import { GITHUB_URL } from "../../landing/site";
import { Card, Code, Hero, Pre, PublicLayout, Section, link, usePageTitle } from "../../site/components";

export default function SelfHostPage() {
  usePageTitle("Self-host a coordinator · DominusNode");
  return (
    <PublicLayout>
      <Hero eyebrow="Self-host" title="Run your own coordinator in one command.">
        <p>DominusNode is MIT-licensed. A coordinator is the API, gateway and database that nodes join and agents buy through. Anyone can run one; federation lets nodes choose which coordinators they trust.</p>
      </Hero>

      <Section id="install" eyebrow="01 / Install" title="One command, idempotent">
        <Pre label="Install">{`git clone ${GITHUB_URL}.git && cd DomiNode
DOMINUSNODE_HOSTNAMES="relay.example.org" TLS_MODE=auto \\
  ./scripts/selfhost/install.sh --yes`}</Pre>
        <ul className="mt-4 list-disc space-y-1 pl-5 text-sm text-ddg-text-2">
          <li>First run generates the coordinator signing key, a <Code>.env</Code> with random secrets and a Caddyfile.</li>
          <li>Later runs keep secrets and the key, refresh config, rebuild images and restart: that is the upgrade path.</li>
          <li><Code>TLS_MODE</Code>: <Code>auto</Code> (Let's Encrypt via Caddy), <Code>internal</Code> (self-signed) or <Code>off</Code> (terminate TLS in front).</li>
          <li>Needs Docker, Node.js and OpenSSL. <Code>--no-start</Code> only writes config.</li>
        </ul>
      </Section>

      <Section id="federation" eyebrow="02 / Federation" title="Nodes join by domain, trust on first use">
        <div className="grid gap-4 md:grid-cols-2">
          <Card title="Signed coordinator document"><p>Each coordinator publishes a signed identity document with its hostnames, API and tunnel URLs and keys. Nodes verify signature, freshness and hostname.</p></Card>
          <Card title="Explicit trust"><p>A node pointed at your domain prints your key fingerprint and refuses until the operator confirms it with <Code>DN_NODE_TRUST</Code>. Check it out of band.</p></Card>
        </div>
        <div className="mt-4"><Pre label="Join">{`DN_NODE_COORDINATOR=relay.example.org dominusnode-node run
# prints: signing key fingerprint: sha256:…  and refuses
DN_NODE_COORDINATOR=relay.example.org DN_NODE_TRUST=sha256:… dominusnode-node run`}</Pre></div>
        <p className="mt-4 text-sm text-ddg-text-2">Docs: <a className={link} href={`${GITHUB_URL}/blob/master/docs/agent-network/FEDERATION.md`}>FEDERATION.md</a>, <a className={link} href={`${GITHUB_URL}/blob/master/docs/agent-network/DEPLOYMENT.md`}>DEPLOYMENT.md</a>, <a className={link} href={`${GITHUB_URL}/blob/master/scripts/selfhost/install.sh`}>install.sh</a>.</p>
      </Section>
    </PublicLayout>
  );
}
