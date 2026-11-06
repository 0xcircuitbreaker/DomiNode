/**
 * Pinned coordinator ed25519 public keys (raw 32-byte, hex) used to verify
 * CHALLENGE signatures (DESIGN.md §2.4, commit 20). Release builds embed the
 * production key(s) here; operators may only ADD pins (DN_NODE_COORD_PINS),
 * never remove embedded ones. With no pins at all the agent refuses to auth.
 */
import { GENERATED_COORD_PUBKEYS } from "./coord-pins.generated.js";

const HEX64 = /^[0-9a-f]{64}$/;

/**
 * Embedded at build time by scripts/gen-coord-pins.mjs from DN_COORD_PUBKEYS
 * (empty in dev). Re-validated here so a hand-edited file cannot add junk.
 */
export const EMBEDDED_COORD_PUBKEYS: readonly string[] = Object.freeze(
  GENERATED_COORD_PUBKEYS.filter((p) => HEX64.test(p)),
);

export function effectiveCoordPins(extra: readonly string[]): string[] {
  const out = new Set<string>(EMBEDDED_COORD_PUBKEYS);
  for (const p of extra) if (HEX64.test(p)) out.add(p);
  return [...out];
}
