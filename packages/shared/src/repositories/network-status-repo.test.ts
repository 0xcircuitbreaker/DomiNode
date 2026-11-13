import { describe, it, expect, vi } from "vitest";

vi.mock("../db.js", () => ({ query: vi.fn() }));
import { kAnonymize } from "./network-status-repo.js";

const base = { onlineNodes: 0, seedOnline: 0, communityOnline: 0, paidBytes24h: "0", seedPaidBytes24h: "0", communityPaidBytes24h: "0", byClass: {} };

describe("kAnonymize", () => {
  it("hides the split and totals when one community node is alone", () => {
    const r = kAnonymize({ ...base, onlineNodes: 1, communityOnline: 1, paidBytes24h: "999", communityPaidBytes24h: "999", byClass: { residential: 1 } });
    expect(JSON.stringify(r)).not.toContain("999");
    expect(r.onlineNodes).toBe(0);
    expect(r.byClass).toEqual({});
  });

  it("hides only the split when seeds already form a crowd", () => {
    const r = kAnonymize({ ...base, onlineNodes: 6, seedOnline: 5, communityOnline: 1, paidBytes24h: "1000", seedPaidBytes24h: "900", communityPaidBytes24h: "100", byClass: { dc: 5, residential: 1 } });
    expect(r.onlineNodes).toBe(6);
    expect(r.paidBytes24h).toBe("1000");
    expect(r.seedPaidBytes24h).toBe("0");
    expect(r.communityPaidBytes24h).toBe("0");
    expect(r.byClass).toEqual({ dc: 5 });
    expect(r.suppressed).toContain("byClass");
  });

  it("publishes everything once each group has at least 3 nodes", () => {
    const x = { ...base, onlineNodes: 7, seedOnline: 4, communityOnline: 3, paidBytes24h: "10", seedPaidBytes24h: "6", communityPaidBytes24h: "4", byClass: { dc: 4, residential: 3 } };
    const r = kAnonymize(x);
    expect(r).toMatchObject(x);
    expect(r.suppressed).toEqual([]);
  });
});
