import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { HttpClient } from "../http-client.js";
import type { WalletBalance, WalletForecast, TransactionList } from "../types.js";

export function registerWalletTools(server: McpServer, httpClient: HttpClient): void {
  server.tool(
    "dominusnode_get_balance",
    "Get current wallet balance in USD. Check this before making requests to ensure sufficient funds.",
    {},
    async () => {
      try {
        const wallet = await httpClient.get<WalletBalance>("/api/wallet");
        const text = `Balance: $${wallet.balance_usd} (${wallet.balance_cents} cents)`;
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
    "dominusnode_get_forecast",
    "Get spending forecast: daily average spend, estimated days remaining, and projected depletion date.",
    {},
    async () => {
      try {
        const forecast = await httpClient.get<WalletForecast>("/api/wallet/forecast");
        const lines = [
          `Daily Average: ${(forecast.daily_average_cents / 100).toFixed(2)} USD`,
          `Days Remaining: ${forecast.days_remaining ?? "unlimited"}`,
        ];
        if (forecast.estimated_depletion_date) {
          lines.push(`Estimated Depletion: ${forecast.estimated_depletion_date}`);
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
    "dominusnode_get_transactions",
    "Get wallet transaction history. Shows top-ups, usage charges, and refunds.",
    {
      page: z.number().min(1).default(1).describe("Page number"),
      limit: z.number().min(1).max(100).default(20).describe("Items per page"),
    },
    async (args) => {
      try {
        const data = await httpClient.get<TransactionList>(
          `/api/wallet/transactions?page=${args.page}&limit=${args.limit}`,
        );
        if (data.transactions.length === 0) {
          return { content: [{ type: "text", text: "No transactions found." }] };
        }
        const lines = data.transactions.map(
          (t) => `${t.created_at} | ${t.type.padEnd(10)} | ${(t.amount_cents / 100).toFixed(2)} USD | ${t.description}`,
        );
        lines.unshift(`Transactions (page ${data.page}, ${data.total} total):`);
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
