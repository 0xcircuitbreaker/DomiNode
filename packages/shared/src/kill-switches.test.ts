import { describe, it, expect, vi, afterEach } from "vitest";
import {
  KillSwitchCache, KillSwitchView, KILL_SWITCH_KEYS, configureKillSwitches, killSwitches, killSwitchEnvMs, isKillSwitchKey,
  type KillSwitchKey,
} from "./kill-switches.js";

const view = (keys: KillSwitchKey[] = [], drained: string[] = []) =>
  new KillSwitchView({ engaged: new Set(keys), drainedNodeIds: new Set(drained) });

afterEach(() => configureKillSwitches(null));

describe("kill switch keys", () => {
  it("covers relay (global + per class), signups, api keys, payouts and the four rails", () => {
    expect([...KILL_SWITCH_KEYS]).toEqual([
      "relay", "relay_residential", "relay_mobile", "relay_dc", "relay_masked",
      "signups", "api_keys", "payouts", "rail_x402", "rail_mpp", "rail_tempo", "rail_nowpayments",
    ]);
    expect(isKillSwitchKey("relay_dc")).toBe(true);
    expect(isKillSwitchKey("relay_unknown")).toBe(false);
  });
});

describe("KillSwitchView", () => {
  it("allows everything when nothing is engaged", () => {
    const v = view();
    expect(v.checkRelay()).toBeNull();
    expect(v.checkRelay("dc")).toBeNull();
    expect(v.check("signups")).toBeNull();
    expect(v.checkRail("x402")).toBeNull();
    expect(v.isDrained("n1")).toBe(false);
  });

  it("global relay pause refuses every class", () => {
    const v = view(["relay"]);
    expect(v.checkRelay()?.code).toBe("RELAY_PAUSED");
    expect(v.checkRelay("masked")?.code).toBe("RELAY_PAUSED");
  });

  it("per-class pause refuses that class only; unflagged refused only when all default classes are paused", () => {
    const v = view(["relay_dc"]);
    expect(v.checkRelay("dc")?.code).toBe("EXIT_CLASS_PAUSED");
    expect(v.checkRelay("residential")).toBeNull();
    expect(v.checkRelay()).toBeNull();
    expect(v.pausedClasses()).toEqual(["dc"]);
    const all = view(["relay_dc", "relay_residential", "relay_mobile"]);
    expect(all.checkRelay()?.code).toBe("EXIT_CLASS_PAUSED");
    expect(all.checkRelay("masked")).toBeNull();
  });

  it("maps simple switches and rails to stable agent-facing codes", () => {
    const v = view(["signups", "api_keys", "payouts", "rail_mpp"]);
    expect(v.check("signups")).toMatchObject({ status: 503, code: "SIGNUPS_PAUSED" });
    expect(v.check("api_keys")?.code).toBe("API_KEYS_PAUSED");
    expect(v.check("payouts")?.code).toBe("PAYOUTS_PAUSED");
    expect(v.checkRail("mpp")?.code).toBe("PAYMENT_RAIL_PAUSED");
    expect(v.checkRail("x402")).toBeNull();
  });

  it("fail-closed view refuses everything", () => {
    const v = new KillSwitchView(null);
    expect(v.unavailable).toBe(true);
    for (const b of [v.checkRelay(), v.checkRelay("dc"), v.check("signups"), v.check("payouts"), v.checkRail("tempo")]) {
      expect(b?.code).toBe("KILL_SWITCH_UNAVAILABLE");
    }
    expect(v.engaged("payouts")).toBe(true);
    expect(v.isDrained("x")).toBe(true);
  });
});

describe("KillSwitchCache", () => {
  it("fails closed before the first load and after the snapshot goes stale", async () => {
    let t = 0;
    const load = vi.fn().mockResolvedValueOnce({ engaged: new Set(["signups"]), drainedNodeIds: new Set(["n1"]) })
      .mockRejectedValue(new Error("db down"));
    const onError = vi.fn();
    const c = new KillSwitchCache({ load, now: () => t, maxStaleMs: 15_000, onError });
    expect(c.current().unavailable).toBe(true);
    await c.refresh();
    expect(c.current().check("signups")?.code).toBe("SIGNUPS_PAUSED");
    expect(c.current().drainedNodeIds()).toEqual(["n1"]);
    t = 10_000;
    await c.refresh(); // fails, last good snapshot still fresh
    expect(onError).toHaveBeenCalledTimes(1);
    expect(c.current().unavailable).toBe(false);
    t = 15_001;
    expect(c.current().check("api_keys")?.code).toBe("KILL_SWITCH_UNAVAILABLE");
  });

  it("picks up a change on the next poll", async () => {
    vi.useFakeTimers();
    try {
      let engaged: KillSwitchKey[] = [];
      const c = new KillSwitchCache({ load: async () => ({ engaged: new Set(engaged), drainedNodeIds: new Set() }), pollMs: 5_000, now: () => Date.now() });
      await c.start();
      expect(c.current().checkRelay()).toBeNull();
      engaged = ["relay"];
      await vi.advanceTimersByTimeAsync(5_000);
      expect(c.current().checkRelay()?.code).toBe("RELAY_PAUSED");
      c.stop();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("process gate", () => {
  it("unconfigured: open outside production, closed in production", () => {
    expect(killSwitches({ NODE_ENV: "test" }).checkRelay()).toBeNull();
    expect(killSwitches({ NODE_ENV: "production" }).checkRelay()?.code).toBe("KILL_SWITCH_UNAVAILABLE");
  });

  it("uses the configured cache", async () => {
    const c = new KillSwitchCache({ load: async () => ({ engaged: new Set<KillSwitchKey>(["payouts"]), drainedNodeIds: new Set() }) });
    await c.refresh();
    configureKillSwitches(c);
    expect(killSwitches({}).check("payouts")?.code).toBe("PAYOUTS_PAUSED");
  });
});

describe("killSwitchEnvMs", () => {
  it("defaults, accepts in-range integers and rejects NaN / out of range", () => {
    expect(killSwitchEnvMs({}, "KILL_SWITCH_POLL_MS")).toBe(5_000);
    expect(killSwitchEnvMs({ KILL_SWITCH_POLL_MS: "2000" }, "KILL_SWITCH_POLL_MS")).toBe(2_000);
    expect(() => killSwitchEnvMs({ KILL_SWITCH_POLL_MS: "abc" }, "KILL_SWITCH_POLL_MS")).toThrow();
    expect(() => killSwitchEnvMs({ KILL_SWITCH_POLL_MS: "60000" }, "KILL_SWITCH_POLL_MS")).toThrow();
    expect(killSwitchEnvMs({}, "KILL_SWITCH_MAX_STALE_MS")).toBe(15_000);
    expect(() => killSwitchEnvMs({ KILL_SWITCH_MAX_STALE_MS: "1000" }, "KILL_SWITCH_MAX_STALE_MS")).toThrow();
  });
});
