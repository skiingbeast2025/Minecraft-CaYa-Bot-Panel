/**
 * CLI proxy tester: reads a JSON array of proxies (default: data/proxies-sorted.json),
 * tests each entry concurrently, and writes sorted results to data/proxies-tested.json.
 *
 * Usage:
 *   npm run test:proxies -- [input.json] [output.json] [targetHost:port]
 */
import * as fs from "fs";
import * as path from "path";
import { DATA_DIR } from "../server/src/config/paths";
import { testProxyConnection } from "../server/src/modules/proxy/connect";
import { clampProxyPort, normalizeProxyHost, normalizeProxyProtocol, parseProxyLine } from "../server/src/modules/proxy/store";
import type { ProxyProfile } from "../server/src/types";

interface InputEntry {
  protocol: ProxyProfile["protocol"];
  host: string;
  port: number;
  username?: string;
  password?: string;
  source?: string;
}

interface TestedEntry extends InputEntry {
  working: boolean;
  latencyMs: number | null;
  error?: string;
}

function parseInput(raw: unknown): InputEntry[] {
  if (!Array.isArray(raw)) throw new Error("Input JSON must be an array.");
  const out: InputEntry[] = [];
  const seen = new Set<string>();
  for (const item of raw) {
    let entry: InputEntry | null = null;
    if (typeof item === "string") {
      const parsed = parseProxyLine(item);
      if (parsed) entry = { protocol: parsed.protocol, host: parsed.host, port: parsed.port, username: parsed.username, password: parsed.password };
    } else if (item && typeof item === "object") {
      const rec = item as Record<string, unknown>;
      entry = {
        protocol: normalizeProxyProtocol(rec.protocol),
        host: normalizeProxyHost(rec.host),
        port: clampProxyPort(rec.port),
        username: typeof rec.username === "string" && rec.username.trim() ? rec.username.trim() : undefined,
        password: typeof rec.password === "string" && rec.password ? rec.password : undefined,
        source: typeof rec.source === "string" ? rec.source : undefined
      };
    }
    if (!entry) continue;
    const key = `${entry.protocol}:${entry.host}:${entry.port}:${entry.username ?? ""}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(entry);
  }
  return out;
}

async function main() {
  const inputPath = path.resolve(process.argv[2] || path.join(DATA_DIR, "proxies-sorted.json"));
  const outputPath = path.resolve(process.argv[3] || path.join(DATA_DIR, "proxies-tested.json"));
  const targetArg = process.argv[4] || "";
  const [targetHost, targetPortRaw] = targetArg.split(":");
  const targetPort = targetPortRaw ? Number(targetPortRaw) : undefined;

  if (!fs.existsSync(inputPath)) {
    console.error(`Input file not found: ${inputPath}`);
    process.exit(1);
  }

  const entries = parseInput(JSON.parse(fs.readFileSync(inputPath, "utf8")));
  const concurrency = Math.max(1, Math.min(200, Number(process.env.CAYA_PROXY_TEST_CONCURRENCY) || 60));
  const results: TestedEntry[] = new Array(entries.length);
  let cursor = 0;
  let done = 0;
  let workingCount = 0;

  await Promise.all(
    Array.from({ length: Math.min(concurrency, entries.length) }, async () => {
      while (cursor < entries.length) {
        const i = cursor++;
        const item = entries[i]!;
        const profile: ProxyProfile = {
          id: `cli-${i}`,
          name: `${item.host}:${item.port}`,
          protocol: item.protocol,
          host: item.host,
          port: item.port,
          username: item.username,
          enabled: true
        };
        const res = await testProxyConnection(profile, item.password ?? null, targetHost || undefined, targetPort, 4_000);
        results[i] = {
          ...item,
          working: res.ok,
          latencyMs: res.latencyMs,
          ...(res.error ? { error: res.error } : {})
        };
        done++;
        if (res.ok) workingCount++;
        if (done % 250 === 0 || done === entries.length) {
          console.log(`Tested ${done}/${entries.length} (${workingCount} working)`);
        }
      }
    })
  );

  results.sort((a, b) => {
    if (a.working !== b.working) return a.working ? -1 : 1;
    if (a.working && b.working) return (a.latencyMs ?? 99999) - (b.latencyMs ?? 99999);
    return a.protocol.localeCompare(b.protocol) || a.host.localeCompare(b.host) || a.port - b.port;
  });

  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, JSON.stringify(results, null, 2));
  console.log(`Wrote ${results.length} results (${workingCount} working) to ${outputPath}`);
}

void main();
