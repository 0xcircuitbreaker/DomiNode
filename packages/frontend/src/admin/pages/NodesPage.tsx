import { useState } from "react";
import { useSearchParams } from "react-router-dom";
import { useApi } from "../../hooks/useApi";
import { adminApi, IP_CLASSES, NODE_STATUSES, type NodeRow, type NodeStatus } from "../../api/admin";
import { fmtAgo, fmtBps, fmtBytes, fmtDate, fmtDay, fmtGb, fmtInt, fmtMoney, fmtMusd, shortId } from "../../lib/format";
import {
  Badge, Card, ConfirmDialog, DataTable, DefList, Drawer, ErrorBox, FilterBar, Loading, Mono, Notice, PageHeader, Pager,
  SelectFilter, TextFilter, useDebounced, type Column,
} from "../components/ui";

const LIMIT = 50;
type NodeAction = "quarantine" | "activate" | "revoke";
const ACTION_FROM: Record<NodeAction, NodeStatus[]> = {
  quarantine: ["pending", "active", "cooldown", "suspended"],
  activate: ["pending", "cooldown", "quarantined", "suspended"],
  revoke: ["pending", "active", "cooldown", "quarantined", "suspended"],
};

export function NodeDetailView({ id, onChanged }: { id: string; onChanged?: () => void }) {
  const d = useApi(() => adminApi.node(id), [id]);
  const [action, setAction] = useState<NodeAction | null>(null);
  const [done, setDone] = useState<string | null>(null);

  if (d.loading && !d.data) return <Loading />;
  if (!d.data) return <ErrorBox error={d.error ?? "Failed to load"} onRetry={d.refetch} />;
  const { node, dailyStats, reputationByTarget, disputes, chargesByRail30d, adminActions, chargesDaily } = d.data;
  const earned30 = chargesDaily.reduce((s, c) => s + Number(c.node.musd), 0);

  return (
    <div className="space-y-4">
      {done && <Notice tone="good">{done}</Notice>}
      <div className="flex flex-wrap items-center gap-2">
        <Badge>{node.status}</Badge>
        <Badge tone={node.online ? "good" : "muted"}>{node.online ? "online" : "offline"}</Badge>
        <div className="ml-auto flex flex-wrap gap-2">
          {(["activate", "quarantine", "revoke"] as const).map((a) => (
            <button key={a} type="button" disabled={!ACTION_FROM[a].includes(node.status)}
              className={a === "activate" ? "btn-primary" : a === "revoke" ? "btn-danger" : "btn-secondary"}
              onClick={() => setAction(a)}>
              {a[0].toUpperCase() + a.slice(1)}
            </button>
          ))}
        </div>
      </div>
      <Card title="Node">
        <DefList items={[
          ["Node id", <Mono key="i" title={node.id}>{node.id}</Mono>],
          ["Owner", <span key="o" title={node.ownerUserId}>{node.ownerEmail ?? shortId(node.ownerUserId)}</span>],
          ["Owner status / tier", `${node.ownerStatus ?? "—"} / ${node.ownerTier ?? "—"}`],
          ["Owner wallet", <Mono key="w">{node.ownerWallet}</Mono>],
          ["Observed IP", node.observedIp ?? "—"],
          ["Prefix", node.ipPrefix ?? "—"],
          ["ASN / country", `${node.asn !== null ? `AS${node.asn}` : "—"} / ${node.country ?? "—"}`],
          ["IP class (verified)", node.verifiedClass ?? node.ipClass ?? "unknown"],
          ["Declared class", node.declaredClass ?? "—"],
          ["Egress mismatch flags", String(node.openEgressMismatchFlags ?? 0)],
          ["Reputation", fmtBps(node.reputation)],
          ["Byte disputes", fmtInt(node.byteDisputes)],
          ["Caps", `${node.maxStreams} streams · ${node.maxGbDay} GB/day`],
          ["Agent / attestation", `${node.agentVersion ?? "—"} / v${node.attestationVersion}`],
          ["Last seen", `${fmtDate(node.lastSeenAt)} (${fmtAgo(node.lastSeenAt)})`],
          ["Created", fmtDate(node.createdAt)],
          ["Node earnings 30d", fmtMusd(earned30)],
        ]} />
      </Card>
      <Card title="Daily stats (newest first)" bodyClassName="pt-0">
        <DataTable caption="Daily stats" rowKey={(s) => s.day} rows={dailyStats.slice(0, 30)} empty="No stats"
          columns={[
            { key: "d", header: "Day", render: (s) => fmtDay(s.day) },
            { key: "gb", header: "Traffic", align: "right", render: (s) => fmtGb(s.gb) },
            { key: "s", header: "Streams", align: "right", render: (s) => fmtInt(s.streams) },
            { key: "f", header: "Failures", align: "right", render: (s) => fmtInt(s.failures) },
            { key: "b", header: "Burns", align: "right", render: (s) => fmtInt(s.burns) },
          ]} />
      </Card>
      <Card title="Charges by rail (30d)" bodyClassName="pt-0">
        <DataTable caption="Charges by rail" rowKey={(r) => r.rail} rows={chargesByRail30d} empty="No charges"
          columns={[
            { key: "r", header: "Rail", render: (r) => r.rail },
            { key: "g", header: "Gross", align: "right", render: (r) => fmtMoney(r.gross) },
            { key: "n", header: "Node", align: "right", render: (r) => fmtMoney(r.node) },
            { key: "gb", header: "Traffic", align: "right", render: (r) => fmtGb(r.gb) },
            { key: "c", header: "Charges", align: "right", render: (r) => fmtInt(r.charges) },
            { key: "d", header: "Disputed", align: "right", render: (r) => fmtInt(r.disputed) },
            { key: "z", header: "Zero share", align: "right", render: (r) => fmtInt(r.zeroShare) },
          ]} />
      </Card>
      <Card title="Reputation by target (top 50 by burns)" bodyClassName="pt-0">
        <DataTable caption="Reputation by target" rowKey={(r) => r.target} rows={reputationByTarget} empty="No targets"
          columns={[
            { key: "t", header: "Target", render: (r) => r.target },
            { key: "o", header: "OK", align: "right", render: (r) => fmtInt(r.okCount) },
            { key: "b", header: "Burns", align: "right", render: (r) => fmtInt(r.burnCount) },
            { key: "c", header: "Cooldown until", render: (r) => fmtDate(r.cooldownUntil) },
          ]} />
      </Card>
      <Card title="Disputes" bodyClassName="pt-0">
        <DataTable caption="Node disputes" rowKey={(r) => r.id} rows={disputes} empty="No disputes"
          columns={[
            { key: "id", header: "Id", render: (r) => r.id },
            { key: "s", header: "Status", render: (r) => <Badge>{r.status}</Badge> },
            { key: "g", header: "Gateway bytes", align: "right", render: (r) => fmtBytes(r.bytesGateway) },
            { key: "n", header: "Node bytes", align: "right", render: (r) => fmtBytes(r.bytesNode) },
            { key: "c", header: "Created", render: (r) => fmtDate(r.createdAt) },
          ]} />
      </Card>
      <Card title="Admin actions" bodyClassName="pt-0">
        <DataTable caption="Admin actions" rowKey={(r) => r.id} rows={adminActions} empty="No admin actions"
          columns={[
            { key: "a", header: "Action", render: (r) => r.action },
            { key: "d", header: "Details", render: (r) => <span className="text-xs">{detailText(r.details)}</span>, className: "max-w-xs truncate" },
            { key: "t", header: "When", render: (r) => fmtDate(r.createdAt) },
          ]} />
      </Card>

      <ConfirmDialog open={action !== null} danger={action !== "activate"}
        title={action ? `${action[0].toUpperCase()}${action.slice(1)} node?` : ""}
        confirmLabel={action ? action[0].toUpperCase() + action.slice(1) : ""}
        reason={action === "activate" ? "optional" : "required"}
        description={action === "revoke"
          ? "Revocation is terminal. The gateway closes the node's tunnel within the next status sync (~30 s)."
          : action === "quarantine"
            ? "The node stays connected but receives no traffic after the next status sync (~30 s)."
            : "The node becomes routable after the next status sync (~30 s). The owner must be active."}
        onClose={() => setAction(null)}
        onConfirm={async (reason) => {
          const r = await adminApi.nodeAction(node.id, action!, reason || undefined);
          setAction(null);
          setDone(r.changed ? `Node ${r.previousStatus} → ${r.status}. Gateways apply this within the sync interval.` : `Node was already ${r.status}.`);
          d.refetch();
          onChanged?.();
        }} />
    </div>
  );
}

export function detailText(d: Record<string, unknown> | null | undefined): string {
  if (!d) return "";
  return Object.entries(d).map(([k, v]) => `${k}: ${typeof v === "object" ? JSON.stringify(v) : String(v)}`).join(" · ").slice(0, 300);
}

export default function NodesPage() {
  const [params] = useSearchParams();
  const [status, setStatus] = useState(params.get("status") ?? "");
  const [ipClass, setIpClass] = useState("");
  const [country, setCountry] = useState("");
  const [asn, setAsn] = useState("");
  const [online, setOnline] = useState("");
  const [search, setSearch] = useState("");
  const [sort, setSort] = useState<{ key: string; order: "asc" | "desc" }>({ key: "created", order: "desc" });
  const [offset, setOffset] = useState(0);
  const [selected, setSelected] = useState<string | null>(null);
  const q = useDebounced({ search, country, asn });

  const validCountry = /^[A-Za-z]{2}$/.test(q.country) ? q.country : "";
  const validAsn = /^\d{1,10}$/.test(q.asn) ? q.asn : "";
  const list = useApi(() => adminApi.nodes({
    status, ip_class: ipClass, online, country: validCountry, asn: validAsn, search: q.search.trim(),
    sort: sort.key, order: sort.order, limit: LIMIT, offset,
  }), [status, ipClass, online, validCountry, validAsn, q.search, sort.key, sort.order, offset]);

  const reset = <T,>(fn: (v: T) => void) => (v: T) => { fn(v); setOffset(0); };
  const columns: Column<NodeRow>[] = [
    { key: "id", header: "Node", render: (n) => <Mono title={n.id}>{shortId(n.id)}</Mono> },
    { key: "st", header: "Status", render: (n) => <Badge>{n.status}</Badge> },
    { key: "on", header: "Online", render: (n) => <Badge tone={n.online ? "good" : "muted"}>{n.online ? "online" : "offline"}</Badge> },
    { key: "owner", header: "Owner", render: (n) => <span title={n.ownerUserId}>{n.ownerEmail ?? shortId(n.ownerWallet, 10)}</span> },
    { key: "loc", header: "Country / ASN", render: (n) => `${n.country ?? "—"} / ${n.asn !== null ? `AS${n.asn}` : "—"}` },
    { key: "cls", header: "Class", render: (n) => n.ipClass ?? "unknown" },
    { key: "rep", header: "Reputation", align: "right", sortKey: "reputation", render: (n) => fmtBps(n.reputation, 1) },
    { key: "today", header: "Today", align: "right", render: (n) => fmtGb(n.gbToday) },
    { key: "30d", header: "30d", align: "right", sortKey: "bytes", render: (n) => fmtGb(n.gb30d) },
    { key: "disp", header: "Disputes", align: "right", render: (n) => (n.openDisputes > 0 ? <Badge tone="warn">{String(n.openDisputes)}</Badge> : "0") },
    { key: "seen", header: "Last seen", sortKey: "last_seen", render: (n) => fmtAgo(n.lastSeenAt) },
    { key: "created", header: "Created", sortKey: "created", render: (n) => fmtDay(n.createdAt) },
  ];

  return (
    <div>
      <PageHeader title="Nodes" subtitle={list.data ? `${fmtInt(list.data.total)} matching nodes` : undefined} />
      <FilterBar>
        <TextFilter label="Search" value={search} onChange={reset(setSearch)} placeholder="id, wallet, IP, version" />
        <SelectFilter label="Status" value={status} onChange={reset(setStatus)} options={NODE_STATUSES} />
        <SelectFilter label="Online" value={online} onChange={reset(setOnline)} options={[{ value: "true", label: "Online" }, { value: "false", label: "Offline" }]} />
        <SelectFilter label="IP class" value={ipClass} onChange={reset(setIpClass)} options={IP_CLASSES} />
        <TextFilter label="Country" value={country} onChange={reset(setCountry)} placeholder="US" maxLength={2} />
        <TextFilter label="ASN" value={asn} onChange={reset(setAsn)} placeholder="7922" maxLength={10} />
      </FilterBar>
      <ErrorBox error={list.error} onRetry={list.refetch} />
      <Card bodyClassName="pt-0">
        {list.loading && !list.data ? <Loading /> : (
          <>
            <DataTable caption="Nodes" columns={columns} rows={list.data?.items ?? []} rowKey={(n) => n.id}
              onRowClick={(n) => setSelected(n.id)} sort={sort}
              onSort={(k) => { setSort((s) => ({ key: k, order: s.key === k && s.order === "desc" ? "asc" : "desc" })); setOffset(0); }} />
            {list.data && <Pager limit={LIMIT} offset={offset} total={list.data.total} onChange={setOffset} />}
          </>
        )}
      </Card>
      <Drawer open={selected !== null} onClose={() => setSelected(null)} title={selected ? `Node ${shortId(selected)}` : ""}>
        {selected && <NodeDetailView id={selected} onChanged={list.refetch} />}
      </Drawer>
    </div>
  );
}
