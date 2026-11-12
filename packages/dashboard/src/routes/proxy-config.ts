import { Router } from "express";
import { requireAuth } from "../middleware/auth.js";
import { US_STATES, MAJOR_US_CITIES, getPublicProxyPorts } from "@dominusnode/shared";

const router = Router();

// GET /api/proxy/config — proxy server connection details (for browser extension)
router.get("/", requireAuth, async (_req, res) => {
  const host = process.env["PROXY_PUBLIC_HOST"] ?? process.env["PROXY_HOST"] ?? "localhost";
  const ports = getPublicProxyPorts();

  res.json({
    httpProxy: { host, port: ports.http },
    socks5Proxy: { host, port: ports.socks5 },
    tlsProxy: ports.tls !== null ? { host, port: ports.tls } : null,
    socks5TlsProxy: ports.socks5Tls !== null ? { host, port: ports.socks5Tls } : null,
    supportedCountries: ["US", "GB", "DE", "FR", "JP", "BR", "AU", "CA", "IN", "NL", "SG", "KR"],
    blockedCountries: ["CU", "IR", "KP", "RU", "SY"],
    maxRotationIntervalMinutes: 60,
    minRotationIntervalMinutes: 1,
    geoTargeting: {
      // Webshare only supports country-level targeting; state/city are silently ignored
      stateSupport: false,
      citySupport: false,
      asnSupport: false,
      usStates: US_STATES,
      majorUsCities: MAJOR_US_CITIES,
    },
  });
});

export default router;
