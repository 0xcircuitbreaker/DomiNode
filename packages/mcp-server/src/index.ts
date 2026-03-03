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
import { registerPaypalTools } from "./tools/paypal.js";
import { registerStripeTools } from "./tools/stripe.js";
import { registerAgentWalletTools } from "./tools/agent-wallet.js";
import { registerWalletAuthTools } from "./tools/wallet-auth.js";
import { registerSlotsTools } from "./tools/slots.js";
import { registerTeamsTools } from "./tools/teams.js";

async function main(): Promise<void> {
  let config;
  try {
    config = parseConfig();
  } catch (err) {
    if (err instanceof ConfigError) {
      process.stderr.write(`Configuration error: ${err.message}\n`);
      process.stderr.write(`\nOptional environment variables:\n`);
      process.stderr.write(`  DOMINUSNODE_API_KEY         — Your Dominus Node API key (starts with dn_live_)\n`);
      process.stderr.write(`                             Omit to start in bootstrap mode\n`);
      process.stderr.write(`  DOMINUSNODE_API_URL         — API base URL (default: https://api.dominusnode.com)\n`);
      process.stderr.write(`  DOMINUSNODE_PROXY_HOST      — Proxy host (default: proxy.dominusnode.com)\n`);
      process.stderr.write(`  DOMINUSNODE_HTTP_PROXY_PORT — HTTP proxy port (default: 8080)\n`);
      process.exit(1);
    }
    throw err;
  }

  const tokenManager = new TokenManager(config.apiUrl);
  const httpClient = new HttpClient(config.apiUrl, tokenManager, config.mcpAgentSecret);

  // Clear credentials on process shutdown to minimize in-memory exposure time
  function cleanupCredentials(): void {
    tokenManager.clear();
  }
  process.on("SIGINT", () => { cleanupCredentials(); process.exit(0); });
  process.on("SIGTERM", () => { cleanupCredentials(); process.exit(0); });
  process.on("exit", cleanupCredentials);

  const server = new McpServer({
    name: "dominusnode",
    version: "1.0.0",
  });

  const bootstrapMode = config.apiKey === null;

  if (bootstrapMode) {
    // ── Bootstrap Mode ──────────────────────────────────────────────
    // No API key provided. Start with account/auth tools only.
    // Agent can register, login, or setup — then use all tools.
    process.stderr.write("Dominus Node MCP Server starting in BOOTSTRAP mode...\n");
    process.stderr.write("No API key detected. Only account tools are available.\n");
    process.stderr.write("Use dominusnode_setup to create an account and get an API key.\n\n");

    registerAccountTools(server, httpClient);
    registerCryptoTools(server, httpClient);
    registerPaypalTools(server, httpClient);
    registerStripeTools(server, httpClient);
    // Do NOT register agent-wallet tools in bootstrap mode —
    // they require authentication and should only be available in authenticated mode.
    registerWalletAuthTools(server, httpClient);
    registerSlotsTools(server, httpClient);

    // Register a helper tool that tells the agent what to do
    registerBootstrapHelper(server);

    const transport = new StdioServerTransport();
    await server.connect(transport);
    process.stderr.write("Dominus Node MCP Server ready — bootstrap mode (17 tools + bootstrap helper)\n");
    process.stderr.write("Run dominusnode_setup or dominusnode_wallet_setup to create an account and unlock all 59 tools.\n");
  } else {
    // ── Authenticated Mode ──────────────────────────────────────────
    process.stderr.write("Dominus Node MCP Server starting...\n");

    try {
      await tokenManager.initialize(config.apiKey!);
      process.stderr.write("Authenticated with Dominus Node API\n");
    } catch (err) {
      process.stderr.write(`Authentication failed: ${err instanceof Error ? err.message : String(err)}\n`);
      process.stderr.write("Verify your DOMINUSNODE_API_KEY is valid and DOMINUSNODE_API_URL is reachable.\n");
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
    registerPaypalTools(server, httpClient);
    registerStripeTools(server, httpClient);
    registerAgentWalletTools(server, httpClient, config);
    registerWalletAuthTools(server, httpClient);
    registerSlotsTools(server, httpClient);
    registerTeamsTools(server, httpClient);

    const transport = new StdioServerTransport();
    await server.connect(transport);
    process.stderr.write("Dominus Node MCP Server ready — 59 tools available\n");
  }
}

function registerBootstrapHelper(server: McpServer): void {
  server.tool(
    "dominusnode_bootstrap_help",
    "Shows how to get started with Dominus Node. Use this if you're running in bootstrap mode without an API key.",
    {},
    async () => {
      const text = [
        `Dominus Node Bootstrap Mode`,
        ``,
        `You're running without an API key. Here's how to get started:`,
        ``,
        `Step 0: Check slot availability`,
        `  Use dominusnode_check_slots to see if registration slots are open.`,
        `  Alpha is limited to 2,500 users. If slots are full, use`,
        `  dominusnode_join_waitlist to get notified when one opens.`,
        ``,
        `Option 1: One-shot setup (recommended)`,
        `  Use dominusnode_setup with an email and password.`,
        `  This creates an account + API key in one step.`,
        ``,
        `Option 2: Wallet auth (no email/password needed)`,
        `  1. dominusnode_wallet_challenge — Get a message to sign`,
        `  2. dominusnode_wallet_setup — Submit signature + get API key`,
        ``,
        `Option 3: Step by step (email/password)`,
        `  1. dominusnode_register — Create an account`,
        `  2. dominusnode_login — Log in if you already have an account`,
        `  Note: To create API keys, use dominusnode_setup (one-shot) or`,
        `  set DOMINUSNODE_API_KEY and restart to unlock dominusnode_create_key.`,
        ``,
        `Option 4: Top up with Stripe, PayPal, or crypto`,
        `  After registering, use dominusnode_pay_stripe for card/Apple Pay/Google Pay.`,
        `  Or use dominusnode_pay_paypal for PayPal top-up (min $5).`,
        `  Or use dominusnode_pay_crypto for 11 cryptocurrencies:`,
        `  BTC, ETH, LTC, XMR, ZEC, USDC, SOL, USDT, DAI, BNB, LINK.`,
        `  Check your balance with dominusnode_get_balance to confirm funds arrived.`,
        ``,
        `Option 5: Multi-agent teams (manage multiple AI agents)`,
        `  Lead agent sets up account + payment, then:`,
        `  1. dominusnode_create_team — Create a team for your agents`,
        `  2. dominusnode_team_fund — Fund team wallet from personal wallet`,
        `  3. Sub-agents register via dominusnode_setup (auto-verified)`,
        `  4. dominusnode_team_add_member — Add sub-agents by email`,
        `  5. dominusnode_team_create_key — Create shared team API keys`,
        `  All traffic bills to team wallet. Only lead needs payment.`,
        ``,
        `After setup, set DOMINUSNODE_API_KEY in your environment`,
        `to unlock all 59 tools on next startup.`,
        ``,
        `Email auto-verified for MCP agents — crypto payments enabled (11 currencies).`,
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
