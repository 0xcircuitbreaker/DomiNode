/**
 * Credential scrubbing for every string that can reach a UI, a log, a control
 * channel response or an error message.
 */
const PATTERNS: RegExp[] = [
  /dn_(?:live|test|node|proxy)_[A-Za-z0-9_-]+/g,
  /eyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]*/g, // JWT
  /\b0x[0-9a-fA-F]{64}\b/g, // raw private keys
];

export function scrubCredentials(input: unknown): string {
  let s = typeof input === "string" ? input : input instanceof Error ? input.message : String(input);
  if (s.length > 2000) s = s.slice(0, 2000);
  for (const re of PATTERNS) s = s.replace(re, "[REDACTED]");
  return s;
}

/** Log-safe API key display: first 8 chars only. */
export function keyPrefix(key: string | null | undefined): string {
  if (!key) return "";
  return `${key.slice(0, 8)}…`;
}
