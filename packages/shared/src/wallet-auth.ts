import * as crypto from "node:crypto";

/** Validate EVM address format (0x + 40 hex chars) */
const EVM_ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;

export function isValidEvmAddress(address: string): boolean {
  return EVM_ADDRESS_RE.test(address);
}

/** Generate a cryptographically random nonce (32 bytes hex) */
export function generateWalletNonce(): string {
  return crypto.randomBytes(32).toString("hex");
}

/**
 * Build the EIP-4361 inspired message for wallet signing.
 * Includes domain, address, nonce, and timestamp to prevent cross-site replay.
 */
export function buildSignMessage(
  domain: string,
  address: string,
  nonce: string,
  issuedAt: Date,
): string {
  const ts = issuedAt.toISOString();
  return [
    `${domain} wants you to sign in with your Ethereum account:`,
    address,
    "",
    "Sign in to DomiNode proxy service",
    "",
    `URI: https://${domain}`,
    `Nonce: ${nonce}`,
    `Issued At: ${ts}`,
  ].join("\n");
}

/** Convert a wallet address to a synthetic email for the users table */
export function walletToSyntheticEmail(address: string): string {
  return `${address.toLowerCase()}@wallet.dominode.io`;
}

/** Detect synthetic wallet emails */
export function isWalletEmail(email: string): boolean {
  return email.endsWith("@wallet.dominode.io");
}

/** Wallet challenge TTL in milliseconds (5 minutes) */
export const WALLET_CHALLENGE_TTL_MS = 5 * 60 * 1000;
