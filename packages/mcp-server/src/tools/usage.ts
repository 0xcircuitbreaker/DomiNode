import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { HttpClient } from "../http-client.js";
import type { UsageSummary, DailyUsage, TopHost } from "../types.js";

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(3)} GB`;
}

export function registerUsageTools(server: McpServer, httpClient: HttpClient): void {
  server.tool(
    "dominusnode_get_usage",
    "Get bandwidth usage summary for a time period. Shows total bytes, cost, and request count.",
    {
      days: z.number().min(1).max(365).default(30).describe("Number of days to look back"),
    },
    async (args) => {
      try {
        const since = new Date(Date.now() - args.days * 24 * 60 * 60 * 1000).toISOString();
        const until = new Date().toISOString();
        const data = await httpClient.get<{ summary: UsageSummary }>(`/api/usage?since=${encodeURIComponent(since)}&until=${encodeURIComponent(until)}`);
        const usage = data.summary;
        const text = [
          `Usage Summary (last ${args.days} days):`,
          `Total Bandwidth: ${formatBytes(usage.totalBytes)}`,
          `Total Cost: $${usage.totalCostUsd.toFixed(2)}`,
          `Total Requests: ${usage.requestCount}`,
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
    "dominusnode_get_daily_usage",
    "Get daily bandwidth breakdown showing bytes, cost, and requests per day.",
    {
      days: z.number().min(1).max(90).default(7).describe("Number of days"),
    },
    async (args) => {
      try {
        const since = new Date(Date.now() - args.days * 24 * 60 * 60 * 1000).toISOString();
        const until = new Date().toISOString();
        const data = await httpClient.get<{ days: DailyUsage[] }>(`/api/usage/daily?since=${encodeURIComponent(since)}&until=${encodeURIComponent(until)}`);
        if (!data.days || data.days.length === 0) {
          return { content: [{ type: "text", text: "No usage data for this period." }] };
        }
        const header = "Date       | Bandwidth      | Cost    | Requests";
        const lines = data.days.map(
          (d) => `${d.date} | ${formatBytes(d.totalBytes).padEnd(14)} | $${d.totalCostUsd.toFixed(2).padStart(5)} | ${d.requestCount}`,
        );
        return { content: [{ type: "text", text: [header, ...lines].join("\n") }] };
      } catch (err) {
        return {
          isError: true,
          content: [{ type: "text", text: `Error: ${err instanceof Error ? err.message : String(err)}` }],
        };
      }
    },
  );

  server.tool(
    "dominusnode_get_top_hosts",
    "Get top target hosts by bandwidth usage. Useful for understanding which sites consume the most data.",
    {
      limit: z.number().min(1).max(50).default(10).describe("Number of top hosts to return"),
      days: z.number().min(1).max(365).default(30).describe("Number of days"),
    },
    async (args) => {
      try {
        const since = new Date(Date.now() - args.days * 24 * 60 * 60 * 1000).toISOString();
        const until = new Date().toISOString();
        const data = await httpClient.get<{ hosts: TopHost[] }>(
          `/api/usage/top-hosts?limit=${args.limit}&since=${encodeURIComponent(since)}&until=${encodeURIComponent(until)}`,
        );
        if (!data.hosts || data.hosts.length === 0) {
          return { content: [{ type: "text", text: "No host data for this period." }] };
        }
        const header = "Host                         | Bandwidth      | Requests";
        const lines = data.hosts.map(
          (h) => `${h.targetHost.padEnd(28)} | ${formatBytes(h.totalBytes).padEnd(14)} | ${h.requestCount}`,
        );
        return { content: [{ type: "text", text: [header, ...lines].join("\n") }] };
      } catch (err) {
        return {
          isError: true,
          content: [{ type: "text", text: `Error: ${err instanceof Error ? err.message : String(err)}` }],
        };
      }
    },
  );
}
