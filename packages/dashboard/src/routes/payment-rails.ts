import { killSwitches } from "@dominusnode/shared";
import { tempoConfigFromEnv, mppConfigFromEnv } from "@dominusnode/billing";

function safeConfigured(f: () => unknown): boolean {
  try {
    return f() !== null;
  } catch {
    return false; // invalid config never advertises a rail
  }
}

/** x402 is configured in this process: enabled and at least one receiving address. */
export function x402Configured(env: NodeJS.ProcessEnv = process.env): boolean {
  return env["X402_ENABLED"] === "true" && !!(env["X402_RECEIVING_ADDRESS"] || env["X402_RECEIVING_ADDRESS_SOLANA"]);
}

const RAIL_SWITCH: Record<string, "x402" | "mpp" | "tempo" | "nowpayments" | undefined> = {
  x402: "x402", mpp: "mpp", tempo: "tempo", crypto: "nowpayments",
};

/**
 * Rails advertised by /v1/pricing: the NETWORK_PAYMENT_RAILS list (operator
 * order/opt-out) narrowed to rails that are actually configured in this
 * deployment and whose kill switch is released. Never advertises a rail an
 * agent cannot pay with.
 */
export function enabledRails(env: NodeJS.ProcessEnv = process.env): string[] {
  const raw = env["NETWORK_PAYMENT_RAILS"] || "wallet,x402,mpp,tempo,crypto";
  const configured: Record<string, () => boolean> = {
    wallet: () => true,
    x402: () => x402Configured(env),
    mpp: () => safeConfigured(() => mppConfigFromEnv(env)),
    tempo: () => safeConfigured(() => tempoConfigFromEnv(env)),
    crypto: () => !!env["NOWPAYMENTS_API_KEY"],
  };
  let ks: ReturnType<typeof killSwitches> | null = null;
  try { ks = killSwitches(); } catch { ks = null; }
  return raw.split(",").map((s) => s.trim()).filter((s) => /^[a-z0-9_-]{1,32}$/.test(s)).slice(0, 16)
    .filter((r, i, all) => all.indexOf(r) === i)
    .filter((r) => configured[r]?.() === true)
    .filter((r) => {
      const sw = RAIL_SWITCH[r];
      return !sw || (ks !== null && ks.checkRail(sw) === null);
    });
}
