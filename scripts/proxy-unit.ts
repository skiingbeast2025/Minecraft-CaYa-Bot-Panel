/**
 * Unit tests for outbound proxy routing (SOCKS5 + HTTP CONNECT), fail-closed
 * guarantees, sealed proxy credential storage, and bulk/round-robin import.
 */
import * as crypto from "crypto";
import * as fs from "fs";
import * as net from "net";
import * as os from "os";
import * as path from "path";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "caya-proxy-unit-"));
process.env.CAYA_DATA_DIR = tmpDir;

import type { ConnectHook } from "../server/src/modules/proxy/connect";
import type { ProxyProfile } from "../server/src/types";

let failures = 0;
function assert(name: string, cond: boolean, detail = "") {
  if (cond) console.log(`  ok ${name}`);
  else {
    failures++;
    console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

/** Local mock HTTP CONNECT proxy supporting optional Basic auth. */
function startMockHttpProxy(expectedAuth?: { user: string; pass: string }): Promise<{ port: number; hits: number; close(): Promise<void> }> {
  const state = { hits: 0 };
  const server = net.createServer((clientSocket) => {
    let buf = Buffer.alloc(0);
    const onData = (chunk: Buffer) => {
      buf = Buffer.concat([buf, chunk]);
      const sep = buf.indexOf("\r\n\r\n");
      if (sep === -1) return;
      clientSocket.removeListener("data", onData);
      const head = buf.subarray(0, sep).toString("latin1");
      const rest = buf.subarray(sep + 4);
      const lines = head.split("\r\n");
      const reqLine = lines[0] ?? "";
      const m = reqLine.match(/^CONNECT\s+([^:\s]+):(\d+)\s+HTTP\/1\.\d$/i);
      if (!m) {
        clientSocket.end("HTTP/1.1 400 Bad Request\r\n\r\n");
        return;
      }
      if (expectedAuth) {
        const authHeader = lines.find((l) => /^Proxy-Authorization:\s*Basic\s+/i.test(l));
        const expectedB64 = Buffer.from(`${expectedAuth.user}:${expectedAuth.pass}`).toString("base64");
        if (!authHeader || !authHeader.endsWith(expectedB64)) {
          clientSocket.end("HTTP/1.1 407 Proxy Authentication Required\r\n\r\n");
          return;
        }
      }
      state.hits++;
      const upstream = net.connect({ host: m[1]!, port: Number(m[2]) });
      upstream.once("error", () => clientSocket.end("HTTP/1.1 502 Bad Gateway\r\n\r\n"));
      upstream.once("connect", () => {
        clientSocket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
        if (rest.length > 0) upstream.write(rest);
        clientSocket.pipe(upstream);
        upstream.pipe(clientSocket);
      });
    };
    clientSocket.on("data", onData);
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const port = (server.address() as net.AddressInfo).port;
      resolve({
        port,
        get hits() {
          return state.hits;
        },
        close: () => new Promise((r) => server.close(() => r()))
      });
    });
  });
}

/** Local mock SOCKS5 proxy supporting no-auth and username/password auth (RFC 1928 / 1929). */
function startMockSocks5Proxy(expectedAuth?: { user: string; pass: string }): Promise<{ port: number; hits: number; close(): Promise<void> }> {
  const state = { hits: 0 };
  const server = net.createServer((sock) => {
    let stage: "greeting" | "auth" | "request" = "greeting";
    let buf = Buffer.alloc(0);

    const onData = (chunk: Buffer) => {
      buf = Buffer.concat([buf, chunk]);
      if (stage === "greeting") {
        if (buf.length < 2) return;
        const nMethods = buf[1]!;
        if (buf.length < 2 + nMethods) return;
        const methods = buf.subarray(2, 2 + nMethods);
        buf = buf.subarray(2 + nMethods);
        if (expectedAuth) {
          if (!methods.includes(0x02)) {
            sock.end(Buffer.from([0x05, 0xff]));
            return;
          }
          stage = "auth";
          sock.write(Buffer.from([0x05, 0x02]));
        } else {
          stage = "request";
          sock.write(Buffer.from([0x05, 0x00]));
        }
      }
      if (stage === "auth") {
        if (buf.length < 2) return;
        const ulen = buf[1]!;
        if (buf.length < 3 + ulen) return;
        const plen = buf[2 + ulen]!;
        if (buf.length < 3 + ulen + plen) return;
        const user = buf.subarray(2, 2 + ulen).toString("utf8");
        const pass = buf.subarray(3 + ulen, 3 + ulen + plen).toString("utf8");
        buf = buf.subarray(3 + ulen + plen);
        if (!expectedAuth || user !== expectedAuth.user || pass !== expectedAuth.pass) {
          sock.end(Buffer.from([0x01, 0x01]));
          return;
        }
        stage = "request";
        sock.write(Buffer.from([0x01, 0x00]));
      }
      if (stage === "request") {
        if (buf.length < 4) return;
        const atyp = buf[3]!;
        let host = "";
        let offset = 4;
        if (atyp === 0x01) {
          if (buf.length < offset + 6) return;
          host = `${buf[4]}.${buf[5]}.${buf[6]}.${buf[7]}`;
          offset += 4;
        } else if (atyp === 0x03) {
          const dlen = buf[4]!;
          if (buf.length < offset + 1 + dlen + 2) return;
          host = buf.subarray(5, 5 + dlen).toString("utf8");
          offset += 1 + dlen;
        } else {
          sock.end(Buffer.from([0x05, 0x08, 0x00, 0x01, 0, 0, 0, 0, 0, 0]));
          return;
        }
        const port = buf.readUInt16BE(offset);
        const rest = buf.subarray(offset + 2);
        sock.removeListener("data", onData);
        state.hits++;
        const upstream = net.connect({ host, port });
        upstream.once("error", () => sock.end(Buffer.from([0x05, 0x05, 0x00, 0x01, 0, 0, 0, 0, 0, 0])));
        upstream.once("connect", () => {
          sock.write(Buffer.from([0x05, 0x00, 0x00, 0x01, 0, 0, 0, 0, 0, 0]));
          if (rest.length > 0) upstream.write(rest);
          sock.pipe(upstream);
          upstream.pipe(sock);
        });
      }
    };
    sock.on("data", onData);
  });

  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const port = (server.address() as net.AddressInfo).port;
      resolve({
        port,
        get hits() {
          return state.hits;
        },
        close: () => new Promise((r) => server.close(() => r()))
      });
    });
  });
}

function connectWithHook(hook: ConnectHook): Promise<string> {
  return new Promise((resolve, reject) => {
    let sock: net.Socket | null = null;
    const fakeClient = {
      // Match minecraft-protocol Client constructor, which starts with ended=true until setSocket().
      ended: true,
      setSocket(s: net.Socket) {
        this.ended = false;
        sock = s;
      },
      emit(event: string, ...args: unknown[]) {
        if (event === "error") {
          reject(args[0]);
          return true;
        }
        if (event === "connect" && sock) {
          sock.once("data", (d) => {
            const text = d.toString("utf8");
            sock?.destroy();
            resolve(text);
          });
          sock.write("PING");
        }
        return true;
      }
    };
    hook(fakeClient);
  });
}

async function run() {
  const { DATA_DIR } = await import("../server/src/config/paths");
  const { createProxyConnect, redactProxySecrets, testProxyConnection } = await import("../server/src/modules/proxy/connect");
  const { deleteProxySecret, hasProxySecret, readProxySecret, writeProxySecret } = await import("../server/src/modules/proxy/secrets");
  const { parseProxyLine, ProxyStore } = await import("../server/src/modules/proxy/store");
  const { initSecretBox, setSecretKeyForTests } = await import("../server/src/security/secretBox");
  const { BotManager } = await import("../server/src/core/BotManager");
  const { friendlyError } = await import("../server/src/utils/chatText");

  await initSecretBox();
  setSecretKeyForTests(crypto.randomBytes(32));

  console.log("parsing & sealed storage");
  const u1 = parseProxyLine("socks5://alice:s3cr3t@10.0.0.2:1080");
  assert("parses socks5 URL with credentials", u1?.protocol === "socks5" && u1.host === "10.0.0.2" && u1.port === 1080 && u1.username === "alice" && u1.password === "s3cr3t");

  const u2 = parseProxyLine("10.0.0.3:8080:bob:pw123", "http");
  assert("parses host:port:user:pass", u2?.protocol === "http" && u2.host === "10.0.0.3" && u2.port === 8080 && u2.username === "bob" && u2.password === "pw123");

  writeProxySecret("p1", "topsecret");
  assert("proxy secret is stored and readable", hasProxySecret("p1") && readProxySecret("p1") === "topsecret");
  const sealedPath = path.join(DATA_DIR, "proxy-secrets.json.sealed");
  assert("proxy secrets are sealed on disk", fs.existsSync(sealedPath) && !fs.readFileSync(sealedPath, "utf8").includes("topsecret"));
  deleteProxySecret("p1");
  assert("proxy secret deletes cleanly", !hasProxySecret("p1"));

  const store = new ProxyStore();
  store.load();
  const imp = store.importBulk([
    { protocol: "socks5", host: "127.0.0.1", port: 1080, working: true, password: "hidden" },
    { protocol: "http", host: "127.0.0.1", port: 8080, working: false },
    "http://u1:p1@127.0.0.1:3128"
  ]);
  assert("import skips working:false entries", imp.added.length === 2 && imp.skipped === 1);
  assert("ProxyProfile strips password from list()", imp.added.every((p) => !("password" in p)));
  assert("imported password is stored in secretBox", imp.added[0]?.hasPassword === true);

  console.log("secret redaction");
  const redacted = redactProxySecrets("failed socks5://alice:s3cr3t@1.2.3.4:1080 auth for alice / s3cr3t", { username: "alice" }, "s3cr3t");
  assert("redacts credentials from errors", !redacted.includes("alice") && !redacted.includes("s3cr3t"));
  const proxyErr = friendlyError(new Error("Proxy (socks5://1.2.3.4:1080) failed: connect ECONNREFUSED 1.2.3.4:1080"));
  assert("friendlyError preserves proxy errors", proxyErr.startsWith("Proxy (socks5://1.2.3.4:1080) failed:"));

  console.log("mock echo + proxies");
  const echoServer = net.createServer((s) => {
    s.once("data", (d) => s.end(`ECHO:${d.toString("utf8")}`));
  });
  await new Promise<void>((r) => echoServer.listen(0, "127.0.0.1", r));
  const echoPort = (echoServer.address() as net.AddressInfo).port;

  const httpProxy = await startMockHttpProxy({ user: "u", pass: "p" });
  const socksProxy = await startMockSocks5Proxy({ user: "su", pass: "sp" });

  try {
    const httpProfile: ProxyProfile = { id: "hp", name: "HTTP", protocol: "http", host: "127.0.0.1", port: httpProxy.port, username: "u", enabled: true };
    const httpReply = await connectWithHook(createProxyConnect("127.0.0.1", echoPort, httpProfile, "p"));
    assert("HTTP CONNECT tunnels traffic through proxy", httpReply === "ECHO:PING" && httpProxy.hits === 1);

    const socksProfile: ProxyProfile = { id: "sp", name: "SOCKS5", protocol: "socks5", host: "127.0.0.1", port: socksProxy.port, username: "su", enabled: true };
    const socksReply = await connectWithHook(createProxyConnect("127.0.0.1", echoPort, socksProfile, "sp"));
    assert("SOCKS5 tunnels traffic through proxy", socksReply === "ECHO:PING" && socksProxy.hits === 1);

    // Fail-closed checks: bad credentials or disabled proxy must fail and never hit echoServer directly.
    let badAuthFailed = false;
    try {
      await connectWithHook(createProxyConnect("127.0.0.1", echoPort, httpProfile, "wrong"));
    } catch {
      badAuthFailed = true;
    }
    assert("HTTP CONNECT fails closed on bad auth", badAuthFailed && httpProxy.hits === 1);

    let badSocksFailed = false;
    try {
      await connectWithHook(createProxyConnect("127.0.0.1", echoPort, socksProfile, "wrong"));
    } catch {
      badSocksFailed = true;
    }
    assert("SOCKS5 fails closed on bad auth", badSocksFailed && socksProxy.hits === 1);

    const testRes = await testProxyConnection({ ...socksProfile, host: "127.0.0.1", port: 1 }, "sp", undefined, undefined, 1000);
    assert("testProxyConnection reports failure on dead port", !testRes.ok && testRes.latencyMs === null);

    console.log("per-IP connection stagger");
    const mgr = new BotManager();
    mgr.proxies.load();
    const srv = mgr.createServer({ name: "TestSrv", host: "127.0.0.1", port: 25565, version: "1.20.4" });
    const pxA = mgr.createProxy({ name: "ProxyA", protocol: "socks5", host: "10.10.0.1", port: 1080 });
    const pxB = mgr.createProxy({ name: "ProxyB", protocol: "http", host: "10.10.0.2", port: 8080 });
    const pxASameIp = mgr.createProxy({ name: "ProxyA2", protocol: "http", host: "10.10.0.1", port: 3128 });

    const b1 = mgr.createBot({ username: "ProxBot1", serverId: srv.id, proxyId: pxA.id });
    const b2 = mgr.createBot({ username: "ProxBot2", serverId: srv.id, proxyId: pxB.id });
    const distinctPlan = mgr.planStaggeredStarts([b1.config.id, b2.config.id], 2000);
    assert("distinct proxy IPs have 0ms connection stagger", distinctPlan.every((p) => p.delayMs === 0));

    const b3 = mgr.createBot({ username: "ProxBot3", serverId: srv.id, proxyId: pxASameIp.id });
    const mixedPlan = mgr.planStaggeredStarts([b1.config.id, b2.config.id, b3.config.id], 2000);
    assert("same outbound IP staggers subsequent bots on that IP", mixedPlan[0]?.delayMs === 0 && mixedPlan[1]?.delayMs === 0 && (mixedPlan[2]?.delayMs ?? 0) === 2000);

    const d1 = mgr.createBot({ username: "DirectBot1", serverId: srv.id, proxyId: "__direct__" });
    const d2 = mgr.createBot({ username: "DirectBot2", serverId: srv.id, proxyId: "__direct__" });
    const directPlan = mgr.planStaggeredStarts([d1.config.id, d2.config.id], 2000);
    assert("direct bots on same server stagger", directPlan[0]?.delayMs === 0 && directPlan[1]?.delayMs === 2000);
  } finally {
    await httpProxy.close();
    await socksProxy.close();
    await new Promise<void>((r) => echoServer.close(() => r()));
    await new Promise((r) => setTimeout(r, 50));
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }

  if (failures > 0) {
    console.log(`\n${failures} proxy check(s) failed`);
    process.exit(1);
  }
  console.log("\nproxy checks passed");
}

void run();
