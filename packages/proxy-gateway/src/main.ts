import dotenv from "dotenv";
dotenv.config();

import { createLogger, closePool, usageRepo } from "@dominusnode/shared";
import { validateConfig, createProviderSelector } from "@dominusnode/pool-manager";
import { startProxyServer } from "./server.js";
import { startSocks5Server } from "./socks5.js";
import { getActiveSessionCount } from "./session-manager.js";

const log = createLogger("proxy:main");
const httpPort = parseInt(process.env["PROXY_LISTEN_PORT"] ?? "8080", 10);
const socks5Port = parseInt(process.env["SOCKS5_LISTEN_PORT"] ?? "1080", 10);

async function main(): Promise<void> {
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
      log.warn(`forced shutdown with ${getActiveSessionCount()} active sessions`);
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
