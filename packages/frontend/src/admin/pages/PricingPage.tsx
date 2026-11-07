import { useEffect, useState } from "react";
import { useApi } from "../../hooks/useApi";
import { adminApi, launchApi, type Tier } from "../../api/admin";
import { fmtBps, fmtDate, fmtMusd, fmtInt } from "../../lib/format";
import { Card, ConfirmDialog, DataTable, ErrorBox, Field, Loading, Notice, PageHeader } from "../components/ui";

const PRICE_CLASSES = ["residential", "dc", "mobile", "any"] as const;

/** "$2.50" style USD string → µUSD integer, or null if malformed. */
export function usdToMusd(s: string): number | null {
  const t = s.trim().replace(/^\$/, "");
  if (!/^\d+(\.\d{1,6})?$/.test(t)) return null;
  return Math.round(Number(t) * 1_000_000);
}
/** Percent string → basis points, or null. */
export function pctToBps(s: string): number | null {
  const t = s.trim().replace(/%$/, "");
  if (!/^\d+(\.\d{1,2})?$/.test(t)) return null;
  return Math.round(Number(t) * 100);
}

function PricingCard({ onSaved }: { onSaved: (m: string) => void }) {
  const pr = useApi(() => adminApi.pricing());
  const [edit, setEdit] = useState<Record<string, string>>({});
  const [confirm, setConfirm] = useState<{ ipClass: string; musd: number } | null>(null);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => {
    if (pr.data) setEdit(Object.fromEntries(pr.data.pricing.map((p) => [p.ipClass, String(Number(p.pricePerGbMusd) / 1_000_000)])));
  }, [pr.data]);
  if (pr.loading && !pr.data) return <Card title="Relay pricing (per GB)"><Loading /></Card>;
  const rows = pr.data?.pricing ?? [];
  const byClass = new Map(rows.map((r) => [r.ipClass, r]));
  return (
    <Card title="Relay pricing (per GB)">
      <ErrorBox error={pr.error ?? err} />
      <p className="mb-3 text-xs text-slate-500">Price charged to requesters per GB, $0.001–$5.00. Node share is applied on top via the split and tiers.</p>
      <div className="space-y-3">
        {PRICE_CLASSES.filter((c) => byClass.has(c) || c !== "any").map((c) => {
          const cur = byClass.get(c);
          return (
            <form key={c} className="flex flex-wrap items-end gap-2" onSubmit={(e) => {
              e.preventDefault();
              const musd = usdToMusd(edit[c] ?? "");
              if (musd === null || musd < 1000 || musd > 5_000_000) { setErr(`${c}: enter a USD price between 0.001 and 5`); return; }
              setErr(null);
              setConfirm({ ipClass: c, musd });
            }}>
              <Field label={`${c} (USD/GB)`} className="w-40" hint={cur ? `Now ${fmtMusd(cur.pricePerGbMusd)} · ${fmtDate(cur.updatedAt)}` : "Not set"}>
                {(id) => <input id={id} className="input" inputMode="decimal" value={edit[c] ?? ""} onChange={(e) => setEdit((s) => ({ ...s, [c]: e.target.value }))} />}
              </Field>
              <button type="submit" className="btn-secondary mb-5">Save</button>
            </form>
          );
        })}
      </div>
      <ConfirmDialog open={confirm !== null} title="Change relay price?" confirmLabel="Save price"
        description={confirm && <>Set <strong>{confirm.ipClass}</strong> to <strong>{fmtMusd(confirm.musd)}</strong> per GB. Applies to new charges immediately.</>}
        onClose={() => setConfirm(null)}
        onConfirm={async () => {
          const r = await adminApi.setPricing(confirm!.ipClass, confirm!.musd);
          setConfirm(null);
          onSaved(`${r.ipClass} price set to ${fmtMusd(r.pricePerGbMusd)}/GB.`);
          pr.refetch();
        }} />
    </Card>
  );
}

function SplitCard({ onSaved }: { onSaved: (m: string) => void }) {
  const sp = useApi(() => adminApi.split());
  const [share, setShare] = useState("");
  const [hours, setHours] = useState("");
  const [note, setNote] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<{ bps: number; hours: number } | null>(null);
  useEffect(() => {
    if (sp.data) { setShare(String(sp.data.current.nodeShareBps / 100)); setHours(String(sp.data.current.maturationHours)); }
  }, [sp.data]);
  if (sp.loading && !sp.data) return <Card title="Revenue split"><Loading /></Card>;
  return (
    <Card title="Revenue split">
      <ErrorBox error={sp.error ?? err} />
      {sp.data && (
        <p className="mb-3 text-sm text-slate-600 dark:text-slate-400">
          Current: node share <strong>{fmtBps(sp.data.current.nodeShareBps)}</strong>, credits mature after <strong>{sp.data.current.maturationHours} h</strong> (since {fmtDate(sp.data.current.effectiveFrom)}).
          The split is append-only; a new row takes effect now.
        </p>
      )}
      <form className="grid grid-cols-1 gap-3 sm:grid-cols-4 sm:items-end" onSubmit={(e) => {
        e.preventDefault();
        const bps = pctToBps(share);
        const h = /^\d+$/.test(hours.trim()) ? Number(hours) : NaN;
        if (bps === null || bps > 5000) { setErr("Node share must be between 0% and 50%."); return; }
        if (!Number.isInteger(h) || h > 2160) { setErr("Maturation must be 0–2160 hours."); return; }
        setErr(null);
        setConfirm({ bps, hours: h });
      }}>
        <Field label="Node share (%)" hint="max 50%">{(id) => <input id={id} className="input" inputMode="decimal" value={share} onChange={(e) => setShare(e.target.value)} />}</Field>
        <Field label="Maturation (hours)" hint="0–2160">{(id) => <input id={id} className="input" inputMode="numeric" value={hours} onChange={(e) => setHours(e.target.value)} />}</Field>
        <Field label="Note" hint="optional">{(id) => <input id={id} className="input" maxLength={500} value={note} onChange={(e) => setNote(e.target.value)} />}</Field>
        <button type="submit" className="btn-secondary mb-5">Append split…</button>
      </form>
      {sp.data && (
        <DataTable caption="Split history" rowKey={(r) => String(r.id)} rows={sp.data.history}
          columns={[
            { key: "e", header: "Effective", render: (r) => fmtDate(r.effectiveFrom) },
            { key: "s", header: "Node share", align: "right", render: (r) => fmtBps(r.nodeShareBps) },
            { key: "m", header: "Maturation", align: "right", render: (r) => `${r.maturationHours} h` },
            { key: "n", header: "Note", render: (r) => r.note ?? "—", className: "max-w-xs truncate" },
          ]} />
      )}
      <ConfirmDialog open={confirm !== null} title="Append revenue split?" confirmLabel="Append"
        description={confirm && <>Node share {fmtBps(confirm.bps)}, maturation {confirm.hours} h, effective now.</>}
        onClose={() => setConfirm(null)}
        onConfirm={async () => {
          await adminApi.addSplit({ nodeShareBps: confirm!.bps, maturationHours: confirm!.hours, ...(note.trim() ? { note: note.trim() } : {}) });
          setConfirm(null);
          setNote("");
          onSaved(`Split appended: node share ${fmtBps(confirm!.bps)}.`);
          sp.refetch();
        }} />
    </Card>
  );
}

const TIER_FIELDS: Array<{ key: keyof Tier; label: string; kind: "pct" | "int" | "usd"; max?: number }> = [
  { key: "nodeShareBps", label: "Node share (%)", kind: "pct", max: 5000 },
  { key: "minTenureDays", label: "Min tenure (days)", kind: "int", max: 3650 },
  { key: "minUptimeBps", label: "Min uptime (%)", kind: "pct", max: 10000 },
  { key: "minActiveIps", label: "Min active IPs", kind: "int", max: 1_000_000 },
  { key: "minReputation", label: "Min reputation (%)", kind: "pct", max: 10000 },
  { key: "noClawbackDays", label: "No-clawback after (days)", kind: "int", max: 3650 },
  { key: "holdDays", label: "Hold (days)", kind: "int", max: 90 },
  { key: "maxNodes", label: "Max nodes", kind: "int", max: 100000 },
  { key: "buyerDiscountBps", label: "Buyer discount (%)", kind: "pct", max: 5000 },
  { key: "dailyWithdrawLimitMusd", label: "Daily withdraw limit (USD)", kind: "usd" },
];

function tierToStrings(t: Tier): Record<string, string> {
  const o: Record<string, string> = {};
  for (const f of TIER_FIELDS) {
    const v = t[f.key];
    o[f.key] = f.kind === "pct" ? String(Number(v) / 100) : f.kind === "usd" ? String(Number(v) / 1_000_000) : String(v);
  }
  return o;
}

export function tierPatch(t: Tier, vals: Record<string, string>): { patch: Record<string, number>; error: string | null } {
  const patch: Record<string, number> = {};
  for (const f of TIER_FIELDS) {
    const s = vals[f.key] ?? "";
    const n = f.kind === "pct" ? pctToBps(s) : f.kind === "usd" ? usdToMusd(s) : (/^\d+$/.test(s.trim()) ? Number(s) : null);
    if (n === null) return { patch: {}, error: `${f.label}: invalid number` };
    if (f.max !== undefined && n > f.max) return { patch: {}, error: `${f.label}: maximum is ${f.kind === "pct" ? `${f.max / 100}%` : f.max}` };
    if (f.key === "maxNodes" && n < 1) return { patch: {}, error: "Max nodes must be at least 1" };
    if (n !== Number(t[f.key])) patch[f.key] = n;
  }
  return { patch, error: null };
}

function TiersCard({ onSaved }: { onSaved: (m: string) => void }) {
  const tiers = useApi(() => adminApi.tiers());
  const [editing, setEditing] = useState<Tier | null>(null);
  const [vals, setVals] = useState<Record<string, string>>({});
  const [err, setErr] = useState<string | null>(null);
  if (tiers.loading && !tiers.data) return <Card title="Node tiers"><Loading /></Card>;
  return (
    <Card title="Node tiers" bodyClassName="pt-0">
      <ErrorBox error={tiers.error} />
      <DataTable caption="Node tiers" rowKey={(t) => String(t.id)} rows={tiers.data?.tiers ?? []}
        columns={[
          { key: "n", header: "Tier", render: (t) => <strong>{t.name}</strong> },
          { key: "s", header: "Node share", align: "right", render: (t) => fmtBps(t.nodeShareBps) },
          { key: "t", header: "Tenure", align: "right", render: (t) => `${t.minTenureDays} d` },
          { key: "u", header: "Uptime", align: "right", render: (t) => fmtBps(t.minUptimeBps, 1) },
          { key: "ip", header: "Active IPs", align: "right", render: (t) => fmtInt(t.minActiveIps) },
          { key: "r", header: "Reputation", align: "right", render: (t) => fmtBps(t.minReputation, 1) },
          { key: "h", header: "Hold", align: "right", render: (t) => `${t.holdDays} d` },
          { key: "m", header: "Max nodes", align: "right", render: (t) => fmtInt(t.maxNodes) },
          { key: "bd", header: "Buyer discount", align: "right", render: (t) => fmtBps(t.buyerDiscountBps ?? 0) },
          { key: "w", header: "Withdraw/day", align: "right", render: (t) => fmtMusd(t.dailyWithdrawLimitMusd) },
          { key: "x", header: <span className="sr-only">Actions</span>, render: (t) => (
            <button type="button" className="btn-secondary !py-1 text-xs" onClick={() => { setErr(null); setVals(tierToStrings(t)); setEditing(t); }}>Edit</button>
          ) },
        ]} />
      <ConfirmDialog open={editing !== null} title={`Edit tier ${editing?.name ?? ""}`} confirmLabel="Save tier"
        onClose={() => setEditing(null)}
        onConfirm={async () => {
          const { patch, error } = tierPatch(editing!, vals);
          if (error) throw new Error(error);
          if (Object.keys(patch).length === 0) { setEditing(null); return; }
          await adminApi.updateTier(editing!.id, patch);
          setEditing(null);
          onSaved(`Tier ${editing!.name} updated.`);
          tiers.refetch();
        }}>
        <ErrorBox error={err} />
        <div className="mt-3 grid grid-cols-2 gap-3">
          {TIER_FIELDS.map((f) => (
            <Field key={f.key} label={f.label}>
              {(id) => <input id={id} className="input" inputMode="decimal" value={vals[f.key] ?? ""} onChange={(e) => setVals((v) => ({ ...v, [f.key]: e.target.value }))} />}
            </Field>
          ))}
        </div>
      </ConfirmDialog>
    </Card>
  );
}

/** Buyer discounts are platform-funded: the platform keeps at least this share of the list price. */
function MarginFloorCard({ onSaved }: { onSaved: (m: string) => void }) {
  const s = useApi(() => launchApi.discountSettings());
  const [pct, setPct] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const value = pct ?? (s.data ? String(s.data.minPlatformMarginBps / 100) : "");
  return (
    <Card title="Buyer discount margin floor">
      <ErrorBox error={s.error ?? err} />
      <p className="mb-3 text-xs text-slate-500 dark:text-slate-400">
        Node operators buy at their tier discount. Node earnings are computed on the list price and never change;
        the discount comes out of the platform share and is clamped so the platform keeps at least this percentage of list.
      </p>
      <div className="flex flex-wrap items-end gap-3">
        <Field label="Minimum platform margin (%)">
          {(id) => <input id={id} className="input w-32" inputMode="decimal" value={value} onChange={(e) => setPct(e.target.value)} />}
        </Field>
        <label className="flex items-center gap-2 py-1.5 text-sm">
          <input type="checkbox" checked={s.data?.enabled ?? true} onChange={async (e) => {
            try { await launchApi.updateDiscountSettings({ enabled: e.target.checked }); s.refetch(); onSaved("Buyer discounts updated."); }
            catch (x) { setErr(x instanceof Error ? x.message : String(x)); }
          }} />
          Discounts enabled
        </label>
        <button type="button" className="btn-primary" onClick={async () => {
          const bps = pctToBps(value);
          if (bps === null || bps > 10000) { setErr("Enter a percentage between 0 and 100"); return; }
          try { setErr(null); await launchApi.updateDiscountSettings({ minPlatformMarginBps: bps }); setPct(null); s.refetch(); onSaved("Margin floor updated."); }
          catch (x) { setErr(x instanceof Error ? x.message : String(x)); }
        }}>Save</button>
      </div>
    </Card>
  );
}

export default function PricingPage() {
  const [msg, setMsg] = useState<string | null>(null);
  return (
    <div>
      <PageHeader title="Pricing, Split & Tiers" subtitle="Every change is written to the audit log." />
      {msg && <Notice tone="good">{msg}</Notice>}
      <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
        <PricingCard onSaved={setMsg} />
        <SplitCard onSaved={setMsg} />
      </div>
      <div className="mt-4"><TiersCard onSaved={setMsg} /></div>
      <div className="mt-4"><MarginFloorCard onSaved={setMsg} /></div>
    </div>
  );
}
