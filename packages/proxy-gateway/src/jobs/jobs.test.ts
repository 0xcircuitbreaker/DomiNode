import { describe, it, expect, vi } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { withAdvisoryLock, envInt, Job, type LockPool } from "./runner.js";
import * as maturity from "./maturity.js";
import * as retention from "./retention.js";
import * as tiers from "./tiers.js";
import * as repFlush from "./reputation-flush.js";
import * as payouts from "./payouts.js";
import * as settleRetry from "./relay-settle-retry.js";
import { PayoutNotBroadcastError, PayoutBroadcastUncertainError, type PayoutDeps } from "./payouts.js";
import { loadSdnFile, parseSdnAddresses, SdnUnavailableError } from "./sdn.js";
import { readSignerKeyFile, createEthersPayoutSender } from "./payout-sender-ethers.js";

const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };

function lockPool(granted: boolean) {
  const queries: string[] = [];
  const release = vi.fn();
  const pool: LockPool = {
    connect: async () => ({
      query: async (sql: string) => {
        queries.push(sql);
        return { rows: [{ ok: granted }] };
      },
      release,
    }),
  };
  return { pool, queries, release };
}

describe("runner", () => {
  it("runs under the advisory lock and unlocks", async () => {
    const { pool, queries, release } = lockPool(true);
    const r = await withAdvisoryLock(pool, 7, async () => 42);
    expect(r).toEqual({ ran: true, result: 42 });
    expect(queries[0]).toMatch(/pg_try_advisory_lock/);
    expect(queries[1]).toMatch(/pg_advisory_unlock/);
    expect(release).toHaveBeenCalledOnce();
  });

  it("skips when another instance holds the lock", async () => {
    const { pool, release } = lockPool(false);
    const fn = vi.fn();
    expect(await withAdvisoryLock(pool, 7, fn)).toEqual({ ran: false });
    expect(fn).not.toHaveBeenCalled();
    expect(release).toHaveBeenCalledOnce();
  });

  it("unlocks even when the job throws", async () => {
    const { pool, queries } = lockPool(true);
    await expect(withAdvisoryLock(pool, 7, async () => { throw new Error("x"); })).rejects.toThrow("x");
    expect(queries.some((q) => /unlock/.test(q))).toBe(true);
  });

  it("envInt rejects NaN and out of range", () => {
    expect(envInt({}, "X", 5, 1, 10)).toBe(5);
    expect(envInt({ X: "7" }, "X", 5, 1, 10)).toBe(7);
    expect(() => envInt({ X: "abc" }, "X", 5, 1, 10)).toThrow();
    expect(() => envInt({ X: "11" }, "X", 5, 1, 10)).toThrow();
  });

  it("does not overlap runs and stop waits for in-flight run", async () => {
    let resolve!: () => void;
    const run = vi.fn(() => new Promise<void>((r) => { resolve = r; }));
    const job = new Job({ name: "t", intervalMs: 1000, lockKey: null, run, logger });
    const p1 = job.tick();
    void job.tick();
    expect(run).toHaveBeenCalledOnce();
    const stopped = job.stop();
    resolve();
    await p1;
    await stopped;
    expect(job.running).toBe(false);
  });
});

describe("maturity job", () => {
  it("loops full batches and stops on a short one", async () => {
    const matureDue = vi.fn()
      .mockResolvedValueOnce({ scanned: 1000, matured: 1000, skippedFrozen: 0, movedMusd: 5n })
      .mockResolvedValueOnce({ scanned: 3, matured: 2, skippedFrozen: 1, movedMusd: 1n });
    const r = await maturity.runOnce({ matureDue });
    expect(r).toEqual({ batches: 2, matured: 1002, skippedFrozen: 1, movedMusd: 6n });
  });
  it("stops when only frozen rows remain", async () => {
    const matureDue = vi.fn().mockResolvedValue({ scanned: 1000, matured: 0, skippedFrozen: 1000, movedMusd: 0n });
    const r = await maturity.runOnce({ matureDue });
    expect(matureDue).toHaveBeenCalledOnce();
    expect(r.batches).toBe(1);
  });
});

describe("retention job", () => {
  it("deletes in batches of 1000 using policy logRetentionDays", async () => {
    const purgeBatch = vi.fn().mockResolvedValueOnce(1000).mockResolvedValueOnce(10);
    const r = await retention.runOnce({ getRetentionDays: () => 30, purgeBatch });
    expect(purgeBatch).toHaveBeenCalledWith(30, 1000);
    expect(r).toEqual({ days: 30, deleted: 1010, batches: 2 });
  });
  it("refuses an out-of-range retention", async () => {
    await expect(retention.runOnce({ getRetentionDays: () => 0, purgeBatch: vi.fn() })).rejects.toThrow();
  });
});

describe("tiers job", () => {
  it("applies each owner and isolates failures", async () => {
    const apply = vi.fn().mockRejectedValueOnce(new Error("x")).mockResolvedValue({});
    const r = await tiers.runOnce({
      listOwners: vi.fn().mockResolvedValueOnce(["a", "b"]),
      getUptimeBps: vi.fn().mockResolvedValue(9000),
      getStats: vi.fn().mockResolvedValue({ tenureDays: 1, uptimeBps: 9000, activeIps: 1, reputation: 5000, daysSinceLastClawback: null }),
      apply,
    });
    expect(r).toEqual({ owners: 1, failed: 1 });
  });
});

describe("reputation flush job", () => {
  it("maps counters to health updates and quarantines low-reputation nodes", async () => {
    const flushHealth = vi.fn().mockResolvedValue(2);
    const quarantine = vi.fn().mockResolvedValue(null);
    const etld = new Map();
    const r = await repFlush.runOnce({
      drain: () => [
        { nodeId: "n1", day: 1, reputation: 5000, quarantine: false, counters: { bytes: 10, streams: 1, failures: 0, burns: 0, disputes: 0, etld } },
        { nodeId: "n2", day: 1, reputation: 500, quarantine: true, counters: { bytes: 0, streams: 0, failures: 3, burns: 2, disputes: 0, etld } },
      ],
      flushHealth, quarantine,
    });
    expect(flushHealth.mock.calls[0]![0][1]).toEqual({ nodeId: "n2", bytes: 0, streams: 0, failures: 3, burns: 2, reputation: 500 });
    expect(quarantine).toHaveBeenCalledWith("n2");
    expect(r).toEqual({ nodes: 2, flushed: 2, quarantined: 1 });
  });
});

describe("SDN list", () => {
  it("extracts lowercase EVM addresses from any text format", () => {
    const s = parseSdnAddresses(`Digital Currency Address - ETH 0xAbCdEf0123456789abcdef0123456789ABCDEF01;\n0x${"1".repeat(41)}`);
    expect(s.has("0xabcdef0123456789abcdef0123456789abcdef01")).toBe(true);
    expect(s.size).toBe(1); // 41-hex run is not an address
  });
  it("throws when unset or missing", async () => {
    await expect(loadSdnFile(undefined)).rejects.toBeInstanceOf(SdnUnavailableError);
    await expect(loadSdnFile("/nonexistent/sdn.csv")).rejects.toBeInstanceOf(SdnUnavailableError);
  });
  it("loads a readable file", async () => {
    const dir = mkdtempSync(join(tmpdir(), "sdn-"));
    const f = join(dir, "sdn.txt");
    writeFileSync(f, "0x" + "a".repeat(40));
    expect((await loadSdnFile(f)).has("0x" + "a".repeat(40))).toBe(true);
  });
});

const ADDR = "0x" + "c".repeat(40);
const TX = "0x" + "d".repeat(64);

function payoutDeps(over: Partial<PayoutDeps> = {}): PayoutDeps {
  return {
    enabled: () => true,
    loadSdn: async () => new Set<string>(),
    listAutoCandidates: async () => [],
    requestWithdraw: vi.fn().mockResolvedValue({}),
    listDue: async () => [{ id: "p1", userId: "u1", payoutWalletId: "w1", address: ADDR, chain: "base", amountMusd: 2_000_000n }],
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

describe("payout job", () => {
  it("does nothing when payouts are disabled", async () => {
    const d = payoutDeps({ enabled: () => false });
    expect((await payouts.runOnce(d)).skipped).toBe("disabled");
    expect(d.sender.send).not.toHaveBeenCalled();
  });

  it("refuses to pay anything when the SDN file is unavailable", async () => {
    const d = payoutDeps({ loadSdn: () => loadSdnFile("/nonexistent/sdn") });
    const r = await payouts.runOnce(d);
    expect(r.skipped).toBe("sdn_unavailable");
    expect(d.sender.send).not.toHaveBeenCalled();
    expect(d.claim).not.toHaveBeenCalled();
  });

  it("refuses an SDN-listed destination, blocks the wallet and freezes the account", async () => {
    const d = payoutDeps({ loadSdn: async () => new Set([ADDR]) });
    const r = await payouts.runOnce(d);
    expect(r.sanctioned).toBe(1);
    expect(d.blockWallet).toHaveBeenCalledWith("w1", "u1");
    expect(d.claim).not.toHaveBeenCalled();
    expect(d.sender.send).not.toHaveBeenCalled();
  });

  it("confirms a successful payout and records the tx hash", async () => {
    const d = payoutDeps();
    const r = await payouts.runOnce(d);
    expect(d.sender.send).toHaveBeenCalledWith({ payoutId: "p1", to: ADDR, amountMusd: 2_000_000n, chain: "base" });
    expect(d.recordTx).toHaveBeenCalledWith("p1", TX);
    expect(d.markConfirmed).toHaveBeenCalledWith("p1", TX);
    expect(r.confirmed).toBe(1);
  });

  it("is idempotent by payout id: an unclaimable payout is never sent", async () => {
    const d = payoutDeps({ claim: vi.fn().mockResolvedValue(false) });
    await payouts.runOnce(d);
    expect(d.sender.send).not.toHaveBeenCalled();
  });

  it("a reverted tx is marked failed then reversed (re-credit)", async () => {
    const d = payoutDeps({ sender: { send: vi.fn().mockResolvedValue({ txHash: TX }), waitForReceipt: vi.fn().mockResolvedValue("reverted") } });
    const r = await payouts.runOnce(d);
    expect(d.markFailed).toHaveBeenCalledWith("p1", { txHash: TX, outcome: "reverted" });
    expect(d.markReversed).toHaveBeenCalledWith("p1", "tx reverted");
    expect(d.markConfirmed).not.toHaveBeenCalled();
    expect(r.reversed).toBe(1);
  });

  it("releases only a provably un-broadcast payout back to pending", async () => {
    const d = payoutDeps({ sender: { send: vi.fn().mockRejectedValue(new PayoutNotBroadcastError("x")), waitForReceipt: vi.fn() } });
    const r = await payouts.runOnce(d);
    expect(d.releaseUnbroadcast).toHaveBeenCalledWith("p1");
    expect(r.released).toBe(1);
  });

  it("leaves an ambiguous send submitted (never re-sent, never reversed)", async () => {
    const d = payoutDeps({ sender: { send: vi.fn().mockRejectedValue(new PayoutBroadcastUncertainError(TX, "?")), waitForReceipt: vi.fn() } });
    const r = await payouts.runOnce(d);
    expect(r.ambiguous).toBe(1);
    expect(d.releaseUnbroadcast).not.toHaveBeenCalled();
    expect(d.markReversed).not.toHaveBeenCalled();
    expect(d.recordTx).toHaveBeenCalledWith("p1", TX);
  });

  it("reconciles earlier submitted payouts", async () => {
    const d = payoutDeps({ listDue: async () => [], listSubmitted: async () => [{ id: "p0", txHash: TX }],
      sender: { send: vi.fn(), waitForReceipt: vi.fn().mockResolvedValue("dropped") } });
    await payouts.runOnce(d);
    expect(d.markFailed).toHaveBeenCalledWith("p0", { txHash: TX, outcome: "dropped" });
    expect(d.markReversed).toHaveBeenCalledWith("p0", "tx dropped");
  });

  it("auto-queues with a per-day idempotency key", async () => {
    const d = payoutDeps({ listDue: async () => [], listAutoCandidates: async () => [{ userId: "u1", availableMusd: 3_000_000n }],
      now: () => new Date("2026-11-05T12:00:00Z") });
    await payouts.runOnce(d);
    expect(d.requestWithdraw).toHaveBeenCalledWith({ userId: "u1", amountMusd: 3_000_000n, idempotencyKey: "auto-20261105", trigger: "auto" });
  });

  it("stops at the per-run treasury cap", async () => {
    const d = payoutDeps({ runCapMusd: 1_000_000n });
    await payouts.runOnce(d);
    expect(d.claim).not.toHaveBeenCalled();
  });
});

describe("ethers payout sender config", () => {
  it("never accepts a signer key from env", () => {
    expect(() => createEthersPayoutSender({ PAYOUT_SIGNER_KEY: "0x" + "1".repeat(64), PAYOUT_RPC_URL: "https://rpc" })).toThrow(/KEY_FILE/);
  });
  it("requires an https RPC url", () => {
    expect(() => createEthersPayoutSender({ PAYOUT_RPC_URL: "http://rpc" })).toThrow(/https/);
  });
  it("reads and validates the key file", () => {
    const dir = mkdtempSync(join(tmpdir(), "key-"));
    const good = join(dir, "k");
    writeFileSync(good, "1".repeat(64) + "\n");
    expect(readSignerKeyFile(good)).toBe("0x" + "1".repeat(64));
    const bad = join(dir, "b");
    writeFileSync(bad, "nope");
    expect(() => readSignerKeyFile(bad)).toThrow();
    expect(() => readSignerKeyFile(undefined)).toThrow();
  });
});

describe("relay settle retry job", () => {
  const input = { sessionId: "s1", bytesGateway: 1234n } as never;
  const mk = () => ({
    listDue: vi.fn().mockResolvedValue([{ sessionId: "s1", attempts: 0, input }, { sessionId: "s2", attempts: 19, input: { ...(input as object), sessionId: "s2" } }]),
    settle: vi.fn(),
    markDone: vi.fn().mockResolvedValue(undefined),
    markFailed: vi.fn(),
    onDead: vi.fn().mockResolvedValue(undefined),
    logger,
  });

  it("settles due rows and marks them done", async () => {
    const d = mk();
    d.settle.mockResolvedValue({ status: "settled" });
    const r = await settleRetry.runOnce(d);
    expect(r).toEqual({ due: 2, settled: 2, failed: 0, dead: 0 });
    expect(d.markDone).toHaveBeenCalledWith("s1");
    expect(d.markDone).toHaveBeenCalledWith("s2");
  });

  it("backs off failures and dead-letters exhausted rows (session closed as error)", async () => {
    const d = mk();
    d.settle.mockRejectedValue(new Error("db down"));
    d.markFailed.mockResolvedValueOnce(false).mockResolvedValueOnce(true);
    const r = await settleRetry.runOnce(d);
    expect(r).toEqual({ due: 2, settled: 0, failed: 2, dead: 1 });
    expect(d.markDone).not.toHaveBeenCalled();
    expect(d.onDead).toHaveBeenCalledTimes(1);
    expect(d.onDead).toHaveBeenCalledWith("s2", 1234);
  });

  it("runs under its own advisory lock", async () => {
    const { JOB_LOCK_KEYS } = await import("./runner.js");
    expect(new Set(Object.values(JOB_LOCK_KEYS)).size).toBe(Object.keys(JOB_LOCK_KEYS).length);
    expect(JOB_LOCK_KEYS.settleRetry).toBeDefined();
  });
});
