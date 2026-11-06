import { describe, it, expect, vi, beforeEach } from "vitest";

const mockGetWallet = vi.fn();
const mockGetDailySpend = vi.fn();
vi.mock("@dominusnode/shared", () => ({
  agenticWalletRepo: {
    getWallet: (...a: unknown[]) => mockGetWallet(...a),
    getDailySpend: (...a: unknown[]) => mockGetDailySpend(...a),
  },
  createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));

import { checkAgenticWalletPolicy } from "./wallet-policy.js";

const W = "00000000-0000-0000-0000-000000000000";
const base = { id: W, user_id: "u", status: "active", allowed_domains: null, daily_limit_cents: null };

describe("proxy-gateway/wallet-policy", () => {
  beforeEach(() => { mockGetWallet.mockReset(); mockGetDailySpend.mockReset(); });

  it("no walletId: allowed, not agent", async () => {
    expect(await checkAgenticWalletPolicy(undefined, "u", "a.com")).toEqual({ allowed: true, isAgent: false });
  });
  it("unknown wallet is rejected (no free agent rate limit)", async () => {
    mockGetWallet.mockResolvedValueOnce(null);
    const r = await checkAgenticWalletPolicy(W, "u", "a.com");
    expect(r.allowed).toBe(false);
    expect(r.isAgent).toBe(false);
  });
  it("frozen wallet is rejected", async () => {
    mockGetWallet.mockResolvedValueOnce({ ...base, status: "frozen" });
    expect((await checkAgenticWalletPolicy(W, "u", "a.com")).allowed).toBe(false);
  });
  it("malformed allowed_domains fails closed", async () => {
    mockGetWallet.mockResolvedValueOnce({ ...base, allowed_domains: "{bad" });
    expect((await checkAgenticWalletPolicy(W, "u", "a.com")).allowed).toBe(false);
  });
  it("DB error fails closed", async () => {
    mockGetWallet.mockRejectedValueOnce(new Error("db down"));
    expect((await checkAgenticWalletPolicy(W, "u", "a.com")).allowed).toBe(false);
  });
  it("active wallet with matching domain: allowed + agent", async () => {
    mockGetWallet.mockResolvedValueOnce({ ...base, allowed_domains: '["a.com"]' });
    expect(await checkAgenticWalletPolicy(W, "u", "x.a.com")).toEqual({ allowed: true, isAgent: true });
  });
});
