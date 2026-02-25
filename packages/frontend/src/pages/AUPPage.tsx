import { Link } from "react-router-dom";

export default function AUPPage() {
  return (
    <div className="min-h-screen bg-gray-950 text-gray-300">
      <header className="border-b border-gray-800 px-6 py-4">
        <div className="max-w-4xl mx-auto flex items-center justify-between">
          <Link to="/" className="text-indigo-400 font-bold text-lg">Dominus Node</Link>
          <Link to="/" className="text-sm text-gray-400 hover:text-gray-200">Back to Home</Link>
        </div>
      </header>

      <main className="max-w-4xl mx-auto px-6 py-12">
        <h1 className="text-3xl font-bold text-white mb-8">Acceptable Use Policy</h1>
        <p className="text-sm text-gray-500 mb-8">Last updated: February 2026</p>

        <div className="space-y-8 text-sm leading-relaxed">
          <section>
            <h2 className="text-xl font-semibold text-white mb-3">1. Purpose</h2>
            <p>Dominus Node provides proxy infrastructure for legitimate automation, AI agent workflows, data collection, and privacy-preserving web access. This Acceptable Use Policy ("AUP") supplements our <Link to="/terms" className="text-indigo-400 hover:text-indigo-300">Terms of Service</Link> and defines the boundaries of permitted and prohibited activity on our platform.</p>
          </section>

          <section>
            <h2 className="text-xl font-semibold text-white mb-3">2. Permitted Uses</h2>
            <ul className="list-disc list-inside space-y-1">
              <li>AI agent web access for research, comparison, and monitoring</li>
              <li>Automated data collection that respects robots.txt and rate limits</li>
              <li>Privacy-preserving browsing and geo-testing</li>
              <li>API integration testing and development</li>
              <li>Price monitoring, SEO auditing, and ad verification</li>
              <li>Market research and competitive intelligence within legal bounds</li>
              <li>Quality assurance and website accessibility testing</li>
            </ul>
          </section>

          <section>
            <h2 className="text-xl font-semibold text-white mb-3">3. Prohibited Uses</h2>
            <p className="mb-3">In addition to the prohibitions in our Terms of Service (Section 2), the following activities are expressly prohibited:</p>
            <ul className="list-disc list-inside space-y-1">
              <li>Credential stuffing, account takeover, or brute force attacks</li>
              <li>Ad fraud, click fraud, or impression manipulation</li>
              <li>Competitive scraping that violates target site terms of service</li>
              <li>Ticket scalping or inventory hoarding bots</li>
              <li>Social media manipulation or fake engagement generation</li>
              <li>Sneaker bots or limited-release purchase automation</li>
              <li>CAPTCHA solving services or bypass tools</li>
              <li>Any activity designed to overwhelm target infrastructure (DoS/DDoS)</li>
              <li>Automated creation of fake accounts on third-party services</li>
              <li>Email harvesting or spam list generation</li>
            </ul>
          </section>

          <section>
            <h2 className="text-xl font-semibold text-white mb-3">4. Abuse Detection</h2>
            <p className="mb-3">We monitor for patterns that indicate policy violations, including:</p>
            <ul className="list-disc list-inside space-y-1">
              <li>Anomalous request velocity patterns</li>
              <li>Known malicious target patterns</li>
              <li>Excessive error rates (403/429 spikes)</li>
              <li>Geographic targeting anomalies</li>
              <li>Unusual bandwidth consumption patterns</li>
            </ul>
            <p className="mt-3 text-gray-400">We do not inspect the content of proxied traffic. Abuse detection is based on metadata, request patterns, and error rates only.</p>
          </section>

          <section>
            <h2 className="text-xl font-semibold text-white mb-3">5. Enforcement</h2>
            <p className="mb-3">Violations are handled through a graduated response:</p>
            <ol className="list-decimal list-inside space-y-1">
              <li><strong className="text-gray-200">Warning:</strong> First-time or minor violations may result in a written warning with required corrective action.</li>
              <li><strong className="text-gray-200">Throttle:</strong> Continued violations may result in bandwidth or connection throttling.</li>
              <li><strong className="text-gray-200">Suspend:</strong> Serious or repeated violations will result in temporary account suspension.</li>
              <li><strong className="text-gray-200">Terminate:</strong> Severe or persistent violations result in permanent termination and wallet balance forfeiture per our Terms of Service.</li>
            </ol>
            <p className="mt-3 text-gray-400">We reserve the right to skip steps in this process for severe violations, including any illegal activity.</p>
          </section>

          <section>
            <h2 className="text-xl font-semibold text-white mb-3">6. Agent-Specific Rules</h2>
            <p className="mb-3">AI agents using Dominus Node are subject to additional requirements:</p>
            <ul className="list-disc list-inside space-y-1">
              <li>Agents must operate within assigned spend controls and budget limits</li>
              <li>x402 transactions are logged with payer wallet address for accountability</li>
              <li>Agentic wallets have per-transaction and optional daily spending limits</li>
              <li>Agents should identify themselves via User-Agent or X-DominusNode-Agent header</li>
              <li>Agents must respect domain allowlists when configured on their wallet</li>
            </ul>
          </section>

          <section>
            <h2 className="text-xl font-semibold text-white mb-3">7. Reporting Abuse</h2>
            <p>If you believe our service is being used in violation of this policy, please report it to <a href="mailto:0xcircuitbreaker@protonmail.com" className="text-indigo-400 hover:text-indigo-300">0xcircuitbreaker@protonmail.com</a>.</p>
          </section>
        </div>
      </main>
    </div>
  );
}
