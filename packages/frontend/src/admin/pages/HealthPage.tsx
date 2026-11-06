import { useEffect } from "react";
import { useApi } from "../../hooks/useApi";
import { adminApi } from "../../api/admin";
import { fmtAgo, fmtDate, fmtInt } from "../../lib/format";
import { Badge, Card, DataTable, ErrorBox, Kpi, Loading, PageHeader, cx } from "../components/ui";

function fmtInterval(ms: number | null): string {
  if (ms === null) return "—";
  if (ms < 60_000) return `${Math.round(ms / 1000)} s`;
  if (ms < 3_600_000) return `${Math.round(ms / 60_000)} min`;
  return `${(ms / 3_600_000).toFixed(ms % 3_600_000 ? 1 : 0)} h`;
}

export default function HealthPage() {
  const h = useApi(() => adminApi.health());
  useEffect(() => {
    const t = setInterval(h.refetch, 30_000);
    return () => clearInterval(t);
  }, [h.refetch]);

  if (h.loading && !h.data) return <Loading />;
  if (!h.data) return <ErrorBox error={h.error ?? "Failed to load"} onRetry={h.refetch} />;
  const d = h.data;
  const stale = d.jobs.filter((j) => j.stale).length;
  const q = d.settleRetryQueue;

  return (
    <div>
      <PageHeader title="Health" subtitle={`Generated ${fmtDate(d.generatedAt)} · refreshes every 30 s`}
        actions={<button type="button" className="btn-secondary" onClick={h.refetch}>Refresh</button>} />
      <ErrorBox error={h.error} />
      <div className="mb-4 grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Kpi label="Stale jobs" value={fmtInt(stale)} sub={`${d.jobs.length} jobs tracked`} tone={stale > 0 ? "bad" : "good"} />
        <Kpi label="Settle-retry queue" value={fmtInt(q.pending)} tone={q.dead > 0 ? "bad" : q.pending > 0 ? "warn" : "good"}
          sub={`${fmtInt(q.due)} due · ${fmtInt(q.dead)} dead (≥${q.maxAttempts} attempts) · oldest ${fmtAgo(q.oldestPendingAt)}`} />
        <Kpi label="Gateways" value={fmtInt(d.gateway.liveInstances)} sub={`${fmtInt(d.gateway.connectedNodes)} nodes · heartbeat ${fmtAgo(d.gateway.lastHeartbeatAt)}`}
          tone={d.gateway.liveInstances === 0 ? "bad" : undefined} />
        <Kpi label="API DB pool" value={`${d.dbPool.total ?? "—"} conn`} sub={`${d.dbPool.idle ?? "—"} idle · ${d.dbPool.waiting ?? "—"} waiting`}
          tone={(d.dbPool.waiting ?? 0) > 0 ? "warn" : undefined} />
      </div>
      <Card title="Background jobs" bodyClassName="pt-0">
        <DataTable caption="Background jobs" rowKey={(j) => j.name} rows={d.jobs}
          columns={[
            { key: "n", header: "Job", render: (j) => <span className={cx("font-medium", j.stale && "text-red-600 dark:text-red-400")}>{j.name}</span> },
            { key: "s", header: "State", render: (j) => (j.stale ? <Badge tone="bad">stale</Badge> : j.lastOk === false ? <Badge tone="bad">failed</Badge> : j.lastOk ? <Badge tone="good">ok</Badge> : <Badge>never ran</Badge>) },
            { key: "l", header: "Last finished", render: (j) => <span title={fmtDate(j.lastFinishedAt)}>{fmtAgo(j.lastFinishedAt)}</span> },
            { key: "ok", header: "Last success", render: (j) => <span title={fmtDate(j.lastSuccessAt)}>{fmtAgo(j.lastSuccessAt)}</span> },
            { key: "i", header: "Interval", align: "right", render: (j) => fmtInterval(j.expectedIntervalMs) },
            { key: "d", header: "Duration", align: "right", render: (j) => (j.lastDurationMs === null ? "—" : `${fmtInt(j.lastDurationMs)} ms`) },
            { key: "r", header: "Runs / fails", align: "right", render: (j) => `${fmtInt(j.runCount)} / ${fmtInt(j.failCount)}` },
            { key: "inst", header: "Instance", render: (j) => j.instanceId ?? "—" },
            { key: "e", header: "Last error", render: (j) => <span title={j.lastError ?? ""} className="text-xs">{j.lastError ?? "—"}</span>, className: "max-w-xs truncate" },
          ]} />
        <p className="mt-2 text-xs text-slate-500">A job is stale when it has not run within 3× its expected interval. <code>probes</code> and <code>payouts</code> only run when enabled.</p>
      </Card>
    </div>
  );
}
