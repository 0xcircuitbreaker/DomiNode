import { describe, expect, it, vi } from "vitest";
import { chatCompletionTools, createDominusNodeFunctionHandler, functionDefinitions, responsesTools, type SdkClient } from "./handler.js";

const KEY = "dn_live_" + "cd".repeat(32);

function client() {
  return { x402: { getInfo: vi.fn(async () => ({ enabled: true })) } } as unknown as SdkClient & { x402: { getInfo: ReturnType<typeof vi.fn> } };
}

describe("OpenAI wrappers", () => {
  it("chat completions and responses tool shapes", () => {
    expect(chatCompletionTools).toHaveLength(19);
    expect(chatCompletionTools[0]).toEqual({ type: "function", function: functionDefinitions[0] });
    expect(responsesTools[0]).toEqual({ type: "function", ...functionDefinitions[0] });
    for (const f of functionDefinitions) expect(f.parameters.type).toBe("object");
  });

  it("accepts the raw JSON arguments string", async () => {
    const c = client();
    const handle = createDominusNodeFunctionHandler({ apiKey: KEY, client: c });
    expect(JSON.parse(await handle("dominusnode_x402_info", "{}"))).toEqual({ enabled: true });
    expect(JSON.parse(await handle("dominusnode_x402_info", ""))).toEqual({ enabled: true });
    expect(c.x402.getInfo).toHaveBeenCalledTimes(2);
  });

  it("rejects malformed or polluted arguments", async () => {
    const handle = createDominusNodeFunctionHandler({ apiKey: KEY, client: client() });
    expect(JSON.parse(await handle("dominusnode_x402_info", "[1]")).error).toBeTruthy();
    expect(JSON.parse(await handle("dominusnode_x402_info", "{bad")).error).toBeTruthy();
    const out = await handle("dominusnode_x402_info", '{"__proto__":{"x":1}}');
    expect(JSON.parse(out)).toEqual({ enabled: true });
    expect(({} as Record<string, unknown>).x).toBeUndefined();
  });
});
