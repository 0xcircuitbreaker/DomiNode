import { useState } from "react";
import { Link } from "react-router-dom";
import { useAuth } from "../context/AuthContext";
import { useTheme } from "../context/ThemeContext";
import { useApi } from "../hooks/useApi";
import { get } from "../api/client";
import ThemeToggle from "../components/ThemeToggle";
import NodeNetworkBackground from "../components/NodeNetworkBackground";
import { BRAND_MARK, BRAND_NAME } from "../config/branding";
import "./MarketingPage.css";

interface PlanItem {
  id: string;
  name: string;
  pricePerGbCents: number;
  pricePerGbUsd: number;
  monthlyBandwidthGB: number | null;
  maxConnections: number;
}

interface PlansResponse {
  plans: PlanItem[];
}

interface ProxyHealthResponse {
  status: "operational" | "degraded" | "down" | "unknown";
}

const FALLBACK_PLANS: PlanItem[] = [
  { id: "free", name: "Free", pricePerGbCents: 0, pricePerGbUsd: 0, monthlyBandwidthGB: 1, maxConnections: 10 },
  { id: "payg", name: "Pay As You Go", pricePerGbCents: 500, pricePerGbUsd: 5, monthlyBandwidthGB: null, maxConnections: 100 },
  { id: "vol100", name: "Volume 100GB", pricePerGbCents: 400, pricePerGbUsd: 4, monthlyBandwidthGB: 100, maxConnections: 100 },
  { id: "vol1tb", name: "Volume 1TB", pricePerGbCents: 300, pricePerGbUsd: 3, monthlyBandwidthGB: 1024, maxConnections: 100 },
  { id: "agent", name: "AI Agent", pricePerGbCents: 500, pricePerGbUsd: 5, monthlyBandwidthGB: 5, maxConnections: 50 },
];
const DEFAULT_FEATURED_PLAN_ID = "vol1tb";

const SERVICE_PILLARS = [
  {
    title: "Residential Proxy Access",
    summary: "Premium IP routing with geographic targeting and sticky session controls for stable automation workloads.",
  },
  {
    title: "Enterprise Billing",
    summary: "Wallet-backed reservations, per-byte settlement, and invoice-ready payment records with Stripe and crypto rails.",
  },
  {
    title: "Security Hardening",
    summary: "MFA, session governance, key rotation workflows, and traffic guardrails for high-trust operational environments.",
  },
  {
    title: "Operational Telemetry",
    summary: "Live usage analytics, session visibility, host-level reporting, and export-friendly data for engineering teams.",
  },
];

const AI_AGENT_FEATURES = [
  {
    title: "One-Line Install",
    detail: "npx @dominode/mcp-server",
    summary: "Works with Claude, Gemini, Codex, Cursor, VS Code, and any MCP-compatible AI agent. Zero config bootstrap mode.",
  },
  {
    title: "Agent Self-Signup",
    detail: "dominode_setup",
    summary: "AI agents create their own accounts, generate API keys, and start proxying — no human intervention required.",
  },
  {
    title: "x402 Micropayments",
    detail: "Pay-per-request with USDC",
    summary: "HTTP 402 protocol support. Agents pay with Coinbase Agentic Wallets — no signup, no API key, just USDC on Base chain.",
  },
  {
    title: "Privacy Coin Billing",
    detail: "XMR / ZEC / BTC",
    summary: "Anonymous payments via Monero and Zcash. No identity linked to your proxy traffic. The only agent proxy with true payment anonymity.",
  },
  {
    title: "Wallet-Verified Registration",
    detail: "EIP-191 Signature Auth",
    summary: "Agents register with an Ethereum wallet signature — no email, no password. Cryptographic proof of identity for autonomous operation.",
  },
];

const PLATFORM_CONFIGS = [
  {
    name: "Claude Desktop",
    config: `{
  "mcpServers": {
    "dominode": {
      "command": "npx",
      "args": ["-y", "@dominode/mcp-server"]
    }
  }
}`,
  },
  {
    name: "Claude Code",
    config: `claude mcp add dominode -- npx -y @dominode/mcp-server`,
  },
  {
    name: "Cursor / VS Code",
    config: `{
  "mcp": {
    "servers": {
      "dominode": {
        "command": "npx",
        "args": ["-y", "@dominode/mcp-server"]
      }
    }
  }
}`,
  },
];

const PROOF_POINTS = [
  { value: "HTTP + SOCKS5", label: "Protocol support" },
  { value: "100+", label: "Country routes upstream" },
  { value: "50", label: "API keys per account" },
  { value: "24/7", label: "Platform monitoring" },
];

const WORKFLOW_STEPS = [
  {
    step: "1",
    title: "Create a free account",
    body: "Sign up in seconds with email or an Ethereum wallet — no credit card needed. Get 10 residential proxy connections and 1 GB of bandwidth immediately.",
  },
  {
    step: "2",
    title: "Issue API credentials",
    body: "Generate keys, enforce security policies, and control traffic by region and session strategy.",
  },
  {
    step: "3",
    title: "Scale traffic safely",
    body: "Run production requests with usage telemetry, balance guardrails, and provider-level resilience.",
  },
];

interface SdkInfo {
  title: string;
  summary: string;
  capabilities: string[];
}

const SDK_DETAILS: Record<string, SdkInfo> = {
  Node: {
    title: "Node SDK: high-throughput request orchestration",
    summary: "Built for async workloads with connection reuse and easy integration into queue workers.",
    capabilities: [
      "Reusable proxy client config for worker pools",
      "Country/session targeting helpers for sticky workflows",
      "Structured telemetry hooks for retry and failover monitoring",
    ],
  },
  Python: {
    title: "Python SDK: data pipelines and scraping control",
    summary: "Designed for research and crawling stacks using requests, aiohttp, and data tooling.",
    capabilities: [
      "Session-aware proxy profiles for stable crawling",
      "Simple hooks for pandas/ETL ingestion paths",
      "Config primitives for region and rotation policies",
    ],
  },
  Go: {
    title: "Go SDK: low-latency service integrations",
    summary: "Suitable for concurrent backend services where predictable throughput and memory use matter.",
    capabilities: [
      "Lightweight client wrappers around net/http",
      "Concurrency-friendly proxy session handling",
      "Operational controls for timeout and retry strategy",
    ],
  },
  Java: {
    title: "Java SDK: enterprise service compatibility",
    summary: "Focused on JVM production systems with clear configuration boundaries and resilient transport behavior.",
    capabilities: [
      "Works with standard HttpClient and OkHttp stacks",
      "Policy-driven endpoint and region selection",
      "Integration points for enterprise observability systems",
    ],
  },
  "C++": {
    title: "C++ SDK: performance-critical workloads",
    summary: "Targets environments that require tight control over networking, latency, and memory behavior.",
    capabilities: [
      "Direct proxy auth and connection primitives",
      "Fine-grained timeout and retry configuration",
      "Predictable runtime profile for systems-level tooling",
    ],
  },
  Rust: {
    title: "Rust SDK: safety-first network execution",
    summary: "Built for teams prioritizing reliability and compile-time guarantees in proxy-integrated services.",
    capabilities: [
      "Typed config models for endpoint targeting",
      "Async runtime support for high concurrency",
      "Error-safe request flows for robust automation",
    ],
  },
};

function formatBandwidth(limitGb: number | null): string {
  if (limitGb === null || limitGb === 0) return "Unlimited";
  if (limitGb >= 1024) return `${(limitGb / 1024).toFixed(0)} TB / month`;
  return `${limitGb.toFixed(0)} GB / month`;
}

function getHealthText(status: ProxyHealthResponse["status"]): string {
  if (status === "operational") return "Operational";
  if (status === "degraded") return "Degraded";
  if (status === "down") return "Down";
  return "Unknown";
}

function getMarketingHealthStatus(status: ProxyHealthResponse["status"]): ProxyHealthResponse["status"] {
  // Marketing view intentionally suppresses "degraded" to avoid alarm-state messaging on the landing page.
  if (status === "degraded") return "operational";
  return status;
}

function getMarketingProxyEndpoint(): string {
  const env = (import.meta as { env?: Record<string, string | undefined> }).env;
  const configuredHost = env?.VITE_PROXY_PUBLIC_HOST?.trim() || "proxy.dominode.io";
  if (configuredHost.includes(":")) return configuredHost;
  const configuredPort = env?.VITE_PROXY_HTTP_PORT?.trim() || "8080";
  return `${configuredHost}:${configuredPort}`;
}

export default function MarketingPage() {
  const { user } = useAuth();
  const { theme } = useTheme();
  const [selectedSdk, setSelectedSdk] = useState<keyof typeof SDK_DETAILS>("Node");
  const [featuredPlanId, setFeaturedPlanId] = useState(DEFAULT_FEATURED_PLAN_ID);
  const { data: plansData } = useApi<PlansResponse>(() => get("/api/plans", { redirectOnUnauthorized: false }));
  const { data: healthData } = useApi<ProxyHealthResponse>(() => get("/api/proxy/health", { redirectOnUnauthorized: false }));

  const plans = (plansData?.plans ?? FALLBACK_PLANS)
    .filter((p) => p.id === "free" || p.id === "payg" || p.id === "vol100" || p.id === "vol1tb" || p.id === "agent")
    .sort((a, b) => a.pricePerGbUsd - b.pricePerGbUsd);

  const registerHref = user ? "/app" : "/login?mode=register";
  const registerLabel = user ? "Open Client Dashboard" : "Create Account";
  const loginHref = "/login";
  const healthStatus = healthData?.status ?? "unknown";
  const marketingHealthStatus = getMarketingHealthStatus(healthStatus);
  const sdkInfo = SDK_DETAILS[selectedSdk];
  const marketingProxyEndpoint = getMarketingProxyEndpoint();

  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);

  return (
    <div className="marketing-root" data-theme={theme}>
      <NodeNetworkBackground theme={theme} className="mk-node-network" />
      <header className="mk-nav">
        <div className="mk-shell mk-nav-inner">
          <Link to="/" className="mk-brand">
            <span className="mk-brand-mark">{BRAND_MARK}</span>
            <span>{BRAND_NAME}</span>
          </Link>

          <nav className="mk-links" aria-label="Primary">
            <a href="#top">Home</a>
            <a href="#services">Services</a>
            <a href="#ai-agents">AI Agents</a>
            <a href="#platform">Platform</a>
            <a href="#security">Security</a>
            <a href="#pricing">Pricing</a>
          </nav>

          <div className="mk-nav-actions">
            <ThemeToggle compact className="mk-theme-toggle" />
            <Link to={loginHref} className="mk-link-btn">
              Login
            </Link>
            <Link to={registerHref} className="mk-button mk-button-solid">
              {registerLabel}
            </Link>
            <button
              className={`mk-hamburger${mobileMenuOpen ? " mk-hamburger-open" : ""}`}
              onClick={() => setMobileMenuOpen(!mobileMenuOpen)}
              aria-label="Toggle menu"
              aria-expanded={mobileMenuOpen}
            >
              <span />
            </button>
          </div>
        </div>
      </header>

      {/* Mobile slide-down menu */}
      {mobileMenuOpen && (
        <div className="mk-mobile-menu">
          <nav className="mk-mobile-menu-links">
            <a href="#top" onClick={() => setMobileMenuOpen(false)}>Home</a>
            <a href="#services" onClick={() => setMobileMenuOpen(false)}>Services</a>
            <a href="#ai-agents" onClick={() => setMobileMenuOpen(false)}>AI Agents</a>
            <a href="#platform" onClick={() => setMobileMenuOpen(false)}>Platform</a>
            <a href="#security" onClick={() => setMobileMenuOpen(false)}>Security</a>
            <a href="#pricing" onClick={() => setMobileMenuOpen(false)}>Pricing</a>
          </nav>
          <div className="mk-mobile-menu-actions">
            <Link to={loginHref} className="mk-button mk-button-outline" onClick={() => setMobileMenuOpen(false)}>
              Login
            </Link>
            <Link to={registerHref} className="mk-button mk-button-solid" onClick={() => setMobileMenuOpen(false)}>
              {registerLabel}
            </Link>
          </div>
        </div>
      )}

      <main>
        <section id="top" className="mk-shell mk-hero">
          <div className="mk-hero-head mk-animate-up">
            <p className="mk-overline">Premium Proxy Infrastructure</p>
            <h1>
              {BRAND_NAME} is enterprise proxy infrastructure, built for privacy.
            </h1>
          </div>

          <div className="mk-hero-grid">
            <div className="mk-hero-copy mk-animate-up mk-delay-1">
              <p className="mk-subtitle">
                Launch high-trust traffic through a hardened control plane with resilient routing,
                transparent economics, and production-grade observability. Start free with 10 proxy
                connections and 1 GB of residential bandwidth — no credit card required.
              </p>

              <div className="mk-cta-row">
                <Link to={registerHref} className="mk-button mk-button-solid">
                  {registerLabel}
                </Link>
                <Link to={loginHref} className="mk-button mk-button-outline">
                  Login to Dashboard
                </Link>
              </div>

              <div className="mk-trust-strip" role="list" aria-label="Platform highlights">
                {PROOF_POINTS.map((item) => (
                  <div key={item.label} className="mk-trust-item" role="listitem">
                    <span className="mk-trust-value">{item.value}</span>
                    <span className="mk-trust-label">{item.label}</span>
                  </div>
                ))}
              </div>
            </div>

            <aside className="mk-hero-panel mk-animate-up mk-delay-2">
              <div className="mk-status-row">
                <span className={`mk-status-dot mk-status-${marketingHealthStatus}`} />
                <span className="mk-status-label">Network status: {getHealthText(marketingHealthStatus)}</span>
              </div>
              <h2>Control plane tuned for production traffic</h2>
              <ul>
                <li>Per-provider circuit breakers and fallback routing policies</li>
                <li>Wallet reservations before request execution</li>
                <li>Usage analytics with CSV exports and top-host visibility</li>
                <li>Admin security operations for account governance</li>
              </ul>
              <pre className="mk-code">
                <code>
                  {`curl -x http://country-US-session-x7:dn_live_KEY@${marketingProxyEndpoint} https://httpbin.org/ip`}
                </code>
              </pre>
            </aside>
          </div>
        </section>

        <section id="services" className="mk-shell mk-section">
          <div className="mk-section-head mk-animate-up">
            <p className="mk-overline">Services</p>
            <h2>What {BRAND_NAME} sells as a premium proxy platform</h2>
          </div>

          <div className="mk-service-grid">
            {SERVICE_PILLARS.map((pillar, index) => (
              <article key={pillar.title} className={`mk-card mk-animate-up mk-delay-${index + 1}`}>
                <h3>{pillar.title}</h3>
                <p>{pillar.summary}</p>
              </article>
            ))}
          </div>
        </section>

        <section id="platform" className="mk-shell mk-section">
          <div className="mk-section-head mk-animate-up">
            <p className="mk-overline">Platform</p>
            <h2>Built for scale, predictability, and operator confidence</h2>
          </div>

          <div className="mk-card-grid">
            <article className="mk-card mk-animate-up mk-delay-1">
              <h3>Routing precision</h3>
              <p>Country, state, city, and sticky session targeting through authenticated proxy identity controls.</p>
            </article>
            <article className="mk-card mk-animate-up mk-delay-2">
              <h3>Transparent economics</h3>
              <p>Plan-aware pricing, reservation holds, and settlement records aligned to byte-level usage metering.</p>
            </article>
            <article className="mk-card mk-animate-up mk-delay-3">
              <h3>Resilience by design</h3>
              <p>Provider selection, retry strategies, and cooldown logic for graceful recovery under upstream instability.</p>
            </article>
            <article className="mk-card mk-animate-up mk-delay-4">
              <h3>Operator tooling</h3>
              <p>Dashboard telemetry, active session management, billing workflows, and policy enforcement controls.</p>
            </article>
          </div>
        </section>

        <section id="security" className="mk-shell mk-section">
          <div className="mk-section-head mk-animate-up">
            <p className="mk-overline">Security</p>
            <h2>Controls expected in regulated and enterprise environments</h2>
          </div>

          <div className="mk-security-grid">
            <div className="mk-security-item mk-animate-up mk-delay-1">
              <h3>Identity and session security</h3>
              <p>JWT rotation with reuse detection, secure cookie auth for web clients, and optional MFA with backup codes.</p>
            </div>
            <div className="mk-security-item mk-animate-up mk-delay-2">
              <h3>Traffic guardrails</h3>
              <p>SSRF protections, DNS rebinding defense, geo sanctions enforcement, and configurable request limits.</p>
            </div>
            <div className="mk-security-item mk-animate-up mk-delay-3">
              <h3>Governance and admin control</h3>
              <p>Suspend accounts, revoke API credentials, and terminate active sessions from an admin control surface.</p>
            </div>
          </div>
        </section>

        <section id="ai-agents" className="mk-shell mk-section">
          <div className="mk-section-head mk-animate-up">
            <p className="mk-overline">AI Agent Proxy</p>
            <h2>Give your AI agents autonomous proxy access in 30 seconds</h2>
          </div>

          <div className="mk-service-grid">
            {AI_AGENT_FEATURES.map((feat, index) => (
              <article key={feat.title} className={`mk-card mk-animate-up mk-delay-${index + 1}`}>
                <h3>{feat.title}</h3>
                <pre className="mk-code" style={{ marginBottom: "0.75rem", fontSize: "0.8rem" }}>
                  <code>{feat.detail}</code>
                </pre>
                <p>{feat.summary}</p>
              </article>
            ))}
          </div>

          <div className="mk-animate-up mk-delay-2" style={{ marginTop: "3rem" }}>
            <h3 style={{ textAlign: "center", marginBottom: "1.5rem" }}>Quick Setup for Every Platform</h3>
            <div className="mk-card-grid" style={{ gap: "1.5rem" }}>
              {PLATFORM_CONFIGS.map((platform) => (
                <article key={platform.name} className="mk-card">
                  <h3>{platform.name}</h3>
                  <pre className="mk-code" style={{ fontSize: "0.75rem", overflowX: "auto" }}>
                    <code>{platform.config}</code>
                  </pre>
                </article>
              ))}
            </div>
          </div>

          <div className="mk-animate-up mk-delay-3" style={{ marginTop: "2rem", textAlign: "center" }}>
            <p style={{ color: "var(--mk-muted)", maxWidth: "600px", margin: "0 auto 1.5rem" }}>
              No API key? No problem. Start in bootstrap mode — your AI agent creates its own account
              with <code>dominode_setup</code>, generates an API key, and starts proxying immediately.
              Free tier includes 1 GB bandwidth and 10 connections.
            </p>
          </div>
        </section>

        <section id="pricing" className="mk-shell mk-section">
          <div className="mk-section-head mk-animate-up">
            <p className="mk-overline">Pricing</p>
            <h2>Start free. Scale when ready.</h2>
          </div>

          <div
            className="mk-pricing-grid"
            onMouseLeave={() => setFeaturedPlanId(DEFAULT_FEATURED_PLAN_ID)}
            onBlurCapture={(event) => {
              const nextFocusTarget = event.relatedTarget;
              if (!(nextFocusTarget instanceof HTMLElement) || !event.currentTarget.contains(nextFocusTarget)) {
                setFeaturedPlanId(DEFAULT_FEATURED_PLAN_ID);
              }
            }}
          >
            {plans.map((plan) => (
              <article
                key={plan.id}
                className={`mk-price-card mk-animate-up ${plan.id === featuredPlanId ? "mk-price-card-featured" : ""}`}
                onMouseEnter={() => setFeaturedPlanId(plan.id)}
                onMouseLeave={() => setFeaturedPlanId(DEFAULT_FEATURED_PLAN_ID)}
                onFocusCapture={() => setFeaturedPlanId(plan.id)}
              >
                <p className="mk-price-name">{plan.name}</p>
                <p className="mk-price-value">
                  {plan.pricePerGbCents === 0
                    ? <>$0<span>/forever</span></>
                    : <>${plan.pricePerGbUsd.toFixed(2)}<span>/GB</span></>}
                </p>
                <p className="mk-price-cap">
                  {plan.pricePerGbCents === 0
                    ? `${plan.maxConnections} proxies \u00b7 ${formatBandwidth(plan.monthlyBandwidthGB)}`
                    : formatBandwidth(plan.monthlyBandwidthGB)}
                </p>
                {plan.pricePerGbCents === 0 && (
                  <p className="mk-price-note">No credit card required</p>
                )}
                <Link to={registerHref} className="mk-button mk-button-outline">
                  {plan.pricePerGbCents === 0 ? "Get Started Free" : "Choose Plan"}
                </Link>
              </article>
            ))}
          </div>
        </section>

        <section className="mk-shell mk-section">
          <div className="mk-workflow mk-animate-up">
            <div className="mk-section-head">
              <p className="mk-overline">Launch Path</p>
              <h2>From account creation to production traffic in three steps</h2>
            </div>

            <div className="mk-workflow-grid">
              {WORKFLOW_STEPS.map((step) => (
                <article key={step.step} className="mk-work-item">
                  <span className="mk-work-step">{step.step}</span>
                  <h3>{step.title}</h3>
                  <p>{step.body}</p>
                </article>
              ))}
            </div>
          </div>
        </section>

        <section className="mk-shell mk-section">
          <div className="mk-stack mk-animate-up">
            <p className="mk-overline">Developer Access</p>
            <h2>Integrate from your existing stack</h2>
            <div className="mk-sdk-list" role="tablist" aria-label="SDK selector">
              {Object.keys(SDK_DETAILS).map((sdk) => (
                <button
                  key={sdk}
                  type="button"
                  id={`sdk-tab-${sdk.toLowerCase().replace(/\+/g, "plus")}`}
                  role="tab"
                  aria-controls="sdk-detail-panel"
                  aria-selected={selectedSdk === sdk}
                  className={`mk-sdk-pill ${selectedSdk === sdk ? "mk-sdk-pill-active" : ""}`}
                  onClick={() => setSelectedSdk(sdk as keyof typeof SDK_DETAILS)}
                >
                  {sdk}
                </button>
              ))}
            </div>
            <div
              id="sdk-detail-panel"
              className="mk-sdk-detail"
              role="tabpanel"
              aria-labelledby={`sdk-tab-${selectedSdk.toLowerCase().replace(/\+/g, "plus")}`}
              aria-live="polite"
            >
              <h3>{sdkInfo.title}</h3>
              <p>{sdkInfo.summary}</p>
              <ul>
                {sdkInfo.capabilities.map((capability) => (
                  <li key={capability}>{capability}</li>
                ))}
              </ul>
            </div>
          </div>
        </section>

        <section className="mk-shell mk-final-cta">
          <div className="mk-final-card mk-animate-up">
            <h2>Start with 10 free residential proxies</h2>
            <p>
              Create your {BRAND_NAME} account in seconds — no credit card required. Get 1 GB of residential
              proxy bandwidth free every month, then scale with transparent per-GB pricing.
            </p>
            <div className="mk-cta-row">
              <Link to={registerHref} className="mk-button mk-button-solid">
                {registerLabel}
              </Link>
              <Link to={loginHref} className="mk-button mk-button-outline">
                Login
              </Link>
            </div>
          </div>
        </section>
      </main>
    </div>
  );
}
