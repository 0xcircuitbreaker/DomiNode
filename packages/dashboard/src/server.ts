import express from "express";
import cors from "cors";
import helmet from "helmet";
import cookieParser from "cookie-parser";
import rateLimit from "express-rate-limit";
import * as crypto from "node:crypto";
import { createLogger, query } from "@dominode/shared";

import { refreshTokenRepo } from "@dominode/shared";
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

      // Reverse proxies often forward Host without port; allow same hostname in that case.
      if (!parsedRequestHost.port || !originPort) return true;
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
      methods: ["GET", "POST", "PUT", "DELETE"],
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
    const hasAuthCookie = !!req.cookies?.dominode_access || !!req.cookies?.dominode_refresh;
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

  // RFC 9116: security.txt
  app.get("/.well-known/security.txt", (_req, res) => {
    const expires = new Date(Date.now() + 180 * 24 * 60 * 60 * 1000).toISOString();
    res.type("text/plain").send(
      `Contact: mailto:security@dominode.io\n` +
      `Expires: ${expires}\n` +
      `Preferred-Languages: en\n`
    );
  });

  // Health check
  app.get("/api/health", async (_req, res) => {
    try {
      await query("SELECT 1");
      res.json({ status: "ok", service: "dominode-api", db: "connected" });
    } catch {
      res.status(503).json({ status: "error", service: "dominode-api", db: "disconnected" });
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
