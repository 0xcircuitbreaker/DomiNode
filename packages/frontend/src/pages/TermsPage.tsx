import { Link } from "react-router-dom";

export default function TermsPage() {
  return (
    <div className="min-h-screen bg-gray-950 text-gray-300">
      <header className="border-b border-gray-800 px-6 py-4">
        <div className="max-w-4xl mx-auto flex items-center justify-between">
          <Link to="/" className="text-indigo-400 font-bold text-lg">Dominus Node</Link>
          <Link to="/" className="text-sm text-gray-400 hover:text-gray-200">Back to Home</Link>
        </div>
      </header>

      <main className="max-w-4xl mx-auto px-6 py-12">
        <h1 className="text-3xl font-bold text-white mb-8">Terms of Service</h1>
        <p className="text-sm text-gray-500 mb-8">Last updated: February 2026</p>

        <div className="space-y-8 text-sm leading-relaxed">
          <section>
            <h2 className="text-xl font-semibold text-white mb-3">1. Service Description</h2>
            <p>Dominus Node provides rotating proxy-as-a-service infrastructure. Users connect through our proxy gateway to route internet traffic through managed IP pools. Usage is metered by bandwidth (data transferred) and billed accordingly.</p>
          </section>

          <section>
            <h2 className="text-xl font-semibold text-white mb-3">2. Strictly Prohibited Use</h2>
            <p className="mb-3 text-white font-medium">Dominus Node may NOT be used for any illegal operations whatsoever. This is a zero-tolerance policy.</p>
            <p className="mb-2">Without limitation, the following activities are expressly prohibited:</p>
            <ul className="list-disc list-inside space-y-1">
              <li>Any activity that violates local, state, national, or international law</li>
              <li>Fraud, identity theft, phishing, or financial crimes of any kind</li>
              <li>Distributed denial-of-service (DDoS) attacks or network disruption</li>
              <li>Sending spam or unsolicited bulk messages</li>
              <li>Distributing malware, ransomware, or exploiting vulnerabilities</li>
              <li>Child sexual abuse material (CSAM) or any form of child exploitation</li>
              <li>Human trafficking, drug trafficking, or weapons trafficking</li>
              <li>Credential stuffing, brute force attacks, or unauthorized account access</li>
              <li>Circumventing sanctions, export controls, or trade embargoes</li>
              <li>Harassment, stalking, doxxing, or threats of violence</li>
              <li>Copyright infringement or intellectual property theft</li>
              <li>Any activity that could damage Dominus Node infrastructure, reputation, or upstream providers</li>
            </ul>
          </section>

          <section>
            <h2 className="text-xl font-semibold text-white mb-3">3. Enforcement and Penalties</h2>
            <p className="mb-3">If we determine, at our sole discretion, that your account has been used for any illegal activity or violation of these terms:</p>
            <ul className="list-disc list-inside space-y-2">
              <li><strong className="text-white">Immediate termination:</strong> Your account will be suspended and terminated without prior notice.</li>
              <li><strong className="text-white">Balance forfeiture:</strong> Any remaining wallet balance will be permanently forfeited as a penalty. No refund will be issued under any circumstances for accounts terminated due to abuse or illegal activity.</li>
              <li><strong className="text-white">API key revocation:</strong> All API keys and active proxy sessions will be immediately revoked.</li>
              <li><strong className="text-white">Permanent ban:</strong> You will be permanently prohibited from creating new accounts or using Dominus Node services.</li>
              <li><strong className="text-white">Legal cooperation:</strong> We reserve the right to cooperate with law enforcement agencies and may report illegal activity to the appropriate authorities.</li>
            </ul>
            <p className="mt-3 text-gray-400">We reserve the right to investigate suspected violations and take any action we deem necessary to protect the service, our users, and third parties.</p>
          </section>

          <section>
            <h2 className="text-xl font-semibold text-white mb-3">4. Billing and Payments</h2>
            <ul className="list-disc list-inside space-y-1">
              <li>Dominus Node uses a prepaid wallet system. You must maintain a positive balance to use paid proxy services.</li>
              <li>Relay bandwidth is billed per GB at the current published rate for each IP class (see <code>/v1/pricing</code>).</li>
              <li>Agents pay through x402 per-request payments (settled by facilitators such as Coinbase CDP and PayAI), MPP per-request payments, Tempo, and NOWPayments cryptocurrency top-ups. Card payments are not available to agents.</li>
              <li>All payments are final. Refunds are issued at our sole discretion for service outages or billing errors only.</li>
              <li>Free tier bandwidth is subject to monthly limits and may be reduced or discontinued at any time.</li>
            </ul>
          </section>

          <section>
            <h2 className="text-xl font-semibold text-white mb-3">5. No Logging of Traffic Content</h2>
            <p>Dominus Node does not log, inspect, store, or monitor the content of traffic relayed through the network: no payloads, request paths or full URLs. For billing we record byte totals. For abuse handling we keep a metadata-only relay abuse log (time, requesting agent, exit node, destination hostname and port, bytes) for a limited retention window (90 days by default). See our Privacy Policy for full details.</p>
          </section>

          <section>
            <h2 className="text-xl font-semibold text-white mb-3">6. Service Availability</h2>
            <p>We strive for high availability but do not guarantee uninterrupted service. Proxy IP availability, geographic coverage, and connection speeds may vary. We reserve the right to modify, suspend, or discontinue any aspect of the service with reasonable notice.</p>
          </section>

          <section>
            <h2 className="text-xl font-semibold text-white mb-3">7. Account Responsibility</h2>
            <p>You are responsible for all activity under your account and API keys. Keep your credentials secure. Notify us immediately if you suspect unauthorized access. We reserve the right to suspend accounts that pose a security risk.</p>
          </section>

          <section>
            <h2 className="text-xl font-semibold text-white mb-3">8. Sanctions Compliance</h2>
            <p>Dominus Node complies with OFAC sanctions. Service is not available to users in Cuba, Iran, North Korea, Russia, or Syria. Proxy exit nodes in these countries are blocked. Attempting to circumvent these restrictions will result in immediate account termination without refund.</p>
          </section>

          <section>
            <h2 className="text-xl font-semibold text-white mb-3">9. Limitation of Liability</h2>
            <p>Dominus Node is provided "as is" without warranty of any kind. We are not liable for any indirect, incidental, special, or consequential damages arising from your use of the service. Our total liability shall not exceed the amount you paid in the 12 months preceding the claim.</p>
          </section>

          <section>
            <h2 className="text-xl font-semibold text-white mb-3">10. Termination</h2>
            <p className="mb-2">Either party may terminate the service at any time. You may delete your account through the dashboard.</p>
            <p className="mb-2"><strong className="text-gray-200">Voluntary termination:</strong> If you close your account in good standing, any remaining balance may be refunded at our discretion.</p>
            <p><strong className="text-gray-200">Termination for violation:</strong> Accounts terminated for violating these terms, including any illegal use, will have their remaining balance permanently forfeited. No exceptions.</p>
          </section>

          <section>
            <h2 className="text-xl font-semibold text-white mb-3">11. Changes to Terms</h2>
            <p>We may update these terms from time to time. Continued use of the service after changes constitutes acceptance. Material changes are announced through the API: the current policy version and hash are published at <code>/v1/policy</code>.</p>
          </section>

          <section>
            <h2 className="text-xl font-semibold text-white mb-3">12. Contact</h2>
            <p>For questions about these terms: <a href="mailto:0xcircuitbreaker@protonmail.com" className="text-indigo-400 hover:text-indigo-300">0xcircuitbreaker@protonmail.com</a></p>
          </section>
        </div>
      </main>
    </div>
  );
}
