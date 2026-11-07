import { describe, it, expect, vi, beforeEach } from "vitest";
import { mockClient, TEST_KEY } from "./helpers.js";

let current: ReturnType<typeof mockClient>;
vi.mock("@dominusnode/sdk", async (orig) => {
  const real = await orig<typeof import("@dominusnode/sdk")>();
  return { ...real, DominusNodeClient: vi.fn(() => current) };
});

import { DominusNode, operationValue } from "../src/nodes/DominusNode/DominusNode.node.js";
import { DominusNodeApi } from "../src/credentials/DominusNodeApi.credentials.js";
import { STANDARD_TOOL_NAMES } from "../src/core.js";

function ctx(op: string, params: Record<string, unknown> = {}, continueOnFail = false) {
  return {
    getInputData: () => [{ json: {} }],
    getCredentials: vi.fn(async () => ({ apiKey: TEST_KEY, baseUrl: "https://api.dominusnode.daedalusdevelopmentgroup.com", proxyHost: "proxy.dominusnode.daedalusdevelopmentgroup.com", proxyPort: 8080 })),
    getNodeParameter: (name: string, _i: number, fallback?: unknown) =>
      name === "operation" ? op : name in params ? params[name] : fallback,
    getNode: () => ({ name: "DominusNode" }),
    continueOnFail: () => continueOnFail,
  };
}

describe("n8n DominusNode node", () => {
  beforeEach(() => {
    current = mockClient();
  });

  it("exposes exactly the 19 standard operations", () => {
    const node = new DominusNode();
    const op = node.description.properties.find((p) => p.name === "operation")!;
    expect((op.options as Array<{ value: string }>).map((o) => o.value)).toEqual(STANDARD_TOOL_NAMES.map(operationValue));
    expect(node.description.usableAsTool).toBe(true);
    expect(node.description.credentials).toEqual([{ name: "dominusNodeApi", required: true }]);
  });

  it("no node parameter holds an API key; credentials store it as a password", () => {
    const node = new DominusNode();
    expect(node.description.properties.some((p) => /api.?key|token|secret/i.test(p.name))).toBe(false);
    expect(JSON.stringify(node.description)).not.toContain("dn_live_x");
    const cred = new DominusNodeApi().properties.find((p) => p.name === "apiKey")!;
    expect(cred.typeOptions).toEqual({ password: true });
    expect(new DominusNodeApi().properties.map((p) => p.name)).not.toContain("agentSecret");
  });

  it("fetch maps required params and options to proxy.fetch", async () => {
    const node = new DominusNode();
    const [out] = await node.execute.call(
      ctx("fetch", { url: "https://example.com", options: { country: "de", ip_class: "residential" } }) as never,
    );
    expect(current.connectWithKey).toHaveBeenCalledWith(TEST_KEY);
    expect(current.proxy.fetch).toHaveBeenCalledWith("https://example.com", expect.objectContaining({ country: "DE", ipClass: "residential", method: "GET" }));
    expect(out[0].json.status).toBe(200);
    expect(current.disconnect).toHaveBeenCalled();
  });

  it.each([
    ["networkPricing", {}, () => current.network.pricing],
    ["topupCrypto", { amount_cents: 1500, currency: "eth" }, () => current.wallet.topUpCrypto],
    ["creditsConvert", { amount_musd: "20000" }, () => current.credits.convert],
    ["payoutsList", { options: { limit: 5 } }, () => current.payouts.list],
  ])("%s calls the SDK", async (op, params, pick) => {
    await new DominusNode().execute.call(ctx(op, params) as never);
    expect(pick()).toHaveBeenCalled();
  });

  it("scrubs errors (continueOnFail and thrown)", async () => {
    current.wallet.getBalance.mockRejectedValue(new Error(`bad ${TEST_KEY}`));
    const [out] = await new DominusNode().execute.call(ctx("balance", {}, true) as never);
    expect(out[0].json.error).toBe("bad [REDACTED]");
    await expect(new DominusNode().execute.call(ctx("balance") as never)).rejects.toThrow("bad [REDACTED]");
  });

  it("proxyUrl output does not contain the key", async () => {
    const [out] = await new DominusNode().execute.call(ctx("proxyUrl", { options: { country: "US" } }) as never);
    expect(JSON.stringify(out)).not.toContain(TEST_KEY);
  });
});
