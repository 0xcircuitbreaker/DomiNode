import type { HttpClient } from "../http.js";

export interface X402Facilitator {
  network: string;
  receivingAddress: string | null;
  currency: string;
}

/** GET /api/x402/info. Prices are server-reported; the SDK hardcodes none. */
export interface X402Info {
  supported: boolean;
  enabled: boolean;
  protocol: string;
  version: string;
  facilitators: Record<string, X402Facilitator>;
  pricing: Record<string, string | number>;
  currencies: string[];
  walletType: string;
  agenticWallets: boolean;
}

export class X402Resource {
  constructor(private http: HttpClient) {}

  /** GET /api/x402/info (no auth). */
  async getInfo(): Promise<X402Info> {
    return this.http.get("/api/x402/info", "none");
  }
}
