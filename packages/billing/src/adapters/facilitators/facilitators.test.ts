import { describe, it, expect, afterEach } from "vitest";
import { getFacilitator, facilitatorOverride, FACILITATOR_URLS } from "./index.js";
import { NotConfiguredError } from "../types.js";
import { detectFacilitator } from "../../x402.js";

describe("x402 facilitator adapters", () => {
  afterEach(() => { delete process.env["X402_FACILITATOR"]; });

  it("resolves the three facilitators", () => {
    expect(getFacilitator("coinbase").id).toBe("coinbase");
    expect(getFacilitator("payai").id).toBe("payai");
    expect(getFacilitator("selfhosted").id).toBe("selfhosted");
    expect(() => getFacilitator("__proto__" as never)).toThrow();
  });

  it("selfhosted throws NotConfigured", async () => {
    await expect(getFacilitator("selfhosted").verify("x", { version: "1", accepts: [] })).rejects.toBeInstanceOf(NotConfiguredError);
    await expect(getFacilitator("selfhosted").settle("x")).rejects.toBeInstanceOf(NotConfiguredError);
  });

  it("uses only hardcoded https URLs", () => {
    for (const f of Object.values(FACILITATOR_URLS)) for (const u of Object.values(f)) expect(u).toMatch(/^https:\/\//);
    expect(Object.isFrozen(FACILITATOR_URLS)).toBe(true);
  });

  it("X402_FACILITATOR overrides detection only for allowlisted values", () => {
    process.env["X402_FACILITATOR"] = "payai";
    expect(facilitatorOverride()).toBe("payai");
    expect(detectFacilitator(JSON.stringify({ network: "base" }))).toBe("payai");
    process.env["X402_FACILITATOR"] = "https://evil.example";
    expect(facilitatorOverride()).toBeNull();
    expect(detectFacilitator(JSON.stringify({ network: "base" }))).toBe("coinbase");
  });
});
