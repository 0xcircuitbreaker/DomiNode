import { describe, it, expect } from "vitest";
import { checkGatewayEnv } from "./env-check.js";

describe("gateway startup env validation", () => {
  it("passes a minimal dev config", () => {
    expect(checkGatewayEnv({ DATABASE_URL: "postgres://x" })).toEqual([]);
  });
  it("names every missing required variable", () => {
    const e = checkGatewayEnv({ NODE_ENV: "production" });
    expect(e).toContain("DATABASE_URL is required");
    expect(e.some((m) => m.startsWith("COORD_SIGNING_KEY_FILE is required in production"))).toBe(true);
  });
  it("reports port clashes", () => {
    const e = checkGatewayEnv({ DATABASE_URL: "x", PROXY_TLS_PORT: "8443", TUNNEL_PORT: "8443" });
    expect(e.join(" ")).toMatch(/PROXY_TLS_PORT and TUNNEL_PORT are both 8443/);
  });
});
