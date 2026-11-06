import { describe, expect, it } from "vitest";
import { DEFAULT_GATEWAY_PORT } from "./constants.js";
import { parseConfig } from "./managed-config.js";
import { assertGatewayTransport, DEFAULT_SETTINGS, normalizeSettings, validateSettingsPatch } from "./settings.js";

describe("gatewayTls setting", () => {
  it("defaults to TLS on the gateway TLS port", () => {
    expect(DEFAULT_SETTINGS.gatewayTls).toBe(true);
    expect(DEFAULT_GATEWAY_PORT).toBe(8443);
  });

  it("is operator-only (not changeable by control channels)", () => {
    expect(validateSettingsPatch({ gatewayTls: false }, "operator")).toEqual({ gatewayTls: false });
    expect(() => validateSettingsPatch({ gatewayTls: false }, "control")).toThrow(/control channel/);
    expect(() => validateSettingsPatch({ gatewayTls: "no" }, "operator")).toThrow(/boolean/);
  });

  it("refuses plaintext for non-local gateways", () => {
    expect(() => assertGatewayTransport({ gatewayHost: "proxy.dominusnode.com", gatewayTls: false })).toThrow(/localhost/);
    expect(() => assertGatewayTransport({ gatewayHost: "localhost", gatewayTls: false })).not.toThrow();
    expect(() => assertGatewayTransport({ gatewayHost: "127.0.0.1", gatewayTls: false })).not.toThrow();
  });

  it("normalize falls back to TLS for a stored plaintext non-local gateway", () => {
    expect(normalizeSettings({ gatewayHost: "gw.example.com", gatewayTls: false }).gatewayTls).toBe(true);
    expect(normalizeSettings({ gatewayHost: "localhost", gatewayTls: false }).gatewayTls).toBe(false);
  });

  it("is accepted by managed config / import", () => {
    expect(parseConfig({ gatewayTls: false, gatewayHost: "127.0.0.1", gatewayPort: 8080 }, "strict").settings)
      .toEqual({ gatewayTls: false, gatewayHost: "127.0.0.1", gatewayPort: 8080 });
  });
});
