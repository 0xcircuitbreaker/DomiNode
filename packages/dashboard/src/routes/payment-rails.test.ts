import { describe, it, expect, vi, beforeEach } from "vitest";

const engaged = vi.hoisted(() => ({ keys: new Set<string>() }));
vi.mock("@dominusnode/shared", async (orig) => {
  const actual = (await orig()) as Record<string, unknown>;
  return {
    ...actual,
    killSwitches: () => ({
      checkRail: (r: string) => (engaged.keys.has(`rail_${r}`) ? { status: 503, code: "PAYMENT_RAIL_PAUSED", message: "", retryAfterSec: 300 } : null),
    }),
  };
});

import { enabledRails, x402Configured } from "./payment-rails.js";

const ADDR = "0x" + "1".repeat(40);

describe("enabledRails: only rails that are configured and not paused", () => {
  beforeEach(() => engaged.keys.clear());

  it("advertises only the wallet when no rail is configured (default list)", () => {
    expect(enabledRails({})).toEqual(["wallet"]);
  });

  it("does not advertise x402 from X402_ENABLED alone (no receiving address)", () => {
    expect(x402Configured({ X402_ENABLED: "true" })).toBe(false);
    expect(enabledRails({ X402_ENABLED: "true" })).toEqual(["wallet"]);
  });

  it("advertises configured rails, in operator order, and drops paused ones", () => {
    const env = { X402_ENABLED: "true", X402_RECEIVING_ADDRESS: ADDR, NOWPAYMENTS_API_KEY: "k", NETWORK_PAYMENT_RAILS: "crypto,x402,wallet" };
    expect(enabledRails(env)).toEqual(["crypto", "x402", "wallet"]);
    engaged.keys.add("rail_x402");
    engaged.keys.add("rail_nowpayments");
    expect(enabledRails(env)).toEqual(["wallet"]);
  });

  it("treats an empty NETWORK_PAYMENT_RAILS as the default list", () => {
    expect(enabledRails({ NETWORK_PAYMENT_RAILS: "", NOWPAYMENTS_API_KEY: "k" })).toEqual(["wallet", "crypto"]);
  });
});
