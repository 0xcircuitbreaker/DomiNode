import type { Settings } from "./settings.js";

/**
 * Build the gateway proxy username from settings.
 * Format (dash separated, parsed by proxy-gateway parseProxyOptions):
 *   agent[-country-XX][-class-residential|dc|mobile][-session-<id>][-allowhttp-1]
 * The leading "agent" segment keeps the legacy dc-/residential- prefix parser from
 * ever matching. The API key is never part of the username (it is the password).
 */
export function buildUsername(s: Pick<Settings, "country" | "ipClass" | "sticky" | "sessionId" | "plaintext">): string {
  const parts = ["agent"];
  if (s.country && /^[A-Z]{2}$/.test(s.country)) parts.push(`country-${s.country}`);
  if (s.ipClass) parts.push(`class-${s.ipClass}`);
  if (s.sticky && s.sessionId && /^[a-zA-Z0-9]{1,64}$/.test(s.sessionId)) parts.push(`session-${s.sessionId}`);
  if (s.plaintext) parts.push("allowhttp-1");
  return parts.join("-");
}

/** 16 random hex chars for sticky sessions. */
export function newSessionId(): string {
  const b = new Uint8Array(8);
  crypto.getRandomValues(b);
  return Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
}
