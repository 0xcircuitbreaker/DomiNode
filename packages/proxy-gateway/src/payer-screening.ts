/**
 * Sanctions screening of x402/MPP payer wallets (LAUNCH_PLAN §9, PAYMENTS.md).
 *
 * Runs after the facilitator verifies the payment and BEFORE settlement, so a
 * listed payer is never charged. The list is the same local OFAC SDN
 * digital-currency address file used for payouts (PAYOUT_SDN_FILE), or
 * PAYER_SDN_FILE when set.
 *
 * Fail closed: in production a missing/unreadable list refuses every paid
 * request (503 PAYER_SCREENING_UNAVAILABLE). Outside production screening is
 * still enforced whenever the file exists; a missing file passes unless
 * PAYER_SDN_REQUIRED=true. Nothing relaxes production.
 */
import { loadSdnText, parseSdnPayerAddresses } from "@dominusnode/shared";

export type ScreenResult = "clear" | "blocked" | "unavailable";

const RELOAD_MS = 10 * 60_000;

export interface PayerScreeningConfig {
  path: string | undefined;
  required: boolean;
  load?: (path: string | undefined) => Promise<Set<string>>;
  now?: () => number;
}

export function screeningConfigFromEnv(env: NodeJS.ProcessEnv = process.env): PayerScreeningConfig {
  const production = env["NODE_ENV"] === "production";
  return {
    path: env["PAYER_SDN_FILE"] || env["PAYOUT_SDN_FILE"],
    required: production || env["PAYER_SDN_REQUIRED"] === "true",
  };
}

let cfg: PayerScreeningConfig = screeningConfigFromEnv();
let cache: { at: number; set: Set<string> | null } | null = null;

export function configurePayerScreening(c: PayerScreeningConfig): void {
  cfg = c;
  cache = null;
}

async function defaultLoad(path: string | undefined): Promise<Set<string>> {
  return parseSdnPayerAddresses(await loadSdnText(path));
}

async function list(): Promise<Set<string> | null> {
  const now = (cfg.now ?? Date.now)();
  if (cache && now - cache.at < RELOAD_MS) return cache.set;
  let set: Set<string> | null;
  try {
    set = await (cfg.load ?? defaultLoad)(cfg.path);
  } catch {
    set = null;
  }
  // A failed reload keeps the last good list rather than dropping screening.
  if (set === null && cache?.set) set = cache.set;
  cache = { at: now, set };
  return set;
}

/** Screen a payer address (EVM 0x… or Solana base58). */
export async function screenPayer(payer: string): Promise<ScreenResult> {
  const set = await list();
  if (!set) return cfg.required ? "unavailable" : "clear";
  const p = payer.trim();
  const key = p.startsWith("0x") || p.startsWith("0X") ? p.toLowerCase() : p;
  return set.has(key) ? "blocked" : "clear";
}
