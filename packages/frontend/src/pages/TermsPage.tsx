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
            <h2 className="text-xl font-semibold text-white mb-3">2. Acceptable Use</h2>
            <p className="mb-2">You agree NOT to use Dominus Node for:</p>
            <ul className="list-disc list-inside space-y-1">
              <li>Any illegal activity under applicable law</li>
              <li>Distributed denial-of-service (DDoS) attacks</li>
              <li>Sending spam or unsolicited bulk messages</li>
              <li>Distributing malware or exploiting vulnerabilities</li>
              <li>Scraping in violation of target website terms of service</li>
              <li>Circumventing sanctions or export controls</li>
              <li>Child exploitation material of any kind</li>
              <li>Credential stuffing, brute force attacks, or account takeover</li>
              <li>Activities that could damage Dominus Node infrastructure or reputation</li>
            </ul>
            <p className="mt-2">Violation of these terms may result in immediate account suspension without refund.</p>
          </section>

          <section>
            <h2 className="text-xl font-semibold text-white mb-3">3. Billing and Payments</h2>
            <ul className="list-disc list-inside space-y-1">
              <li>Dominus Node uses a prepaid wallet system. You must maintain a positive balance to use paid proxy services.</li>
              <li>Datacenter proxies are billed at the current rate (see Plans page). Residential proxies are billed at a separate rate.</li>
              <li>Payments are accepted via Stripe (credit/debit card) and cryptocurrency (BTC, ETH, XMR, SOL, ZEC via NOWPayments).</li>
              <li>All payments are final. Refunds are issued at our sole discretion for service outages or billing errors.</li>
              <li>Free tier bandwidth is subject to monthly limits and may be reduced or discontinued at any time.</li>
            </ul>
          </section>

          <section>
            <h2 className="text-xl font-semibold text-white mb-3">4. Service Availability</h2>
            <p>We strive for high availability but do not guarantee uninterrupted service. Proxy IP availability, geographic coverage, and connection speeds may vary. We reserve the right to modify, suspend, or discontinue any aspect of the service with reasonable notice.</p>
          </section>

          <section>
            <h2 className="text-xl font-semibold text-white mb-3">5. Account Responsibility</h2>
            <p>You are responsible for all activity under your account and API keys. Keep your credentials secure. Notify us immediately if you suspect unauthorized access. We reserve the right to suspend accounts that pose a security risk.</p>
          </section>

          <section>
            <h2 className="text-xl font-semibold text-white mb-3">6. Sanctions Compliance</h2>
            <p>Dominus Node complies with OFAC sanctions. Service is not available to users in Cuba, Iran, North Korea, Russia, or Syria. Proxy exit nodes in these countries are blocked. Attempting to circumvent these restrictions will result in account termination.</p>
          </section>

          <section>
            <h2 className="text-xl font-semibold text-white mb-3">7. Limitation of Liability</h2>
            <p>Dominus Node is provided "as is" without warranty of any kind. We are not liable for any indirect, incidental, special, or consequential damages arising from your use of the service. Our total liability shall not exceed the amount you paid in the 12 months preceding the claim.</p>
          </section>

          <section>
            <h2 className="text-xl font-semibold text-white mb-3">8. Termination</h2>
            <p>Either party may terminate the service at any time. You may delete your account through the dashboard. We may suspend or terminate accounts that violate these terms. Upon termination, remaining wallet balance may be forfeited if the account was terminated for abuse.</p>
          </section>

          <section>
            <h2 className="text-xl font-semibold text-white mb-3">9. Changes to Terms</h2>
            <p>We may update these terms from time to time. Continued use of the service after changes constitutes acceptance. Material changes will be communicated via email or dashboard notification.</p>
          </section>

          <section>
            <h2 className="text-xl font-semibold text-white mb-3">10. Contact</h2>
            <p>For questions about these terms: <a href="mailto:legal@dominusnode.com" className="text-indigo-400 hover:text-indigo-300">legal@dominusnode.com</a></p>
          </section>
        </div>
      </main>
    </div>
  );
}
