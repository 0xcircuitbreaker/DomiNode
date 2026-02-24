import { describe, it, expect, vi, beforeEach } from "vitest";
import { X402Resource } from "../src/resources/x402.js";

function createMockHttp() {
  return {
    get: vi.fn(),
    post: vi.fn(),
    put: vi.fn(),
    patch: vi.fn(),
    delete: vi.fn(),
    request: vi.fn(),
  };
}

describe("X402Resource", () => {
  let http: ReturnType<typeof createMockHttp>;
  let resource: X402Resource;

  beforeEach(() => {
    http = createMockHttp();
    resource = new X402Resource(http as any);
  });

  it("getInfo calls GET /api/x402/info without auth", async () => {
    const mockResponse = {
      supported: true,
      enabled: true,
      protocol: "x402",
      version: "1.0",
      facilitators: [
        { address: "0xabc123", chain: "base", network: "mainnet" },
      ],
      pricing: { perRequestCents: 1, perGbCents: 300, currency: "USDC" },
      currencies: ["USDC", "USDT"],
      walletType: "evm",
      agenticWallets: true,
    };
    http.get.mockResolvedValue(mockResponse);

    const result = await resource.getInfo();

    expect(http.get).toHaveBeenCalledWith("/api/x402/info", false);
    expect(result.supported).toBe(true);
    expect(result.enabled).toBe(true);
    expect(result.protocol).toBe("x402");
    expect(result.facilitators).toHaveLength(1);
    expect(result.pricing.perRequestCents).toBe(1);
    expect(result.currencies).toContain("USDC");
    expect(result.agenticWallets).toBe(true);
  });
});
