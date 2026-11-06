import { describe, it, expect, vi } from "vitest";
import { collusionRepo } from "@dominusnode/shared";
import * as job from "./collusion.js";

const S = collusionRepo.DEFAULT_COLLUSION_SETTINGS;
const USD = 1_000_000n;
const node = (id: string, top: bigint) => ({
  nodeId: id, ownerUserId: "o-" + id, totalMusd: 100n * USD, requesters: 5, topRequesterUserId: "r", topMusd: top, topKMusd: top, hhiBps: 0,
});

function deps(over: Partial<job.CollusionDeps> = {}): job.CollusionDeps {
  return {
    getSettings: vi.fn(async () => ({ ...S, updatedBy: null, updatedAt: null })),
    listNodes: vi.fn(async () => []),
    listCircular: vi.fn(async () => []),
    evaluateNode: collusionRepo.evaluateNode,
    evaluateCircular: collusionRepo.evaluateCircular,
    record: vi.fn(async () => ({ flagged: true, frozen: false })),
    ...over,
  };
}

describe("collusion job", () => {
  it("pages nodes by id, records only suspicious ones, and walks circular pairs", async () => {
    const pages = [[node("a", 90n * USD), node("b", 10n * USD)], [node("c", 85n * USD)]];
    const listNodes = vi.fn(async (_after: string | null, _l: number, _w: number, _k: number) => pages.shift() ?? []);
    const circ = [[{ a: "x", b: "y", aToBMusd: 5n * USD, bToAMusd: 5n * USD }]];
    const listCircular = vi.fn(async (_c: { a: string; b: string } | null, _l: number, _w: number, _m: bigint) => circ.shift() ?? []);
    const d = deps({ listNodes, listCircular });
    const r = await job.runOnce({ ...d, pageLimit: 2 });
    expect(listNodes.mock.calls.map((c) => c[0])).toEqual([null, "b"]);
    expect(listNodes.mock.calls[0].slice(1)).toEqual([2, 30, 3]);
    expect(listCircular.mock.calls[0]).toEqual([null, 2, 30, S.circularMinMusd]);
    expect(r).toEqual({ nodes: 3, pairs: 1, flagged: 4, frozen: 0, failed: 0 });
  });

  it("counts failures without stopping and reports freezes", async () => {
    let n = 0;
    const record = vi.fn(async () => { n++; if (n === 1) throw new Error("db"); return { flagged: true, frozen: true }; });
    const warn = vi.fn();
    const r = await job.runOnce(deps({
      listNodes: vi.fn(async () => [node("a", 99n * USD), node("b", 99n * USD)]),
      record, logger: { info: vi.fn(), warn, error: vi.fn() },
    }));
    expect(r).toMatchObject({ failed: 1, flagged: 1, frozen: 1 });
    expect(warn).toHaveBeenCalledWith("collusion auto-freeze", expect.objectContaining({ ownerUserId: "o-b" }));
  });

  it("respects maxPages", async () => {
    const listNodes = vi.fn(async () => [node("a", 0n)]);
    await job.runOnce(deps({ listNodes, pageLimit: 1, maxPages: 2 }));
    expect(listNodes).toHaveBeenCalledTimes(2);
  });
});
