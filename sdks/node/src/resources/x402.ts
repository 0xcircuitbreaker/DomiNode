import type { HttpClient } from "../http.js";

export interface X402Facilitator {
  address: string;
  chain: string;
  network: string;
}

export interface X402Pricing {
  perRequestCents: number;
  perGbCents: number;
  currency: string;
}

export interface X402Info {
  supported: boolean;
  enabled: boolean;
  protocol: string;
  version: string;
  facilitators: X402Facilitator[];
  pricing: X402Pricing;
  currencies: string[];
  walletType: string;
  agenticWallets: boolean;
}

/**
 * x402 (HTTP 402 Payment Required) protocol information.
 *
 * Provides details about x402 micropayment support, facilitator addresses,
 * pricing, and supported chains/currencies for AI agent payments.
 */
export class X402Resource {
  constructor(private http: HttpClient) {}

  /**
   * Get x402 protocol information including facilitator details,
   * pricing, supported chains, and currencies.
   *
   * This endpoint does not require authentication.
   */
  async getInfo(): Promise<X402Info> {
    return this.http.get("/api/x402/info", false);
  }
}
