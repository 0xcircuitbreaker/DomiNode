import type { HttpClient } from "../http.js";
import type { TokenManager } from "../token-manager.js";
import type { User } from "../types.js";
import { validateAddress, validateSignature } from "../validation.js";
import { assertSigner, sign, type Signer } from "../signer.js";
import { ProtocolError } from "../errors.js";

export interface WalletChallenge {
  /** Message to sign (EIP-191). */
  message: string;
  nonce: string;
  /** Same as message (legacy field). */
  challenge: string;
  expiresAt: string;
}

export interface WalletVerifyResult {
  token?: string;
  refreshToken?: string;
  user?: User;
  /** True when MFA is enabled on the account: no tokens were issued or stored. */
  mfaRequired?: boolean;
  mfaChallengeToken?: string;
}

export interface WalletLinkResult {
  success: boolean;
  walletAddress: string;
}

/** EIP-191 wallet sign-in. Wallet-identity accounts are agent principals for /v1 routes. */
export class WalletAuthResource {
  constructor(private http: HttpClient, private tokens: TokenManager) {}

  /** POST /api/auth/wallet/challenge (no auth). */
  async challenge(address: string): Promise<WalletChallenge> {
    return this.http.post("/api/auth/wallet/challenge", { address: validateAddress(address) }, "none");
  }

  /**
   * POST /api/auth/wallet/verify (no auth). Creates the account on first use.
   * Stores the JWT pair unless the response says mfaRequired (then nothing is stored).
   */
  async verify(address: string, signature: string): Promise<WalletVerifyResult> {
    const body = { address: validateAddress(address), signature: validateSignature(signature) };
    const result = await this.http.post<WalletVerifyResult>("/api/auth/wallet/verify", body, "none");
    if (result.mfaRequired === true) return { mfaRequired: true, mfaChallengeToken: result.mfaChallengeToken };
    if (typeof result.token === "string" && typeof result.refreshToken === "string") {
      this.tokens.setTokens(result.token, result.refreshToken);
    }
    return result;
  }

  /** challenge -> signer.signMessage -> verify. Refuses if the challenge does not name the signer's address. */
  async signIn(signer: Signer): Promise<WalletVerifyResult> {
    assertSigner(signer);
    const ch = await this.challenge(signer.address);
    if (typeof ch.message !== "string" || !ch.message.toLowerCase().includes(signer.address.toLowerCase())) {
      throw new ProtocolError("wallet challenge does not name the signer's address; refusing to sign");
    }
    const signature = await sign(signer, ch.message);
    return this.verify(signer.address, signature);
  }

  /** POST /api/auth/wallet/link — link a wallet to the current (JWT) account. */
  async link(address: string, signature: string): Promise<WalletLinkResult> {
    return this.http.post("/api/auth/wallet/link", { address: validateAddress(address), signature: validateSignature(signature) });
  }
}
