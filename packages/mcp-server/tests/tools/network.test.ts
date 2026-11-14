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

  it("status reads GET /v1/status unauthenticated and lists open incidents only", async () => {
    const server = await setup();
    const fetchFn = mockFetchSequence(jsonResponse({
      status: "degraded",
      coordinator: { status: "operational", policyVersion: 4 },
      gateway: { status: "operational", instancesOnline: 2, lastHeartbeatAt: "2026-11-14T00:00:00Z" },
      availability: { last24h: 99.5, last7d: null },
      nodes: { onlineNodes: 17, byClass: { dc: 10 } },
      incidents: [
        { title: "EU exits flapping", severity: "major", status: "investigating", startedAt: "2026-11-13T22:00:00Z", resolvedAt: null },
        { title: "Old outage", severity: "minor", status: "resolved", startedAt: "2026-11-01T00:00:00Z", resolvedAt: "2026-11-01T01:00:00Z" },
      ],
      generatedAt: "2026-11-14T00:00:01Z",
    }));
    const text = (await callTool(server, "dominusnode_status")).content[0].text;
    expect(fetchFn.mock.calls[0][0]).toBe("http://localhost:3000/v1/status");
    expect(fetchFn.mock.calls[0][1].headers.Authorization).toBeUndefined();
    expect(text).toContain("Status: degraded");
    expect(text).toContain("Gateway: operational (2 online)");
    expect(text).toContain("policy v4");
    expect(text).toContain("24h 99.5%, 7d n/a");
    expect(text).toContain("Online nodes: 17");
    expect(text).toContain("[major] EU exits flapping");
    expect(text).not.toContain("Old outage");
  });

  it("status surfaces API errors", async () => {
    const server = await setup();
    mockFetchSequence(jsonResponse({ error: "Status unavailable" }, 503));
    const r = await callTool(server, "dominusnode_status");
    expect(r.isError).toBe(true);
  });
});
