/**
 * @dominusnode/mastra-tools
 *
 * Dominus Node rotating proxy tools for Mastra AI agents.
 * Provides 23 tools for proxy fetching, wallet management,
 * team collaboration, and payment operations.
 *
 * @example
 * ```typescript
 * import { DominusNodeToolkit } from "@dominusnode/mastra-tools";
 *
 * const toolkit = new DominusNodeToolkit({
 *   apiKey: process.env.DOMINUSNODE_API_KEY!,
 * });
 *
 * const tools = toolkit.getTools();
 * ```
 */

export {
  DominusNodeToolkit,
  // Security utilities (exported for testing)
  isPrivateIp,
  validateTargetUrl,
  validateCountry,
  validateUuid,
  normalizeIpv4,
  stripDangerousKeys,
  scrubCredentials,
  truncate,
  formatBytes,
  formatCents,
} from "./toolkit.js";

export type { DominusNodeToolkitConfig } from "./toolkit.js";
