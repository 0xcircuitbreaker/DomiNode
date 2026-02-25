/**
 * @dominusnode/flowise-tools
 *
 * DomiNode rotating proxy tools for Flowise AI.
 *
 * Exposes a DominusNodeToolkit class that produces LangChain-compatible
 * DynamicStructuredTool instances for use inside Flowise workflows.
 *
 * @example
 * ```ts
 * import { DominusNodeToolkit } from "@dominusnode/flowise-tools";
 *
 * const toolkit = new DominusNodeToolkit({ apiKey: "dn_live_..." });
 * const tools = toolkit.getTools(); // DynamicStructuredTool[]
 * ```
 *
 * @packageDocumentation
 */

export { DominusNodeToolkit } from "./toolkit.js";
export type { DominusNodeToolkitOptions } from "./toolkit.js";

// Re-export security utilities for testing
export {
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
  checkDnsRebinding,
  SANCTIONED_COUNTRIES,
  BLOCKED_HOSTNAMES,
} from "./toolkit.js";
