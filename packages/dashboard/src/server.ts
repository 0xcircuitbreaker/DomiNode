import express from "express";
import cors from "cors";
import helmet from "helmet";
import rateLimit from "express-rate-limit";
import { createLogger } from "@dominode/shared";

import webhookRoutes from "./routes/webhooks.js";
import authRoutes from "./routes/auth.js";
import keyRoutes from "./routes/keys.js";
import usageRoutes from "./routes/usage.js";
import walletRoutes from "./routes/wallet.js";
import planRoutes from "./routes/plans.js";
import sessionRoutes from "./routes/sessions.js";
import adminRoutes from "./routes/admin.js";

const log = createLogger("api:server");

export function startApiServer(port: number = 3000): ReturnType<express.Express["listen"]> {
  const ALLOWED_ORIGINS = (process.env["CORS_ORIGINS"] ?? "http://localhost:5173")
    .split(",")
    .map((s) => s.trim());

  const app = express();

  // Security headers
  app.use(helmet());

  // CORS — restricted to frontend origin(s)
  app.use(
    cors({
      origin: ALLOWED_ORIGINS,
      methods: ["GET", "POST", "PUT", "DELETE"],
      allowedHeaders: ["Content-Type", "Authorization"],
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

  // JSON body parser with size limit
  app.use(express.json({ limit: "16kb" }));

  // Stricter rate limits on auth endpoints
  const authLimiter = rateLimit({
    windowMs: 15 * 60_000, // 15 minutes
    max: 10, // 10 attempts per 15 min per IP
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: "Too many attempts, please try again later" },
  });

  // Routes
  app.use("/api/auth", authLimiter, authRoutes);
  app.use("/api/keys", keyRoutes);
  app.use("/api/usage", usageRoutes);
  app.use("/api/wallet", walletRoutes);
  app.use("/api", planRoutes);
  app.use("/api/sessions", sessionRoutes);
  app.use("/api/admin", adminRoutes);

  // Health check
  app.get("/api/health", (_req, res) => {
    res.json({ status: "ok", service: "dominode-api" });
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

  const server = app.listen(port, () => {
    log.info(`API server listening on port ${port}`);
  });

  return server;
}
