import { describe, it, expect } from "vitest";
import { validatePolicy, PolicyValidationError, DEFAULT_POLICY, policySha256, isFloorKey } from "./policy.js";

function errs(input: unknown, current?: typeof DEFAULT_POLICY): string[] {
  try { validatePolicy(input, { current }); return []; }
  catch (e) { expect(e).toBeInstanceOf(PolicyValidationError); return (e as PolicyValidationError).errors; }
}

describe("validatePolicy", () => {
  it("fills defaults; plaintext defaults to opt_in", () => {
    const p = validatePolicy({});
    expect(p.plaintext).toBe("opt_in");
    expect(p.ports).toEqual([80, 443]);
    expect(p.sanctionedCountries).toEqual(["CU", "IR", "KP", "RU", "SY"]);
  });
  it("accepts all plaintext modes, rejects others", () => {
    for (const m of ["deny", "opt_in", "allow"]) expect(validatePolicy({ plaintext: m }).plaintext).toBe(m);
    expect(errs({ plaintext: "opt-in" }).length).toBeGreaterThan(0);
  });
  it("rejects floor keys at top level and nested", () => {
    for (const k of ["floorHash", "hardDenyPorts", "privateRanges", "ssrfCheck", "ssrf_disable", "floor"]) {
      expect(errs({ [k]: true }).join()).toMatch(/floor keys/);
    }
    expect(errs({ nodeDefaults: { maxStreams: 1, maxGbDay: 1, privateRanges: [] } }).join()).toMatch(/floor keys/);
    expect(isFloorKey("FloorPorts")).toBe(true);
  });
  it("rejects unknown and dangerous keys", () => {
    expect(errs({ foo: 1 }).join()).toMatch(/unknown key/);
    expect(errs(JSON.parse('{"__proto__":{"x":1}}')).join()).toMatch(/forbidden/);
  });
  it("ports: only 80/443, no hard-deny, no dupes", () => {
    expect(validatePolicy({ ports: [443] }).ports).toEqual([443]);
    expect(errs({ ports: [25] }).join()).toMatch(/hard-denied/);
    expect(errs({ ports: [8080] }).join()).toMatch(/outside the floor/);
    expect(errs({ ports: [] }).length).toBe(1);
    expect(errs({ ports: [80, 80] }).join()).toMatch(/duplicate/);
  });
  it("category and domain denylists normalised", () => {
    const p = validatePolicy({ denyCategories: ["banking", "banking"], denyDomains: ["Example-Bank.COM."] });
    expect(p.denyCategories).toEqual(["banking"]);
    expect(p.denyDomains).toEqual(["example-bank.com"]);
    expect(errs({ denyDomains: ["http://x.com"] }).length).toBe(1);
    expect(errs({ denyCategories: ["Bad Cat"] }).length).toBe(1);
  });
  it("caps are range checked", () => {
    expect(errs({ nodeDefaults: { maxStreams: 0, maxGbDay: 5 } }).join()).toMatch(/maxStreams/);
    expect(errs({ requesterLimits: { reqPerSec: 1.5, dailySpendMusd: 1 } }).join()).toMatch(/reqPerSec/);
    expect(errs({ nodeCapsPerPrefix: { per32: 10, per24: 5, perAsn: 5 } }).join()).toMatch(/per32/);
    expect(errs({ logRetentionDays: 0 }).length).toBe(1);
  });
  it("sanctions are grow-only vs constant and current", () => {
    expect(errs({ sanctionedCountries: ["CU", "IR", "KP", "SY"] }).join()).toMatch(/RU/);
    const cur = validatePolicy({ sanctionedCountries: ["CU", "IR", "KP", "RU", "SY", "BY"] });
    expect(errs({}, cur).join()).toMatch(/grow-only; cannot remove BY/);
    expect(validatePolicy({ sanctionedCountries: ["BY", "CU", "IR", "KP", "RU", "SY", "VE"] }, { current: cur }).sanctionedCountries).toContain("VE");
    expect(errs({ sanctionedCountries: ["cu"] }).length).toBeGreaterThan(0);
  });
  it("attestation text/minVersion", () => {
    expect(validatePolicy({ attestation: { minVersion: 2, text: "ok" } }).attestation.minVersion).toBe(2);
    expect(errs({ attestation: { minVersion: 2, text: "" } }).join()).toMatch(/text/);
    expect(errs({ attestation: { minVersion: 0, text: "x" } }).join()).toMatch(/minVersion/);
    const cur = validatePolicy({ attestation: { minVersion: 3, text: "x" } });
    expect(errs({ attestation: { minVersion: 2, text: "x" } }, cur).join()).toMatch(/cannot decrease/);
  });
  it("omitting attestation cannot reset minVersion below current", () => {
    const cur = validatePolicy({ attestation: { minVersion: 5, text: "x" } });
    expect(errs({}, cur).join()).toMatch(/attestation.minVersion: cannot decrease/);
    expect(errs({ plaintext: "deny" }, cur).join()).toMatch(/cannot decrease/);
    expect(validatePolicy({ attestation: { minVersion: 5, text: "y" } }, { current: cur }).attestation.minVersion).toBe(5);
  });
  it("rejects non-object and oversize bodies", () => {
    expect(errs([]).length).toBe(1);
    expect(errs({ denyDomains: Array(9000).fill("a".repeat(40) + ".com") }).join()).toMatch(/exceeds/);
  });
  it("hash is key-order independent", () => {
    const a = validatePolicy({ plaintext: "deny", logRetentionDays: 30 });
    const b = validatePolicy({ logRetentionDays: 30, plaintext: "deny" });
    expect(policySha256(a)).toBe(policySha256(b));
    expect(policySha256(a)).toMatch(/^[0-9a-f]{64}$/);
    expect(policySha256(a)).not.toBe(policySha256(validatePolicy({})));
  });
});

describe("freeTierRelay", () => {
  it("defaults to false, accepts booleans, rejects others", () => {
    expect(validatePolicy({}).freeTierRelay).toBe(false);
    expect(validatePolicy({ freeTierRelay: true }).freeTierRelay).toBe(true);
    expect(errs({ freeTierRelay: "yes" })).toContain("freeTierRelay: must be a boolean");
  });
});
