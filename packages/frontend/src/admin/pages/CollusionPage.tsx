import { useState } from "react";
import { useApi } from "../../hooks/useApi";
import { COLLUSION_KINDS, COLLUSION_STATUSES, collusionApi, type CollusionFlag, type CollusionSettings } from "../../api/admin";
import { fmtBps, fmtDate, fmtMoney, shortId } from "../../lib/format";
import {
  Badge, Card, ConfirmDialog, DataTable, DefList, ErrorBox, Field, FilterBar, Loading, Mono, Notice, PageHeader, Pager, SelectFilter,
} from "../components/ui";

const LIMIT = 50;
type Action = "dismiss" | "confirm";

function SettingsCard() {
  const s = useApi(() => collusionApi.settings(), []);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState<Record<string, string>>({});
  const [confirm, setConfirm] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const NUM = ["windowDays", "concentrationBps", "clusterSize", "clusterBps", "freezeBps"] as const;

  const start = (d: CollusionSettings) => {
    setDraft(Object.fromEntries(NUM.map((k) => [k, String(d[k])])));
    setEditing(true);
  };
  return (
    <Card title="Detection settings" actions={s.data && !editing ? <button type="button" className="btn-secondary !py-1 text-xs" onClick={() => start(s.data!)}>Edit</button> : null}>
      {msg && <Notice tone="good">{msg}</Notice>}
      <ErrorBox error={s.error} onRetry={s.refetch} />
      {s.loading && !s.data ? <Loading /> : s.data && (editing ? (
        <form className="grid gap-3 sm:grid-cols-3" onSubmit={(e) => { e.preventDefault(); setConfirm(true); }}>
          {NUM.map((k) => (
            <Field key={k} label={k}>{(id) => <input id={id} className="input" inputMode="numeric" value={draft[k] ?? ""} onChange={(e) => setDraft({ ...draft, [k]: e.target.value })} />}</Field>
          ))}
          <div className="flex gap-2 sm:col-span-3">
            <button type="submit" className="btn-primary">Save</button>
            <button type="button" className="btn-secondary" onClick={() => setEditing(false)}>Cancel</button>
          </div>
        </form>
      ) : (
        <DefList items={[
          ["Window", `${s.data.windowDays} days`],
          ["Min node volume", fmtMoney(s.data.minNodeVolume)],
          ["Concentration", fmtBps(s.data.concentrationBps)],
          ["Cluster", `≤${s.data.clusterSize} requesters ≥ ${fmtBps(s.data.clusterBps)}`],
          ["Circular min", fmtMoney(s.data.circularMin)],
          ["Auto-freeze", s.data.autoFreeze ? <Badge tone="warn">on</Badge> : <Badge tone="muted">off</Badge>],
          ["Freeze at", `${fmtBps(s.data.freezeBps)} and ${fmtMoney(s.data.freezeMinVolume)}`],
          ["Updated", fmtDate(s.data.updatedAt)],
        ]} />
      ))}
      <ConfirmDialog open={confirm} title="Update collusion thresholds" confirmLabel="Save"
        description="Thresholds are private to operators. The change is audited."
        onClose={() => setConfirm(false)}
        onConfirm={async () => {
          const body: Record<string, number> = {};
          for (const k of NUM) {
            const n = Number(draft[k]);
            if (!Number.isInteger(n)) throw new Error(`${k} must be an integer`);
            body[k] = n;
          }
          await collusionApi.updateSettings(body);
          setConfirm(false); setEditing(false); setMsg("Settings saved."); s.refetch();
        }} />
    </Card>
  );
}

export default function CollusionPage() {
  const [status, setStatus] = useState("open");
  const [kind, setKind] = useState("");
  const [offset, setOffset] = useState(0);
  const [target, setTarget] = useState<{ flag: CollusionFlag; action: Action } | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const list = useApi(() => collusionApi.flags({ status, kind, limit: LIMIT, offset }), [status, kind, offset]);

  return (
    <div className="space-y-5">
      <PageHeader title="Collusion flags" subtitle="Daily detection of concentrated, clustered or circular paid traffic. Freezing is done from Agents or Credits." />
      {msg && <Notice tone="good">{msg}</Notice>}
      <FilterBar>
        <SelectFilter label="Status" value={status} onChange={(v) => { setStatus(v); setOffset(0); }} options={[...COLLUSION_STATUSES]} />
        <SelectFilter label="Kind" value={kind} onChange={(v) => { setKind(v); setOffset(0); }} options={[...COLLUSION_KINDS]} />
      </FilterBar>
      <ErrorBox error={list.error} onRetry={list.refetch} />
      <Card bodyClassName="pt-0">
        {list.loading && !list.data ? <Loading /> : (
          <>
            <DataTable caption="Collusion flags" rowKey={(f) => f.id} rows={list.data?.items ?? []} empty="No flags"
              columns={[
                { key: "k", header: "Kind", render: (f) => <Badge tone="info">{f.kind}</Badge> },
                { key: "s", header: "Status", render: (f) => <Badge>{f.status}</Badge> },
                { key: "o", header: "Owner", render: (f) => <Mono title={f.ownerUserId}>{f.ownerEmail ?? shortId(f.ownerUserId)}</Mono> },
                { key: "n", header: "Node", render: (f) => <Mono title={f.nodeId ?? ""}>{shortId(f.nodeId)}</Mono> },
                { key: "r", header: "Requester", render: (f) => <Mono title={f.requesterUserId ?? ""}>{f.requesterEmail ?? shortId(f.requesterUserId)}</Mono> },
                { key: "sh", header: "Share", align: "right", render: (f) => fmtBps(f.shareBps) },
                { key: "v", header: "Volume", align: "right", render: (f) => `${fmtMoney(f.volume)} / ${fmtMoney(f.total)}` },
                { key: "fz", header: "Frozen", render: (f) => (f.ownerCreditsFrozen ? <Badge tone="bad">{f.autoFrozen ? "auto" : "frozen"}</Badge> : "—") },
                { key: "l", header: "Last seen", render: (f) => fmtDate(f.lastSeenAt) },
                { key: "x", header: <span className="sr-only">Actions</span>, render: (f) => f.status === "open" ? (
                  <div className="flex gap-1">
                    <button type="button" className="btn-secondary !py-1 text-xs" onClick={() => setTarget({ flag: f, action: "confirm" })}>Confirm</button>
                    <button type="button" className="btn-secondary !py-1 text-xs" onClick={() => setTarget({ flag: f, action: "dismiss" })}>Dismiss</button>
                  </div>
                ) : (f.resolutionNote ?? fmtDate(f.resolvedAt)) },
              ]} />
            {list.data && <Pager limit={LIMIT} offset={offset} total={list.data.total} onChange={setOffset} />}
          </>
        )}
      </Card>
      <SettingsCard />
      <ConfirmDialog open={target !== null} title={`${target?.action === "confirm" ? "Confirm" : "Dismiss"} flag ${shortId(target?.flag.id)}`}
        confirmLabel={target?.action === "confirm" ? "Confirm flag" : "Dismiss flag"} danger={target?.action === "confirm"} reason="optional"
        description={target?.action === "confirm" ? "Confirming records the finding; it does not freeze the owner." : "A flag dismissed within the window is not re-opened."}
        onClose={() => setTarget(null)}
        onConfirm={async (note) => {
          const r = await collusionApi.resolve(target!.flag.id, target!.action, note || undefined);
          setTarget(null); setMsg(`Flag ${shortId(r.id)} ${r.status}.`); list.refetch();
        }} />
    </div>
  );
}
