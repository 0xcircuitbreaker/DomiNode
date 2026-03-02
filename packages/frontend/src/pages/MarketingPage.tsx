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
  { id: "free-dc", name: "Free DC", pricePerGbCents: 0, pricePerGbUsd: 0, monthlyBandwidthGB: 0.49, maxConnections: 5 },
  { id: "free-res", name: "Free Residential", pricePerGbCents: 0, pricePerGbUsd: 0, monthlyBandwidthGB: 0.05, maxConnections: 5 },
  { id: "payg", name: "Pay As You Go", pricePerGbCents: 500, pricePerGbUsd: 5, monthlyBandwidthGB: null, maxConnections: 100 },
  { id: "vol100", name: "Volume 100GB", pricePerGbCents: 400, pricePerGbUsd: 4, monthlyBandwidthGB: 100, maxConnections: 100 },
  { id: "vol1tb", name: "Volume 1TB", pricePerGbCents: 300, pricePerGbUsd: 3, monthlyBandwidthGB: 1024, maxConnections: 100 },
  { id: "agent", name: "AI Agent", pricePerGbCents: 500, pricePerGbUsd: 5, monthlyBandwidthGB: null, maxConnections: 50 },
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
    detail: "npx @dominusnode/mcp-server",
    summary: "Works with Claude, Gemini, Codex, Cursor, VS Code, and any MCP-compatible AI agent. Zero config bootstrap mode.",
  },
  {
    title: "Agent Authorization",
    detail: "dominusnode_setup",
    summary: "AI agents create accounts, generate API keys, and start proxying through a verified MCP bootstrap flow — subject to spend controls and usage policies.",
  },
  {
    title: "x402 Micropayments",
    detail: "Pay-per-request with USDC",
    summary: "HTTP 402 protocol support. Agents pay via Coinbase (Base chain) or PayAI (Solana) with USDC micropayments. All transactions logged and auditable.",
  },
  {
    title: "11 Cryptocurrencies",
    detail: "BTC / ETH / SOL / XMR + 7 more",
    summary: "Pay with Bitcoin, Ethereum, Solana, Monero, Zcash, USDC, USDT, DAI, BNB, LINK, or Litecoin via NOWPayments. Privacy coins supported for anonymous billing.",
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
    "dominusnode": {
      "command": "npx",
      "args": ["-y", "@dominusnode/mcp-server"]
    }
  }
}`,
  },
  {
    name: "Claude Code",
    config: `claude mcp add dominusnode -- npx -y @dominusnode/mcp-server`,
  },
  {
    name: "Cursor / VS Code",
    config: `{
  "mcp": {
    "servers": {
      "dominusnode": {
        "command": "npx",
        "args": ["-y", "@dominusnode/mcp-server"]
      }
    }
  }
}`,
  },
];

const PROOF_POINTS = [
  { value: "27", label: "AI frameworks supported" },
  { value: "x402", label: "Pay-per-request protocol" },
  { value: "50+", label: "Country routes" },
  { value: "<1s", label: "Agent onboarding" },
];

// ── Payment Methods Data ──────────────────────────────────────────────

interface X402Network {
  name: string;
  facilitator: string;
  token: string;
  note: string;
  tag: "coinbase" | "payai";
}

const X402_NETWORKS: X402Network[] = [
  { name: "Base",      facilitator: "Coinbase",  token: "USDC", note: "EIP-3009 gasless",  tag: "coinbase" },
  { name: "Solana",    facilitator: "PayAI",     token: "USDC", note: "~400ms settlement", tag: "payai" },
  { name: "Polygon",   facilitator: "PayAI",     token: "USDC", note: "PoS sidechain",     tag: "payai" },
  { name: "Avalanche", facilitator: "PayAI",     token: "USDC", note: "C-Chain EVM",       tag: "payai" },
  { name: "Sei",       facilitator: "PayAI",     token: "USDC", note: "High-speed EVM",    tag: "payai" },
  { name: "SKALE",     facilitator: "PayAI",     token: "USDC", note: "Zero gas fees",     tag: "payai" },
  { name: "IoTeX",     facilitator: "PayAI",     token: "USDC", note: "DePIN network",     tag: "payai" },
  { name: "XLayer",    facilitator: "PayAI",     token: "USDC", note: "OKX L2",            tag: "payai" },
  { name: "Peaq",      facilitator: "PayAI",     token: "USDC", note: "DePIN L1",          tag: "payai" },
];

interface CryptoCurrency {
  symbol: string;
  name: string;
}

const NOWPAYMENTS_CURRENCIES: CryptoCurrency[] = [
  { symbol: "BTC",  name: "Bitcoin" },
  { symbol: "ETH",  name: "Ethereum" },
  { symbol: "SOL",  name: "Solana" },
  { symbol: "XMR",  name: "Monero" },
  { symbol: "ZEC",  name: "Zcash" },
  { symbol: "USDC", name: "USD Coin" },
  { symbol: "USDT", name: "Tether" },
  { symbol: "DAI",  name: "Dai" },
  { symbol: "BNB",  name: "BNB" },
  { symbol: "LINK", name: "Chainlink" },
  { symbol: "LTC",  name: "Litecoin" },
];

const WORKFLOW_STEPS = [
  {
    step: "1",
    title: "Create a free account",
    body: "Sign up in seconds with email or an Ethereum wallet — no credit card needed. Choose 2 GB datacenter or 50 MB residential bandwidth free.",
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
    title: "Python SDK: data pipelines and automation",
    summary: "Designed for research and data collection workflows using requests, aiohttp, and data tooling.",
    capabilities: [
      "Session-aware proxy profiles for stable data collection",
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

const ECOSYSTEM_STATS = [
  { value: "27", label: "AI Integrations" },
  { value: "6", label: "Native SDKs" },
  { value: "59+", label: "MCP Tools" },
  { value: "4", label: "Browsers" },
];

interface Integration {
  name: string;
  lang: string;
  tools: number | null;
  desc: string;
}

interface IntegrationCategory {
  name: string;
  description: string;
  integrations: Integration[];
}

const INTEGRATION_CATEGORIES: IntegrationCategory[] = [
  {
    name: "Agent Frameworks",
    description: "Drop-in toolkits for autonomous AI agent platforms",
    integrations: [
      { name: "LangChain", lang: "Python", tools: 7, desc: "BaseToolSpec with native LangChain tools and async support" },
      { name: "CrewAI", lang: "Python", tools: 6, desc: "Multi-agent crew orchestration with geo-targeting awareness" },
      { name: "LlamaIndex", lang: "Python", tools: 24, desc: "BaseToolSpec with FunctionTool objects for RAG pipelines" },
      { name: "AutoGPT", lang: "Python", tools: 24, desc: "Command plugin with dispatcher pattern for autonomous agents" },
      { name: "Agent Zero", lang: "Python", tools: 24, desc: "Numbered tool modules with structured JSON output" },
      { name: "PydanticAI", lang: "Python", tools: 24, desc: "Async tool functions with full type safety" },
      { name: "CAMEL-AI", lang: "Python", tools: 24, desc: "FunctionTool objects for multi-agent orchestration" },
      { name: "MetaGPT", lang: "Python", tools: 24, desc: "DataInterpreter compatible with docstring schema extraction" },
      { name: "SuperAGI", lang: "Python", tools: 24, desc: "Registered toolkit with full command coverage" },
      { name: "Agno", lang: "Python", tools: 24, desc: "Toolkit with x402 micropayment and agentic wallet support" },
      { name: "Semantic Kernel", lang: "Python", tools: 25, desc: "Microsoft kernel functions as a native plugin" },
      { name: "IronClaw", lang: "Python", tools: 25, desc: "NEAR AI Rust agent runtime with native MCP bridge" },
    ],
  },
  {
    name: "Function Calling",
    description: "Schema definitions for LLM function calling APIs",
    integrations: [
      { name: "OpenAI Functions", lang: "JSON / TS / Py", tools: 24, desc: "Cross-platform schemas \u2014 works with Claude, Gemini, Mistral, and Llama" },
      { name: "Gemini / Vertex AI", lang: "TS / Python", tools: 24, desc: "FunctionDeclaration objects for Google Gemini and Vertex AI" },
      { name: "ChatGPT GPT Actions", lang: "OpenAPI", tools: 20, desc: "OpenAPI 3.1.0 spec \u2014 ChatGPT calls the REST API directly" },
      { name: "OpenClaw", lang: "TypeScript", tools: 24, desc: "Runtime skill plugin with dynamic SKILL.md definitions" },
    ],
  },
  {
    name: "AI SDKs & Pipelines",
    description: "Typed libraries for structured AI application development",
    integrations: [
      { name: "Vercel AI SDK", lang: "TypeScript", tools: 8, desc: "Native Vercel AI tool objects with streaming and generateText" },
      { name: "Haystack", lang: "Python", tools: 24, desc: "Pipeline Tool objects for search and retrieval workflows" },
      { name: "Composio", lang: "Python", tools: 24, desc: "Action definitions with standardized DOMINUSNODE_* naming" },
      { name: "Dify", lang: "Python", tools: 24, desc: "Tool provider with YAML definitions and credential management" },
    ],
  },
  {
    name: "Workflow & Low-Code",
    description: "Visual builders and automation platforms",
    integrations: [
      { name: "n8n", lang: "TypeScript", tools: 3, desc: "Community nodes \u2014 Proxy, Wallet, and Usage node types" },
      { name: "Langflow", lang: "Visual", tools: null, desc: "Visual workflow builder with web scraping component" },
      { name: "Flowise", lang: "Visual", tools: null, desc: "Low-code LLM app builder with native Dominus Node node" },
      { name: "TaskWeaver", lang: "Python", tools: null, desc: "Agent coordination framework for complex task planning" },
      { name: "Mastra", lang: "TypeScript", tools: null, desc: "TypeScript AI framework with first-class proxy support" },
      { name: "Moltbook", lang: "Python", tools: 34, desc: "Social network integration with EIP-191 wallet signing" },
      { name: "Kustomai", lang: "Python", tools: null, desc: "Custom AI framework with proxy and billing support" },
    ],
  },
];

const TOOLKIT_FEATURES = [
  {
    title: "MCP Server",
    subtitle: "59+ authenticated tools",
    points: [
      "Bootstrap mode \u2014 agents self-register with zero config",
      "Proxy, billing, wallets, teams, usage, and admin tools",
      "Works with Claude Desktop, Claude Code, Cursor, VS Code, Gemini CLI",
      "x402 micropayments and agentic wallet management",
    ],
  },
  {
    title: "Browser Extension",
    subtitle: "Chrome, Firefox, Edge, Opera",
    points: [
      "Real-time wallet balance tracking with low-balance alerts",
      "WebRTC leak prevention and privacy-first proxy routing",
      "Geo-targeting across 70+ countries with sticky sessions",
      "MFA support, auto-reconnect, and session rotation controls",
    ],
  },
  {
    title: "Native SDKs",
    subtitle: "Node \u00b7 Python \u00b7 Go \u00b7 Java \u00b7 C++ \u00b7 Rust",
    points: [
      "Agentic wallets with spending limits and freeze controls",
      "Team management with shared billing and role-based access",
      "Proxy URL builder with geo-targeting and session pinning",
      "Auto token refresh, rate limit retry, and typed error handling",
    ],
  },
];

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


export default function MarketingPage() {
  const { user } = useAuth();
  const { theme } = useTheme();
  const [selectedSdk, setSelectedSdk] = useState<keyof typeof SDK_DETAILS>("Node");
  const [featuredPlanId, setFeaturedPlanId] = useState(DEFAULT_FEATURED_PLAN_ID);
  const { data: plansData } = useApi<PlansResponse>(() => get("/api/plans", { redirectOnUnauthorized: false }));
  const { data: healthData } = useApi<ProxyHealthResponse>(() => get("/api/proxy/health", { redirectOnUnauthorized: false }));
  const { data: slotsData } = useApi<{ total: number; used: number; remaining: number; unlimited: boolean }>(
    () => get("/api/slots", { redirectOnUnauthorized: false })
  );
  const { data: waitlistData } = useApi<{ pending: number }>(
    () => get("/api/waitlist/count", { redirectOnUnauthorized: false })
  );

  const plans = (plansData?.plans ?? FALLBACK_PLANS)
    .filter((p) => p.id === "free-dc" || p.id === "free-res" || p.id === "payg" || p.id === "vol100" || p.id === "vol1tb" || p.id === "agent")
    .sort((a, b) => a.pricePerGbUsd - b.pricePerGbUsd);

  const registerHref = user ? "/app" : "/login?mode=register";
  const registerLabel = user ? "Open Client Dashboard" : "Create Account";
  const loginHref = "/login";
  const healthStatus = healthData?.status ?? "unknown";
  const marketingHealthStatus = getMarketingHealthStatus(healthStatus);
  const sdkInfo = SDK_DETAILS[selectedSdk];

  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);
  const [alphaDismissed, setAlphaDismissed] = useState(() => {
    try { return localStorage.getItem("dn_alpha_dismissed") === "1"; } catch { return false; }
  });

  function dismissAlpha() {
    setAlphaDismissed(true);
    try { localStorage.setItem("dn_alpha_dismissed", "1"); } catch { /* ignore */ }
  }

  return (
    <div className="marketing-root" data-theme={theme}>
      <NodeNetworkBackground theme={theme} className="mk-node-network" />

      {!alphaDismissed && (
        <div className="mk-alpha-banner">
          <div className="mk-shell mk-alpha-banner-inner">
            <span className="mk-alpha-badge">ALPHA</span>
            <p className="mk-alpha-text">
              {slotsData && !slotsData.unlimited && slotsData.remaining > 0
                ? <>{slotsData.remaining} of {slotsData.total} alpha slots remaining &mdash; join before they fill up.</>
                : slotsData && !slotsData.unlimited && slotsData.remaining === 0
                  ? <>All {slotsData.total} alpha slots filled{waitlistData && waitlistData.pending > 0 ? <> &mdash; {waitlistData.pending} on the waitlist</> : <> &mdash; join the waitlist!</>}</>
                  : <>Limited alpha slots available &mdash; 5,000 slots, 250 datacenter proxies, residential pool access.</>}
            </p>
            <Link to={slotsData && !slotsData.unlimited && slotsData.remaining === 0 ? "/login?waitlist=1" : registerHref} className="mk-alpha-cta">
              {slotsData && !slotsData.unlimited && slotsData.remaining === 0
                ? "Join Waitlist"
                : user ? "Open Dashboard" : "Join Alpha"}
            </Link>
            <button className="mk-alpha-close" onClick={dismissAlpha} aria-label="Dismiss alpha banner">
              &times;
            </button>
          </div>
        </div>
      )}

      <header className="mk-nav">
        <div className="mk-shell mk-nav-inner">
          <Link to="/" className="mk-brand">
            <img src="/logo.svg" alt={BRAND_MARK} className="mk-brand-mark" />
            <span>{BRAND_NAME}</span>
          </Link>

          <nav className="mk-links" aria-label="Primary">
            <a href="#top">Home</a>
            <a href="#services">Services</a>
            <a href="#ai-agents">AI Agents</a>
            <a href="#ecosystem">Ecosystem</a>
            <a href="#platform">Platform</a>
            <a href="#pricing">Pricing</a>
            <a href="#payments">Payments</a>
            <Link to="/docs">Docs</Link>
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
            <a href="#ecosystem" onClick={() => setMobileMenuOpen(false)}>Ecosystem</a>
            <a href="#platform" onClick={() => setMobileMenuOpen(false)}>Platform</a>
            <a href="#pricing" onClick={() => setMobileMenuOpen(false)}>Pricing</a>
            <a href="#payments" onClick={() => setMobileMenuOpen(false)}>Payments</a>
            <Link to="/docs" onClick={() => setMobileMenuOpen(false)}>Docs</Link>
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
            <p className="mk-overline">AI-Native Proxy Infrastructure</p>
            <h1>
              Proxy infrastructure built for AI agents.
            </h1>
          </div>

          <div className="mk-hero-grid">
            <div className="mk-hero-copy mk-animate-up mk-delay-1">
              <p className="mk-subtitle">
                Give your agents authenticated web access through rotating residential and
                datacenter proxies. One MCP command to connect. Pay per request with USDC
                via x402 — with built-in spend controls and usage accountability.
              </p>

              <div className="mk-cta-row">
                <Link to={registerHref} className="mk-button mk-button-solid">
                  Connect Your Agent
                </Link>
                <Link to={loginHref} className="mk-button mk-button-outline">
                  View Documentation
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
              <h2>Zero-config agent connectivity</h2>
              <ul>
                <li>MCP server for Claude, Gemini, Codex, Cursor</li>
                <li>x402 USDC micropayments — no account needed</li>
                <li>EIP-191 wallet auth — no email, no password</li>
                <li>Agent authorization: MCP bootstrap with spend controls</li>
              </ul>
              <pre className="mk-code">
                <code>
                  {`npx @dominusnode/mcp-server`}
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
              <p>Country-level targeting and sticky session controls through authenticated proxy identity.</p>
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

          <div className="mk-service-grid mk-centered-grid mk-centered-4">
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
            <div className="mk-centered-grid mk-centered-3" style={{ gap: "1.5rem" }}>
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
              No API key? Start in bootstrap mode — your AI agent authenticates via MCP,
              generates an API key, and begins proxying under spend controls.
              Free tier includes 2 GB datacenter bandwidth and 5 connections. Subject to <Link to="/aup" style={{ color: "var(--mk-accent)" }}>Acceptable Use Policy</Link>.
            </p>
          </div>
        </section>

        <section id="ecosystem" className="mk-shell mk-section">
          <div className="mk-section-head mk-animate-up">
            <p className="mk-overline">AI Ecosystem</p>
            <h2>Native integrations for every major AI framework</h2>
          </div>

          <div className="mk-ecosystem-stats mk-animate-up mk-delay-1">
            {ECOSYSTEM_STATS.map((stat) => (
              <div key={stat.label} className="mk-eco-stat">
                <span className="mk-eco-stat-value">{stat.value}</span>
                <span className="mk-eco-stat-label">{stat.label}</span>
              </div>
            ))}
          </div>

          <div className="mk-toolkit-grid mk-animate-up mk-delay-2">
            {TOOLKIT_FEATURES.map((tool) => (
              <article key={tool.title} className="mk-toolkit-card">
                <h3>{tool.title}</h3>
                <p className="mk-toolkit-subtitle">{tool.subtitle}</p>
                <ul>
                  {tool.points.map((point) => (
                    <li key={point}>{point}</li>
                  ))}
                </ul>
              </article>
            ))}
          </div>

          {INTEGRATION_CATEGORIES.map((category, catIndex) => (
            <div key={category.name} className={`mk-integration-category mk-animate-up mk-delay-${Math.min(catIndex + 1, 4)}`}>
              <div className="mk-category-header">
                <h3>{category.name}</h3>
                <p>{category.description}</p>
              </div>
              <div className={`mk-integration-grid${category.integrations.length % 4 !== 0 ? " mk-integration-centered" : ""}`}>
                {category.integrations.map((integration) => (
                  <div key={integration.name} className="mk-integration-card">
                    <div className="mk-integration-top">
                      <span className="mk-integration-name">{integration.name}</span>
                      <span className="mk-lang-badge">{integration.lang}</span>
                    </div>
                    {integration.tools !== null && (
                      <span className="mk-tool-count">{integration.tools} tools</span>
                    )}
                    <p className="mk-integration-desc">{integration.desc}</p>
                  </div>
                ))}
              </div>
            </div>
          ))}

          <div className="mk-animate-up mk-delay-3" style={{ marginTop: "2rem", textAlign: "center" }}>
            <p style={{ color: "var(--mk-muted)", maxWidth: "680px", margin: "0 auto" }}>
              Every integration includes SSRF protection, credential scrubbing, OFAC compliance,
              prototype pollution prevention, and response size caps. Security is built in, not bolted on.
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

        <section id="payments" className="mk-shell mk-section">
          <div className="mk-section-head mk-animate-up">
            <p className="mk-overline">Payments</p>
            <h2>Pay with any currency, any chain, any method</h2>
          </div>

          {/* x402 — AI micropayments */}
          <div className="mk-payment-category mk-animate-up mk-delay-1">
            <div className="mk-payment-category-head">
              <div className="mk-payment-category-title">
                <span className="mk-payment-proto-badge">x402 Protocol</span>
                <h3>AI Micropayments &mdash; USDC on 9 chains</h3>
              </div>
              <p>HTTP-native pay-per-request. AI agents pay directly from their wallet with a single
              USDC transfer, no account or subscription required. Verified on-chain before each proxy request.</p>
            </div>
            <div className="mk-chain-grid">
              {X402_NETWORKS.map((chain) => (
                <div key={chain.name} className={`mk-chain-chip mk-chain-${chain.tag}`}>
                  <div className="mk-chain-chip-top">
                    <span className="mk-chain-name">{chain.name}</span>
                    <span className="mk-chain-token">{chain.token}</span>
                  </div>
                  <div className="mk-chain-chip-bottom">
                    <span className="mk-chain-facilitator">{chain.facilitator}</span>
                    <span className="mk-chain-note">{chain.note}</span>
                  </div>
                </div>
              ))}
            </div>
          </div>

          {/* Traditional crypto top-up */}
          <div className="mk-payment-category mk-animate-up mk-delay-2">
            <div className="mk-payment-category-head">
              <div className="mk-payment-category-title">
                <span className="mk-payment-proto-badge mk-payment-proto-crypto">NOWPayments</span>
                <h3>Crypto Wallet Top-Up &mdash; 11 currencies</h3>
              </div>
              <p>Fund your Dominus Node wallet with any major cryptocurrency. Payments are converted to
              wallet credits automatically. Privacy coins (XMR, ZEC) supported for anonymous billing.</p>
            </div>
            <div className="mk-crypto-grid">
              {NOWPAYMENTS_CURRENCIES.map((c) => (
                <div key={c.symbol} className="mk-crypto-pill">
                  <span className="mk-crypto-symbol">{c.symbol}</span>
                  <span className="mk-crypto-name">{c.name}</span>
                </div>
              ))}
            </div>
          </div>

          {/* Fiat */}
          <div className="mk-payment-category mk-animate-up mk-delay-3">
            <div className="mk-payment-category-head">
              <div className="mk-payment-category-title">
                <span className="mk-payment-proto-badge mk-payment-proto-fiat">Fiat</span>
                <h3>Card &amp; PayPal</h3>
              </div>
              <p>Pay with a credit or debit card via Stripe, or use PayPal directly. Stripe Link
              enables one-click checkout for returning customers. All payments convert to wallet credits.</p>
            </div>
            <div className="mk-fiat-grid">
              <div className="mk-fiat-card">
                <span className="mk-fiat-provider">Stripe</span>
                <p className="mk-fiat-detail">Credit / debit card &middot; Stripe Link one-click &middot; All major card networks</p>
              </div>
              <div className="mk-fiat-card">
                <span className="mk-fiat-provider">PayPal</span>
                <p className="mk-fiat-detail">Direct PayPal integration &middot; Lower fees than card &middot; PayPal balance or linked bank</p>
              </div>
            </div>
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
            <h2>Start free with datacenter or residential proxies</h2>
            <p>
              Create your {BRAND_NAME} account in seconds — no credit card required. Get 2 GB datacenter
              or 50 MB residential bandwidth free every month, then scale with transparent per-GB pricing.
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

      <footer className="border-t border-gray-800 py-8 px-6">
        <div className="mk-shell flex flex-col sm:flex-row items-center justify-between gap-4">
          <p className="text-xs text-gray-600">&copy; {new Date().getFullYear()} {BRAND_NAME}. All rights reserved.</p>
          <div className="flex gap-6">
            <Link to="/docs" className="text-xs text-gray-500 hover:text-gray-300 transition-colors">Documentation</Link>
            <Link to="/privacy" className="text-xs text-gray-500 hover:text-gray-300 transition-colors">Privacy Policy</Link>
            <Link to="/terms" className="text-xs text-gray-500 hover:text-gray-300 transition-colors">Terms of Service</Link>
            <Link to="/aup" className="text-xs text-gray-500 hover:text-gray-300 transition-colors">Acceptable Use</Link>
            <a href="mailto:0xcircuitbreaker@protonmail.com" className="text-xs text-gray-500 hover:text-gray-300 transition-colors">Contact</a>
          </div>
        </div>
      </footer>
    </div>
  );
}
