import dotenv from "dotenv";
dotenv.config();

import { createLogger, closePool, retentionRepo, connectWithRetry } from "@dominusnode/shared";
import { startApiServer } from "./server.js";

const log = createLogger("api:main");

// ─── Crash handlers — log and exit rather than silently dying ────────
process.on("uncaughtException", (err) => {
  log.error("uncaught exception — shutting down", { error: err.message, stack: err.stack });
  process.exit(1);
});
process.on("unhandledRejection", (reason) => {
  const msg = reason instanceof Error ? reason.message : String(reason);
  log.error("unhandled rejection — shutting down", { error: msg });
  process.exit(1);
});

// ─── Startup validation ─────────────────────────────────────────────
function validateRequiredEnv(): void {
  const errors: string[] = [];

  if (!process.env["DATABASE_URL"]) {
    errors.push("DATABASE_URL is required");
  }

  const jwtSecret = process.env["JWT_SECRET"] ?? "";
  if (!jwtSecret) {
    errors.push("JWT_SECRET is required");
  } else if (jwtSecret.length < 32) {
    errors.push("JWT_SECRET must be at least 32 characters");
  }

  if (process.env.NODE_ENV === "production" && jwtSecret === "change-me-to-a-64-char-random-string-in-production") {
    errors.push("JWT_SECRET must not use the default value in production");
  }

  const mfaKey = process.env["MFA_ENCRYPTION_KEY"];
  if (mfaKey && mfaKey.length < 32) {
    errors.push("MFA_ENCRYPTION_KEY must be at least 32 characters when set");
  }

  if (errors.length > 0) {
    for (const err of errors) {
      log.error(`startup validation failed: ${err}`);
    }
    throw new Error(`Environment validation failed: ${errors.join("; ")}`);
  }

  // Non-fatal warnings for MCP agent support
  if (!process.env["MCP_AGENT_SECRET"]) {
    log.warn("MCP_AGENT_SECRET is not set — MCP agent auto-verification and reCAPTCHA bypass are DISABLED. AI agents will not be able to register or create API keys.");
  }

  log.info("environment validation passed");
}

async function start(): Promise<void> {
  validateRequiredEnv();

  const port = parseInt(process.env["DASHBOARD_PORT"] ?? "3000", 10);
  if (isNaN(port) || port < 1 || port > 65535) {
    throw new Error("DASHBOARD_PORT must be a valid port number (1-65535)");
  }

  // Ensure database is reachable before accepting requests
  await connectWithRetry();

  const server = startApiServer(port);

  // Add server error listener for clear port-in-use errors
  server.on("error", (err: NodeJS.ErrnoException) => {
    if (err.code === "EADDRINUSE") {
      log.error(`Port ${port} is already in use`);
    } else {
      log.error("server error", { error: err.message });
    }
    process.exit(1);
  });

  // ─── Scheduled data retention cleanup (hourly) ─────────────────────
  const retentionInterval = setInterval(async () => {
    try {
      const deleted = await retentionRepo.enforceRetentionPolicies();
      if (deleted > 0) {
        log.info("data retention cleanup completed", { deleted });
      }
    } catch (err) {
      log.error("data retention cleanup failed", { error: err instanceof Error ? err.message : String(err) });
    }
  }, 3600_000); // 1 hour
  retentionInterval.unref();

  // Graceful shutdown with connection draining
  let isShuttingDown = false;
  async function shutdown(signal: string): Promise<void> {
    if (isShuttingDown) return; // Prevent double-shutdown
    isShuttingDown = true;
    log.info(`received ${signal}, shutting down...`);

    // Stop accepting new connections
    server.close(() => {
      log.info("all connections drained");
    });

    // Wait for server to fully close (max 30s)
    await new Promise<void>((resolve) => {
      const checkInterval = setInterval(() => {
        server.getConnections((err, count) => {
          if (err || count === 0) {
            clearInterval(checkInterval);
            resolve();
          } else {
            log.info(`waiting for ${count} connections to drain...`);
          }
        });
      }, 1000);

      // Force resolve after 30s
      setTimeout(() => {
        clearInterval(checkInterval);
        log.warn("drain timeout exceeded, forcing shutdown");
        resolve();
      }, 30_000);
    });

    await closePool();
    process.exit(0);
  }

  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));
}

start().catch((err) => {
  log.error("failed to start API server", { error: err instanceof Error ? err.message : String(err) });
  process.exit(1);
});
