import * as fs from "fs";
import * as path from "path";
import { DATA_DIR } from "../../config/paths";
import { PanelError } from "../../core/errors";
import { loadJson, saveJson } from "../../persistence/store";
import { newId, type ProxyProfile, type ProxyProtocol } from "../../types";
import { createLogger } from "../../utils/logger";
import { deleteProxySecret, hasProxySecret, readProxySecret, writeProxySecret } from "./secrets";

const PROXIES_FILE = "proxies.json";
const SEED_TESTED_FILE = "proxies-tested.json";
const log = createLogger("proxy");

const PROTOCOLS = new Set<ProxyProtocol>(["socks5", "socks4", "http"]);

export interface CreateProxyInput {
  name?: string;
  protocol?: string;
  host: string;
  port: number | string;
  username?: string;
  password?: string;
  enabled?: boolean;
  note?: string;
}

export interface UpdateProxyInput {
  name?: string;
  protocol?: string;
  host?: string;
  port?: number | string;
  username?: string;
  password?: string;
  clearPassword?: boolean;
  enabled?: boolean;
  note?: string;
}

export function normalizeProxyProtocol(raw: unknown): ProxyProtocol {
  const v = String(raw ?? "socks5").trim().toLowerCase();
  if (v === "socks5h" || v === "socks") return "socks5";
  if (v === "socks4a") return "socks4";
  if (v === "https") return "http";
  if (PROTOCOLS.has(v as ProxyProtocol)) return v as ProxyProtocol;
  throw new PanelError(`Unsupported proxy protocol "${String(raw)}". Use socks5, socks4, or http.`);
}

export function normalizeProxyHost(raw: unknown): string {
  const host = String(raw ?? "").trim();
  if (!host || /[\s/@\\]/.test(host) || host.length > 253) {
    throw new PanelError("Proxy host must be a valid hostname or IP address.");
  }
  return host;
}

export function clampProxyPort(raw: unknown): number {
  const port = Math.floor(Number(raw));
  if (!Number.isFinite(port) || port < 1 || port > 65535) {
    throw new PanelError("Proxy port must be between 1 and 65535.");
  }
  return port;
}

function stripPasswordFields(row: ProxyProfile): ProxyProfile {
  return {
    id: row.id,
    name: row.name,
    protocol: normalizeProxyProtocol(row.protocol),
    host: row.host,
    port: clampProxyPort(row.port),
    username: row.username?.trim() || undefined,
    hasPassword: hasProxySecret(row.id),
    enabled: row.enabled !== false,
    note: row.note
  };
}

export interface ParsedProxyLine {
  protocol: ProxyProtocol;
  host: string;
  port: number;
  username?: string;
  password?: string;
  note?: string;
  name?: string;
}

/**
 * Parse a single proxy line or URL:
 * - socks5://user:pass@1.2.3.4:1080
 * - http://1.2.3.4:8080
 * - 1.2.3.4:1080:user:pass
 * - 1.2.3.4:1080 (defaults to socks5)
 */
export function parseProxyLine(rawLine: string, defaultProtocol: ProxyProtocol = "socks5"): ParsedProxyLine | null {
  const line = rawLine.trim();
  if (!line || line.startsWith("#")) return null;

  if (/^[a-z0-9]+:\/\//i.test(line)) {
    let url: URL;
    try {
      url = new URL(line);
    } catch {
      throw new PanelError(`Invalid proxy URL: ${line}`);
    }
    const protocol = normalizeProxyProtocol(url.protocol.replace(/:$/, ""));
    const host = normalizeProxyHost(url.hostname.replace(/^\[|\]$/g, ""));
    const port = clampProxyPort(url.port || (protocol === "http" ? 8080 : 1080));
    const username = url.username ? decodeURIComponent(url.username) : undefined;
    const password = url.password ? decodeURIComponent(url.password) : undefined;
    return { protocol, host, port, username, password };
  }

  const parts = line.split(":");
  if (parts.length === 2) {
    return {
      protocol: defaultProtocol,
      host: normalizeProxyHost(parts[0]),
      port: clampProxyPort(parts[1])
    };
  }
  if (parts.length === 4) {
    return {
      protocol: defaultProtocol,
      host: normalizeProxyHost(parts[0]),
      port: clampProxyPort(parts[1]),
      username: parts[2].trim() || undefined,
      password: parts[3] || undefined
    };
  }
  throw new PanelError(`Unrecognized proxy format: ${line}`);
}

export class ProxyStore {
  private proxies: ProxyProfile[] = [];

  load(): void {
    const file = path.join(DATA_DIR, PROXIES_FILE);
    if (!fs.existsSync(file)) {
      this.proxies = [];
      this.seedFromTestedJson();
      return;
    }
    const raw = loadJson<ProxyProfile[]>(PROXIES_FILE, []);
    this.proxies = [];
    for (const entry of Array.isArray(raw) ? raw : []) {
      try {
        // Strip any legacy plaintext password field if a file was hand-edited.
        const legacyPw = (entry as ProxyProfile & { password?: string }).password;
        const clean = stripPasswordFields(entry);
        if (legacyPw && !hasProxySecret(clean.id)) {
          writeProxySecret(clean.id, String(legacyPw));
          clean.hasPassword = true;
        }
        this.proxies.push(clean);
      } catch {
        /* ignore malformed entry */
      }
    }
    log.info(`${this.proxies.length} proxy profile(s) loaded`);
  }

  /** Seed proxies.json once from data/proxies-tested.json when proxies.json does not exist yet. */
  private seedFromTestedJson(): void {
    const seedPath = path.join(DATA_DIR, SEED_TESTED_FILE);
    if (!fs.existsSync(seedPath)) return;
    try {
      const parsed = JSON.parse(fs.readFileSync(seedPath, "utf8")) as unknown;
      if (!Array.isArray(parsed)) return;
      const working = parsed.filter(
        (item): item is Record<string, unknown> =>
          Boolean(item && typeof item === "object" && (item as Record<string, unknown>).working === true)
      );
      if (!working.length) return;
      const added = this.importItems(working, "socks5", false);
      if (added.length > 0) {
        this.persist();
        log.success(`Seeded ${added.length} working proxy profile(s) from ${SEED_TESTED_FILE}`);
      }
    } catch (err) {
      log.warn(`Could not seed from ${SEED_TESTED_FILE}`, err instanceof Error ? err.message : String(err));
    }
  }

  private persist(): void {
    const clean = this.proxies.map(({ hasPassword: _drop, ...stored }) => stored);
    void saveJson(PROXIES_FILE, clean);
  }

  list(): ProxyProfile[] {
    return this.proxies.map((p) => ({ ...p, hasPassword: hasProxySecret(p.id) }));
  }

  get(id: string): { profile: ProxyProfile; password: string | null } | null {
    const found = this.proxies.find((p) => p.id === id);
    if (!found) return null;
    return {
      profile: { ...found, hasPassword: hasProxySecret(found.id) },
      password: readProxySecret(found.id)
    };
  }

  create(input: CreateProxyInput): ProxyProfile {
    const protocol = normalizeProxyProtocol(input.protocol);
    const host = normalizeProxyHost(input.host);
    const port = clampProxyPort(input.port);
    const username = input.username?.trim() || undefined;
    const name = String(input.name ?? "").trim() || `${protocol.toUpperCase()} ${host}:${port}`;
    const id = newId();
    if (input.password) writeProxySecret(id, String(input.password));
    const profile: ProxyProfile = {
      id,
      name,
      protocol,
      host,
      port,
      username,
      hasPassword: hasProxySecret(id),
      enabled: input.enabled !== false,
      note: input.note?.trim() || undefined
    };
    this.proxies.push(profile);
    this.persist();
    return { ...profile };
  }

  update(id: string, patch: UpdateProxyInput): ProxyProfile {
    const cur = this.proxies.find((p) => p.id === id);
    if (!cur) throw new PanelError("Proxy profile not found.", 404);
    if (patch.protocol !== undefined) cur.protocol = normalizeProxyProtocol(patch.protocol);
    if (patch.host !== undefined) cur.host = normalizeProxyHost(patch.host);
    if (patch.port !== undefined) cur.port = clampProxyPort(patch.port);
    if (patch.name !== undefined) cur.name = String(patch.name).trim() || `${cur.protocol.toUpperCase()} ${cur.host}:${cur.port}`;
    if (patch.username !== undefined) cur.username = patch.username.trim() || undefined;
    if (patch.note !== undefined) cur.note = patch.note.trim() || undefined;
    if (patch.enabled !== undefined) cur.enabled = Boolean(patch.enabled);
    if (patch.clearPassword) deleteProxySecret(id);
    else if (patch.password !== undefined && patch.password !== "") writeProxySecret(id, String(patch.password));
    cur.hasPassword = hasProxySecret(id);
    this.persist();
    return { ...cur };
  }

  remove(id: string): void {
    const before = this.proxies.length;
    this.proxies = this.proxies.filter((p) => p.id !== id);
    if (this.proxies.length === before) throw new PanelError("Proxy profile not found.", 404);
    deleteProxySecret(id);
    this.persist();
  }

  /**
   * Bulk import from either newline-delimited proxy text or a JSON array (including proxies-tested.json).
   * Entries explicitly marked working:false are skipped; duplicates by protocol+host+port+username are ignored.
   */
  importBulk(rawInput: string | unknown[], defaultProtocol: ProxyProtocol = "socks5"): { added: ProxyProfile[]; skipped: number } {
    let parsedList: unknown[] | null = null;
    if (Array.isArray(rawInput)) {
      parsedList = rawInput;
    } else {
      const trimmed = String(rawInput ?? "").trim();
      if (!trimmed) return { added: [], skipped: 0 };
      if (trimmed.startsWith("[")) {
        let json: unknown;
        try {
          json = JSON.parse(trimmed);
        } catch {
          throw new PanelError("Invalid JSON proxy list.");
        }
        if (!Array.isArray(json)) throw new PanelError("JSON proxy import must be an array.");
        parsedList = json;
      } else {
        const lines = trimmed.split(/[\r\n,]+/).map((s) => s.trim()).filter(Boolean);
        parsedList = lines;
      }
    }
    const added = this.importItems(parsedList, defaultProtocol, true);
    if (added.length > 0) this.persist();
    return { added, skipped: Math.max(0, parsedList.length - added.length) };
  }

  private importItems(items: unknown[], defaultProtocol: ProxyProtocol, persistEach = false): ProxyProfile[] {
    const seen = new Set(this.proxies.map((p) => dedupeKey(p.protocol, p.host, p.port, p.username)));
    const added: ProxyProfile[] = [];
    for (const item of items) {
      let parsed: ParsedProxyLine | null = null;
      if (typeof item === "string") {
        parsed = parseProxyLine(item, defaultProtocol);
      } else if (item && typeof item === "object") {
        const rec = item as Record<string, unknown>;
        if (rec.working === false) continue; // skip failed entries from tested JSON files
        const protocol = normalizeProxyProtocol(rec.protocol ?? defaultProtocol);
        const host = normalizeProxyHost(rec.host);
        const port = clampProxyPort(rec.port);
        const username = typeof rec.username === "string" && rec.username.trim() ? rec.username.trim() : undefined;
        const password = typeof rec.password === "string" && rec.password ? rec.password : undefined;
        const note =
          typeof rec.source === "string" && rec.source.trim()
            ? rec.source.trim()
            : typeof rec.note === "string" && rec.note.trim()
              ? rec.note.trim()
              : undefined;
        const name = typeof rec.name === "string" && rec.name.trim() ? rec.name.trim() : undefined;
        parsed = { protocol, host, port, username, password, note, name };
      }
      if (!parsed) continue;
      const key = dedupeKey(parsed.protocol, parsed.host, parsed.port, parsed.username);
      if (seen.has(key)) continue;
      seen.add(key);
      const id = newId();
      if (parsed.password) writeProxySecret(id, parsed.password);
      const profile: ProxyProfile = {
        id,
        name: parsed.name || `${parsed.protocol.toUpperCase()} ${parsed.host}:${parsed.port}`,
        protocol: parsed.protocol,
        host: parsed.host,
        port: parsed.port,
        username: parsed.username,
        hasPassword: hasProxySecret(id),
        enabled: true,
        note: parsed.note
      };
      this.proxies.push(profile);
      added.push(profile);
    }
    if (persistEach && added.length > 0) this.persist();
    return added;
  }
}

function dedupeKey(protocol: ProxyProtocol, host: string, port: number, username?: string): string {
  return `${protocol}:${host.toLowerCase()}:${port}:${username ?? ""}`;
}
