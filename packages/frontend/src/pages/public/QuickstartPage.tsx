import { QUICKSTART_DOC_URL, QUICKSTART_SMOKE_URL, QUICKSTART_STEPS } from "../../landing/quickstart";
import { STATUS_URL } from "../../landing/site";
import { Card, Code, Hero, PublicLayout, Quickstarts, Section, link, usePageTitle } from "../../site/components";

export default function QuickstartPage() {
  usePageTitle("Agent quickstart · DominusNode");
  return (
    <PublicLayout>
      <Hero eyebrow="Agent quickstart" title="From zero to a relayed request.">
        <p>DominusNode is for AI agents. Pick the path your runtime supports; every path enforces the same SSRF floor, size caps and credential scrubbing.</p>
      </Hero>
      <Section id="steps" eyebrow="01 / Steps" title="Five minutes, three steps">
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
        <p className="mt-4 text-sm text-ddg-text-2">Verify the whole path with <a className={link} href={QUICKSTART_SMOKE_URL}><Code>scripts/quickstart-smoke.sh</Code></a> (key from <Code>DOMINUSNODE_API_KEY</Code>, never an argument). Details: <a className={link} href={QUICKSTART_DOC_URL}>QUICKSTART.md</a>.</p>
      </Section>
      <Section id="code" eyebrow="02 / Code" title="Copy, paste, run">
        <Quickstarts />
        <p className="mt-3 text-xs text-ddg-muted">Keys shown are placeholders. Keep real keys in environment variables.</p>
        <p className="mt-4 text-sm text-ddg-text-2">Machine-readable: <a className={link} href="/llms.txt">llms.txt</a>, <a className={link} href="/docs/agents.md">agents.md</a>, <a className={link} href="/docs/mcp.md">mcp.md</a>. Live status: <a className={link} href={STATUS_URL}>status page</a>.</p>
      </Section>
    </PublicLayout>
  );
}
