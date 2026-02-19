import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { HttpClient } from "../http-client.js";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function registerTeamsTools(server: McpServer, httpClient: HttpClient): void {
  server.tool(
    "dominusnode_create_team",
    "Create a new team. Teams share a wallet and API keys. Optionally set a max member limit.",
    {
      name: z.string().min(1).max(100).describe("Team name"),
      max_members: z.number().int().min(1).max(1000).optional().describe("Maximum number of team members (default: no limit)"),
    },
    async (args) => {
      try {
        const body: Record<string, unknown> = { name: args.name };
        if (args.max_members !== undefined) {
          body.maxMembers = args.max_members;
        }

        const data = await httpClient.post<{
          id: string;
          name: string;
          ownerId: string;
          maxMembers: number | null;
          status: string;
          walletId: string;
          createdAt: string;
          balanceCents?: number;
        }>("/api/teams", body);

        const text = [
          `Team Created`,
          ``,
          `Team ID: ${data.id}`,
          `Name: ${data.name}`,
          `Max Members: ${data.maxMembers ?? "Unlimited"}`,
          `Balance: $${((data.balanceCents ?? 0) / 100).toFixed(2)}`,
          `Created: ${data.createdAt}`,
          ``,
          `Next steps:`,
          `  1. Use dominusnode_team_add_member to invite members by email`,
          `  2. Use dominusnode_team_fund to add funds from your personal wallet`,
          `  3. Use dominusnode_team_create_key to create a shared API key`,
        ].join("\n");

        return { content: [{ type: "text", text }] };
      } catch (err) {
        return {
          isError: true,
          content: [{ type: "text", text: `Error creating team: ${err instanceof Error ? err.message : String(err)}` }],
        };
      }
    },
  );

  server.tool(
    "dominusnode_list_teams",
    "List all teams you belong to, with roles and balances.",
    {},
    async () => {
      try {
        const data = await httpClient.get<{
          teams: Array<{
            id: string;
            name: string;
            ownerId: string;
            maxMembers: number | null;
            status: string;
            role: string;
            balanceCents: number;
            memberCount?: number;
            createdAt: string;
          }>;
        }>("/api/teams");

        if (data.teams.length === 0) {
          return {
            content: [{ type: "text", text: "No teams found. Use dominusnode_create_team to create one." }],
          };
        }

        const lines = [
          `Teams (${data.teams.length})`,
          ``,
        ];

        for (const t of data.teams) {
          lines.push(`  ${t.name} (${t.id.slice(0, 8)}...)`);
          const memberInfo = t.memberCount !== undefined ? ` | Members: ${t.memberCount}` : "";
          lines.push(`    Role: ${t.role} | Balance: $${(t.balanceCents / 100).toFixed(2)}${memberInfo}`);
          lines.push(``);
        }

        return { content: [{ type: "text", text: lines.join("\n") }] };
      } catch (err) {
        return {
          isError: true,
          content: [{ type: "text", text: `Error listing teams: ${err instanceof Error ? err.message : String(err)}` }],
        };
      }
    },
  );

  server.tool(
    "dominusnode_team_details",
    "Get detailed info about a team including balance, members, and settings.",
    {
      team_id: z.string().regex(UUID_RE).describe("Team ID"),
    },
    async (args) => {
      try {
        const data = await httpClient.get<{
          id: string;
          name: string;
          ownerId: string;
          maxMembers: number | null;
          status: string;
          role: string;
          balanceCents: number;
          createdAt: string;
          // members/memberCount are NOT returned by GET /api/teams/:id
          members?: Array<{
            userId: string;
            email: string;
            role: string;
            joinedAt: string;
          }>;
        }>(`/api/teams/${encodeURIComponent(args.team_id)}`);

        const members = data.members ?? [];

        const lines = [
          `Team: ${data.name}`,
          ``,
          `Team ID: ${data.id}`,
          `Owner: ${data.ownerId}`,
          `Status: ${data.status}`,
          `Your Role: ${data.role}`,
          `Balance: $${(data.balanceCents / 100).toFixed(2)}`,
          `Max Members: ${data.maxMembers ?? "Unlimited"}`,
          `Created: ${data.createdAt}`,
        ];

        if (members.length > 0) {
          lines.push(``, `Members (${members.length}):`);
          for (const m of members) {
            lines.push(`  ${m.email} — ${m.role} (joined ${m.joinedAt})`);
          }
        } else {
          lines.push(``, `Use dominusnode_team_add_member to view and manage members.`);
        }

        return { content: [{ type: "text", text: lines.join("\n") }] };
      } catch (err) {
        return {
          isError: true,
          content: [{ type: "text", text: `Error fetching team details: ${err instanceof Error ? err.message : String(err)}` }],
        };
      }
    },
  );

  server.tool(
    "dominusnode_team_add_member",
    "Add a member to a team by their email address. Optionally assign a role (default: member).",
    {
      team_id: z.string().regex(UUID_RE).describe("Team ID"),
      email: z.string().email().describe("Email address of the user to add"),
      role: z.enum(["member", "admin"]).optional().describe("Role to assign: 'admin' or 'member'. Default: 'member'"),
    },
    async (args) => {
      try {
        const body: Record<string, unknown> = { email: args.email };
        if (args.role !== undefined) {
          body.role = args.role;
        }

        const data = await httpClient.post<{
          id: string;
          teamId: string;
          userId: string;
          role: string;
          joinedAt: string;
        }>(`/api/teams/${encodeURIComponent(args.team_id)}/members`, body);

        const text = `Member added to team ${args.team_id}\nMember ID: ${data.id}\nUser ID: ${data.userId}\nRole: ${data.role}\nJoined: ${data.joinedAt}`;

        return { content: [{ type: "text", text }] };
      } catch (err) {
        return {
          isError: true,
          content: [{ type: "text", text: `Error adding member: ${err instanceof Error ? err.message : String(err)}` }],
        };
      }
    },
  );

  server.tool(
    "dominusnode_team_remove_member",
    "Remove a member from a team by their user ID.",
    {
      team_id: z.string().regex(UUID_RE).describe("Team ID"),
      user_id: z.string().regex(UUID_RE).describe("User ID of the member to remove"),
    },
    async (args) => {
      try {
        await httpClient.delete<Record<string, never>>(
          `/api/teams/${encodeURIComponent(args.team_id)}/members/${encodeURIComponent(args.user_id)}`,
        );

        const text = `Member ${args.user_id} removed from team ${args.team_id} successfully.`;
        return { content: [{ type: "text", text }] };
      } catch (err) {
        return {
          isError: true,
          content: [{ type: "text", text: `Error removing member: ${err instanceof Error ? err.message : String(err)}` }],
        };
      }
    },
  );

  server.tool(
    "dominusnode_team_fund",
    "Transfer funds from your personal wallet to a team wallet. Minimum $1, maximum $10,000.",
    {
      team_id: z.string().regex(UUID_RE).describe("Team ID to fund"),
      amount_cents: z.number().int().min(100).max(1000000).describe("Amount in cents to transfer (min $1, max $10,000)"),
    },
    async (args) => {
      try {
        const data = await httpClient.post<{
          transaction: {
            id: string;
            walletId: string;
            type: string;
            amountCents: number;
            description: string;
            createdAt: string;
          };
        }>(`/api/teams/${encodeURIComponent(args.team_id)}/wallet/fund`, {
          amountCents: args.amount_cents,
        });

        const tx = data.transaction;
        const text = [
          `Team Funded Successfully`,
          ``,
          `Transaction ID: ${tx.id}`,
          `Amount: $${(tx.amountCents / 100).toFixed(2)}`,
          `Type: ${tx.type}`,
          `Wallet ID: ${tx.walletId}`,
          ``,
          `The funds have been transferred from your personal wallet.`,
          `Use dominusnode_team_details to check the new team balance.`,
        ].join("\n");

        return { content: [{ type: "text", text }] };
      } catch (err) {
        return {
          isError: true,
          content: [{ type: "text", text: `Error funding team: ${err instanceof Error ? err.message : String(err)}` }],
        };
      }
    },
  );

  server.tool(
    "dominusnode_team_create_key",
    "Create a shared API key for a team. All team members can use team keys for proxy access.",
    {
      team_id: z.string().regex(UUID_RE).describe("Team ID"),
      label: z.string().min(1).max(100).describe("Label for the API key (e.g., 'production', 'staging')"),
    },
    async (args) => {
      try {
        const data = await httpClient.post<{
          id: string;
          key: string;
          prefix: string;
          label: string;
          createdAt: string;
        }>(`/api/teams/${encodeURIComponent(args.team_id)}/keys`, {
          label: args.label,
        });

        const text = [
          `Team API Key Created`,
          ``,
          `Key ID: ${data.id}`,
          `API Key: ${data.key}`,
          `Prefix: ${data.prefix}`,
          `Label: ${data.label}`,
          `Team ID: ${args.team_id}`,
          `Created: ${data.createdAt}`,
          ``,
          `IMPORTANT: Save this API key now — it will not be shown again.`,
          `Usage is billed against the team wallet.`,
        ].join("\n");

        return { content: [{ type: "text", text }] };
      } catch (err) {
        return {
          isError: true,
          content: [{ type: "text", text: `Error creating team key: ${err instanceof Error ? err.message : String(err)}` }],
        };
      }
    },
  );

  server.tool(
    "dominusnode_team_usage",
    "Get the team wallet transaction history (funding, usage charges, refunds).",
    {
      team_id: z.string().regex(UUID_RE).describe("Team ID"),
      limit: z.number().int().min(1).max(100).default(20).describe("Number of transactions to return"),
    },
    async (args) => {
      try {
        const data = await httpClient.get<{
          transactions: Array<{
            id: string;
            walletId: string;
            type: string;
            amountCents: number;
            description: string;
            createdAt: string;
          }>;
        }>(`/api/teams/${encodeURIComponent(args.team_id)}/wallet/transactions?limit=${args.limit}`);

        if (data.transactions.length === 0) {
          return {
            content: [{ type: "text", text: "No transactions found for this team. Use dominusnode_team_fund to add funds." }],
          };
        }

        const lines = [
          `Team Transactions (${data.transactions.length})`,
          ``,
        ];

        for (const tx of data.transactions) {
          const sign = tx.type === "fund" || tx.type === "refund" ? "+" : "-";
          lines.push(`  ${sign}$${(tx.amountCents / 100).toFixed(2)} [${tx.type}] ${tx.description}`);
          lines.push(`    ${tx.createdAt} | Wallet: ${tx.walletId.slice(0, 8)}...`);
        }

        return { content: [{ type: "text", text: lines.join("\n") }] };
      } catch (err) {
        return {
          isError: true,
          content: [{ type: "text", text: `Error fetching team transactions: ${err instanceof Error ? err.message : String(err)}` }],
        };
      }
    },
  );
}
