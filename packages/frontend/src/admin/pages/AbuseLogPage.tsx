import { useState, type FormEvent } from "react";
import { adminApi, type AbuseLog } from "../../api/admin";
import { fmtBytes, fmtDate, fmtInt, shortId } from "../../lib/format";
import { Card, DataTable, ErrorBox, Field, Loading, Mono, Notice, PageHeader, Pager } from "../components/ui";

const LIMIT = 100;
const MAX_WINDOW_MS = 31 * 86_400_000;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const HOST_RE = /^[A-Za-z0-9.:-]{1,253}$/;

/** <input type="datetime-local"> value (UTC) for a Date. */
function toLocalInput(d: Date): string {
  return d.toISOString().slice(0, 16);
}

export interface AbuseQuery { nodeId: string; requesterId: string; host: string; from: string; to: string }

export function validateAbuseQuery(q: AbuseQuery): string | null {
  if (q.nodeId && !UUID_RE.test(q.nodeId.trim())) return "Node id must be a UUID.";
  if (q.requesterId && !UUID_RE.test(q.requesterId.trim())) return "Requester id must be a UUID.";
  if (q.host && !HOST_RE.test(q.host.trim())) return "Host must be a hostname or IP.";
  const from = new Date(`${q.from}Z`).getTime();
  const to = new Date(`${q.to}Z`).getTime();
  if (Number.isNaN(from) || Number.isNaN(to)) return "From and To are required.";
  if (from >= to) return "From must be before To.";
  if (to - from > MAX_WINDOW_MS) return "The time window must be 31 days or less.";
  return null;
}

export default function AbuseLogPage() {
  const now = new Date();
  const [q, setQ] = useState<AbuseQuery>({
    nodeId: "", requesterId: "", host: "",
    from: toLocalInput(new Date(now.getTime() - 86_400_000)), to: toLocalInput(now),
  });
  const [err, setErr] = useState<string | null>(null);
  const [data, setData] = useState<AbuseLog | null>(null);
  const [loading, setLoading] = useState(false);
  const [offset, setOffset] = useState(0);

  async function run(nextOffset: number) {
    const v = validateAbuseQuery(q);
    if (v) { setErr(v); return; }
    setErr(null);
    setLoading(true);
    try {
      const r = await adminApi.abuseLog({
        nodeId: q.nodeId.trim(), requesterId: q.requesterId.trim(), host: q.host.trim(),
        from: new Date(`${q.from}Z`).toISOString(), to: new Date(`${q.to}Z`).toISOString(), limit: LIMIT, offset: nextOffset,
      });
      setData(r);
      setOffset(nextOffset);
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Search failed");
    } finally {
      setLoading(false);
    }
  }

  function submit(e: FormEvent) {
    e.preventDefault();
    void run(0);
  }

  const set = (k: keyof AbuseQuery) => (e: React.ChangeEvent<HTMLInputElement>) => setQ((s) => ({ ...s, [k]: e.target.value }));

  return (
    <div>
      <PageHeader title="Abuse log" subtitle="Connection metadata only (destination host, port, bytes). URLs and payloads are never stored." />
      <Notice tone="warn">Every search is recorded in the audit log. Narrow the window to what the investigation needs.</Notice>
      <Card className="mb-4">
        <form onSubmit={submit} className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-6 lg:items-end">
          <Field label="Node id" className="lg:col-span-2">{(id) => <input id={id} className="input font-mono" value={q.nodeId} onChange={set("nodeId")} maxLength={36} placeholder="UUID" />}</Field>
          <Field label="Requester id" className="lg:col-span-2">{(id) => <input id={id} className="input font-mono" value={q.requesterId} onChange={set("requesterId")} maxLength={36} placeholder="UUID" />}</Field>
          <Field label="Destination host" className="lg:col-span-2">{(id) => <input id={id} className="input" value={q.host} onChange={set("host")} maxLength={253} placeholder="example.com" />}</Field>
          <Field label="From (UTC)" className="lg:col-span-2">{(id) => <input id={id} type="datetime-local" className="input" value={q.from} onChange={set("from")} />}</Field>
          <Field label="To (UTC)" className="lg:col-span-2">{(id) => <input id={id} type="datetime-local" className="input" value={q.to} onChange={set("to")} />}</Field>
          <button type="submit" className="btn-primary lg:col-span-2" disabled={loading}>{loading ? "Searching…" : "Search"}</button>
        </form>
      </Card>
      <ErrorBox error={err} />
      {loading && !data && <Loading />}
      {data && (
        <Card title={`${fmtInt(data.total)} connections`} actions={<span className="text-xs text-slate-500">Retention {data.retentionDays} days</span>} bodyClassName="pt-0">
          <DataTable caption="Abuse log entries" rowKey={(r) => r.id} rows={data.items} empty="No connections in this window"
            columns={[
              { key: "ts", header: "Time", render: (r) => fmtDate(r.ts) },
              { key: "h", header: "Destination", render: (r) => `${r.destHost}:${r.destPort}` },
              { key: "b", header: "Bytes", align: "right", render: (r) => fmtBytes(r.bytes) },
              { key: "n", header: "Node", render: (r) => <Mono title={r.nodeId}>{shortId(r.nodeId)}</Mono> },
              { key: "r", header: "Requester", render: (r) => <Mono title={r.requesterUserId}>{shortId(r.requesterUserId)}</Mono> },
              { key: "s", header: "Session", render: (r) => <Mono title={r.sessionId}>{shortId(r.sessionId)}</Mono> },
            ]} />
          <Pager limit={LIMIT} offset={offset} total={data.total} onChange={(o) => void run(o)} />
        </Card>
      )}
    </div>
  );
}
