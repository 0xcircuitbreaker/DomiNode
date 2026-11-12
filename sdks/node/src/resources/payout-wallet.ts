import type { HttpClient } from "../http.js";
import { invalidArg, ProtocolError } from "../errors.js";
import { assertSigner, sign, type Signer } from "../signer.js";
import { buildPayoutWalletMessage, extractUserId, assertSameMessage } from "../messages.js";
import { HEX64_RE, validateAddress } from "../validation.js";

export const PAYOUT_CHAINS = ["base", "base-sepolia"] as const;
export type PayoutChain = (typeof PAYOUT_CHAINS)[number];

export interface PayoutWalletInfo {
  address: string;
  chain: "base" | string;
  /** "pending" while a change cools down until activeFrom. */
  status: "active" | "pending";
  activeFrom: string;
}

export interface PayoutWalletChallenge {
  nonce: string;
  message: string;
  expiresAt: string;
  signer: string;
  oldWalletSignatureRequired: boolean;
  oldWalletAddress: string | null;
}

export interface SetPayoutWalletOptions {
  /** New payout address (0x + 40 hex). Screened against OFAC SDN server-side. */
  address: string;
  /**
   * "base" (default) or "base-sepolia". base-sepolia is an explicit opt-in for staging;
   * the server decides whether it is accepted (refused in production).
   */
  chain?: PayoutChain;
  /** Signer for the account's LINKED wallet. */
  signer: Signer;
  /** Signer for the CURRENT payout wallet; required when changing it and it is not the linked wallet. */
  oldWalletSigner?: Signer;
}

export interface SetPayoutWalletResult {
  payoutWallet: PayoutWalletInfo;
  changed: boolean;
  cooldownHours: number;
}

/** Where withdrawals are sent. /v1 agent routes. */
export class PayoutWalletResource {
  constructor(private http: HttpClient) {}

  /** GET /v1/payout-wallet */
  async get(): Promise<{ payoutWallet: PayoutWalletInfo | null; cooldownHours: number }> {
    return this.http.get("/v1/payout-wallet", "agent");
  }

  /**
   * Register or change the payout wallet: POST /v1/payout-wallet/challenge -> rebuild message locally
   * (refuse on mismatch) -> linked-wallet signature (+ old payout wallet signature when required) -> PUT.
   * A change cools down 72h; unsent payouts to the old wallet are reversed to available credit.
   */
  async set(opts: SetPayoutWalletOptions): Promise<SetPayoutWalletResult> {
    const signer = assertSigner(opts?.signer);
    const address = validateAddress(opts.address).toLowerCase();
    const chain = opts.chain ?? "base";
    if (!(PAYOUT_CHAINS as readonly string[]).includes(chain)) throw invalidArg("chain must be 'base' or 'base-sepolia'");
    if (opts.oldWalletSigner !== undefined) assertSigner(opts.oldWalletSigner, "oldWalletSigner");

    const ch = await this.http.post<PayoutWalletChallenge>("/v1/payout-wallet/challenge", { address, chain }, "agent");
    if (typeof ch.nonce !== "string" || !HEX64_RE.test(ch.nonce)) throw new ProtocolError("invalid challenge nonce");
    if (typeof ch.signer !== "string" || ch.signer.toLowerCase() !== signer.address.toLowerCase()) {
      throw new ProtocolError("the account's linked wallet is not the signer's address; refusing to sign");
    }
    const local = buildPayoutWalletMessage({ userId: extractUserId(String(ch.message)), wallet: signer.address, address, chain, nonce: ch.nonce });
    assertSameMessage(ch.message, local, "payout wallet");

    let oldWalletSignature: string | undefined;
    if (ch.oldWalletSignatureRequired === true) {
      if (!opts.oldWalletSigner) {
        throw invalidArg(`changing the payout wallet requires oldWalletSigner for ${String(ch.oldWalletAddress)}`);
      }
      if (typeof ch.oldWalletAddress !== "string" || ch.oldWalletAddress.toLowerCase() !== opts.oldWalletSigner.address.toLowerCase()) {
        throw invalidArg("oldWalletSigner.address is not the current payout wallet");
      }
    }
    const signature = await sign(signer, local);
    if (ch.oldWalletSignatureRequired === true && opts.oldWalletSigner) {
      oldWalletSignature = await sign(opts.oldWalletSigner, local, "oldWalletSigner");
    }
    const body: Record<string, string> = { address, chain, nonce: ch.nonce, signature };
    if (oldWalletSignature) body["oldWalletSignature"] = oldWalletSignature;
    return this.http.put("/v1/payout-wallet", body, "agent");
  }
}
