import { Router } from "express";
import { SUPPORTED_CRYPTO, policyRepo, createLogger, RELAY_BYTES_PER_GB } from "@dominusnode/shared";
import { X402_RESOURCE_DESCRIPTION, bazaarExtension } from "@dominusnode/billing";

const router = Router();
const log = createLogger("api:x402-info");

/** Bytes one x402 payment buys; must match the gateway (X402_BYTES_PER_REQUEST, default 10 MiB). */
function bytesPerRequest(): number {
  const n = parseInt(process.env["X402_BYTES_PER_REQUEST"] ?? "10485760", 10);
  return Number.isFinite(n) && n >= 65_536 && n <= 1_073_741_824 ? n : 10_485_760;
}

/** Same unit the gateway uses for its x402 quote (x402AmountMusd). */
const GB_UNIT = BigInt(RELAY_BYTES_PER_GB);
const musdToUsd = (m: bigint): string => {
  const whole = m / 1_000_000n;
  const frac = (m % 1_000_000n).toString().padStart(6, "0");
  return `${whole}.${frac}`;
};

/** Live per-class pricing from network_pricing (never hardcoded). */
async function livePricing(): Promise<Record<string, unknown> | null> {
  try {
    const rows = await policyRepo.listPricing();
    const bytes = BigInt(bytesPerRequest());
    const classes: Record<string, unknown> = {};
    for (const r of rows) {
      // Same rounding as the gateway quote: round up to the next µUSD.
      const perReq = (r.pricePerGbMusd * bytes + GB_UNIT - 1n) / GB_UNIT;
      classes[r.ipClass] = {
        perGb: { musd: r.pricePerGbMusd.toString(), usd: musdToUsd(r.pricePerGbMusd) },
        perRequest: { musd: perReq.toString(), usd: musdToUsd(perReq) },
      };
    }
    return { bytesPerRequest: Number(bytes), classes, source: "/v1/pricing" };
  } catch (err) {
    log.warn("network pricing unavailable for x402 info", { error: err instanceof Error ? err.message : String(err) });
    return null;
  }
}

// GET /api/x402/info — Public x402 payment protocol info
// Prices are read live from network_pricing; see also GET /v1/pricing.
router.get("/info", async (_req, res) => {
  const pricing = await livePricing();
  res.json({
    supported: true,
    enabled: process.env["X402_ENABLED"] === "true",
    protocol: "x402",
    version: "1",
    facilitators: {
      coinbase: {
        network: process.env["X402_NETWORK"] ?? "base-sepolia",
        receivingAddress: process.env["X402_RECEIVING_ADDRESS"] || null,
        currency: "USDC",
      },
      payai: {
        network: "solana",
        receivingAddress: process.env["X402_RECEIVING_ADDRESS_SOLANA"] || null,
        currency: "USDC",
      },
    },
    // null when the pricing table is unreachable; agents should then read /v1/pricing.
    pricing,
    currencies: [...SUPPORTED_CRYPTO],
    walletType: "custodial",
    agenticWallets: true,
    // x402 Bazaar discovery (docs/agent-network/PAYMENTS.md "Bazaar"): the same
    // metadata the gateway's 402 carries, so catalogs and agents can read it here.
    discovery: {
      discoverable: true,
      resource: {
        url: `https://${process.env["PROXY_PUBLIC_HOST"] ?? "proxy.dominusnode.com"}`,
        description: X402_RESOURCE_DESCRIPTION,
        mimeType: "application/json",
      },
      extensions: { bazaar: bazaarExtension() },
    },
  });
});

export default router;
