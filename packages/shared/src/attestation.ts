import * as crypto from "node:crypto";

/**
 * Exact text a node operator signs (EIP-191 personal_sign) to register a node.
 * Binds the wallet, the single-use challenge nonce, the attestation version and
 * text from the active policy, and the node's ed25519 public key (if any).
 */
export function buildAttestationMessage(p: {
  wallet: string;
  nonce: string;
  attestationVersion: number;
  attestationText: string;
  nodePubkey: string | null;
}): string {
  return [
    "DomiNode node attestation",
    `Version: ${p.attestationVersion}`,
    `Wallet: ${p.wallet.toLowerCase()}`,
    `Nonce: ${p.nonce}`,
    `Node pubkey: ${p.nodePubkey ?? "none"}`,
    "",
    p.attestationText,
  ].join("\n");
}

export function sha256Hex(s: string): string {
  return crypto.createHash("sha256").update(s).digest("hex");
}

export function countLeadingZeroBits(buf: Buffer): number {
  let bits = 0;
  for (const byte of buf) {
    if (byte === 0) { bits += 8; continue; }
    return bits + Math.clz32(byte) - 24;
  }
  return bits;
}

/** True if sha256(prefix + nonce) has at least `difficulty` leading zero bits. */
export function verifyPow(prefix: string, nonce: string, difficulty: number): boolean {
  const h = crypto.createHash("sha256").update(prefix + nonce).digest();
  return countLeadingZeroBits(h) >= difficulty;
}
