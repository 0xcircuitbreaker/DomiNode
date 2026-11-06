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
    "Generate a per-agent secret (das_xxx) for autonomous operation. The secret replaces MCP_AGENT_SECRET for this agent's subsequent requests — enables CAPTCHA bypass, email auto-verify, and elevated rate limits. Requires authentication. Save the returned secret — it is shown only once.",
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
          `  Set DOMINUSNODE_AGENT_SECRET=${data.agentSecret} in your environment`,
          `  Or pass as X-DominusNode-Agent-Secret header with X-DominusNode-Agent: mcp`,
          ``,
          `This secret is unique to your agent. It enables:`,
          `  - CAPTCHA bypass on all endpoints`,
          `  - Email auto-verification on registration`,
          `  - Elevated rate limits`,
          `  - Max 5 active secrets per account (oldest auto-revoked)`,
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
