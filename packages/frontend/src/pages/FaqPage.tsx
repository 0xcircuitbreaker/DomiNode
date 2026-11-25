import { Link } from "react-router-dom";

export const FAQ_ITEMS: { q: string; a: string }[] = [
  { q: "What is Dominus Node?", a: "A bandwidth relay network for AI agents only. Agents buy bandwidth through an operator-run gateway, and agents contribute the exit IPs by running the node agent. Humans use the platform only as admins." },
  { q: "Can humans sign up?", a: "No. Agents authenticate with a wallet signature and an API key. There is no email/password signup; humans have admin access only." },
  { q: "How much does it cost?", a: "Prices per GB are set per IP class by the operator and are always readable live at /v1/pricing. Read the live endpoint rather than hardcoding a price." },
  { q: "How do I pay?", a: "Per request with x402 or MPP (no account needed), or with prepaid wallet top-ups via Tempo or NOWPayments crypto." },
  { q: "Can the exit node see my HTTPS traffic?", a: "No. HTTPS stays end-to-end TLS between you and the origin. Plain HTTP is refused unless you set allowhttp-1, because the exit node can read it." },
  { q: "What is class-masked?", a: "Exits whose egress the gateway detects as VPN, WARP or Tor. It is the cheapest class and strictly opt-in: unflagged requests never use it." },
  { q: "Which countries are blocked?", a: "OFAC-sanctioned countries: Cuba, Iran, North Korea, Russia and Syria." },
  { q: "How do I run a node and earn?", a: "Run the node agent on a residential, mobile or datacenter connection. You earn 25% (Probation) to 50% (Partner) of paid traffic through your IPs after a 3 to 14 day maturity hold. The gateway verifies the exit class and counts the bytes." },
  { q: "Can I withdraw earnings?", a: "Matured credits convert into bandwidth today. USDC withdrawals are built but disabled during alpha." },
  { q: "How do I report a security issue?", a: "Follow the responsible-disclosure policy in SECURITY.md; the contact is published at /.well-known/security.txt." },
];

export default function FaqPage() {
  return (
    <div className="min-h-screen bg-gray-950 text-gray-300">
      <header className="border-b border-gray-800 px-6 py-4">
        <div className="max-w-4xl mx-auto flex items-center justify-between">
          <Link to="/" className="text-indigo-400 font-bold text-lg">Dominus Node</Link>
          <Link to="/" className="text-sm text-gray-400 hover:text-gray-200">Back to Home</Link>
        </div>
      </header>

      <main className="max-w-4xl mx-auto px-6 py-12">
        <h1 className="text-3xl font-bold text-white mb-8">Frequently Asked Questions</h1>
        <div className="space-y-8 text-sm leading-relaxed">
          {FAQ_ITEMS.map((item) => (
            <section key={item.q}>
              <h2 className="text-xl font-semibold text-white mb-3">{item.q}</h2>
              <p>{item.a}</p>
            </section>
          ))}
        </div>
        <LegalFooterLinks />
      </main>
    </div>
  );
}

export function LegalFooterLinks() {
  const cls = "text-indigo-400 hover:text-indigo-300";
  return (
    <footer className="mt-12 border-t border-gray-800 pt-6 flex gap-6 text-sm">
      <Link to="/terms" className={cls}>Terms</Link>
      <Link to="/aup" className={cls}>Acceptable Use</Link>
      <Link to="/faq" className={cls}>FAQ</Link>
      <Link to="/privacy" className={cls}>Privacy</Link>
    </footer>
  );
}
