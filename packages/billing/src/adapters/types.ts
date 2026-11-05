import type { IncomingHttpHeaders } from "node:http";
import type { X402Requirements, X402VerifyResult, X402Settlement, X402PaymentOption, X402Facilitator } from "../x402.js";

/** Payment adapter interfaces (DESIGN.md §7). All money is integer µUSD (bigint). */

export interface PaymentRequirement {
  amountMusd: bigint;
  resource: string;
  payTo: string;
  network: string;
  asset: string;
  expiresAt: number;
}
export interface VerifyResult {
  ok: boolean;
  payer?: string;
  paymentHash: string;
  amountMusd?: bigint;
  reason?: string;
  /** Rail-specific context needed by settle (e.g. the x402 facilitator). */
  facilitator?: X402Facilitator;
}
export interface SettleResult {
  ok: boolean;
  txRef?: string;
  reason?: string;
}

export type X402FacilitatorId = "coinbase" | "payai" | "selfhosted";

/** Pluggable network backend under the x402 rail (wire shapes unchanged from x402.ts). */
export interface X402FacilitatorAdapter {
  readonly id: X402FacilitatorId;
  verify(paymentHeader: string, requirements: X402Requirements): Promise<X402VerifyResult>;
  settle(paymentHeader: string, accept?: X402PaymentOption): Promise<X402Settlement>;
}

export interface PerRequestRail {
  readonly id: "x402" | "mpp";
  enabled(): boolean;
  requirements(r: { amountMusd: bigint; resource: string }): unknown;
  parseHeader(h: IncomingHttpHeaders): string | null;
  verify(payload: string, req: { amountMusd: bigint; resource: string }): Promise<VerifyResult>;
  settle(payload: string, req: { amountMusd: bigint; resource: string }, verified: VerifyResult): Promise<SettleResult>;
  /** Release a claimed payment hash after a rejection before settle. */
  release(paymentHash: string): Promise<void>;
}

export interface PrepaidCallbackResult {
  chargeId: string;
  status: "paid" | "failed" | "pending";
  amountCents: number;
  userId?: string;
}
export interface PrepaidRail {
  readonly id: "nowpayments" | "tempo" | "stripe" | "paypal";
  createCharge(userId: string, amountCents: number, opts?: Record<string, unknown>): Promise<{ chargeId: string; instructions: unknown }>;
  handleCallback(rawBody: Buffer, headers: IncomingHttpHeaders): Promise<PrepaidCallbackResult | null>;
}

export class NotConfiguredError extends Error {
  constructor(what: string) {
    super(`${what} is not configured`);
    this.name = "NotConfiguredError";
  }
}
