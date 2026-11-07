import { useEffect, useState, type ReactNode } from "react";
import ThemeToggle from "../components/ThemeToggle";
import { SNIPPETS } from "../landing/snippets";
import {
  API_BASE, ABUSE_URL, API_LLMS_URL, DDG_URL, DOCS_URL, GITHUB_URL, HISTORY_URL, PUBLIC_ORIGIN, STATUS_URL,
} from "../landing/site";
import {
  bpsToPct, isPolicy, isPricing, isStats, musdToUsd, usePublic,
} from "../landing/publicApi";

const NAV = [
  ["#buy", "Buy"],
  ["#earn", "Earn"],
  ["#live", "Live network"],
  ["#safety", "Safety"],
  ["#integrations", "Integrate"],
] as const;

function Section({ id, eyebrow, title, children }: { id: string; eyebrow: string; title: string; children: ReactNode }) {
  return (
    <section id={id} aria-labelledby={`${id}-h`} className="scroll-mt-20 py-14 sm:py-20 border-t border-slate-200 dark:border-slate-800">
      <p className="text-xs font-bold uppercase tracking-widest text-teal-700 dark:text-teal-400">{eyebrow}</p>
      <h2 id={`${id}-h`} className="mt-2 text-2xl sm:text-3xl font-extrabold tracking-tight">{title}</h2>
      <div className="mt-6">{children}</div>
    </section>
  );
}

function Card({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm dark:border-slate-800 dark:bg-slate-900/70">
      <h3 className="font-bold text-lg">{title}</h3>
      <div className="mt-2 text-sm leading-relaxed text-slate-600 dark:text-slate-300 space-y-2">{children}</div>
    </div>
  );
}

const Code = ({ children }: { children: ReactNode }) => (
  <code className="[overflow-wrap:anywhere] rounded bg-slate-100 px-1.5 py-0.5 font-mono text-[0.85em] text-slate-800 dark:bg-slate-800 dark:text-slate-100">{children}</code>
);

function Fallback({ what, path }: { what: string; path: string }) {
  return (
    <p className="text-sm text-slate-600 dark:text-slate-400 [overflow-wrap:anywhere]" role="status">
      Live {what} is unavailable right now. Query <a className="underline" href={`${API_BASE}${path}`}>{`GET ${path}`}</a> directly
      or ask the MCP server (<Code>dominusnode_network_{what === "pricing" ? "pricing" : what === "policy" ? "policy" : "stats"}</Code>).
    </p>
  );
}

function LivePricing() {
  const p = usePublic("/v1/pricing", isPricing);
  if (p.state === "loading") return <p className="text-sm text-slate-500" role="status">Loading live pricing…</p>;
  if (p.state === "error") return <Fallback what="pricing" path="/v1/pricing" />;
  const { prices, nodeShare, rails } = p.data;
  const discounts = new Map((p.data.buyerDiscounts ?? []).map((d) => [d.tier, d.buyerDiscountBps]));
  const hasDiscount = discounts.size > 0;
  return (
    <div className="space-y-5" data-testid="live-pricing">
      <ul className="grid gap-3 sm:grid-cols-3">
        {prices.map((x) => (
          <li key={x.ipClass} className="rounded-xl border border-slate-200 p-4 dark:border-slate-800">
            <p className="text-xs uppercase tracking-wide text-slate-500">{x.ipClass} · list</p>
            <p className="text-2xl font-extrabold">{musdToUsd(x.pricePerGbMusd) ?? "?"}<span className="text-sm font-medium text-slate-500"> / GB</span></p>
          </li>
        ))}
      </ul>
      {nodeShare.length > 0 && (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <caption className="text-left text-xs text-slate-500 pb-2">Contributor tiers (live): share of each paid GB they carry, and discount on what they buy</caption>
            <thead><tr className="text-left text-slate-500"><th className="py-1 pr-4">Tier</th><th className="py-1 pr-4">Node share</th>{hasDiscount && <th className="py-1">Buyer discount</th>}</tr></thead>
            <tbody>
              {[...nodeShare].sort((a, b) => a.rank - b.rank).map((t) => (
                <tr key={t.tier} className="border-t border-slate-200 dark:border-slate-800">
                  <td className="py-1.5 pr-4 capitalize">{t.tier}</td>
                  <td className="py-1.5 pr-4">{bpsToPct(t.nodeShareBps)}</td>
                  {hasDiscount && <td className="py-1.5">{discounts.has(t.tier) ? bpsToPct(discounts.get(t.tier)!) : "—"}</td>}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {rails && rails.length > 0 && <p className="text-xs text-slate-500">Enabled payment rails: {rails.join(", ")}</p>}
    </div>
  );
}

function LiveStats() {
  const s = usePublic("/v1/network/stats", isStats);
  if (s.state === "loading") return <p className="text-sm text-slate-500" role="status">Loading network stats…</p>;
  if (s.state === "error") return <Fallback what="stats" path="/v1/network/stats" />;
  const d = s.data;
  return (
    <dl className="grid grid-cols-2 gap-3 sm:grid-cols-4" data-testid="live-stats">
      <div className="rounded-xl border border-slate-200 p-4 dark:border-slate-800"><dt className="text-xs text-slate-500">Nodes online</dt><dd className="text-2xl font-extrabold">{d.onlineNodes}</dd></div>
      {Object.entries(d.byClass).slice(0, 3).map(([k, v]) => (
        <div key={k} className="rounded-xl border border-slate-200 p-4 dark:border-slate-800"><dt className="text-xs text-slate-500">{k}</dt><dd className="text-2xl font-extrabold">{v}</dd></div>
      ))}
      {d.byCountry.length > 0 && (
        <div className="col-span-2 sm:col-span-4 text-xs text-slate-500">
          Top countries: {d.byCountry.slice(0, 8).map((c) => `${c.country} ${c.online}`).join(" · ")}
          {d.otherCountries > 0 ? ` · other ${d.otherCountries}` : ""}
        </div>
      )}
    </dl>
  );
}

function LivePolicy() {
  const p = usePublic("/v1/policy", isPolicy);
  if (p.state === "loading") return <p className="text-sm text-slate-500" role="status">Loading policy…</p>;
  if (p.state === "error") return <Fallback what="policy" path="/v1/policy" />;
  return (
    <div className="text-sm" data-testid="live-policy">
      <p className="text-slate-600 dark:text-slate-300">Policy version <strong>{p.data.version}</strong>, hash <Code>{p.data.sha256.slice(0, 12)}…</Code></p>
      {p.data.floorGuarantees && (
        <ul className="mt-3 list-disc pl-5 space-y-1 text-slate-600 dark:text-slate-300">
          {p.data.floorGuarantees.slice(0, 10).map((g) => <li key={g}>{g}</li>)}
        </ul>
      )}
    </div>
  );
}

function Quickstarts() {
  const [active, setActive] = useState(SNIPPETS[0]!.id);
  const [copied, setCopied] = useState(false);
  const s = SNIPPETS.find((x) => x.id === active) ?? SNIPPETS[0]!;
  const copy = async () => {
    try { await navigator.clipboard.writeText(s.code); setCopied(true); setTimeout(() => setCopied(false), 1500); } catch { /* clipboard blocked */ }
  };
  return (
    <div className="rounded-2xl border border-slate-200 bg-white dark:border-slate-800 dark:bg-slate-900/70 overflow-hidden">
      <div role="tablist" aria-label="Quickstarts" className="flex flex-wrap gap-1 border-b border-slate-200 p-2 dark:border-slate-800">
        {SNIPPETS.map((x) => (
          <button key={x.id} role="tab" type="button" aria-selected={x.id === active} aria-controls="qs-panel"
            onClick={() => setActive(x.id)}
            className={`rounded-lg px-3 py-1.5 text-xs font-semibold ${x.id === active ? "bg-teal-600 text-white" : "text-slate-600 hover:bg-slate-100 dark:text-slate-300 dark:hover:bg-slate-800"}`}>
            {x.label}
          </button>
        ))}
      </div>
      <div id="qs-panel" role="tabpanel" className="relative">
        <button type="button" onClick={copy} className="absolute right-2 top-2 rounded-md border border-slate-600 bg-slate-800 px-2 py-1 text-xs text-slate-100">{copied ? "Copied" : "Copy"}</button>
        <pre className="overflow-x-auto bg-slate-950 p-4 pr-16 text-xs leading-relaxed text-slate-100"><code>{s.code}</code></pre>
      </div>
    </div>
  );
}

export default function LandingPage() {
  useEffect(() => { document.title = "DominusNode: the relay network for AI agents"; }, []);
  const link = "underline decoration-teal-500/60 underline-offset-2 hover:text-teal-700 dark:hover:text-teal-300";
  return (
    <div className="min-h-screen bg-slate-50 text-slate-900 dark:bg-slate-950 dark:text-slate-100">
      <a href="#main" className="sr-only focus:not-sr-only focus:absolute focus:left-2 focus:top-2 focus:rounded focus:bg-teal-600 focus:px-3 focus:py-2 focus:text-white">Skip to content</a>
      <header className="sticky top-0 z-20 border-b border-slate-200 bg-slate-50/90 backdrop-blur dark:border-slate-800 dark:bg-slate-950/90">
        <div className="mx-auto flex max-w-6xl items-center justify-between gap-3 px-4 py-3">
          <a href="/" className="flex items-center gap-2 font-extrabold tracking-tight">
            <img src="/logo.svg" alt="" width={28} height={28} />
            <span>DominusNode</span>
          </a>
          <nav aria-label="Sections" className="hidden md:flex gap-5 text-sm font-semibold text-slate-600 dark:text-slate-300">
            {NAV.map(([href, label]) => <a key={href} href={href} className="hover:text-teal-700 dark:hover:text-teal-300">{label}</a>)}
          </nav>
          <div className="flex items-center gap-2">
            <a href={GITHUB_URL} className="hidden sm:inline text-sm font-semibold text-slate-600 hover:text-teal-700 dark:text-slate-300">GitHub</a>
            <ThemeToggle compact />
          </div>
        </div>
      </header>

      <main id="main" className="mx-auto max-w-6xl px-4">
        <section className="py-16 sm:py-24" aria-labelledby="hero-h">
          <p className="inline-block rounded-full border border-teal-600/40 px-3 py-1 text-xs font-semibold text-teal-700 dark:text-teal-300">Alpha · built for AI agents only</p>
          <h1 id="hero-h" className="mt-5 max-w-3xl text-4xl sm:text-6xl font-extrabold tracking-tight leading-[1.05]">
            A decentralized relay network, run by agents, for agents.
          </h1>
          <p className="mt-6 max-w-2xl text-lg text-slate-600 dark:text-slate-300">
            DominusNode lets AI agents route HTTP, HTTPS and SOCKS5 traffic through residential, mobile and datacenter IPs that
            other agents contribute. Buyers pay per request or from a prepaid wallet. Contributors earn a share of every paid byte
            that leaves through their IP. There is no third-party IP upstream: every exit is a node run by an agent.
          </p>
          <div className="mt-8 flex flex-wrap gap-3">
            <a href="#integrations" className="rounded-xl bg-teal-600 px-5 py-3 text-sm font-bold text-white hover:bg-teal-700">Agent quickstart</a>
            <a href="/llms.txt" className="rounded-xl border border-slate-300 px-5 py-3 text-sm font-bold hover:bg-slate-100 dark:border-slate-700 dark:hover:bg-slate-900">llms.txt</a>
            <a href={DOCS_URL} className="rounded-xl border border-slate-300 px-5 py-3 text-sm font-bold hover:bg-slate-100 dark:border-slate-700 dark:hover:bg-slate-900">Docs</a>
          </div>
          <pre aria-label="Traffic path" className="mt-10 overflow-x-auto rounded-xl bg-slate-950 p-4 text-[11px] sm:text-xs text-teal-200">{`agent ──HTTP/CONNECT/SOCKS5──▶ gateway ──wss tunnel (TLS 1.3, pinned)──▶ node-agent ──▶ target
      (API key or x402/MPP)     meters bytes, picks node,              SSRF floor, ports,
                                settles the split                      operator caps`}</pre>
        </section>

        <Section id="buy" eyebrow="For agents that buy" title="Fetch through real IPs, pay per request or prepaid">
          <div className="grid gap-4 md:grid-cols-3">
            <Card title="No signup: x402 and MPP">
              <p>Send a request without credentials and the gateway answers <Code>402</Code> with payment requirements. Pay with an x402 or MPP (Tempo) client and retry with the proof. No account is needed; the paid amount caps that request's bytes.</p>
            </Card>
            <Card title="Prepaid wallet">
              <p>Sign in with a wallet signature, get a <Code>dn_live_</Code> API key, and top up with crypto (Tempo or NOWPayments). Usage is billed per GB at the live price for the exit's IP class, minus your tier discount if you run a node.</p>
            </Card>
            <Card title="One gateway, three protocols">
              <p>HTTP proxy on <Code>:8080</Code>, SOCKS5 on <Code>:1080</Code>, and a TLS proxy listener so credentials never cross the wire in clear. HTTPS stays end-to-end TLS between you and the origin.</p>
            </Card>
          </div>
          <div className="mt-6 rounded-2xl border border-slate-200 p-5 text-sm dark:border-slate-800">
            <p className="font-semibold">Routing flags go in the proxy username, the key in the password:</p>
            <ul className="mt-3 grid gap-2 sm:grid-cols-2 text-slate-600 dark:text-slate-300">
              <li><Code>country-XX</Code> exit country (OFAC countries refused)</li>
              <li><Code>class-residential|dc|mobile</Code> IP class</li>
              <li><Code>session-&lt;id&gt;</Code> sticky exit</li>
              <li><Code>allowhttp-1</Code> allow plaintext HTTP (the exit can read it)</li>
            </ul>
            <p className="mt-3 text-slate-600 dark:text-slate-400">No flags? Use <Code>relay</Code>. Example: <Code>country-US-class-residential</Code>.</p>
          </div>
        </Section>

        <Section id="earn" eyebrow="For agents that earn" title="Contribute an IP, earn from paid traffic">
          <div className="grid gap-4 md:grid-cols-3">
            <Card title="Run the node agent">
              <p>Register with a signed consent attestation, then run <Code>node-agent</Code> on the connection you control. It dials out to the gateway, so no inbound ports are opened.</p>
            </Card>
            <Card title="Tiers: Probation → Partner">
              <p>Contribute IPs to climb tiers: earn more and buy cheaper. Your node share rises from 25% at Probation to 50% at Partner, and your own relay purchases get 0% up to 25% off list price. Tiers follow paid tenure, uptime, active IPs and reputation.</p>
              <p>Only matured, undisputed paid traffic from other principals counts. Self-dealing earns nothing.</p>
            </Card>
            <Card title="Maturity holds and payouts">
              <p>Earnings are held 3–14 days depending on tier so fraud can be clawed back, then become available credit.</p>
              <p>Today, available credit converts into bandwidth on your own wallet. USDC withdrawals on Base are built but stay off until the operator enables payouts; until then the API answers <Code>PAYOUTS_DISABLED</Code>.</p>
            </Card>
          </div>
        </Section>

        <Section id="live" eyebrow="Live from the public API" title="Pricing and network right now">
          <p className="mb-6 text-sm text-slate-600 dark:text-slate-400">Prices are set by the operator and published at <Code>/v1/pricing</Code>; nothing on this page is hardcoded. Fetched from <Code>{API_BASE}</Code>.</p>
          <div className="grid gap-8 lg:grid-cols-2">
            <div><h3 className="mb-3 font-bold">Pricing</h3><LivePricing /></div>
            <div><h3 className="mb-3 font-bold">Network</h3><LiveStats /></div>
          </div>
        </Section>

        <Section id="safety" eyebrow="Safety and trust" title="A floor nobody can switch off">
          <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
            <Card title="Non-disableable node floor"><p>Inside the node agent: only ports 80/443, never private, loopback, link-local, CGNAT or cloud-metadata ranges, re-checked after DNS and after connect. Contributors can make it stricter, never looser. Not even the operator can turn it off.</p></Card>
            <Card title="No payload logging"><p>The abuse log stores metadata only (time, requester, node, destination host, bytes), never payloads or full URLs, for a fixed retention window.</p></Card>
            <Card title="Sanctions"><p>No nodes from, and no routing to, Cuba, Iran, North Korea, Russia or Syria. Payout wallets are screened against the OFAC SDN list, failing closed.</p></Card>
            <Card title="Abuse controls"><p>Port policy blocks SMTP, SSH and RDP. A destination denylist, per-node and per-requester rate caps, and burn-report reputation protect contributors' IPs.</p></Card>
            <Card title="Consent-only supply"><p>Every node signs an attestation that its operator controls the connection and accepts relaying. There is no SDK-bundled or hidden supply.</p></Card>
            <Card title="Untrusted exits"><p>Only the gateway counts billable bytes. HTTPS is end-to-end, and plaintext needs an explicit opt-in because the exit can read it.</p></Card>
          </div>
          <div className="mt-6 rounded-2xl border border-slate-200 p-5 dark:border-slate-800">
            <h3 className="mb-3 font-bold">Current policy</h3>
            <LivePolicy />
          </div>
          <p className="mt-4 text-sm text-slate-600 dark:text-slate-400">Seen abuse from a DominusNode exit? <a className={link} href={ABUSE_URL}>Report it</a> with the target host and time window, no account needed. The metadata log lets the operator trace and suspend the requesting agent. Network health: <a className={link} href={STATUS_URL}>status page</a> and <a className={link} href={HISTORY_URL}>hourly history</a>.</p>
        </Section>

        <Section id="integrations" eyebrow="Integrate" title="MCP, six SDKs, 27 frameworks">
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            <Card title="MCP server"><p>65 tools (plus 11 bootstrap tools without a key) for relay fetch, nodes, earnings and wallets. Works in Claude, Cursor, VS Code, Gemini CLI, Codex CLI and others.</p></Card>
            <Card title="SDKs v2"><p>Node.js, Python, Go, Rust, Java and C++, all on one contract: SSRF and DNS-rebinding checks, no redirects, 10 MB cap, credential scrubbing.</p></Card>
            <Card title="27 frameworks"><p>LangChain, CrewAI, LlamaIndex, Vercel AI, Mastra, n8n and more, each with the same 19-tool set.</p></Card>
            <Card title="Browser extension"><p>An MV3 companion that routes an agent's (usually headless) Chromium profile through the gateway over TLS, with a per-run spend cap.</p></Card>
          </div>
          <div className="mt-6"><Quickstarts /></div>
          <p className="mt-3 text-xs text-slate-500">Keys shown are placeholders. Keep real keys in environment variables, never in prompts or tool arguments.</p>
        </Section>
      </main>

      <footer className="border-t border-slate-200 dark:border-slate-800">
        <div className="mx-auto grid max-w-6xl gap-6 px-4 py-10 text-sm sm:grid-cols-2">
          <div>
            <p className="font-bold">DominusNode</p>
            <p className="mt-1 text-slate-600 dark:text-slate-400">A <a className={link} href={DDG_URL}>Daedalus Development Group</a> product. Open source under MIT.</p>
          </div>
          <nav aria-label="Footer" className="flex flex-wrap gap-x-5 gap-y-2 sm:justify-end text-slate-600 dark:text-slate-300">
            <a className={link} href={GITHUB_URL}>GitHub</a>
            <a className={link} href={DOCS_URL}>Docs</a>
            <a className={link} href="/llms.txt">llms.txt</a>
            <a className={link} href={API_LLMS_URL}>API llms.txt</a>
            <a className={link} href={STATUS_URL}>API status</a>
            <a className={link} href={ABUSE_URL}>Report abuse</a>
            <a className={link} href="/terms">Terms</a>
            <a className={link} href="/privacy">Privacy</a>
            <a className={link} href="/aup">AUP</a>
          </nav>
          <p className="sm:col-span-2 text-xs text-slate-500">{PUBLIC_ORIGIN.replace(/^https?:\/\//, "")}</p>
        </div>
      </footer>
    </div>
  );
}
