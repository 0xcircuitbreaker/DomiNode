import { describe, it, expect } from "vitest";
import { DominusNodeToolkit, STANDARD_TOOL_NAMES, toZod, createToolSpecs } from "../src/index.js";
import { mockClient, TEST_KEY } from "./helpers.js";

describe("Mastra toolkit", () => {
  it("registers exactly the 19 standard tools via createTool", () => {
    const tools = new DominusNodeToolkit({ apiKey: TEST_KEY, client: mockClient() as never }).getTools();
    const ids = STANDARD_TOOL_NAMES.map((n) => `dominusnode_${n}`);
    expect(Object.keys(tools)).toEqual(ids);
    for (const [id, t] of Object.entries(tools)) {
      expect(t.id).toBe(id);
      expect(typeof t.execute).toBe("function");
    }
  });

  it("execute(input, ctx) calls the SDK and does not leak the key", async () => {
    const client = mockClient();
    const tools = new DominusNodeToolkit({ apiKey: TEST_KEY, client: client as never }).getTools();
    const out = await tools.dominusnode_node_list.execute!({ limit: 2 } as never, {} as never);
    expect(client.nodes.list).toHaveBeenCalledWith({ limit: 2, offset: undefined });
    expect(String(out)).not.toContain(TEST_KEY);
    const url = await tools.dominusnode_proxy_url.execute!({} as never, {} as never);
    expect(String(url)).not.toContain(TEST_KEY);
  });

  it("zod schemas validate required/enum fields", () => {
    const fetch = toZod(createToolSpecs()[0].parameters);
    expect(fetch.safeParse({ url: "https://x.com", ip_class: "dc" }).success).toBe(true);
    expect(fetch.safeParse({ ip_class: "dc" }).success).toBe(false);
    expect(fetch.safeParse({ url: "https://x.com", method: "POST" }).success).toBe(false);
    expect(fetch.safeParse({ url: "https://x.com", api_key: TEST_KEY }).success).toBe(false);
  });

  it("toolkit never prints the key", () => {
    const tk = new DominusNodeToolkit({ apiKey: TEST_KEY, client: mockClient() as never });
    expect(String(tk) + JSON.stringify(tk)).not.toContain(TEST_KEY);
  });
});
