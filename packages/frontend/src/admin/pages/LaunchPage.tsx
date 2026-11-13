import { useState } from "react";
import { useApi } from "../../hooks/useApi";
import { launchApi, type AbuseReport, type Announcement, type GenesisSettings, type Incident, type StarterSettings } from "../../api/admin";
import { fmtBps, fmtBytes, fmtDate, fmtMoney, shortId } from "../../lib/format";
import { Badge, Card, ConfirmDialog, DataTable, ErrorBox, Field, Kpi, Loading, Mono, Notice, PageHeader, SelectFilter } from "../components/ui";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const errText = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** "0.50" → "500000" (µUSD digit string) or null. */
export function usdToMusdString(s: string): string | null {
  const t = s.trim().replace(/^\$/, "");
  if (!/^\d{1,9}(\.\d{1,6})?$/.test(t)) return null;
  const [w, f = ""] = t.split(".");
  return (BigInt(w) * 1_000_000n + BigInt(f.padEnd(6, "0"))).toString();
}

function SeedCard({ onMsg }: { onMsg: (m: string) => void }) {
  const s = useApi(() => launchApi.seedSummary());
  const [nodeId, setNodeId] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const toggle = async (operatorRun: boolean) => {
    if (!UUID.test(nodeId.trim())) { setErr("Enter a node id (UUID)"); return; }
    try {
      setErr(null);
      const r = await launchApi.setOperatorRun(nodeId.trim(), operatorRun);
      onMsg(`Node ${shortId(r.nodeId)} ${r.operatorRun ? "flagged as operator-run seed" : "marked as community"}; effective on its next tunnel reconnect.`);
      s.refetch();
    } catch (e) { setErr(errText(e)); }
  };
  return (
    <Card title="Seed vs community nodes">
      <ErrorBox error={s.error ?? err} />
      {s.loading && !s.data ? <Loading /> : s.data && (
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          <Kpi label="Seed online" value={`${s.data.seed.online} / ${s.data.seed.total}`} sub={`${s.data.seed.countries} countries · ${s.data.seed.asns} ASNs`} />
          <Kpi label="Community online" value={`${s.data.community.online} / ${s.data.community.total}`} sub={`${s.data.community.countries} countries · ${s.data.community.asns} ASNs`} />
          <Kpi label="Seed paid 24h" value={fmtBytes(s.data.seed.paidBytes24h)} sub={fmtMoney(s.data.seed.paid24h)} />
          <Kpi label="Community paid 24h" value={fmtBytes(s.data.community.paidBytes24h)} sub={fmtMoney(s.data.community.paid24h)} />
        </div>
      )}
      <div className="mt-4 flex flex-wrap items-end gap-2">
        <Field label="Node id" className="w-80">
          {(id) => <input id={id} className="input font-mono" value={nodeId} onChange={(e) => setNodeId(e.target.value)} placeholder="uuid" />}
        </Field>
        <button type="button" className="btn-primary" onClick={() => void toggle(true)}>Flag operator-run</button>
        <button type="button" className="btn-secondary" onClick={() => void toggle(false)}>Mark community</button>
      </div>
    </Card>
  );
}

type FieldDef = { key: string; label: string; kind: "bool" | "int" | "usd" | "digits" };

/** A small settings form: shows current values, sends only changed fields. */
function SettingsForm({ fields, current, onSave }: {
  fields: FieldDef[]; current: Record<string, string | boolean>; onSave: (patch: Record<string, unknown>) => Promise<void>;
}) {
  const [vals, setVals] = useState<Record<string, string | boolean>>({});
  const [err, setErr] = useState<string | null>(null);
  const v = (k: string) => (k in vals ? vals[k] : current[k]);
  return (
    <form className="space-y-3" onSubmit={async (e) => {
      e.preventDefault();
      const patch: Record<string, unknown> = {};
      for (const f of fields) {
        if (!(f.key in vals) || vals[f.key] === current[f.key]) continue;
        const raw = vals[f.key];
        if (f.kind === "bool") patch[f.key] = raw === true;
        else if (f.kind === "int") {
          if (!/^\d+$/.test(String(raw))) { setErr(`${f.label}: whole number required`); return; }
          patch[f.key] = Number(raw);
        } else if (f.kind === "usd") {
          const m = usdToMusdString(String(raw));
          if (m === null) { setErr(`${f.label}: invalid USD amount`); return; }
          patch[f.key.replace(/Usd$/, "Musd")] = m;
        } else {
          if (!/^\d{1,18}$/.test(String(raw))) { setErr(`${f.label}: digits only`); return; }
          patch[f.key] = String(raw);
        }
      }
      if (Object.keys(patch).length === 0) { setErr("Nothing changed"); return; }
      try { setErr(null); await onSave(patch); setVals({}); } catch (x) { setErr(errText(x)); }
    }}>
      <ErrorBox error={err} />
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
        {fields.map((f) => f.kind === "bool" ? (
          <label key={f.key} className="flex items-center gap-2 self-end py-1.5 text-sm">
            <input type="checkbox" checked={v(f.key) === true} onChange={(e) => setVals((o) => ({ ...o, [f.key]: e.target.checked }))} />
            {f.label}
          </label>
        ) : (
          <Field key={f.key} label={f.label}>
            {(id) => <input id={id} className="input" inputMode="decimal" value={String(v(f.key) ?? "")} onChange={(e) => setVals((o) => ({ ...o, [f.key]: e.target.value }))} />}
          </Field>
        ))}
      </div>
      <button type="submit" className="btn-primary">Save</button>
    </form>
  );
}

const STARTER_FIELDS: FieldDef[] = [
  { key: "enabled", label: "Grants enabled", kind: "bool" },
  { key: "amountUsd", label: "Amount per grant (USD)", kind: "usd" },
  { key: "dailyBudgetUsd", label: "Global daily budget (USD)", kind: "usd" },
  { key: "perPrefixCap", label: "Grants per /24 (window)", kind: "int" },
  { key: "perFundingSourceCap", label: "Grants per funding source (window)", kind: "int" },
  { key: "capWindowDays", label: "Cap window (days)", kind: "int" },
  { key: "expiryDays", label: "Expiry (days)", kind: "int" },
  { key: "seedNodesOnly", label: "Route starter traffic to seed nodes only", kind: "bool" },
  { key: "seedOnlyDays", label: "Seed-only period (days)", kind: "int" },
  { key: "requireFunding", label: "Require prior Base tx or paid top-up", kind: "bool" },
  { key: "minTopupCents", label: "Minimum qualifying top-up (cents)", kind: "int" },
];

export function starterCurrent(s: StarterSettings): Record<string, string | boolean> {
  return {
    enabled: s.enabled, amountUsd: s.amount.usd.replace(/0+$/, "").replace(/\.$/, ""), dailyBudgetUsd: s.dailyBudget.usd.replace(/0+$/, "").replace(/\.$/, ""),
    perPrefixCap: String(s.perPrefixCap), perFundingSourceCap: String(s.perFundingSourceCap), capWindowDays: String(s.capWindowDays),
    expiryDays: String(s.expiryDays), seedNodesOnly: s.seedNodesOnly, seedOnlyDays: String(s.seedOnlyDays),
    requireFunding: s.requireFunding ?? true, minTopupCents: String(s.minTopupCents ?? 100),
  };
}

function StarterCard({ onMsg }: { onMsg: (m: string) => void }) {
  const s = useApi(() => launchApi.starterSettings());
  const [status, setStatus] = useState("active");
  const grants = useApi(() => launchApi.starterGrants({ status, limit: 50 }), [status]);
  const [revoke, setRevoke] = useState<string | null>(null);
  return (
    <Card title="Starter credits">
      <ErrorBox error={s.error ?? grants.error} />
      {s.data && (
        <>
          <p className="mb-3 text-xs text-slate-500 dark:text-slate-400">
            Granted today: {s.data.grantedToday?.count ?? 0} ({fmtMoney(s.data.grantedToday?.amount)}). Credits are non-withdrawable, expire, and never count toward tiers.
          </p>
          {s.data.requireFunding !== false && s.data.rpcConfigured === false && (
            <Notice tone="warn">STARTER_CREDIT_RPC_URL is not set (or not https): the on-chain check fails closed, so only paid top-ups qualify.</Notice>
          )}
          <SettingsForm fields={STARTER_FIELDS} current={starterCurrent(s.data)} onSave={async (p) => {
            await launchApi.updateStarterSettings(p); s.refetch(); onMsg("Starter credit settings saved.");
          }} />
        </>
      )}
      <div className="mt-4 flex items-end gap-3">
        <SelectFilter label="Grant status" value={status} onChange={setStatus} options={["active", "exhausted", "expired", "revoked"]} />
      </div>
      <DataTable caption="Starter credit grants" rowKey={(g) => g.id} rows={grants.data?.items ?? []} empty="No grants"
        columns={[
          { key: "u", header: "Agent", render: (g) => <Mono title={g.userId}>{g.walletAddress ? shortId(g.walletAddress) : shortId(g.userId)}</Mono> },
          { key: "a", header: "Amount", align: "right", render: (g) => fmtMoney(g.amount) },
          { key: "r", header: "Remaining", align: "right", render: (g) => fmtMoney(g.remaining) },
          { key: "p", header: "Prefix", render: (g) => g.ipPrefix ?? "—" },
          { key: "s", header: "Status", render: (g) => <Badge>{g.status}</Badge> },
          { key: "e", header: "Expires", render: (g) => fmtDate(g.expiresAt) },
          { key: "x", header: <span className="sr-only">Actions</span>, render: (g) => g.status === "active"
            ? <button type="button" className="btn-secondary !py-1 text-xs" onClick={() => setRevoke(g.id)}>Revoke</button> : null },
        ]} />
      <ConfirmDialog open={revoke !== null} title="Revoke starter grant" confirmLabel="Revoke" danger reason="required"
        onClose={() => setRevoke(null)}
        onConfirm={async (reason) => { const r = await launchApi.revokeGrant(revoke!, reason); setRevoke(null); onMsg(`Grant revoked; ${fmtMoney(r.removed)} removed.`); grants.refetch(); }} />
    </Card>
  );
}

const GENESIS_FIELDS: FieldDef[] = [
  { key: "enabled", label: "Genesis boost enabled", kind: "bool" },
  { key: "maxOwners", label: "Cohort size (owners)", kind: "int" },
  { key: "bonusBps", label: "Share bonus (bps)", kind: "int" },
  { key: "boostDays", label: "Boost length (days)", kind: "int" },
  { key: "creditUsd", label: "One-time credit (USD)", kind: "usd" },
  { key: "creditThresholdBytes", label: "Credit after matured paid bytes", kind: "digits" },
  { key: "minDistinctPayers", label: "Distinct unlinked paying principals to enter", kind: "int" },
  { key: "minPayerSpendMusd", label: "Paid spend each payer needs (µUSD)", kind: "digits" },
  { key: "creditThresholdNodeMusd", label: "Credit after matured node earnings (µUSD)", kind: "digits" },
];

export function genesisCurrent(g: GenesisSettings): Record<string, string | boolean> {
  return {
    enabled: g.enabled, maxOwners: String(g.maxOwners), bonusBps: String(g.bonusBps), boostDays: String(g.boostDays),
    creditUsd: g.credit.usd.replace(/0+$/, "").replace(/\.$/, ""), creditThresholdBytes: g.creditThresholdBytes,
    minDistinctPayers: String(g.minDistinctPayers ?? 3),
    minPayerSpendMusd: g.minPayerSpendMusd ?? "1000000", creditThresholdNodeMusd: g.creditThresholdNodeMusd ?? "10000000",
  };
}

function GenesisCard({ onMsg }: { onMsg: (m: string) => void }) {
  const s = useApi(() => launchApi.genesisSettings());
  const members = useApi(() => launchApi.genesisMembers({ limit: 50 }));
  const [claw, setClaw] = useState<string | null>(null);
  return (
    <Card title="Genesis boost">
      <ErrorBox error={s.error ?? members.error} />
      {s.data && (
        <>
          <p className="mb-3 text-xs text-slate-500 dark:text-slate-400">
            {s.data.members ?? 0} of {s.data.maxOwners} slots used. Bonus {fmtBps(s.data.bonusBps)} on top of tier share, never above 50%.
          </p>
          <SettingsForm fields={GENESIS_FIELDS} current={genesisCurrent(s.data)} onSave={async (p) => {
            await launchApi.updateGenesisSettings(p); s.refetch(); onMsg("Genesis settings saved.");
          }} />
        </>
      )}
      <DataTable caption="Genesis cohort" rowKey={(g) => g.ownerUserId} rows={members.data?.items ?? []} empty="No members yet"
        columns={[
          { key: "n", header: "#", render: (g) => g.seq },
          { key: "o", header: "Owner", render: (g) => <Mono title={g.ownerUserId}>{g.walletAddress ? shortId(g.walletAddress) : shortId(g.ownerUserId)}</Mono> },
          { key: "b", header: "Boost until", render: (g) => fmtDate(g.boostUntil) },
          { key: "q", header: "Qualifying traffic", align: "right", render: (g) => fmtBytes(g.qualifyingBytes) },
          { key: "c", header: "Credit", render: (g) => <Badge>{g.creditStatus}</Badge> },
          { key: "x", header: <span className="sr-only">Actions</span>, render: (g) => g.creditStatus === "held"
            ? <button type="button" className="btn-secondary !py-1 text-xs" onClick={() => setClaw(g.ownerUserId)}>Claw back</button> : null },
        ]} />
      <ConfirmDialog open={claw !== null} title="Claw back genesis credit" confirmLabel="Claw back" danger reason="required"
        description="Removes the still-held one-time genesis credit from this owner."
        onClose={() => setClaw(null)}
        onConfirm={async (reason) => { const r = await launchApi.clawbackGenesis(claw!, reason); setClaw(null); onMsg(`Genesis credit clawed back; ${fmtMoney(r.amount)} removed.`); members.refetch(); }} />
    </Card>
  );
}

function IncidentsCard({ onMsg }: { onMsg: (m: string) => void }) {
  const list = useApi(() => launchApi.incidents({ limit: 20 }));
  const [title, setTitle] = useState("");
  const [severity, setSeverity] = useState("minor");
  const [err, setErr] = useState<string | null>(null);
  const setStatus = async (i: Incident, status: string) => {
    try { await launchApi.updateIncident(i.id, { status }); list.refetch(); onMsg(`Incident marked ${status}.`); } catch (e) { setErr(errText(e)); }
  };
  return (
    <Card title="Incidents (public status page)">
      <ErrorBox error={list.error ?? err} />
      <form className="mb-3 flex flex-wrap items-end gap-2" onSubmit={async (e) => {
        e.preventDefault();
        if (!title.trim()) { setErr("Title required"); return; }
        try { setErr(null); await launchApi.createIncident({ title: title.trim(), severity }); setTitle(""); list.refetch(); onMsg("Incident posted."); }
        catch (x) { setErr(errText(x)); }
      }}>
        <Field label="Title" className="min-w-64 flex-1">{(id) => <input id={id} className="input" maxLength={200} value={title} onChange={(e) => setTitle(e.target.value)} />}</Field>
        <SelectFilter label="Severity" value={severity} onChange={setSeverity} options={["minor", "major", "critical", "maintenance"]} allLabel={null} />
        <button type="submit" className="btn-primary">Post incident</button>
      </form>
      <DataTable caption="Incidents" rowKey={(i) => i.id} rows={list.data?.items ?? []} empty="No incidents"
        columns={[
          { key: "t", header: "Title", render: (i) => i.title },
          { key: "s", header: "Severity", render: (i) => <Badge>{i.severity}</Badge> },
          { key: "st", header: "Status", render: (i) => <Badge>{i.status}</Badge> },
          { key: "d", header: "Started", render: (i) => fmtDate(i.startedAt) },
          { key: "x", header: <span className="sr-only">Actions</span>, render: (i) => i.status === "resolved" ? fmtDate(i.resolvedAt) : (
            <span className="flex gap-1">
              <button type="button" className="btn-secondary !py-1 text-xs" onClick={() => void setStatus(i, "monitoring")}>Monitoring</button>
              <button type="button" className="btn-secondary !py-1 text-xs" onClick={() => void setStatus(i, "resolved")}>Resolve</button>
            </span>
          ) },
        ]} />
    </Card>
  );
}

const ANN_CATEGORIES = ["news", "policy", "pricing", "payments", "api", "network"];

function AnnouncementsCard({ onMsg }: { onMsg: (m: string) => void }) {
  const list = useApi(() => launchApi.announcements({ limit: 50 }));
  const [title, setTitle] = useState("");
  const [text, setText] = useState("");
  const [url, setUrl] = useState("");
  const [category, setCategory] = useState("news");
  const [err, setErr] = useState<string | null>(null);
  const [remove, setRemove] = useState<string | null>(null);
  const toggle = async (a: Announcement) => {
    try { await launchApi.updateAnnouncement(a.id, { published: !a.published }); list.refetch(); onMsg(a.published ? "Announcement unpublished." : "Announcement published."); }
    catch (e) { setErr(errText(e)); }
  };
  return (
    <Card title="Announcements (GET /v1/announcements)">
      <ErrorBox error={list.error ?? err} />
      <p className="mb-3 text-xs text-slate-500 dark:text-slate-400">Public feed agents poll for policy, pricing, payment and API changes. Linked from llms.txt and the discovery document.</p>
      <form className="mb-3 space-y-2" onSubmit={async (e) => {
        e.preventDefault();
        if (!title.trim()) { setErr("Title required"); return; }
        if (url.trim() && !/^https:\/\/\S+$/.test(url.trim())) { setErr("Link must be an https URL"); return; }
        try {
          setErr(null);
          await launchApi.createAnnouncement({ title: title.trim(), body: text, category, ...(url.trim() ? { url: url.trim() } : {}) });
          setTitle(""); setText(""); setUrl(""); list.refetch(); onMsg("Announcement published.");
        } catch (x) { setErr(errText(x)); }
      }}>
        <div className="flex flex-wrap items-end gap-2">
          <Field label="Announcement title" className="min-w-64 flex-1">{(id) => <input id={id} className="input" maxLength={200} value={title} onChange={(e) => setTitle(e.target.value)} />}</Field>
          <SelectFilter label="Category" value={category} onChange={setCategory} options={ANN_CATEGORIES} allLabel={null} />
          <Field label="Link (https, optional)" className="min-w-48">{(id) => <input id={id} className="input" maxLength={500} value={url} onChange={(e) => setUrl(e.target.value)} />}</Field>
        </div>
        <Field label="Announcement body">{(id) => <textarea id={id} className="input" rows={3} maxLength={10000} value={text} onChange={(e) => setText(e.target.value)} />}</Field>
        <button type="submit" className="btn-primary">Publish announcement</button>
      </form>
      <DataTable caption="Announcements" rowKey={(a) => a.id} rows={list.data?.items ?? []} empty="No announcements"
        columns={[
          { key: "t", header: "Title", render: (a) => a.title },
          { key: "c", header: "Category", render: (a) => <Badge>{a.category}</Badge> },
          { key: "p", header: "State", render: (a) => <Badge>{a.published ? "published" : "draft"}</Badge> },
          { key: "d", header: "Published", render: (a) => fmtDate(a.publishedAt) },
          { key: "x", header: <span className="sr-only">Actions</span>, render: (a) => (
            <span className="flex gap-1">
              <button type="button" className="btn-secondary !py-1 text-xs" onClick={() => void toggle(a)}>{a.published ? "Unpublish" : "Publish"}</button>
              <button type="button" className="btn-secondary !py-1 text-xs" onClick={() => setRemove(a.id)}>Delete</button>
            </span>
          ) },
        ]} />
      <ConfirmDialog open={remove !== null} title="Delete announcement" confirmLabel="Delete" danger
        onClose={() => setRemove(null)}
        onConfirm={async () => { await launchApi.deleteAnnouncement(remove!); setRemove(null); list.refetch(); onMsg("Announcement deleted."); }} />
    </Card>
  );
}

function UnmetCard() {
  const [days, setDays] = useState("7");
  const d = useApi(() => launchApi.unmetDemand(Number(days)), [days]);
  return (
    <Card title="Unmet demand (no eligible node)">
      <ErrorBox error={d.error} />
      <SelectFilter label="Window (days)" value={days} onChange={setDays} options={["1", "7", "30", "90"]} allLabel={null} />
      {d.loading && !d.data ? <Loading /> : (
        <DataTable caption="Unmet demand" rowKey={(g) => `${g.country}-${g.ipClass}`} rows={d.data?.groups ?? []} empty="No unmet demand"
          columns={[
            { key: "c", header: "Country", render: (g) => g.country ?? "any" },
            { key: "k", header: "Class", render: (g) => g.ipClass ?? "any" },
            { key: "n", header: "Failed selections", align: "right", render: (g) => g.requests },
            { key: "l", header: "Last seen (hour)", render: (g) => fmtDate(g.lastHour) },
          ]} />
      )}
    </Card>
  );
}

function AbuseReportsCard({ onMsg }: { onMsg: (m: string) => void }) {
  const [status, setStatus] = useState("new");
  const list = useApi(() => launchApi.abuseReports({ status, limit: 50 }), [status]);
  const [target, setTarget] = useState<{ r: AbuseReport; status: string } | null>(null);
  return (
    <Card title="Abuse reports (public intake)">
      <ErrorBox error={list.error} />
      <SelectFilter label="Status" value={status} onChange={setStatus} options={["new", "triaged", "actioned", "dismissed"]} />
      <DataTable caption="Abuse reports" rowKey={(r) => r.id} rows={list.data?.items ?? []} empty="No reports"
        columns={[
          { key: "h", header: "Destination", render: (r) => <Mono>{r.destHost}</Mono> },
          { key: "w", header: "Window", render: (r) => `${fmtDate(r.windowStart)} – ${fmtDate(r.windowEnd)}` },
          { key: "c", header: "Category", render: (r) => r.category },
          { key: "d", header: "Description", render: (r) => <span className="line-clamp-2 max-w-md">{r.description}</span> },
          { key: "m", header: "Matching sessions", align: "right", render: (r) => `${r.matches.sessions} (${r.matches.requesters} agents)` },
          { key: "x", header: <span className="sr-only">Actions</span>, render: (r) => (
            <span className="flex gap-1">
              {["triaged", "actioned", "dismissed"].filter((s) => s !== r.status).map((s) => (
                <button key={s} type="button" className="btn-secondary !py-1 text-xs" onClick={() => setTarget({ r, status: s })}>{s}</button>
              ))}
            </span>
          ) },
        ]} />
      <ConfirmDialog open={target !== null} title={`Mark report ${target?.status ?? ""}`} confirmLabel="Save" reason="optional"
        onClose={() => setTarget(null)}
        onConfirm={async (note) => { await launchApi.triageReport(target!.r.id, target!.status, note || undefined); setTarget(null); onMsg("Report updated."); list.refetch(); }} />
    </Card>
  );
}

function AllowlistCard({ onMsg }: { onMsg: (m: string) => void }) {
  const list = useApi(() => launchApi.allowlist({ limit: 100 }));
  const [userId, setUserId] = useState("");
  const [err, setErr] = useState<string | null>(null);
  return (
    <Card title="Contribution allowlist (policy.requireContribution)">
      <ErrorBox error={list.error ?? err} />
      <form className="mb-3 flex flex-wrap items-end gap-2" onSubmit={async (e) => {
        e.preventDefault();
        if (!UUID.test(userId.trim())) { setErr("Enter an agent user id (UUID)"); return; }
        try { setErr(null); await launchApi.addAllowlist(userId.trim()); setUserId(""); list.refetch(); onMsg("Agent allowlisted."); }
        catch (x) { setErr(errText(x)); }
      }}>
        <Field label="Agent user id" className="w-80">{(id) => <input id={id} className="input font-mono" value={userId} onChange={(e) => setUserId(e.target.value)} />}</Field>
        <button type="submit" className="btn-primary">Allow</button>
      </form>
      <DataTable caption="Allowlist" rowKey={(a) => a.userId} rows={list.data?.items ?? []} empty="Nobody allowlisted"
        columns={[
          { key: "u", header: "Agent", render: (a) => <Mono title={a.userId}>{a.walletAddress ?? a.userId}</Mono> },
          { key: "n", header: "Note", render: (a) => a.note ?? "—" },
          { key: "c", header: "Added", render: (a) => fmtDate(a.createdAt) },
          { key: "x", header: <span className="sr-only">Actions</span>, render: (a) => (
            <button type="button" className="btn-secondary !py-1 text-xs" onClick={async () => {
              try { await launchApi.removeAllowlist(a.userId); list.refetch(); onMsg("Removed from allowlist."); } catch (e) { setErr(errText(e)); }
            }}>Remove</button>
          ) },
        ]} />
    </Card>
  );
}

export default function LaunchPage() {
  const [msg, setMsg] = useState<string | null>(null);
  return (
    <div>
      <PageHeader title="Launch controls" subtitle="Seed nodes, starter credits, genesis boost, status incidents, announcements, unmet demand, abuse reports and the contribution allowlist. Changes are audited." />
      {msg && <Notice tone="good">{msg}</Notice>}
      <div className="space-y-4">
        <SeedCard onMsg={setMsg} />
        <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
          <StarterCard onMsg={setMsg} />
          <GenesisCard onMsg={setMsg} />
        </div>
        <IncidentsCard onMsg={setMsg} />
        <AnnouncementsCard onMsg={setMsg} />
        <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
          <UnmetCard />
          <AllowlistCard onMsg={setMsg} />
        </div>
        <AbuseReportsCard onMsg={setMsg} />
      </div>
    </div>
  );
}
