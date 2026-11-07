import { describe, it, expect, beforeEach } from "vitest";
import { recordUnmetDemand, drainUnmetDemand, restoreUnmetDemand, pendingUnmetKeys } from "./unmet-demand.js";
import { runUnmetFlush } from "./jobs/launch.js";

const T = Date.UTC(2026, 10, 7, 10, 25);

describe("unmet demand aggregation", () => {
  beforeEach(() => { drainUnmetDemand(); });

  it("aggregates by (hour, country, class) only and normalises input", () => {
    recordUnmetDemand("br", "residential", T);
    recordUnmetDemand("BR", "residential", T + 60_000);
    recordUnmetDemand(undefined, undefined, T);
    recordUnmetDemand("not-a-country", "bogus", T);
    const rows = drainUnmetDemand().sort((a, b) => b.requests - a.requests);
    expect(rows).toEqual([
      { hour: new Date(Date.UTC(2026, 10, 7, 10)), country: "BR", ipClass: "residential", requests: 2 },
      { hour: new Date(Date.UTC(2026, 10, 7, 10)), country: "", ipClass: "", requests: 2 },
    ]);
    expect(pendingUnmetKeys()).toBe(0);
  });

  it("is size-capped", () => {
    for (let i = 0; i < 12_000; i++) recordUnmetDemand("US", "dc", T + i * 3_600_000);
    expect(pendingUnmetKeys()).toBe(10_000);
  });

  it("flush restores rows when the write fails", async () => {
    recordUnmetDemand("DE", "dc", T);
    const write = async () => { throw new Error("db"); };
    await expect(runUnmetFlush({ drain: drainUnmetDemand, restore: restoreUnmetDemand, write })).rejects.toThrow();
    expect(pendingUnmetKeys()).toBe(1);
    expect(await runUnmetFlush({ drain: drainUnmetDemand, restore: restoreUnmetDemand, write: async (r) => r.length })).toEqual({ rows: 1 });
    expect(pendingUnmetKeys()).toBe(0);
  });
});
