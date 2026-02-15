import { Router } from "express";
import { requireAuth } from "../middleware/auth.js";
import { US_STATES, MAJOR_US_CITIES } from "@dominusnode/shared";

const router = Router();

// GET /api/proxy/config — proxy server connection details (for browser extension)
router.get("/", requireAuth, async (_req, res) => {
  const host = process.env["PROXY_HOST"] ?? "localhost";
  const httpPort = parseInt(process.env["PROXY_HTTP_PORT"] ?? "8080", 10);
  const socks5Port = parseInt(process.env["PROXY_SOCKS5_PORT"] ?? "1080", 10);

  res.json({
    httpProxy: { host, port: httpPort },
    socks5Proxy: { host, port: socks5Port },
    supportedCountries: ["US", "GB", "DE", "FR", "JP", "BR", "AU", "CA", "IN", "NL", "SG", "KR"],
    blockedCountries: ["CU", "IR", "KP", "RU", "SY"],
    maxRotationIntervalMinutes: 60,
    minRotationIntervalMinutes: 1,
    geoTargeting: {
      stateSupport: true,
      citySupport: true,
      asnSupport: false,
      usStates: US_STATES,
      majorUsCities: MAJOR_US_CITIES,
    },
  });
});

export default router;
