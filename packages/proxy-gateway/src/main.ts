import type * as net from "node:net";
import dotenv from "dotenv";
dotenv.config();

import { createLogger, closePool, getPool, usageRepo, connectWithRetry, nodeRepo, policyRepo, nodeCreditRepo, retentionRepo, tierRepo, payoutRepo, relayChargeRepo, relaySettleRetryRepo, reportReputationRepo, collusionRepo } from "@dominusnode/shared";
import type { ActivePolicy } from "@dominusnode/shared";
import { startProxyServer } from "./server.js";
import { geoAvailable, initGeoCheck, lookupPeerGeo } from "./geo-check.js";
import { installSharedLimits, makeInstanceId } from "./shared-limits.js";
import { NodeRegistry } from "./node-tunnel/registry.js";
import { NodeSelector } from "./node-tunnel/selector.js";
import { loadCoordSigner } from "./node-tunnel/coord-key.js";
import { NodeTunnelServer, resolveTunnelPort } from "./node-tunnel/server.js";
import { startSocks5Server } from "./socks5.js";
import { loadProxyTls, parseRequireTls, createPlaintextAuthGuard } from "./proxy-tls.js";
import { envInt, setJobRunRecorder, JOB_RUN_UPSERT_SQL, type Job, type LockPool } from "./jobs/runner.js";
import * as nodeStatusJob from "./jobs/node-status.js";
import * as maturityJob from "./jobs/maturity.js";
import * as retentionJob from "./jobs/retention.js";
import * as tiersJob from "./jobs/tiers.js";
import * as payoutsJob from "./jobs/payouts.js";
import * as reputationFlushJob from "./jobs/reputation-flush.js";
import * as settleRetryJob from "./jobs/relay-settle-retry.js";
import * as reportReputationJob from "./jobs/report-reputation.js";
import * as collusionJob from "./jobs/collusion.js";
import { loadSdnFile } from "./jobs/sdn.js";
import * as probesJob from "./jobs/probes.js";
import { parseTrustedProxyIps, loadTunnelTls } from "./node-tunnel/ingress.js";
import { createEthersPayoutSender } from "./jobs/payout-sender-ethers.js";
import { getActiveSessionCount, terminateUserSessions, getActiveSessions, awaitInFlightSettlements, getInFlightSettlementCount } from "./session-manager.js";

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
  const isProduction = process.env["NODE_ENV"] === "production";
  const asnDbOptional = process.env["ASN_DB_OPTIONAL"] === "true";
  if (!geoAvailable()) log.warn("geo database unavailable: public peers and destinations are refused", { asnRequired: isProduction && !asnDbOptional });
  const shared = installSharedLimits(log);
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
    claimIpSlot: shared.claimIpSlot,
    releaseIpSlot: shared.releaseIpSlot,
    activatePending: async (nodeId) => (await nodeRepo.setStatus(nodeId, "active", ["pending"])) !== null,
    getPolicy,
    geoLookup: lookupPeerGeo,
    onStreamClose: (nodeId, r) => {
      if (r.nodeReport && (r.nodeReport.bytesIn !== r.gatewayBytesOut || r.nodeReport.bytesOut !== r.gatewayBytesIn)) {
        log.warn("node byte report mismatch", { nodeId, gatewayOut: r.gatewayBytesOut, gatewayIn: r.gatewayBytesIn, nodeIn: r.nodeReport.bytesIn, nodeOut: r.nodeReport.bytesOut });
      }
    },
  }, {
    port: resolveTunnelPort(process.env["TUNNEL_PORT"]),
    logger: log,
    trustedProxyIps: parseTrustedProxyIps(process.env["TUNNEL_TRUSTED_PROXY_IPS"]),
    tls: loadTunnelTls(process.env),
    production: isProduction,
    requireAsn: isProduction && !asnDbOptional,
  });
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

  // ─── Background jobs (DESIGN.md §6.4, §15) ─────────────────────────
  const jobs = startJobs(registry, getPolicy);

  // TLS proxy listener (DESIGN.md §15): Proxy-Authorization over TLS.
  const proxyTls = loadProxyTls(process.env);
  const requireTls = parseRequireTls(process.env);
  if (requireTls && !proxyTls) throw new Error("PROXY_REQUIRE_TLS=true requires PROXY_TLS_PORT");
  const plaintextAuth = createPlaintextAuthGuard({ production: isProduction, requireTls, warn: (m, meta) => log.warn(m, meta) });
  if (isProduction && !requireTls) {
    log.warn(proxyTls
      ? "plaintext proxy listeners accept credentials; set PROXY_REQUIRE_TLS=true once clients use the TLS port"
      : "PROXY_TLS_PORT not set: proxy credentials travel in plaintext");
  }
  const httpServer = await startProxyServer(httpPort, relay, { plaintextAuth });
  const socks5Server = await startSocks5Server(socks5Port, relay, { plaintextAuth });
  const tlsServers: net.Server[] = [];
  if (proxyTls) {
    tlsServers.push(await startProxyServer(proxyTls.port, relay, { tls: proxyTls }));
    if (proxyTls.socks5Port !== null) tlsServers.push(await startSocks5Server(proxyTls.socks5Port, relay, { tls: proxyTls }));
  }

  // Graceful shutdown
  async function shutdown(signal: string): Promise<void> {
    log.info(`received ${signal}, shutting down...`);

    httpServer.close();
    socks5Server.close();
    for (const s of tlsServers) s.close();
    clearInterval(policyInterval);
    await Promise.all(jobs.map((j) => j.stop().catch(() => {})));

    // Wait for active sessions to finish (max 30s)
    const DRAIN_TIMEOUT_MS = 30_000;
    const start = Date.now();
    while (getActiveSessionCount() > 0 && Date.now() - start < DRAIN_TIMEOUT_MS) {
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

    // Sessions leave the active map when settlement STARTS; wait for those
    // settlements to commit before the pool goes away. The drain timeout is
    // the overall upper bound (force-settles above are awaited directly).
    const settleBudget = Math.max(0, DRAIN_TIMEOUT_MS - (Date.now() - start));
    if (!(await awaitInFlightSettlements(settleBudget))) {
      log.warn(`shutdown with ${getInFlightSettlementCount()} settlements still in flight`);
    }

    registry.stopSweep();
    try { await tunnelServer.close(); } catch { /* best effort */ }
    await shared.stop();
    await closePool();
    process.exit(0);
  }

  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));
}

function startJobs(registry: NodeRegistry, getPolicy: () => ActivePolicy): Job[] {
  const pool = getPool() as unknown as LockPool;
  const jobLog = createLogger("proxy:jobs");
  const jobs: Job[] = [];
  if (process.env["JOBS_ENABLED"] === "false") {
    jobLog.warn("JOBS_ENABLED=false: background jobs disabled on this instance");
    return jobs;
  }
  const instanceId = makeInstanceId();
  setJobRunRecorder(async (r) => {
    await getPool().query(JOB_RUN_UPSERT_SQL, [
      r.name, instanceId, r.startedAt.toISOString(), r.finishedAt.toISOString(), r.ok, r.error,
      Math.min(2_147_483_647, Math.max(0, r.finishedAt.getTime() - r.startedAt.getTime())),
    ]);
  });
  jobs.push(nodeStatusJob.start({
    logger: jobLog, intervalMs: envInt(process.env, "NODE_STATUS_SYNC_INTERVAL_MS", 30_000, 5_000, 3_600_000),
    deps: {
      liveNodeIds: () => [...registry.all()].map((n) => n.nodeId),
      fetchStatuses: async (ids) => {
        const r = await getPool().query<{ id: string; status: string }>(
          "SELECT id, status FROM nodes WHERE id = ANY($1::uuid[])", [ids]);
        return new Map(r.rows.map((x) => [x.id, x.status]));
      },
      setStatus: (nodeId, status) => {
        const n = registry.get(nodeId);
        if (n && n.status !== status) n.status = status as typeof n.status;
      },
      close: (nodeId, reason) => registry.get(nodeId)?.tunnel.close(reason),
    },
  }));
  jobs.push(maturityJob.start({
    pool, logger: jobLog, intervalMs: envInt(process.env, "MATURITY_JOB_INTERVAL_MS", 3_600_000, 60_000, 86_400_000),
    deps: { matureDue: nodeCreditRepo.matureDue },
  }));
  jobs.push(settleRetryJob.start({
    pool, logger: jobLog, intervalMs: envInt(process.env, "SETTLE_RETRY_JOB_INTERVAL_MS", 60_000, 10_000, 3_600_000),
    deps: {
      listDue: relaySettleRetryRepo.listDueSettleRetries,
      settle: relayChargeRepo.settleRelayCharge,
      markDone: relaySettleRetryRepo.markSettleRetryDone,
      markFailed: (id, e) => relaySettleRetryRepo.markSettleRetryFailed(id, e),
      onDead: async (id, bytes) => { await usageRepo.endSession(id, bytes, "error"); },
      logger: jobLog,
    },
  }));
  jobs.push(retentionJob.start({
    pool, logger: jobLog, intervalMs: envInt(process.env, "RETENTION_JOB_INTERVAL_MS", 3_600_000, 60_000, 86_400_000),
    deps: { getRetentionDays: () => getPolicy().body.logRetentionDays, purgeBatch: retentionRepo.purgeRelayAbuseLogBatch },
  }));
  jobs.push(tiersJob.start({
    pool, logger: jobLog, intervalMs: envInt(process.env, "TIER_JOB_INTERVAL_MS", 86_400_000, 3_600_000, 7 * 86_400_000),
    deps: {
      listOwners: tierRepo.listTierOwners, getUptimeBps: tierRepo.getOwnerUptimeBps,
      getStats: tierRepo.getOwnerTierStats, apply: (u, s) => tierRepo.applyOwnerTier(u, s),
    },
  }));
  jobs.push(reputationFlushJob.start({
    logger: jobLog, intervalMs: envInt(process.env, "REPUTATION_FLUSH_INTERVAL_MS", 60_000, 10_000, 3_600_000),
    deps: {
      drain: () => registry.drainCounters(),
      flushHealth: nodeRepo.flushHealth,
      refreshPenalties: async () => {
        const ids = [...registry.all()].map((n) => n.nodeId);
        for (let i = 0; i < ids.length; i += 1000) {
          const chunk = ids.slice(i, i + 1000);
          registry.setReportPenalties(chunk, await reportReputationRepo.getReportPenalties(chunk));
        }
      },
      quarantine: async (nodeId) => {
        await nodeRepo.setStatus(nodeId, "quarantined", ["active", "pending", "cooldown"]);
        registry.get(nodeId)?.tunnel.close("quarantined");
      },
      flagReview: (nodeId, penalty) => reportReputationRepo.flagReportPenaltyReview(nodeId, penalty),
    },
  }));
  jobs.push(reportReputationJob.start({
    pool, logger: jobLog, intervalMs: envInt(process.env, "REPORT_REPUTATION_INTERVAL_MS", 3_600_000, 60_000, 86_400_000),
    deps: {
      listAggregates: reportReputationRepo.listReportAggregates,
      compute: reportReputationRepo.computeReportPenalties,
      apply: reportReputationRepo.applyReportPenalties,
      params: reportReputationJob.paramsFromEnv(process.env, envInt, reportReputationRepo.DEFAULT_REPORT_PENALTY_PARAMS),
    },
  }));
  jobs.push(collusionJob.start({
    pool, logger: jobLog, intervalMs: envInt(process.env, "COLLUSION_JOB_INTERVAL_MS", 86_400_000, 3_600_000, 7 * 86_400_000),
    deps: {
      getSettings: collusionRepo.getSettings,
      listNodes: collusionRepo.listNodeConcentration,
      listCircular: collusionRepo.listCircularPairs,
      evaluateNode: collusionRepo.evaluateNode,
      evaluateCircular: collusionRepo.evaluateCircular,
      record: collusionRepo.recordFinding,
    },
  }));
  const probeTarget = probesJob.parseProbeUrl(process.env["PROBE_URL"]);
  if (probeTarget) {
    jobs.push(probesJob.start({
      logger: jobLog, intervalMs: envInt(process.env, "PROBE_INTERVAL_MS", 900_000, 60_000, 86_400_000),
      deps: {
        target: probeTarget,
        sampleSize: envInt(process.env, "PROBE_SAMPLE_SIZE", 20, 1, 1000),
        timeoutMs: envInt(process.env, "PROBE_TIMEOUT_MS", 10_000, 1000, 60_000),
        listNodes: () => [...registry.all()]
          .filter((n) => n.ready && n.status === "active" && n.tunnel.isOpen)
          .map((n) => ({ nodeId: n.nodeId, ip: n.ip, openStream: (h, p) => n.tunnel.openStream(h, p) })),
        quarantine: async (nodeId, reason) => {
          await nodeRepo.setStatus(nodeId, "quarantined", ["active", "pending", "cooldown"]);
          registry.get(nodeId)?.tunnel.close(`probe: ${reason}`);
        },
        logger: jobLog,
      },
    }));
  } else {
    jobLog.warn("PROBE_URL not set: canary probes disabled");
  }
  if (payoutRepo.payoutsEnabled()) {
    const capUsd = envInt(process.env, "PAYOUT_RUN_CAP_USD", 10_000, 1, 1_000_000);
    jobs.push(payoutsJob.start({
      pool, logger: jobLog, intervalMs: envInt(process.env, "PAYOUT_JOB_INTERVAL_MS", 86_400_000, 3_600_000, 7 * 86_400_000),
      deps: {
        enabled: payoutRepo.payoutsEnabled,
        loadSdn: () => loadSdnFile(process.env["PAYOUT_SDN_FILE"]),
        listAutoCandidates: () => payoutRepo.listAutoPayoutCandidates(),
        requestWithdraw: payoutRepo.requestWithdraw,
        listDue: () => payoutRepo.listDuePayouts(),
        listSubmitted: () => payoutRepo.listSubmittedPayouts(),
        claim: payoutRepo.claimPayoutForSend,
        recordTx: payoutRepo.recordPayoutTx,
        releaseUnbroadcast: payoutRepo.releaseUnbroadcastPayout,
        markConfirmed: payoutRepo.markPayoutConfirmed,
        markFailed: payoutRepo.markPayoutFailed,
        markReversed: payoutRepo.markPayoutReversed,
        blockWallet: payoutRepo.blockWalletForSanctions,
        sender: createEthersPayoutSender(process.env),
        runCapMusd: BigInt(capUsd) * 1_000_000n,
        logger: jobLog,
      },
    }));
  } else {
    jobLog.info("PAYOUTS_ENABLED is not true: payout job not started");
  }
  return jobs;
}

main().catch((err) => {
  log.error("failed to start proxy", { error: err instanceof Error ? err.message : String(err) });
  process.exit(1);
});
