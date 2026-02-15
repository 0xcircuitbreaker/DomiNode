import { Router } from "express";
import { createLogger } from "@dominusnode/shared";
import { requireAuth, type AuthenticatedRequest } from "../middleware/auth.js";

const router = Router();
const log = createLogger("api:proxy-health");

const PROXY_INTERNAL_HOST = process.env["PROXY_INTERNAL_HOST"] ?? "127.0.0.1";
const PROXY_INTERNAL_PORT = process.env["PROXY_INTERNAL_PORT"] ?? process.env["PROXY_LISTEN_PORT"] ?? "8080";
const PROXY_INTERNAL_URL = process.env["PROXY_INTERNAL_URL"] ??
  `http://${PROXY_INTERNAL_HOST}:${PROXY_INTERNAL_PORT}/internal/stats`;
const PROXY_INTERNAL_SECRET = process.env["PROXY_STATS_SECRET"] ?? process.env["JWT_SECRET"] ?? "";

const SUPPORTED_COUNTRIES = [
  "US", "GB", "DE", "FR", "CA", "AU", "NL", "JP", "SG", "BR",
  "IN", "KR", "IT", "ES", "SE", "CH", "MX", "PL", "BE", "AT",
  "NO", "DK", "FI", "IE", "PT", "CZ", "RO", "HU", "BG", "GR",
  "HR", "SK", "SI", "LT", "LV", "EE", "IL", "TH", "VN", "PH",
  "MY", "ID", "TW", "HK", "ZA", "AR", "CL", "CO", "PE", "UA",
];

interface ProviderStat {
  name: string;
  state: string;
  consecutiveFailures: number;
  totalRequests: number;
  totalErrors: number;
  avgLatencyMs: number;
  fallbackOnly: boolean;
}

interface ProxyStats {
  status: string;
  activeSessions: number;
  totalRequests: number;
  totalErrors: number;
  avgLatencyMs: number;
  uptimeSeconds: number;
  providers?: ProviderStat[];
}

async function fetchProxyStats(): Promise<ProxyStats | null> {
  try {
    const headers: Record<string, string> = {};
    if (PROXY_INTERNAL_SECRET) {
      headers["Authorization"] = `Bearer ${PROXY_INTERNAL_SECRET}`;
    }
    const res = await fetch(PROXY_INTERNAL_URL, { signal: AbortSignal.timeout(3000), headers });
    if (!res.ok) return null;
    return await res.json() as ProxyStats;
  } catch (err) {
    log.warn("failed to fetch proxy stats", { error: err instanceof Error ? err.message : String(err) });
    return null;
  }
}

// GET /api/proxy/health — public status (minimal data, no operational details)
router.get("/health", async (_req, res) => {
  const stats = await fetchProxyStats();

  if (!stats) {
    res.json({ status: "unknown" });
    return;
  }

  // Only expose status — no session counts or uptime (prevents competitive intel)
  res.json({ status: stats.status });
});

// GET /api/proxy/status — detailed for authenticated users
router.get("/status", requireAuth, async (req, res) => {
  const stats = await fetchProxyStats();

  const proxyHost = process.env["PROXY_PUBLIC_HOST"] ?? "proxy.dominusnode.io";
  const httpPort = process.env["PROXY_LISTEN_PORT"] ?? "8080";
  const socks5Port = process.env["SOCKS5_LISTEN_PORT"] ?? "1080";

  if (!stats) {
    res.json({
      status: "unknown",
      activeSessions: 0,
      userActiveSessions: 0,
      avgLatencyMs: 0,
      providers: [],
      endpoints: {
        http: `${proxyHost}:${httpPort}`,
        socks5: `${proxyHost}:${socks5Port}`,
      },
      supportedCountries: SUPPORTED_COUNTRIES,
      uptimeSeconds: 0,
    });
    return;
  }

  res.json({
    status: stats.status,
    activeSessions: stats.activeSessions,
    userActiveSessions: 0, // would need per-user tracking via session API
    avgLatencyMs: stats.avgLatencyMs,
    providers: stats.providers ?? [],
    endpoints: {
      http: `${proxyHost}:${httpPort}`,
      socks5: `${proxyHost}:${socks5Port}`,
    },
    supportedCountries: SUPPORTED_COUNTRIES,
    uptimeSeconds: stats.uptimeSeconds,
  });
});

export default router;
