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
        const balanceUsd = typeof wallet.balanceUsd === "number" ? wallet.balanceUsd : 0;
        const balanceCents = typeof wallet.balanceCents === "number" ? wallet.balanceCents : 0;
        const text = `Balance: $${balanceUsd.toFixed(2)} (${balanceCents} cents)`;
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
    "Get spending forecast: daily average spend, estimated days remaining, and spending trend.",
    {},
    async () => {
      try {
        const forecast = await httpClient.get<WalletForecast>("/api/wallet/forecast");
        const lines = [
          `Daily Average: $${(forecast.dailyAvgCents / 100).toFixed(2)} USD`,
          `Days Remaining: ${forecast.daysRemaining ?? "unlimited"}`,
          `Trend: ${forecast.trend} (${forecast.trendPct}%)`,
        ];
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
        const offset = (args.page - 1) * args.limit;
        const data = await httpClient.get<TransactionList>(
          `/api/wallet/transactions?offset=${offset}&limit=${args.limit}`,
        );
        if (data.transactions.length === 0) {
          return { content: [{ type: "text", text: "No transactions found." }] };
        }
        const lines = data.transactions.map(
          (t) => `${t.createdAt ?? "unknown"} | ${(t.type ?? "unknown").padEnd(10)} | $${((t.amountCents ?? 0) / 100).toFixed(2)} | ${t.description ?? ""}`,
        );
        lines.unshift(`Transactions (page ${args.page}):`);
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
