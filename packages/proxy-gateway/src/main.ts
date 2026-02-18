import dotenv from "dotenv";
dotenv.config();

import { createLogger, closePool, usageRepo, connectWithRetry } from "@dominusnode/shared";
import { validateConfig, createProviderSelector, getBandwidthUsage } from "@dominusnode/pool-manager";
import { startProxyServer } from "./server.js";
import { startSocks5Server } from "./socks5.js";
import { getActiveSessionCount, terminateUserSessions, getActiveSessions } from "./session-manager.js";

const log = createLogger("proxy:main");

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

const httpPort = parseInt(process.env["PROXY_LISTEN_PORT"] ?? "8080", 10);
const socks5Port = parseInt(process.env["SOCKS5_LISTEN_PORT"] ?? "1080", 10);

if (isNaN(httpPort) || httpPort < 1 || httpPort > 65535) {
  throw new Error("PROXY_LISTEN_PORT must be a valid port number (1-65535)");
}
if (isNaN(socks5Port) || socks5Port < 1 || socks5Port > 65535) {
  throw new Error("SOCKS5_LISTEN_PORT must be a valid port number (1-65535)");
}

async function main(): Promise<void> {
  // Validate critical env vars before starting
  if (!process.env["DATABASE_URL"]) {
    throw new Error("DATABASE_URL is required");
  }

  // Ensure database is reachable before accepting connections
  await connectWithRetry();

  validateConfig();

  // Create provider selector with all configured providers
  const providerSelector = createProviderSelector();
  const providerCount = providerSelector.getProviderCount();
  log.info(`initialized ${providerCount} proxy provider(s)`);

  // Clean up orphaned sessions from previous crash
  const orphaned = await usageRepo.cleanupOrphanedSessions();
  if (orphaned > 0) {
    log.info(`cleaned up ${orphaned} orphaned sessions from previous run`);
  }

  const httpServer = await startProxyServer(httpPort, providerSelector);
  const socks5Server = await startSocks5Server(socks5Port, providerSelector);

  // ─── Webshare bandwidth monitoring (every 5 min) ─────────────────
  const BANDWIDTH_WARN_THRESHOLD = 0.80; // 80%
  const BANDWIDTH_CRITICAL_THRESHOLD = 0.95; // 95%
  const bandwidthMonitorInterval = setInterval(async () => {
    try {
      const usage = await getBandwidthUsage();
      if (usage.totalBytes <= 0) return; // No limit configured

      const ratio = usage.usedBytes / usage.totalBytes;
      const usedGB = (usage.usedBytes / (1024 * 1024 * 1024)).toFixed(2);
      const totalGB = (usage.totalBytes / (1024 * 1024 * 1024)).toFixed(2);
      const pct = (ratio * 100).toFixed(1);

      if (ratio >= BANDWIDTH_CRITICAL_THRESHOLD) {
        log.error("CRITICAL: Webshare bandwidth near limit", { usedGB, totalGB, pct: `${pct}%` });
      } else if (ratio >= BANDWIDTH_WARN_THRESHOLD) {
        log.warn("Webshare bandwidth approaching limit", { usedGB, totalGB, pct: `${pct}%` });
      } else {
        log.info("Webshare bandwidth check", { usedGB, totalGB, pct: `${pct}%` });
      }
    } catch (err) {
      // Don't log full error — may contain API key or account details
      log.warn("Webshare bandwidth check failed", { error: err instanceof Error ? err.message.slice(0, 100) : "unknown" });
    }
  }, 300_000); // 5 minutes
  bandwidthMonitorInterval.unref();

  // Graceful shutdown
  async function shutdown(signal: string): Promise<void> {
    log.info(`received ${signal}, shutting down...`);

    httpServer.close();
    socks5Server.close();

    // Wait for active sessions to finish (max 30s)
    const start = Date.now();
    while (getActiveSessionCount() > 0 && Date.now() - start < 30_000) {
      await new Promise((r) => setTimeout(r, 500));
    }

    if (getActiveSessionCount() > 0) {
      log.warn(`forced shutdown with ${getActiveSessionCount()} active sessions — force-settling`);
      // R29 C-2: Force-settle all remaining sessions to prevent unbilled bandwidth
      const remaining = getActiveSessions();
      const uniqueUsers = new Set(remaining.map(s => s.userId));
      for (const uid of uniqueUsers) {
        try { await terminateUserSessions(uid); } catch { /* best effort */ }
      }
    }

    await closePool();
    process.exit(0);
  }

  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));
}

main().catch((err) => {
  log.error("failed to start proxy", { error: err instanceof Error ? err.message : String(err) });
  process.exit(1);
});
