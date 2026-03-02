import { DominusNodeClient } from "@dominusnode/sdk";
import {
  createProxiedFetchTool,
  createCheckBalanceTool,
  createCheckUsageTool,
  createGetProxyConfigTool,
  createListSessionsTool,
  createTopupPaypalTool,
  createTopupStripeTool,
  createTopupCryptoTool,
  createX402InfoTool,
  createCreateAgenticWalletTool,
  createFundAgenticWalletTool,
  createAgenticWalletBalanceTool,
  createListAgenticWalletsTool,
  createAgenticTransactionsTool,
  createFreezeAgenticWalletTool,
  createUnfreezeAgenticWalletTool,
  createDeleteAgenticWalletTool,
  createUpdateWalletPolicyTool,
} from "./tools.js";

/**
 * Configuration for creating Dominus Node AI tools.
 */
export interface DominusNodeToolsConfig {
  /**
   * Dominus Node API key for authentication.
   * Must start with "dn_live_" or "dn_test_".
   */
  apiKey: string;

  /**
   * Base URL for the Dominus Node API.
   * @default "https://api.dominusnode.com"
   */
  baseUrl?: string;

  /**
   * Proxy host override.
   * @default "proxy.dominusnode.com"
   */
  proxyHost?: string;

  /**
   * HTTP proxy port override.
   * @default 8080
   */
  httpProxyPort?: number;

  /**
   * SOCKS5 proxy port override.
   * @default 1080
   */
  socks5ProxyPort?: number;
}

/**
 * The set of Dominus Node tools for use with the Vercel AI SDK.
 */
export interface DominusNodeTools {
  /** Make HTTP requests through Dominus Node's rotating proxy network. */
  proxiedFetch: ReturnType<typeof createProxiedFetchTool>;
  /** Check the current wallet balance. */
  checkBalance: ReturnType<typeof createCheckBalanceTool>;
  /** Check proxy usage statistics for a given period. */
  checkUsage: ReturnType<typeof createCheckUsageTool>;
  /** Get proxy endpoint configuration and supported countries. */
  getProxyConfig: ReturnType<typeof createGetProxyConfigTool>;
  /** List all active proxy sessions. */
  listSessions: ReturnType<typeof createListSessionsTool>;
  /** Top up wallet balance via PayPal. */
  topupPaypal: ReturnType<typeof createTopupPaypalTool>;
  /** Top up wallet balance via Stripe (credit/debit card, Apple Pay, Google Pay, Link). */
  topupStripe: ReturnType<typeof createTopupStripeTool>;
  /** Top up wallet balance via cryptocurrency (BTC, ETH, XMR, etc.). */
  topupCrypto: ReturnType<typeof createTopupCryptoTool>;
  /** Get x402 micropayment protocol information. */
  x402Info: ReturnType<typeof createX402InfoTool>;
  /** Create a new agentic sub-wallet. */
  createAgenticWallet: ReturnType<typeof createCreateAgenticWalletTool>;
  /** Fund an agentic sub-wallet from the main wallet. */
  fundAgenticWallet: ReturnType<typeof createFundAgenticWalletTool>;
  /** Check the balance of an agentic sub-wallet. */
  agenticWalletBalance: ReturnType<typeof createAgenticWalletBalanceTool>;
  /** List all agentic sub-wallets. */
  listAgenticWallets: ReturnType<typeof createListAgenticWalletsTool>;
  /** List transactions for an agentic sub-wallet. */
  agenticTransactions: ReturnType<typeof createAgenticTransactionsTool>;
  /** Freeze an agentic sub-wallet. */
  freezeAgenticWallet: ReturnType<typeof createFreezeAgenticWalletTool>;
  /** Unfreeze an agentic sub-wallet. */
  unfreezeAgenticWallet: ReturnType<typeof createUnfreezeAgenticWalletTool>;
  /** Delete an agentic sub-wallet. */
  deleteAgenticWallet: ReturnType<typeof createDeleteAgenticWalletTool>;
  /** Update the policy of an agentic sub-wallet. */
  updateWalletPolicy: ReturnType<typeof createUpdateWalletPolicyTool>;
}

/**
 * Create a set of Vercel AI SDK tools for interacting with the Dominus Node
 * rotating proxy service.
 *
 * @example
 * ```ts
 * import { createDominusNodeTools } from "@dominusnode/ai-tools";
 * import { generateText } from "ai";
 * import { openai } from "@ai-sdk/openai";
 *
 * const tools = await createDominusNodeTools({
 *   apiKey: process.env.DOMINUSNODE_API_KEY!,
 * });
 *
 * const result = await generateText({
 *   model: openai("gpt-4o"),
 *   tools,
 *   prompt: "Check my proxy balance and fetch https://httpbin.org/ip through a US proxy",
 * });
 * ```
 */
export async function createDominusNodeTools(
  config: DominusNodeToolsConfig,
): Promise<DominusNodeTools> {
  // Validate API key format
  if (!config.apiKey || typeof config.apiKey !== "string") {
    throw new Error("apiKey is required and must be a non-empty string");
  }
  if (!config.apiKey.startsWith("dn_live_") && !config.apiKey.startsWith("dn_test_")) {
    throw new Error('apiKey must start with "dn_live_" or "dn_test_"');
  }

  // Create and authenticate the client
  const client = new DominusNodeClient({
    apiKey: config.apiKey,
    baseUrl: config.baseUrl,
    proxyHost: config.proxyHost,
  } as any);

  await client.connectWithKey(config.apiKey);

  return {
    proxiedFetch: createProxiedFetchTool(client, config.apiKey),
    checkBalance: createCheckBalanceTool(client),
    checkUsage: createCheckUsageTool(client),
    getProxyConfig: createGetProxyConfigTool(client),
    listSessions: createListSessionsTool(client),
    topupPaypal: createTopupPaypalTool(client),
    topupStripe: createTopupStripeTool(client),
    topupCrypto: createTopupCryptoTool(client),
    x402Info: createX402InfoTool(client),
    createAgenticWallet: createCreateAgenticWalletTool(client),
    fundAgenticWallet: createFundAgenticWalletTool(client),
    agenticWalletBalance: createAgenticWalletBalanceTool(client),
    listAgenticWallets: createListAgenticWalletsTool(client),
    agenticTransactions: createAgenticTransactionsTool(client),
    freezeAgenticWallet: createFreezeAgenticWalletTool(client),
    unfreezeAgenticWallet: createUnfreezeAgenticWalletTool(client),
    deleteAgenticWallet: createDeleteAgenticWalletTool(client),
    updateWalletPolicy: createUpdateWalletPolicyTool(client),
  };
}

/**
 * Create Dominus Node AI tools from an already-authenticated client instance.
 * Use this when you manage the DominusNodeClient lifecycle yourself.
 *
 * @param client - An already-authenticated DominusNodeClient.
 * @param apiKey - The API key (needed for building proxy URLs).
 */
export function createDominusNodeToolsFromClient(
  client: DominusNodeClient,
  apiKey: string,
): DominusNodeTools {
  if (!apiKey || typeof apiKey !== "string") {
    throw new Error("apiKey is required and must be a non-empty string");
  }

  return {
    proxiedFetch: createProxiedFetchTool(client, apiKey),
    checkBalance: createCheckBalanceTool(client),
    checkUsage: createCheckUsageTool(client),
    getProxyConfig: createGetProxyConfigTool(client),
    listSessions: createListSessionsTool(client),
    topupPaypal: createTopupPaypalTool(client),
    topupStripe: createTopupStripeTool(client),
    topupCrypto: createTopupCryptoTool(client),
    x402Info: createX402InfoTool(client),
    createAgenticWallet: createCreateAgenticWalletTool(client),
    fundAgenticWallet: createFundAgenticWalletTool(client),
    agenticWalletBalance: createAgenticWalletBalanceTool(client),
    listAgenticWallets: createListAgenticWalletsTool(client),
    agenticTransactions: createAgenticTransactionsTool(client),
    freezeAgenticWallet: createFreezeAgenticWalletTool(client),
    unfreezeAgenticWallet: createUnfreezeAgenticWalletTool(client),
    deleteAgenticWallet: createDeleteAgenticWalletTool(client),
    updateWalletPolicy: createUpdateWalletPolicyTool(client),
  };
}
