import { describe, it, expect, vi } from "vitest";
import * as payouts from "./payouts.js";
import { PayoutNotBroadcastError, type PayoutDeps, type DuePayout } from "./payouts.js";
import { classifyBroadcastError, isDropped } from "./payout-sender-ethers.js";

const ADDR = "0x" + "c".repeat(40);
const TX = "0x" + "d".repeat(64);
const due = (id: string, amountMusd = 2_000_000n): DuePayout => ({ id, userId: "u-" + id, payoutWalletId: "w", address: ADDR, chain: "base", amountMusd });

function deps(over: Partial<PayoutDeps> = {}): PayoutDeps {
  return {
    enabled: () => true,
    loadSdn: async () => new Set<string>(),
    listAutoCandidates: async () => [],
    requestWithdraw: vi.fn().mockResolvedValue({}),
    listDue: async () => [due("p1"), due("p2"), due("p3")],
    listSubmitted: async () => [],
    claim: vi.fn().mockResolvedValue(true),
    recordTx: vi.fn().mockResolvedValue(true),
    releaseUnbroadcast: vi.fn().mockResolvedValue(true),
    markConfirmed: vi.fn().mockResolvedValue({}),
    markFailed: vi.fn().mockResolvedValue({}),
    markReversed: vi.fn().mockResolvedValue({}),
    blockWallet: vi.fn().mockResolvedValue(undefined),
    sender: { send: vi.fn().mockResolvedValue({ txHash: TX }), waitForReceipt: vi.fn().mockResolvedValue("confirmed") },
    ...over,
  };
}

describe("payout broadcast error classification", () => {
  it("definite RPC rejections are not-broadcast; everything else is uncertain", () => {
    for (const code of ["INSUFFICIENT_FUNDS", "NONCE_EXPIRED", "REPLACEMENT_UNDERPRICED"]) {
      expect(classifyBroadcastError({ code })).toBe("rejected");
    }
    for (const e of [{ code: "TIMEOUT" }, { code: "NETWORK_ERROR" }, { code: "SERVER_ERROR" }, new Error("x"), null]) {
      expect(classifyBroadcastError(e)).toBe("uncertain");
    }
  });

  it("a rejection that affects every payout releases the claimed one and stops the run", async () => {
    const send = vi.fn().mockRejectedValue(new PayoutNotBroadcastError("broadcast rejected: INSUFFICIENT_FUNDS", true));
    const d = deps({ sender: { send, waitForReceipt: vi.fn() } });
    const r = await payouts.runOnce(d);
    expect(send).toHaveBeenCalledTimes(1);
    expect(d.releaseUnbroadcast).toHaveBeenCalledWith("p1");
    expect(d.claim).toHaveBeenCalledTimes(1);
    expect(r.released).toBe(1);
    expect(r.ambiguous).toBe(0);
  });
});

describe("dropped transaction detection", () => {
  it("dropped only when the node forgot the tx and the confirmed nonce passed it", async () => {
    const gone = { getTransaction: async () => null, confirmedNonce: async () => 8 };
    expect(await isDropped(TX, 7, gone)).toBe(true);
    expect(await isDropped(TX, 8, gone)).toBe(false);
    expect(await isDropped(TX, 7, { ...gone, getTransaction: async () => ({}) })).toBe(false);
    expect(await isDropped(TX, undefined, gone)).toBe(false);
  });

  it("reconciliation reverses dropped payouts and checks submitted ones in parallel with a short timeout", async () => {
    const waitForReceipt = vi.fn(async (h: string) => (h === "0xdrop" ? "dropped" : "pending"));
    const subs = Array.from({ length: 12 }, (_, i) => ({ id: `s${i}`, txHash: i === 0 ? "0xdrop" : `0x${i}` }));
    const d = deps({ listDue: async () => [], listSubmitted: async () => subs, sender: { send: vi.fn(), waitForReceipt } });
    const r = await payouts.runOnce(d);
    expect(waitForReceipt).toHaveBeenCalledTimes(12);
    expect(waitForReceipt).toHaveBeenCalledWith("0xdrop", payouts.RECONCILE_RECEIPT_TIMEOUT_MS);
    expect(d.markFailed).toHaveBeenCalledWith("s0", { txHash: "0xdrop", outcome: "dropped" });
    expect(d.markReversed).toHaveBeenCalledWith("s0", "tx dropped");
    expect(r.reversed).toBe(1);
  });
});

describe("treasury preflight", () => {
  it("sends nothing when the hot wallet has no gas", async () => {
    const send = vi.fn();
    const d = deps({ sender: { send, waitForReceipt: vi.fn(), preflight: async () => ({ gasOk: false, usdcMusd: 10n ** 12n }) } });
    const r = await payouts.runOnce(d);
    expect(send).not.toHaveBeenCalled();
    expect(d.claim).not.toHaveBeenCalled();
    expect(r.sent).toBe(0);
  });

  it("stops when the USDC balance cannot cover the next payout", async () => {
    const send = vi.fn().mockResolvedValue({ txHash: TX });
    const d = deps({ sender: { send, waitForReceipt: vi.fn().mockResolvedValue("confirmed"), preflight: async () => ({ gasOk: true, usdcMusd: 5_000_000n }) } });
    const r = await payouts.runOnce(d);
    expect(send).toHaveBeenCalledTimes(2);
    expect(r.sent).toBe(2);
  });
});
