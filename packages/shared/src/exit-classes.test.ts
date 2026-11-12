import { describe, it, expect } from "vitest";
import {
  EXIT_CLASSES, NODE_IP_CLASSES, PRICING_CLASSES, DEFAULT_PRICE_PER_GB_MUSD, DEFAULT_TIER_WEIGHT_BPS,
  conservativeClass, isClassDowngrade, isExitClass, isNodeIpClass, tierWeightBpsFor, weightedIpCount,
} from "./exit-classes.js";
import * as fs from "node:fs";
import * as path from "node:path";

describe("exit classes (single source)", () => {
  it("lists the four exit classes; unknown is node-only; any is pricing-only", () => {
    expect([...EXIT_CLASSES]).toEqual(["residential", "mobile", "dc", "masked"]);
    expect(NODE_IP_CLASSES).toContain("unknown");
    expect([...PRICING_CLASSES]).toEqual(["any", "residential", "mobile", "dc", "masked"]);
    expect(isExitClass("masked")).toBe(true);
    expect(isExitClass("unknown")).toBe(false);
    expect(isExitClass("__proto__")).toBe(false);
    expect(isNodeIpClass("unknown")).toBe(true);
  });

  it("defaults: masked $0.10/GB, weights 1.0/1.0/0.4/0.25", () => {
    expect(DEFAULT_PRICE_PER_GB_MUSD.masked).toBe(100_000);
    expect(DEFAULT_TIER_WEIGHT_BPS).toEqual({ residential: 10_000, mobile: 10_000, dc: 4_000, masked: 2_500 });
  });

  it("schema.sql CHECK constraints match the class list", () => {
    const sql = fs.readFileSync(path.join(__dirname, "schema.sql"), "utf8");
    expect(sql).toContain("ip_class IN ('residential','mobile','dc','masked','unknown')");
    expect(sql).toContain("ip_class IN ('any','residential','mobile','dc','masked')");
    expect(sql).toContain("INSERT INTO network_pricing (ip_class, price_per_gb_musd) VALUES ('masked', 100000)");
    expect(sql).toMatch(/tier_weight_bps = 4000 WHERE ip_class = 'dc'/);
    expect(sql).toMatch(/tier_weight_bps = 2500 WHERE ip_class = 'masked'/);
  });
});

describe("conservativeClass", () => {
  it("masked always wins (positive evidence), else lower trust rank", () => {
    expect(conservativeClass("residential", "masked")).toBe("masked");
    expect(conservativeClass("unknown", "masked")).toBe("masked");
    expect(conservativeClass("residential", "dc")).toBe("dc");
    expect(conservativeClass("dc", "unknown")).toBe("unknown");
    expect(conservativeClass("residential", "unknown")).toBe("unknown");
    expect(conservativeClass("residential", "mobile")).toBe("residential");
    expect(conservativeClass("dc", "dc")).toBe("dc");
  });
});

describe("isClassDowngrade (declared vs verified)", () => {
  it("flags a verified class less trusted than declared", () => {
    expect(isClassDowngrade("residential", "masked")).toBe(true);
    expect(isClassDowngrade("residential", "dc")).toBe(true);
    expect(isClassDowngrade("mobile", "masked")).toBe(true);
    expect(isClassDowngrade("dc", "masked")).toBe(true);
  });
  it("does not flag equal, upgrades, missing declarations or unknown data", () => {
    expect(isClassDowngrade("masked", "masked")).toBe(false);
    expect(isClassDowngrade("dc", "residential")).toBe(false);
    expect(isClassDowngrade("masked", "residential")).toBe(false);
    expect(isClassDowngrade(null, "masked")).toBe(false);
    expect(isClassDowngrade("residential", "unknown")).toBe(false);
    expect(isClassDowngrade("residential", null)).toBe(false);
  });
});

describe("tier weights", () => {
  it("uses configured weights, falling back to defaults for missing/invalid rows", () => {
    expect(tierWeightBpsFor("masked", { masked: 2000 })).toBe(2000);
    expect(tierWeightBpsFor("masked", {})).toBe(2500);
    expect(tierWeightBpsFor("dc", { dc: 10_001 })).toBe(4000);
    expect(tierWeightBpsFor("dc", { dc: 1.5 })).toBe(4000);
    expect(tierWeightBpsFor("residential")).toBe(10_000);
  });
  it("unknown / null class gets the LOWEST configured weight", () => {
    expect(tierWeightBpsFor("unknown")).toBe(2500);
    expect(tierWeightBpsFor(null, { masked: 1000 })).toBe(1000);
    expect(tierWeightBpsFor("unknown", { dc: 500 })).toBe(500);
  });
  it("weighted IP counts floor to whole IPs with integer math", () => {
    expect(weightedIpCount([])).toBe(0);
    expect(weightedIpCount([10_000])).toBe(1); // 1 residential
    expect(weightedIpCount([2500, 2500, 2500])).toBe(0); // 3 masked = 0.75
    expect(weightedIpCount([2500, 2500, 2500, 2500])).toBe(1); // 4 masked = 1.0
    expect(weightedIpCount([10_000, 2500, 2500, 2500])).toBe(1); // 1.75
    expect(weightedIpCount([4000, 4000, 4000])).toBe(1); // 3 dc = 1.2
    expect(weightedIpCount(Array(10).fill(10_000))).toBe(10); // silver needs 3, gold 10
    expect(weightedIpCount(Array(10).fill(2500))).toBe(2); // 10 masked IPs = 2.5 -> 2
    expect(() => weightedIpCount([10_001])).toThrow();
    expect(() => weightedIpCount([-1])).toThrow();
  });
});
