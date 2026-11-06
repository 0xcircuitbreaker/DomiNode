import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import plugin, { createOpenClawTools, STANDARD_TOOL_NAMES, type OpenClawTool } from "../src/index.js";
import { mockClient, TEST_KEY } from "./helpers.js";

const NAMES = STANDARD_TOOL_NAMES.map((n) => `dominusnode_${n}`);

describe("OpenClaw plugin", () => {
  it("register(api) registers exactly the 19 standard tools", () => {
    const registered: OpenClawTool[] = [];
    plugin.register({ registerTool: (t) => registered.push(t) });
    expect(registered.map((t) => t.name)).toEqual(NAMES);
    expect(plugin.id).toBe("dominusnode");
  });

  it("manifest contracts.tools matches the registered tools", () => {
    const manifest = JSON.parse(readFileSync(new URL("../openclaw.plugin.json", import.meta.url), "utf8"));
    expect(manifest.id).toBe(plugin.id);
    expect(manifest.contracts.tools).toEqual(NAMES);
    expect(JSON.stringify(manifest)).not.toMatch(/apiKey|dn_live_/);
  });

  it("execute returns OpenClaw content and calls the SDK (JWT via connectWithKey)", async () => {
    const client = mockClient();
    const tools = createOpenClawTools({ apiKey: TEST_KEY, client: client as never });
    const bal = tools.find((t) => t.name === "dominusnode_balance")!;
    const res = await bal.execute("call-1", {});
    expect(client.connectWithKey).toHaveBeenCalledWith(TEST_KEY);
    expect(client.wallet.getBalance).toHaveBeenCalled();
    expect(res.content[0].type).toBe("text");
    expect(res.details.ok).toBe(true);
  });

  it("errors are scrubbed and the key is never in schemas or output", async () => {
    const client = mockClient();
    client.proxy.fetch.mockRejectedValueOnce(new Error(`tunnel refused ${TEST_KEY}`));
    const tools = createOpenClawTools({ apiKey: TEST_KEY, client: client as never });
    const res = await tools[0].execute("c", { url: "https://example.com" });
    expect(res.content[0].text).toBe("Error: tunnel refused [REDACTED]");
    expect(res.details.ok).toBe(false);
    expect(JSON.stringify(tools.map((t) => t.parameters))).not.toContain(TEST_KEY);
    const url = await tools[1].execute("c", {});
    expect(url.content[0].text).not.toContain(TEST_KEY);
  });
});
