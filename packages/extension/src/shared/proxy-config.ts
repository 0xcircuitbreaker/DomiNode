import type { ExtensionState } from "./types.js";

/**
 * Build proxy username from extension state.
 * Format: user-country-XX[-state-xxx][-city-xxx][-asn-NNN][-session-XXXXXXXX]
 *
 * Uses hyphen separator between key and value (country-XX not country_XX)
 * to match the proxy gateway parser format. All values are URL-encoded.
 */
export function buildProxyUsername(state: ExtensionState): string {
  const parts: string[] = ["user"];

  if (state.country) {
    parts.push(`country-${encodeURIComponent(state.country)}`);
  }

  if (state.state) {
    parts.push(`state-${encodeURIComponent(state.state)}`);
  }

  if (state.city) {
    parts.push(`city-${encodeURIComponent(state.city)}`);
  }

  if (state.asn) {
    parts.push(`asn-${encodeURIComponent(String(state.asn))}`);
  }

  if (state.stickySession && state.sessionId) {
    parts.push(`session-${encodeURIComponent(state.sessionId)}`);
  }

  return parts.join("-");
}

/**
 * Generate a random session ID (8 hex characters).
 */
export function generateSessionId(): string {
  const bytes = new Uint8Array(4);
  crypto.getRandomValues(bytes);
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}
