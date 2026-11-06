import { describe, it, expect } from "vitest";
import { DominusNodeToolkit, STANDARD_TOOL_NAMES } from "../src/index.js";
import { mockClient, TEST_KEY } from "./helpers.js";

describe("Flowise toolkit", () => {
  it("returns exactly the 19 standard DynamicStructuredTools", () => {
    const tools = new DominusNodeToolkit({ apiKey: TEST_KEY, client: mockClient() as never }).getTools();
    expect(tools.map((t) => t.name)).toEqual(STANDARD_TOOL_NAMES.map((n) => `dominusnode_${n}`));
    for (const t of tools) expect(t.description.length).toBeGreaterThan(20);
  });

  it("invoke() validates input and calls the SDK", async () => {
    const client = mockClient();
    const tools = new DominusNodeToolkit({ apiKey: TEST_KEY, client: client as never }).getTools();
    const report = tools.find((t) => t.name === "dominusnode_report_session")!;
    const out = await report.invoke({ session_id: "123e4567-e89b-12d3-a456-426614174000", reason: "slow" });
    expect(client.sessions.report).toHaveBeenCalledWith("123e4567-e89b-12d3-a456-426614174000", "slow");
    expect(String(out)).not.toContain(TEST_KEY);
    await expect(report.invoke({ session_id: "x", reason: "nope" } as never)).rejects.toThrow();
  });

  it("scrubs errors and never exposes the key", async () => {
    const client = mockClient();
    client.credits.balance.mockRejectedValueOnce(new Error(`denied for ${TEST_KEY}`));
    const tk = new DominusNodeToolkit({ apiKey: TEST_KEY, client: client as never });
    const credits = tk.getTools().find((t) => t.name === "dominusnode_credits_balance")!;
    expect(await credits.invoke({})).toBe("Error: denied for [REDACTED]");
    expect(String(tk) + JSON.stringify(tk)).not.toContain(TEST_KEY);
  });
});
