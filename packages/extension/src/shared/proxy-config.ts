import type { ExtensionState } from "./types.js";

/**
 * Build proxy username from extension state.
 * Format: user-country_XX[-state_xxx][-city_xxx][-asn_NNN][-session_XXXXXXXX]
 *
 * Uses underscore separator between key and value (country_XX not country-XX)
 * to match the standardized format across all SDKs. All values are URL-encoded.
 */
export function buildProxyUsername(state: ExtensionState): string {
  const parts: string[] = ["user"];

  if (state.country) {
    parts.push(`country_${encodeURIComponent(state.country)}`);
  }

  if (state.state) {
    parts.push(`state_${encodeURIComponent(state.state)}`);
  }

  if (state.city) {
    parts.push(`city_${encodeURIComponent(state.city)}`);
  }

  if (state.asn) {
    parts.push(`asn_${encodeURIComponent(String(state.asn))}`);
  }

  if (state.stickySession && state.sessionId) {
    parts.push(`session_${encodeURIComponent(state.sessionId)}`);
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
