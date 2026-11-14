import type { HttpClient } from "../http.js";
import { invalidArg } from "../errors.js";
import { qs, seg, validateCents, validateIntRange, validateUuid } from "../validation.js";

export interface WalletBalance {
  balanceCents: number;
  balanceUsd: number;
  currency: string;
  lastToppedUp: string | null;
}

/** GET /v1/wallet (agent route, raw API key). */
export interface AgentWalletBalance {
  balanceCents: number;
  currency: string;
  lastToppedUp: string | null;
}

export interface WalletTransaction {
  id: string;
  type: string;
  amountCents: number;
  amountUsd: number;
  description: string;
  paymentProvider: string | null;
  createdAt: string;
}

export interface CryptoInvoice {
  invoiceId: string;
  invoiceUrl: string;
  payCurrency: string;
  priceAmount: number;
}

export interface CryptoInvoiceStatus {
  invoiceId: string;
  status: string;
  amountCents: number;
  provider: string;
  createdAt: string;
}

export interface Forecast {
  dailyAvgCents: number;
  daysRemaining: number | null;
  trend: "up" | "down" | "stable";
  trendPct: number;
}

/** Crypto currencies accepted by /api/wallet/topup/crypto (NOWPayments). */
export const CRYPTO_CURRENCIES = ["btc", "eth", "ltc", "xmr", "zec", "usdc", "sol", "usdt", "dai", "bnb", "link"] as const;
export type CryptoCurrency = (typeof CRYPTO_CURRENCIES)[number];

/** Requester (prepaid) wallet. Card/PayPal top-ups are not available to agents. */
export class WalletResource {
  constructor(private http: HttpClient) {}

  /** GET /v1/wallet — balance with the raw API key (no JWT is minted). */
  async get(): Promise<AgentWalletBalance> {
    return this.http.get("/v1/wallet", "agent");
  }

  /** GET /api/wallet */
  async getBalance(): Promise<WalletBalance> {
    return this.http.get("/api/wallet");
  }

  /** GET /api/wallet/transactions */
  async getTransactions(opts: { limit?: number; offset?: number } = {}): Promise<{ transactions: WalletTransaction[] }> {
    return this.http.get(`/api/wallet/transactions${qs({ limit: opts.limit, offset: opts.offset })}`);
  }

  /** Iterate every wallet transaction (offset pagination; `limit` is the page size, default 50, server max 100). */
  async *iterTransactions(opts: { limit?: number } = {}): AsyncGenerator<WalletTransaction, void, undefined> {
    const limit = opts.limit ?? 50;
    validateIntRange(limit, "limit", 1, 100);
    for (let offset = 0; offset <= 1_000_000; offset += limit) {
      const page = await this.getTransactions({ limit, offset });
      const items = Array.isArray(page.transactions) ? page.transactions : [];
      for (const t of items) yield t;
      if (items.length < limit) return;
    }
  }

  /** GET /api/wallet/forecast */
  async getForecast(): Promise<Forecast> {
    return this.http.get("/api/wallet/forecast");
  }

  /** POST /api/wallet/topup/crypto — $10..$1,000 (1000..100000 cents). */
  async topUpCrypto(amountCents: number, currency: CryptoCurrency | string): Promise<CryptoInvoice> {
    validateCents(amountCents);
    if (amountCents < 1000 || amountCents > 100_000) throw invalidArg("crypto top-up must be between 1000 and 100000 cents ($10-$1,000)");
    const c = String(currency).toLowerCase();
    if (!(CRYPTO_CURRENCIES as readonly string[]).includes(c)) throw invalidArg(`currency must be one of ${CRYPTO_CURRENCIES.join(", ")}`);
    return this.http.post("/api/wallet/topup/crypto", { amountUsd: amountCents / 100, currency: c });
  }

  /** GET /api/wallet/crypto/status/:invoiceId */
  async getCryptoStatus(invoiceId: string): Promise<CryptoInvoiceStatus> {
    return this.http.get(`/api/wallet/crypto/status/${seg(validateUuid(invoiceId, "invoiceId"))}`);
  }
}
