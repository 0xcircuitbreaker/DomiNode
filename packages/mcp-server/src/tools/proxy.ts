import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { HttpClient } from "../http-client.js";
import type { ProxyConfig, ProxyStatus } from "../types.js";

export function registerProxyTools(server: McpServer, httpClient: HttpClient): void {
  server.tool(
    "dominusnode_get_proxy_config",
    "Get proxy endpoint configuration including HTTP/SOCKS5 endpoints, supported countries, pricing, and username format for geo-targeting.",
    {},
    async () => {
      try {
        const config = await httpClient.get<ProxyConfig>("/api/proxy/config");
        const text = [
          `HTTP Endpoint: ${config.httpProxy.host}:${config.httpProxy.port}`,
          `SOCKS5 Endpoint: ${config.socks5Proxy.host}:${config.socks5Proxy.port}`,
          ``,
          `Pricing:`,
          `  Datacenter Pool: $3.00/GB (prefix: dc-)`,
          `  Residential Pool: $5.00/GB (prefix: residential-)`,
          `  Auto (default): tries DC first, falls back to residential`,
          ``,
          `Username Format: <pool>-country-<CC>:<api_key>`,
          `  Examples: dc-country-US:<key>  |  residential-country-DE:<key>  |  auto:<key>`,
          ``,
          `Supported Countries: ${config.supportedCountries?.join(", ") ?? "all"}`,
          `Blocked Countries (OFAC): ${config.blockedCountries?.join(", ") ?? "none"}`,
          `Geo-Targeting: Country: yes, State: ${config.geoTargeting?.stateSupport ? "yes" : "no"}, City: ${config.geoTargeting?.citySupport ? "yes" : "no"}`,
        ].join("\n");
        return { content: [{ type: "text", text }] };
      } catch (err) {
        return {
          isError: true,
          content: [{ type: "text", text: `Error: ${err instanceof Error ? err.message : String(err)}` }],
        };
      }
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
