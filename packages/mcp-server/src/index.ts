#!/usr/bin/env node

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { parseConfig, ConfigError } from "./config.js";
import { TokenManager } from "./token-manager.js";
import { HttpClient } from "./http-client.js";
import { PACKAGE_VERSION } from "./version.js";
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
      process.stderr.write(`  DOMINUSNODE_API_URL         — API base URL (default: https://api.dominusnode.daedalusdevelopmentgroup.com)\n`);
      process.stderr.write(`  DOMINUSNODE_PROXY_HOST      — Proxy host (default: proxy.dominusnode.daedalusdevelopmentgroup.com)\n`);
      process.stderr.write(`  DOMINUSNODE_HTTP_PROXY_PORT — HTTP proxy port (default: 8080)\n`);
      process.stderr.write(`  DOMINUSNODE_PROXY_URL       — https://host[:port] TLS gateway (default https://proxy.dominusnode.daedalusdevelopmentgroup.com:8443)\n`);
      process.stderr.write(`  DOMINUSNODE_PROXY_CA_FILE   — extra PEM CA for a privately issued gateway cert\n`);
      process.stderr.write(`  DOMINUSNODE_PROXY_INSECURE  — set to 1 to use plaintext http to the gateway (key sent in clear)\n`);
      process.stderr.write(`  DOMINUSNODE_WALLET_KEY_FILE — chmod-600 wallet key file (node registration only)\n`);
      process.stderr.write(`  DOMINUSNODE_NODE_KEY_FILE   — node credential output file (default ~/.dominusnode/node.json)\n`);
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
    version: PACKAGE_VERSION,
  });

  const bootstrapMode = config.apiKey === null;

  if (bootstrapMode) {
    // ── Bootstrap Mode ──────────────────────────────────────────────
    // No API key provided. Start with account/auth tools only.
    // Agent authenticates by wallet signature; wallet_setup then unlocks the full set in-process.
    process.stderr.write("Dominus Node MCP Server starting in BOOTSTRAP mode...\n");
    process.stderr.write("No API key detected. Only account tools are available.\n");
    process.stderr.write("Use dominusnode_wallet_challenge + dominusnode_wallet_setup to get an API key.\n\n");

    registerBootstrapTools(server, httpClient, config);

    const transport = new StdioServerTransport();
    await server.connect(transport);
    process.stderr.write(`Dominus Node MCP Server ready — bootstrap mode (${countTools(server)} tools)\n`);
    process.stderr.write("Run dominusnode_wallet_setup: it creates an API key and unlocks the full tool set in this session.\n");
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
