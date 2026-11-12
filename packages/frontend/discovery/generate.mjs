// Single source of truth for the public site's agent-discovery files.
//
//   node packages/frontend/discovery/generate.mjs            -> rewrite packages/frontend/public (default origin)
//   generateDiscovery(origin) / writeDiscovery(dir, origin)  -> used by the Vite plugin at build time
//
// The markdown pages in public/docs/*.md are hand-written; they reference the
// default origin, which is rewritten to VITE_PUBLIC_ORIGIN at build time.
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const DEFAULT_ORIGIN = "https://dominusnode.com";
export const API_BASE = "https://api.dominusnode.com";
export const GITHUB = "https://github.com/0xcircuitbreaker/DomiNode";
export const DDG = "https://daedalusdevelopmentgroup.com";
const HERE = dirname(fileURLToPath(import.meta.url));
export const PUBLIC_DIR = resolve(HERE, "../public");

/** Markdown pages, in llms-full.txt order. */
export const DOCS = [
  { path: "/docs/agents.md", title: "Agent quickstart", note: "endpoints, x402/MPP or prepaid wallet, username flags, SDK snippets" },
  { path: "/docs/payments.md", title: "Pricing and payments", note: "pricing model (live from /v1/pricing), rails, node earnings and payouts status" },
  { path: "/docs/policy.md", title: "Policy and abuse controls", note: "node floor, sanctions, metadata-only logging, reporting abuse" },
  { path: "/docs/api.md", title: "API overview", note: "public and /v1 agent routes" },
  { path: "/docs/mcp.md", title: "MCP server setup", note: "install block, bootstrap mode, tool groups" },
  { path: "/docs/nodes.md", title: "Node agent setup", note: "contribute an IP, tiers, maturity holds, run commands" },
];

/** Crawlers explicitly allowed on public pages (admin is disallowed for everyone). */
export const AI_CRAWLERS = [
  "GPTBot", "OAI-SearchBot", "ChatGPT-User", "ClaudeBot", "Claude-User", "Claude-SearchBot", "anthropic-ai",
  "PerplexityBot", "Perplexity-User", "Google-Extended", "Googlebot", "Bingbot", "CCBot", "Applebot-Extended",
  "Meta-ExternalAgent", "Amazonbot", "DuckAssistBot", "cohere-ai", "MistralAI-User",
];

const PRIVATE = ["/admin", "/login", "/forgot-password", "/reset-password", "/verify-email"];

export function rewriteOrigin(text, origin) {
  return origin === DEFAULT_ORIGIN ? text : text.split(DEFAULT_ORIGIN).join(origin);
}

function llmsTxt(origin) {
  return [
    "# DominusNode",
    "",
    "> DominusNode is a decentralized relay network built for AI agents only. Agents buy HTTP, HTTPS and SOCKS5 egress through residential, mobile and datacenter IPs that other agents contribute, paying per request with x402 or MPP (no signup) or from a prepaid crypto wallet. Agents that run the node agent earn a tier-based share (25% at Probation to 50% at Partner) of the paid traffic that leaves through their IP, and buy relay bandwidth at a tier discount (0% to 25%). Alpha: earnings accrue as credits; USDC payouts on Base stay off until the operator enables them. Prices are live at " + `${API_BASE}/v1/pricing` + "; never hardcode them. A Daedalus Development Group product.",
    "",
    "Gateway: proxy.dominusnode.com (HTTP 8080, SOCKS5 1080, TLS proxy 8443). API: " + API_BASE + " (the SDKs and the MCP server use this API by default). API key in the proxy password; username flags country-XX, class-residential|dc|mobile, session-<id>, allowhttp-1 (hyphen-joined, or `relay` for none).",
    "",
    "## Docs",
    "",
    ...DOCS.map((d) => `- [${d.title}](${origin}${d.path}): ${d.note}`),
    "",
    "## API",
    "",
    `- [Live pricing](${API_BASE}/v1/pricing): per-class list price in µUSD per GB, tier node shares, tier buyer discounts, enabled rails (JSON, no auth)`,
    `- [Network policy](${API_BASE}/v1/policy): active policy, version hash and node floor guarantees (JSON, no auth)`,
    `- [Network stats](${API_BASE}/v1/network/stats): aggregate online nodes by class and country (JSON, no auth)`,
    `- [Network history](${API_BASE}/v1/network/history): hourly aggregate snapshots (JSON, no auth)`,
    `- [Wanted](${API_BASE}/v1/network/wanted): countries and classes where requesters found no node (JSON, no auth)`,
    `- [Status page](${API_BASE}/status): human-readable network status`,
    `- [Abuse reports](${origin}/docs/policy.md): POST ${API_BASE}/v1/abuse-reports, no account, proof-of-work gated`,
    `- [API llms.txt](${API_BASE}/llms.txt): the API host's own summary with live prices`,
    `- [Agent tool manifest](${API_BASE}/.well-known/agent-tool.json): machine-readable endpoints, auth and pricing`,
    "",
    "## Tools",
    "",
    `- [MCP server](${origin}/.well-known/mcp/server.json): npm package @dominusnode/mcp-server, stdio, 65 tools (11 without a key)`,
    `- [SDKs](${GITHUB}/tree/master/sdks): Node.js, Python, Go, Rust, Java, C++ (contract: sdks/SDK_SURFACE.md)`,
    `- [Framework integrations](${GITHUB}/tree/master/integrations): 27 frameworks, same 19-tool set`,
    "",
    "## Optional",
    "",
    `- [Full docs in one file](${origin}/llms-full.txt)`,
    `- [Source code](${GITHUB})`,
    `- [Design docs](${GITHUB}/tree/master/docs/agent-network)`,
    `- [Daedalus Development Group](${DDG})`,
    "",
  ].join("\n");
}

function llmsFull(origin, publicDir) {
  const parts = [
    "# DominusNode: full documentation for agents",
    "",
    `> Concatenation of the markdown pages linked from ${origin}/llms.txt. Prices are never included: read ${API_BASE}/v1/pricing.`,
    "",
  ];
  for (const d of DOCS) {
    const body = readFileSync(join(publicDir, d.path), "utf8").trim();
    parts.push(`<!-- source: ${origin}${d.path} -->`, "", body, "", "---", "");
  }
  return rewriteOrigin(parts.join("\n"), origin);
}

function robotsTxt(origin) {
  const dis = PRIVATE.map((p) => `Disallow: ${p}`);
  const lines = ["# DominusNode public site. AI crawlers are welcome on public pages.", ""];
  for (const bot of AI_CRAWLERS) lines.push(`User-agent: ${bot}`);
  lines.push("Allow: /", ...dis, "", "User-agent: *", "Allow: /", ...dis, "", `Sitemap: ${origin}/sitemap.xml`, "");
  return lines.join("\n");
}

function sitemapXml(origin) {
  const urls = ["/", "/quickstart", "/run-a-node", "/self-host", "/pricing", "/report-abuse", "/llms.txt", "/llms-full.txt", ...DOCS.map((d) => d.path), "/terms", "/privacy", "/aup"];
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">',
    ...urls.map((u) => `  <url><loc>${origin}${u}</loc></url>`),
    "</urlset>",
    "",
  ].join("\n");
}

function mcpServerJson(mcpVersion) {
  // MCP Registry server.json (https://github.com/modelcontextprotocol/registry, docs/reference/server-json).
  return JSON.stringify({
    $schema: "https://static.modelcontextprotocol.io/schemas/2025-12-11/server.schema.json",
    name: "io.github.0xcircuitbreaker/dominusnode",
    title: "DominusNode",
    description: "Relay network for AI agents: fetch through agent-contributed IPs, run nodes, track earnings and wallets.",
    version: mcpVersion,
    websiteUrl: DEFAULT_ORIGIN,
    repository: { url: GITHUB, source: "github", subfolder: "packages/mcp-server" },
    packages: [
      {
        registryType: "npm",
        registryBaseUrl: "https://registry.npmjs.org",
        identifier: "@dominusnode/mcp-server",
        version: mcpVersion,
        runtimeHint: "npx",
        transport: { type: "stdio" },
        environmentVariables: [
          { name: "DOMINUSNODE_API_KEY", description: "dn_live_ API key. Omit to start in bootstrap mode.", isRequired: false, isSecret: true, format: "string" },
          { name: "DOMINUSNODE_API_URL", description: "API base URL", isRequired: false, isSecret: false, format: "string", default: API_BASE },
        ],
      },
    ],
  }, null, 2) + "\n";
}

function readMcpVersion() {
  try {
    return JSON.parse(readFileSync(resolve(HERE, "../../mcp-server/package.json"), "utf8")).version ?? "0.0.0";
  } catch {
    return "0.0.0";
  }
}

/** Returns {relativePath: content} for every generated file. */
export function generateDiscovery(origin = DEFAULT_ORIGIN, publicDir = PUBLIC_DIR) {
  return {
    "llms.txt": llmsTxt(origin),
    "llms-full.txt": llmsFull(origin, publicDir),
    "robots.txt": robotsTxt(origin),
    "sitemap.xml": sitemapXml(origin),
    ".well-known/mcp/server.json": rewriteOrigin(mcpServerJson(readMcpVersion()), origin),
  };
}

export function writeDiscovery(outDir, origin = DEFAULT_ORIGIN) {
  // Markdown pages first, so llms-full.txt is built from the rewritten copies' sources.
  for (const d of DOCS) {
    const src = join(PUBLIC_DIR, d.path);
    const dst = join(outDir, d.path);
    mkdirSync(dirname(dst), { recursive: true });
    writeFileSync(dst, rewriteOrigin(readFileSync(src, "utf8"), origin));
  }
  for (const [rel, content] of Object.entries(generateDiscovery(origin))) {
    const p = join(outDir, rel);
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, content);
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (!existsSync(PUBLIC_DIR)) throw new Error(`missing ${PUBLIC_DIR}`);
  for (const [rel, content] of Object.entries(generateDiscovery())) {
    const p = join(PUBLIC_DIR, rel);
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, content);
  }
  console.log("discovery files written to", PUBLIC_DIR);
}
