import { useEffect, useRef, useState, type FormEvent } from "react";
import ThemeToggle from "../components/ThemeToggle";
import { API_BASE } from "../landing/site";
import { solvePow } from "../landing/pow";

const CATEGORIES = ["spam", "credential_stuffing", "scraping", "fraud", "ddos", "illegal_content", "other"] as const;
const HOST_RE = /^(?=.{1,253}$)(?!-)[a-z0-9-]{1,63}(?<!-)(\.(?!-)[a-z0-9-]{1,63}(?<!-))+$/;
const MAX_BYTES = 64 * 1024;

async function postJson(path: string, body: unknown, signal: AbortSignal): Promise<Record<string, unknown>> {
  const res = await fetch(`${API_BASE}${path}`, {
    method: "POST", signal, credentials: "omit",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  if (!text || text.length > MAX_BYTES) throw new Error(`Unexpected response (HTTP ${res.status})`);
  const data = JSON.parse(text) as Record<string, unknown>;
  if (!res.ok) throw new Error(typeof data["error"] === "string" ? data["error"].slice(0, 300) : `HTTP ${res.status}`);
  return data;
}

/** Client-side checks that mirror the API (parseAbuseReport); the API stays authoritative. */
export function validateReport(f: { destHost: string; windowStart: string; windowEnd: string; description: string }): string | null {
  const host = f.destHost.trim().toLowerCase().replace(/\.$/, "");
  if (!HOST_RE.test(host) || /^[0-9.]+$/.test(host)) return "Target host must be a bare hostname, e.g. shop.example.com (no scheme, path, port or IP).";
  const ws = new Date(f.windowStart), we = new Date(f.windowEnd);
  if (Number.isNaN(ws.getTime()) || Number.isNaN(we.getTime())) return "Enter the start and end of the time window.";
  if (we < ws) return "The window end must not be before its start.";
  if (we.getTime() - ws.getTime() > 31 * 86_400_000) return "The time window can be at most 31 days.";
  const d = f.description.trim();
  if (d.length < 10 || d.length > 4000) return "The description must be 10 to 4000 characters.";
  return null;
}

type Phase = { k: "idle" } | { k: "working"; msg: string } | { k: "done"; id: string } | { k: "error"; msg: string };

export default function AbuseReportPage() {
  const [form, setForm] = useState({ destHost: "", windowStart: "", windowEnd: "", category: "other", description: "", contact: "" });
  const [phase, setPhase] = useState<Phase>({ k: "idle" });
  const ctl = useRef<AbortController | null>(null);
  useEffect(() => { document.title = "Report abuse · DominusNode"; return () => ctl.current?.abort(); }, []);

  const set = (k: keyof typeof form) => (e: { target: { value: string } }) => setForm((f) => ({ ...f, [k]: e.target.value }));

  async function submit(e: FormEvent) {
    e.preventDefault();
    const err = validateReport(form);
    if (err) { setPhase({ k: "error", msg: err }); return; }
    ctl.current?.abort();
    const c = new AbortController();
    ctl.current = c;
    try {
      setPhase({ k: "working", msg: "Requesting a proof-of-work challenge…" });
      const ch = await postJson("/v1/abuse-reports/challenge", {}, c.signal);
      const prefix = String(ch["prefix"] ?? ""), difficulty = Number(ch["difficulty"]), challengeId = String(ch["challengeId"] ?? "");
      setPhase({ k: "working", msg: "Solving the proof of work in your browser (usually a few seconds)…" });
      const nonce = await solvePow(prefix, difficulty, c.signal);
      setPhase({ k: "working", msg: "Sending the report…" });
      const r = await postJson("/v1/abuse-reports", {
        pow: { challengeId, nonce },
        destHost: form.destHost.trim().toLowerCase().replace(/\.$/, ""),
        windowStart: new Date(form.windowStart).toISOString(),
        windowEnd: new Date(form.windowEnd).toISOString(),
        category: form.category,
        description: form.description.trim(),
        ...(form.contact.trim() ? { contact: form.contact.trim() } : {}),
      }, c.signal);
      setPhase({ k: "done", id: String(r["id"] ?? "") });
    } catch (x) {
      if (c.signal.aborted) return;
      setPhase({ k: "error", msg: x instanceof Error ? `Could not send the report: ${x.message}` : "Could not send the report." });
    }
  }

  const input = "mt-1 w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm dark:border-slate-700 dark:bg-slate-900";
  const busy = phase.k === "working";
  return (
    <div className="min-h-screen bg-slate-50 text-slate-900 dark:bg-slate-950 dark:text-slate-100">
      <header className="border-b border-slate-200 dark:border-slate-800">
        <div className="mx-auto flex max-w-3xl items-center justify-between px-4 py-3">
          <a href="/" className="flex items-center gap-2 font-extrabold"><img src="/logo.svg" alt="" width={28} height={28} />DominusNode</a>
          <ThemeToggle compact />
        </div>
      </header>
      <main className="mx-auto max-w-3xl px-4 py-10">
        <h1 className="text-3xl font-extrabold tracking-tight">Report abuse from a DominusNode exit</h1>
        <p className="mt-3 text-sm text-slate-600 dark:text-slate-300">
          No account needed. Tell us which host received the traffic and when. Relays keep metadata only (time, requesting agent, node, destination host, bytes), so a host and time window are enough to trace and suspend the requesting agent. Your IP address is not stored with the report. A small proof of work runs in your browser instead of a captcha.
        </p>
        {phase.k === "done" ? (
          <div role="status" className="mt-8 rounded-xl border border-teal-600/40 bg-teal-50 p-5 dark:bg-teal-950/40">
            <p className="font-bold">Report received.</p>
            <p className="mt-1 text-sm">Reference <code className="font-mono">{phase.id}</code>. Target response time: 24 hours.</p>
          </div>
        ) : (
          <form onSubmit={submit} className="mt-8 grid gap-4" noValidate>
            <label className="text-sm font-semibold">Target host
              <input className={input} value={form.destHost} onChange={set("destHost")} placeholder="shop.example.com" autoComplete="off" required />
            </label>
            <div className="grid gap-4 sm:grid-cols-2">
              <label className="text-sm font-semibold">Window start
                <input className={input} type="datetime-local" value={form.windowStart} onChange={set("windowStart")} required />
              </label>
              <label className="text-sm font-semibold">Window end
                <input className={input} type="datetime-local" value={form.windowEnd} onChange={set("windowEnd")} required />
              </label>
            </div>
            <label className="text-sm font-semibold">Category
              <select className={input} value={form.category} onChange={set("category")}>
                {CATEGORIES.map((c) => <option key={c} value={c}>{c.replace(/_/g, " ")}</option>)}
              </select>
            </label>
            <label className="text-sm font-semibold">What happened
              <textarea className={input} rows={5} maxLength={4000} value={form.description} onChange={set("description")} required />
            </label>
            <label className="text-sm font-semibold">Contact (optional)
              <input className={input} value={form.contact} onChange={set("contact")} maxLength={254} autoComplete="email" />
            </label>
            {phase.k === "error" && <p role="alert" className="text-sm text-red-700 dark:text-red-400">{phase.msg}</p>}
            {phase.k === "working" && <p role="status" className="text-sm text-slate-600 dark:text-slate-300">{phase.msg}</p>}
            <button type="submit" disabled={busy} className="justify-self-start rounded-xl bg-teal-600 px-5 py-3 text-sm font-bold text-white hover:bg-teal-700 disabled:opacity-60">
              {busy ? "Working…" : "Send report"}
            </button>
          </form>
        )}
        <p className="mt-10 text-xs text-slate-500 [overflow-wrap:anywhere]">Agents can use the API directly: <code>POST {API_BASE}/v1/abuse-reports/challenge</code>, then <code>POST /v1/abuse-reports</code>. See <a className="underline" href="/docs/policy.md">policy.md</a>.</p>
      </main>
    </div>
  );
}
