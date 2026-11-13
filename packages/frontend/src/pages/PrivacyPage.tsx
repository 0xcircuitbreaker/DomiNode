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
        <p className="text-sm text-gray-500 mb-8">Last updated: November 2026</p>

        <div className="space-y-8 text-sm leading-relaxed">
          <section>
            <h2 className="text-xl font-semibold text-white mb-3">1. Our Privacy Commitment</h2>
            <p className="mb-3 text-white font-medium">Dominus Node is built with privacy at its core. We never record the content of your traffic. To stop the network being used for abuse, we keep one narrow, metadata-only abuse log for a limited time, described below.</p>
            <p>We do not log, inspect, monitor, store, or analyze the content of any traffic routed through the relay network: no payloads, full URLs, paths, query strings, headers or cookies. For every relay session we do keep a short metadata-only abuse log entry (time, your account id, the exit node id, destination hostname, destination port and byte count) so that an abuse complaint against an exit node's IP can be traced to the agent that caused it. That log is kept for a fixed retention window (90 days by default) and then deleted. Separately, you may opt in to per-site target host logging in your Security settings for your own usage analytics; that is off by default.</p>
          </section>

          <section>
            <h2 className="text-xl font-semibold text-white mb-3">2. What We Do Collect</h2>
            <p className="mb-3">We collect the minimum data necessary to operate the service and bill you accurately:</p>
            <p className="mb-2"><strong className="text-gray-200">Account Information:</strong> Dominus Node accounts belong to AI agents. An agent account is identified by its wallet address, and it authenticates with an API key (<code>dn_live_</code>) or a wallet signature. We store only a SHA-256 hash of each API key, plus its prefix and creation date. We do not collect names, email addresses or other login secrets from agents. Humans use the service only as operators (administrators).</p>
            <p className="mb-2"><strong className="text-gray-200">Bandwidth Metering:</strong> We track the total number of bytes transferred per session for billing purposes only. Your usage and billing records hold byte totals only; they do not include the destination unless you opt in to target host logging.</p>
            <p className="mb-2"><strong className="text-gray-200">Relay Abuse Log (metadata only):</strong> For every relay session we store the time, your account id, the session id, the exit node id, the destination hostname and port, and the byte count. We never store payloads, full URLs, paths or query strings. Purpose: tracing abuse complaints made against an exit node's IP to the requesting agent so that agent can be suspended, and protecting node operators. It is visible only to platform administrators and is deleted after the retention window (see Data Retention).</p>
            <p className="mb-2"><strong className="text-gray-200">Payment Data:</strong> Agents pay with crypto rails only: x402 and MPP per-request payments, Tempo and NOWPayments crypto top-ups. We record payer wallet addresses, amounts, transaction hashes, invoice IDs and payment provider reference IDs. We do not accept or store card numbers.</p>
            <p><strong className="text-gray-200">Security Data:</strong> IP addresses are used transiently for rate limiting and abuse prevention. API key metadata (prefix, creation date) is stored for your key management dashboard.</p>
          </section>

          <section>
            <h2 className="text-xl font-semibold text-white mb-3">3. What We Do NOT Collect (By Default)</h2>
            <p className="mb-2">By default, we do <strong className="text-white">NOT</strong> collect or store:</p>
            <ul className="list-disc list-inside space-y-1">
              <li>Full URLs, paths or query strings you request through the relay (destination hostnames are kept only in the metadata-only abuse log described above, and in your usage records if you opt in to target host logging)</li>
              <li>HTTP request or response content</li>
              <li>DNS queries made through the proxy</li>
                            <li>File downloads or uploads content</li>
              <li>Cookies, form data, or authentication credentials you send to third-party sites</li>
              <li>Any content of encrypted (HTTPS/TLS) connections — we cannot see this even if we wanted to</li>
            </ul>
            <p className="mt-3 text-gray-400">Our proxy gateway handles HTTPS traffic via the CONNECT method, which creates an encrypted tunnel directly between your device and the destination. We relay the encrypted bytes and count them for billing. We cannot decrypt or inspect this traffic.</p>
            <p className="mt-2 text-gray-400"><strong className="text-gray-200">Opt-in target host logging:</strong> You may enable target host logging in your Security settings to see per-site bandwidth analytics. When enabled, the hostname (not full URL) of each destination is stored in your usage records. This is disabled by default and can be turned off at any time. It is separate from the abuse log, which is always kept for its retention window.</p>
          </section>

          <section>
            <h2 className="text-xl font-semibold text-white mb-3">4. How We Use Your Data</h2>
            <ul className="list-disc list-inside space-y-1">
              <li>Authenticate your identity and authorize proxy access</li>
              <li>Meter aggregate bandwidth usage and process billing</li>
              <li>Prevent abuse, fraud, and unauthorized account access, including tracing abuse complaints against exit node IPs through the metadata-only abuse log</li>
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
              <li>Relay abuse log (time, account id, node id, destination host and port, bytes): 90 days by default; administrators may set a different window (the <code>logRetentionDays</code> network policy)</li>
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
              <li><strong className="text-gray-200">x402 facilitators</strong> (Coinbase CDP, PayAI) — payer wallet address, amount and transaction data, to verify and settle x402 payments</li>
              <li><strong className="text-gray-200">NOWPayments</strong> — invoice ID and amount, to process crypto top-ups</li>
              <li><strong className="text-gray-200">Blockchain RPC providers</strong> (Base and Tempo networks) — wallet addresses and transaction hashes, to verify on-chain payments. Blockchain transactions are public by nature.</li>
              <li><strong className="text-gray-200">IP data</strong> — exit-node IP addresses are classified locally against the public ip2asn dataset; no IP addresses are sent to that provider</li>
              <li><strong className="text-gray-200">GitHub</strong> — code and release hosting; no account or traffic data</li>
              <li><strong className="text-gray-200">Cloudflare</strong> — terminates TLS for this website and the API and forwards requests to our servers, so it processes the contents of website and API requests, including API keys in request headers, wallet addresses, signatures and the responses (for example balances and node listings). It acts as our processor under the <a href="https://www.cloudflare.com/cloudflare-customer-dpa/" className="text-indigo-400 hover:text-indigo-300" target="_blank" rel="noopener noreferrer">Cloudflare Data Processing Addendum</a>. Relay and proxy traffic (the HTTP and SOCKS5 gateway ports and the node tunnel) does not pass through Cloudflare.</li>
              <li><strong className="text-gray-200">Law enforcement</strong> — only when legally compelled, and only the limited data we have: account data and, within its retention window, the metadata-only abuse log (destination host, port, time and bytes). We have no traffic content, full URLs or payloads to provide.</li>
            </ul>
          </section>

          <section>
            <h2 className="text-xl font-semibold text-white mb-3">8. Your Rights</h2>
            <p className="mb-2">You have the right to:</p>
            <ul className="list-disc list-inside space-y-1">
              <li><strong className="text-gray-200">Export your data:</strong> Download your account data through the dashboard or via GET /api/account/export</li>
              <li><strong className="text-gray-200">Delete your account:</strong> Request full account deletion through your dashboard. Your personal data will be anonymized, your abuse-log entries, node IP addresses and payout wallets deleted, and billing records retained (unlinked from your identity where possible) only as required by law.</li>
              <li><strong className="text-gray-200">Correct your data:</strong> Rotate or revoke your API keys and update your payout wallet through the API</li>
            </ul>
          </section>

          <section>
            <h2 className="text-xl font-semibold text-white mb-3">9. Security</h2>
            <p>We protect your data using: SHA-256 API key hashing, wallet-signature verification, TLS encryption for all connections, httpOnly secure cookies with strict SameSite policy for the admin console, and regular independent security audits.</p>
          </section>

          <section>
            <h2 className="text-xl font-semibold text-white mb-3">10. Cookies</h2>
            <p>Agents authenticate with API keys or wallet signatures, not cookies. The admin console uses strictly necessary authentication cookies (access token and refresh token) only. We do not use tracking cookies, advertising cookies, analytics cookies, or any third-party cookies.</p>
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
