import * as crypto from "node:crypto";

/** Validate EVM address format (0x + 40 hex chars) */
const EVM_ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;

/** Placeholder (non-deliverable) email domain for wallet-identity accounts. */
export const WALLET_EMAIL_DOMAIN = "wallet.dominusnode.com";
/** Domain used while the DDG subdomain was primary; still recognised for existing rows. */
export const LEGACY_WALLET_EMAIL_DOMAIN = "wallet.dominusnode.daedalusdevelopmentgroup.com";

/** Placeholder domain written into anonymised (deleted) user rows. */
export const DELETED_EMAIL_DOMAIN = "deleted.dominusnode.com";
/** Deleted-user domain used while the DDG subdomain was primary. */
export const LEGACY_DELETED_EMAIL_DOMAIN = "deleted.dominusnode.daedalusdevelopmentgroup.com";

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
    "Sign in to Dominus Node proxy service",
    "",
    `URI: https://${domain}`,
    `Nonce: ${nonce}`,
    `Issued At: ${ts}`,
  ].join("\n");
}

/** Convert a wallet address to a synthetic email for the users table */
export function walletToSyntheticEmail(address: string): string {
  return `${address.toLowerCase()}@${WALLET_EMAIL_DOMAIN}`;
}

/** Detect synthetic wallet emails */
export function isWalletEmail(email: string): boolean {
  return email.endsWith(`@${WALLET_EMAIL_DOMAIN}`) || email.endsWith(`@${LEGACY_WALLET_EMAIL_DOMAIN}`);
}

/** True for anonymised (deleted) user emails under the current or legacy domain. */
export function isDeletedUserEmail(email: string): boolean {
  return email.endsWith(`@${DELETED_EMAIL_DOMAIN}`) || email.endsWith(`@${LEGACY_DELETED_EMAIL_DOMAIN}`);
}

/** Wallet challenge TTL in milliseconds (5 minutes) */
export const WALLET_CHALLENGE_TTL_MS = 5 * 60 * 1000;
