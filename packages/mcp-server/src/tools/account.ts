import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { HttpClient } from "../http-client.js";
import type { AccountInfo } from "../types.js";

/**
 * Account tools for AI agents. Email/password registration, login, password
 * changes and email verification are human flows (admin-only behind
 * ADMIN_HUMAN_LOGIN) and are intentionally not exposed. Agents authenticate
 * with an API key or wallet signature (see wallet-auth tools).
 */
export function registerAccountTools(server: McpServer, httpClient: HttpClient): void {
  server.tool(
    "dominusnode_get_account_info",
    "Get account details including email, admin status, and email verification.",
    {},
    async () => {
      try {
        const info = await httpClient.get<AccountInfo>("/api/auth/me");
        const user = info.user;
        const text = [
          `User ID: ${user.id}`,
          `Email: ${user.email}`,
          `Email Verified: ${user.email_verified ? "yes" : "no"}`,
          `Admin: ${user.is_admin ? "yes" : "no"}`,
          user.wallet_address ? `Wallet: ${user.wallet_address}` : null,
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

  server.tool(
    "dominusnode_create_agent_secret",
    "Generate a per-agent secret (das_...) that marks this agent's API requests as a verified agent, which raises its " +
      "API rate limits. Set it as DOMINUSNODE_AGENT_SECRET for this MCP server (sent as X-DominusNode-Agent-Secret). " +
      "It does not bypass brute-force protections. Max 5 active secrets per account; the oldest is revoked. " +
      "Requires authentication. Shown only once.",
    {
      label: z.string().max(100).default("mcp-agent").describe("Human-readable label for the agent secret"),
    },
    async (args) => {
      try {
        const data = await httpClient.post<{
          id: string;
          agentSecret: string;
          label: string;
          createdAt: string;
        }>("/api/agent/secret", { label: args.label });

        const text = [
          `Agent secret created!`,
          ``,
          `Secret (save now — shown only once):`,
          `  ${data.agentSecret}`,
          ``,
          `ID: ${data.id}`,
          `Label: ${data.label}`,
          ``,
          `Usage:`,
          `  Set DOMINUSNODE_AGENT_SECRET=<the secret above> in this MCP server's environment and restart it`,
          `  (MCP_AGENT_SECRET is accepted as an alias). Other clients send it as the`,
          `  X-DominusNode-Agent-Secret header together with X-DominusNode-Agent: mcp.`,
          ``,
          `Effect: requests are treated as a verified agent (higher API rate limits).`,
          `Max 5 active secrets per account; the oldest is revoked automatically.`,
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
