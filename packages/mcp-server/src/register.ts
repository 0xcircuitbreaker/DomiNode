import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { McpConfig } from "./config.js";
import type { HttpClient } from "./http-client.js";
import { registerFetchTools } from "./tools/fetch.js";
import { registerProxyTools } from "./tools/proxy.js";
import { registerWalletTools } from "./tools/wallet.js";
import { registerUsageTools } from "./tools/usage.js";
import { registerKeysTools } from "./tools/keys.js";
import { registerSessionsTools } from "./tools/sessions.js";
import { registerAccountTools } from "./tools/account.js";
import { registerCryptoTools } from "./tools/crypto.js";
import { registerAgentWalletTools } from "./tools/agent-wallet.js";
import { registerWalletAuthTools } from "./tools/wallet-auth.js";
import { registerTeamsTools } from "./tools/teams.js";
import { registerNetworkTools } from "./tools/network.js";
import { registerNodeTools } from "./tools/nodes.js";

/** Tools available without an API key (account bootstrap + public network info). */
export function registerBootstrapTools(server: McpServer, httpClient: HttpClient): void {
  registerAccountTools(server, httpClient);
  registerCryptoTools(server, httpClient);
  // Agent-wallet tools need authentication and are not registered here.
  registerWalletAuthTools(server, httpClient);
  registerNetworkTools(server, httpClient);
  registerBootstrapHelper(server);
}

/** Full tool set for an authenticated (DOMINUSNODE_API_KEY) session. */
export function registerAuthenticatedTools(server: McpServer, httpClient: HttpClient, config: McpConfig): void {
  registerFetchTools(server, config);
  registerProxyTools(server, httpClient, config);
  registerWalletTools(server, httpClient);
  registerUsageTools(server, httpClient);
  registerKeysTools(server, httpClient);
  registerSessionsTools(server, httpClient);
  registerAccountTools(server, httpClient);
  registerCryptoTools(server, httpClient);
  registerAgentWalletTools(server, httpClient, config);
  registerWalletAuthTools(server, httpClient);
  registerTeamsTools(server, httpClient);
  registerNetworkTools(server, httpClient);
  registerNodeTools(server, httpClient, config);
}

/** Number of tools registered on a server (used for startup logging and tests). */
export function countTools(server: McpServer): number {
  return Object.keys((server as unknown as { _registeredTools: Record<string, unknown> })._registeredTools).length;
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
        `Dominus Node is a relay network for AI agents: traffic exits through`,
        `nodes that other agents contribute, priced per GB by IP class.`,
        ``,
        `Option 1: Wallet auth (recommended, no email/password)`,
        `  1. dominusnode_wallet_challenge — Get a message to sign`,
        `  2. dominusnode_wallet_setup — Submit signature + get API key`,
        ``,
        `Option 2: Fund your wallet`,
        `  dominusnode_pay_crypto — top up with crypto (BTC, ETH, USDC, SOL, ...)`,
        ``,
        `Public network info (no account needed):`,
        `  dominusnode_network_pricing — live per-GB prices and node tier shares`,
        `  dominusnode_network_policy — exit policy (ports, plaintext rules, attestation)`,
        `  dominusnode_network_stats — online nodes by country and class`,
        ``,
        `After setup, set DOMINUSNODE_API_KEY in your environment and restart`,
        `to unlock fetch, keys, usage, teams and node (earning) tools.`,
      ].join("\n");
      return { content: [{ type: "text", text }] };
    },
  );
}

