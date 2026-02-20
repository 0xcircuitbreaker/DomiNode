import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { HttpClient } from "../http-client.js";
import type { ProxyConfig, ProxyStatus } from "../types.js";

export function registerProxyTools(server: McpServer, httpClient: HttpClient): void {
  server.tool(
    "dominusnode_get_proxy_config",
    "Get proxy endpoint configuration including HTTP/SOCKS5 endpoints, supported countries, and username format for geo-targeting.",
    {},
    async () => {
      try {
        const config = await httpClient.get<ProxyConfig>("/api/proxy/config");
        const text = [
          `HTTP Endpoint: ${config.httpEndpoint}`,
          `SOCKS5 Endpoint: ${config.socks5Endpoint}`,
          `Username Format: ${config.usernameFormat}`,
          `Supported Countries: ${config.supportedCountries?.join(", ") ?? "all"}`,
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
    "Get live proxy network status including latency, active providers, and session count.",
    {},
    async () => {
      try {
        const status = await httpClient.get<ProxyStatus>("/api/proxy/status");
        const text = [
          `Status: ${status.status}`,
          `Latency: ${status.latencyMs}ms`,
          `Providers: ${status.providers?.join(", ") ?? "unknown"}`,
          `Active Sessions: ${status.activeSessions}`,
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
}
