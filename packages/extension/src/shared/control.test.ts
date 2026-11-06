import { describe, expect, it } from "vitest";
import { isAllowedExtensionSender, isAllowedPageSender, validateControlMessage } from "./control.js";

const ALLOWED = "abcdefghijklmnopabcdefghijklmnop";
const OWN = "ponmlkjihgfedcbaponmlkjihgfedcba";

describe("validateControlMessage", () => {
  it("accepts the documented commands", () => {
    expect(validateControlMessage({ v: 1, type: "getStatus" })).toEqual({ type: "getStatus" });
    expect(validateControlMessage({ v: 1, type: "rotateSession" })).toEqual({ type: "rotateSession" });
    expect(validateControlMessage({ v: 1, type: "enable" })).toEqual({ type: "enable" });
    expect(
      validateControlMessage({ v: 1, type: "setSettings", settings: { country: "de", ipClass: "mobile", sticky: true, plaintext: false } }),
    ).toEqual({ type: "setSettings", settings: { country: "DE", ipClass: "mobile", sticky: true, plaintext: false } });
  });

  it("rejects missing version, unknown types and extra fields", () => {
    expect(() => validateControlMessage({ type: "getStatus" })).toThrow(/version/);
    expect(() => validateControlMessage({ v: 1, type: "deleteEverything" })).toThrow(/unknown command/);
    expect(() => validateControlMessage({ v: 1, type: "getStatus", extra: 1 })).toThrow(/unexpected field/);
    expect(() => validateControlMessage("getStatus")).toThrow();
    expect(() => validateControlMessage(null)).toThrow();
    expect(() => validateControlMessage([1])).toThrow();
  });

  it("never lets a control channel change the key, gateway, spend cap or allowlists", () => {
    for (const settings of [
      { apiKey: "dn_live_aaaaaaaaaa" },
      { gatewayHost: "evil.example" },
      { gatewayPort: 9999 },
      { apiBase: "https://evil.example" },
      { spendCapCents: 999999 },
      { controlExtensionIds: [ALLOWED] },
      { controlPageOrigins: ["https://evil.example"] },
      { exitCheckUrl: "https://evil.example" },
    ]) {
      expect(() => validateControlMessage({ v: 1, type: "setSettings", settings })).toThrow();
    }
  });

  it("validates values strictly (no coercion)", () => {
    const bad = [
      { country: "USA" },
      { country: "RU" }, // OFAC
      { country: "IR" },
      { ipClass: "isp" },
      { sticky: "true" },
      { sessionId: "has-dash" },
      { rotateMinutes: 1.5 },
      { rotateMinutes: -1 },
    ];
    for (const settings of bad) expect(() => validateControlMessage({ v: 1, type: "setSettings", settings })).toThrow();
  });

  it("strips prototype-pollution keys and caps message size", () => {
    const polluted = JSON.parse('{"v":1,"type":"setSettings","settings":{"__proto__":{"x":1},"country":"US"}}');
    expect(validateControlMessage(polluted)).toEqual({ type: "setSettings", settings: { country: "US" } });
    expect(({} as Record<string, unknown>).x).toBeUndefined();
    expect(() => validateControlMessage({ v: 1, type: "setSettings", settings: { sessionId: "a".repeat(5000) } })).toThrow(/too large/);
  });
});

describe("sender allowlists", () => {
  it("allows only listed extension ids", () => {
    expect(isAllowedExtensionSender({ id: ALLOWED }, [ALLOWED])).toBe(true);
    expect(isAllowedExtensionSender({ id: ALLOWED, origin: `chrome-extension://${ALLOWED}` }, [ALLOWED])).toBe(true);
    expect(isAllowedExtensionSender({ id: OWN }, [ALLOWED])).toBe(false);
    expect(isAllowedExtensionSender({}, [ALLOWED])).toBe(false);
    expect(isAllowedExtensionSender({ id: ALLOWED }, [])).toBe(false);
  });

  it("rejects web-page senders even if they claim an allowed id", () => {
    expect(isAllowedExtensionSender({ id: ALLOWED, url: "https://evil.example/x" }, [ALLOWED])).toBe(false);
  });

  it("page bridge: own content script, top frame, exact allowlisted origin only", () => {
    const tab = { id: 1 };
    const ok = { id: OWN, tab, frameId: 0, url: "https://app.example.com/run?x=1" };
    expect(isAllowedPageSender(ok, OWN, ["https://app.example.com"])).toBe(true);
    expect(isAllowedPageSender(ok, OWN, [])).toBe(false); // disabled by default
    expect(isAllowedPageSender({ ...ok, url: "https://app.example.com:8443/" }, OWN, ["https://app.example.com"])).toBe(false);
    expect(isAllowedPageSender({ ...ok, url: "http://app.example.com/" }, OWN, ["https://app.example.com"])).toBe(false);
    expect(isAllowedPageSender({ ...ok, frameId: 3 }, OWN, ["https://app.example.com"])).toBe(false);
    expect(isAllowedPageSender({ ...ok, tab: undefined }, OWN, ["https://app.example.com"])).toBe(false);
    expect(isAllowedPageSender({ ...ok, id: ALLOWED }, OWN, ["https://app.example.com"])).toBe(false);
  });
});
