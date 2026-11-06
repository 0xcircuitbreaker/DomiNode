import { describe, it, expect, vi, afterEach } from "vitest";
import { runOnce } from "./node-status.js";
import { Job, setJobRunRecorder } from "./runner.js";

describe("node-status-sync", () => {
  it("closes revoked/suspended/deleted tunnels and syncs other statuses", async () => {
    const close = vi.fn();
    const setStatus = vi.fn();
    const r = await runOnce({
      liveNodeIds: () => ["a", "b", "c", "d", "e"],
      fetchStatuses: async () => new Map([["a", "active"], ["b", "revoked"], ["c", "quarantined"], ["e", "suspended"]]),
      setStatus, close,
    });
    expect(r).toEqual({ checked: 5, closed: 3, updated: 2 });
    expect(close.mock.calls.map((c) => c[0]).sort()).toEqual(["b", "d", "e"]);
    expect(close).toHaveBeenCalledWith("d", "status: deleted");
    expect(setStatus).toHaveBeenCalledWith("c", "quarantined");
    expect(setStatus).toHaveBeenCalledWith("a", "active");
  });

  it("does nothing without live nodes", async () => {
    const fetchStatuses = vi.fn();
    const r = await runOnce({ liveNodeIds: () => [], fetchStatuses, setStatus: vi.fn(), close: vi.fn() });
    expect(r.checked).toBe(0);
    expect(fetchStatuses).not.toHaveBeenCalled();
  });
});

describe("job run recorder", () => {
  afterEach(() => setJobRunRecorder(null));
  const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };

  it("records success and failure, and swallows recorder errors", async () => {
    const rec = vi.fn().mockRejectedValueOnce(new Error("db down")).mockResolvedValue(undefined);
    setJobRunRecorder(rec);
    await new Job({ name: "ok", intervalMs: 1000, lockKey: null, logger, run: async () => ({}) }).tick();
    await new Job({ name: "bad", intervalMs: 1000, lockKey: null, logger, run: async () => { throw new Error("boom"); } }).tick();
    expect(rec).toHaveBeenCalledTimes(2);
    expect(rec.mock.calls[0][0]).toMatchObject({ name: "ok", ok: true, error: null });
    expect(rec.mock.calls[1][0]).toMatchObject({ name: "bad", ok: false, error: "boom" });
  });

  it("does not record ticks skipped by the advisory lock", async () => {
    const rec = vi.fn().mockResolvedValue(undefined);
    setJobRunRecorder(rec);
    const pool = { connect: async () => ({ query: async () => ({ rows: [{ ok: false }] }), release: () => {} }) };
    await new Job({ name: "locked", intervalMs: 1000, lockKey: 1, pool, logger, run: async () => ({}) }).tick();
    expect(rec).not.toHaveBeenCalled();
  });
});
