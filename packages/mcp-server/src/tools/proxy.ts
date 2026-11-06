import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { HttpClient } from "../http-client.js";
import type { McpConfig } from "../config.js";
import type { ProxyStatus } from "../types.js";
import { fetchPricing, formatPricing, PLAINTEXT_EXPLAINER, type NetworkPolicyResponse } from "./network.js";

export function registerProxyTools(server: McpServer, httpClient: HttpClient, config: McpConfig): void {
  server.tool(
    "dominusnode_get_proxy_config",
    "Get relay proxy connection details for use outside this MCP server (curl, SDKs, browsers): gateway endpoints, " +
      "the username routing flags (country-XX, class-residential|dc|mobile, session-<id>, allowhttp-1), live per-GB prices " +
      "from GET /v1/pricing and the active plaintext/port policy. The API key always goes in the PASSWORD field.",
    {},
    async () => {
      const lines = [
        ...(config.proxyTls ? [`HTTPS proxy (TLS to the gateway, preferred): ${config.proxyHost}:${config.proxyTls.port}`] : []),
        `HTTP proxy: ${config.proxyHost}:${config.httpProxyPort} (CONNECT for https)`,
        `SOCKS5 proxy: ${config.proxyHost}:${config.socks5ProxyPort}`,
        ``,
        `Credentials: username = routing flags, password = your dn_live_ API key`,
        `Username flags (hyphen-joined, any order, all optional):`,
        `  country-XX          exit country, ISO 3166-1 alpha-2 (e.g. country-US)`,
        `  class-residential   exit IP class: residential | dc | mobile`,
        `  session-<id>        sticky exit node for an alphanumeric session id`,
        `  allowhttp-1         permit plaintext http:// (exit-visible)`,
        `Examples:`,
        `  curl -x http://country-US-class-residential:$DOMINUSNODE_API_KEY@${config.proxyHost}:${config.httpProxyPort} https://httpbin.org/ip`,
        `  curl -x http://class-dc-session-abc123:$DOMINUSNODE_API_KEY@${config.proxyHost}:${config.httpProxyPort} https://example.com`,
        ...(config.proxyTls ? [`  curl -x https://relay:$DOMINUSNODE_API_KEY@${config.proxyHost}:${config.proxyTls.port} https://example.com`] : []),
        ``,
      ];
      const [pricing, policy] = await Promise.allSettled([
        fetchPricing(httpClient),
        httpClient.get<NetworkPolicyResponse>("/v1/policy", false),
      ]);
      if (pricing.status === "fulfilled") lines.push(...formatPricing(pricing.value));
      else lines.push("Pricing unavailable right now; use dominusnode_network_pricing.");
      lines.push("");
      if (policy.status === "fulfilled") {
        const b = policy.value.body ?? {};
        lines.push(`Policy v${policy.value.version}: ports ${(b.ports ?? []).join(", ")}, plaintext=${b.plaintext ?? "?"}`);
        lines.push(`Blocked (sanctioned) countries: ${(b.sanctionedCountries ?? []).join(", ") || "none"}`);
      } else {
        lines.push("Policy unavailable right now; use dominusnode_network_policy.");
      }
      lines.push(PLAINTEXT_EXPLAINER);
      return { content: [{ type: "text", text: lines.join("\n") }] };
    },
  );

  server.tool(
    "dominusnode_get_proxy_status",
    "Get live proxy network status including latency, active session count, and uptime.",
    {},
    async () => {
      try {
        const status = await httpClient.get<ProxyStatus>("/api/proxy/status");
        const text = [
          `Status: ${status.status}`,
          `Latency: ${status.avgLatencyMs ?? 0}ms`,
          `Active Sessions: ${status.activeSessions}`,
          `Uptime: ${status.uptimeSeconds ?? 0}s`,
          status.endpoints ? `HTTP: ${status.endpoints.http}` : null,
          status.endpoints ? `SOCKS5: ${status.endpoints.socks5}` : null,
        ].filter(Boolean).join("\n");
        return { content: [{ type: "text", text }] };
      } catch (err) {
        return {
          isError: true,
          content: [{ type: "text", text: `Error: ${err instanceof Error ? err.message : String(err)}` }],
        };
      }
    },
  );
}
