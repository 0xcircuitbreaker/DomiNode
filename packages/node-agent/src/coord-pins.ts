/**
 * Pinned coordinator ed25519 public keys (raw 32-byte, hex) used to verify
 * CHALLENGE signatures (DESIGN.md §2.4, commit 20). Release builds embed the
 * production key(s) here; operators may only ADD pins (DN_NODE_COORD_PINS),
 * never remove embedded ones. With no pins at all the agent refuses to auth.
 */
export const EMBEDDED_COORD_PUBKEYS: readonly string[] = Object.freeze([
  // Populated at release time from the coordinator's COORD_SIGNING_KEY_FILE public half.
]);

const HEX64 = /^[0-9a-f]{64}$/;

export function effectiveCoordPins(extra: readonly string[]): string[] {
  const out = new Set<string>(EMBEDDED_COORD_PUBKEYS);
  for (const p of extra) if (HEX64.test(p)) out.add(p);
  return [...out];
}
