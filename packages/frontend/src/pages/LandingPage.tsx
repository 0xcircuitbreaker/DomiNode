import { QUICKSTART_DOC_URL, QUICKSTART_STEPS } from "../landing/quickstart";
import { ABUSE_URL, API_BASE, HISTORY_URL, STATUS_URL } from "../landing/site";
import {
  Button, Card, Code, Hero, LivePolicy, LivePricing, LiveStats, Pre, PublicLayout, Quickstarts, Section, link, usePageTitle,
} from "../site/components";

export default function LandingPage() {
  usePageTitle("DominusNode: the relay network for AI agents");
  return (
    <PublicLayout>
      <Hero eyebrow="Alpha · built for AI agents only" title="A decentralized relay network, run by agents, for agents.">
        <p>
          DominusNode lets AI agents route HTTP, HTTPS and SOCKS5 traffic through residential, mobile and datacenter IPs that
          other agents contribute. Buyers pay per request or from a prepaid wallet. Contributors earn a share of every paid byte
          that leaves through their IP. There is no third-party IP upstream: every exit is a node run by an agent.
        </p>
        <div className="flex flex-wrap gap-3 pt-2">
          <Button to="/quickstart" primary>Agent quickstart</Button>
          <Button to="/run-a-node">Run a node</Button>
          <Button to="/llms.txt">llms.txt</Button>
        </div>
      </Hero>
      <Pre label="Traffic path">{`agent ──HTTP/CONNECT/SOCKS5──▶ gateway ──wss tunnel (TLS 1.3, pinned)──▶ node-agent ──▶ target
      (API key or x402/MPP)     meters bytes, picks node,              SSRF floor, ports,
                                settles the split                      operator caps`}</Pre>

      <Section id="five-minutes" eyebrow="00 / Five minutes" title="Zero to a first relayed request">
        <ol className="grid gap-4 md:grid-cols-3">
          {QUICKSTART_STEPS.map((s) => (
            <li key={s.minute}>
              <Card title={`Minute ${s.minute}: ${s.title}`}>
                <p>{s.text}</p>
                {s.code && <pre className="mt-3 overflow-x-auto text-xs"><code>{s.code}</code></pre>}
              </Card>
            </li>
          ))}
        </ol>
        <p className="mt-3 text-sm text-ddg-text-2">Full path and a one-command smoke check: <a className={link} href={QUICKSTART_DOC_URL}>QUICKSTART.md</a>.</p>
      </Section>

      <Section id="buy" eyebrow="01 / For agents that buy" title="Fetch through real IPs, pay per request or prepaid">
        <div className="grid gap-4 md:grid-cols-3">
          <Card title="No signup: x402 and MPP">
            <p>Send a request without credentials and the gateway answers <Code>402</Code> with payment requirements. Pay with an x402 or MPP (Tempo) client and retry with the proof. The paid amount caps that request's bytes.</p>
          </Card>
          <Card title="Prepaid wallet">
            <p>Sign in with a wallet signature, get a <Code>dn_live_</Code> API key, and top up with crypto (Tempo or NOWPayments). Usage is billed per GB at the live price for the exit's IP class.</p>
          </Card>
          <Card title="Three ways in">
            <p>The <strong>MCP server</strong> for Claude, Cursor and other MCP clients; <strong>six SDKs</strong> (Node, Python, Go, Rust, Java, C++); or the raw <strong>proxy</strong>: TLS (HTTPS) proxy <Code>:8443</Code>; plaintext <Code>:8080</Code>/<Code>:1080</Code> only on a local gateway.</p>
          </Card>
        </div>
        <div className="mt-6 border border-white/10 p-5 text-sm">
          <p className="font-semibold">Routing flags go in the proxy username, the key in the password:</p>
          <ul className="mt-3 grid gap-2 sm:grid-cols-2 text-ddg-text-2">
            <li><Code>country-XX</Code> exit country (OFAC countries refused)</li>
            <li><Code>class-residential|dc|mobile</Code> IP class</li>
            <li><Code>session-&lt;id&gt;</Code> sticky exit</li>
            <li><Code>allowhttp-1</Code> allow plaintext HTTP (the exit can read it)</li>
          </ul>
          <p className="mt-3 text-ddg-muted">No flags? Use <Code>relay</Code>. Example: <Code>country-US-class-residential</Code>.</p>
        </div>
      </Section>

      <Section id="earn" eyebrow="02 / For agents that earn" title="Contribute an IP, earn from paid traffic">
        <div className="grid gap-4 md:grid-cols-3">
          <Card title="Run the node agent"><p>Register with a signed consent attestation, then run the node image on a connection you control. It dials out to the gateway: no inbound ports. <a className={link} href="/run-a-node">Setup guide</a>.</p></Card>
          <Card title="Tiers: Probation → Partner"><p>Your node share rises from 25% at Probation to 50% at Partner, and your own purchases get a tier discount. Only matured, undisputed paid traffic from other principals counts.</p></Card>
          <Card title="Maturity holds and payouts"><p>Earnings are held 3–14 days by tier so fraud can be clawed back, then become available credit. USDC payouts on Base stay off until the operator enables them (<Code>PAYOUTS_DISABLED</Code>).</p></Card>
        </div>
      </Section>

      <Section id="live" eyebrow="03 / Live from the public API" title="Pricing and network right now">
        <p className="mb-6 text-sm text-ddg-text-2">Prices are set by the operator and published at <Code>/v1/pricing</Code>; nothing on this page is hardcoded. Fetched from <Code>{API_BASE}</Code>.</p>
        <div className="grid gap-8 lg:grid-cols-2">
          <div><h3 className="ddg-label mb-3">Pricing</h3><LivePricing /></div>
          <div><h3 className="ddg-label mb-3">Network</h3><LiveStats /></div>
        </div>
      </Section>

      <Section id="safety" eyebrow="04 / Safety and trust" title="A floor nobody can switch off">
        <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
          <Card title="Non-disableable node floor"><p>Only ports 80/443, never private, loopback, link-local, CGNAT or cloud-metadata ranges, re-checked after DNS and after connect. Contributors can make it stricter, never looser.</p></Card>
          <Card title="No payload logging"><p>The abuse log stores metadata only (time, requester, node, destination host, bytes), never payloads or full URLs.</p></Card>
          <Card title="Sanctions"><p>No nodes from, and no routing to, Cuba, Iran, North Korea, Russia or Syria. Payout wallets are screened against the OFAC SDN list, failing closed.</p></Card>
          <Card title="Abuse controls"><p>Port policy blocks SMTP, SSH and RDP. A destination denylist, per-node and per-requester rate caps, and burn-report reputation protect contributors' IPs.</p></Card>
          <Card title="Consent-only supply"><p>Every node signs an attestation that its operator controls the connection and accepts relaying. No SDK-bundled or hidden supply.</p></Card>
          <Card title="Untrusted exits"><p>Only the gateway counts billable bytes. HTTPS is end-to-end, and plaintext needs an explicit opt-in because the exit can read it.</p></Card>
        </div>
        <div className="mt-6 border border-white/10 p-5">
          <h3 className="ddg-label mb-3">Current policy</h3>
          <LivePolicy />
        </div>
        <p className="mt-4 text-sm text-ddg-text-2">Seen abuse from a DominusNode exit? <a className={link} href={ABUSE_URL}>Report it</a>, no account needed. Network health: <a className={link} href={STATUS_URL}>status page</a> and <a className={link} href={HISTORY_URL}>hourly history</a>.</p>
      </Section>

      <Section id="integrations" eyebrow="05 / Integrate" title="MCP, six SDKs, 27 frameworks">
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          <Card title="MCP server"><p>65 tools (plus bootstrap tools without a key) for relay fetch, nodes, earnings and wallets.</p></Card>
          <Card title="SDKs v2"><p>One contract across six languages: SSRF and DNS-rebinding checks, no redirects, 10 MB cap, credential scrubbing.</p></Card>
          <Card title="27 frameworks"><p>LangChain, CrewAI, LlamaIndex, Vercel AI, Mastra, n8n and more, each with the same 19-tool set.</p></Card>
          <Card title="Self-host"><p>Run your own coordinator with one command and federate. <a className={link} href="/self-host">How</a>.</p></Card>
        </div>
        <div className="mt-6"><Quickstarts /></div>
        <p className="mt-3 text-xs text-ddg-muted">Keys shown are placeholders. Keep real keys in environment variables, never in prompts or tool arguments.</p>
      </Section>
    </PublicLayout>
  );
}
