import { describe, it, expect, afterEach, vi } from "vitest";

// We need to control env vars before importing the module
describe("agent-rate-limit", () => {
  const originalEnv = { ...process.env };

  afterEach(() => {
    process.env = { ...originalEnv };
    vi.resetModules();
  });

  describe("getAgentMultiplier", () => {
    it("defaults to 10 when env var is not set", async () => {
      delete process.env["AGENT_RATE_LIMIT_MULTIPLIER"];
      const { getAgentMultiplier } = await import("./agent-rate-limit.js");
      expect(getAgentMultiplier()).toBe(10);
    });

    it("parses a valid integer from env", async () => {
      process.env["AGENT_RATE_LIMIT_MULTIPLIER"] = "5";
      const { getAgentMultiplier } = await import("./agent-rate-limit.js");
      expect(getAgentMultiplier()).toBe(5);
    });

    it("returns 10 for NaN values", async () => {
      process.env["AGENT_RATE_LIMIT_MULTIPLIER"] = "not-a-number";
      const { getAgentMultiplier } = await import("./agent-rate-limit.js");
      expect(getAgentMultiplier()).toBe(10);
    });

    it("clamps to 100 for values above upper bound", async () => {
      process.env["AGENT_RATE_LIMIT_MULTIPLIER"] = "999";
      const { getAgentMultiplier } = await import("./agent-rate-limit.js");
      expect(getAgentMultiplier()).toBe(100);
    });

    it("returns 10 for values below 1", async () => {
      process.env["AGENT_RATE_LIMIT_MULTIPLIER"] = "0";
      const { getAgentMultiplier } = await import("./agent-rate-limit.js");
      expect(getAgentMultiplier()).toBe(10);
    });

    it("returns 10 for negative values", async () => {
      process.env["AGENT_RATE_LIMIT_MULTIPLIER"] = "-5";
      const { getAgentMultiplier } = await import("./agent-rate-limit.js");
      expect(getAgentMultiplier()).toBe(10);
    });
  });

  describe("isVerifiedAgent", () => {
    it("returns false when MCP_AGENT_SECRET is not configured", async () => {
      delete process.env["MCP_AGENT_SECRET"];
      const { isVerifiedAgent } = await import("./agent-rate-limit.js");
      const req = {
        headers: {
          "x-dominusnode-agent": "mcp",
          "x-dominusnode-agent-secret": "some-secret",
        },
      } as any;
      expect(isVerifiedAgent(req)).toBe(false);
    });

    it("returns false when agent header is missing", async () => {
      process.env["MCP_AGENT_SECRET"] = "test-secret-32-chars-long-enough!";
      vi.resetModules();
      const { isVerifiedAgent } = await import("./agent-rate-limit.js");
      const req = {
        headers: {
          "x-dominusnode-agent-secret": "test-secret-32-chars-long-enough!",
        },
      } as any;
      expect(isVerifiedAgent(req)).toBe(false);
    });

    it("returns false when agent header is not 'mcp'", async () => {
      process.env["MCP_AGENT_SECRET"] = "test-secret-32-chars-long-enough!";
      vi.resetModules();
      const { isVerifiedAgent } = await import("./agent-rate-limit.js");
      const req = {
        headers: {
          "x-dominusnode-agent": "other",
          "x-dominusnode-agent-secret": "test-secret-32-chars-long-enough!",
        },
      } as any;
      expect(isVerifiedAgent(req)).toBe(false);
    });

    it("returns false when secret header is wrong", async () => {
      process.env["MCP_AGENT_SECRET"] = "correct-secret-value-here123456!";
      vi.resetModules();
      const { isVerifiedAgent } = await import("./agent-rate-limit.js");
      const req = {
        headers: {
          "x-dominusnode-agent": "mcp",
          "x-dominusnode-agent-secret": "wrong-secret-value-here1234567!!",
        },
      } as any;
      expect(isVerifiedAgent(req)).toBe(false);
    });

    it("returns false when secret header has different length", async () => {
      process.env["MCP_AGENT_SECRET"] = "short";
      vi.resetModules();
      const { isVerifiedAgent } = await import("./agent-rate-limit.js");
      const req = {
        headers: {
          "x-dominusnode-agent": "mcp",
          "x-dominusnode-agent-secret": "different-length-secret",
        },
      } as any;
      expect(isVerifiedAgent(req)).toBe(false);
    });

    it("returns true with correct headers and secret", async () => {
      process.env["MCP_AGENT_SECRET"] = "my-agent-secret-for-testing-1234";
      vi.resetModules();
      const { isVerifiedAgent } = await import("./agent-rate-limit.js");
      const req = {
        headers: {
          "x-dominusnode-agent": "mcp",
          "x-dominusnode-agent-secret": "my-agent-secret-for-testing-1234",
        },
      } as any;
      expect(isVerifiedAgent(req)).toBe(true);
    });

    it("returns false when secret header is missing entirely", async () => {
      process.env["MCP_AGENT_SECRET"] = "test-secret";
      vi.resetModules();
      const { isVerifiedAgent } = await import("./agent-rate-limit.js");
      const req = {
        headers: {
          "x-dominusnode-agent": "mcp",
        },
      } as any;
      expect(isVerifiedAgent(req)).toBe(false);
    });
  });

  describe("agentAwareRateLimit", () => {
    it("returns an express middleware function", async () => {
      const { agentAwareRateLimit } = await import("./agent-rate-limit.js");
      const limiter = agentAwareRateLimit({
        windowMs: 60_000,
        max: 100,
      });
      expect(typeof limiter).toBe("function");
    });
  });

  describe("isGlobalVerifiedAgent", () => {
    it("accepts only the global MCP_AGENT_SECRET", async () => {
      process.env["MCP_AGENT_SECRET"] = "test-secret-32-chars-long-enough!";
      vi.resetModules();
      const { isGlobalVerifiedAgent } = await import("./agent-rate-limit.js");
      expect(isGlobalVerifiedAgent({ headers: { "x-dominusnode-agent": "mcp", "x-dominusnode-agent-secret": "test-secret-32-chars-long-enough!" } } as any)).toBe(true);
      expect(isGlobalVerifiedAgent({ headers: { "x-dominusnode-agent": "mcp", "x-dominusnode-agent-secret": "wrong-secret-32-chars-long-enough" } } as any)).toBe(false);
    });

    it("rejects per-agent das_ secrets (cannot bypass brute-force protections)", async () => {
      process.env["MCP_AGENT_SECRET"] = "test-secret-32-chars-long-enough!";
      vi.resetModules();
      const { isGlobalVerifiedAgent } = await import("./agent-rate-limit.js");
      const das = "das_" + "a".repeat(64);
      expect(isGlobalVerifiedAgent({ headers: { "x-dominusnode-agent": "mcp", "x-dominusnode-agent-secret": das } } as any)).toBe(false);
    });

    it("returns false when MCP_AGENT_SECRET is unset", async () => {
      delete process.env["MCP_AGENT_SECRET"];
      vi.resetModules();
      const { isGlobalVerifiedAgent } = await import("./agent-rate-limit.js");
      expect(isGlobalVerifiedAgent({ headers: { "x-dominusnode-agent": "mcp", "x-dominusnode-agent-secret": "" } } as any)).toBe(false);
    });
  });

  describe("global secret comparison is byte-length safe", () => {
    const SECRET = "s3cret-value-abc";
    const reqWith = (secret: string) =>
      ({ headers: { "x-dominusnode-agent": "mcp", "x-dominusnode-agent-secret": secret } }) as never;

    it("same char length but multi-byte UTF-8 does not throw and is rejected", async () => {
      process.env["MCP_AGENT_SECRET"] = SECRET;
      const m = await import("./agent-rate-limit.js");
      const evil = "\u00e9" + SECRET.slice(1); // same .length, +1 UTF-8 byte
      expect(evil.length).toBe(SECRET.length);
      expect(() => m.isGlobalVerifiedAgent(reqWith(evil))).not.toThrow();
      expect(m.isGlobalVerifiedAgent(reqWith(evil))).toBe(false);
      expect(m.isVerifiedAgent(reqWith(evil))).toBe(false);
      await expect(m.isVerifiedAgentAsync(reqWith(evil))).resolves.toEqual({ verified: false });
    });

    it("correct secret still verifies; wrong length rejected", async () => {
      process.env["MCP_AGENT_SECRET"] = SECRET;
      const m = await import("./agent-rate-limit.js");
      expect(m.isGlobalVerifiedAgent(reqWith(SECRET))).toBe(true);
      expect(m.isVerifiedAgent(reqWith(SECRET))).toBe(true);
      expect(m.isGlobalVerifiedAgent(reqWith("short"))).toBe(false);
    });

    it("matchesGlobalAgentSecret never throws on odd input", async () => {
      const m = await import("./agent-rate-limit.js");
      expect(m.matchesGlobalAgentSecret(["a", "b"], SECRET)).toBe(false);
      expect(m.matchesGlobalAgentSecret("", SECRET)).toBe(false);
      expect(m.matchesGlobalAgentSecret("x", "")).toBe(false);
    });
  });
});
