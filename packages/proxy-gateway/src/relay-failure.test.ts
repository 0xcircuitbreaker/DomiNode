import { describe, it, expect, vi } from "vitest";

vi.mock("@dominusnode/shared", () => ({
  createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));
vi.mock("./unmet-demand.js", () => ({ recordUnmetDemand: vi.fn() }));

import { openRelayStream, type RelayRuntime } from "./relay.js";
import { TunnelOpenError } from "./node-tunnel/mux.js";

function rt(code: string, onNodeFailure: (id: string, c: string) => void): RelayRuntime {
  let n = 0;
  return {
    selector: {
      select: () => ({ nodeId: `node-${++n}`, tunnel: { openStream: async () => { throw new TunnelOpenError(code); } } }),
    } as unknown as RelayRuntime["selector"],
    getPolicy: () => ({}) as ReturnType<RelayRuntime["getPolicy"]>,
    onNodeFailure,
  };
}

describe("relay open failures feed node reputation", () => {
  it("reports DIAL_FAIL/DNS_FAIL/TIMEOUT against the node that failed", async () => {
    for (const code of ["DIAL_FAIL", "DNS_FAIL", "TIMEOUT"]) {
      const seen: string[] = [];
      await expect(openRelayStream(rt(code, (id, c) => seen.push(`${id}:${c}`)), { targetHost: "example.com", port: 443 } as never)).rejects.toThrow();
      expect(seen.length).toBeGreaterThanOrEqual(1);
      expect(seen[0]).toBe(`node-1:${code}`);
    }
  });

  it("does not penalise policy refusals (FLOOR_BLOCKED)", async () => {
    const seen: string[] = [];
    await expect(openRelayStream(rt("FLOOR_BLOCKED", (id) => seen.push(id)), { targetHost: "example.com", port: 443 } as never)).rejects.toThrow();
    expect(seen).toEqual([]);
  });
});
