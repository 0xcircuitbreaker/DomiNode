import { describe, it, expect } from "vitest";
import { Value } from "typebox/value";
import dominusNodeExtension, { createPiTools, toTypeBox, createToolSpecs, STANDARD_TOOL_NAMES, type PiTool } from "../src/index.js";
import { mockClient, TEST_KEY } from "./helpers.js";

describe("pi extension", () => {
  it("registers exactly the 19 standard tools", () => {
    const registered: PiTool[] = [];
    dominusNodeExtension({ registerTool: (t) => registered.push(t) });
    expect(registered.map((t) => t.name)).toEqual(STANDARD_TOOL_NAMES.map((n) => `dominusnode_${n}`));
    for (const t of registered) expect(t.label.startsWith("DominusNode: ")).toBe(true);
  });

  it("TypeBox schemas validate arguments", () => {
    const schema = toTypeBox(createToolSpecs().find((s) => s.name === "topup_crypto")!.parameters);
    expect(Value.Check(schema, { amount_cents: 2000, currency: "btc" })).toBe(true);
    expect(Value.Check(schema, { amount_cents: 2000, currency: "doge" })).toBe(false);
    expect(Value.Check(schema, { currency: "btc" })).toBe(false);
  });

  it("execute calls the SDK and returns pi content", async () => {
    const client = mockClient();
    const tools = createPiTools({ apiKey: TEST_KEY, client: client as never });
    const res = await tools.find((t) => t.name === "dominusnode_credits_balance")!.execute("1", {});
    expect(client.credits.balance).toHaveBeenCalledWith();
    expect(res.content[0].type).toBe("text");
    expect(res.details.ok).toBe(true);
  });

  it("scrubs errors; key never in schemas or output", async () => {
    const client = mockClient();
    client.nodes.tier.mockRejectedValueOnce(new Error(`no ${TEST_KEY}`));
    const tools = createPiTools({ apiKey: TEST_KEY, client: client as never });
    const res = await tools.find((t) => t.name === "dominusnode_node_tier")!.execute("1", {});
    expect(res.content[0].text).toBe("Error: no [REDACTED]");
    expect(JSON.stringify(tools.map((t) => t.parameters))).not.toContain(TEST_KEY);
    const url = await tools.find((t) => t.name === "dominusnode_proxy_url")!.execute("1", {});
    expect(url.content[0].text).not.toContain(TEST_KEY);
  });
});
