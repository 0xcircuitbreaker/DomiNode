#!/usr/bin/env node

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { parseConfig, ConfigError } from "./config.js";
import { TokenManager } from "./token-manager.js";
import { HttpClient } from "./http-client.js";
import { registerFetchTools } from "./tools/fetch.js";
import { registerProxyTools } from "./tools/proxy.js";
import { registerWalletTools } from "./tools/wallet.js";
import { registerUsageTools } from "./tools/usage.js";
import { registerKeysTools } from "./tools/keys.js";
import { registerPlansTools } from "./tools/plans.js";
import { registerSessionsTools } from "./tools/sessions.js";
import { registerAccountTools } from "./tools/account.js";
import { registerCryptoTools } from "./tools/crypto.js";
import { registerAgentWalletTools } from "./tools/agent-wallet.js";
import { registerWalletAuthTools } from "./tools/wallet-auth.js";

async function main(): Promise<void> {
  let config;
  try {
    config = parseConfig();
  } catch (err) {
    if (err instanceof ConfigError) {
      process.stderr.write(`Configuration error: ${err.message}\n`);
      process.stderr.write(`\nOptional environment variables:\n`);
      process.stderr.write(`  DOMINODE_API_KEY         — Your DomiNode API key (starts with dn_live_)\n`);
      process.stderr.write(`                             Omit to start in bootstrap mode\n`);
      process.stderr.write(`  DOMINODE_API_URL         — API base URL (default: https://api.dominode.io)\n`);
      process.stderr.write(`  DOMINODE_PROXY_HOST      — Proxy host (default: proxy.dominode.io)\n`);
      process.stderr.write(`  DOMINODE_HTTP_PROXY_PORT — HTTP proxy port (default: 8080)\n`);
      process.exit(1);
    }
    throw err;
  }

  const tokenManager = new TokenManager(config.apiUrl);
  const httpClient = new HttpClient(config.apiUrl, tokenManager);
  const server = new McpServer({
    name: "dominode",
    version: "1.0.0",
  });

  const bootstrapMode = config.apiKey === null;

  if (bootstrapMode) {
    // ── Bootstrap Mode ──────────────────────────────────────────────
    // No API key provided. Start with account/auth tools only.
    // Agent can register, login, or setup — then use all tools.
    process.stderr.write("DomiNode MCP Server starting in BOOTSTRAP mode...\n");
    process.stderr.write("No API key detected. Only account tools are available.\n");
    process.stderr.write("Use dominode_setup to create an account and get an API key.\n\n");

    registerAccountTools(server, httpClient);
    registerCryptoTools(server, httpClient);
    registerAgentWalletTools(server, httpClient, config);
    registerWalletAuthTools(server, httpClient);

    // Register a helper tool that tells the agent what to do
    registerBootstrapHelper(server);

    const transport = new StdioServerTransport();
    await server.connect(transport);
    process.stderr.write("DomiNode MCP Server ready — bootstrap mode (8 tools)\n");
    process.stderr.write("Run dominode_setup or dominode_wallet_setup to create an account and unlock all 27 tools.\n");
  } else {
    // ── Authenticated Mode ──────────────────────────────────────────
    process.stderr.write("DomiNode MCP Server starting...\n");

    try {
      await tokenManager.initialize(config.apiKey!);
      process.stderr.write("Authenticated with DomiNode API\n");
    } catch (err) {
      process.stderr.write(`Authentication failed: ${err instanceof Error ? err.message : String(err)}\n`);
      process.stderr.write("Verify your DOMINODE_API_KEY is valid and DOMINODE_API_URL is reachable.\n");
      process.exit(1);
    }

    // Register all tool groups
    registerFetchTools(server, config);
    registerProxyTools(server, httpClient);
    registerWalletTools(server, httpClient);
    registerUsageTools(server, httpClient);
    registerKeysTools(server, httpClient);
    registerPlansTools(server, httpClient);
    registerSessionsTools(server, httpClient);
    registerAccountTools(server, httpClient);
    registerCryptoTools(server, httpClient);
    registerAgentWalletTools(server, httpClient, config);
    registerWalletAuthTools(server, httpClient);

    const transport = new StdioServerTransport();
    await server.connect(transport);
    process.stderr.write("DomiNode MCP Server ready — 27 tools available\n");
  }
}

function registerBootstrapHelper(server: McpServer): void {
  server.tool(
    "dominode_bootstrap_help",
    "Shows how to get started with DomiNode. Use this if you're running in bootstrap mode without an API key.",
    {},
    async () => {
      const text = [
        `DomiNode Bootstrap Mode`,
        ``,
        `You're running without an API key. Here's how to get started:`,
        ``,
        `Option 1: One-shot setup (recommended)`,
        `  Use dominode_setup with an email and password.`,
        `  This creates an account + API key in one step.`,
        ``,
        `Option 2: Wallet auth (no email/password needed)`,
        `  1. dominode_wallet_challenge — Get a message to sign`,
        `  2. dominode_wallet_setup — Submit signature + get API key`,
        ``,
        `Option 3: Step by step (email/password)`,
        `  1. dominode_register — Create an account`,
        `  2. dominode_create_key — Generate an API key`,
        ``,
        `Option 4: Pay with crypto (no account needed)`,
        `  Use dominode_pay_crypto to create a payment invoice.`,
        `  Pay with BTC, ETH, XMR, SOL, or ZEC.`,
        ``,
        `After setup, set DOMINODE_API_KEY in your environment`,
        `to unlock all 27 tools on next startup.`,
        ``,
        `Free tier: 10 connections, 1GB bandwidth — no payment required.`,
      ].join("\n");
      return { content: [{ type: "text", text }] };
    },
  );
}

main().catch((err) => {
  process.stderr.write(`Fatal error: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
