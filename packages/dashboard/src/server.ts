import express from "express";
import cors from "cors";
import helmet from "helmet";
import cookieParser from "cookie-parser";
import rateLimit from "express-rate-limit";
import * as crypto from "node:crypto";
import { createLogger, query } from "@dominusnode/shared";

import { refreshTokenRepo } from "@dominusnode/shared";
import webhookRoutes from "./routes/webhooks.js";
import authRoutes from "./routes/auth.js";
import keyRoutes from "./routes/keys.js";
import usageRoutes from "./routes/usage.js";
import walletRoutes from "./routes/wallet.js";
import planRoutes from "./routes/plans.js";
import sessionRoutes from "./routes/sessions.js";
import adminRoutes from "./routes/admin.js";
import proxyConfigRoutes from "./routes/proxy-config.js";
import proxyHealthRoutes from "./routes/proxy-health.js";
import walletAuthRoutes from "./routes/wallet-auth.js";
import accountRoutes from "./routes/account.js";
import slotsRoutes from "./routes/slots.js";
import waitlistRoutes from "./routes/waitlist.js";
import agentWalletRoutes from "./routes/agent-wallet.js";
import x402Routes from "./routes/x402.js";
import teamsRoutes from "./routes/teams.js";

const log = createLogger("api:server");

export function startApiServer(port: number = 3000): ReturnType<express.Express["listen"]> {
  const ALLOWED_ORIGINS = (process.env["CORS_ORIGINS"] ?? "http://localhost:5173")
    .split(",")
    .map((s) => s.trim());

  function getRequestHost(req: express.Request): string {
    const forwardedHostHeader = req.headers["x-forwarded-host"];
    if (typeof forwardedHostHeader === "string" && forwardedHostHeader.trim()) {
      return forwardedHostHeader.split(",")[0]?.trim() ?? "";
    }
    if (Array.isArray(forwardedHostHeader) && forwardedHostHeader[0]) {
      return forwardedHostHeader[0];
    }
    return req.headers["host"] ?? "";
  }

  function parseHost(rawHost: string): { host: string; hostname: string; port: string } {
    try {
      const normalized = rawHost.includes("://") ? rawHost : `http://${rawHost}`;
      const parsed = new URL(normalized);
      return {
        host: parsed.host.toLowerCase(),
        hostname: parsed.hostname.toLowerCase(),
        port: parsed.port,
      };
    } catch {
      return { host: rawHost.toLowerCase(), hostname: rawHost.toLowerCase(), port: "" };
    }
  }

  function isOriginAllowedForRequest(origin: string, req: express.Request): boolean {
    if (ALLOWED_ORIGINS.includes("*") || ALLOWED_ORIGINS.includes(origin)) return true;
    try {
      const originUrl = new URL(origin);
      const originHost = originUrl.host.toLowerCase();
      const originHostname = originUrl.hostname.toLowerCase();
      const originPort = originUrl.port;
      const requestHost = getRequestHost(req);
      if (!requestHost) return false;

      const parsedRequestHost = parseHost(requestHost);
      if (originHost === parsedRequestHost.host) return true;
      if (originHostname !== parsedRequestHost.hostname) return false;

      // R40 H-2: Strict port matching — if request host has no port, only allow
      // origins with no explicit port or standard ports for their scheme
      if (!parsedRequestHost.port) {
        if (!originPort) return true;
        const isStandardPort = (originUrl.protocol === "https:" && originPort === "443") ||
                                (originUrl.protocol === "http:" && originPort === "80");
        return isStandardPort;
      }
      if (!originPort) {
        const isStandardPort = (originUrl.protocol === "https:" && parsedRequestHost.port === "443") ||
                                (originUrl.protocol === "http:" && parsedRequestHost.port === "80");
        return isStandardPort;
      }
      return parsedRequestHost.port === originPort;
    } catch {
      return false;
    }
  }

  if (process.env.NODE_ENV === "production" && ALLOWED_ORIGINS.includes("*")) {
    throw new Error("CORS_ORIGINS must not contain wildcard (*) in production");
  }

  const app = express();

  // Trust proxy: required for correct req.ip behind reverse proxies (nginx, Cloudflare, ALB)
  // Without this, rate limiting, login lockout, and webhook IP allowlisting all use the proxy's IP (R13 C-2)
  const trustProxy = process.env["TRUST_PROXY"];
  if (trustProxy) {
    const parsed = parseInt(trustProxy, 10);
    app.set("trust proxy", isNaN(parsed) ? trustProxy : parsed);
  } else if (process.env.NODE_ENV === "production") {
    // Default to 1 hop (single reverse proxy) in production
    app.set("trust proxy", 1);
  }

  // Security headers
  app.use(helmet({
    hsts: { maxAge: 31536000, includeSubDomains: true, preload: true },
  }));

  // Request ID for tracing
  app.use((req, _res, next) => {
    (req as unknown as Record<string, unknown>).requestId = crypto.randomUUID();
    next();
  });

  // Cache control: no-store for API responses
  app.use((_req, res, next) => {
    res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate");
    res.setHeader("Pragma", "no-cache");
    next();
  });

  // Cookie parser — must be before routes
  app.use(cookieParser());

  // CORS — restricted to frontend origin(s), with credentials for httpOnly cookies
  app.use(
    cors({
      origin: ALLOWED_ORIGINS,
      methods: ["GET", "POST", "PUT", "PATCH", "DELETE"],
      allowedHeaders: ["Content-Type", "Authorization"],
      credentials: true,
      maxAge: 86400,
    }),
  );

  // Global rate limit: 100 requests/min per IP
  app.use(
    rateLimit({
      windowMs: 60_000,
      max: 100,
      standardHeaders: true,
      legacyHeaders: false,
      message: { error: "Too many requests, please try again later" },
    }),
  );

  // Webhook routes FIRST (before express.json) — they need raw body
  app.use("/api/webhooks", webhookRoutes);

  // CSRF protection: verify Origin header on state-changing requests.
  // With httpOnly cookie auth, Origin validation prevents CSRF attacks.
  // CSRF is only possible when the browser auto-sends auth cookies.
  // Requests without cookies (extension/API) are not vulnerable to CSRF.
  app.use((req, res, next) => {
    if (req.method === "GET" || req.method === "HEAD" || req.method === "OPTIONS") {
      next();
      return;
    }
    // Skip for webhook routes (they use signature verification, not Origin)
    if (req.path.startsWith("/api/webhooks")) {
      next();
      return;
    }
    // CSRF is only a risk when auth cookies are present (auto-sent by browser).
    // Requests without cookies are from extension/API clients — no CSRF risk.
    const hasAuthCookie = !!req.cookies?.dominusnode_access || !!req.cookies?.dominusnode_refresh;
    if (!hasAuthCookie) {
      next();
      return;
    }
    // Request has auth cookies — require valid Origin header
    const origin = req.headers["origin"];
    if (!origin) {
      log.warn("CSRF: rejected cookie-auth request with missing Origin", { path: req.path });
      res.status(403).json({ error: "Missing Origin header" });
      return;
    }
    if (!isOriginAllowedForRequest(origin, req)) {
      log.warn("CSRF: rejected request with invalid Origin", { origin, path: req.path });
      res.status(403).json({ error: "Invalid origin" });
      return;
    }
    next();
  });

  // JSON body parser with size limit
  app.use(express.json({ limit: "16kb", type: "application/json" }));

  // Stricter rate limits on auth endpoints (login, register, wallet-auth)
  // Note: the custom per-IP login lockout in auth.ts provides the real credential-stuffing defense.
  // This express-rate-limit acts as a coarse outer guard on all auth routes.
  const authLimiter = rateLimit({
    windowMs: 15 * 60_000, // 15 minutes
    max: 60,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: "Too many requests. Please try again later." },
  });

  // Routes
  app.use("/api/auth/wallet", authLimiter, walletAuthRoutes);
  app.use("/api/auth", authLimiter, authRoutes);
  app.use("/api/keys", keyRoutes);
  app.use("/api/usage", usageRoutes);
  app.use("/api/wallet", walletRoutes);
  app.use("/api/plans", planRoutes);
  app.use("/api/sessions", sessionRoutes);
  app.use("/api/admin", adminRoutes);
  app.use("/api/proxy/config", proxyConfigRoutes);
  app.use("/api/proxy", proxyHealthRoutes);
  app.use("/api/account", accountRoutes);
  app.use("/api/slots", slotsRoutes);
  app.use("/api/waitlist", waitlistRoutes);
  app.use("/api/agent-wallet", agentWalletRoutes);
  app.use("/api/x402", x402Routes);
  app.use("/api/teams", teamsRoutes);

  // RFC 9116: security.txt
  app.get("/.well-known/security.txt", (_req, res) => {
    const expires = new Date(Date.now() + 180 * 24 * 60 * 60 * 1000).toISOString();
    res.type("text/plain").send(
      `Contact: mailto:security@dominusnode.com\n` +
      `Expires: ${expires}\n` +
      `Preferred-Languages: en\n`
    );
  });

  // Prometheus metrics endpoint (localhost only)
  // H-2 fix: Use socket.remoteAddress (not req.ip) to prevent X-Forwarded-For spoofing
  app.get("/metrics", async (req, res) => {
    const remoteIp = (req.socket.remoteAddress ?? "").replace(/^::ffff:/, "");
    const isLoopback = remoteIp === "127.0.0.1" || remoteIp === "::1";
    if (!isLoopback) {
      res.status(403).send("Forbidden");
      return;
    }
    try {
      const dbResult = await query("SELECT 1");
      const dbUp = dbResult ? 1 : 0;
      const uptime = Math.floor(process.uptime());
      const mem = process.memoryUsage();
      const metrics = [
        "# HELP dominusnode_api_up API health status (1=healthy, 0=unhealthy)",
        "# TYPE dominusnode_api_up gauge",
        `dominusnode_api_up ${dbUp}`,
        "",
        "# HELP dominusnode_api_uptime_seconds API uptime in seconds",
        "# TYPE dominusnode_api_uptime_seconds gauge",
        `dominusnode_api_uptime_seconds ${uptime}`,
        "",
        "# HELP dominusnode_api_memory_rss_bytes API resident set size",
        "# TYPE dominusnode_api_memory_rss_bytes gauge",
        `dominusnode_api_memory_rss_bytes ${mem.rss}`,
        "",
        "# HELP dominusnode_api_memory_heap_used_bytes API heap used",
        "# TYPE dominusnode_api_memory_heap_used_bytes gauge",
        `dominusnode_api_memory_heap_used_bytes ${mem.heapUsed}`,
        "",
        "# HELP dominusnode_api_memory_heap_total_bytes API heap total",
        "# TYPE dominusnode_api_memory_heap_total_bytes gauge",
        `dominusnode_api_memory_heap_total_bytes ${mem.heapTotal}`,
        "",
      ].join("\n");
      res.type("text/plain; version=0.0.4; charset=utf-8").send(metrics);
    } catch {
      res.type("text/plain; version=0.0.4; charset=utf-8").send(
        `dominusnode_api_up 0\ndominusnode_api_uptime_seconds ${Math.floor(process.uptime())}\n`
      );
    }
  });

  // Health check
  app.get("/api/health", async (_req, res) => {
    try {
      await query("SELECT 1");
      res.json({ status: "ok", service: "dominusnode-api", db: "connected" });
    } catch {
      res.status(503).json({ status: "error", service: "dominusnode-api", db: "disconnected" });
    }
  });

  // 404
  app.use((_req, res) => {
    res.status(404).json({ error: "Not found" });
  });

  // Error handler
  app.use(
    (
      err: Error,
      _req: express.Request,
      res: express.Response,
      _next: express.NextFunction,
    ) => {
      log.error("unhandled error", { error: err.message });
      res.status(500).json({ error: "Internal server error" });
    },
  );

  // Periodic expired token cleanup (every hour)
  const tokenPurgeInterval = setInterval(async () => {
    try {
      const purged = await refreshTokenRepo.purgeExpired();
      if (purged > 0) {
        log.info("purged expired refresh tokens", { count: purged });
      }
    } catch (err) {
      log.error("token purge failed", { error: err instanceof Error ? err.message : String(err) });
    }
  }, 3600_000);
  tokenPurgeInterval.unref();

  // Warn if webhook IP allowlisting is configured but trust proxy is not set (H-7)
  // Without trust proxy, req.ip returns the reverse proxy's IP, not the real client IP,
  // making webhook IP allowlisting ineffective behind nginx/Cloudflare/ALB.
  if (!trustProxy && process.env.NODE_ENV !== "production") {
    const hasWebhookIpConfig = process.env["STRIPE_WEBHOOK_IPS"] || process.env["NOWPAYMENTS_WEBHOOK_IPS"];
    if (hasWebhookIpConfig) {
      log.warn("TRUST_PROXY is not set but webhook IP allowlisting is configured. " +
        "Behind a reverse proxy, req.ip will return the proxy's IP, not the real client IP. " +
        "Set TRUST_PROXY=1 (or the number of proxy hops) for correct IP-based security.");
    }
  }

  const server = app.listen(port, () => {
    log.info(`API server listening on port ${port}`);
  });

  return server;
}
