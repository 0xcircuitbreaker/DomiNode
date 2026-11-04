import dotenv from "dotenv";
dotenv.config();

import { createLogger, closePool, usageRepo, connectWithRetry, nodeRepo, policyRepo } from "@dominusnode/shared";
import type { ActivePolicy } from "@dominusnode/shared";
import { startProxyServer } from "./server.js";
import { initGeoCheck, lookupPeerGeo } from "./geo-check.js";
import { NodeRegistry } from "./node-tunnel/registry.js";
import { NodeSelector } from "./node-tunnel/selector.js";
import { loadCoordSigner } from "./node-tunnel/coord-key.js";
import { NodeTunnelServer, resolveTunnelPort } from "./node-tunnel/server.js";
import { startSocks5Server } from "./socks5.js";
import { getActiveSessionCount, terminateUserSessions, getActiveSessions } from "./session-manager.js";

const log = createLogger("proxy:main");

// ─── Crash handlers ─────────────────────────────────────────────────
// Socket resets (ECONNRESET, EPIPE, ECONNABORTED) are normal in proxy
// traffic — clients disconnect, upstreams drop connections. Log and
// continue rather than crashing the entire process.
const SOCKET_ERRORS = new Set(["ECONNRESET", "EPIPE", "ECONNABORTED", "ETIMEDOUT"]);

process.on("uncaughtException", (err) => {
  if (err && "code" in err && SOCKET_ERRORS.has((err as NodeJS.ErrnoException).code ?? "")) {
    log.warn("socket error (non-fatal)", { code: (err as NodeJS.ErrnoException).code, message: err.message });
    return; // Do NOT crash — this is normal proxy traffic noise
  }
  log.error("uncaught exception — shutting down", { error: err.message, stack: err.stack });
  process.exit(1);
});
process.on("unhandledRejection", (reason) => {
  const msg = reason instanceof Error ? reason.message : String(reason);
  if (reason instanceof Error && "code" in reason && SOCKET_ERRORS.has((reason as NodeJS.ErrnoException).code ?? "")) {
    log.warn("socket rejection (non-fatal)", { code: (reason as NodeJS.ErrnoException).code, message: msg });
    return;
  }
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

  // ─── Policy snapshot (reloaded every 30 s, pushed to tunnels) ─────
  let policy: ActivePolicy = await policyRepo.getActivePolicy();
  const getPolicy = (): ActivePolicy => policy;

  // ─── Node tunnel server + registry + selector ────────────────────
  await initGeoCheck();
  const registry = new NodeRegistry();
  registry.startSweep();
  const selector = new NodeSelector(registry, { getPolicy: () => policy.body });
  const coordSigner = loadCoordSigner(process.env);
  if (coordSigner) log.info("coordinator signing key loaded", { publicKey: coordSigner.publicKeyHex });
  else log.warn("COORD_SIGNING_KEY_FILE not set: CHALLENGE frames are unsigned (non-production only)");
  const tunnelServer = new NodeTunnelServer(registry, {
    coordSign: coordSigner?.sign,
    getNodeForTunnelAuth: nodeRepo.getNodeForTunnelAuth,
    markOnline: nodeRepo.markOnline,
    markOffline: nodeRepo.markOffline,
    activatePending: async (nodeId) => (await nodeRepo.setStatus(nodeId, "active", ["pending"])) !== null,
    getPolicy,
    geoLookup: lookupPeerGeo,
    onStreamClose: (nodeId, r) => {
      if (r.nodeReport && (r.nodeReport.bytesIn !== r.gatewayBytesOut || r.nodeReport.bytesOut !== r.gatewayBytesIn)) {
        log.warn("node byte report mismatch", { nodeId, gatewayOut: r.gatewayBytesOut, gatewayIn: r.gatewayBytesIn, nodeIn: r.nodeReport.bytesIn, nodeOut: r.nodeReport.bytesOut });
      }
    },
  }, { port: resolveTunnelPort(process.env["TUNNEL_PORT"]), logger: log });
  const tunnelPort = await tunnelServer.listen();
  log.info(`node tunnel server listening on port ${tunnelPort}`);

  const policyInterval = setInterval(async () => {
    try {
      const next = await policyRepo.getActivePolicy();
      if (next.version !== policy.version || next.sha256 !== policy.sha256) {
        policy = next;
        tunnelServer.pushPolicy(next);
        log.info("policy updated", { version: next.version });
      }
    } catch (err) {
      // Keep the last good snapshot
      log.warn("policy reload failed", { error: err instanceof Error ? err.message.slice(0, 100) : "unknown" });
    }
    selector.sweepSticky();
  }, 30_000);
  policyInterval.unref();

  const relay = { selector, getPolicy: () => policy.body, nodeCount: () => registry.size };

  // Clean up orphaned sessions from previous crash
  const orphaned = await usageRepo.cleanupOrphanedSessions();
  if (orphaned > 0) {
    log.info(`cleaned up ${orphaned} orphaned sessions from previous run`);
  }

  const httpServer = await startProxyServer(httpPort, relay);
  const socks5Server = await startSocks5Server(socks5Port, relay);

  // Graceful shutdown
  async function shutdown(signal: string): Promise<void> {
    log.info(`received ${signal}, shutting down...`);

    httpServer.close();
    socks5Server.close();
    clearInterval(policyInterval);

    // Wait for active sessions to finish (max 30s)
    const start = Date.now();
    while (getActiveSessionCount() > 0 && Date.now() - start < 30_000) {
      await new Promise((r) => setTimeout(r, 500));
    }

    if (getActiveSessionCount() > 0) {
      log.warn(`forced shutdown with ${getActiveSessionCount()} active sessions — force-settling`);
      // Force-settle all remaining sessions to prevent unbilled bandwidth
      const remaining = getActiveSessions();
      const uniqueUsers = new Set(remaining.map(s => s.userId));
      for (const uid of uniqueUsers) {
        try { await terminateUserSessions(uid); } catch { /* best effort */ }
      }
    }

    registry.stopSweep();
    try { await tunnelServer.close(); } catch { /* best effort */ }
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
