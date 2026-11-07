import { describe, it, expect, afterEach } from "vitest";
import { parseSdnPayerAddresses } from "@dominusnode/shared";
import { configurePayerScreening, screenPayer, screeningConfigFromEnv } from "./payer-screening.js";

const EVM = "0x" + "b".repeat(40);
const SOL = "7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU";

afterEach(() => configurePayerScreening({ path: undefined, required: false }));

describe("payer sanctions screening", () => {
  it("parses EVM and SOL-tagged / one-per-line Solana addresses", () => {
    const s = parseSdnPayerAddresses(`Digital Currency Address - ETH 0x${"B".repeat(40)}; Digital Currency Address - SOL ${SOL};\n${"9".repeat(40)}\n`);
    expect(s.has(EVM)).toBe(true);
    expect(s.has(SOL)).toBe(true);
    expect(s.has("9".repeat(40))).toBe(true);
  });

  it("blocks listed EVM (case-insensitive) and Solana (exact) payers", async () => {
    configurePayerScreening({ path: "/f", required: true, load: async () => new Set([EVM, SOL]) });
    expect(await screenPayer("0x" + "B".repeat(40))).toBe("blocked");
    expect(await screenPayer(SOL)).toBe("blocked");
    expect(await screenPayer(SOL.toLowerCase())).toBe("clear");
    expect(await screenPayer("0x" + "c".repeat(40))).toBe("clear");
  });

  it("fails closed when required and the list is missing; open only when not required", async () => {
    configurePayerScreening({ path: undefined, required: true, load: async () => { throw new Error("missing"); } });
    expect(await screenPayer(EVM)).toBe("unavailable");
    configurePayerScreening({ path: undefined, required: false, load: async () => { throw new Error("missing"); } });
    expect(await screenPayer(EVM)).toBe("clear");
  });

  it("keeps the last good list when a reload fails", async () => {
    let t = 0;
    let fail = false;
    configurePayerScreening({ path: "/f", required: true, now: () => t, load: async () => { if (fail) throw new Error("x"); return new Set([EVM]); } });
    expect(await screenPayer(EVM)).toBe("blocked");
    fail = true;
    t += 11 * 60_000;
    expect(await screenPayer(EVM)).toBe("blocked");
  });

  it("production always requires the list; elsewhere PAYER_SDN_REQUIRED=true opts in", () => {
    expect(screeningConfigFromEnv({ NODE_ENV: "production", PAYER_SDN_REQUIRED: "false" }).required).toBe(true);
    expect(screeningConfigFromEnv({ NODE_ENV: "development" }).required).toBe(false);
    expect(screeningConfigFromEnv({ PAYER_SDN_REQUIRED: "true" }).required).toBe(true);
    expect(screeningConfigFromEnv({ PAYOUT_SDN_FILE: "/a", PAYER_SDN_FILE: "/b" }).path).toBe("/b");
    expect(screeningConfigFromEnv({ PAYOUT_SDN_FILE: "/a" }).path).toBe("/a");
  });
});
