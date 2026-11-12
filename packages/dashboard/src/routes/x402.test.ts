import { describe, it, expect } from "vitest";
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
});
