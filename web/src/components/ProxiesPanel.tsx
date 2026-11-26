import { useState } from "react";
import { useI18n } from "../i18n/useI18n";
import { api } from "../lib/api";
import type { ProxyProfile, ProxyProtocol, StateSnapshot } from "../lib/types";
import { useAppStore } from "../stores/useAppStore";

interface TestState {
  busy?: boolean;
  ok?: boolean;
  latencyMs?: number | null;
  error?: string;
}

export function ProxiesPanel() {
  const proxies = useAppStore((s) => s.proxies);
  const bots = useAppStore((s) => s.bots);
  const applySnapshot = useAppStore((s) => s.applySnapshot);
  const toast = useAppStore((s) => s.toast);
  const { t } = useI18n();

  const [name, setName] = useState("");
  const [protocol, setProtocol] = useState<ProxyProtocol>("socks5");
  const [host, setHost] = useState("");
  const [port, setPort] = useState("1080");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);

  const [showImport, setShowImport] = useState(false);
  const [importText, setImportText] = useState("");
  const [importProto, setImportProto] = useState<ProxyProtocol>("socks5");
  const [tests, setTests] = useState<Record<string, TestState>>({});

  const refresh = async () => applySnapshot(await api.get<StateSnapshot>("/api/state"));
  const botCount = Object.keys(bots).length;
  const enabledCount = proxies.filter((p) => p.enabled).length;

  const addProxy = async () => {
    if (!host.trim() || busy) return;
    setBusy(true);
    try {
      await api.post("/api/proxies", {
        name: name.trim() || undefined,
        protocol,
        host: host.trim(),
        port: Number(port),
        username: username.trim() || undefined,
        password: password || undefined
      });
      await refresh();
      setName("");
      setHost("");
      setUsername("");
      setPassword("");
      toast("success", t("proxies.added"));
    } catch (e) {
      toast("error", e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const toggleEnabled = async (p: ProxyProfile) => {
    try {
      await api.patch(`/api/proxies/${p.id}`, { enabled: !p.enabled });
      await refresh();
    } catch (e) {
      toast("error", e instanceof Error ? e.message : String(e));
    }
  };

  const remove = async (p: ProxyProfile) => {
    if (!confirm(t("proxies.deleteConfirm", { name: p.name }))) return;
    try {
      await api.del(`/api/proxies/${p.id}`);
      await refresh();
    } catch (e) {
      toast("error", e instanceof Error ? e.message : String(e));
    }
  };

  const testOne = async (p: ProxyProfile) => {
    setTests((cur) => ({ ...cur, [p.id]: { busy: true } }));
    try {
      const res = await api.post<{ ok: boolean; latencyMs: number | null; error?: string }>(`/api/proxies/${p.id}/test`, {});
      setTests((cur) => ({ ...cur, [p.id]: { busy: false, ok: res.ok, latencyMs: res.latencyMs, error: res.error } }));
    } catch (e) {
      setTests((cur) => ({
        ...cur,
        [p.id]: { busy: false, ok: false, latencyMs: null, error: e instanceof Error ? e.message : String(e) }
      }));
    }
  };

  const importBulk = async () => {
    if (!importText.trim() || busy) return;
    setBusy(true);
    try {
      const res = await api.post<{ added: ProxyProfile[]; skipped: number }>("/api/proxies/import", {
        text: importText,
        defaultProtocol: importProto
      });
      await refresh();
      setImportText("");
      setShowImport(false);
      toast("success", t("proxies.imported", { added: res.added.length, skipped: res.skipped }));
    } catch (e) {
      toast("error", e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const assignRoundRobin = async () => {
    setBusy(true);
    try {
      const res = await api.post<{ ok: boolean; count: number }>("/api/proxies/assign-round-robin", {});
      await refresh();
      toast("success", t("proxies.assignedAll", { n: res.count }));
    } catch (e) {
      toast("error", e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex flex-col gap-4 border-t border-zinc-800 pt-6">
      <div className="flex flex-wrap items-center gap-3">
        <div>
          <h2 className="text-lg font-bold text-zinc-100">{t("proxies.title")}</h2>
          <p className="text-xs text-zinc-500">{t("proxies.subtitle")}</p>
        </div>
        <div className="ml-auto flex flex-wrap gap-2">
          <button
            type="button"
            onClick={() => setShowImport((v) => !v)}
            className="rounded-lg bg-zinc-800 px-3 py-1.5 text-xs text-zinc-200 hover:bg-zinc-700"
          >
            {t("proxies.importBtn")}
          </button>
          <button
            type="button"
            disabled={busy || enabledCount === 0 || botCount === 0}
            onClick={() => void assignRoundRobin()}
            className="rounded-lg bg-indigo-600/20 px-3 py-1.5 text-xs text-indigo-200 hover:bg-indigo-600/30 disabled:opacity-40"
          >
            {t("proxies.assignAll")}
          </button>
        </div>
      </div>

      {showImport && (
        <div className="flex flex-col gap-2 rounded-xl border border-zinc-800 bg-zinc-900/60 p-4">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <span className="text-xs text-zinc-400">{t("proxies.importHint")}</span>
            <label className="flex items-center gap-2 text-xs text-zinc-400">
              {t("proxies.defaultProtocol")}
              <select
                value={importProto}
                onChange={(e) => setImportProto(e.target.value as ProxyProtocol)}
                className="rounded border border-zinc-700 bg-zinc-800 px-2 py-1 text-zinc-100"
              >
                <option value="socks5">SOCKS5</option>
                <option value="socks4">SOCKS4</option>
                <option value="http">HTTP CONNECT</option>
              </select>
            </label>
          </div>
          <textarea
            rows={5}
            value={importText}
            onChange={(e) => setImportText(e.target.value)}
            placeholder="socks5://user:pass@1.2.3.4:1080&#10;http://5.6.7.8:8080&#10;or paste proxies-tested.json"
            className="mono rounded-lg border border-zinc-700 bg-zinc-950 p-2.5 text-xs text-zinc-100 outline-none focus:border-indigo-500"
          />
          <div className="flex justify-end gap-2">
            <button
              type="button"
              onClick={() => setShowImport(false)}
              className="rounded-lg px-3 py-1.5 text-xs text-zinc-400 hover:bg-zinc-800"
            >
              {t("common.cancel")}
            </button>
            <button
              type="button"
              disabled={busy || !importText.trim()}
              onClick={() => void importBulk()}
              className="rounded-lg bg-indigo-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-indigo-500 disabled:opacity-50"
            >
              {t("proxies.importSubmit")}
            </button>
          </div>
        </div>
      )}

      <div className="flex flex-wrap items-end gap-3 rounded-xl border border-zinc-800 bg-zinc-900/50 p-4">
        <label className="flex flex-col gap-1 text-sm">
          <span className="text-zinc-400">{t("proxies.protocol")}</span>
          <select
            value={protocol}
            onChange={(e) => setProtocol(e.target.value as ProxyProtocol)}
            className="w-32 rounded-lg border border-zinc-700 bg-zinc-800 px-3 py-2 text-zinc-100 outline-none focus:border-indigo-500"
          >
            <option value="socks5">SOCKS5</option>
            <option value="socks4">SOCKS4</option>
            <option value="http">HTTP</option>
          </select>
        </label>
        <label className="flex flex-col gap-1 text-sm">
          <span className="text-zinc-400">{t("proxies.host")}</span>
          <input
            value={host}
            onChange={(e) => setHost(e.target.value)}
            placeholder="127.0.0.1"
            className="w-44 rounded-lg border border-zinc-700 bg-zinc-800 px-3 py-2 text-zinc-100 outline-none focus:border-indigo-500"
          />
        </label>
        <label className="flex flex-col gap-1 text-sm">
          <span className="text-zinc-400">{t("proxies.port")}</span>
          <input
            type="number"
            min={1}
            max={65535}
            value={port}
            onChange={(e) => setPort(e.target.value)}
            className="w-24 rounded-lg border border-zinc-700 bg-zinc-800 px-3 py-2 text-zinc-100 outline-none focus:border-indigo-500"
          />
        </label>
        <label className="flex flex-col gap-1 text-sm">
          <span className="text-zinc-400">{t("proxies.name")}</span>
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder={t("common.optional")}
            className="w-36 rounded-lg border border-zinc-700 bg-zinc-800 px-3 py-2 text-zinc-100 outline-none focus:border-indigo-500"
          />
        </label>
        <label className="flex flex-col gap-1 text-sm">
          <span className="text-zinc-400">{t("proxies.username")}</span>
          <input
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            placeholder={t("common.optional")}
            className="w-32 rounded-lg border border-zinc-700 bg-zinc-800 px-3 py-2 text-zinc-100 outline-none focus:border-indigo-500"
          />
        </label>
        <label className="flex flex-col gap-1 text-sm">
          <span className="text-zinc-400">{t("proxies.password")}</span>
          <input
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            placeholder={t("common.optional")}
            className="w-32 rounded-lg border border-zinc-700 bg-zinc-800 px-3 py-2 text-zinc-100 outline-none focus:border-indigo-500"
          />
        </label>
        <button
          type="button"
          onClick={() => void addProxy()}
          disabled={busy || !host.trim()}
          className="rounded-lg bg-indigo-600 px-4 py-2 text-sm font-medium text-white hover:bg-indigo-500 disabled:opacity-50"
        >
          {t("servers.addShort")}
        </button>
      </div>

      <div className="overflow-x-auto rounded-xl border border-zinc-800">
        <table className="w-full text-left text-sm">
          <thead className="bg-zinc-900 text-xs text-zinc-500 uppercase">
            <tr>
              <th className="px-4 py-2.5">{t("proxies.name")}</th>
              <th className="px-4 py-2.5">{t("proxies.protocol")}</th>
              <th className="px-4 py-2.5">{t("proxies.address")}</th>
              <th className="px-4 py-2.5">{t("proxies.auth")}</th>
              <th className="px-4 py-2.5">{t("proxies.status")}</th>
              <th className="px-4 py-2.5 text-right">{t("servers.actionsColumn")}</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-zinc-800/60">
            {proxies.length === 0 && (
              <tr>
                <td colSpan={6} className="px-4 py-6 text-center text-zinc-600">
                  {t("proxies.empty")}
                </td>
              </tr>
            )}
            {proxies.slice(0, 100).map((p) => {
              const st = tests[p.id];
              return (
                <tr key={p.id} className="bg-zinc-900/40 hover:bg-zinc-900">
                  <td className="px-4 py-2 font-medium text-zinc-200">{p.name}</td>
                  <td className="px-4 py-2 text-xs text-zinc-400 uppercase">{p.protocol}</td>
                  <td className="mono px-4 py-2 text-zinc-400">
                    {p.host}:{p.port}
                  </td>
                  <td className="px-4 py-2 text-xs text-zinc-500">
                    {p.username ? p.username : p.hasPassword ? "••••" : t("common.none")}
                  </td>
                  <td className="px-4 py-2 text-xs">
                    <button
                      type="button"
                      onClick={() => void toggleEnabled(p)}
                      className={`mr-2 rounded px-1.5 py-0.5 ${
                        p.enabled ? "bg-emerald-950/70 text-emerald-300" : "bg-zinc-800 text-zinc-500"
                      }`}
                    >
                      {p.enabled ? t("common.enabled") : t("common.disabled")}
                    </button>
                    {st?.busy && <span className="text-zinc-400">{t("common.loading")}</span>}
                    {st && !st.busy && st.ok && <span className="text-emerald-400">{st.latencyMs} ms</span>}
                    {st && !st.busy && st.ok === false && (
                      <span className="text-red-400" title={st.error}>
                        {t("common.error")}
                      </span>
                    )}
                  </td>
                  <td className="px-4 py-2 text-right text-xs">
                    <button
                      type="button"
                      disabled={st?.busy}
                      onClick={() => void testOne(p)}
                      className="mr-3 text-indigo-400 hover:underline disabled:opacity-50"
                    >
                      {t("proxies.test")}
                    </button>
                    <button type="button" onClick={() => void remove(p)} className="text-red-400 hover:underline">
                      {t("common.delete")}
                    </button>
                  </td>
                </tr>
              );
            })}
            {proxies.length > 100 && (
              <tr>
                <td colSpan={6} className="px-4 py-2 text-center text-xs text-zinc-500">
                  {t("proxies.moreCount", { n: proxies.length - 100 })}
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
