import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { parse } from "yaml";
import { createDominusNodeFunctionHandler, functionDefinitions, openAIFunctions, STANDARD_TOOL_NAMES } from "../src/handler.js";
import { mockClient, TEST_KEY } from "./helpers.js";

const read = (p: string) => readFileSync(new URL(p, import.meta.url), "utf8");

describe("ChatGPT function handler", () => {
  it("defines exactly the 19 standard functions", () => {
    expect(functionDefinitions().map((f) => f.name)).toEqual(STANDARD_TOOL_NAMES.map((n) => `dominusnode_${n}`));
    expect(openAIFunctions()[0].type).toBe("function");
  });

  it("functions.json is in sync with the handler", () => {
    expect(JSON.parse(read("../functions.json"))).toEqual(functionDefinitions());
  });

  it("dispatches by name (with or without prefix, args as object or JSON string)", async () => {
    const client = mockClient();
    const handler = createDominusNodeFunctionHandler({ apiKey: TEST_KEY, client: client as never });
    await handler("dominusnode_transactions", { limit: 3 });
    expect(client.wallet.getTransactions).toHaveBeenCalledWith({ limit: 3, offset: undefined });
    await handler("check_payment", JSON.stringify({ invoice_id: "123e4567-e89b-12d3-a456-426614174000" }));
    expect(client.wallet.getCryptoStatus).toHaveBeenCalledWith("123e4567-e89b-12d3-a456-426614174000");
  });

  it("rejects unknown functions and bad JSON with scrubbed errors", async () => {
    const handler = createDominusNodeFunctionHandler({ apiKey: TEST_KEY, client: mockClient() as never });
    expect(await handler("dominusnode_topup_stripe", {})).toMatch(/^Error: Unknown function/);
    expect(await handler(`x_${TEST_KEY}`, {})).not.toContain(TEST_KEY);
    expect(await handler("balance", "{not json")).toMatch(/^Error: arguments must be a JSON object/);
  });

  it("never returns the key", async () => {
    const handler = createDominusNodeFunctionHandler({ apiKey: TEST_KEY, client: mockClient() as never });
    expect(await handler("dominusnode_proxy_url", {})).not.toContain(TEST_KEY);
    expect(read("../functions.json")).not.toMatch(/dn_live_[A-Za-z0-9]/);
  });
});

describe("Custom GPT Actions schema (openapi.yaml)", () => {
  const spec = parse(read("../openapi.yaml"));
  const ops: Array<{ path: string; method: string; operationId: string }> = [];
  for (const [path, item] of Object.entries<Record<string, { operationId: string }>>(spec.paths)) {
    for (const [method, op] of Object.entries(item)) ops.push({ path, method, operationId: op.operationId });
  }

  it("operationIds are standard tool names and unique", () => {
    const ids = ops.map((o) => o.operationId);
    expect(new Set(ids).size).toBe(ids.length);
    for (const id of ids) expect(STANDARD_TOOL_NAMES as readonly string[]).toContain(id);
  });

  it("only uses routes that accept a raw API key (/v1) or none (/api/x402/info)", () => {
    for (const o of ops) expect(o.path.startsWith("/v1/") || o.path === "/api/x402/info").toBe(true);
    expect(spec.components.securitySchemes.ApiKeyBearer).toEqual(expect.objectContaining({ type: "http", scheme: "bearer" }));
  });

  it("every path matches a real dashboard route", () => {
    const routesDir = new URL("../../../packages/dashboard/src/routes/", import.meta.url);
    const v1 = readdirSync(new URL("v1/", routesDir))
      .filter((f) => f.endsWith(".ts") && !f.includes(".test."))
      .map((f) => readFileSync(new URL(`v1/${f}`, routesDir), "utf8"))
      .join("\n");
    const x402 = readFileSync(new URL("x402.ts", routesDir), "utf8");
    for (const o of ops) {
      if (o.path === "/api/x402/info") {
        expect(x402).toContain(`router.${o.method}("/info"`);
        continue;
      }
      const express = o.path.replace(/^\/v1/, "").replace(/\{(\w+)\}/g, ":$1");
      expect(v1, `${o.method.toUpperCase()} ${o.path}`).toContain(`router.${o.method}("${express}"`);
    }
  });

  it("has no legacy or hardcoded-price content", () => {
    const raw = read("../openapi.yaml") + read("../ai-plugin.json");
    expect(raw).not.toMatch(/stripe|paypal|\/plans|slots|\$3|\$5\/GB|X-DominusNode-Agent|dn_live_[A-Za-z0-9]/i);
  });
});
