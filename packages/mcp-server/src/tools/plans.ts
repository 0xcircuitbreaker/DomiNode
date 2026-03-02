import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
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
          `Proxy Types: ${data.plan.allowedProxyTypes ?? "all"}`,
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

  server.tool(
    "dominusnode_change_plan",
    "Switch your account to a different pricing plan. Available plans: free-dc (free, 500MB DC), free-res (free, 50MB residential), payg (pay-as-you-go, unlimited), vol100 (100GB/month), vol1tb (1TB/month), agent (AI agent plan, unlimited bandwidth, 50 connections, $5/GB). Volume plans require minimum wallet balance. Email must be verified.",
    {
      plan_id: z.string().min(1).max(50).describe("Plan ID to switch to. Options: free-dc, free-res, payg, vol100, vol1tb, agent"),
    },
    async (args) => {
      try {
        const data = await httpClient.put<{ message: string; plan: Plan }>("/api/plans/user/plan", { planId: args.plan_id });
        const text = [
          data.message,
          `Plan: ${data.plan.name}`,
          `Price: $${data.plan.pricePerGbUsd.toFixed(2)}/GB`,
          `Bandwidth: ${data.plan.monthlyBandwidthGB != null ? `${data.plan.monthlyBandwidthGB} GB/month` : "Unlimited"}`,
          `Max Connections: ${data.plan.maxConnections}`,
          `Proxy Types: ${data.plan.allowedProxyTypes ?? "all"}`,
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
