import { describe, it, expect } from "vitest";
import { scrubCredentials } from "./client";

describe("scrubCredentials", () => {
  it("redacts dn_node_ agent-node credentials", () => {
    expect(scrubCredentials("key dn_node_abc123 failed")).toBe("key [REDACTED] failed");
  });
  it("still redacts dn_live_ and dn_test_", () => {
    expect(scrubCredentials("dn_live_x dn_test_y")).toBe("[REDACTED] [REDACTED]");
  });
});
