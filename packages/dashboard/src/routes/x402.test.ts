import { describe, it, expect, vi } from "vitest";

const listPricing = vi.fn();
vi.mock("@dominusnode/shared", async (orig) => {
  const actual = await orig<typeof import("@dominusnode/shared")>();
  return { ...actual, policyRepo: { ...actual.policyRepo, listPricing: (...a: unknown[]) => listPricing(...a) } };
});
import express from "express";
import router from "./x402.js";
import { call } from "./v1/test-helpers.js";

describe("GET /api/x402/info", () => {
  it("publishes Bazaar discovery metadata for the gateway resource", async () => {
    const a = express();
    a.use("/api/x402", router);
    const r = await call(a, "GET", "/api/x402/info");
    expect(r.status).toBe(200);
    const d = r.body["discovery"] as { discoverable: boolean; resource: { url: string; description: string; mimeType: string }; extensions: { bazaar: { info: { input: { type: string; method: string } }; schema: unknown } } };
    expect(d.discoverable).toBe(true);
    expect(d.resource.url).toMatch(/^https:\/\//);
    expect(d.resource.description.length).toBeLessThanOrEqual(500);
    expect(d.resource.mimeType).toBe("application/json");
    expect(d.extensions.bazaar.info.input).toMatchObject({ type: "http", method: "GET" });
    expect(d.extensions.bazaar.schema).toBeTruthy();
  });

  it("serves live per-GB and per-request prices from network_pricing", async () => {
    listPricing.mockResolvedValueOnce([
      { ipClass: "residential", pricePerGbMusd: 500000n, updatedAt: new Date() },
      { ipClass: "dc", pricePerGbMusd: 200000n, updatedAt: new Date() },
    ]);
    const a = express();
    a.use("/api/x402", router);
    const r = await call(a, "GET", "/api/x402/info");
    const p = r.body["pricing"] as { bytesPerRequest: number; classes: Record<string, { perGb: { usd: string }; perRequest: { musd: string; usd: string } }> };
    expect(p.bytesPerRequest).toBe(10485760);
    expect(p.classes["residential"]!.perGb.usd).toBe("0.500000");
    // Matches the gateway quote: ceil(500000 × 10485760 / BYTES_PER_GB)
    expect(p.classes["residential"]!.perRequest).toEqual({ musd: "4883", usd: "0.004883" });
    expect(p.classes["dc"]!.perRequest.musd).toBe("1954");
  });

  it("answers with pricing null when the pricing table is unavailable", async () => {
    listPricing.mockRejectedValueOnce(new Error("db down"));
    const a = express();
    a.use("/api/x402", router);
    const r = await call(a, "GET", "/api/x402/info");
    expect(r.status).toBe(200);
    expect(r.body["pricing"]).toBeNull();
  });
});
