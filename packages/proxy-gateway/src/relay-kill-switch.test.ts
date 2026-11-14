import { PassThrough } from "node:stream";
import { describe, it, expect, vi } from "vitest";

const gate = vi.hoisted(() => ({ view: null as unknown }));
vi.mock("@dominusnode/shared", () => ({
  killSwitches: () => gate.view,
  createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));
vi.mock("./unmet-demand.js", () => ({ recordUnmetDemand: vi.fn() }));

import { openRelayStream, type RelayRuntime } from "./relay.js";
import { KillSwitchView, type KillSwitchKey } from "../../shared/src/kill-switches.js";

function rt(view: KillSwitchView | undefined, seen: unknown[]): RelayRuntime {
  return {
    selector: {
      select: (o: unknown) => { seen.push(o); return { nodeId: "node-1", tunnel: { openStream: async () => new PassThrough() } }; },
    } as unknown as RelayRuntime["selector"],
    getPolicy: () => ({}) as ReturnType<RelayRuntime["getPolicy"]>,
    killSwitches: view ? () => view : undefined,
  };
}
const v = (keys: KillSwitchKey[] = [], drained: string[] = []) => new KillSwitchView({ engaged: new Set(keys), drainedNodeIds: new Set(drained) });
const opts = { targetHost: "example.com", port: 443, requesterUserId: "u", clientIp: "198.51.100.1" };

describe("openRelayStream kill switches", () => {
  it("global pause refuses before node selection", async () => {
    const seen: unknown[] = [];
    await expect(openRelayStream(rt(v(["relay"]), seen), opts)).rejects.toMatchObject({ status: 503, code: "RELAY_PAUSED" });
    expect(seen).toEqual([]);
  });

  it("refuses a paused requested class", async () => {
    const seen: unknown[] = [];
    await expect(openRelayStream(rt(v(["relay_residential"]), seen), { ...opts, ipClass: "residential" })).rejects.toMatchObject({ code: "EXIT_CLASS_PAUSED" });
  });

  it("excludes paused classes and drained nodes from unflagged selection", async () => {
    const seen: Array<{ excludeIpClasses?: string[]; excludeNodeIds?: string[] }> = [];
    await openRelayStream(rt(v(["relay_dc"], ["n-drained"]), seen), opts);
    expect(seen[0]!.excludeIpClasses).toEqual(["dc"]);
    expect(seen[0]!.excludeNodeIds).toContain("n-drained");
  });

  it("fails closed when switch state is unavailable", async () => {
    const seen: unknown[] = [];
    await expect(openRelayStream(rt(new KillSwitchView(null), seen), opts)).rejects.toMatchObject({ code: "KILL_SWITCH_UNAVAILABLE" });
    expect(seen).toEqual([]);
  });

  it("falls back to the process gate when no view is injected", async () => {
    const seen: unknown[] = [];
    gate.view = new KillSwitchView(null);
    await expect(openRelayStream(rt(undefined, seen), opts)).rejects.toMatchObject({ code: "KILL_SWITCH_UNAVAILABLE" });
    expect(seen).toEqual([]);
    gate.view = v();
    await expect(openRelayStream(rt(undefined, seen), opts)).resolves.toMatchObject({ node: { nodeId: "node-1" } });
  });
});
