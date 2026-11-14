import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { HttpClient } from "../http-client.js";

/** GET /v1/pricing response (µUSD per GB, node share in basis points). */
export interface NetworkPricing {
  currency: string;
  unit: string;
  prices: Array<{ ipClass: string; pricePerGbMusd: string }>;
  nodeShare: Array<{ tier: string; rank: number; nodeShareBps: number }>;
  maturationHours: number;
  rails: string[];
}

/** GET /v1/policy response. `body` mirrors shared NetworkPolicy. */
export interface NetworkPolicyResponse {
  version: number;
  sha256: string;
  body: {
    ports?: number[];
    plaintext?: "deny" | "opt_in" | "allow";
    sanctionedCountries?: string[];
    requesterLimits?: { reqPerSec?: number; dailySpendMusd?: number };
    nodeDefaults?: { maxStreams?: number; maxGbDay?: number };
    attestation?: { minVersion?: number; text?: string };
    denyCategories?: string[];
    denyDomains?: string[];
    logRetentionDays?: number;
    nodeCapsPerPrefix?: { per32?: number; per24?: number; perAsn?: number };
    freeTierRelay?: boolean;
  };
  floorGuarantees?: string[];
}

/** GET /v1/status response (public, aggregate; no IPs or ids). */
export interface NetworkStatus {
  status: "operational" | "degraded" | "down" | "unknown";
  coordinator: { status: string; policyVersion: number | null };
  gateway: { status: string; instancesOnline: number; lastHeartbeatAt: string | null };
  availability: { last24h: number | null; last7d: number | null };
  nodes: { onlineNodes: number; byClass?: Record<string, number> } | null;
  incidents: Array<{ title: string; severity: string; status: string; startedAt: string; resolvedAt: string | null }>;
  generatedAt: string;
}

const pct = (v: number | null | undefined) => (typeof v === "number" ? `${v}%` : "n/a");

export interface NetworkStats {
  onlineNodes: number;
  byClass: Record<string, number>;
  byCountry: Array<{ country: string; online: number }>;
  otherCountries: number;
  generatedAt: string;
}

/** Format a µUSD amount as dollars ("500000" -> "$0.50"). Non-numeric input -> "?". */
export function formatMusd(musd: string | number): string {
  const n = typeof musd === "number" ? musd : Number(musd);
  if (!Number.isFinite(n) || n < 0) return "?";
  const usd = n / 1_000_000;
  return `$${usd < 0.01 && usd > 0 ? usd.toFixed(4) : usd.toFixed(2)}`;
}

function bpsToPct(bps: number): string {
  return Number.isFinite(bps) ? `${(bps / 100).toFixed(bps % 100 === 0 ? 0 : 2)}%` : "?";
}

/** Human-readable pricing block built from live GET /v1/pricing data. */
export function formatPricing(p: NetworkPricing): string[] {
  const lines = ["Requester price per GB (live, from GET /v1/pricing):"];
  for (const row of p.prices ?? []) lines.push(`  class-${row.ipClass}: ${formatMusd(row.pricePerGbMusd)}/GB`);
  if (!p.prices?.length) lines.push("  (no classes priced)");
  return lines;
}

export function formatTiers(p: NetworkPricing): string[] {
  const tiers = [...(p.nodeShare ?? [])].sort((a, b) => a.rank - b.rank);
  const lines = ["Node operator share of each GB relayed, by tier:"];
  for (const t of tiers) lines.push(`  ${t.rank}. ${t.tier}: ${bpsToPct(t.nodeShareBps)}`);
  if (!tiers.length) lines.push("  (no tiers configured)");
  return lines;
}

export async function fetchPricing(httpClient: HttpClient): Promise<NetworkPricing> {
  return httpClient.get<NetworkPricing>("/v1/pricing", false);
}

function errorResult(err: unknown) {
  return {
    isError: true,
    content: [{ type: "text" as const, text: `Error: ${err instanceof Error ? err.message : String(err)}` }],
  };
}

export const PLAINTEXT_EXPLAINER =
  "Plaintext http:// is exit-visible: the node operator relaying it can read and alter the traffic. " +
  "Under policy plaintext=opt_in you must set the allowhttp-1 username flag (allow_http=true in dominusnode_fetch); " +
  "responses then carry X-DominusNode-Exit-Visible: 1. https:// is end-to-end TLS through a CONNECT tunnel and the node only sees the hostname.";

export function registerNetworkTools(server: McpServer, httpClient: HttpClient): void {
  server.tool(
    "dominusnode_network_policy",
    "Get the active relay network policy (GET /v1/policy, public): which destination ports nodes will dial (only 80/443, ever), " +
      "plaintext HTTP mode (deny | opt_in via allowhttp-1 | allow), requester rate/spend limits, sanctioned countries, node defaults, " +
      "the attestation text node operators sign, and the fixed node-floor guarantees (no private/loopback/metadata targets, no SMTP/SSH/RDP). " +
      "Read this before fetching or registering a node.",
    {},
    async () => {
      try {
        const p = await httpClient.get<NetworkPolicyResponse>("/v1/policy", false);
        const b = p.body ?? {};
        const lines = [
          `Network Policy v${p.version} (sha256 ${String(p.sha256).slice(0, 16)}…)`,
          ``,
          `Destination ports: ${(b.ports ?? []).join(", ") || "none"}`,
          `Plaintext HTTP: ${b.plaintext ?? "unknown"}`,
          `  ${PLAINTEXT_EXPLAINER}`,
          `Requester limits: ${b.requesterLimits?.reqPerSec ?? "?"} req/s, daily spend cap ${
            b.requesterLimits?.dailySpendMusd !== undefined ? formatMusd(b.requesterLimits.dailySpendMusd) : "?"
          }`,
          `Relay for free-plan requesters: ${b.freeTierRelay ? "yes" : "no (paid balance required)"}`,
          `Sanctioned countries (no exits, no nodes): ${(b.sanctionedCountries ?? []).join(", ") || "none"}`,
          `Denied categories: ${(b.denyCategories ?? []).length}, denied domains: ${(b.denyDomains ?? []).length}`,
          `Node defaults: ${b.nodeDefaults?.maxStreams ?? "?"} streams, ${b.nodeDefaults?.maxGbDay ?? "?"} GB/day`,
          `Node caps per prefix: /32=${b.nodeCapsPerPrefix?.per32 ?? "?"}, /24=${b.nodeCapsPerPrefix?.per24 ?? "?"}, ASN=${b.nodeCapsPerPrefix?.perAsn ?? "?"}`,
          `Connection-metadata log retention: ${b.logRetentionDays ?? "?"} days`,
          ``,
          `Attestation v${b.attestation?.minVersion ?? "?"} (signed by node owners at registration):`,
          `  ${b.attestation?.text ?? "(none)"}`,
          ``,
          `Node floor guarantees (cannot be changed by policy):`,
          ...(p.floorGuarantees ?? []).map((g) => `  - ${g}`),
        ];
        return { content: [{ type: "text", text: lines.join("\n") }] };
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  server.tool(
    "dominusnode_network_pricing",
    "Get live relay pricing (GET /v1/pricing, public): the per-GB price requesters pay for each IP class (residential, dc, mobile), " +
      "the share of that price paid to the node operator at each tier (Probation 25% up to Partner 50%), how long earnings take to mature, " +
      "and the enabled payment rails. Prices are admin-set; never assume a fixed number.",
    {},
    async () => {
      try {
        const p = await fetchPricing(httpClient);
        const lines = [
          ...formatPricing(p),
          ``,
          ...formatTiers(p),
          ``,
          `Earnings mature after ${p.maturationHours} hours before they count as available credit.`,
          `Payment rails: ${(p.rails ?? []).join(", ") || "none"}`,
          ``,
          `Earn by contributing IPs: run the node agent (dominusnode_node_setup_guide). Traffic you or your team`,
          `send through your own nodes is self-dealing and earns nothing.`,
        ];
        return { content: [{ type: "text", text: lines.join("\n") }] };
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  server.tool(
    "dominusnode_network_stats",
    "Get aggregate relay network capacity (GET /v1/network/stats, public): nodes online in the last 5 minutes, by IP class and by country. " +
      "Countries with fewer than 3 nodes are folded into 'other'. Use this to pick a country/class that has exits before fetching.",
    {},
    async () => {
      try {
        const s = await httpClient.get<NetworkStats>("/v1/network/stats", false);
        const lines = [
          `Online nodes: ${s.onlineNodes}`,
          `By class: ${Object.entries(s.byClass ?? {}).map(([k, v]) => `${k}=${v}`).join(", ") || "none"}`,
          `By country: ${(s.byCountry ?? []).map((c) => `${c.country}=${c.online}`).join(", ") || "none"}`,
          `Other countries (groups < 3): ${s.otherCountries ?? 0}`,
          `Generated at: ${s.generatedAt}`,
        ];
        return { content: [{ type: "text", text: lines.join("\n") }] };
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  server.tool(
    "dominusnode_status",
    "Get live network status (GET /v1/status, public): overall status, gateway and coordinator health, 24h/7d gateway availability, " +
      "online node count and open incidents. Check this first when a fetch fails with no eligible node or the proxy is unreachable.",
    {},
    async () => {
      try {
        const s = await httpClient.get<NetworkStatus>("/v1/status", false);
        const open = (s.incidents ?? []).filter((i) => i.status !== "resolved");
        const lines = [
          `Status: ${s.status}`,
          `Gateway: ${s.gateway?.status ?? "unknown"} (${s.gateway?.instancesOnline ?? 0} online)`,
          `Coordinator: ${s.coordinator?.status ?? "unknown"}${s.coordinator?.policyVersion != null ? ` (policy v${s.coordinator.policyVersion})` : ""}`,
          `Availability: 24h ${pct(s.availability?.last24h)}, 7d ${pct(s.availability?.last7d)}`,
          `Online nodes: ${s.nodes ? s.nodes.onlineNodes : "unavailable"}`,
          open.length
            ? `Open incidents:\n${open.map((i) => `  - [${i.severity}] ${i.title} (${i.status}, since ${i.startedAt})`).join("\n")}`
            : "Open incidents: none",
          `Generated at: ${s.generatedAt}`,
        ];
        return { content: [{ type: "text", text: lines.join("\n") }] };
      } catch (err) {
        return errorResult(err);
      }
    },
  );
}
