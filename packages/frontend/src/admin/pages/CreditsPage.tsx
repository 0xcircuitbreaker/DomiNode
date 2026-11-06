import { useState } from "react";
import { useApi } from "../../hooks/useApi";
import { adminApi, PAYOUT_STATUSES, type Payout } from "../../api/admin";
import { fmtDate, fmtInt, fmtMoney, shortId } from "../../lib/format";
import { Badge, Card, ConfirmDialog, DataTable, ErrorBox, FilterBar, Loading, Mono, Notice, PageHeader, Pager, SelectFilter } from "../components/ui";
import { FreezeControls } from "./AgentsPage";

const LIMIT = 25;
const REVERSIBLE = new Set(["pending", "held_tax", "held_frozen", "failed"]);

export default function CreditsPage() {
  const [frozen, setFrozen] = useState("");
  const [sort, setSort] = useState("available");
  const [accOffset, setAccOffset] = useState(0);
  const [status, setStatus] = useState("");
  const [payOffset, setPayOffset] = useState(0);
  const [reverse, setReverse] = useState<Payout | null>(null);
  const [msg, setMsg] = useState<string | null>(null);

  const acc = useApi(() => adminApi.creditAccounts({ frozen, sort, limit: LIMIT, offset: accOffset }), [frozen, sort, accOffset]);
  const pay = useApi(() => adminApi.payouts({ status, limit: LIMIT, offset: payOffset }), [status, payOffset]);

  return (
    <div>
      <PageHeader title="Credits & Payouts" />
      {msg && <Notice tone="good">{msg}</Notice>}

      <Card title="Node credit accounts" className="mb-4">
        <FilterBar>
          <SelectFilter label="Frozen" value={frozen} onChange={(v) => { setFrozen(v); setAccOffset(0); }}
            options={[{ value: "true", label: "Frozen only" }, { value: "false", label: "Not frozen" }]} />
          <SelectFilter label="Sort by" value={sort} allLabel={null} onChange={(v) => { setSort(v); setAccOffset(0); }}
            options={[{ value: "available", label: "Available" }, { value: "pending", label: "Pending" }, { value: "updated", label: "Last updated" }]} />
        </FilterBar>
        <ErrorBox error={acc.error} onRetry={acc.refetch} />
        {acc.loading && !acc.data ? <Loading /> : (
          <>
            <DataTable caption="Credit accounts" rowKey={(a) => a.userId} rows={acc.data?.items ?? []} empty="No accounts"
              columns={[
                { key: "who", header: "Account", render: (a) => <span title={a.userId}>{a.email ?? shortId(a.walletAddress ?? a.userId, 12)}</span> },
                { key: "f", header: "State", render: (a) => <Badge tone={a.frozen ? "bad" : "good"}>{a.frozen ? "frozen" : "active"}</Badge> },
                { key: "p", header: "Pending", align: "right", render: (a) => fmtMoney(a.pending) },
                { key: "av", header: "Available", align: "right", render: (a) => fmtMoney(a.available) },
                { key: "h", header: "Held payouts", align: "right", render: (a) => fmtMoney(a.heldPayouts) },
                { key: "y", header: "YTD paid", align: "right", render: (a) => fmtMoney(a.ytdPaid) },
                { key: "t", header: "Tax form", render: (a) => a.taxFormStatus.replace(/_/g, " ") },
                { key: "u", header: "Updated", render: (a) => fmtDate(a.updatedAt) },
                { key: "x", header: <span className="sr-only">Actions</span>, render: (a) => (
                  <FreezeControls userId={a.userId} frozen={a.frozen} onDone={(m) => { setMsg(m); acc.refetch(); pay.refetch(); }} />
                ) },
              ]} />
            {acc.data && <Pager limit={LIMIT} offset={accOffset} total={acc.data.total} onChange={setAccOffset} />}
          </>
        )}
      </Card>

      <Card title="Payouts" actions={pay.data && <span className="text-sm text-slate-500">Total {fmtMoney(pay.data.totalAmount)}</span>}>
        <FilterBar>
          <SelectFilter label="Status" value={status} onChange={(v) => { setStatus(v); setPayOffset(0); }} options={PAYOUT_STATUSES} />
        </FilterBar>
        <ErrorBox error={pay.error} onRetry={pay.refetch} />
        {pay.loading && !pay.data ? <Loading /> : (
          <>
            <DataTable caption="Payouts" rowKey={(p) => p.id} rows={pay.data?.items ?? []} empty="No payouts"
              columns={[
                { key: "id", header: "Payout", render: (p) => <Mono title={p.id}>{shortId(p.id)}</Mono> },
                { key: "who", header: "User", render: (p) => p.email ?? shortId(p.userId) },
                { key: "a", header: "Amount", align: "right", render: (p) => fmtMoney(p.amount) },
                { key: "s", header: "Status", render: (p) => <Badge>{p.status}</Badge> },
                { key: "tr", header: "Trigger", render: (p) => p.trigger.replace("_", "-") },
                { key: "w", header: "Wallet", render: (p) => p.payoutWallet ? <Mono title={p.payoutWallet.address}>{shortId(p.payoutWallet.address, 10)} · {p.payoutWallet.chain}</Mono> : "—" },
                { key: "tx", header: "Tx / failure", render: (p) => p.txHash ? <Mono title={p.txHash}>{shortId(p.txHash, 10)}</Mono> : (p.failureReason ?? "—"), className: "max-w-[14rem] truncate" },
                { key: "c", header: "Created", render: (p) => fmtDate(p.createdAt) },
                { key: "x", header: <span className="sr-only">Actions</span>, render: (p) => REVERSIBLE.has(p.status)
                  ? <button type="button" className="btn-secondary !py-1 text-xs" onClick={() => setReverse(p)}>Reverse</button> : null },
              ]} />
            {pay.data && <Pager limit={LIMIT} offset={payOffset} total={pay.data.total} onChange={setPayOffset} />}
          </>
        )}
      </Card>

      <ConfirmDialog open={reverse !== null} danger title="Reverse payout?" confirmLabel="Reverse payout" reason="required" reasonMax={200}
        description={reverse && <>The {fmtMoney(reverse.amount)} payout ({reverse.status.replace(/_/g, " ")}) is cancelled and re-credited to the user's available credits.</>}
        onClose={() => setReverse(null)}
        onConfirm={async (reason) => {
          const r = await adminApi.reversePayout(reverse!.id, reason);
          setReverse(null);
          setMsg(`Payout ${shortId(r.id)} reversed (${fmtMoney(r.amount)} re-credited).`);
          pay.refetch();
          acc.refetch();
        }} />
      <p className="mt-3 text-xs text-slate-500">{pay.data ? `${fmtInt(pay.data.total)} payouts match.` : ""}</p>
    </div>
  );
}
