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
            <h2 className="text-xl font-semibold text-white mb-3">1. Our Privacy Commitment</h2>
            <p className="mb-3 text-white font-medium">Dominus Node is built with privacy at its core. By default, we save no traffic logs and we do not know what our proxies are being used for.</p>
            <p>We do not log, inspect, monitor, store, or analyze the content of any traffic routed through our proxy servers. By default, we do not record which websites you visit — only aggregate bandwidth totals are tracked for billing. You may optionally enable per-site target host logging in your Security settings for usage analytics, but this is off by default. This is by design, not by accident.</p>
          </section>

          <section>
            <h2 className="text-xl font-semibold text-white mb-3">2. What We Do Collect</h2>
            <p className="mb-3">We collect the minimum data necessary to operate the service and bill you accurately:</p>
            <p className="mb-2"><strong className="text-gray-200">Account Information:</strong> Email address and hashed password (bcrypt) when you create an account. If you use wallet authentication, your Ethereum wallet address. We cannot see or recover your password.</p>
            <p className="mb-2"><strong className="text-gray-200">Bandwidth Metering:</strong> We track the total number of bytes transferred per session for billing purposes only. This is an aggregate number — we do not log which websites or services generated that traffic.</p>
            <p className="mb-2"><strong className="text-gray-200">Payment Data:</strong> Transaction records, payment provider reference IDs, and invoice amounts. We do not store credit card numbers — payment processing is handled entirely by Stripe and NOWPayments.</p>
            <p><strong className="text-gray-200">Security Data:</strong> IP addresses are used transiently for rate limiting and abuse prevention. API key metadata (prefix, creation date) is stored for your key management dashboard.</p>
          </section>

          <section>
            <h2 className="text-xl font-semibold text-white mb-3">3. What We Do NOT Collect (By Default)</h2>
            <p className="mb-2">By default, we do <strong className="text-white">NOT</strong> collect or store:</p>
            <ul className="list-disc list-inside space-y-1">
              <li>URLs or domains you visit through the proxy (unless you opt in to target host logging)</li>
              <li>HTTP request or response content</li>
              <li>DNS queries made through the proxy</li>
              <li>Browsing history or browsing patterns</li>
              <li>File downloads or uploads content</li>
              <li>Cookies, form data, or authentication credentials you send to third-party sites</li>
              <li>Any content of encrypted (HTTPS/TLS) connections — we cannot see this even if we wanted to</li>
            </ul>
            <p className="mt-3 text-gray-400">Our proxy gateway handles HTTPS traffic via the CONNECT method, which creates an encrypted tunnel directly between your device and the destination. We relay the encrypted bytes and count them for billing. We cannot decrypt or inspect this traffic.</p>
            <p className="mt-2 text-gray-400"><strong className="text-gray-200">Opt-in target host logging:</strong> You may enable target host logging in your Security settings to see per-site bandwidth analytics. When enabled, the hostname (not full URL) of each destination is stored in your usage records. This is disabled by default and can be turned off at any time.</p>
          </section>

          <section>
            <h2 className="text-xl font-semibold text-white mb-3">4. How We Use Your Data</h2>
            <ul className="list-disc list-inside space-y-1">
              <li>Authenticate your identity and authorize proxy access</li>
              <li>Meter aggregate bandwidth usage and process billing</li>
              <li>Prevent abuse, fraud, and unauthorized account access</li>
              <li>Enforce rate limits and connection quotas</li>
              <li>Comply with applicable laws and sanctions regulations</li>
            </ul>
          </section>

          <section>
            <h2 className="text-xl font-semibold text-white mb-3">5. Data Retention</h2>
            <p className="mb-2">We retain data for the minimum period necessary:</p>
            <ul className="list-disc list-inside space-y-1">
              <li>Usage records (bandwidth totals only): 1 year</li>
              <li>Session records (connection metadata): 90 days</li>
              <li>Audit events (account actions): 1 year</li>
              <li>Wallet transactions: 2 years (financial compliance)</li>
              <li>Authentication challenges: 1 day</li>
            </ul>
            <p className="mt-2">Data is automatically purged after its retention period expires. You can request early deletion by deleting your account.</p>
          </section>

          <section>
            <h2 className="text-xl font-semibold text-white mb-3">6. x402 Micropayment Data</h2>
            <p className="mb-2">When using x402 pay-per-request micropayments, we record the following data for billing reconciliation and fraud prevention:</p>
            <ul className="list-disc list-inside space-y-1">
              <li>Payer wallet address (Ethereum or Solana)</li>
              <li>Transaction amount (in USD)</li>
              <li>Facilitator used (Coinbase or PayAI)</li>
              <li>Transaction hash</li>
              <li>Proxy pool type (datacenter or residential)</li>
              <li>Timestamp</li>
            </ul>
            <p className="mt-2 text-gray-400">This data is retained for 2 years in accordance with our financial data retention policies. x402 transactions do not require an account — the wallet address serves as the billing identity. This data is subject to the same retention and deletion policies as other billing data.</p>
          </section>

          <section>
            <h2 className="text-xl font-semibold text-white mb-3">7. Data Sharing</h2>
            <p className="mb-2">We do not sell, rent, or trade your personal data. We share data only with:</p>
            <ul className="list-disc list-inside space-y-1 mt-2">
              <li><strong className="text-gray-200">Payment processors</strong> (Stripe, NOWPayments) — to process your payments only</li>
              <li><strong className="text-gray-200">Upstream proxy providers</strong> (Webshare) — only connection routing data, never traffic content</li>
              <li><strong className="text-gray-200">Law enforcement</strong> — only when legally compelled, and only the limited account data we have (we cannot provide traffic logs because they do not exist)</li>
            </ul>
          </section>

          <section>
            <h2 className="text-xl font-semibold text-white mb-3">8. Your Rights</h2>
            <p className="mb-2">You have the right to:</p>
            <ul className="list-disc list-inside space-y-1">
              <li><strong className="text-gray-200">Export your data:</strong> Download your account data through the dashboard or via GET /api/account/export</li>
              <li><strong className="text-gray-200">Delete your account:</strong> Request full account deletion through your dashboard. Your personal data will be anonymized and billing records retained only as required by law.</li>
              <li><strong className="text-gray-200">Correct your data:</strong> Update your email or password through security settings</li>
            </ul>
          </section>

          <section>
            <h2 className="text-xl font-semibold text-white mb-3">9. Security</h2>
            <p>We protect your data using: bcrypt password hashing, AES-encrypted MFA secrets, TLS encryption for all connections, SHA-256 API key hashing, httpOnly secure cookies with strict SameSite policy, and regular independent security audits.</p>
          </section>

          <section>
            <h2 className="text-xl font-semibold text-white mb-3">10. Cookies</h2>
            <p>We use strictly necessary cookies for authentication (access token and refresh token) only. We do not use tracking cookies, advertising cookies, analytics cookies, or any third-party cookies.</p>
          </section>

          <section>
            <h2 className="text-xl font-semibold text-white mb-3">11. Contact</h2>
            <p>For privacy-related inquiries: <a href="mailto:0xcircuitbreaker@protonmail.com" className="text-indigo-400 hover:text-indigo-300">0xcircuitbreaker@protonmail.com</a></p>
          </section>
        </div>
      </main>
    </div>
  );
}
