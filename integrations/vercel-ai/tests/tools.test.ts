import { describe, it, expect } from "vitest";
import { createDominusNodeTools, STANDARD_TOOL_NAMES } from "../src/index.js";
import { mockClient, TEST_KEY } from "./helpers.js";

describe("Vercel AI SDK tools", () => {
  it("registers exactly the 19 standard tools", () => {
    const tools = createDominusNodeTools({ apiKey: TEST_KEY, client: mockClient() as never });
    expect(Object.keys(tools)).toEqual(STANDARD_TOOL_NAMES.map((n) => `dominusnode_${n}`));
    for (const t of Object.values(tools)) {
      expect(typeof t.description).toBe("string");
      expect(typeof t.execute).toBe("function");
      expect(t.inputSchema).toBeDefined();
    }
  });

  it("execute dispatches to the SDK and never leaks the key", async () => {
    const client = mockClient();
    const tools = createDominusNodeTools({ apiKey: TEST_KEY, client: client as never });
    const out = await tools.dominusnode_balance.execute({}, { toolCallId: "1", messages: [] });
    expect(client.wallet.getBalance).toHaveBeenCalled();
    expect(out).toContain("balanceCents");
    const url = await tools.dominusnode_proxy_url.execute({ country: "US" }, { toolCallId: "2", messages: [] });
    expect(url).not.toContain(TEST_KEY);
    expect(JSON.stringify(tools)).not.toContain(TEST_KEY);
  });

  it("returns scrubbed errors instead of throwing", async () => {
    const client = mockClient();
    client.network.pricing.mockRejectedValueOnce(new Error(`boom ${TEST_KEY}`));
    const tools = createDominusNodeTools({ apiKey: TEST_KEY, client: client as never });
    const out = await tools.dominusnode_network_pricing.execute({}, { toolCallId: "1", messages: [] });
    expect(out).toBe("Error: boom [REDACTED]");
  });
});
