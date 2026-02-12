import type { HttpClient } from "./http.js";
import type { Wallet, WalletTransaction, StripeCheckout, CryptoInvoice } from "./types.js";

export interface WalletBalanceResponse {
  balanceCents: number;
  balanceUsd: number;
  currency: string;
  lastToppedUp: string | null;
}

export interface TransactionsResponse {
  transactions: Array<{
    id: string;
    type: WalletTransaction["type"];
    amountCents: number;
    amountUsd: number;
    description: string;
    paymentProvider: string | null;
    createdAt: string;
  }>;
}

export interface StripeCheckoutResponse {
  sessionId: string;
  url: string;
}

export interface CryptoInvoiceResponse {
  invoiceId: string;
  invoiceUrl: string;
  payCurrency: string;
  priceAmount: number;
}

export interface ForecastResponse {
  dailyAvgCents: number;
  daysRemaining: number | null;
  trend: "up" | "down" | "stable";
  trendPct: number;
}

export class WalletResource {
  constructor(private http: HttpClient) {}

  /** Get current wallet balance. */
  async getBalance(): Promise<WalletBalanceResponse> {
    return this.http.get("/api/wallet");
  }

  /** Get wallet transaction history. */
  async getTransactions(opts?: { limit?: number; offset?: number }): Promise<TransactionsResponse> {
    const params = new URLSearchParams();
    if (opts?.limit !== undefined) params.set("limit", String(opts.limit));
    if (opts?.offset !== undefined) params.set("offset", String(opts.offset));
    const qs = params.toString();
    return this.http.get(`/api/wallet/transactions${qs ? `?${qs}` : ""}`);
  }

  /** Create a Stripe checkout session for wallet top-up. */
  async topUpStripe(amountCents: number): Promise<StripeCheckoutResponse> {
    return this.http.post("/api/wallet/topup/stripe", { amountCents });
  }

  /** Create a crypto invoice for wallet top-up. */
  async topUpCrypto(amountCents: number, currency: string): Promise<CryptoInvoiceResponse> {
    const amountUsd = amountCents / 100;
    return this.http.post("/api/wallet/topup/crypto", { amountUsd, currency });
  }

  /** Get spending forecast based on recent usage. */
  async getForecast(): Promise<ForecastResponse> {
    return this.http.get("/api/wallet/forecast");
  }
}
