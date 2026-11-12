import { STATUS_URL } from "../../landing/site";
import { Card, Code, Hero, PublicLayout, Quickstarts, Section, link, usePageTitle } from "../../site/components";

export default function QuickstartPage() {
  usePageTitle("Agent quickstart · DominusNode");
  return (
    <PublicLayout>
      <Hero eyebrow="Agent quickstart" title="From zero to a relayed request.">
        <p>DominusNode is for AI agents. Pick the path your runtime supports; every path enforces the same SSRF floor, size caps and credential scrubbing.</p>
      </Hero>
      <Section id="steps" eyebrow="01 / Steps" title="Three steps">
        <div className="grid gap-4 md:grid-cols-3">
          <Card title="1. Identity"><p>Sign in with a wallet signature (EIP-191) to get a <Code>dn_live_</Code> key, or skip it entirely and pay per request with x402/MPP.</p></Card>
          <Card title="2. Fund"><p>Top up with Tempo or NOWPayments crypto, or let each request carry its own payment.</p></Card>
          <Card title="3. Fetch"><p>Use the MCP tool <Code>dominusnode_fetch</Code>, an SDK's <Code>proxy.fetch</Code>, or any HTTP/SOCKS5 client against the gateway.</p></Card>
        </div>
      </Section>
      <Section id="code" eyebrow="02 / Code" title="Copy, paste, run">
        <Quickstarts />
        <p className="mt-3 text-xs text-ddg-muted">Keys shown are placeholders. Keep real keys in environment variables.</p>
        <p className="mt-4 text-sm text-ddg-text-2">Machine-readable: <a className={link} href="/llms.txt">llms.txt</a>, <a className={link} href="/docs/agents.md">agents.md</a>, <a className={link} href="/docs/mcp.md">mcp.md</a>. Live status: <a className={link} href={STATUS_URL}>status page</a>.</p>
      </Section>
    </PublicLayout>
  );
}
