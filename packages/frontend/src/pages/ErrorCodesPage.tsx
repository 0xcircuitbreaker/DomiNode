import { Link } from "react-router-dom";

interface ErrorCode {
  code: string;
  http: number;
  description: string;
}

const ERROR_CODES: ErrorCode[] = [
  { code: "AUTH_REQUIRED", http: 407, description: "Missing or invalid proxy credentials" },
  { code: "AUTH_RATE_LIMITED", http: 429, description: "Too many failed auth attempts" },
  { code: "INSUFFICIENT_BALANCE", http: 402, description: "Wallet balance too low" },
  { code: "BANDWIDTH_LIMIT_EXCEEDED", http: 403, description: "Monthly plan limit reached" },
  { code: "TOO_MANY_CONNECTIONS", http: 429, description: "Concurrent connection limit" },
  { code: "TARGET_BLOCKED", http: 403, description: "Target host blocked (SSRF protection)" },
  { code: "DOMAIN_NOT_ALLOWED", http: 403, description: "Target not in wallet domain allowlist" },
  { code: "SANCTIONED_COUNTRY", http: 403, description: "Geo-blocked country" },
  { code: "POOL_RESTRICTED", http: 403, description: "Plan does not include this pool type" },
  { code: "METHOD_NOT_ALLOWED", http: 405, description: "HTTP method not permitted (x402)" },
  { code: "ALL_PROVIDERS_DOWN", http: 503, description: "No upstream providers available" },
  { code: "UPSTREAM_UNAVAILABLE", http: 502, description: "Upstream proxy connection failed" },
  { code: "UPSTREAM_TIMEOUT", http: 504, description: "Upstream proxy timed out" },
  { code: "BUDGET_EXCEEDED", http: 403, description: "Daily budget limit reached" },
];

export default function ErrorCodesPage() {
  return (
    <div className="min-h-screen bg-gray-950 text-gray-300">
      <header className="border-b border-gray-800 px-6 py-4">
        <div className="max-w-4xl mx-auto flex items-center justify-between">
          <Link to="/" className="text-indigo-400 font-bold text-lg">Dominus Node</Link>
          <Link to="/" className="text-sm text-gray-400 hover:text-gray-200">Back to Home</Link>
        </div>
      </header>

      <main className="max-w-4xl mx-auto px-6 py-12">
        <h1 className="text-3xl font-bold text-white mb-4">Proxy Error Codes</h1>
        <p className="text-sm text-gray-400 mb-8">
          All proxy gateway errors include an <code className="text-indigo-400 bg-gray-900 px-1 rounded">X-DominusNode-Error</code> response header
          with a machine-readable error code. Use these codes for programmatic error handling in your integrations.
        </p>

        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-gray-800">
                <th className="text-left py-3 px-4 text-gray-400 font-medium">Code</th>
                <th className="text-left py-3 px-4 text-gray-400 font-medium">HTTP</th>
                <th className="text-left py-3 px-4 text-gray-400 font-medium">Description</th>
              </tr>
            </thead>
            <tbody>
              {ERROR_CODES.map((err) => (
                <tr key={err.code} className="border-b border-gray-800/50 hover:bg-gray-900/50">
                  <td className="py-3 px-4">
                    <code className="text-indigo-400 bg-gray-900 px-1.5 py-0.5 rounded text-xs">{err.code}</code>
                  </td>
                  <td className="py-3 px-4 text-gray-300">{err.http}</td>
                  <td className="py-3 px-4 text-gray-400">{err.description}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        <section className="mt-12 space-y-4">
          <h2 className="text-xl font-semibold text-white">Usage Example</h2>
          <pre className="bg-gray-900 rounded-lg p-4 text-xs overflow-x-auto">
            <code>{`# Check for error codes in proxy responses
curl -v -x http://dc-country-US:YOUR_API_KEY@proxy.dominusnode.com:8080 \\
  http://httpbin.org/ip 2>&1 | grep X-DominusNode-Error

# Programmatic handling (Node.js)
const response = await fetch(url, { agent: proxyAgent });
const errorCode = response.headers.get('x-dominusnode-error');
if (errorCode === 'INSUFFICIENT_BALANCE') {
  // Top up wallet
} else if (errorCode === 'DOMAIN_NOT_ALLOWED') {
  // Target domain not in wallet allowlist
}`}</code>
          </pre>
        </section>
      </main>
    </div>
  );
}
