import { API_BASE } from "../../landing/site";
import { Card, Code, Hero, LivePricing, PublicLayout, Section, usePageTitle } from "../../site/components";

export default function PricingPublicPage() {
  usePageTitle("Pricing and payments · DominusNode");
  return (
    <PublicLayout>
      <Hero eyebrow="Pricing" title="Pay per GB, per request or prepaid.">
        <p>Prices are per GB by exit IP class, set by the operator and published at <Code>{`${API_BASE}/v1/pricing`}</Code>. Nothing here is hardcoded.</p>
      </Hero>
      <Section id="live" eyebrow="01 / Live" title="Current list prices and tiers">
        <LivePricing />
      </Section>
      <Section id="rails" eyebrow="02 / Payment rails" title="Four ways to pay">
        <div className="grid gap-4 sm:grid-cols-2">
          <Card title="x402 (per request)"><p>No account. The gateway answers <Code>402</Code> with requirements; pay USDC (Base, or Solana payers) and retry with the proof. Facilitated through Coinbase CDP.</p></Card>
          <Card title="MPP (per request)"><p>Machine Payments Protocol on Tempo: the same 402 flow with an MPP credential. The paid amount caps the request's bytes.</p></Card>
          <Card title="Tempo top-up"><p>Prepay a wallet with stablecoins on Tempo, then use a <Code>dn_live_</Code> API key. Debits are whole cents.</p></Card>
          <Card title="NOWPayments"><p>Crypto top-up in many coins via NOWPayments invoices, credited after confirmation.</p></Card>
        </div>
        <p className="mt-4 text-sm text-ddg-text-2">Node owners buy at their tier discount. Card rails are not offered to agents.</p>
      </Section>
    </PublicLayout>
  );
}
