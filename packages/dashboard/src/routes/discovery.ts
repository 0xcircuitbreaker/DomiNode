import { Router } from "express";
import type { Request, Response } from "express";
import { createLogger, policyRepo, BLOCKED_COUNTRY_CODES, getPublicProxyPorts } from "@dominusnode/shared";

/**
 * Agent discovery documents (v2): /.well-known/agent-tool.json and /llms.txt.
 *
 * Everything that can change at runtime (prices, tier shares, maturation) is
 * read live from network_pricing / node_tiers / revenue_split_config. Nothing
 * here mentions email/password signup, pool prefixes or plan tiers: agents
 * authenticate with a wallet signature or an API key, or pay per request with
 * x402/MPP and no signup at all.
 */
const log = createLogger("api:discovery");
const router = Router();

export interface DiscoveryEnv {
  baseUrl: string;
  proxyHost: string;
  httpPort: string;
  socks5Port: string;
  /** HTTPS proxy port when the TLS listener is on, else null. */
  tlsPort?: string | null;
  x402Enabled: boolean;
  rails: string[];
}

export interface DiscoveryPricing {
  prices: Array<{ ipClass: string; pricePerGbMusd: bigint }>;
  tiers: Array<{ name: string; rank: number; nodeShareBps: number; holdDays?: number; buyerDiscountBps?: number }>;
  maturationHours: number;
}

export function discoveryEnv(env: NodeJS.ProcessEnv = process.env): DiscoveryEnv {
  const rails = (env["NETWORK_PAYMENT_RAILS"] ?? "wallet,x402,crypto")
    .split(",").map((s) => s.trim()).filter((s) => /^[a-z0-9_-]{1,32}$/.test(s)).slice(0, 16);
  return {
    baseUrl: (env["APP_URL"] ?? "https://dominusnode.com").replace(/\/+$/, ""),
    proxyHost: env["PROXY_PUBLIC_HOST"] ?? "proxy.dominusnode.com",
    httpPort: String(getPublicProxyPorts(env).http),
    socks5Port: String(getPublicProxyPorts(env).socks5),
    tlsPort: getPublicProxyPorts(env).tls !== null ? String(getPublicProxyPorts(env).tls) : null,
    x402Enabled: env["X402_ENABLED"] === "true",
    rails,
  };
}

/** µUSD bigint → "0.500000" (6 decimal places, no float math). */
export function musdToUsd(m: bigint): string {
  const neg = m < 0n;
  const a = neg ? -m : m;
  return `${neg ? "-" : ""}${a / 1_000_000n}.${(a % 1_000_000n).toString().padStart(6, "0")}`;
}

/** Build the v2 machine-readable tool card. Pure: inputs are the live DB rows. */
export function buildAgentToolDocument(env: DiscoveryEnv, p: DiscoveryPricing): Record<string, unknown> {
  const b = env.baseUrl;
  const proxy = `${env.proxyHost}`;
  return {
    schema_version: "2.0.0",
    name: "Dominus Node",
    description:
      "Relay network for AI agents: an agent-contributed exit network with an operator-run gateway (federation planned). Agents buy bandwidth through the gateway and exit through IPs other agents contribute; agents that run a node earn a share of the paid traffic that leaves through their IPs. Alpha: payouts are off until legal review, earnings accrue as credits.",
    homepage: b,
    audience: "ai_agents",
    status: "alpha",

    auth: {
      methods: ["wallet_signature", "api_key", "x402", "mpp"],
      wallet_signature: {
        description: "EIP-191 personal_sign over a server nonce creates or reuses a wallet-identity agent principal.",
        challenge: `${b}/api/auth/wallet/challenge`,
        verify: `${b}/api/auth/wallet/verify`,
      },
      api_key: {
        description: "dn_live_ API key, created with the wallet JWT; sent as the proxy credential (after the colon) or as Authorization: Bearer on /v1.",
        create: `${b}/api/keys`,
        prefix: "dn_live_",
      },
      no_signup: {
        description: "x402 or MPP per-request payment: no account, no key. Send the request to the gateway, receive 402 with payment requirements, retry with the payment header.",
        x402_enabled: env.x402Enabled,
        info: `${b}/api/x402/info`,
      },
    },

    proxy: {
      ...(env.tlsPort ? { https: `https://{username}:{api_key}@${proxy}:${env.tlsPort}` } : {}),
      http: `http://{username}:{api_key}@${proxy}:${env.httpPort}`,
      plaintext_warning: `Ports ${env.httpPort} (http) and ${env.socks5Port} (socks5) send the API key in clear; prefer the https proxy when listed.`,
      socks5: `socks5h://{username}:{api_key}@${proxy}:${env.socks5Port}`,
      username: {
        format: "hyphen-joined flags, or 'relay' for none",
        flags: {
          "country-XX": "ISO 3166-1 alpha-2 exit country",
          "class-residential|dc|mobile": "exit IP class",
          "session-<id>": "sticky exit for up to 10 minutes",
          "allowhttp-1": "allow plaintext http:// (readable by the exit node)",
        },
        examples: ["relay", "country-US-class-residential", "country-DE-class-dc-session-abc123"],
      },
      tls: "HTTPS stays end-to-end TLS through the exit node; the gateway never sees payloads.",
      example: env.tlsPort
        ? `curl -x https://country-US-class-residential:$DOMINUSNODE_API_KEY@${proxy}:${env.tlsPort} https://httpbin.org/ip`
        : `curl -x http://country-US-class-residential:$DOMINUSNODE_API_KEY@${proxy}:${env.httpPort} https://httpbin.org/ip`,
      blocked_countries: [...BLOCKED_COUNTRY_CODES].sort(),
    },

    pricing: {
      source: `${b}/v1/pricing`,
      currency: "USD",
      unit: "per_gb",
      per_gb: p.prices.map((x) => ({
        ip_class: x.ipClass,
        price_per_gb_musd: x.pricePerGbMusd.toString(),
        price_per_gb_usd: musdToUsd(x.pricePerGbMusd),
      })),
      minimum_purchase: "none",
      payment_rails: env.rails,
      note: "Prices are admin-tunable and read live from the network pricing table; always re-read /v1/pricing before quoting.",
    },

    earn: {
      description: "Run packages/node-agent to contribute a residential, mobile or datacenter IP. Paid traffic from other agents earns a tier-based share, held for a maturity period, then convertible to wallet balance.",
      node_share: p.tiers.map((t) => ({ tier: t.name, rank: t.rank, node_share_bps: t.nodeShareBps, ...(t.holdDays !== undefined ? { hold_days: t.holdDays } : {}) })),
      buyer_discount: {
        description: "Contribute IPs to climb tiers: earn more and buy cheaper. Agents that run nodes buy relay bandwidth at their owner-tier discount, funded from the platform share (node earnings are unchanged).",
        by_tier: p.tiers.map((t) => ({ tier: t.name, rank: t.rank, buyer_discount_bps: t.buyerDiscountBps ?? 0 })),
      },
      maturation_hours: p.maturationHours,
      register_challenge: `${b}/v1/nodes/challenge`,
      register: `${b}/v1/nodes`,
      tier: `${b}/v1/node/tier`,
      credits: `${b}/v1/credits`,
      wanted: `${b}/v1/network/wanted`,
    },

    policy: {
      url: `${b}/v1/policy`,
      description: "Active network policy with version and SHA-256; the node floor (SSRF/private-range blocking, payload-free logs) cannot be switched off.",
      contribution_requirement: "policy.requireContribution: when true, API-key agents need an active node with matured paid traffic (or an admin allowlist entry) to buy bandwidth (403 CONTRIBUTION_REQUIRED). policy.allowAnonymousPayers governs x402/MPP payers (403 ANONYMOUS_PAYERS_DISABLED).",
      starter_credits: `${b}/v1/starter-credits`,
    },

    network: {
      stats: `${b}/v1/network/stats`,
      history: `${b}/v1/network/history`,
      status_page: `${b}/status`,
      incidents: `${b}/v1/network/incidents`,
    },

    announcements: {
      url: `${b}/v1/announcements`,
      description: "Changelog / news feed of policy, pricing, payment-rail, API and network changes. Public; poll with ?since=<last publishedAt>.",
    },

    abuse: {
      report: `${b}/v1/abuse-reports`,
      challenge: `${b}/v1/abuse-reports/challenge`,
      description: "Report abuse through an exit IP: proof-of-work gated, no account needed. Stores destination host, time window and a description only.",
    },

    integrations: {
      mcp_server: { npm: "@dominusnode/mcp-server", run: "npx -y @dominusnode/mcp-server", registry_name: "io.github.0xcircuitbreaker/dominusnode" },
      sdks: {
        node: "@dominusnode/sdk",
        python: "dominusnode",
        rust: "dominusnode",
        go: "github.com/Dominus-Node/dominusnode-go",
        java: "com.dominusnode:dominusnode-java",
        cpp: "dominusnode-cpp",
      },
      surface: "sdks/SDK_SURFACE.md (v2)",
    },

    errors: {
      structured: true,
      header: "X-DominusNode-Error",
      codes: [
        "INSUFFICIENT_BALANCE", "NO_NODES_AVAILABLE", "SANCTIONED_COUNTRY", "TARGET_BLOCKED", "POLICY_DENIED",
        "TOO_MANY_CONNECTIONS", "CONTRIBUTION_REQUIRED", "ANONYMOUS_PAYERS_DISABLED", "PAYER_SANCTIONED",
        "X402_PAYMENT_INVALID", "MPP_PAYMENT_INVALID",
      ],
    },

    contact: { security: `${b}/.well-known/security.txt` },
  };
}

/** Plain-text summary for LLM crawlers (llms.txt convention). */
export function buildLlmsTxt(env: DiscoveryEnv, p: DiscoveryPricing): string {
  const b = env.baseUrl;
  const prices = p.prices.map((x) => `- ${x.ipClass}: $${musdToUsd(x.pricePerGbMusd)}/GB`).join("\n");
  const shares = p.tiers.map((t) => `${t.name} ${(t.nodeShareBps / 100).toFixed(0)}%`).join(", ");
  return [
    "# Dominus Node",
    "",
    "> Relay network for AI agents only: an agent-contributed exit network with an operator-run gateway (federation planned). Agents buy bandwidth through the gateway; agents that run a node earn a share of the paid traffic that exits through their IPs. Alpha: earnings convert into bandwidth today; USDC withdrawals are built but disabled.",
    "",
    "## Use it",
    `- No signup: pay per request with x402 or MPP at the gateway (${env.proxyHost}:${env.httpPort}).`,
    `- Or sign in with a wallet signature (${b}/api/auth/wallet/challenge) and create a dn_live_ API key.`,
    "- Proxy username: hyphen-joined flags country-XX, class-residential|dc|mobile, session-<id>, allowhttp-1; use 'relay' for none.",
    `- MCP server: npx -y @dominusnode/mcp-server. SDKs: @dominusnode/sdk (Node), dominusnode (Python, Rust), Go, Java, C++.`,
    "",
    "## Pricing (live from the network pricing table)",
    prices,
    `- Source of truth: ${b}/v1/pricing`,
    "",
    "## Earn",
    `- Run packages/node-agent; node share by tier: ${shares}. Earnings mature after a hold.`,
    `- Contribute IPs to climb tiers: earn more and buy cheaper (buyer discount by tier: ${p.tiers.map((t) => `${t.name} ${((t.buyerDiscountBps ?? 0) / 100).toFixed(0)}%`).join(", ")}).`,
    `- Wanted countries/classes: ${b}/v1/network/wanted`,
    "",
    "## Policy and status",
    `- Policy: ${b}/v1/policy`,
    `- Network stats: ${b}/v1/network/stats, history: ${b}/v1/network/history, status page: ${b}/status`,
    `- Abuse reports: ${b}/v1/abuse-reports`,
    `- Announcements (policy/pricing/API changes): ${b}/v1/announcements`,
    "",
  ].join("\n");
}

async function loadPricing(): Promise<DiscoveryPricing> {
  const [prices, tiers, split] = await Promise.all([policyRepo.listPricing(), policyRepo.listTiers(), policyRepo.getSplit()]);
  return {
    prices: prices.map((x) => ({ ipClass: x.ipClass, pricePerGbMusd: x.pricePerGbMusd })),
    tiers: tiers.map((t) => ({ name: t.name, rank: t.rank, nodeShareBps: t.nodeShareBps, holdDays: t.holdDays, buyerDiscountBps: t.buyerDiscountBps })),
    maturationHours: split.maturationHours,
  };
}

function publicCache(res: Response): void {
  res.setHeader("Cache-Control", "public, max-age=60");
  res.removeHeader("Pragma");
}

router.get("/.well-known/agent-tool.json", async (_req: Request, res: Response) => {
  try {
    const doc = buildAgentToolDocument(discoveryEnv(), await loadPricing());
    publicCache(res);
    res.json(doc);
  } catch (err) {
    log.error("discovery document failed", { error: err instanceof Error ? err.message : String(err) });
    res.status(503).json({ error: "Discovery document unavailable" });
  }
});

router.get("/llms.txt", async (_req: Request, res: Response) => {
  try {
    const txt = buildLlmsTxt(discoveryEnv(), await loadPricing());
    publicCache(res);
    res.type("text/plain; charset=utf-8").send(txt);
  } catch (err) {
    log.error("llms.txt failed", { error: err instanceof Error ? err.message : String(err) });
    res.status(503).type("text/plain").send("unavailable\n");
  }
});

export default router;
