import type { HttpClient } from "../http.js";

export interface AgenticWallet {
  id: string;
  label: string;
  balanceCents: number;
  spendingLimitCents: number;
  status: string;
  createdAt: string;
}

export interface AgenticWalletTransaction {
  id: string;
  walletId: string;
  type: string;
  amountCents: number;
  description: string;
  sessionId: string | null;
  createdAt: string;
}

export interface AgenticWalletListResponse {
  wallets: AgenticWallet[];
}

export interface AgenticWalletFundResponse {
  transaction: AgenticWalletTransaction;
}

export interface AgenticWalletTransactionsResponse {
  transactions: AgenticWalletTransaction[];
}

export interface AgenticWalletDeleteResponse {
  deleted: boolean;
  refundedCents: number;
}

export class AgenticWalletResource {
  constructor(private http: HttpClient) {}

  async create(label: string, spendingLimitCents: number = 10000): Promise<AgenticWallet> {
    if (!Number.isInteger(spendingLimitCents) || spendingLimitCents < 0 || spendingLimitCents > 2_147_483_647) {
      throw new Error("spendingLimitCents must be a non-negative integer <= 2,147,483,647");
    }
    return this.http.post("/api/agent-wallet", { label, spendingLimitCents });
  }

  async list(): Promise<AgenticWalletListResponse> {
    return this.http.get("/api/agent-wallet");
  }

  async get(walletId: string): Promise<AgenticWallet> {
    return this.http.get(`/api/agent-wallet/${encodeURIComponent(walletId)}`);
  }

  async fund(walletId: string, amountCents: number): Promise<AgenticWalletFundResponse> {
    if (!Number.isInteger(amountCents) || amountCents <= 0 || amountCents > 2_147_483_647) {
      throw new Error("amountCents must be a positive integer <= 2,147,483,647");
    }
    return this.http.post(`/api/agent-wallet/${encodeURIComponent(walletId)}/fund`, { amountCents });
  }

  async transactions(walletId: string, limit?: number, offset?: number): Promise<AgenticWalletTransactionsResponse> {
    const params = new URLSearchParams();
    if (limit !== undefined) params.set("limit", String(limit));
    if (offset !== undefined) params.set("offset", String(offset));
    const qs = params.toString();
    return this.http.get(`/api/agent-wallet/${encodeURIComponent(walletId)}/transactions${qs ? `?${qs}` : ""}`);
  }

  async freeze(walletId: string): Promise<AgenticWallet> {
    return this.http.post(`/api/agent-wallet/${encodeURIComponent(walletId)}/freeze`, {});
  }

  async unfreeze(walletId: string): Promise<AgenticWallet> {
    return this.http.post(`/api/agent-wallet/${encodeURIComponent(walletId)}/unfreeze`, {});
  }

  async delete(walletId: string): Promise<AgenticWalletDeleteResponse> {
    return this.http.delete(`/api/agent-wallet/${encodeURIComponent(walletId)}`);
  }
}
