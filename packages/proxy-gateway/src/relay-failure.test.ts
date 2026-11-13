import { PassThrough } from "node:stream";
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

function rtSecondOk(code: string, onNodeFailure: (id: string, c: string) => void): RelayRuntime {
  let n = 0;
  return {
    selector: {
      select: () => {
        const id = `node-${++n}`;
        return { nodeId: id, tunnel: { openStream: async () => { if (id === "node-1") throw new TunnelOpenError(code); return new PassThrough(); } } };
      },
    } as unknown as RelayRuntime["selector"],
    getPolicy: () => ({}) as ReturnType<RelayRuntime["getPolicy"]>,
    onNodeFailure,
  };
}

describe("relay open failures feed node reputation", () => {
  it("penalises the failed node when another node reached the same target", async () => {
    for (const code of ["DIAL_FAIL", "DNS_FAIL"]) {
      const seen: string[] = [];
      const up = await openRelayStream(rtSecondOk(code, (id, c) => seen.push(`${id}:${c}`)), { targetHost: "example.com", port: 443 } as never);
      expect(up.node.nodeId).toBe("node-2");
      expect(seen).toEqual([`node-1:${code}`]);
    }
  });

  it("never penalises nodes for an unreachable target, however often it is opened", async () => {
    const seen: string[] = [];
    for (let i = 0; i < 50; i++) {
      for (const code of ["DIAL_FAIL", "DNS_FAIL", "TIMEOUT"]) {
        await expect(openRelayStream(rt(code, (id) => seen.push(id)), { targetHost: "blackhole.example", port: 443 } as never)).rejects.toThrow();
      }
    }
    expect(seen).toEqual([]);
  });

  it("does not penalise policy refusals (FLOOR_BLOCKED)", async () => {
    const seen: string[] = [];
    await expect(openRelayStream(rt("FLOOR_BLOCKED", (id) => seen.push(id)), { targetHost: "example.com", port: 443 } as never)).rejects.toThrow();
    expect(seen).toEqual([]);
  });
});
