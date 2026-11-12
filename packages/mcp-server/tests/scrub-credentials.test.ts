import { describe, it, expect } from "vitest";
import { scrubCredentials } from "../src/http-client.js";

describe("scrubCredentials", () => {
  it("redacts dn_node_ agent-node credentials", () => {
    const out = scrubCredentials("bad token dn_node_abc123DEF_-x in request");
    expect(out).not.toContain("dn_node_abc");
    expect(out).toContain("[REDACTED]");
  });
  it("still redacts dn_live_/dn_test_/dn_proxy_", () => {
    const out = scrubCredentials("dn_live_a1 dn_test_b2 dn_proxy_c3.d");
    expect(out).toBe("[REDACTED] [REDACTED] [REDACTED]");
  });
});

describe("scrubCredentials das_", () => {
  it("redacts per-agent das_ secrets", () => {
    expect(scrubCredentials("secret das_AbC123_-xyz leaked")).toBe("secret [REDACTED] leaked");
  });
});
