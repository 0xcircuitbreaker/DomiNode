import { useState } from "react";
import { useApi } from "../../hooks/useApi";
import { adminApi, DISPUTE_STATUSES, type Dispute, type DisputeStatus } from "../../api/admin";
import { fmtBps, fmtBytes, fmtDate, fmtMoney, shortId } from "../../lib/format";
import { Badge, Card, ConfirmDialog, DataTable, ErrorBox, FilterBar, Loading, Mono, Notice, PageHeader, Pager, SelectFilter } from "../components/ui";

const LIMIT = 50;
type Resolution = Exclude<DisputeStatus, "open">;
const RESOLUTIONS: Array<{ value: Resolution; label: string; help: string }> = [
  { value: "resolved_gateway", label: "Gateway count is right", help: "Clears the charge's disputed flag so the node share can mature." },
  { value: "resolved_node", label: "Node count is right", help: "Re-splits the charge at the node's byte count: claws back the extra node share, refunds the requester, then releases it." },
  { value: "dismissed", label: "Dismiss", help: "Clears the disputed flag; no adjustment." },
];

export default function DisputesPage() {
  const [status, setStatus] = useState<string>("open");
  const [offset, setOffset] = useState(0);
  const [target, setTarget] = useState<Dispute | null>(null);
  const [resolution, setResolution] = useState<Resolution>("resolved_gateway");
  const [msg, setMsg] = useState<string | null>(null);
  const list = useApi(() => adminApi.disputes({ status, limit: LIMIT, offset }), [status, offset]);

  return (
    <div>
      <PageHeader title="Byte disputes" subtitle="Disagreements between gateway and node byte counts on a relay charge." />
      {msg && <Notice tone="good">{msg}</Notice>}
      <FilterBar>
        <SelectFilter label="Status" value={status} onChange={(v) => { setStatus(v); setOffset(0); }} options={DISPUTE_STATUSES} />
      </FilterBar>
      <ErrorBox error={list.error} onRetry={list.refetch} />
      <Card bodyClassName="pt-0">
        {list.loading && !list.data ? <Loading /> : (
          <>
            <DataTable caption="Disputes" rowKey={(d) => d.id} rows={list.data?.items ?? []} empty="No disputes"
              columns={[
                { key: "id", header: "Id", render: (d) => d.id },
                { key: "s", header: "Status", render: (d) => <Badge>{d.status}</Badge> },
                { key: "n", header: "Node", render: (d) => <Mono title={d.nodeId ?? ""}>{shortId(d.nodeId)}</Mono> },
                { key: "r", header: "Rail", render: (d) => d.paymentRail ?? "—" },
                { key: "g", header: "Gateway", align: "right", render: (d) => fmtBytes(d.bytesGateway) },
                { key: "nb", header: "Node", align: "right", render: (d) => fmtBytes(d.bytesNode) },
                { key: "diff", header: "Diff", align: "right", render: (d) => `${fmtBytes(d.bytesDiff)} (${fmtBps(d.diffBps, 1)})` },
                { key: "gr", header: "Gross", align: "right", render: (d) => fmtMoney(d.gross) },
                { key: "ns", header: "Node share", align: "right", render: (d) => fmtMoney(d.nodeShare) },
                { key: "c", header: "Created", render: (d) => fmtDate(d.createdAt) },
                { key: "x", header: <span className="sr-only">Actions</span>, render: (d) => d.status === "open"
                  ? <button type="button" className="btn-secondary !py-1 text-xs" onClick={() => { setResolution("resolved_gateway"); setTarget(d); }}>Resolve</button>
                  : fmtDate(d.resolvedAt) },
              ]} />
            {list.data && <Pager limit={LIMIT} offset={offset} total={list.data.total} onChange={setOffset} />}
          </>
        )}
      </Card>
      <ConfirmDialog open={target !== null} title={`Resolve dispute ${target?.id ?? ""}`} confirmLabel="Resolve" reason="optional"
        onClose={() => setTarget(null)}
        onConfirm={async (reason) => {
          const r = await adminApi.resolveDispute(target!.id, resolution, reason || undefined);
          setTarget(null);
          setMsg(`Dispute ${r.id} ${r.status.replace(/_/g, " ")}${r.chargeReleased ? "; charge released" : ""}.`);
          list.refetch();
        }}>
        <fieldset className="mt-3 space-y-2 text-sm">
          <legend className="text-xs font-medium text-slate-600 dark:text-slate-400">Resolution</legend>
          {RESOLUTIONS.map((o) => (
            <label key={o.value} className="flex items-start gap-2">
              <input type="radio" name="resolution" value={o.value} checked={resolution === o.value} onChange={() => setResolution(o.value)} className="mt-1" />
              <span><strong>{o.label}</strong> <span className="text-slate-500">— {o.help}</span></span>
            </label>
          ))}
        </fieldset>
      </ConfirmDialog>
    </div>
  );
}
