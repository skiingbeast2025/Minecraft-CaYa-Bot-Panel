import * as dns from "dns";
import * as net from "net";
import { SocksClient } from "socks";
import type { ProxyProfile } from "../../types";

export interface McProtocolClientLike {
  ended?: boolean;
  setSocket(socket: net.Socket): void;
  emit(event: string, ...args: unknown[]): boolean;
}

export type ConnectHook = (client: McProtocolClientLike) => void;

const DEFAULT_PROXY_TIMEOUT_MS = 15_000;

/** Strip any proxy credentials before logging or surfacing error text. */
export function redactProxySecrets(message: string, proxy?: Pick<ProxyProfile, "username"> | null, password?: string | null): string {
  let out = String(message ?? "");
  if (password) out = out.split(password).join("••••");
  if (proxy?.username) out = out.split(proxy.username).join("••••");
  return out.replace(/([a-z0-9]+:\/\/)([^:\s/@]+):([^@\s/]+)@/gi, "$1••••:••••@");
}

function resolveMinecraftSrv(host: string, port: number): Promise<{ host: string; port: number }> {
  if (port !== 25565 || net.isIP(host) !== 0 || host.toLowerCase() === "localhost") {
    return Promise.resolve({ host, port });
  }
  return new Promise((resolve) => {
    let settled = false;
    const done = (target: { host: string; port: number }) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(target);
    };
    const timer = setTimeout(() => done({ host, port }), 3_000);
    dns.resolveSrv(`_minecraft._tcp.${host}`, (err, records) => {
      if (!err && records && records.length > 0 && records[0]?.name && records[0]?.port) {
        done({ host: records[0].name, port: records[0].port });
      } else {
        done({ host, port });
      }
    });
  });
}

function dialHttpConnect(
  proxy: ProxyProfile,
  password: string | null,
  destHost: string,
  destPort: number,
  timeoutMs: number
): Promise<net.Socket> {
  return new Promise((resolve, reject) => {
    const socket = net.connect({ host: proxy.host, port: proxy.port });
    let headerBuf = Buffer.alloc(0);
    let settled = false;

    const cleanup = () => {
      clearTimeout(timer);
      socket.removeListener("data", onData);
      socket.removeListener("error", onError);
      socket.removeListener("close", onClose);
    };
    const fail = (err: Error) => {
      if (settled) return;
      settled = true;
      cleanup();
      socket.destroy();
      reject(err);
    };

    const timer = setTimeout(() => fail(new Error(`HTTP proxy timeout after ${timeoutMs}ms`)), timeoutMs);
    const onError = (err: Error) => fail(err);
    const onClose = () => fail(new Error("HTTP proxy closed connection during CONNECT handshake"));

    const onData = (chunk: Buffer) => {
      headerBuf = Buffer.concat([headerBuf, chunk]);
      const sep = headerBuf.indexOf("\r\n\r\n");
      if (sep === -1) {
        if (headerBuf.length > 16_384) fail(new Error("HTTP proxy CONNECT response header too large"));
        return;
      }
      const headText = headerBuf.subarray(0, sep).toString("latin1");
      const rest = headerBuf.subarray(sep + 4);
      const statusLine = headText.split("\r\n")[0] ?? "";
      const match = statusLine.match(/^HTTP\/\d\.\d\s+(\d{3})(?:\s+(.*))?/i);
      const code = match ? Number(match[1]) : 0;
      if (code !== 200) {
        fail(new Error(`HTTP proxy CONNECT rejected (${statusLine || "invalid response"})`));
        return;
      }
      settled = true;
      cleanup();
      if (rest.length > 0) socket.unshift(rest);
      resolve(socket);
    };

    socket.once("error", onError);
    socket.once("close", onClose);
    socket.on("data", onData);

    socket.once("connect", () => {
      const target = destHost.includes(":") && !destHost.startsWith("[") ? `[${destHost}]:${destPort}` : `${destHost}:${destPort}`;
      const lines = [`CONNECT ${target} HTTP/1.1`, `Host: ${target}`];
      if (proxy.username || password) {
        const token = Buffer.from(`${proxy.username ?? ""}:${password ?? ""}`, "utf8").toString("base64");
        lines.push(`Proxy-Authorization: Basic ${token}`);
      }
      lines.push("Proxy-Connection: Keep-Alive", "", "");
      socket.write(lines.join("\r\n"));
    });
  });
}

export async function dialThroughProxy(
  proxy: ProxyProfile,
  password: string | null,
  destHost: string,
  destPort: number,
  timeoutMs = DEFAULT_PROXY_TIMEOUT_MS
): Promise<net.Socket> {
  if (!proxy.enabled) {
    throw new Error(`Proxy "${proxy.name}" is disabled.`);
  }
  if (proxy.protocol === "http") {
    return dialHttpConnect(proxy, password, destHost, destPort, timeoutMs);
  }
  const type = proxy.protocol === "socks5" ? 5 : 4;
  const info = await SocksClient.createConnection({
    proxy: {
      host: proxy.host,
      port: proxy.port,
      type,
      ...(proxy.username ? { userId: proxy.username } : {}),
      ...(password ? { password } : {})
    },
    command: "connect",
    destination: { host: destHost, port: destPort },
    timeout: timeoutMs
  });
  return info.socket;
}

/**
 * Create a `minecraft-protocol` `options.connect(client)` callback that tunnels
 * traffic through `proxy` and fails closed if the proxy handshake fails.
 */
export function createProxyConnect(
  targetHost: string,
  targetPort: number,
  proxy: ProxyProfile,
  password: string | null,
  timeoutMs = DEFAULT_PROXY_TIMEOUT_MS
): ConnectHook {
  return (client: McProtocolClientLike) => {
    void (async () => {
      try {
        const target = await resolveMinecraftSrv(targetHost, targetPort);
        const socket = await dialThroughProxy(proxy, password, target.host, target.port, timeoutMs);
        if (client.ended) {
          socket.destroy();
          return;
        }
        client.setSocket(socket);
        client.emit("connect");
      } catch (err) {
        const msg = redactProxySecrets(err instanceof Error ? err.message : String(err), proxy, password);
        client.emit("error", new Error(`Proxy (${proxy.protocol}://${proxy.host}:${proxy.port}) failed: ${msg}`));
      }
    })();
  };
}

export interface ProxyTestResult {
  ok: boolean;
  latencyMs: number | null;
  target: string;
  error?: string;
}

/**
 * Test a proxy either by pinging a Minecraft server through it or, when no target
 * is given, completing a tunnel handshake to 1.1.1.1:443.
 */
export async function testProxyConnection(
  proxy: ProxyProfile,
  password: string | null,
  targetHost?: string,
  targetPort?: number,
  timeoutMs = 8_000
): Promise<ProxyTestResult> {
  const start = Date.now();
  const host = targetHost?.trim() || "1.1.1.1";
  const port = targetPort && Number.isFinite(targetPort) ? targetPort : targetHost?.trim() ? 25565 : 443;
  const label = `${host}:${port}`;

  try {
    if (targetHost?.trim()) {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const mc = require("minecraft-protocol") as { ping(opts: Record<string, unknown>): Promise<unknown> };
      const probe = { ...proxy, enabled: true };
      await Promise.race([
        mc.ping({
          host,
          port,
          closeTimeout: timeoutMs,
          noPongTimeout: timeoutMs,
          connect: createProxyConnect(host, port, probe, password, timeoutMs)
        }),
        new Promise((_, rej) => setTimeout(() => rej(new Error("Proxy ping timeout")), timeoutMs + 500))
      ]);
      return { ok: true, latencyMs: Date.now() - start, target: label };
    }

    const probe = { ...proxy, enabled: true };
    const socket = await dialThroughProxy(probe, password, host, port, timeoutMs);
    socket.destroy();
    return { ok: true, latencyMs: Date.now() - start, target: label };
  } catch (err) {
    return {
      ok: false,
      latencyMs: null,
      target: label,
      error: redactProxySecrets(err instanceof Error ? err.message : String(err), proxy, password)
    };
  }
}
