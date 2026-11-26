import * as path from "path";
import { DATA_DIR } from "../../config/paths";
import { readSecretJson, writeSecretJson } from "../../security/secretBox";

const FILE = "proxy-secrets.json";

function file(): string {
  return path.join(DATA_DIR, FILE);
}

function readAll(): Record<string, string> {
  const parsed = readSecretJson<Record<string, string>>(file(), {});
  return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
}

function writeAll(data: Record<string, string>): void {
  writeSecretJson(file(), data);
}

/** Startup migration: seals an older plaintext proxy-secrets file when a key is present. */
export function migrateProxySecrets(): void {
  readAll();
}

export function hasProxySecret(proxyId: string): boolean {
  return Boolean(readAll()[proxyId]);
}

export function readProxySecret(proxyId: string): string | null {
  const value = readAll()[proxyId];
  return value ? String(value) : null;
}

export function writeProxySecret(proxyId: string, password: string): void {
  const data = readAll();
  const value = String(password ?? "");
  if (!value) delete data[proxyId];
  else data[proxyId] = value;
  writeAll(data);
}

export function deleteProxySecret(proxyId: string): void {
  const data = readAll();
  if (!data[proxyId]) return;
  delete data[proxyId];
  writeAll(data);
}
