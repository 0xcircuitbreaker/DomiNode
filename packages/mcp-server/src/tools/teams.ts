import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { HttpClient } from "../http-client.js";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const TEAMS_RATE_MAX = 20;
const TEAMS_RATE_WINDOW_MS = 60_000;
const teamsTimestamps: number[] = [];

function checkTeamsRateLimit(): boolean {
  const now = Date.now();
  while (teamsTimestamps.length > 0 && now - teamsTimestamps[0] > TEAMS_RATE_WINDOW_MS) {
    teamsTimestamps.shift();
  }
  if (teamsTimestamps.length > 100) teamsTimestamps.length = 100;
  if (teamsTimestamps.length >= TEAMS_RATE_MAX) return false;
  teamsTimestamps.push(now);
  return true;
}

export function registerTeamsTools(server: McpServer, httpClient: HttpClient): void {
  server.tool(
    "dominusnode_create_team",
    "Create a new team. Teams share a wallet and API keys. Optionally set a max member limit.",
    {
      name: z.string().min(1).max(100).describe("Team name"),
      max_members: z.number().int().min(1).max(100).optional().describe("Maximum number of team members (default: no limit)"),
    },
    async (args) => {
      try {
        if (!checkTeamsRateLimit()) {
          return {
            isError: true,
            content: [{ type: "text", text: "Rate limit exceeded: maximum 20 team operations per minute. Please wait before retrying." }],
          };
        }

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
          lines.push(`    Role: ${t.role} | Balance: $${(t.balanceCents / 100).toFixed(2)}`);
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
        }>(`/api/teams/${encodeURIComponent(args.team_id)}`);

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
          ``,
          `Use dominusnode_team_list_members to view members.`,
        ];

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
    "dominusnode_team_update",
    "Update a team's name or max member limit. Only team owners and admins can update team settings.",
    {
      team_id: z.string().regex(UUID_RE).describe("Team ID"),
      name: z.string().min(1).max(100).optional().describe("New team name"),
      max_members: z.number().int().min(1).max(100).optional().describe("New maximum member limit"),
    },
    async (args) => {
      try {
        if (!checkTeamsRateLimit()) {
          return {
            isError: true,
            content: [{ type: "text", text: "Rate limit exceeded: maximum 20 team operations per minute. Please wait before retrying." }],
          };
        }

        const body: Record<string, unknown> = {};
        if (args.name !== undefined) body.name = args.name;
        if (args.max_members !== undefined) body.maxMembers = args.max_members;

        if (Object.keys(body).length === 0) {
          return {
            isError: true,
            content: [{ type: "text", text: "No updates provided. Specify name and/or max_members to update." }],
          };
        }

        const data = await httpClient.patch<{
          id: string;
          name: string;
          ownerId: string;
          maxMembers: number | null;
          status: string;
          createdAt: string;
        }>(`/api/teams/${encodeURIComponent(args.team_id)}`, body);

        const text = [
          `Team Updated`,
          ``,
          `Team ID: ${data.id}`,
          `Name: ${data.name}`,
          `Max Members: ${data.maxMembers ?? "Unlimited"}`,
          `Status: ${data.status}`,
        ].join("\n");

        return { content: [{ type: "text", text }] };
      } catch (err) {
        return {
          isError: true,
          content: [{ type: "text", text: `Error updating team: ${err instanceof Error ? err.message : String(err)}` }],
        };
      }
    },
  );

  server.tool(
    "dominusnode_team_update_member_role",
    "Change a team member's role. Only team owners can change roles. Cannot change the owner's role or your own role.",
    {
      team_id: z.string().regex(UUID_RE).describe("Team ID"),
      user_id: z.string().regex(UUID_RE).describe("User ID of the member to update"),
      role: z.enum(["member", "admin"]).describe("New role: 'admin' or 'member'"),
    },
    async (args) => {
      try {
        if (!checkTeamsRateLimit()) {
          return {
            isError: true,
            content: [{ type: "text", text: "Rate limit exceeded: maximum 20 team operations per minute. Please wait before retrying." }],
          };
        }

        const data = await httpClient.patch<{
          id: string;
          teamId: string;
          userId: string;
          role: string;
          joinedAt: string;
        }>(`/api/teams/${encodeURIComponent(args.team_id)}/members/${encodeURIComponent(args.user_id)}`, {
          role: args.role,
        });

        const text = `Member ${data.userId} role updated to '${data.role}' in team ${data.teamId}.`;
        return { content: [{ type: "text", text }] };
      } catch (err) {
        return {
          isError: true,
          content: [{ type: "text", text: `Error updating member role: ${err instanceof Error ? err.message : String(err)}` }],
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
        if (!checkTeamsRateLimit()) {
          return {
            isError: true,
            content: [{ type: "text", text: "Rate limit exceeded: maximum 20 team operations per minute. Please wait before retrying." }],
          };
        }

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
        if (!checkTeamsRateLimit()) {
          return {
            isError: true,
            content: [{ type: "text", text: "Rate limit exceeded: maximum 20 team operations per minute. Please wait before retrying." }],
          };
        }

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
        if (!checkTeamsRateLimit()) {
          return {
            isError: true,
            content: [{ type: "text", text: "Rate limit exceeded: maximum 20 team operations per minute. Please wait before retrying." }],
          };
        }

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
        if (!checkTeamsRateLimit()) {
          return {
            isError: true,
            content: [{ type: "text", text: "Rate limit exceeded: maximum 20 team operations per minute. Please wait before retrying." }],
          };
        }

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
    "dominusnode_team_revoke_key",
    "Revoke a team API key. Only team owners and admins can revoke keys. The key will immediately stop working.",
    {
      team_id: z.string().regex(UUID_RE).describe("Team ID"),
      key_id: z.string().regex(UUID_RE).describe("API key ID to revoke"),
    },
    async (args) => {
      try {
        if (!checkTeamsRateLimit()) {
          return {
            isError: true,
            content: [{ type: "text", text: "Rate limit exceeded: maximum 20 team operations per minute. Please wait before retrying." }],
          };
        }

        await httpClient.delete<Record<string, never>>(
          `/api/teams/${encodeURIComponent(args.team_id)}/keys/${encodeURIComponent(args.key_id)}`,
        );

        const text = `Team API key ${args.key_id} has been revoked and will no longer work for proxy access.`;
        return { content: [{ type: "text", text }] };
      } catch (err) {
        return {
          isError: true,
          content: [{ type: "text", text: `Error revoking team key: ${err instanceof Error ? err.message : String(err)}` }],
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

  server.tool(
    "dominusnode_team_list_members",
    "List all members of a team with their roles and join dates.",
    {
      team_id: z.string().regex(UUID_RE).describe("Team ID"),
    },
    async (args) => {
      try {
        const data = await httpClient.get<{
          members: Array<{
            id: string;
            teamId: string;
            userId: string;
            role: string;
            email: string;
            joinedAt: string;
          }>;
        }>(`/api/teams/${encodeURIComponent(args.team_id)}/members`);

        if (data.members.length === 0) {
          return {
            content: [{ type: "text", text: "No members found for this team. Use dominusnode_team_add_member or dominusnode_team_invite_member to add members." }],
          };
        }

        const lines = [
          `Team Members (${data.members.length})`,
          ``,
        ];

        for (const m of data.members) {
          lines.push(`  ${m.email} (${m.userId.slice(0, 8)}...)`);
          lines.push(`    Role: ${m.role} | Joined: ${m.joinedAt}`);
          lines.push(``);
        }

        return { content: [{ type: "text", text: lines.join("\n") }] };
      } catch (err) {
        return {
          isError: true,
          content: [{ type: "text", text: `Error listing team members: ${err instanceof Error ? err.message : String(err)}` }],
        };
      }
    },
  );

  server.tool(
    "dominusnode_team_invite_member",
    "Send an email invitation to join a team. The invited user will receive an email with a link to accept. Only team owners and admins can send invites.",
    {
      team_id: z.string().regex(UUID_RE).describe("Team ID"),
      email: z.string().email().describe("Email address of the person to invite"),
      role: z.enum(["member", "admin"]).default("member").describe("Role to assign when they accept: 'admin' or 'member'. Default: 'member'"),
    },
    async (args) => {
      try {
        if (!checkTeamsRateLimit()) {
          return {
            isError: true,
            content: [{ type: "text", text: "Rate limit exceeded: maximum 20 team operations per minute. Please wait before retrying." }],
          };
        }

        const data = await httpClient.post<{
          id: string;
          teamId: string;
          email: string;
          role: string;
          expiresAt: string;
          createdAt: string;
        }>(`/api/teams/${encodeURIComponent(args.team_id)}/invites`, {
          email: args.email,
          role: args.role,
        });

        const text = [
          `Team Invite Sent`,
          ``,
          `Invite ID: ${data.id}`,
          `Email: ${data.email}`,
          `Role: ${data.role}`,
          `Expires: ${data.expiresAt}`,
          `Created: ${data.createdAt}`,
          ``,
          `An invitation email has been sent. The invite expires in 7 days.`,
          `Use dominusnode_team_list_invites to see all pending invites.`,
        ].join("\n");

        return { content: [{ type: "text", text }] };
      } catch (err) {
        return {
          isError: true,
          content: [{ type: "text", text: `Error sending invite: ${err instanceof Error ? err.message : String(err)}` }],
        };
      }
    },
  );

  server.tool(
    "dominusnode_team_list_invites",
    "List all pending invitations for a team. Shows invited email, role, and expiration.",
    {
      team_id: z.string().regex(UUID_RE).describe("Team ID"),
    },
    async (args) => {
      try {
        const data = await httpClient.get<{
          invites: Array<{
            id: string;
            teamId: string;
            email: string;
            role: string;
            invitedBy: string;
            expiresAt: string;
            createdAt: string;
          }>;
        }>(`/api/teams/${encodeURIComponent(args.team_id)}/invites`);

        if (data.invites.length === 0) {
          return {
            content: [{ type: "text", text: "No pending invites for this team. Use dominusnode_team_invite_member to send invitations." }],
          };
        }

        const lines = [
          `Pending Invites (${data.invites.length})`,
          ``,
        ];

        for (const inv of data.invites) {
          lines.push(`  ${inv.email} — ${inv.role}`);
          lines.push(`    Invite ID: ${inv.id}`);
          lines.push(`    Invited by: ${inv.invitedBy.slice(0, 8)}... | Expires: ${inv.expiresAt}`);
          lines.push(``);
        }

        return { content: [{ type: "text", text: lines.join("\n") }] };
      } catch (err) {
        return {
          isError: true,
          content: [{ type: "text", text: `Error listing invites: ${err instanceof Error ? err.message : String(err)}` }],
        };
      }
    },
  );

  server.tool(
    "dominusnode_team_cancel_invite",
    "Cancel a pending team invitation. Only team owners and admins can cancel invites.",
    {
      team_id: z.string().regex(UUID_RE).describe("Team ID"),
      invite_id: z.string().regex(UUID_RE).describe("Invite ID to cancel"),
    },
    async (args) => {
      try {
        if (!checkTeamsRateLimit()) {
          return {
            isError: true,
            content: [{ type: "text", text: "Rate limit exceeded: maximum 20 team operations per minute. Please wait before retrying." }],
          };
        }

        await httpClient.delete<Record<string, never>>(
          `/api/teams/${encodeURIComponent(args.team_id)}/invites/${encodeURIComponent(args.invite_id)}`,
        );

        const text = `Invite ${args.invite_id} has been cancelled. The invited user can no longer accept it.`;
        return { content: [{ type: "text", text }] };
      } catch (err) {
        return {
          isError: true,
          content: [{ type: "text", text: `Error cancelling invite: ${err instanceof Error ? err.message : String(err)}` }],
        };
      }
    },
  );

  server.tool(
    "dominusnode_team_list_keys",
    "List all API keys for a team. Shows key prefix, label, and creation date.",
    {
      team_id: z.string().regex(UUID_RE).describe("Team ID"),
    },
    async (args) => {
      try {
        const data = await httpClient.get<{
          keys: Array<{
            id: string;
            userId: string;
            prefix: string;
            label: string;
            teamId: string;
            createdAt: string;
          }>;
        }>(`/api/teams/${encodeURIComponent(args.team_id)}/keys`);

        if (data.keys.length === 0) {
          return {
            content: [{ type: "text", text: "No API keys found for this team. Use dominusnode_team_create_key to create one." }],
          };
        }

        const lines = [
          `Team API Keys (${data.keys.length})`,
          ``,
        ];

        for (const k of data.keys) {
          lines.push(`  ${k.prefix}... — ${k.label}`);
          lines.push(`    Key ID: ${k.id} | Created: ${k.createdAt}`);
          lines.push(``);
        }

        return { content: [{ type: "text", text: lines.join("\n") }] };
      } catch (err) {
        return {
          isError: true,
          content: [{ type: "text", text: `Error listing team keys: ${err instanceof Error ? err.message : String(err)}` }],
        };
      }
    },
  );

  server.tool(
    "dominusnode_team_delete",
    "Delete a team. Only the team owner can delete a team. Any remaining balance in the team wallet is refunded to the owner's personal wallet. All team members, keys, and invites are removed.",
    {
      team_id: z.string().regex(UUID_RE).describe("Team ID to delete"),
    },
    async (args) => {
      try {
        if (!checkTeamsRateLimit()) {
          return {
            isError: true,
            content: [{ type: "text", text: "Rate limit exceeded: maximum 20 team operations per minute. Please wait before retrying." }],
          };
        }

        const data = await httpClient.delete<{
          deleted: boolean;
          refundedCents: number;
        }>(`/api/teams/${encodeURIComponent(args.team_id)}`);

        const text = [
          `Team Deleted`,
          ``,
          `Refunded: $${(data.refundedCents / 100).toFixed(2)} to your personal wallet`,
          ``,
          `The team, all its members, API keys, and invites have been removed.`,
        ].join("\n");

        return { content: [{ type: "text", text }] };
      } catch (err) {
        return {
          isError: true,
          content: [{ type: "text", text: `Error deleting team: ${err instanceof Error ? err.message : String(err)}` }],
        };
      }
    },
  );
}
