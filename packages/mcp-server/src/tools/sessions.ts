import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { HttpClient } from "../http-client.js";
import type { ActiveSession } from "../types.js";

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

export function registerSessionsTools(server: McpServer, httpClient: HttpClient): void {
  server.tool(
    "dominusnode_get_active_sessions",
    "Get all active proxy sessions showing target hosts, bandwidth used, and geo-targeting.",
    {},
    async () => {
      try {
        const data = await httpClient.get<{ sessions: ActiveSession[] }>("/api/sessions/active");
        const sessions = data.sessions ?? [];
        if (sessions.length === 0) {
          return { content: [{ type: "text", text: "No active proxy sessions." }] };
        }
        const lines = sessions.map(
          (s) => `${s.id.substring(0, 8)}... | ${s.target_host} | In: ${formatBytes(s.bytes_in)} Out: ${formatBytes(s.bytes_out)} | Country: ${s.country ?? "any"} | Since: ${s.started_at}`,
        );
        lines.unshift(`Active Sessions (${sessions.length}):`);
        return { content: [{ type: "text", text: lines.join("\n") }] };
      } catch (err) {
        return {
          isError: true,
          content: [{ type: "text", text: `Error: ${err instanceof Error ? err.message : String(err)}` }],
        };
      }
    },
  );
}
