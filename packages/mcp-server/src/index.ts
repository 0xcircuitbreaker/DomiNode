#!/usr/bin/env node

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { parseConfig, ConfigError } from "./config.js";
import { TokenManager } from "./token-manager.js";
import { HttpClient } from "./http-client.js";
import { registerAuthenticatedTools, registerBootstrapTools, countTools } from "./register.js";

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
    // Agent authenticates by wallet signature, then restarts with a key.
    process.stderr.write("Dominus Node MCP Server starting in BOOTSTRAP mode...\n");
    process.stderr.write("No API key detected. Only account tools are available.\n");
    process.stderr.write("Use dominusnode_wallet_challenge + dominusnode_wallet_setup to get an API key.\n\n");

    registerBootstrapTools(server, httpClient);

    const transport = new StdioServerTransport();
    await server.connect(transport);
    process.stderr.write(`Dominus Node MCP Server ready — bootstrap mode (${countTools(server)} tools)\n`);
    process.stderr.write("Run dominusnode_wallet_setup to get an API key, then restart with DOMINUSNODE_API_KEY.\n");
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

    registerAuthenticatedTools(server, httpClient, config);

    const transport = new StdioServerTransport();
    await server.connect(transport);
    process.stderr.write(`Dominus Node MCP Server ready — ${countTools(server)} tools available\n`);
  }
}

main().catch((err) => {
  process.stderr.write(`Fatal error: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
