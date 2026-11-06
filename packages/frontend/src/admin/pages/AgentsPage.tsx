import { useState } from "react";
import { useApi } from "../../hooks/useApi";
import { adminApi, type Agent } from "../../api/admin";
import { fmtAgo, fmtDate, fmtDay, fmtGb, fmtInt, fmtMoney, shortId } from "../../lib/format";
import {
  Badge, Card, ConfirmDialog, DataTable, DefList, Drawer, ErrorBox, FilterBar, Loading, Mono, Notice, PageHeader, Pager,
  SelectFilter, TextFilter, useDebounced, type Column,
} from "../components/ui";

const LIMIT = 50;

/** Freeze / unfreeze controls for a node credit account (shared with the Credits page). */
export function FreezeControls({ userId, frozen, onDone }: { userId: string; frozen: boolean; onDone: (msg: string) => void }) {
  const [dialog, setDialog] = useState<"freeze" | "unfreeze" | null>(null);
  const [mode, setMode] = useState<"release" | "reverse">("release");
  return (
    <>
      {frozen
        ? <button type="button" className="btn-primary" onClick={() => { setMode("release"); setDialog("unfreeze"); }}>Unfreeze</button>
        : <button type="button" className="btn-danger" onClick={() => setDialog("freeze")}>Freeze credits</button>}
      <ConfirmDialog open={dialog === "freeze"} danger title="Freeze credit account?" confirmLabel="Freeze" reason="required"
        description="Maturity stops moving credits to available and pending payouts become held_frozen."
        onClose={() => setDialog(null)}
        onConfirm={async (reason) => {
          const r = await adminApi.freeze(userId, reason);
          setDialog(null);
          onDone(r.wasFrozen ? "Account was already frozen." : `Account frozen; ${r.heldPayouts} payout(s) held.`);
        }} />
      <ConfirmDialog open={dialog === "unfreeze"} title="Unfreeze credit account?" confirmLabel="Unfreeze"
        description="Choose what happens to payouts held while frozen."
        onClose={() => setDialog(null)}
        onConfirm={async () => {
          const r = await adminApi.unfreeze(userId, mode);
          setDialog(null);
          onDone(`Account unfrozen; ${r.payouts} held payout(s) ${mode === "release" ? "released to pending" : "reversed and re-credited"}.`);
        }}>
        <fieldset className="mt-3 space-y-2 text-sm">
          <legend className="sr-only">Held payouts</legend>
          <label className="flex items-start gap-2">
            <input type="radio" name="unfreeze-mode" checked={mode === "release"} onChange={() => setMode("release")} className="mt-1" />
            <span><strong>Release</strong> — held payouts return to pending and are paid normally.</span>
          </label>
          <label className="flex items-start gap-2">
            <input type="radio" name="unfreeze-mode" checked={mode === "reverse"} onChange={() => setMode("reverse")} className="mt-1" />
            <span><strong>Reverse</strong> — held payouts are cancelled and re-credited to available.</span>
          </label>
        </fieldset>
      </ConfirmDialog>
    </>
  );
}

function AgentDetailView({ id, onChanged }: { id: string; onChanged: () => void }) {
  const d = useApi(() => adminApi.agent(id), [id]);
  const [msg, setMsg] = useState<string | null>(null);
  if (d.loading && !d.data) return <Loading />;
  if (!d.data) return <ErrorBox error={d.error ?? "Failed to load"} onRetry={d.refetch} />;
  const { agent: a, creditAccount: ca, nodes, recentPayouts, recentCreditTransactions, spendByRail30d } = d.data;
  return (
    <div className="space-y-4">
      {msg && <Notice tone="good">{msg}</Notice>}
      <div className="flex flex-wrap items-center gap-2">
        <Badge>{a.status}</Badge>
        {a.isRequester && <Badge tone="info">requester</Badge>}
        {a.isNodeOwner && <Badge tone="info">node owner</Badge>}
        {a.credits.frozen && <Badge tone="bad">frozen</Badge>}
        <div className="ml-auto">
          <FreezeControls userId={a.userId} frozen={a.credits.frozen} onDone={(m) => { setMsg(m); d.refetch(); onChanged(); }} />
        </div>
      </div>
      <Card title="Agent">
        <DefList items={[
          ["User id", <Mono key="u">{a.userId}</Mono>],
          ["Email", a.email ?? "—"],
          ["Wallet", <Mono key="w">{a.walletAddress ?? "—"}</Mono>],
          ["Tier", a.tier ?? "—"],
          ["Spend (all / 30d)", `${fmtMoney(a.spend)} / ${fmtMoney(a.spend30d)}`],
          ["Traffic requested", fmtGb(a.gbRequested)],
          ["Last request", fmtAgo(a.lastRequestAt)],
          ["Earnings (all / 30d)", `${fmtMoney(a.earnings)} / ${fmtMoney(a.earnings30d)}`],
          ["Nodes (active / online)", `${a.nodes} (${a.activeNodes} / ${a.onlineNodes})`],
          ["Credits pending", fmtMoney(a.credits.pending)],
          ["Credits available", fmtMoney(a.credits.available)],
          ["USD wallet", fmtMoney(a.walletBalance)],
          ["Tax form", ca ? `${ca.taxFormStatus}${ca.taxFormType ? ` (${ca.taxFormType})` : ""}` : "—"],
          ["YTD paid", ca ? fmtMoney(ca.ytdPaid) : "—"],
          ["Auto-convert", ca ? `${ca.autoConvertPct}%` : "—"],
          ["Created", fmtDate(a.createdAt)],
        ]} />
      </Card>
      <Card title="Spend by rail (30d)" bodyClassName="pt-0">
        <DataTable caption="Spend by rail" rowKey={(r) => r.rail} rows={spendByRail30d} empty="No spend"
          columns={[
            { key: "r", header: "Rail", render: (r) => r.rail },
            { key: "g", header: "Gross", align: "right", render: (r) => fmtMoney(r.gross) },
            { key: "gb", header: "Traffic", align: "right", render: (r) => fmtGb(r.gb) },
            { key: "c", header: "Charges", align: "right", render: (r) => fmtInt(r.charges) },
          ]} />
      </Card>
      <Card title={`Nodes (${nodes.length})`} bodyClassName="pt-0">
        <DataTable caption="Agent nodes" rowKey={(n) => n.id} rows={nodes} empty="No nodes"
          columns={[
            { key: "id", header: "Node", render: (n) => <Mono title={n.id}>{shortId(n.id)}</Mono> },
            { key: "s", header: "Status", render: (n) => <Badge>{n.status}</Badge> },
            { key: "o", header: "Online", render: (n) => (n.online ? "yes" : "no") },
            { key: "c", header: "Country", render: (n) => n.country ?? "—" },
            { key: "seen", header: "Last seen", render: (n) => fmtAgo(n.lastSeenAt) },
          ]} />
      </Card>
      <Card title="Recent payouts" bodyClassName="pt-0">
        <DataTable caption="Recent payouts" rowKey={(p) => p.id} rows={recentPayouts} empty="No payouts"
          columns={[
            { key: "a", header: "Amount", align: "right", render: (p) => fmtMoney(p.amount) },
            { key: "s", header: "Status", render: (p) => <Badge>{p.status}</Badge> },
            { key: "t", header: "Trigger", render: (p) => p.trigger },
            { key: "c", header: "Created", render: (p) => fmtDate(p.createdAt) },
          ]} />
      </Card>
      <Card title="Recent credit transactions" bodyClassName="pt-0">
        <DataTable caption="Credit transactions" rowKey={(t) => t.id} rows={recentCreditTransactions} empty="No transactions"
          columns={[
            { key: "t", header: "Type", render: (t) => t.type },
            { key: "a", header: "Amount", align: "right", render: (t) => fmtMoney(t.amount) },
            { key: "c", header: "When", render: (t) => fmtDate(t.createdAt) },
          ]} />
      </Card>
    </div>
  );
}

export default function AgentsPage() {
  const [role, setRole] = useState("");
  const [frozen, setFrozen] = useState("");
  const [status, setStatus] = useState("");
  const [search, setSearch] = useState("");
  const [sort, setSort] = useState<{ key: string; order: "asc" | "desc" }>({ key: "spend", order: "desc" });
  const [offset, setOffset] = useState(0);
  const [selected, setSelected] = useState<string | null>(null);
  const dSearch = useDebounced(search);
  const list = useApi(() => adminApi.agents({ role, frozen, status, search: dSearch.trim(), sort: sort.key, order: sort.order, limit: LIMIT, offset }),
    [role, frozen, status, dSearch, sort.key, sort.order, offset]);
  const reset = (fn: (v: string) => void) => (v: string) => { fn(v); setOffset(0); };

  const columns: Column<Agent>[] = [
    { key: "who", header: "Agent", render: (a) => <span title={a.userId}>{a.email ?? (a.walletAddress ? shortId(a.walletAddress, 12) : shortId(a.userId))}</span> },
    { key: "role", header: "Role", render: (a) => [a.isRequester && "requester", a.isNodeOwner && "node owner"].filter(Boolean).join(", ") || "—" },
    { key: "st", header: "Status", render: (a) => <span className="inline-flex gap-1"><Badge>{a.status}</Badge>{a.credits.frozen && <Badge tone="bad">frozen</Badge>}</span> },
    { key: "tier", header: "Tier", render: (a) => a.tier ?? "—" },
    { key: "spend", header: "Spend", align: "right", sortKey: "spend", render: (a) => fmtMoney(a.spend) },
    { key: "spend30", header: "Spend 30d", align: "right", sortKey: "spend_30d", render: (a) => fmtMoney(a.spend30d) },
    { key: "earn", header: "Earnings", align: "right", sortKey: "earnings", render: (a) => fmtMoney(a.earnings) },
    { key: "nodes", header: "Nodes", align: "right", sortKey: "nodes", render: (a) => `${a.onlineNodes}/${a.nodes}` },
    { key: "avail", header: "Credits avail.", align: "right", render: (a) => fmtMoney(a.credits.available) },
    { key: "last", header: "Last request", sortKey: "last_request", render: (a) => fmtAgo(a.lastRequestAt) },
    { key: "created", header: "Joined", sortKey: "created", render: (a) => fmtDay(a.createdAt) },
  ];

  return (
    <div>
      <PageHeader title="Agents" subtitle={list.data ? `${fmtInt(list.data.total)} agents (requesters, node owners, credit holders)` : undefined} />
      <FilterBar>
        <TextFilter label="Search" value={search} onChange={reset(setSearch)} placeholder="email, wallet, id" />
        <SelectFilter label="Role" value={role} onChange={reset(setRole)} options={[{ value: "requester", label: "Requester" }, { value: "node_owner", label: "Node owner" }]} />
        <SelectFilter label="Credits" value={frozen} onChange={reset(setFrozen)} options={[{ value: "true", label: "Frozen" }, { value: "false", label: "Not frozen" }]} />
        <SelectFilter label="User status" value={status} onChange={reset(setStatus)} options={["active", "suspended", "deleted"]} />
      </FilterBar>
      <ErrorBox error={list.error} onRetry={list.refetch} />
      <Card bodyClassName="pt-0">
        {list.loading && !list.data ? <Loading /> : (
          <>
            <DataTable caption="Agents" columns={columns} rows={list.data?.items ?? []} rowKey={(a) => a.userId}
              onRowClick={(a) => setSelected(a.userId)} sort={sort}
              onSort={(k) => { setSort((s) => ({ key: k, order: s.key === k && s.order === "desc" ? "asc" : "desc" })); setOffset(0); }} />
            {list.data && <Pager limit={LIMIT} offset={offset} total={list.data.total} onChange={setOffset} />}
          </>
        )}
      </Card>
      <Drawer open={selected !== null} onClose={() => setSelected(null)} title={selected ? `Agent ${shortId(selected)}` : ""}>
        {selected && <AgentDetailView id={selected} onChanged={list.refetch} />}
      </Drawer>
    </div>
  );
}
