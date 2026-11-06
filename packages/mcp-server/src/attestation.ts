/**
 * Node attestation message signed (EIP-191) by the owner wallet at node
 * registration. Kept byte-for-byte identical to packages/shared/src/attestation.ts
 * (enforced by tests/attestation-parity.test.ts) so this published package has
 * no dependency on the private @dominusnode/shared workspace.
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
