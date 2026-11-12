import { describe, it, expect, vi } from "vitest";
import { readActivePolicyForExport, PolicyExportError } from "./federation-export.js";
import { DEFAULT_POLICY } from "./policy.js";

describe("readActivePolicyForExport", () => {
  it("connects, reads the active policy and closes the pool", async () => {
    const policy = { version: 5, sha256: "x", body: DEFAULT_POLICY, createdAt: null };
    const order: string[] = [];
    const deps = {
      connect: vi.fn(async () => { order.push("connect"); }),
      getActivePolicy: vi.fn(async () => { order.push("get"); return policy; }),
      close: vi.fn(async () => { order.push("close"); }),
    };
    await expect(readActivePolicyForExport(deps as never)).resolves.toBe(policy);
    expect(order).toEqual(["connect", "get", "close"]);
  });
  it("closes the pool and scrubs the error on DB failure", async () => {
    const deps = {
      connect: vi.fn().mockResolvedValue(undefined),
      getActivePolicy: vi.fn().mockRejectedValue(new Error("password=hunter2 at postgres://u:p@h")),
      close: vi.fn().mockResolvedValue(undefined),
    };
    const err = await readActivePolicyForExport(deps as never).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PolicyExportError);
    expect((err as Error).message).not.toMatch(/hunter2|postgres:/);
    expect(deps.close).toHaveBeenCalledTimes(1);
  });
});
