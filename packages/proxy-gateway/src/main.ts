import dotenv from "dotenv";
dotenv.config();

import { createLogger, closePool } from "@dominode/shared";
import { validateConfig } from "@dominode/pool-manager";
import { startProxyServer } from "./server.js";
import { startSocks5Server } from "./socks5.js";
import { getActiveSessionCount } from "./session-manager.js";

const log = createLogger("proxy:main");
const httpPort = parseInt(process.env["PROXY_LISTEN_PORT"] ?? "8080", 10);
const socks5Port = parseInt(process.env["SOCKS5_LISTEN_PORT"] ?? "1080", 10);

async function main(): Promise<void> {
  validateConfig();
  const httpServer = await startProxyServer(httpPort);
  const socks5Server = startSocks5Server(socks5Port);

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
