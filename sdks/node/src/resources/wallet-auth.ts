import type { HttpClient } from "../http.js";
import type { TokenManager } from "../token-manager.js";
import type { User } from "../types.js";

export interface WalletChallenge {
  challenge: string;
  expiresAt: string;
}

export interface WalletVerifyResult {
  token: string;
  refreshToken: string;
  user: User;
  /** When true, the user must complete MFA before authentication is granted. */
  mfaRequired?: boolean;
  /** Challenge token to pass to auth.verifyMfa() when mfaRequired is true. */
  mfaChallengeToken?: string;
}

export interface WalletLinkResult {
  success: boolean;
  walletAddress: string;
}

// Ethereum address validation: 0x followed by 40 hex characters
const ETH_ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;

// EIP-191 signature format: 0x prefix + 130 hex chars (65 bytes)
const EIP191_SIGNATURE_RE = /^0x[0-9a-fA-F]{130}$/;
const MAX_SIGNATURE_LENGTH = 200;

function validateAddress(address: string): void {
  if (!address || typeof address !== "string") {
    throw new Error("address is required and must be a string");
  }
  if (!ETH_ADDRESS_RE.test(address)) {
    throw new Error("address must be a valid Ethereum address (0x followed by 40 hex characters)");
  }
}

function validateSignature(signature: string): void {
  if (!signature || typeof signature !== "string") {
    throw new Error("signature is required and must be a string");
  }
  // Max length check before regex
  if (signature.length > MAX_SIGNATURE_LENGTH) {
    throw new Error(`signature must not exceed ${MAX_SIGNATURE_LENGTH} characters`);
  }
  // EIP-191 format validation
  if (!EIP191_SIGNATURE_RE.test(signature)) {
    throw new Error("signature must be a valid EIP-191 signature (0x followed by 130 hex characters)");
  }
}

/**
 * Wallet-based authentication using EIP-191 signed messages.
 *
 * Allows Ethereum wallet holders to authenticate by signing a server-issued
 * challenge message. Supports account creation, login, and linking a wallet
 * to an existing account.
 */
export class WalletAuthResource {
  private tokenManager: TokenManager;

  constructor(private http: HttpClient, tokenManager: TokenManager) {
    this.tokenManager = tokenManager;
  }

  /**
   * Request a signature challenge for the given Ethereum address.
   *
   * The returned challenge must be signed with the wallet's private key
   * and submitted via `verify()` to complete authentication.
   *
   * This endpoint does not require authentication.
   */
  async challenge(address: string): Promise<WalletChallenge> {
    validateAddress(address);
    return this.http.post("/api/auth/wallet/challenge", { address }, false);
  }

  /**
   * Submit a signed challenge to create an account or log in.
   *
   * If the address is not yet associated with an account, a new one is created.
   * Returns JWT tokens and user information on success.
   * Tokens are automatically stored for subsequent authenticated requests.
   *
   * This endpoint does not require authentication.
   *
   * @param address - Ethereum address (0x-prefixed, 40 hex chars)
   * @param signature - EIP-191 signature of the challenge message
   * @param challenge - Optional: the challenge string (server looks up internally)
   */
  async verify(address: string, signature: string, challenge?: string): Promise<WalletVerifyResult> {
    validateAddress(address);
    validateSignature(signature);
    const body: Record<string, string> = { address, signature };
    if (challenge) body.challenge = challenge;
    const result: WalletVerifyResult = await this.http.post("/api/auth/wallet/verify", body, false);
    // Detect MFA-required response — don't store tokens, surface to caller
    if (result.mfaRequired) {
      return result;
    }
    // Store tokens after verify (matching Python/Go/Java SDKs)
    if (result.token && result.refreshToken) {
      this.tokenManager.setTokens(result.token, result.refreshToken);
    }
    return result;
  }

  /**
   * Link an Ethereum wallet to the currently authenticated account.
   *
   * Requires JWT authentication. The challenge must have been previously
   * obtained via `challenge()` and signed with the wallet.
   *
   * @param address - Ethereum address
   * @param signature - EIP-191 signature
   * @param challenge - Optional: the challenge string
   */
  async link(address: string, signature: string, challenge?: string): Promise<WalletLinkResult> {
    validateAddress(address);
    validateSignature(signature);
    const body: Record<string, string> = { address, signature };
    if (challenge) body.challenge = challenge;
    return this.http.post("/api/auth/wallet/link", body);
  }
}
