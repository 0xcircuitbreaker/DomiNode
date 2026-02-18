import { Link } from "react-router-dom";

export default function PrivacyPage() {
  return (
    <div className="min-h-screen bg-gray-950 text-gray-300">
      <header className="border-b border-gray-800 px-6 py-4">
        <div className="max-w-4xl mx-auto flex items-center justify-between">
          <Link to="/" className="text-indigo-400 font-bold text-lg">Dominus Node</Link>
          <Link to="/" className="text-sm text-gray-400 hover:text-gray-200">Back to Home</Link>
        </div>
      </header>

      <main className="max-w-4xl mx-auto px-6 py-12">
        <h1 className="text-3xl font-bold text-white mb-8">Privacy Policy</h1>
        <p className="text-sm text-gray-500 mb-8">Last updated: February 2026</p>

        <div className="space-y-8 text-sm leading-relaxed">
          <section>
            <h2 className="text-xl font-semibold text-white mb-3">1. Information We Collect</h2>
            <p className="mb-2"><strong className="text-gray-200">Account Information:</strong> Email address and hashed password when you create an account. If you use wallet authentication, your Ethereum wallet address.</p>
            <p className="mb-2"><strong className="text-gray-200">Usage Data:</strong> Bandwidth consumed (bytes in/out), proxy type used, connection timestamps, and target hostnames (retained for billing accuracy and abuse prevention).</p>
            <p className="mb-2"><strong className="text-gray-200">Payment Data:</strong> Transaction records, payment provider IDs, and invoice amounts. We do not store credit card numbers — payment processing is handled by Stripe and NOWPayments.</p>
            <p><strong className="text-gray-200">Technical Data:</strong> IP address (for rate limiting and abuse prevention), API key metadata (prefix, creation date), and session identifiers.</p>
          </section>

          <section>
            <h2 className="text-xl font-semibold text-white mb-3">2. How We Use Your Data</h2>
            <ul className="list-disc list-inside space-y-1">
              <li>Authenticate your identity and authorize proxy access</li>
              <li>Meter bandwidth usage and process billing</li>
              <li>Prevent abuse, fraud, and unauthorized access</li>
              <li>Enforce rate limits and connection quotas</li>
              <li>Comply with applicable laws and sanctions regulations</li>
            </ul>
          </section>

          <section>
            <h2 className="text-xl font-semibold text-white mb-3">3. Data Retention</h2>
            <p className="mb-2">We retain data according to the following schedule:</p>
            <ul className="list-disc list-inside space-y-1">
              <li>Usage records: 1 year</li>
              <li>Session records: 90 days</li>
              <li>Audit events: 1 year</li>
              <li>Wallet transactions: 2 years</li>
              <li>Authentication challenges: 1 day</li>
            </ul>
            <p className="mt-2">Data is automatically purged after its retention period expires.</p>
          </section>

          <section>
            <h2 className="text-xl font-semibold text-white mb-3">4. Data Sharing</h2>
            <p>We do not sell your data. We share data only with:</p>
            <ul className="list-disc list-inside space-y-1 mt-2">
              <li><strong className="text-gray-200">Payment processors</strong> (Stripe, NOWPayments) to process transactions</li>
              <li><strong className="text-gray-200">Upstream proxy providers</strong> (Webshare) to route your traffic — only connection metadata, not content</li>
              <li><strong className="text-gray-200">Law enforcement</strong> when legally required</li>
            </ul>
          </section>

          <section>
            <h2 className="text-xl font-semibold text-white mb-3">5. Your Rights</h2>
            <p className="mb-2">You have the right to:</p>
            <ul className="list-disc list-inside space-y-1">
              <li><strong className="text-gray-200">Export your data:</strong> Use the data export feature in your dashboard settings or call GET /api/account/export</li>
              <li><strong className="text-gray-200">Delete your account:</strong> Request account deletion through your dashboard. Your personal data will be anonymized.</li>
              <li><strong className="text-gray-200">Correct your data:</strong> Update your email or password through your security settings</li>
            </ul>
          </section>

          <section>
            <h2 className="text-xl font-semibold text-white mb-3">6. Security</h2>
            <p>We protect your data using: password hashing (bcrypt), encrypted MFA secrets, TLS for all connections, API key hashing (SHA-256), httpOnly secure cookies, and regular security audits.</p>
          </section>

          <section>
            <h2 className="text-xl font-semibold text-white mb-3">7. Cookies</h2>
            <p>We use strictly necessary cookies for authentication (access token and refresh token). We do not use tracking or advertising cookies.</p>
          </section>

          <section>
            <h2 className="text-xl font-semibold text-white mb-3">8. Contact</h2>
            <p>For privacy-related inquiries: <a href="mailto:privacy@dominusnode.com" className="text-indigo-400 hover:text-indigo-300">privacy@dominusnode.com</a></p>
          </section>
        </div>
      </main>
    </div>
  );
}
