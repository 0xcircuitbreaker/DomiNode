import { NODE_IMAGE } from "../../landing/site";
import { Card, Code, Hero, LivePolicy, LivePricing, Pre, PublicLayout, Section, link, usePageTitle } from "../../site/components";

/** Tier table text from docs/agent-network/ECONOMICS.md §2; live shares come from /v1/pricing below. */
const TIERS: Array<[string, string, string, string, string]> = [
  ["Probation", "25%", "0 days", "≥1", "14 d"],
  ["Bronze", "30%", "≥7 days", "≥1", "7 d"],
  ["Silver", "35%", "≥30 days", "≥3", "7 d"],
  ["Gold", "40%", "≥60 days", "≥10", "5 d"],
  ["Platinum", "45%", "≥90 days", "≥25", "3 d"],
  ["Partner", "50%", "≥180 days", "≥50", "3 d"],
];

export default function RunNodePage() {
  usePageTitle("Run a node · DominusNode");
  return (
    <PublicLayout>
      <Hero eyebrow="Run a node" title="Contribute an IP. Earn from paid traffic.">
        <p>The node agent is a small container that dials out to the gateway over a pinned TLS tunnel and serves floor-checked TCP streams. No inbound ports, no payload logging, and caps you control.</p>
      </Hero>

      <Section id="setup" eyebrow="01 / Setup" title="Register once, then run">
        <p className="mb-4 text-sm text-ddg-text-2">Image: <Code>{NODE_IMAGE}</Code> (linux/amd64 and linux/arm64, Raspberry Pi 4/5). Coordinator pins are baked in.</p>
        <Pre label="Register">{`sudo install -d -o 1001 -g 1001 -m 700 /etc/dominusnode
sudo install -o 1001 -g 1001 -m 600 ./wallet.key /etc/dominusnode/wallet.key
read -rs DN_API_KEY && export DN_API_KEY          # never on the command line
docker run --rm -it -e DN_API_KEY -e DN_WALLET_KEY_FILE=/run/dominusnode/wallet.key \\
  -v /etc/dominusnode:/run/dominusnode ${NODE_IMAGE} register
sudo rm /etc/dominusnode/wallet.key               # not needed after registration`}</Pre>
        <div className="mt-4"><Pre label="Run">{`docker run -d --name dominusnode-node --restart unless-stopped \\
  -e DN_NODE_GB_PER_DAY=2 -e DN_NODE_MAX_STREAMS=8 -e DN_NODE_MAX_MBPS=10 -e DN_NODE_REQ_PER_SEC=5 \\
  -v /etc/dominusnode/node.json:/run/dominusnode/node.json:ro \\
  ${NODE_IMAGE}`}</Pre></div>
        <p className="mt-3 text-sm text-ddg-text-2"><Code>register</Code> refuses if the server's attestation text differs from the one it builds locally, before anything is signed.</p>
      </Section>

      <Section id="attestation" eyebrow="02 / Consent" title="Signed attestation">
        <div className="grid gap-4 md:grid-cols-2">
          <Card title="What you sign"><p>An EIP-191 statement from your owner wallet: you control this connection, you accept relaying under the published policy version, and you can stop at any time. A new policy that raises the attestation asks you to sign again.</p></Card>
          <Card title="What is shared"><p>Your exit IP class and country with buyers; destination host, bytes and time with the operator's metadata-only abuse log. Never payloads, never full URLs.</p></Card>
        </div>
      </Section>

      <Section id="floor" eyebrow="03 / Safety floor and caps" title="Stricter, never looser">
        <div className="grid gap-4 md:grid-cols-2">
          <Card title="Non-disableable floor"><p>Ports 80/443 only. Never private, loopback, link-local, CGNAT or metadata ranges, re-checked after DNS and after connect. SMTP, SSH and RDP blocked. OFAC countries refused.</p></Card>
          <Card title="Your caps"><p><Code>DN_NODE_GB_PER_DAY</Code>, <Code>DN_NODE_MAX_STREAMS</Code>, <Code>DN_NODE_MAX_MBPS</Code>, <Code>DN_NODE_REQ_PER_SEC</Code>, <Code>DN_NODE_PORTS</Code>, <Code>DN_NODE_DENY_DOMAINS</Code>. Start low on home lines and raise after a week.</p></Card>
        </div>
        <div className="mt-6 border border-white/10 p-5"><h3 className="ddg-label mb-3">Current policy</h3><LivePolicy /></div>
      </Section>

      <Section id="earnings" eyebrow="04 / Earnings" title="Tiers: 25% to 50% of every paid GB">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <caption className="pb-2 text-left text-xs text-ddg-muted">Design targets from ECONOMICS.md; the operator tunes them, the live table below is authoritative.</caption>
            <thead><tr className="text-left font-mono text-[11px] uppercase tracking-[0.14em] text-ddg-muted"><th className="py-1 pr-4">Tier</th><th className="pr-4">Node share</th><th className="pr-4">Paid tenure</th><th className="pr-4">Active IPs</th><th>Maturity hold</th></tr></thead>
            <tbody>{TIERS.map((t) => <tr key={t[0]} className="border-t border-white/10">{t.map((c, i) => <td key={i} className="py-1.5 pr-4">{c}</td>)}</tr>)}</tbody>
          </table>
        </div>
        <p className="mt-3 text-sm text-ddg-text-2">Share is snapshotted at session start. Only matured, undisputed traffic from other principals counts; self-dealing earns nothing. Tiers also need uptime and reputation; a clawback drops you to Probation.</p>
        <div className="mt-6"><h3 className="ddg-label mb-3">Live tiers</h3><LivePricing showRails={false} /></div>
        <p className="mt-4 text-sm text-ddg-text-2">Full detail: <a className={link} href="/docs/nodes.md">nodes.md</a>.</p>
      </Section>
    </PublicLayout>
  );
}
