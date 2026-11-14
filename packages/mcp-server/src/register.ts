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
import { registerAgentWalletTools, registerX402InfoTool } from "./tools/agent-wallet.js";
import { registerWalletAuthTools } from "./tools/wallet-auth.js";
import { registerTeamsTools } from "./tools/teams.js";
import { registerNetworkTools } from "./tools/network.js";
import { registerNodeTools } from "./tools/nodes.js";
import { registerCreditsTools } from "./tools/credits.js";

/** Tools available without an API key (account bootstrap + public network info). */
export function registerBootstrapTools(server: McpServer, httpClient: HttpClient, config?: McpConfig): void {
  registerAccountTools(server, httpClient);
  registerCryptoTools(server, httpClient);
  // Agent-wallet tools need authentication and are not registered here.
  registerWalletAuthTools(server, httpClient, {
    config,
    onAuthenticated: config ? (apiKey) => unlockAuthenticatedTools(server, httpClient, config, apiKey) : undefined,
  });
  registerNetworkTools(server, httpClient);
  registerX402InfoTool(server, httpClient);
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
  registerWalletAuthTools(server, httpClient, { config });
  registerTeamsTools(server, httpClient);
  registerNetworkTools(server, httpClient);
  registerX402InfoTool(server, httpClient);
  registerNodeTools(server, httpClient, config);
  registerCreditsTools(server, httpClient, config);
}

/**
 * Bootstrap -> authenticated in-process, after dominusnode_wallet_setup has a session token
 * (already stored on httpClient) and a fresh API key. Registers every authenticated tool not
 * already present and notifies the client (notifications/tools/list_changed).
 */
export function unlockAuthenticatedTools(server: McpServer, httpClient: HttpClient, config: McpConfig, apiKey: string): boolean {
  if (!apiKey.startsWith("dn_live_")) return false;
  config.apiKey = apiKey;
  const registered = (server as unknown as { _registeredTools: Record<string, unknown> })._registeredTools;
  // Skip names the bootstrap set already registered (McpServer rejects duplicates).
  const skipExisting = new Proxy(server, {
    get(target, prop, receiver) {
      if (prop === "tool") {
        return (name: string, ...rest: unknown[]) => {
          if (name in registered) return registered[name];
          return (target.tool as (...a: unknown[]) => unknown).call(target, name, ...rest);
        };
      }
      return Reflect.get(target, prop, receiver);
    },
  });
  registerAuthenticatedTools(skipExisting, httpClient, config);
  // McpServer.tool() itself sends notifications/tools/list_changed while connected.
  if (server.isConnected()) server.sendToolListChanged();
  return true;
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
        `Step 1: Sign in with a wallet (no email/password)`,
        `  a. dominusnode_wallet_challenge — get the sign-in message for your address`,
        `  b. dominusnode_wallet_setup — submit the signature; creates an API key and`,
        `     unlocks the full tool set (fetch, keys, usage, wallet, nodes, earnings)`,
        `     in this session, no restart needed.`,
        `  With DOMINUSNODE_WALLET_KEY_FILE set, call dominusnode_wallet_setup with no`,
        `  signature and this server signs the standard sign-in message itself.`,
        ``,
        `Step 2: Fund or earn (requires the sign-in above)`,
        `  dominusnode_pay_crypto — top up with crypto (BTC, ETH, USDC, SOL, ...)`,
        `  or contribute a node and earn (dominusnode_node_setup_guide after sign-in)`,
        ``,
        `Public network info (no account needed):`,
        `  dominusnode_network_pricing — live per-GB prices and node tier shares`,
        `  dominusnode_network_policy — exit policy (ports, plaintext rules, attestation)`,
        `  dominusnode_network_stats — online nodes by country and class`,
        `  dominusnode_status — live network status and open incidents`,
        `  dominusnode_x402_info — pay per request with x402 instead of a prepaid wallet`,
        ``,
        `For future sessions, set DOMINUSNODE_API_KEY to the key from wallet_setup.`,
      ].join("\n");
      return { content: [{ type: "text", text }] };
    },
  );
}

