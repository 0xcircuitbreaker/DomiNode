import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { HttpClient } from "../http-client.js";
import type { Plan, UserPlan } from "../types.js";

function formatBytes(bytes: number): string {
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(0)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;
}

export function registerPlansTools(server: McpServer, httpClient: HttpClient): void {
  server.tool(
    "dominusnode_get_plan",
    "Get current plan details including monthly usage and bandwidth limits.",
    {},
    async () => {
      try {
        const data = await httpClient.get<UserPlan>("/api/plans/user/plan");
        const bandwidthLine = data.usage.limitGB != null
          ? `Bandwidth: ${formatBytes(data.usage.monthlyUsageBytes)} / ${formatBytes(data.usage.limitBytes)} (${data.usage.percentUsed?.toFixed(1) ?? "0.0"}%)`
          : `Bandwidth: ${formatBytes(data.usage.monthlyUsageBytes)} (unlimited)`;
        const text = [
          `Plan: ${data.plan.name}`,
          `Price: $${data.plan.pricePerGbUsd.toFixed(2)}/GB`,
          bandwidthLine,
          `Max Connections: ${data.plan.maxConnections}`,
          `Proxy Types: ${Array.isArray(data.plan.allowedProxyTypes) ? data.plan.allowedProxyTypes.join(", ") : (data.plan.allowedProxyTypes ?? "all")}`,
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
    "dominusnode_list_plans",
    "List all available pricing plans with bandwidth, connection limits, and features.",
    {},
    async () => {
      try {
        const data = await httpClient.get<{ plans: Plan[] }>("/api/plans");
        const plans = data.plans ?? [];
        if (plans.length === 0) {
          return { content: [{ type: "text", text: "No plans available." }] };
        }
        const lines = plans.map(
          (p) => `${p.name} — $${p.pricePerGbUsd.toFixed(2)}/GB | ${p.monthlyBandwidthGB != null ? `${p.monthlyBandwidthGB} GB` : "unlimited"} bandwidth | ${p.maxConnections} connections`,
        );
        lines.unshift("Available Plans:");
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
