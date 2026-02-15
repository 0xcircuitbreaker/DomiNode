import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { HttpClient } from "../http-client.js";
import type { AccountInfo } from "../types.js";

export function registerAccountTools(server: McpServer, httpClient: HttpClient): void {
  server.tool(
    "dominusnode_get_account_info",
    "Get account details including email, status, and MFA configuration.",
    {},
    async () => {
      try {
        const info = await httpClient.get<AccountInfo>("/api/auth/me");
        const text = [
          `Email: ${info.email}`,
          `Status: ${info.status}`,
          `MFA Enabled: ${info.mfa_enabled ? "yes" : "no"}`,
          `Account Created: ${info.created_at}`,
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
    "dominusnode_register",
    "Register a new Dominus Node account. Returns access token for immediate use. Use this when the AI agent needs to create its own proxy account. The free tier includes 10 connections and 1GB bandwidth — no payment required.",
    {
      email: z.string().email().describe("Email address for the new account"),
      password: z.string().min(8).max(128).describe("Password (min 8 characters)"),
    },
    async (args) => {
      try {
        const data = await httpClient.post<{ accessToken: string; refreshToken: string; user: { id: string; email: string } }>(
          "/api/auth/register",
          { email: args.email, password: args.password },
          false,
        );
        const text = [
          `Account created successfully!`,
          `Email: ${data.user.email}`,
          `User ID: ${data.user.id}`,
          ``,
          `You are now authenticated. Next steps:`,
          `1. Use dominusnode_create_key to create an API key for proxy access`,
          `2. Use dominusnode_fetch to make requests through the proxy`,
          `3. Free tier: 10 connections, 1GB bandwidth — no payment needed`,
        ].join("\n");
        return { content: [{ type: "text", text }] };
      } catch (err) {
        return {
          isError: true,
          content: [{ type: "text", text: `Registration error: ${err instanceof Error ? err.message : String(err)}` }],
        };
      }
    },
  );

  server.tool(
    "dominusnode_login",
    "Login to an existing Dominus Node account with email and password.",
    {
      email: z.string().email().describe("Account email"),
      password: z.string().min(1).describe("Account password"),
    },
    async (args) => {
      try {
        const data = await httpClient.post<{ accessToken: string; refreshToken: string; user: { id: string; email: string } }>(
          "/api/auth/login",
          { email: args.email, password: args.password },
          false,
        );
        const text = [
          `Logged in successfully!`,
          `Email: ${data.user.email}`,
          `User ID: ${data.user.id}`,
        ].join("\n");
        return { content: [{ type: "text", text }] };
      } catch (err) {
        return {
          isError: true,
          content: [{ type: "text", text: `Login error: ${err instanceof Error ? err.message : String(err)}` }],
        };
      }
    },
  );

  server.tool(
    "dominusnode_setup",
    "One-shot setup: register a new account, create an API key, and return proxy config. Perfect for AI agents that need to bootstrap proxy access from scratch.",
    {
      email: z.string().email().describe("Email address for the new account"),
      password: z.string().min(8).max(128).describe("Password (min 8 characters)"),
      key_label: z.string().min(1).max(100).default("ai-agent").describe("Label for the API key"),
    },
    async (args) => {
      try {
        // Step 1: Register
        const reg = await httpClient.post<{ accessToken: string; refreshToken: string; user: { id: string; email: string } }>(
          "/api/auth/register",
          { email: args.email, password: args.password },
          false,
        );

        // Step 2: Create API key (using the newly acquired auth)
        const keyData = await httpClient.post<{ id: string; key: string; label: string }>(
          "/api/keys",
          { label: args.key_label },
        );

        const text = [
          `Dominus Node account setup complete!`,
          ``,
          `Account:`,
          `  Email: ${reg.user.email}`,
          `  User ID: ${reg.user.id}`,
          ``,
          `API Key (save now — shown only once):`,
          `  Key: ${keyData.key}`,
          `  Label: ${keyData.label}`,
          ``,
          `Proxy Usage:`,
          `  curl -x http://USER:${keyData.key}@proxy.dominusnode.com:8080 https://httpbin.org/ip`,
          ``,
          `Free tier: 10 connections, 1GB bandwidth.`,
          `Use dominusnode_fetch to make proxy requests immediately.`,
        ].join("\n");
        return { content: [{ type: "text", text }] };
      } catch (err) {
        return {
          isError: true,
          content: [{ type: "text", text: `Setup error: ${err instanceof Error ? err.message : String(err)}` }],
        };
      }
    },
  );
}
