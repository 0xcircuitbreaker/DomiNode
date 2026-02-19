import { Router } from "express";
import { SUPPORTED_CRYPTO, PRICE_PER_GB_CENTS, PRICE_PER_GB_CENTS_DC } from "@dominusnode/shared";

const router = Router();

// GET /api/x402/info — Public x402 payment protocol info
// R33 M-5: Use shared constants instead of hardcoded pricing
router.get("/info", (_req, res) => {
  res.json({
    supported: true,
    protocol: "x402",
    pricing: {
      dcPerGbCents: PRICE_PER_GB_CENTS_DC,
      residentialPerGbCents: PRICE_PER_GB_CENTS,
    },
    currencies: [...SUPPORTED_CRYPTO],
    walletType: "custodial",
    agenticWallets: true,
  });
});

export default router;
