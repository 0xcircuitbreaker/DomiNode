import { useEffect, useState } from "preact/hooks";
import { fmtCents } from "../shared/api-client.js";
import { send, type Status } from "../ui/bridge.js";
import { ALL_COUNTRIES } from "../ui/countries.js";

const MODE_LABEL: Record<Status["mode"], string> = {
  off: "Off (direct)",
  proxying: "Connected",
  blocked: "Blocked",
  no_key: "No API key (blocked)",
};

export function App() {
  const [st, setSt] = useState<Status | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const run = async (type: string, payload?: unknown) => {
    setBusy(true);
    setErr(null);
    try {
      setSt(await send(type, payload));
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  useEffect(() => {
    void run("getStatus");
    const t = setInterval(() => void send("getStatus").then(setSt).catch(() => {}), 5000);
    return () => clearInterval(t);
  }, []);

  if (!st) return <div class="stack" style="padding:16px">{err ? <div class="error-banner">{err}</div> : "Loading…"}</div>;
  const s = st.settings;
  const locked = (k: string) => st.managedKeys.includes(k);
  const set = (patch: Record<string, unknown>) => run("updateSettings", patch);

  return (
    <div class="stack" style="padding:14px">
      <div class="row-between">
        <strong>DominusNode Agent</strong>
        <span class={`pill ${st.mode === "proxying" ? "on" : st.mode === "off" ? "" : "off"}`}>{MODE_LABEL[st.mode]}</span>
      </div>
      {err && <div class="error-banner">{err}</div>}
      {st.run.blockReason && st.mode === "blocked" && <div class="error-banner">{st.run.blockReason}</div>}
      {!st.hasApiKey && <div class="warn-banner">No API key. Open options to add one (or ship a managed policy).</div>}
      {s.plaintext && <div class="warn-banner">Plaintext HTTP is on (allowhttp-1): the exit node can read unencrypted traffic.</div>}

      <dl class="kv">
        <dt>Flags</dt>
        <dd class="mono">{st.username}</dd>
        <dt>Balance</dt>
        <dd>{fmtCents(st.run.lastBalanceCents)}</dd>
        <dt>Spent this run</dt>
        <dd>
          {fmtCents(st.run.spentCents)}
          {s.spendCapCents !== null ? ` / cap ${fmtCents(s.spendCapCents)}` : " (no cap)"}
        </dd>
        <dt>Exit</dt>
        <dd>{st.exit ? `${st.exit.country ?? "?"} ${st.exit.ip ?? ""}` : s.country ? `requested ${s.country}` : "any"}</dd>
      </dl>

      <label class="row-between">
        <span>Proxy this profile</span>
        <span class="toggle">
          <input type="checkbox" checked={s.enabled} disabled={busy || locked("enabled")} onChange={(e) => set({ enabled: (e.target as HTMLInputElement).checked })} />
          <span class="toggle-slider" />
        </span>
      </label>

      <div class="row" style="gap:8px">
        <select class="select flex-1" value={s.country ?? ""} disabled={busy || locked("country")} onChange={(e) => set({ country: (e.target as HTMLSelectElement).value || null })}>
          <option value="">Any country</option>
          {ALL_COUNTRIES.map((c) => (
            <option value={c.code}>{c.code} {c.name}</option>
          ))}
        </select>
        <select class="select flex-1" value={s.ipClass ?? ""} disabled={busy || locked("ipClass")} onChange={(e) => set({ ipClass: (e.target as HTMLSelectElement).value || null })}>
          <option value="">Any class</option>
          <option value="residential">Residential</option>
          <option value="dc">Datacenter</option>
          <option value="mobile">Mobile</option>
        </select>
      </div>

      <label class="row-between">
        <span>Sticky session</span>
        <span class="toggle">
          <input type="checkbox" checked={s.sticky} disabled={busy || locked("sticky")} onChange={(e) => set({ sticky: (e.target as HTMLInputElement).checked })} />
          <span class="toggle-slider" />
        </span>
      </label>

      <div class="row" style="gap:8px">
        <button class="btn btn-secondary btn-sm" disabled={busy || !s.sticky} onClick={() => run("rotateSession")}>Rotate IP</button>
        <button class="btn btn-secondary btn-sm" disabled={busy || !s.exitCheckUrl || st.mode !== "proxying"} onClick={() => run("checkExit")}>Check exit</button>
        <button class="btn btn-secondary btn-sm" disabled={busy || !st.hasApiKey} onClick={() => run("refreshBalance")}>Refresh</button>
        <button class="btn btn-secondary btn-sm" disabled={busy} onClick={() => run("resetRun")} title="Start a new run (resets spend this run)">New run</button>
      </div>
      {st.run.lastError && <div class="text-sm text-error">{st.run.lastError}</div>}
      <button class="btn btn-primary btn-sm" onClick={() => chrome.runtime.openOptionsPage()}>Options, nodes & pricing</button>
    </div>
  );
}
