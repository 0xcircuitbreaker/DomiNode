import { Router } from "express";
import { SUPPORTED_CRYPTO, PRICE_PER_GB_CENTS, PRICE_PER_GB_CENTS_DC } from "@dominusnode/shared";
import { X402_RESOURCE_DESCRIPTION, bazaarExtension } from "@dominusnode/billing";

const router = Router();

// GET /api/x402/info — Public x402 payment protocol info
// Use shared constants instead of hardcoded pricing
router.get("/info", (_req, res) => {
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
    pricing: {
      dcPerRequestUsd: process.env["X402_DC_PRICE_PER_REQUEST_USD"] || "0.001",
      residentialPerRequestUsd: process.env["X402_RES_PRICE_PER_REQUEST_USD"] || "0.005",
      dcPerGbCents: PRICE_PER_GB_CENTS_DC,
      residentialPerGbCents: PRICE_PER_GB_CENTS,
    },
    currencies: [...SUPPORTED_CRYPTO],
    walletType: "custodial",
    agenticWallets: true,
    // x402 Bazaar discovery (docs/agent-network/PAYMENTS.md "Bazaar"): the same
    // metadata the gateway's 402 carries, so catalogs and agents can read it here.
    discovery: {
      discoverable: true,
      resource: {
        url: `https://${process.env["PROXY_PUBLIC_HOST"] ?? "proxy.dominusnode.daedalusdevelopmentgroup.com"}`,
        description: X402_RESOURCE_DESCRIPTION,
        mimeType: "application/json",
      },
      extensions: { bazaar: bazaarExtension() },
    },
  });
});

export default router;
