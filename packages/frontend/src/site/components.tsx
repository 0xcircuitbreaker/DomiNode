import { useEffect, useState, type ReactNode } from "react";
import { NavLink } from "react-router-dom";
import { DdgEffects } from "../ddg";
import { SNIPPETS, type Snippet } from "../landing/snippets";
import {
  ABUSE_URL, API_BASE, API_LLMS_URL, CONTACT_EMAIL, DDG_URL, DOCS_URL, GITHUB_URL, PUBLIC_ORIGIN, STATUS_URL,
} from "../landing/site";
import { bpsToPct, isPolicy, isPricing, isStats, musdToUsd, usePublic } from "../landing/publicApi";

/* ─── Layout ─────────────────────────────────────────────────────────── */

export const PUBLIC_NAV = [
  ["/", "Overview"],
  ["/quickstart", "Agent quickstart"],
  ["/run-a-node", "Run a node"],
  ["/self-host", "Self-host"],
  ["/pricing", "Pricing"],
] as const;

export const link = "text-ddg-gold underline decoration-ddg-gold/40 underline-offset-2 hover:text-ddg-gold-light";

export function usePageTitle(title: string) {
  useEffect(() => { document.title = title; }, [title]);
}

export function PublicLayout({ children }: { children: ReactNode }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="ddg relative min-h-screen bg-ddg-deep text-ddg-text antialiased">
      <DdgEffects />
      <a href="#main" className="sr-only focus:not-sr-only focus:absolute focus:left-2 focus:top-2 focus:z-50 focus:bg-ddg-gold focus:px-3 focus:py-2 focus:text-ddg-deep">Skip to content</a>
      <header className="sticky top-0 z-20 border-b border-white/10 bg-ddg-deep/90 backdrop-blur">
        <div className="mx-auto flex max-w-6xl items-center justify-between gap-3 px-4 py-3">
          <NavLink to="/" className="flex items-center gap-2 font-semibold tracking-tight">
            <img src="/logo.svg" alt="" width={26} height={26} />
            <span>DominusNode</span>
            <span className="ddg-label hidden sm:inline">/ relay for agents</span>
          </NavLink>
          <nav aria-label="Site" className="hidden md:flex gap-6 font-mono text-[11px] uppercase tracking-[0.16em] text-ddg-text-2">
            {PUBLIC_NAV.map(([to, label]) => (
              <NavLink key={to} to={to} end={to === "/"} className={({ isActive }) => (isActive ? "text-ddg-gold" : "hover:text-ddg-text")}>{label}</NavLink>
            ))}
            <a href={STATUS_URL} className="hover:text-ddg-text">Status</a>
          </nav>
          <div className="flex items-center gap-3">
            <a href={GITHUB_URL} className="hidden sm:inline font-mono text-[11px] uppercase tracking-[0.16em] text-ddg-text-2 hover:text-ddg-gold">GitHub</a>
            <button type="button" className="md:hidden border border-white/15 px-2.5 py-1 font-mono text-xs" aria-expanded={open} aria-controls="mnav" onClick={() => setOpen((o) => !o)}>Menu</button>
          </div>
        </div>
        {open && (
          <nav id="mnav" aria-label="Site (mobile)" className="md:hidden border-t border-white/10 px-4 py-2">
            {PUBLIC_NAV.map(([to, label]) => (
              <NavLink key={to} to={to} end={to === "/"} onClick={() => setOpen(false)}
                className={({ isActive }) => `block py-2 font-mono text-xs uppercase tracking-[0.16em] ${isActive ? "text-ddg-gold" : "text-ddg-text-2"}`}>{label}</NavLink>
            ))}
            <a href={STATUS_URL} className="block py-2 font-mono text-xs uppercase tracking-[0.16em] text-ddg-text-2">Status</a>
          </nav>
        )}
      </header>
      <main id="main" className="relative z-[2] mx-auto max-w-6xl px-4">{children}</main>
      <Footer />
    </div>
  );
}

function Footer() {
  return (
    <footer className="relative z-[2] border-t border-white/10">
      <div className="mx-auto grid max-w-6xl gap-6 px-4 py-10 text-sm sm:grid-cols-2">
        <div>
          <p className="ddg-label">DominusNode</p>
          <p className="mt-2 text-ddg-text-2">A <a className={link} href={DDG_URL}>Daedalus Development Group</a> product. Open source under MIT.</p>
          <p className="mt-1 text-ddg-text-2">Contact: <a className={link} href={`mailto:${CONTACT_EMAIL}`}>{CONTACT_EMAIL}</a></p>
        </div>
        <nav aria-label="Footer" className="flex flex-wrap gap-x-5 gap-y-2 sm:justify-end text-ddg-text-2">
          {PUBLIC_NAV.slice(1).map(([to, label]) => <NavLink key={to} className={link} to={to}>{label}</NavLink>)}
          <a className={link} href={GITHUB_URL}>GitHub</a>
          <a className={link} href={DOCS_URL}>Docs</a>
          <a className={link} href="/llms.txt">llms.txt</a>
          <a className={link} href={API_LLMS_URL}>API llms.txt</a>
          <a className={link} href={STATUS_URL}>Status</a>
          <a className={link} href={ABUSE_URL}>Report abuse</a>
          <a className={link} href="/terms">Terms</a>
          <a className={link} href="/privacy">Privacy</a>
          <a className={link} href="/aup">AUP</a>
        </nav>
        <p className="sm:col-span-2 font-mono text-[11px] uppercase tracking-[0.16em] text-ddg-muted">{PUBLIC_ORIGIN.replace(/^https?:\/\//, "")} · agents only · humans administer</p>
      </div>
    </footer>
  );
}

/* ─── Primitives ─────────────────────────────────────────────────────── */

export function Hero({ eyebrow, title, children }: { eyebrow: string; title: ReactNode; children?: ReactNode }) {
  return (
    <section className="py-16 sm:py-24" aria-labelledby="hero-h">
      <p className="ddg-label">{eyebrow}</p>
      <h1 id="hero-h" className="mt-5 max-w-3xl text-4xl sm:text-6xl font-semibold tracking-tight leading-[1.05]">{title}</h1>
      {children && <div className="mt-6 max-w-2xl text-lg text-ddg-text-2 space-y-4">{children}</div>}
    </section>
  );
}

export function Section({ id, eyebrow, title, children }: { id: string; eyebrow: string; title: string; children: ReactNode }) {
  return (
    <section id={id} aria-labelledby={`${id}-h`} className="scroll-mt-20 py-14 sm:py-20 border-t border-white/10">
      <p className="ddg-label">{eyebrow}</p>
      <h2 id={`${id}-h`} className="mt-3 text-2xl sm:text-3xl font-semibold tracking-tight">{title}</h2>
      <div className="mt-6">{children}</div>
    </section>
  );
}

export function Card({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="border border-white/10 bg-ddg-surface/70 p-5">
      <h3 className="font-semibold text-lg">{title}</h3>
      <div className="mt-2 text-sm leading-relaxed text-ddg-text-2 space-y-2">{children}</div>
    </div>
  );
}

export const Code = ({ children }: { children: ReactNode }) => (
  <code className="[overflow-wrap:anywhere] bg-white/5 px-1.5 py-0.5 font-mono text-[0.85em] text-ddg-gold-light">{children}</code>
);

export function Pre({ children, label }: { children: string; label?: string }) {
  return (
    <pre aria-label={label} className="overflow-x-auto border border-white/10 bg-black/40 p-4 font-mono text-[11px] sm:text-xs leading-relaxed text-ddg-text">{children}</pre>
  );
}

export function Button({ to, children, primary }: { to: string; children: ReactNode; primary?: boolean }) {
  const cls = primary
    ? "border border-ddg-gold bg-ddg-gold px-5 py-3 font-mono text-xs uppercase tracking-[0.16em] text-ddg-deep hover:bg-ddg-gold-light"
    : "border border-white/20 px-5 py-3 font-mono text-xs uppercase tracking-[0.16em] hover:border-ddg-gold hover:text-ddg-gold";
  return to.startsWith("/") && !to.includes(".")
    ? <NavLink to={to} className={cls}>{children}</NavLink>
    : <a href={to} className={cls}>{children}</a>;
}

/* ─── Live data (public /v1, never hardcoded) ────────────────────────── */

export function Fallback({ what, path }: { what: string; path: string }) {
  return (
    <p className="text-sm text-ddg-text-2 [overflow-wrap:anywhere]" role="status">
      Live {what} is unavailable right now. Query <a className={link} href={`${API_BASE}${path}`}>{`GET ${path}`}</a> directly
      or ask the MCP server (<Code>dominusnode_network_{what === "pricing" ? "pricing" : what === "policy" ? "policy" : "stats"}</Code>).
    </p>
  );
}

const Muted = ({ children }: { children: ReactNode }) => <p className="text-sm text-ddg-muted" role="status">{children}</p>;

export function LivePricing({ showRails = true }: { showRails?: boolean }) {
  const p = usePublic("/v1/pricing", isPricing);
  if (p.state === "loading") return <Muted>Loading live pricing…</Muted>;
  if (p.state === "error") return <Fallback what="pricing" path="/v1/pricing" />;
  const { prices, nodeShare, rails } = p.data;
  const discounts = new Map((p.data.buyerDiscounts ?? []).map((d) => [d.tier, d.buyerDiscountBps]));
  const hasDiscount = discounts.size > 0;
  return (
    <div className="space-y-5" data-testid="live-pricing">
      <ul className="grid gap-3 sm:grid-cols-3">
        {prices.map((x) => (
          <li key={x.ipClass} className="border border-white/10 bg-ddg-surface/60 p-4">
            <p className="ddg-label !text-ddg-text-2">{x.ipClass} · list</p>
            <p className="mt-1 text-2xl font-semibold text-ddg-gold-light">{musdToUsd(x.pricePerGbMusd) ?? "?"}<span className="text-sm font-normal text-ddg-muted"> / GB</span></p>
          </li>
        ))}
      </ul>
      {nodeShare.length > 0 && (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <caption className="text-left text-xs text-ddg-muted pb-2">Contributor tiers (live): share of each paid GB they carry, and discount on what they buy</caption>
            <thead><tr className="text-left font-mono text-[11px] uppercase tracking-[0.14em] text-ddg-muted"><th className="py-1 pr-4">Tier</th><th className="py-1 pr-4">Node share</th>{hasDiscount && <th className="py-1">Buyer discount</th>}</tr></thead>
            <tbody>
              {[...nodeShare].sort((a, b) => a.rank - b.rank).map((t) => (
                <tr key={t.tier} className="border-t border-white/10">
                  <td className="py-1.5 pr-4 capitalize">{t.tier}</td>
                  <td className="py-1.5 pr-4">{bpsToPct(t.nodeShareBps)}</td>
                  {hasDiscount && <td className="py-1.5">{discounts.has(t.tier) ? bpsToPct(discounts.get(t.tier)!) : "—"}</td>}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {showRails && rails && rails.length > 0 && <p className="text-xs text-ddg-muted">Enabled payment rails: {rails.join(", ")}</p>}
    </div>
  );
}

export function LiveStats() {
  const s = usePublic("/v1/network/stats", isStats);
  if (s.state === "loading") return <Muted>Loading network stats…</Muted>;
  if (s.state === "error") return <Fallback what="stats" path="/v1/network/stats" />;
  const d = s.data;
  const tile = "border border-white/10 bg-ddg-surface/60 p-4";
  return (
    <dl className="grid grid-cols-2 gap-3 sm:grid-cols-4" data-testid="live-stats">
      <div className={tile}><dt className="ddg-label !text-ddg-text-2">Nodes online</dt><dd className="mt-1 text-2xl font-semibold text-ddg-gold-light">{d.onlineNodes}</dd></div>
      {Object.entries(d.byClass).slice(0, 3).map(([k, v]) => (
        <div key={k} className={tile}><dt className="ddg-label !text-ddg-text-2">{k}</dt><dd className="mt-1 text-2xl font-semibold">{v}</dd></div>
      ))}
      {d.byCountry.length > 0 && (
        <div className="col-span-2 sm:col-span-4 font-mono text-xs text-ddg-muted">
          Top countries: {d.byCountry.slice(0, 8).map((c) => `${c.country} ${c.online}`).join(" · ")}
          {d.otherCountries > 0 ? ` · other ${d.otherCountries}` : ""}
        </div>
      )}
    </dl>
  );
}

export function LivePolicy() {
  const p = usePublic("/v1/policy", isPolicy);
  if (p.state === "loading") return <Muted>Loading policy…</Muted>;
  if (p.state === "error") return <Fallback what="policy" path="/v1/policy" />;
  return (
    <div className="text-sm" data-testid="live-policy">
      <p className="text-ddg-text-2">Policy version <strong className="text-ddg-text">{p.data.version}</strong>, hash <Code>{p.data.sha256.slice(0, 12)}…</Code></p>
      {p.data.floorGuarantees && (
        <ul className="mt-3 list-disc pl-5 space-y-1 text-ddg-text-2">
          {p.data.floorGuarantees.slice(0, 10).map((g) => <li key={g}>{g}</li>)}
        </ul>
      )}
    </div>
  );
}

export function Quickstarts({ snippets = SNIPPETS }: { snippets?: Snippet[] }) {
  const [active, setActive] = useState(snippets[0]!.id);
  const [copied, setCopied] = useState(false);
  const s = snippets.find((x) => x.id === active) ?? snippets[0]!;
  const copy = async () => {
    try { await navigator.clipboard.writeText(s.code); setCopied(true); setTimeout(() => setCopied(false), 1500); } catch { /* clipboard blocked */ }
  };
  return (
    <div className="border border-white/10 bg-ddg-surface/70 overflow-hidden">
      <div role="tablist" aria-label="Quickstarts" className="flex flex-wrap gap-1 border-b border-white/10 p-2">
        {snippets.map((x) => (
          <button key={x.id} role="tab" type="button" aria-selected={x.id === active} aria-controls="qs-panel"
            onClick={() => setActive(x.id)}
            className={`px-3 py-1.5 font-mono text-[11px] uppercase tracking-[0.12em] ${x.id === active ? "bg-ddg-gold text-ddg-deep" : "text-ddg-text-2 hover:bg-white/5"}`}>
            {x.label}
          </button>
        ))}
      </div>
      <div id="qs-panel" role="tabpanel" className="relative">
        <button type="button" onClick={copy} className="absolute right-2 top-2 border border-white/20 bg-ddg-deep px-2 py-1 font-mono text-[11px] text-ddg-text">{copied ? "Copied" : "Copy"}</button>
        <pre className="overflow-x-auto bg-black/40 p-4 pr-16 font-mono text-xs leading-relaxed text-ddg-text"><code>{s.code}</code></pre>
      </div>
    </div>
  );
}
