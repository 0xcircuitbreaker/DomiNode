import { describe, it, expect, afterEach, vi } from "vitest";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerNetworkTools, formatMusd } from "../../src/tools/network.js";
import { callTool, jsonResponse, makeHttpClient, mockFetchSequence } from "../helpers/mock.js";

import { PRICING, POLICY } from "../helpers/fixtures.js";

async function setup() {
  const http = await makeHttpClient();
  const server = new McpServer({ name: "t", version: "1" });
  registerNetworkTools(server, http);
  return server;
}

describe("network tools", () => {
  afterEach(() => vi.restoreAllMocks());

  it("formatMusd converts micro-dollars", () => {
    expect(formatMusd("500000")).toBe("$0.50");
    expect(formatMusd(200000)).toBe("$0.20");
    expect(formatMusd("50000000")).toBe("$50.00");
    expect(formatMusd("nope")).toBe("?");
  });

  it("network_pricing renders live prices and tiers sorted by rank, unauthenticated", async () => {
    const server = await setup();
    const fetchFn = mockFetchSequence(jsonResponse(PRICING));
    const r = await callTool(server, "dominusnode_network_pricing");
    const text = r.content[0].text;
    expect(fetchFn.mock.calls[0][0]).toBe("http://localhost:3000/v1/pricing");
    expect(fetchFn.mock.calls[0][1].headers.Authorization).toBeUndefined();
    expect(fetchFn.mock.calls[0][1].headers["X-DominusNode-Agent"]).toBe("mcp");
    expect(text).toContain("class-residential: $0.50/GB");
    expect(text).toContain("class-dc: $0.20/GB");
    expect(text.indexOf("Probation: 25%")).toBeLessThan(text.indexOf("Partner: 50%"));
    expect(text).toContain("72 hours");
    expect(text).toMatch(/self-dealing/);
  });

  it("network_policy explains ports, plaintext opt-in and floor", async () => {
    const server = await setup();
    mockFetchSequence(jsonResponse(POLICY));
    const text = (await callTool(server, "dominusnode_network_policy")).content[0].text;
    expect(text).toContain("Network Policy v4");
    expect(text).toContain("Destination ports: 80, 443");
    expect(text).toContain("Plaintext HTTP: opt_in");
    expect(text).toContain("allowhttp-1");
    expect(text).toContain("$50.00");
    expect(text).toContain("I operate this node lawfully.");
    expect(text).toContain("Ports 22, 25 are always denied.");
  });

  it("network_stats renders aggregates", async () => {
    const server = await setup();
    mockFetchSequence(jsonResponse({
      onlineNodes: 12, byClass: { residential: 9, dc: 3 }, byCountry: [{ country: "US", online: 7 }],
      otherCountries: 5, generatedAt: "2026-11-06T00:00:00.000Z",
    }));
    const text = (await callTool(server, "dominusnode_network_stats")).content[0].text;
    expect(text).toContain("Online nodes: 12");
    expect(text).toContain("residential=9, dc=3");
    expect(text).toContain("US=7");
  });

  it("returns isError on API failure", async () => {
    const server = await setup();
    mockFetchSequence(jsonResponse({ error: "Pricing unavailable" }, 503));
    const r = await callTool(server, "dominusnode_network_pricing");
    expect(r.isError).toBe(true);
    expect(r.content[0].text).toContain("Pricing unavailable");
  });
});
