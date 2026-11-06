import { useEffect, useState } from "preact/hooks";
import {
  fmtCents,
  fmtMusd,
  isNodeOnline,
  type CreditsResponse,
  type NodeView,
  type PricingResponse,
  type TierResponse,
} from "../shared/api-client.js";
import { safeParse } from "../shared/json.js";
import { nodeSetupGuide, osFromPlatform, type GuideOs } from "../shared/node-guide.js";
import { send, type Status } from "../ui/bridge.js";

type Tab = "connection" | "control" | "nodes" | "contribute" | "pricing";

function useAsync() {
  const [err, setErr] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const wrap = async <T,>(fn: () => Promise<T>, ok?: string): Promise<T | undefined> => {
    setErr(null);
    setMsg(null);
    try {
      const r = await fn();
      if (ok) setMsg(ok);
      return r;
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
      return undefined;
    }
  };
  return { err, msg, wrap };
}

function Banner({ err, msg }: { err: string | null; msg: string | null }) {
  return (
    <>
      {err && <div class="error-banner">{err}</div>}
      {msg && <div class="text-sm text-success">{msg}</div>}
    </>
  );
}

function Connection({ st, setSt }: { st: Status; setSt: (s: Status) => void }) {
  const s = st.settings;
  const { err, msg, wrap } = useAsync();
  const [key, setKey] = useState("");
  const [form, setForm] = useState({
    apiBase: s.apiBase,
    gatewayHost: s.gatewayHost,
    gatewayPort: String(s.gatewayPort),
    spendCap: s.spendCapCents === null ? "" : (s.spendCapCents / 100).toFixed(2),
    rotateMinutes: String(s.rotateMinutes),
    exitCheckUrl: s.exitCheckUrl ?? "",
  });
  const [importText, setImportText] = useState("");
  const locked = (k: string) => st.managedKeys.includes(k);
  const field = (k: keyof typeof form) => ({
    value: form[k],
    onInput: (e: Event) => setForm({ ...form, [k]: (e.target as HTMLInputElement).value }),
  });

  const save = () =>
    wrap(async () => {
      const cap = form.spendCap.trim() === "" ? null : Math.round(parseFloat(form.spendCap) * 100);
      if (cap !== null && !Number.isFinite(cap)) throw new Error("Spend cap must be a dollar amount");
      const patch: Record<string, unknown> = {
        apiBase: form.apiBase.trim(),
        gatewayHost: form.gatewayHost.trim(),
        gatewayPort: parseInt(form.gatewayPort, 10),
        spendCapCents: cap,
        rotateMinutes: parseInt(form.rotateMinutes, 10) || 0,
        exitCheckUrl: form.exitCheckUrl.trim() || null,
      };
      for (const k of st.managedKeys) delete patch[k];
      setSt(await send("updateSettings", patch));
    }, "Saved");

  return (
    <div class="stack">
      <Banner err={err} msg={msg} />
      {st.managedKeys.length > 0 && <div class="warn-banner">Managed by enterprise policy: {st.managedKeys.join(", ")}</div>}
      <section class="card stack-sm">
        <div class="section-title">API key</div>
        <div class="text-sm text-muted">
          Stored only in chrome.storage.local on this profile (never synced). Used as the proxy password and for /v1 calls.
        </div>
        <div>Current: {st.hasApiKey ? <span class="mono">{st.keyPrefix}</span> : <span class="text-warning">none</span>}</div>
        <div class="row" style="gap:8px">
          <input class="input flex-1" type="password" autocomplete="off" placeholder="dn_live_…" value={key} disabled={locked("apiKey")} onInput={(e) => setKey((e.target as HTMLInputElement).value)} />
          <button class="btn btn-primary btn-sm" disabled={!key || locked("apiKey")} onClick={() => wrap(async () => { setSt(await send("setApiKey", key)); setKey(""); }, "Key saved")}>Save key</button>
          <button class="btn btn-danger btn-sm" disabled={!st.hasApiKey || locked("apiKey")} onClick={() => wrap(async () => setSt(await send("setApiKey", null)), "Key removed")}>Remove</button>
        </div>
      </section>

      <section class="card stack-sm">
        <div class="section-title">Gateway & limits</div>
        <label class="stack-sm">API base<input class="input" {...field("apiBase")} disabled={locked("apiBase")} /></label>
        <div class="row" style="gap:8px">
          <label class="stack-sm flex-1">Gateway host<input class="input" {...field("gatewayHost")} disabled={locked("gatewayHost")} /></label>
          <label class="stack-sm">Port<input class="input" {...field("gatewayPort")} disabled={locked("gatewayPort")} /></label>
        </div>
        <label class="stack-sm">
          Spend cap per run (USD, empty = none). When reached, proxying stops and traffic is blocked (never sent direct).
          <input class="input" placeholder="e.g. 5.00" {...field("spendCap")} disabled={locked("spendCapCents")} />
        </label>
        <label class="stack-sm">Auto-rotate sticky session every N minutes (0 = off)<input class="input" {...field("rotateMinutes")} disabled={locked("rotateMinutes")} /></label>
        <label class="stack-sm">
          Exit check URL (optional, https, fetched through the proxy; JSON with ip/country)
          <input class="input" placeholder="https://ipinfo.io/json" {...field("exitCheckUrl")} disabled={locked("exitCheckUrl")} />
        </label>
        <label class="row-between">
          <span>
            Plaintext HTTP (allowhttp-1). <span class="text-warning">Exit-visible: the node operator can read unencrypted HTTP.</span>
          </span>
          <span class="toggle">
            <input type="checkbox" checked={s.plaintext} disabled={locked("plaintext")} onChange={(e) => wrap(async () => setSt(await send("updateSettings", { plaintext: (e.target as HTMLInputElement).checked })))} />
            <span class="toggle-slider" />
          </span>
        </label>
        <button class="btn btn-primary" onClick={save}>Save</button>
      </section>

      <section class="card stack-sm">
        <div class="section-title">One-time import</div>
        <div class="text-sm text-muted">Paste the same JSON accepted by the managed policy (see README). Invalid keys reject the whole import.</div>
        <textarea class="input" value={importText} onInput={(e) => setImportText((e.target as HTMLTextAreaElement).value)} placeholder='{"apiKey":"dn_live_…","country":"US","ipClass":"residential","enabled":true}' />
        <div class="row" style="gap:8px">
          <input type="file" accept="application/json,.json" onChange={async (e) => {
            const f = (e.target as HTMLInputElement).files?.[0];
            if (f && f.size < 64 * 1024) setImportText(await f.text());
          }} />
          <button class="btn btn-primary btn-sm" disabled={!importText} onClick={() => wrap(async () => { setSt(await send("importConfig", safeParse(importText, 64 * 1024))); setImportText(""); }, "Imported")}>Import</button>
        </div>
      </section>
    </div>
  );
}

function Control({ st, setSt }: { st: Status; setSt: (s: Status) => void }) {
  const { err, msg, wrap } = useAsync();
  const [ids, setIds] = useState(st.settings.controlExtensionIds.join("\n"));
  const [origins, setOrigins] = useState(st.settings.controlPageOrigins.join("\n"));
  const lines = (t: string) => t.split(/\s+/).map((x) => x.trim()).filter(Boolean);
  return (
    <div class="stack">
      <Banner err={err} msg={msg} />
      <section class="card stack-sm">
        <div class="section-title">Allowed extension IDs (chrome.runtime.sendMessage)</div>
        <div class="text-sm text-muted">One 32-char extension ID per line. Empty = no external control.</div>
        <textarea class="input" value={ids} disabled={st.managedKeys.includes("controlExtensionIds")} onInput={(e) => setIds((e.target as HTMLTextAreaElement).value)} />
      </section>
      <section class="card stack-sm">
        <div class="section-title">Page bridge origins (window.postMessage)</div>
        <div class="text-sm text-muted">
          Disabled by default. Listed origins (https, or http://localhost) get a content script that relays control messages.
          Any script on those pages can change routing, so list only origins you control.
        </div>
        <textarea class="input" value={origins} disabled={st.managedKeys.includes("controlPageOrigins")} onInput={(e) => setOrigins((e.target as HTMLTextAreaElement).value)} />
      </section>
      <button class="btn btn-primary" onClick={() => wrap(async () => {
        const patch: Record<string, unknown> = { controlExtensionIds: lines(ids), controlPageOrigins: lines(origins) };
        for (const k of st.managedKeys) delete patch[k];
        setSt(await send("updateSettings", patch));
      }, "Saved")}>Save</button>
      <div class="text-sm text-muted">
        Control messages can change only: enabled, country, ipClass, sticky, sessionId, rotateMinutes, plaintext. The API key, gateway, spend cap and these allowlists are operator-only.
      </div>
    </div>
  );
}

interface NodeInfo { nodes: NodeView[]; tier: TierResponse | null; credits: CreditsResponse | null; errors: string[] }

function Nodes({ st }: { st: Status }) {
  const { err, wrap } = useAsync();
  const [info, setInfo] = useState<NodeInfo | null>(null);
  const load = () => wrap(async () => setInfo(await send<NodeInfo>("getNodeInfo")));
  useEffect(() => { if (st.hasApiKey) void load(); }, []);
  if (!st.hasApiKey) return <div class="warn-banner">Add an API key first.</div>;
  const t = info?.tier;
  return (
    <div class="stack">
      <Banner err={err} msg={null} />
      {info?.errors.map((e) => <div class="text-sm text-error">{e}</div>)}
      <div class="row" style="gap:12px;align-items:flex-start">
        <section class="card stack-sm flex-1">
          <div class="section-title">Credits</div>
          <dl class="kv">
            <dt>Pending</dt><dd>{fmtMusd(info?.credits?.pending.musd)}</dd>
            <dt>Available</dt><dd>{fmtMusd(info?.credits?.available.musd)}</dd>
            <dt>Payouts</dt><dd>{info?.credits ? (info.credits.payoutsEnabled ? "enabled" : "disabled") : "—"}{info?.credits?.frozen ? " (frozen)" : ""}</dd>
          </dl>
        </section>
        <section class="card stack-sm flex-1">
          <div class="section-title">Tier</div>
          {t ? (
            <dl class="kv">
              <dt>Tier</dt><dd>{t.tier.name} ({(t.tier.nodeShareBps / 100).toFixed(0)}% share)</dd>
              <dt>Node cap</dt><dd>{t.tier.maxNodes}</dd>
              <dt>Next</dt><dd>{t.nextTier ? `${t.nextTier.name} (${(t.nextTier.nodeShareBps / 100).toFixed(0)}%)` : "top tier"}</dd>
              {t.progress && Object.entries(t.progress).filter(([, r]) => r).map(([k, r]) => (
                <><dt>{k}</dt><dd>{r!.current ?? "?"} / {r!.required} {r!.met ? "✓" : ""}</dd></>
              ))}
              {t.demotionReason && (<><dt>Demotion</dt><dd class="text-warning">{t.demotionReason}</dd></>)}
            </dl>
          ) : "—"}
        </section>
      </div>
      <section class="card stack-sm">
        <div class="row-between"><div class="section-title">Your nodes ({info?.nodes.length ?? 0})</div><button class="btn btn-secondary btn-sm" onClick={load}>Refresh</button></div>
        {info && info.nodes.length === 0 && <div class="text-muted">No nodes yet. See "Contribute this machine".</div>}
        {info && info.nodes.length > 0 && (
          <table class="list">
            <thead><tr><th>Node</th><th>Online</th><th>IP</th><th>Country</th><th>Class</th><th>Rep</th><th>Last seen</th></tr></thead>
            <tbody>
              {info.nodes.map((n) => (
                <tr>
                  <td class="mono">{n.id.slice(0, 8)}</td>
                  <td><span class={`pill ${isNodeOnline(n) ? "on" : "off"}`}>{isNodeOnline(n) ? "online" : n.status}</span></td>
                  <td class="mono">{n.observedIp ?? "—"}</td>
                  <td>{n.country ?? "—"}</td>
                  <td>{n.ipClass ?? "—"}</td>
                  <td>{n.reputation ?? "—"}</td>
                  <td>{n.lastSeenAt ? new Date(n.lastSeenAt).toLocaleString() : "never"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
    </div>
  );
}

function Contribute() {
  const [os, setOs] = useState<GuideOs>("linux");
  useEffect(() => { void send<string>("getPlatform").then((p) => setOs(osFromPlatform(p))).catch(() => {}); }, []);
  return (
    <div class="stack">
      <div class="text-sm text-muted">
        The extension never relays traffic: browsers cannot open raw TCP and must not see other agents' traffic.
        Run the node agent on the machine whose IP you contribute.
      </div>
      <div class="tab-group">
        {(["linux", "mac", "win"] as GuideOs[]).map((o) => (
          <button class={`tab ${o === os ? "active" : ""}`} onClick={() => setOs(o)}>{o === "win" ? "Windows" : o === "mac" ? "macOS" : "Linux"}</button>
        ))}
      </div>
      {nodeSetupGuide(os).map((step) => (
        <section class="card stack-sm">
          <div class="section-title">{step.title}</div>
          {step.text?.map((t) => <div class="text-sm">{t}</div>)}
          {step.commands && <pre class="code">{step.commands.join("\n")}</pre>}
        </section>
      ))}
    </div>
  );
}

function Pricing() {
  const { err, wrap } = useAsync();
  const [p, setP] = useState<PricingResponse | null>(null);
  useEffect(() => { void wrap(async () => setP(await send<PricingResponse>("getPricing"))); }, []);
  return (
    <div class="stack">
      <Banner err={err} msg={null} />
      <section class="card stack-sm">
        <div class="section-title">Price per GB (live, GET /v1/pricing)</div>
        <table class="list">
          <tbody>{p?.prices.map((x) => <tr><td>{x.ipClass}</td><td>{fmtMusd(x.pricePerGbMusd)} / GB</td></tr>)}</tbody>
        </table>
      </section>
      <section class="card stack-sm">
        <div class="section-title">Node share by tier</div>
        <table class="list">
          <tbody>{p?.nodeShare.map((x) => <tr><td>{x.tier}</td><td>{(x.nodeShareBps / 100).toFixed(0)}%</td></tr>)}</tbody>
        </table>
        {p && <div class="text-sm text-muted">Earnings mature after {p.maturationHours} h.</div>}
      </section>
    </div>
  );
}

export function App() {
  const [st, setSt] = useState<Status | null>(null);
  const [tab, setTab] = useState<Tab>("connection");
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => { void send("getStatus").then(setSt).catch((e) => setErr(String(e?.message ?? e))); }, []);
  const tabs: [Tab, string][] = [
    ["connection", "Connection"], ["control", "Agent control"], ["nodes", "Nodes"], ["contribute", "Contribute this machine"], ["pricing", "Pricing"],
  ];
  return (
    <div class="options-container stack">
      <div class="row-between">
        <h1 class="header-title">DominusNode Agent Companion</h1>
        {st && <span class="text-sm text-muted">Mode: {st.mode} · spent {fmtCents(st.run.spentCents)} · flags <span class="mono">{st.username}</span></span>}
      </div>
      {err && <div class="error-banner">{err}</div>}
      <div class="tab-group">{tabs.map(([k, l]) => <button class={`tab ${tab === k ? "active" : ""}`} onClick={() => setTab(k)}>{l}</button>)}</div>
      {st && tab === "connection" && <Connection st={st} setSt={setSt} />}
      {st && tab === "control" && <Control st={st} setSt={setSt} />}
      {st && tab === "nodes" && <Nodes st={st} />}
      {tab === "contribute" && <Contribute />}
      {tab === "pricing" && <Pricing />}
    </div>
  );
}
