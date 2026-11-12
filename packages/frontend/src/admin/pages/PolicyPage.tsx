import { useEffect, useState, type ReactNode } from "react";
import { useApi } from "../../hooks/useApi";
import { ApiError } from "../../api/client";
import { adminApi, type NetworkPolicy, type PlaintextMode } from "../../api/admin";
import { fmtDate, fmtMusd } from "../../lib/format";
import { Badge, Card, ConfirmDialog, ErrorBox, Field, Loading, Mono, Notice, PageHeader } from "../components/ui";

/** Mirrors packages/shared/src/policy.ts — enforced by every node's floor, not editable. */
const FLOOR_PORTS = [80, 443];
const HARD_DENY_PORTS = [22, 23, 25, 465, 587, 3389, 6667];
const OFAC_CODES = ["CU", "IR", "KP", "RU", "SY"];

interface Form {
  plaintext: PlaintextMode; ports: number[]; denyDomains: string; denyCategories: string; categoriesVersion: string;
  maxStreams: string; maxGbDay: string; reqPerSec: string; dailySpendUsd: string;
  per32: string; per24: string; perAsn: string; addCountries: string;
  attestationMinVersion: string; attestationText: string; freeTierRelay: boolean; logRetentionDays: string;
  requireContribution: boolean; contributionWindowDays: string; allowAnonymousPayers: boolean;
}

function toForm(p: NetworkPolicy): Form {
  return {
    plaintext: p.plaintext, ports: [...p.ports], denyDomains: p.denyDomains.join("\n"), denyCategories: p.denyCategories.join("\n"),
    categoriesVersion: String(p.categoriesVersion), maxStreams: String(p.nodeDefaults.maxStreams), maxGbDay: String(p.nodeDefaults.maxGbDay),
    reqPerSec: String(p.requesterLimits.reqPerSec), dailySpendUsd: String(p.requesterLimits.dailySpendMusd / 1_000_000),
    per32: String(p.nodeCapsPerPrefix.per32), per24: String(p.nodeCapsPerPrefix.per24), perAsn: String(p.nodeCapsPerPrefix.perAsn),
    addCountries: "", attestationMinVersion: String(p.attestation.minVersion), attestationText: p.attestation.text,
    freeTierRelay: p.freeTierRelay, logRetentionDays: String(p.logRetentionDays),
    requireContribution: p.requireContribution ?? false, contributionWindowDays: String(p.contributionWindowDays ?? 30),
    allowAnonymousPayers: p.allowAnonymousPayers ?? true,
  };
}

const lines = (s: string) => s.split(/[\n,]/).map((x) => x.trim()).filter(Boolean);
/** Integers are sent as typed; the server validates ranges and reports errors. */
const int = (s: string) => (/^-?\d+$/.test(s.trim()) ? Number(s.trim()) : (s as unknown as number));

export function buildPolicy(f: Form, current: NetworkPolicy): NetworkPolicy {
  const usd = Number(f.dailySpendUsd);
  const added = lines(f.addCountries).map((c) => c.toUpperCase());
  return {
    ports: [...f.ports].sort((a, b) => a - b),
    categoriesVersion: int(f.categoriesVersion),
    denyCategories: lines(f.denyCategories).map((c) => c.toLowerCase()),
    denyDomains: lines(f.denyDomains).map((d) => d.toLowerCase()),
    nodeDefaults: { maxStreams: int(f.maxStreams), maxGbDay: int(f.maxGbDay) },
    requesterLimits: { reqPerSec: int(f.reqPerSec), dailySpendMusd: Number.isFinite(usd) ? Math.round(usd * 1_000_000) : (f.dailySpendUsd as unknown as number) },
    sanctionedCountries: [...new Set([...current.sanctionedCountries, ...added])].sort(),
    attestation: { minVersion: int(f.attestationMinVersion), text: f.attestationText },
    plaintext: f.plaintext,
    logRetentionDays: int(f.logRetentionDays),
    nodeCapsPerPrefix: { per32: int(f.per32), per24: int(f.per24), perAsn: int(f.perAsn) },
    freeTierRelay: f.freeTierRelay,
    requireContribution: f.requireContribution,
    contributionWindowDays: int(f.contributionWindowDays),
    allowAnonymousPayers: f.allowAnonymousPayers,
  };
}

function Section({ title, children, note }: { title: string; children: ReactNode; note?: ReactNode }) {
  return (
    <fieldset className="border-t border-slate-100 pt-4 first:border-0 first:pt-0 dark:border-slate-800">
      <legend className="sr-only">{title}</legend>
      <h3 className="mb-1 text-sm font-semibold text-slate-800 dark:text-slate-200">{title}</h3>
      {note && <p className="mb-3 text-xs text-slate-500 dark:text-slate-400">{note}</p>}
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">{children}</div>
    </fieldset>
  );
}

export default function PolicyPage() {
  const pol = useApi(() => adminApi.policy());
  const [form, setForm] = useState<Form | null>(null);
  const [confirm, setConfirm] = useState(false);
  const [details, setDetails] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState<string | null>(null);

  useEffect(() => { if (pol.data) setForm(toForm(pol.data.body)); }, [pol.data]);

  if (pol.loading && !pol.data) return <Loading />;
  if (!pol.data || !form) return <ErrorBox error={pol.error ?? "Failed to load"} onRetry={pol.refetch} />;
  const p = pol.data;
  const set = <K extends keyof Form>(k: K, v: Form[K]) => setForm((f) => (f ? { ...f, [k]: v } : f));
  const text = (k: keyof Form, label: string, hint?: string, type = "text") => (
    <Field label={label} hint={hint}>
      {(id) => <input id={id} type={type} className="input" value={form[k] as string} onChange={(e) => set(k, e.target.value as never)} />}
    </Field>
  );

  return (
    <div>
      <PageHeader title="Network policy"
        subtitle={<>{p.version === 0 ? <strong>Built-in default (never published)</strong> : <>Version <strong>{p.version}</strong> · published {fmtDate(p.createdAt)}</>} · sha256 <Mono title={p.sha256}>{p.sha256.slice(0, 16)}…</Mono></>} />
      {saved && <Notice tone="good">{saved}</Notice>}
      {error && (
        <div role="alert" className="mb-4 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700 dark:border-red-900 dark:bg-red-950/40 dark:text-red-300">
          <div className="font-medium">{error}</div>
          {details.length > 0 && <ul className="mt-1 list-disc pl-5">{details.map((d) => <li key={d}>{d}</li>)}</ul>}
        </div>
      )}

      <div className="grid grid-cols-1 gap-4 xl:grid-cols-3">
        <Card title="Editable policy" className="xl:col-span-2">
          <form className="space-y-5" onSubmit={(e) => { e.preventDefault(); setConfirm(true); }}>
            <Section title="Traffic" note="Policy can only tighten what the node floor allows.">
              <Field label="Plaintext HTTP (port 80)">
                {(id) => (
                  <select id={id} className="input" value={form.plaintext} onChange={(e) => set("plaintext", e.target.value as PlaintextMode)}>
                    <option value="deny">deny</option><option value="opt_in">opt_in (node must opt in)</option><option value="allow">allow</option>
                  </select>
                )}
              </Field>
              <div className="flex flex-col gap-1">
                <span className="text-xs font-medium text-slate-600 dark:text-slate-400">Allowed ports (subset of 80/443)</span>
                <div className="flex gap-4 py-1.5 text-sm">
                  {FLOOR_PORTS.map((port) => (
                    <label key={port} className="flex items-center gap-1.5">
                      <input type="checkbox" checked={form.ports.includes(port)}
                        onChange={(e) => set("ports", e.target.checked ? [...form.ports, port] : form.ports.filter((x) => x !== port))} />
                      {port}
                    </label>
                  ))}
                </div>
              </div>
              <label className="flex items-center gap-2 self-end py-1.5 text-sm">
                <input type="checkbox" checked={form.freeTierRelay} onChange={(e) => set("freeTierRelay", e.target.checked)} />
                Free-tier relay (deprecated, no effect: all relay traffic is paid)
              </label>
              <label className="flex items-center gap-2 self-end py-1.5 text-sm">
                <input type="checkbox" checked={form.requireContribution} onChange={(e) => set("requireContribution", e.target.checked)} />
                Require contribution to buy (403 CONTRIBUTION_REQUIRED)
              </label>
              <Field label="Contribution window (days)">
                {(id) => <input id={id} className="input" inputMode="numeric" value={form.contributionWindowDays} onChange={(e) => set("contributionWindowDays", e.target.value)} />}
              </Field>
              <label className="flex items-center gap-2 self-end py-1.5 text-sm">
                <input type="checkbox" checked={form.allowAnonymousPayers} onChange={(e) => set("allowAnonymousPayers", e.target.checked)} />
                Allow x402/MPP payers without an account
              </label>
            </Section>

            <Section title="Denylists" note="One entry per line. Domains are matched with their subdomains.">
              <Field label="Deny domains" className="sm:col-span-2">
                {(id) => <textarea id={id} rows={5} className="input font-mono" value={form.denyDomains} onChange={(e) => set("denyDomains", e.target.value)} />}
              </Field>
              <div className="space-y-3">
                <Field label="Deny categories">
                  {(id) => <textarea id={id} rows={3} className="input font-mono" value={form.denyCategories} onChange={(e) => set("denyCategories", e.target.value)} />}
                </Field>
                {text("categoriesVersion", "Categories version")}
              </div>
            </Section>

            <Section title="Caps">
              {text("maxStreams", "Node default max streams", "1–1024")}
              {text("maxGbDay", "Node default max GB/day", "1–10000")}
              {text("reqPerSec", "Requester req/sec", "1–10000")}
              {text("dailySpendUsd", "Requester daily spend (USD)", fmtMusd(Math.round(Number(form.dailySpendUsd) * 1_000_000)))}
              {text("per32", "Nodes per IP (/32)", "≤ per /24")}
              {text("per24", "Nodes per /24")}
              {text("perAsn", "Nodes per ASN")}
              {text("logRetentionDays", "Abuse log retention (days)", "1–3650; the API never returns rows older than 90 days")}
            </Section>

            <Section title="Sanctions" note="Grow-only: codes can be added but never removed once published.">
              <div className="sm:col-span-2">
                <span className="text-xs font-medium text-slate-600 dark:text-slate-400">Current list</span>
                <div className="mt-1 flex flex-wrap gap-1">
                  {p.body.sanctionedCountries.map((c) => <Badge key={c} tone={OFAC_CODES.includes(c) ? "bad" : "warn"}>{c}</Badge>)}
                </div>
              </div>
              {text("addCountries", "Add codes", "ISO alpha-2, comma separated")}
            </Section>

            <Section title="Node attestation" note="Raising the minimum version requires every node to re-attest. It cannot be lowered.">
              {text("attestationMinVersion", "Minimum version", `Current: ${p.body.attestation.minVersion}`)}
              <Field label="Attestation text" className="sm:col-span-2">
                {(id) => <textarea id={id} rows={3} className="input" value={form.attestationText} onChange={(e) => set("attestationText", e.target.value)} />}
              </Field>
            </Section>

            <div className="flex flex-wrap justify-end gap-2 border-t border-slate-100 pt-4 dark:border-slate-800">
              <button type="button" className="btn-secondary" onClick={() => { setForm(toForm(p.body)); setError(null); setDetails([]); }}>Reset</button>
              <button type="submit" className="btn-primary">Publish new version…</button>
            </div>
          </form>
        </Card>

        <Card title="Node floor (read-only)">
          <p className="mb-3 text-sm text-slate-600 dark:text-slate-400">
            These controls are compiled into every node agent and enforced locally before any connection. The policy cannot
            change them; the server rejects any policy that tries.
          </p>
          <dl className="space-y-3 text-sm">
            <div><dt className="font-medium">Dialable ports</dt><dd className="text-slate-500">{FLOOR_PORTS.join(", ")} only</dd></div>
            <div><dt className="font-medium">Hard-denied ports</dt><dd className="text-slate-500">{HARD_DENY_PORTS.join(", ")}</dd></div>
            <div><dt className="font-medium">SSRF / private ranges</dt><dd className="text-slate-500">Private, loopback, link-local, CGNAT, metadata and IPv6-embedded IPv4 are always blocked, with DNS-rebinding checks.</dd></div>
            <div><dt className="font-medium">Compiled-in OFAC codes</dt><dd className="text-slate-500">{OFAC_CODES.join(", ")} — always sanctioned</dd></div>
          </dl>
        </Card>
      </div>

      <ConfirmDialog open={confirm} title={`Publish policy v${p.version + 1}?`} confirmLabel="Publish"
        description="Nodes and gateways pick up the new version on their next policy fetch."
        onClose={() => setConfirm(false)}
        onConfirm={async () => {
          try {
            const r = await adminApi.publishPolicy(buildPolicy(form, p.body));
            setConfirm(false);
            setError(null);
            setDetails([]);
            setSaved(`Published version ${r.version}${r.attestationRaised ? " (attestation raised — nodes must re-attest)" : ""}.`);
            pol.refetch();
          } catch (e) {
            setConfirm(false);
            setSaved(null);
            setError(e instanceof Error ? e.message : "Publish failed");
            setDetails(e instanceof ApiError ? e.details : []);
          }
        }} />
    </div>
  );
}
