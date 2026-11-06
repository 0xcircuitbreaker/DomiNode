import { beforeEach, describe, expect, it } from "vitest";
import { chromeMock } from "../test-setup.js";
import { loadManagedConfig, parseConfig } from "./managed-config.js";

const KEY = "dn_live_abcdefgh12345678";

describe("parseConfig", () => {
  it("maps the managed-policy shape (empty string / 0 mean unset)", () => {
    const r = parseConfig(
      { apiKey: KEY, enabled: true, gatewayHost: "gw.example.com", gatewayPort: 8080, country: "", ipClass: "", spendCapCents: 0, exitCheckUrl: "" },
      "strict",
    );
    expect(r.apiKey).toBe(KEY);
    expect(r.settings).toEqual({ enabled: true, gatewayHost: "gw.example.com", gatewayPort: 8080, country: null, ipClass: null, spendCapCents: null, exitCheckUrl: null });
  });

  it("strict mode rejects unknown keys, bad keys and bad values", () => {
    expect(() => parseConfig({ apiKey: "sk_live_x" }, "strict")).toThrow(/apiKey/);
    expect(() => parseConfig({ nope: 1 }, "strict")).toThrow(/unknown/);
    expect(() => parseConfig({ apiBase: "http://evil.example" }, "strict")).toThrow(/https/);
    expect(() => parseConfig({ controlPageOrigins: ["https://*.example.com"] }, "strict")).toThrow();
    expect(() => parseConfig("x", "strict")).toThrow();
  });

  it("lenient mode keeps valid keys and reports the rest", () => {
    const r = parseConfig({ country: "US", gatewayPort: "8080", ipClass: "dc" }, "lenient");
    expect(r.settings).toEqual({ country: "US", ipClass: "dc" });
    expect(r.errors).toHaveLength(1);
  });

  it("strips prototype pollution", () => {
    const r = parseConfig(JSON.parse('{"__proto__":{"polluted":1},"country":"FR"}'), "strict");
    expect(r.settings).toEqual({ country: "FR" });
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });
});

describe("loadManagedConfig", () => {
  beforeEach(() => chromeMock.storage.managed._store.clear());

  it("reads chrome.storage.managed", async () => {
    chromeMock.storage.managed._store.set("apiKey", KEY);
    chromeMock.storage.managed._store.set("country", "JP");
    chromeMock.storage.managed._store.set("enabled", true);
    chromeMock.storage.managed._store.set("controlExtensionIds", ["abcdefghijklmnopabcdefghijklmnop"]);
    const r = await loadManagedConfig();
    expect(r.apiKey).toBe(KEY);
    expect(r.settings).toEqual({ country: "JP", enabled: true, controlExtensionIds: ["abcdefghijklmnopabcdefghijklmnop"] });
    expect(r.errors).toEqual([]);
  });

  it("returns an empty config when no policy is set", async () => {
    expect(await loadManagedConfig()).toEqual({ settings: {}, errors: [] });
  });
});
