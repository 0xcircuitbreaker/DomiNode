import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { HttpClient } from "../http-client.js";
import type { McpConfig } from "../config.js";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const AGENT_WALLET_RATE_MAX = 20;
const AGENT_WALLET_RATE_WINDOW_MS = 60_000;
const agentWalletTimestamps: number[] = [];

function checkAgentWalletRateLimit(): boolean {
  const now = Date.now();
  while (agentWalletTimestamps.length > 0 && now - agentWalletTimestamps[0] > AGENT_WALLET_RATE_WINDOW_MS) {
    agentWalletTimestamps.shift();
  }
  if (agentWalletTimestamps.length > 100) agentWalletTimestamps.length = 100;
  if (agentWalletTimestamps.length >= AGENT_WALLET_RATE_MAX) return false;
  agentWalletTimestamps.push(now);
  return true;
}

export function registerAgentWalletTools(server: McpServer, httpClient: HttpClient, config: McpConfig): void {
  server.tool(
    "dominusnode_x402_info",
    "Get x402 payment protocol info for Dominus Node. Returns supported currencies, pricing, facilitator details (Coinbase + PayAI), and agentic wallet details.",
    {},
    async () => {
      try {
        const data = await httpClient.get<{
          supported: boolean;
          enabled: boolean;
          protocol: string;
          version: string;
          facilitators: {
            coinbase: { network: string; receivingAddress: string | null; currency: string };
            payai: { network: string; receivingAddress: string | null; currency: string };
          };
          pricing: {
            dcPerRequestUsd: string;
            residentialPerRequestUsd: string;
            dcPerGbCents: number;
            residentialPerGbCents: number;
          };
          currencies: string[];
          walletType: string;
          agenticWallets: boolean;
        }>("/api/x402/info");

        const text = [
          `x402 Payment Protocol Info`,
          ``,
          `Protocol: ${data.protocol} v${data.version}`,
          `Supported: ${data.supported}`,
          `Enabled: ${data.enabled}`,
          ``,
          `Facilitators:`,
          `  Coinbase (EVM/Base):`,
          `    Network: ${data.facilitators.coinbase.network}`,
          `    Currency: ${data.facilitators.coinbase.currency}`,
          `    Receiving Address: ${data.facilitators.coinbase.receivingAddress ?? "Not configured"}`,
          `  PayAI (Solana):`,
          `    Network: ${data.facilitators.payai.network}`,
          `    Currency: ${data.facilitators.payai.currency}`,
          `    Receiving Address: ${data.facilitators.payai.receivingAddress ?? "Not configured"}`,
          ``,
          `Per-Request Pricing (x402 micropayments):`,
          `  Datacenter: $${data.pricing.dcPerRequestUsd}/request`,
          `  Residential: $${data.pricing.residentialPerRequestUsd}/request`,
          ``,
          `Per-GB Pricing (wallet billing):`,
          `  Datacenter: $${(data.pricing.dcPerGbCents / 100).toFixed(2)}/GB`,
          `  Residential: $${(data.pricing.residentialPerGbCents / 100).toFixed(2)}/GB`,
          ``,
          `Supported Currencies: ${data.currencies.join(", ")}`,
          `Wallet Type: ${data.walletType}`,
          `Agentic Wallets: ${data.agenticWallets ? "Yes" : "No"}`,
          ``,
          `x402 allows AI agents to pay per-request with USDC micropayments`,
          `via Coinbase (Base chain) or PayAI (Solana) — no signup needed.`,
          `Agentic wallets allow agents to hold sub-wallets with spending limits.`,
        ].join("\n");

        return { content: [{ type: "text", text }] };
      } catch (err) {
        return {
          isError: true,
          content: [{ type: "text", text: `Error fetching x402 info: ${err instanceof Error ? err.message : String(err)}` }],
        };
      }
    },
  );

  server.tool(
    "dominusnode_agent_wallet_create",
    "Create a server-side custodial agentic wallet for autonomous proxy billing. Set a spending limit per transaction for safety. Fund it from your main wallet.",
    {
      label: z.string().min(1).max(100).describe("Label for this wallet (e.g., 'scraper-bot', 'research-agent')"),
      spending_limit_cents: z.number().int().min(0).max(1000000).default(10000).describe("Max spend per transaction in cents (0 = no limit, default $100)"),
      daily_limit_cents: z.number().int().min(1).max(1000000).optional().describe("Optional daily budget in cents (resets at midnight UTC). Omit for no daily limit."),
      allowed_domains: z.array(z.string().max(253)).max(100).optional().describe("Optional list of allowed target domains. When set, proxy requests to unlisted domains are rejected."),
    },
    async (args) => {
      try {
        if (!checkAgentWalletRateLimit()) {
          return {
            isError: true,
            content: [{ type: "text", text: "Rate limit exceeded: maximum 20 agentic wallet operations per minute. Please wait before retrying." }],
          };
        }

        const body: Record<string, unknown> = {
          label: args.label,
          spendingLimitCents: args.spending_limit_cents,
        };
        if (args.daily_limit_cents !== undefined) body.dailyLimitCents = args.daily_limit_cents;
        if (args.allowed_domains !== undefined) body.allowedDomains = args.allowed_domains;

        const data = await httpClient.post<{
          id: string;
          label: string;
          balanceCents: number;
          spendingLimitCents: number;
          dailyLimitCents: number | null;
          allowedDomains: string[] | null;
          status: string;
          createdAt: string;
        }>("/api/agent-wallet", body);

        const text = [
          `Agentic Wallet Created`,
          ``,
          `Wallet ID: ${data.id}`,
          `Label: ${data.label}`,
          `Balance: $${(data.balanceCents / 100).toFixed(2)}`,
          `Spending Limit: ${data.spendingLimitCents > 0 ? `$${(data.spendingLimitCents / 100).toFixed(2)} per transaction` : "No limit"}`,
          `Daily Budget: ${data.dailyLimitCents ? `$${(data.dailyLimitCents / 100).toFixed(2)}/day` : "No daily limit"}`,
          `Allowed Domains: ${data.allowedDomains ? data.allowedDomains.join(", ") : "All domains"}`,
          `Status: ${data.status}`,
          ``,
          `Next steps:`,
          `  1. Use dominusnode_agent_wallet_fund to add funds from your main wallet`,
          `  2. The wallet can then be used for proxy billing`,
          `  3. Use dominusnode_agent_wallet_balance to check balance`,
          `  4. Use dominusnode_update_wallet_policy to change daily limits or domain restrictions`,
        ].join("\n");

        return { content: [{ type: "text", text }] };
      } catch (err) {
        return {
          isError: true,
          content: [{ type: "text", text: `Error creating wallet: ${err instanceof Error ? err.message : String(err)}` }],
        };
      }
    },
  );

  server.tool(
    "dominusnode_agent_wallet_balance",
    "Check the balance and details of an agentic wallet.",
    {
      wallet_id: z.string().regex(UUID_RE).describe("Wallet ID from dominusnode_agent_wallet_create"),
    },
    async (args) => {
      try {
        const data = await httpClient.get<{
          id: string;
          label: string;
          balanceCents: number;
          spendingLimitCents: number;
          dailyLimitCents: number | null;
          allowedDomains: string[] | null;
          status: string;
          createdAt: string;
        }>(`/api/agent-wallet/${encodeURIComponent(args.wallet_id)}`);

        const text = [
          `Agentic Wallet: ${data.label}`,
          ``,
          `Wallet ID: ${data.id}`,
          `Balance: $${(data.balanceCents / 100).toFixed(2)}`,
          `Spending Limit: ${data.spendingLimitCents > 0 ? `$${(data.spendingLimitCents / 100).toFixed(2)} per tx` : "No limit"}`,
          `Daily Budget: ${data.dailyLimitCents ? `$${(data.dailyLimitCents / 100).toFixed(2)}/day` : "No daily limit"}`,
          `Allowed Domains: ${data.allowedDomains ? data.allowedDomains.join(", ") : "All domains"}`,
          `Status: ${data.status}`,
          `Created: ${data.createdAt}`,
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
    "dominusnode_agent_wallet_fund",
    "Transfer funds from your main wallet to an agentic wallet. Minimum $1, maximum $10,000.",
    {
      wallet_id: z.string().regex(UUID_RE).describe("Wallet ID to fund"),
      amount_cents: z.number().int().min(100).max(1000000).describe("Amount in cents to transfer (min $1, max $10,000)"),
    },
    async (args) => {
      try {
        if (!checkAgentWalletRateLimit()) {
          return {
            isError: true,
            content: [{ type: "text", text: "Rate limit exceeded: maximum 20 agentic wallet operations per minute. Please wait before retrying." }],
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
        }>(`/api/agent-wallet/${encodeURIComponent(args.wallet_id)}/fund`, {
          amountCents: args.amount_cents,
        });

        const tx = data.transaction;
        const text = [
          `Wallet Funded Successfully`,
          ``,
          `Transaction ID: ${tx.id}`,
          `Amount: $${(tx.amountCents / 100).toFixed(2)}`,
          `Type: ${tx.type}`,
          ``,
          `The funds have been transferred from your main wallet.`,
          `Use dominusnode_agent_wallet_balance to check the new balance.`,
        ].join("\n");

        return { content: [{ type: "text", text }] };
      } catch (err) {
        return {
          isError: true,
          content: [{ type: "text", text: `Error funding wallet: ${err instanceof Error ? err.message : String(err)}` }],
        };
      }
    },
  );

  server.tool(
    "dominusnode_agent_wallet_list",
    "List all your agentic wallets with balances and status.",
    {},
    async () => {
      try {
        const data = await httpClient.get<{
          wallets: Array<{
            id: string;
            label: string;
            balanceCents: number;
            spendingLimitCents: number;
            dailyLimitCents: number | null;
            allowedDomains: string[] | null;
            status: string;
            createdAt: string;
          }>;
        }>("/api/agent-wallet");

        if (data.wallets.length === 0) {
          return {
            content: [{ type: "text", text: "No agentic wallets found. Use dominusnode_agent_wallet_create to create one." }],
          };
        }

        const lines = [
          `Agentic Wallets (${data.wallets.length})`,
          ``,
        ];

        for (const w of data.wallets) {
          lines.push(`  ${w.label} (${w.id.slice(0, 8)}...)`);
          lines.push(`    Balance: $${(w.balanceCents / 100).toFixed(2)} | Limit: ${w.spendingLimitCents > 0 ? `$${(w.spendingLimitCents / 100).toFixed(2)}/tx` : "none"} | Status: ${w.status}`);
          if (w.dailyLimitCents) lines.push(`    Daily Budget: $${(w.dailyLimitCents / 100).toFixed(2)}/day`);
          if (w.allowedDomains) lines.push(`    Allowed Domains: ${w.allowedDomains.join(", ")}`);
          lines.push(``);
        }

        return { content: [{ type: "text", text: lines.join("\n") }] };
      } catch (err) {
        return {
          isError: true,
          content: [{ type: "text", text: `Error: ${err instanceof Error ? err.message : String(err)}` }],
        };
      }
    },
  );

  server.tool(
    "dominusnode_agent_wallet_freeze",
    "Freeze an agentic wallet. Frozen wallets cannot be used for proxy billing until unfrozen.",
    {
      wallet_id: z.string().regex(UUID_RE).describe("Wallet ID to freeze"),
    },
    async (args) => {
      try {
        if (!checkAgentWalletRateLimit()) {
          return {
            isError: true,
            content: [{ type: "text", text: "Rate limit exceeded: maximum 20 agentic wallet operations per minute. Please wait before retrying." }],
          };
        }

        const data = await httpClient.post<{
          id: string;
          label: string;
          balanceCents: number;
          status: string;
        }>(`/api/agent-wallet/${encodeURIComponent(args.wallet_id)}/freeze`);

        const text = [
          `Wallet Frozen`,
          ``,
          `Wallet ID: ${data.id}`,
          `Label: ${data.label}`,
          `Balance: $${(data.balanceCents / 100).toFixed(2)}`,
          `Status: ${data.status}`,
          ``,
          `This wallet can no longer be used for proxy billing.`,
          `Use dominusnode_agent_wallet_unfreeze to reactivate it.`,
        ].join("\n");

        return { content: [{ type: "text", text }] };
      } catch (err) {
        return {
          isError: true,
          content: [{ type: "text", text: `Error freezing wallet: ${err instanceof Error ? err.message : String(err)}` }],
        };
      }
    },
  );

  server.tool(
    "dominusnode_agent_wallet_unfreeze",
    "Unfreeze a previously frozen agentic wallet, restoring it to active status for proxy billing.",
    {
      wallet_id: z.string().regex(UUID_RE).describe("Wallet ID to unfreeze"),
    },
    async (args) => {
      try {
        if (!checkAgentWalletRateLimit()) {
          return {
            isError: true,
            content: [{ type: "text", text: "Rate limit exceeded: maximum 20 agentic wallet operations per minute. Please wait before retrying." }],
          };
        }

        const data = await httpClient.post<{
          id: string;
          label: string;
          balanceCents: number;
          status: string;
        }>(`/api/agent-wallet/${encodeURIComponent(args.wallet_id)}/unfreeze`);

        const text = [
          `Wallet Unfrozen`,
          ``,
          `Wallet ID: ${data.id}`,
          `Label: ${data.label}`,
          `Balance: $${(data.balanceCents / 100).toFixed(2)}`,
          `Status: ${data.status}`,
          ``,
          `This wallet is now active and can be used for proxy billing.`,
        ].join("\n");

        return { content: [{ type: "text", text }] };
      } catch (err) {
        return {
          isError: true,
          content: [{ type: "text", text: `Error unfreezing wallet: ${err instanceof Error ? err.message : String(err)}` }],
        };
      }
    },
  );

  server.tool(
    "dominusnode_update_wallet_policy",
    "Update policy settings (daily budget limit and/or domain allowlist) on an agentic wallet. Set dailyLimitCents to null to remove daily limit. Set allowedDomains to null to allow all domains.",
    {
      wallet_id: z.string().regex(UUID_RE).describe("Wallet ID to update"),
      daily_limit_cents: z.number().int().min(1).max(1000000).nullable().optional().describe("Daily budget in cents (null to remove limit)"),
      allowed_domains: z.array(z.string().max(253)).max(100).nullable().optional().describe("Allowed target domains (null to allow all)"),
    },
    async (args) => {
      try {
        if (!checkAgentWalletRateLimit()) {
          return {
            isError: true,
            content: [{ type: "text", text: "Rate limit exceeded: maximum 20 agentic wallet operations per minute. Please wait before retrying." }],
          };
        }

        const body: Record<string, unknown> = {};
        if (args.daily_limit_cents !== undefined) body.dailyLimitCents = args.daily_limit_cents;
        if (args.allowed_domains !== undefined) body.allowedDomains = args.allowed_domains;

        const data = await httpClient.patch<{
          id: string;
          label: string;
          balanceCents: number;
          spendingLimitCents: number;
          dailyLimitCents: number | null;
          allowedDomains: string[] | null;
          status: string;
          createdAt: string;
        }>(`/api/agent-wallet/${encodeURIComponent(args.wallet_id)}/policy`, body);

        const text = [
          `Wallet Policy Updated`,
          ``,
          `Wallet ID: ${data.id}`,
          `Label: ${data.label}`,
          `Daily Budget: ${data.dailyLimitCents ? `$${(data.dailyLimitCents / 100).toFixed(2)}/day` : "No daily limit"}`,
          `Allowed Domains: ${data.allowedDomains ? data.allowedDomains.join(", ") : "All domains"}`,
          `Status: ${data.status}`,
        ].join("\n");

        return { content: [{ type: "text", text }] };
      } catch (err) {
        return {
          isError: true,
          content: [{ type: "text", text: `Error updating policy: ${err instanceof Error ? err.message : String(err)}` }],
        };
      }
    },
  );

  server.tool(
    "dominusnode_agent_wallet_delete",
    "Delete an agentic wallet. Any remaining balance is automatically refunded to your main wallet. Cannot delete frozen wallets.",
    {
      wallet_id: z.string().regex(UUID_RE).describe("Wallet ID to delete"),
    },
    async (args) => {
      try {
        if (!checkAgentWalletRateLimit()) {
          return {
            isError: true,
            content: [{ type: "text", text: "Rate limit exceeded: maximum 20 agentic wallet operations per minute. Please wait before retrying." }],
          };
        }

        const data = await httpClient.delete<{
          deleted: boolean;
          refundedCents: number;
        }>(`/api/agent-wallet/${encodeURIComponent(args.wallet_id)}`);

        const text = [
          `Wallet Deleted`,
          ``,
          `Refunded: $${(data.refundedCents / 100).toFixed(2)} to your main wallet`,
          ``,
          `The wallet has been deactivated and its balance refunded. Transaction records are retained for auditing.`,
        ].join("\n");

        return { content: [{ type: "text", text }] };
      } catch (err) {
        return {
          isError: true,
          content: [{ type: "text", text: `Error deleting wallet: ${err instanceof Error ? err.message : String(err)}` }],
        };
      }
    },
  );

  server.tool(
    "dominusnode_agent_wallet_transactions",
    "Get transaction history for an agentic wallet.",
    {
      wallet_id: z.string().regex(UUID_RE).describe("Wallet ID"),
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
            sessionId: string | null;
            createdAt: string;
          }>;
        }>(`/api/agent-wallet/${encodeURIComponent(args.wallet_id)}/transactions?limit=${args.limit}`);

        if (data.transactions.length === 0) {
          return {
            content: [{ type: "text", text: "No transactions found for this wallet." }],
          };
        }

        const lines = [
          `Wallet Transactions (${data.transactions.length})`,
          ``,
        ];

        for (const tx of data.transactions) {
          const sign = tx.type === "fund" || tx.type === "refund" ? "+" : "-";
          lines.push(`  ${sign}$${(tx.amountCents / 100).toFixed(2)} [${tx.type}] ${tx.description}`);
          lines.push(`    ${tx.createdAt}${tx.sessionId ? ` | Session: ${tx.sessionId.slice(0, 8)}` : ""}`);
        }

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
