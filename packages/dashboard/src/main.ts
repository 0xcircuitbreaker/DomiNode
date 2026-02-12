import dotenv from "dotenv";
dotenv.config();

import { createLogger, closePool } from "@dominode/shared";
import { startApiServer } from "./server.js";

const log = createLogger("api:main");

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

  log.info("environment validation passed");
}

validateRequiredEnv();

const port = parseInt(process.env["DASHBOARD_PORT"] ?? "3000", 10);

const server = startApiServer(port);

// Graceful shutdown
async function shutdown(signal: string): Promise<void> {
  log.info(`received ${signal}, shutting down...`);
  server.close();
  await closePool();
  process.exit(0);
}

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
