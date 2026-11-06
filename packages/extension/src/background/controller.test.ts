import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { chromeMock } from "../test-setup.js";
import { applyBalanceSample, newRun, spendDecision } from "../shared/spend.js";
import { STORAGE_KEYS } from "../shared/constants.js";
import { Controller } from "./controller.js";

const KEY = "dn_live_abcdefgh12345678";

describe("spend tracking", () => {
  it("computes spend from the first sample and blocks at the cap", () => {
    let r = applyBalanceSample(newRun(0), 1000, 300, 1);
    expect(r.spentCents).toBe(0);
    r = applyBalanceSample(r, 800, 300, 2);
    expect(r).toMatchObject({ spentCents: 200, blocked: false });
    r = applyBalanceSample(r, 700, 300, 3);
    expect(r.spentCents).toBe(300);
    expect(r.blocked).toBe(true);
    expect(r.blockReason).toMatch(/Spend cap/);
  });

  it("top-ups do not count as negative spend", () => {
    let r = applyBalanceSample(newRun(0), 1000, null);
    r = applyBalanceSample(r, 900, null);
    r = applyBalanceSample(r, 5900, null); // +5000 top-up
    expect(r.spentCents).toBe(100);
    r = applyBalanceSample(r, 5850, null);
    expect(r.spentCents).toBe(150);
  });

  it("blocks on zero balance even without a cap", () => {
    expect(spendDecision(0, 0, null)).toMatch(/zero/);
    expect(spendDecision(10, 50, null)).toBeNull();
  });
});

function jsonRes(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

describe("Controller spend-cap stop", () => {
  let balances: number[];

  beforeEach(async () => {
    chromeMock.storage.local._store.clear();
    chromeMock.storage.session._store.clear();
    chromeMock.storage.managed._store.clear();
    chromeMock.proxy.settings.set.mockClear();
    balances = [1000, 990, 940];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (url.endsWith("/api/auth/verify-key")) return jsonRes({ valid: true, token: "eyJhbGciOi.eyJzdWIiOi.sig" });
        if (url.endsWith("/api/wallet")) return jsonRes({ balanceCents: balances.shift() ?? 0 });
        return jsonRes({ error: "not found" }, 404);
      }),
    );
    await chromeMock.storage.local.set({
      [STORAGE_KEYS.SETTINGS]: { enabled: true, spendCapCents: 50, gatewayHost: "gw.example.com" },
      [STORAGE_KEYS.SECRET]: { apiKey: KEY },
    });
  });

  afterEach(() => vi.unstubAllGlobals());

  it("proxies, then switches the PAC to block mode and cancels auth once the cap is reached", async () => {
    const ctl = new Controller();
    await ctl.init();
    expect(ctl.mode).toBe("proxying");
    const lastPac = () => (chromeMock.proxy.settings.set.mock.calls.at(-1)?.[0] as { value: { pacScript: { data: string } } }).value.pacScript.data;
    expect(lastPac()).toContain("PROXY gw.example.com:8080");
    expect(ctl.creds()?.auth?.password).toBe(KEY);

    await ctl.pollBalance(); // 1000 baseline
    await ctl.pollBalance(); // 990, spent 10
    expect(ctl.mode).toBe("proxying");
    await ctl.pollBalance(); // 940, spent 60 >= 50
    expect(ctl.mode).toBe("blocked");
    expect(ctl.run.spentCents).toBe(60);
    expect(lastPac()).toContain("PROXY 127.0.0.1:9");
    expect(lastPac()).not.toContain("gw.example.com:8080");
    expect(ctl.creds()?.auth).toBeNull();
    expect(chromeMock.action.setBadgeText).toHaveBeenLastCalledWith({ text: "STOP" });
  });

  it("control channel cannot lift the block; a new run (operator) does", async () => {
    balances = [1000, 900];
    const ctl = new Controller();
    await ctl.init();
    await ctl.pollBalance();
    await ctl.pollBalance();
    expect(ctl.mode).toBe("blocked");
    await ctl.handleControl({ type: "enable" });
    expect(ctl.mode).toBe("blocked");
    balances = [900];
    await ctl.resetRun();
    expect(ctl.run.blocked).toBe(false);
  });

  it("status never contains the API key", async () => {
    const ctl = new Controller();
    await ctl.init();
    expect(JSON.stringify(ctl.status())).not.toContain(KEY);
    expect(JSON.stringify(ctl.controlStatus())).not.toContain(KEY);
    expect(ctl.status().keyPrefix).toBe("dn_live_…");
  });

  it("managed policy overrides stored settings and locks them against operator edits", async () => {
    chromeMock.storage.managed._store.set("country", "JP");
    chromeMock.storage.managed._store.set("spendCapCents", 500);
    const ctl = new Controller();
    await ctl.init();
    expect(ctl.settings.country).toBe("JP");
    expect(ctl.settings.spendCapCents).toBe(500);
    await expect(ctl.operatorUpdate({ spendCapCents: 99999 })).rejects.toThrow(/policy/);
  });

  it("without a key, an enabled profile fails closed (block PAC, no DIRECT leak)", async () => {
    await chromeMock.storage.local.remove(STORAGE_KEYS.SECRET);
    const ctl = new Controller();
    await ctl.init();
    expect(ctl.mode).toBe("no_key");
    const pac = (chromeMock.proxy.settings.set.mock.calls.at(-1)?.[0] as { value: { pacScript: { data: string } } }).value.pacScript.data;
    expect(pac).toContain("127.0.0.1:9");
  });
});
