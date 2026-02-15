import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { HttpClient } from "../http-client.js";
import type { McpConfig } from "../config.js";

export function registerAgentWalletTools(server: McpServer, httpClient: HttpClient, config: McpConfig): void {
  server.tool(
    "dominusnode_x402_info",
    "Get x402 payment info for pay-per-request proxy access. No account needed — pay with USDC on Base chain and get instant proxy access. Uses the HTTP 402 Payment Required protocol (Coinbase/Stripe standard).",
    {},
    async () => {
      try {
        const data = await httpClient.get<{
          supported: boolean;
          chain: string;
          currency: string;
          address: string;
          price_per_mb_usd: string;
          price_per_request_usd: string;
          min_payment_usd: string;
          docs_url: string;
        }>("/api/x402/info");

        const text = [
          `x402 Pay-Per-Request Proxy Access`,
          ``,
          `Protocol: HTTP 402 Payment Required`,
          `Chain: ${data.chain}`,
          `Currency: ${data.currency}`,
          `Payment Address: ${data.address}`,
          ``,
          `Pricing:`,
          `  Per request: $${data.price_per_request_usd}`,
          `  Per MB: $${data.price_per_mb_usd}`,
          `  Minimum payment: $${data.min_payment_usd}`,
          ``,
          `How it works:`,
          `  1. Send USDC to the payment address on Base chain`,
          `  2. Include the tx hash in X-402-Receipt header`,
          `  3. Make proxy requests — no signup required`,
          ``,
          `This is the Coinbase/Stripe x402 standard protocol.`,
          `Compatible with Coinbase Agentic Wallets.`,
        ].join("\n");

        return { content: [{ type: "text", text }] };
      } catch (err) {
        // If the endpoint doesn't exist yet, return info about the protocol
        const text = [
          `x402 Pay-Per-Request Proxy Access`,
          ``,
          `The x402 protocol enables AI agents to pay for proxy access`,
          `using USDC micropayments on Base chain — no account needed.`,
          ``,
          `Status: Coming soon`,
          ``,
          `For now, use one of these alternatives:`,
          `  1. dominusnode_setup — Create a free account (1GB free bandwidth)`,
          `  2. dominusnode_pay_crypto — Pay with BTC/ETH/XMR/SOL/ZEC`,
          ``,
          `x402 protocol details: https://x402.org`,
          `Coinbase Agentic Wallets: https://docs.cdp.coinbase.com`,
        ].join("\n");

        return { content: [{ type: "text", text }] };
      }
    },
  );

  server.tool(
    "dominusnode_agent_wallet_create",
    "Create a Coinbase Agentic Wallet for autonomous proxy billing. The wallet holds USDC on Base chain and auto-pays for proxy bandwidth. Set spending limits and session caps for safety.",
    {
      label: z.string().min(1).max(100).default("ai-agent-wallet").describe("Label for this wallet"),
      max_spend_usd: z.number().min(1).max(10000).default(100).describe("Maximum total spend in USD"),
      max_per_request_usd: z.number().min(0.01).max(100).default(1).describe("Maximum spend per request in USD"),
    },
    async (args) => {
      try {
        const data = await httpClient.post<{
          wallet_id: string;
          address: string;
          chain: string;
          currency: string;
          label: string;
          max_spend_usd: number;
          max_per_request_usd: number;
          status: string;
        }>(
          "/api/agent-wallet/create",
          {
            label: args.label,
            max_spend_usd: args.max_spend_usd,
            max_per_request_usd: args.max_per_request_usd,
          },
        );

        const text = [
          `Agentic Wallet Created`,
          ``,
          `Wallet ID: ${data.wallet_id}`,
          `Address: ${data.address}`,
          `Chain: ${data.chain}`,
          `Currency: ${data.currency}`,
          `Label: ${data.label}`,
          ``,
          `Spending Limits:`,
          `  Max total: $${data.max_spend_usd}`,
          `  Max per request: $${data.max_per_request_usd}`,
          ``,
          `Status: ${data.status}`,
          ``,
          `Fund this wallet with USDC on Base chain to start proxying.`,
          `The wallet will auto-pay for bandwidth as you use it.`,
        ].join("\n");

        return { content: [{ type: "text", text }] };
      } catch (err) {
        const text = [
          `Agentic Wallet — Coming Soon`,
          ``,
          `Coinbase Agentic Wallet integration enables:`,
          `  - AI agents hold their own crypto wallets`,
          `  - Auto-pay for proxy bandwidth with USDC`,
          `  - Spending limits and session caps for safety`,
          `  - No human approval needed per transaction`,
          ``,
          `For now, use these alternatives:`,
          `  1. dominusnode_setup — Free account with 1GB bandwidth`,
          `  2. dominusnode_pay_crypto — Manual crypto top-up (BTC/ETH/XMR/SOL/ZEC)`,
          ``,
          `Agentic Wallet docs: https://docs.cdp.coinbase.com`,
        ].join("\n");

        return { content: [{ type: "text", text }] };
      }
    },
  );

  server.tool(
    "dominusnode_agent_wallet_balance",
    "Check the balance of your Coinbase Agentic Wallet. Shows available USDC, total spent, and remaining budget.",
    {
      wallet_id: z.string().min(1).max(100).describe("Wallet ID from dominusnode_agent_wallet_create"),
    },
    async (args) => {
      try {
        const data = await httpClient.get<{
          wallet_id: string;
          balance_usdc: string;
          total_spent_usdc: string;
          remaining_budget_usdc: string;
          transaction_count: number;
          last_transaction_at: string | null;
        }>(`/api/agent-wallet/${encodeURIComponent(args.wallet_id)}/balance`);

        const text = [
          `Agentic Wallet Balance`,
          ``,
          `Wallet: ${data.wallet_id}`,
          `Balance: ${data.balance_usdc} USDC`,
          `Total Spent: ${data.total_spent_usdc} USDC`,
          `Remaining Budget: ${data.remaining_budget_usdc} USDC`,
          `Transactions: ${data.transaction_count}`,
          data.last_transaction_at
            ? `Last Transaction: ${data.last_transaction_at}`
            : `No transactions yet — send USDC to fund this wallet.`,
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
