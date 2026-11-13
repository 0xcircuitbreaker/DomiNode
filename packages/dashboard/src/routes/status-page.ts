import { Router } from "express";
import type { Request, Response } from "express";
import { createLogger, networkStatusRepo, policyRepo } from "@dominusnode/shared";
import { getNetworkStats, type NetworkStats } from "./v1/public.js";

/**
 * Public network status page (GET /status). Server-rendered HTML with no
 * scripts, built only from aggregate snapshots and the incident log: no node
 * ids, IPs or requester data. Data endpoints: /v1/network/stats, /history,
 * /incidents.
 */
const log = createLogger("api:status-page");
const router = Router();

export function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c] as string));
}

const gb = (bytes: string) => {
  const b = /^\d{1,20}$/.test(bytes) ? BigInt(bytes) : 0n;
  return `${b / 1_000_000_000n}.${((b % 1_000_000_000n) / 10_000_000n).toString().padStart(2, "0")}`;
};
const pct = (bps: number | null) => (bps === null ? "n/a" : `${(bps / 100).toFixed(2)}%`);
const ms = (v: number | null) => (v === null ? "n/a" : `${v} ms`);

type Snap = Awaited<ReturnType<typeof networkStatusRepo.listSnapshots>>[number];

/** A figure hidden by k-anonymity renders as "<3" instead of a misleading 0. */
const SUPPRESSED = `<${networkStatusRepo.PUBLIC_MIN_GROUP}`;
const fig = (o: { suppressed?: string[] }, field: string, v: string): string =>
  (o.suppressed ?? []).includes(field) ? SUPPRESSED : v;
type Incident = Awaited<ReturnType<typeof networkStatusRepo.listIncidents>>[number];

/** "Live now" card: operator-run vs community split and countries available (aggregate only). */
export function renderLiveSection(live: NetworkStats | null): string {
  if (!live) return "<p>Live figures unavailable.</p>";
  const row = (k: string, v: string) => `<tr><th scope="row">${escapeHtml(k)}</th><td>${escapeHtml(v)}</td></tr>`;
  const listed = live.byCountry.map((c) => c.country).join(", ");
  return `<div class="card"><table>${[
    row("Nodes online now", fig(live, "onlineNodes", String(live.onlineNodes))),
    row("Operator-run nodes / community nodes", `${fig(live, "seedOnline", String(live.seed.online))} / ${fig(live, "communityOnline", String(live.community.online))}`),
    row("Countries available", fig(live, "countriesAvailable", String(live.countriesAvailable))),
    row("Countries with 3+ nodes", listed || "none yet"),
  ].join("")}</table></div>`;
}

export function renderStatusPage(snaps: Snap[], incidents: Incident[], policy: { version: number; sha256: string } | null, now = new Date(), live: NetworkStats | null = null): string {
  const last = snaps.at(-1) ?? null;
  const day = snaps.filter((s) => now.getTime() - new Date(s.hour).getTime() <= 24 * 3_600_000);
  const open = incidents.filter((i) => i.status !== "resolved");
  const overall = !last ? "No data yet" : open.some((i) => i.severity === "critical" || i.severity === "major") ? "Degraded" : "Operational";
  const row = (k: string, v: string) => `<tr><th scope="row">${escapeHtml(k)}</th><td>${escapeHtml(v)}</td></tr>`;
  const summary = last
    ? [
        row("Nodes online", fig(last, "onlineNodes", String(last.onlineNodes))),
        row("Operator seed nodes / community nodes", `${fig(last, "seedOnline", String(last.seedOnline))} / ${fig(last, "communityOnline", String(last.communityOnline))}`),
        row("Countries / ASNs", `${fig(last, "countries", String(last.countries))} / ${fig(last, "asns", String(last.asns))}`),
        row("Stream success rate (today and yesterday)", pct(last.successRateBps)),
        row("Connect latency p50 / p95", `${ms(last.p50Ms)} / ${ms(last.p95Ms)}`),
        row("Paid GB, last 24 h (seed / community)", `${fig(last, "paidBytes24h", gb(last.paidBytes24h))} (${fig(last, "seedPaidBytes24h", gb(last.seedPaidBytes24h))} / ${fig(last, "communityPaidBytes24h", gb(last.communityPaidBytes24h))})`),
        row("Snapshot", new Date(last.hour).toISOString()),
      ].join("")
    : row("Status", "No snapshot has been taken yet.");
  const history = day.slice(-24).reverse().map((s) =>
    `<tr><td>${escapeHtml(new Date(s.hour).toISOString().slice(0, 16).replace("T", " "))}</td><td>${escapeHtml(fig(s, "onlineNodes", String(s.onlineNodes)))}</td><td>${escapeHtml(`${fig(s, "seedOnline", String(s.seedOnline))}/${fig(s, "communityOnline", String(s.communityOnline))}`)}</td><td>${escapeHtml(pct(s.successRateBps))}</td><td>${escapeHtml(ms(s.p50Ms))}</td><td>${escapeHtml(ms(s.p95Ms))}</td><td>${escapeHtml(fig(s, "paidBytes24h", gb(s.paidBytes24h)))}</td></tr>`,
  ).join("");
  const inc = incidents.length === 0 ? "<p>No incidents reported.</p>" : `<ul>${incidents.map((i) =>
    `<li><strong>${escapeHtml(i.title)}</strong> <span class="tag">${escapeHtml(i.severity)}</span> <span class="tag">${escapeHtml(i.status)}</span><br>` +
    `<small>${escapeHtml(new Date(i.startedAt).toISOString())}${i.resolvedAt ? ` to ${escapeHtml(new Date(i.resolvedAt).toISOString())}` : ""}</small>` +
    (i.body ? `<p>${escapeHtml(i.body)}</p>` : "") + `</li>`).join("")}</ul>`;
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Dominus Node network status</title>
<style>
:root{color-scheme:light dark;--fg:#0f172a;--bg:#f8fafc;--muted:#64748b;--line:#e2e8f0;--card:#fff}
@media (prefers-color-scheme:dark){:root{--fg:#e2e8f0;--bg:#020617;--muted:#94a3b8;--line:#1e293b;--card:#0f172a}}
body{margin:0;font:15px/1.5 system-ui,sans-serif;color:var(--fg);background:var(--bg)}
main{max-width:860px;margin:0 auto;padding:24px 16px}
h1{font-size:22px;margin:0 0 4px}h2{font-size:17px;margin:28px 0 8px}
.card{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:12px 16px;overflow-x:auto}
table{border-collapse:collapse;width:100%}th,td{text-align:left;padding:6px 8px;border-bottom:1px solid var(--line);font-variant-numeric:tabular-nums}
th[scope=row]{font-weight:500;color:var(--muted);width:55%}.tag{font-size:12px;border:1px solid var(--line);border-radius:6px;padding:0 6px}
small,.muted{color:var(--muted)}ul{padding-left:18px}
</style></head><body><main>
<h1>Network status: ${escapeHtml(overall)}</h1>
<p class="muted">Aggregate figures only; node identities and IPs are never published. Alpha service.</p>
<div class="card"><table>${summary}</table></div>
<h2>Live now</h2>
${renderLiveSection(live)}
<h2>Last 24 hours</h2>
<div class="card"><table><thead><tr><th>Hour (UTC)</th><th>Online</th><th>Seed/community</th><th>Success</th><th>p50</th><th>p95</th><th>Paid GB 24h</th></tr></thead><tbody>${history}</tbody></table></div>
<h2>Incidents</h2>
<div class="card">${inc}</div>
<h2>Policy</h2>
<p>${policy ? `Active policy version ${policy.version}, SHA-256 <code>${escapeHtml(policy.sha256)}</code>.` : "Policy unavailable."} Machine-readable: <a href="/v1/policy">/v1/policy</a>, <a href="/v1/network/stats">/v1/network/stats</a>, <a href="/v1/network/history">/v1/network/history</a>, <a href="/v1/network/incidents">/v1/network/incidents</a>, <a href="/v1/network/wanted">/v1/network/wanted</a>.</p>
<p>Report abuse through an exit IP with <code>POST /v1/abuse-reports</code> (proof-of-work gated; see <a href="/.well-known/agent-tool.json">/.well-known/agent-tool.json</a>).</p>
</main></body></html>`;
}

router.get("/status", async (_req: Request, res: Response) => {
  try {
    const [snaps, incidents, policy, live] = await Promise.all([
      networkStatusRepo.listSnapshots(48),
      networkStatusRepo.listIncidents(20),
      policyRepo.getActivePolicy().then((p) => ({ version: p.version, sha256: p.sha256 })).catch(() => null),
      getNetworkStats().catch(() => null),
    ]);
    res.setHeader("Cache-Control", "public, max-age=60");
    res.removeHeader("Pragma");
    res.type("text/html; charset=utf-8").send(renderStatusPage(snaps, incidents, policy, new Date(), live));
  } catch (err) {
    log.error("status page failed", { error: err instanceof Error ? err.message : String(err) });
    res.status(503).type("text/plain").send("Status temporarily unavailable\n");
  }
});

export default router;
