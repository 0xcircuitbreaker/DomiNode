import { createHash } from "node:crypto";
import { ProtocolError } from "./errors.js";

function leadingZeroBits(buf: Buffer): number {
  let bits = 0;
  for (const byte of buf) {
    if (byte === 0) { bits += 8; continue; }
    return bits + Math.clz32(byte) - 24;
  }
  return bits;
}

/** Find n (decimal string) such that sha256(prefix + n) has >= difficulty leading zero bits. */
export function solvePow(prefix: string, difficulty: number, maxIterations = 200_000_000): string {
  if (typeof prefix !== "string" || prefix.length === 0 || prefix.length > 256) throw new ProtocolError("invalid PoW prefix");
  if (!Number.isInteger(difficulty) || difficulty < 1 || difficulty > 32) throw new ProtocolError("invalid PoW difficulty");
  for (let n = 0; n < maxIterations; n++) {
    const s = n.toString();
    if (leadingZeroBits(createHash("sha256").update(prefix + s).digest()) >= difficulty) return s;
  }
  throw new ProtocolError("PoW not solved within iteration cap");
}
