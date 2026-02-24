import { DominusNodeClient } from "@dominusnode/sdk";
import {
  createProxiedFetchTool,
  createCheckBalanceTool,
  createCheckUsageTool,
  createGetProxyConfigTool,
  createListSessionsTool,
  createTopupPaypalTool,
} from "./tools.js";

/**
 * Configuration for creating DomiNode AI tools.
 */
export interface DominusNodeToolsConfig {
  /**
   * DomiNode API key for authentication.
   * Must start with "dn_live_" or "dn_test_".
   */
  apiKey: string;

  /**
   * Base URL for the DomiNode API.
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
 * The set of DomiNode tools for use with the Vercel AI SDK.
 */
export interface DominusNodeTools {
  /** Make HTTP requests through DomiNode's rotating proxy network. */
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
}

/**
 * Create a set of Vercel AI SDK tools for interacting with the DomiNode
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
  };
}

/**
 * Create DomiNode AI tools from an already-authenticated client instance.
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
  };
}
