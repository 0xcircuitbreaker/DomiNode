import { afterEach, describe, expect, it, vi } from "vitest";
import { apiRequest, fmtMusd, isNodeOnline } from "./api-client.js";
import { scrubCredentials } from "./scrub.js";
import { normalizeSettings, validateSettingsPatch } from "./settings.js";

afterEach(() => vi.unstubAllGlobals());

describe("apiRequest", () => {
  it("strips prototype-pollution keys from responses", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response('{"a":1,"__proto__":{"x":1},"n":{"constructor":{"y":1}}}')));
    const r = await apiRequest<Record<string, unknown>>("https://api.example.com", "/v1/pricing");
    expect(r).toEqual({ a: 1, n: {} });
  });

  it("caps response size", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("x".repeat(3 * 1024 * 1024))));
    await expect(apiRequest("https://api.example.com", "/v1/pricing")).rejects.toThrow(/too large/);
  });

  it("scrubs credentials echoed in server errors", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response('{"error":"bad key dn_live_abcdefgh123 / dn_node_zzzzzzzz"}', { status: 401 })));
    const err = (await apiRequest("https://api.example.com", "/v1/credits").catch((e: unknown) => e)) as Error;
    expect(err.message).not.toMatch(/dn_live_|dn_node_/);
    expect(err.message).toContain("[REDACTED]");
  });

  it("refuses redirects and traversal paths", async () => {
    const f = vi.fn(async () => new Response("{}"));
    vi.stubGlobal("fetch", f);
    await expect(apiRequest("https://api.example.com", "/../x")).rejects.toThrow(/Invalid API path/);
    await apiRequest("https://api.example.com", "/v1/pricing");
    expect((f.mock.calls[0] as unknown[])[1]).toMatchObject({ redirect: "error", credentials: "omit" });
  });
});

describe("helpers", () => {
  it("scrubCredentials covers live/test/node/proxy keys and JWTs", () => {
    const s = scrubCredentials("dn_live_a1 dn_test_b2 dn_node_c3 dn_proxy_d4 eyJhbGciOiJ.eyJzdWIiOiI.abc");
    expect(s).toBe("[REDACTED] [REDACTED] [REDACTED] [REDACTED] [REDACTED]");
  });

  it("formats µUSD", () => {
    expect(fmtMusd("500000")).toBe("$0.50");
    expect(fmtMusd("1234567")).toBe("$1.234567");
    expect(fmtMusd("bad")).toBe("—");
  });

  it("node online requires active + recent last-seen", () => {
    const now = Date.parse("2026-11-06T12:00:00Z");
    expect(isNodeOnline({ status: "active", lastSeenAt: "2026-11-06T11:58:00Z" }, now)).toBe(true);
    expect(isNodeOnline({ status: "active", lastSeenAt: "2026-11-06T11:00:00Z" }, now)).toBe(false);
    expect(isNodeOnline({ status: "revoked", lastSeenAt: "2026-11-06T11:59:00Z" }, now)).toBe(false);
  });

  it("settings: plaintext off by default, invalid stored values dropped", () => {
    const s = normalizeSettings({ plaintext: "yes", country: "KP", gatewayPort: 3128 });
    expect(s.plaintext).toBe(false);
    expect(s.country).toBeNull();
    expect(s.gatewayPort).toBe(3128);
    expect(() => validateSettingsPatch({ apiBase: "https://api.example.com/path" }, "operator")).toThrow();
    expect(validateSettingsPatch({ apiBase: "http://localhost:3000" }, "operator")).toEqual({ apiBase: "http://localhost:3000" });
  });
});
