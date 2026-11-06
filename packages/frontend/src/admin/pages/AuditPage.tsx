import { useState } from "react";
import { useApi } from "../../hooks/useApi";
import { adminApi, AUDIT_ACTIONS } from "../../api/admin";
import { fmtDate, fmtInt, shortId } from "../../lib/format";
import { downloadCsv, toCsv } from "../../lib/csv";
import { Card, DataTable, ErrorBox, FilterBar, Loading, Mono, PageHeader, Pager, SelectFilter, TextFilter, useDebounced } from "../components/ui";
import { detailText } from "./NodesPage";

const LIMIT = 50;

export default function AuditPage() {
  const [action, setAction] = useState("");
  const [resourceId, setResourceId] = useState("");
  const [offset, setOffset] = useState(0);
  const rid = useDebounced(resourceId.trim());
  const list = useApi(() => adminApi.audit({ action, resourceId: rid, limit: LIMIT, offset }), [action, rid, offset]);
  const rows = list.data?.items ?? [];

  return (
    <div>
      <PageHeader title="Audit log" subtitle={list.data ? `${fmtInt(list.data.total)} admin actions` : undefined}
        actions={<button type="button" className="btn-secondary" disabled={rows.length === 0}
          onClick={() => downloadCsv("admin-audit.csv", toCsv(["created_at", "admin", "action", "resource", "resource_id", "ip", "details"],
            rows.map((r) => [r.createdAt, r.adminEmail ?? r.adminUserId, r.action, r.resource, r.resourceId, r.ipAddress, JSON.stringify(r.details)])))}>
          Export page CSV
        </button>} />
      <FilterBar>
        <SelectFilter label="Action" value={action} onChange={(v) => { setAction(v); setOffset(0); }} options={[...AUDIT_ACTIONS]} />
        <TextFilter label="Resource id" value={resourceId} onChange={(v) => { setResourceId(v); setOffset(0); }} maxLength={128} placeholder="node / user / payout id" />
      </FilterBar>
      <ErrorBox error={list.error} onRetry={list.refetch} />
      <Card bodyClassName="pt-0">
        {list.loading && !list.data ? <Loading /> : (
          <>
            <DataTable caption="Audit log" rowKey={(r) => r.id} rows={rows} empty="No admin actions"
              columns={[
                { key: "t", header: "When", render: (r) => fmtDate(r.createdAt) },
                { key: "a", header: "Admin", render: (r) => r.adminEmail ?? shortId(r.adminUserId) },
                { key: "ac", header: "Action", render: (r) => <Mono>{r.action}</Mono> },
                { key: "r", header: "Resource", render: (r) => <span title={r.resourceId ?? ""}>{r.resource} {r.resourceId ? <Mono>{shortId(r.resourceId, 12)}</Mono> : null}</span> },
                { key: "d", header: "Details", render: (r) => <span className="text-xs" title={detailText(r.details)}>{detailText(r.details)}</span>, className: "max-w-md truncate" },
                { key: "ip", header: "IP", render: (r) => r.ipAddress ?? "—" },
              ]} />
            {list.data && <Pager limit={LIMIT} offset={offset} total={list.data.total} onChange={setOffset} />}
          </>
        )}
      </Card>
    </div>
  );
}
