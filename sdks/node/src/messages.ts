/**
 * Byte-exact builders for every message the SDK asks a signer to sign. The SDK
 * NEVER signs a server-supplied string blindly: it rebuilds the message from
 * values it knows and refuses (ProtocolError) if the server's text differs.
 * Server sources: packages/shared/src/attestation.ts (buildAttestationMessage),
 * packages/dashboard/src/routes/v1/credits.ts (payoutWalletMessage, withdrawMessage, convertMessage).
 */
import { ProtocolError } from "./errors.js";
import { UUID_RE } from "./validation.js";

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

export function buildPayoutWalletMessage(i: { userId: string; wallet: string; address: string; chain: string; nonce: string }): string {
  return [
    "DominusNode payout wallet",
    "Action: payout_wallet_set",
    `User: ${i.userId}`,
    `Account wallet: ${i.wallet.toLowerCase()}`,
    `Payout address: ${i.address.toLowerCase()}`,
    `Chain: ${i.chain}`,
    `Nonce: ${i.nonce}`,
  ].join("\n");
}

export function buildWithdrawMessage(i: { userId: string; wallet: string; amountMusd: string; idempotencyKey: string; nonce: string }): string {
  return [
    "DominusNode withdrawal",
    "Action: withdraw",
    `User: ${i.userId}`,
    `Account wallet: ${i.wallet.toLowerCase()}`,
    `Amount (µUSD): ${i.amountMusd}`,
    `Idempotency key: ${i.idempotencyKey}`,
    `Nonce: ${i.nonce}`,
  ].join("\n");
}

export function buildConvertMessage(i: { userId: string; wallet: string; amountMusd: string; idempotencyKey: string; nonce: string }): string {
  return [
    "DominusNode credit conversion",
    "Action: convert",
    `User: ${i.userId}`,
    `Account wallet: ${i.wallet.toLowerCase()}`,
    `Amount (µUSD): ${i.amountMusd}`,
    `Idempotency key: ${i.idempotencyKey}`,
    `Nonce: ${i.nonce}`,
  ].join("\n");
}

/**
 * The payout/withdraw/convert messages carry the account's user id, which the SDK may
 * not know. Take it from line 3 ("User: <uuid>") — it must be a UUID — and
 * rebuild the whole message from it plus the SDK-known values; any other
 * difference is a refusal.
 */
export function extractUserId(message: string): string {
  const line = message.split("\n")[2] ?? "";
  const m = /^User: (.+)$/.exec(line);
  if (!m || !UUID_RE.test(m[1])) throw new ProtocolError("challenge message has no valid User line");
  return m[1];
}

export function assertSameMessage(server: unknown, local: string, what: string): void {
  if (typeof server !== "string" || server !== local) {
    throw new ProtocolError(
      `${what}: the server's message differs from the one built locally; refusing to sign ` +
      "(wrong signer for the linked wallet, mismatched parameters, or protocol change)",
    );
  }
}
