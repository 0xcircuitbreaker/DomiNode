import type * as net from "node:net";
import dotenv from "dotenv";
dotenv.config();

import { createLogger, closePool, getPool, usageRepo, agenticWalletRepo, connectWithRetry, nodeRepo, policyRepo, nodeCreditRepo, retentionRepo, tierRepo, payoutRepo, relayChargeRepo, relaySettleRetryRepo, reportReputationRepo, collusionRepo, starterCreditRepo, contributionRepo, genesisRepo, networkStatusRepo, getProxyPorts, assertDistinctProxyPorts, reportTlsCapability, apiKeyPepper } from "@dominusnode/shared";
import type { ActivePolicy } from "@dominusnode/shared";
import { startProxyServer } from "./server.js";
import { geoAvailable, initGeoCheck, lookupPeerGeo, classifyEgressIp } from "./geo-check.js";
import { makeEgressVerifier } from "./egress-class.js";
import { installSharedLimits, makeInstanceId } from "./shared-limits.js";
import { PerKeyLogLimiter } from "./log-limiter.js";

const mismatchLogLimiter = new PerKeyLogLimiter(60_000, 10_000);
import { NodeRegistry, type LiveNode } from "./node-tunnel/registry.js";
import { NodeSelector, etld1 } from "./node-tunnel/selector.js";
import { loadCoordSigner } from "./node-tunnel/coord-key.js";
import { NodeTunnelServer } from "./node-tunnel/server.js";
import { checkGatewayEnv } from "./env-check.js";
import { startSocks5Server } from "./socks5.js";
import { loadProxyTls, parseRequireTls, createPlaintextAuthGuard, watchProxyTlsCert, type ReloadableTlsServer } from "./proxy-tls.js";
import { envInt, setJobRunRecorder, JOB_RUN_UPSERT_SQL, type Job, type JobLogger, type LockPool } from "./jobs/runner.js";
import * as nodeStatusJob from "./jobs/node-status.js";
import * as userStatusJob from "./jobs/user-status.js";
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
import * as launchJobs from "./jobs/launch.js";
import { configureAccessGate } from "./access-gate.js";
import { getLatencyPercentiles } from "./stats.js";
import { drainUnmetDemand, restoreUnmetDemand } from "./unmet-demand.js";
import { parseTrustedProxyIps, loadTunnelTls } from "./node-tunnel/ingress.js";
import { createEthersPayoutSender } from "./jobs/payout-sender-ethers.js";
import { getActiveSessionCount, terminateUserSessions, terminateNodeSessionsAbove, getActiveSessions, awaitInFlightSettlements, getInFlightSettlementCount, configureSessionRecovery, heartbeatActiveSessions, recoverOrphanedSessions, configureSettledHook } from "./session-manager.js";

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

// Fail fast with every problem listed: required env, port parse and clashes.
{
  const envErrors = checkGatewayEnv(process.env);
  if (envErrors.length > 0) {
    for (const e of envErrors) log.error(`startup validation failed: ${e}`);
    throw new Error(`Environment validation failed: ${envErrors.join("; ")}`);
  }
}
// All five listener ports come from one reader (validated above).
const ports = getProxyPorts(process.env);
assertDistinctProxyPorts(ports);
const httpPort = ports.http;
const socks5Port = ports.socks5;

function toProbeNode(registry: NodeRegistry, n: LiveNode): probesJob.ProbeNode {
  return {
    nodeId: n.nodeId, ip: n.ip, unverified: n.egressVerifiedAt === undefined,
    isPending: () => registry.get(n.nodeId) === n && n.probePending === true && n.tunnel.isOpen,
    openStream: (h, p) => n.tunnel.openStream(h, p),
  };
}

/** PROBE_URL targets, or none when PROBES_DISABLED=true (the explicit opt-out wins). */
function probeTargetsFromEnv(): probesJob.ProbeTarget[] {
  if (process.env["PROBES_DISABLED"] === "true") return [];
  return probesJob.parseProbeUrls(process.env["PROBE_URL"]);
}

/** Echo-target self-check state, shared by the connect queue and the periodic job. */
let probeHealth: probesJob.ProbeHealth | null = null;

/**
 * Release every pending node: the probe setup is broken on our side, so nodes
 * serve at their connect class (peer IP + carried verdicts) as with probes off.
 */
function releasePending(registry: NodeRegistry): number {
  let n = 0;
  for (const live of registry.all()) {
    if (live.probePending !== true) continue;
    live.probePending = false;
    live.ipClass = live.connectClass ?? live.ipClass;
    n++;
  }
  return n;
}

/** Probe deps shared by the periodic job and the per-connect queue. */
function makeProbeDeps(registry: NodeRegistry, targets: probesJob.ProbeTarget[], logger: JobLogger): Omit<probesJob.ProbeDeps, "listNodes"> {
  return {
    targets,
    timeoutMs: envInt(process.env, "PROBE_TIMEOUT_MS", 10_000, 1000, 60_000),
    onEgress: makeEgressVerifier({
      getNode: (id) => registry.get(id),
      classify: classifyEgressIp,
      record: nodeRepo.recordVerifiedClass,
      onDowngrade: (nodeId, _from, to) => terminateNodeSessionsAbove(nodeId, to),
      logger,
    }),
    quarantine: async (nodeId, reason) => {
      await nodeRepo.setStatus(nodeId, "quarantined", ["active", "pending", "cooldown"]);
      registry.get(nodeId)?.tunnel.close(`probe: ${reason}`);
    },
    logger,
  };
}

async function main(): Promise<void> {
  // Ensure database is reachable before accepting connections
  await connectWithRetry();

  // ─── Policy snapshot (reloaded every 30 s, pushed to tunnels) ─────
  let policy: ActivePolicy = await policyRepo.getActivePolicy();
  const getPolicy = (): ActivePolicy => policy;

  // ─── Node tunnel server + registry + selector ────────────────────
  await initGeoCheck();
  const isProduction = process.env["NODE_ENV"] === "production";
  reportTlsCapability(log, "proxy-gateway");
  // Load API_KEY_PEPPER_FILE now so a bad file fails startup, not the first auth.
  log.info("API key hashing", { peppered: apiKeyPepper() !== null });
  const asnDbOptional = process.env["ASN_DB_OPTIONAL"] === "true";
  if (!geoAvailable()) log.warn("geo database unavailable: public peers and destinations are refused", { asnRequired: isProduction && !asnDbOptional });
  const shared = installSharedLimits(log);
  const registry = new NodeRegistry();
  registry.startSweep();
  const selector = new NodeSelector(registry, { getPolicy: () => policy.body });
  const coordSigner = loadCoordSigner(process.env);
  if (coordSigner) log.info("coordinator signing key loaded", { publicKey: coordSigner.publicKeyHex });
  else log.warn("COORD_SIGNING_KEY_FILE not set: CHALLENGE frames are unsigned (non-production only)");
  // Egress probes: with PROBE_URL set, every connect is queued for its own
  // verification probe and stays "unknown" for class-* selection until then.
  const probeTargets = probeTargetsFromEnv();
  if (process.env["PROBES_DISABLED"] === "true" && process.env["PROBE_URL"]) log.warn("PROBES_DISABLED=true: ignoring PROBE_URL");
  if (probeTargets.length > 0) {
    // Self-check the echo targets from the gateway itself. While none passes
    // (TLS not publicly trusted, no API on that host, API still starting),
    // nodes are not held pending and no probe runs, so a broken setup can
    // neither stop all traffic nor quarantine the fleet as "tamper".
    const health = new probesJob.ProbeHealth(probeTargets, (t) => probesJob.selfCheckTarget(t, envInt(process.env, "PROBE_TIMEOUT_MS", 10_000, 1000, 60_000)));
    probeHealth = health;
    let wasHealthy = false;
    const refresh = async (): Promise<void> => {
      const failed = await health.refresh();
      if (failed.length > 0) log.error("probe echo self-check failed", { failed, healthyTargets: health.live.length });
      if (!health.healthy) {
        const released = releasePending(registry);
        if (wasHealthy || released > 0) log.error("probes paused: no echo target passes the self-check; nodes serve at their connect class", { released });
      } else if (!wasHealthy) log.info("probe echo self-check passed", { targets: health.live.length });
      wasHealthy = health.healthy;
    };
    await refresh().catch(() => undefined);
    const t = setInterval(() => { void refresh().catch(() => undefined); }, envInt(process.env, "PROBE_SELFCHECK_INTERVAL_MS", 60_000, 10_000, 3_600_000));
    t.unref();
  }
  const connectProbes = probeTargets.length > 0
    ? new probesJob.ConnectProbeQueue(
      { ...makeProbeDeps(registry, probeHealth?.live ?? probeTargets, log), isHealthy: () => probeHealth?.healthy ?? true, listNodes: () => [] },
      {
        concurrency: envInt(process.env, "PROBE_CONNECT_CONCURRENCY", 4, 1, 64),
        minIntervalMs: envInt(process.env, "PROBE_CONNECT_MIN_INTERVAL_MS", 60_000, 0, 3_600_000),
      },
    )
    : null;
  const tunnelServer = new NodeTunnelServer(registry, {
    coordSign: coordSigner?.sign,
    getNodeForTunnelAuth: nodeRepo.getNodeForTunnelAuth,
    markOnline: nodeRepo.markOnline,
    ownerPrefixProbeClasses: nodeRepo.getOwnerPrefixProbeClasses,
    markOffline: nodeRepo.markOffline,
    claimIpSlot: shared.claimIpSlot,
    releaseIpSlot: shared.releaseIpSlot,
    activatePending: async (nodeId) => (await nodeRepo.setStatus(nodeId, "active", ["pending"])) !== null,
    getPolicy,
    geoLookup: lookupPeerGeo,
    recordVerifiedClass: nodeRepo.recordVerifiedClass,
    onNodeReady: (live) => {
      if (connectProbes && live.status === "active") connectProbes.enqueue(toProbeNode(registry, live));
    },
    onStreamClose: (nodeId, r) => {
      // Nodes are untrusted and control their own report: warn only on a
      // real dispute (isByteDispute) and at most once per node per minute.
      if (!r.nodeReport) return;
      const gw = BigInt(r.gatewayBytesIn + r.gatewayBytesOut);
      const nd = BigInt(r.nodeReport.bytesIn + r.nodeReport.bytesOut);
      if (relayChargeRepo.isByteDispute(gw, nd) && mismatchLogLimiter.allow(nodeId, Date.now())) {
        log.warn("node byte report mismatch", { nodeId, gatewayOut: r.gatewayBytesOut, gatewayIn: r.gatewayBytesIn, nodeIn: r.nodeReport.bytesIn, nodeOut: r.nodeReport.bytesOut });
      }
    },
  }, {
    port: ports.tunnel,
    logger: log,
    trustedProxyIps: parseTrustedProxyIps(process.env["TUNNEL_TRUSTED_PROXY_IPS"]),
    tls: loadTunnelTls(process.env),
    production: isProduction,
    requireAsn: isProduction && !asnDbOptional,
    // Hold new connects pending only while the echo self-check passes.
    deferClassUntilProbe: connectProbes !== null ? () => probeHealth?.healthy === true : false,
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

  const relay = {
    selector, getPolicy: () => policy.body, nodeCount: () => registry.size,
    onNodeFailure: (nodeId: string) => registry.recordFailure(nodeId),
  };

  // Reputation, per-node daily stats and today's earnings come from settled
  // paid sessions (gateway-measured bytes), byte disputes and dial failures.
  configureSettledHook((e) => {
    registry.recordPaidBytes(e.nodeId, e.requesterUserId, e.bytes, e.destHost ? etld1(e.destHost.replace(/^\[|\]$/g, "")) : undefined);
    if (e.disputed) registry.recordDispute(e.nodeId);
    const live = registry.get(e.nodeId);
    if (live && e.nodeMusd > 0n) live.earningsTodayMusd += Number(e.nodeMusd);
  });

  // Crash/restart recovery: sessions carry a settle payload and a heartbeat
  // owned by this instance. Sessions of instances that stopped heartbeating
  // (including a previous run of this process) are settled with their last
  // flushed bytes and the rest of the reservation is refunded. Sessions of
  // live instances and of the settle-retry queue are left alone.
  configureSessionRecovery(shared.instanceId);
  const SESSION_STALE_SECONDS = 120;
  const runRecovery = async (): Promise<void> => {
    try {
      const r = await recoverOrphanedSessions(SESSION_STALE_SECONDS);
      if (r.settled > 0 || r.failed > 0 || r.legacyClosed) log.info("recovered orphaned sessions", r);
      // Return agentic-wallet reservations of sessions that ended without settling.
      const c = await agenticWalletRepo.releaseOrphanedSessionReservations();
      if (c > 0) log.info("released orphaned agentic reservations", { cents: c });
    } catch (err) {
      log.warn("orphaned session recovery failed", { error: err instanceof Error ? err.message.slice(0, 100) : "unknown" });
    }
  };
  await runRecovery();
  const sessionHeartbeat = setInterval(() => {
    heartbeatActiveSessions().catch((err) => log.warn("session heartbeat failed", { error: err instanceof Error ? err.message.slice(0, 100) : "unknown" }));
  }, 15_000);
  sessionHeartbeat.unref();
  const recoveryInterval = setInterval(() => { void runRecovery(); }, 60_000);
  recoveryInterval.unref();

  // ─── Background jobs (DESIGN.md §6.4, §15) ─────────────────────────
  const jobs = startJobs(registry, getPolicy);

  // Requester access: contribution requirement + starter-credit seed-only routing
  configureAccessGate({ isSeedOnly: (u) => starterCreditRepo.isSeedOnlyRequester(u), hasContribution: contributionRepo.hasContribution });

  // TLS proxy listener (DESIGN.md §15): Proxy-Authorization over TLS.
  const proxyTls = loadProxyTls(process.env);
  const requireTls = parseRequireTls(process.env, isProduction);
  if (requireTls && !proxyTls) {
    throw new Error(process.env["PROXY_REQUIRE_TLS"] === "true"
      ? "PROXY_REQUIRE_TLS=true requires PROXY_TLS_PORT"
      : "production refuses proxy credentials on plaintext 8080/1080 by default: set PROXY_TLS_PORT (+ PROXY_TLS_CERT_FILE/PROXY_TLS_KEY_FILE), or PROXY_REQUIRE_TLS=false to accept plaintext credentials explicitly");
  }
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
  // Certificate renewals (e.g. Caddy-issued certs synced by the self-host
  // proxy-certs sidecar) are picked up in place; no restart needed.
  const certWatch = proxyTls
    ? watchProxyTlsCert({
      certFile: proxyTls.certFile, keyFile: proxyTls.keyFile, initial: proxyTls,
      servers: tlsServers as unknown as ReloadableTlsServer[],
      log, intervalMs: 60_000,
    })
    : null;

  // Graceful shutdown
  async function shutdown(signal: string): Promise<void> {
    log.info(`received ${signal}, shutting down...`);

    httpServer.close();
    socks5Server.close();
    for (const s of tlsServers) s.close();
    certWatch?.stop();
    clearInterval(policyInterval);
    clearInterval(recoveryInterval);
    connectProbes?.stop();
    await Promise.all(jobs.map((j) => j.stop().catch(() => {})));

    // Wait for active sessions to finish. Keep this well under the container
    // stop timeout (compose stop_grace_period: 60s); sessions still open when
    // the process dies are settled by the next instance's recovery pass.
    const DRAIN_TIMEOUT_MS = 20_000;
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

    clearInterval(sessionHeartbeat);
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
  // Suspend/erase on a coordinator elsewhere (split self-host, several
  // gateways) reaches this instance through users.status in the DB.
  jobs.push(userStatusJob.start({
    logger: jobLog, intervalMs: envInt(process.env, "USER_STATUS_SWEEP_INTERVAL_MS", 30_000, 5_000, 3_600_000),
    deps: {
      liveUserIds: () => getActiveSessions().map((s) => s.userId),
      fetchStatuses: async (ids) => {
        const r = await getPool().query<{ id: string; status: string }>(
          "SELECT id, status FROM users WHERE id = ANY($1::uuid[])", [ids]);
        return new Map(r.rows.map((x) => [x.id, x.status]));
      },
      terminate: (uid) => terminateUserSessions(uid),
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
      onDead: async (id, bytes) => {
        await usageRepo.endSession(id, bytes, "error");
        // The retry row is 'dead' by now: hand any agentic reservation back.
        await agenticWalletRepo.releaseOrphanedSessionReservations().catch(() => 0);
      },
      logger: jobLog,
    },
  }));
  jobs.push(retentionJob.start({
    pool, logger: jobLog, intervalMs: envInt(process.env, "RETENTION_JOB_INTERVAL_MS", 3_600_000, 60_000, 86_400_000),
    deps: { getRetentionDays: () => getPolicy().body.logRetentionDays, purgeBatch: retentionRepo.purgeRelayAbuseLogBatch,
      scrubAccessAuditBatch: retentionRepo.scrubAbuseLogAccessAuditBatch },
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
  jobs.push(launchJobs.startStarterExpiry({
    pool, logger: jobLog, intervalMs: envInt(process.env, "STARTER_EXPIRY_JOB_INTERVAL_MS", 3_600_000, 60_000, 86_400_000),
    deps: { expireDue: starterCreditRepo.expireDue },
  }));
  jobs.push(launchJobs.startNetworkSnapshot({
    pool, logger: jobLog, intervalMs: envInt(process.env, "NETWORK_SNAPSHOT_INTERVAL_MS", 3_600_000, 60_000, 86_400_000),
    deps: {
      latency: getLatencyPercentiles,
      takeSnapshot: networkStatusRepo.takeSnapshot,
      purgeSnapshots: networkStatusRepo.purgeSnapshots,
      purgeUnmetDemand: networkStatusRepo.purgeUnmetDemand,
      snapshotRetentionDays: envInt(process.env, "NETWORK_SNAPSHOT_RETENTION_DAYS", 400, 7, 3650),
      unmetRetentionDays: envInt(process.env, "UNMET_DEMAND_RETENTION_DAYS", 90, 7, 3650),
    },
  }));
  jobs.push(launchJobs.startUnmetFlush({
    logger: jobLog, intervalMs: envInt(process.env, "UNMET_DEMAND_FLUSH_INTERVAL_MS", 60_000, 5_000, 3_600_000),
    deps: { drain: drainUnmetDemand, restore: restoreUnmetDemand, write: networkStatusRepo.addUnmetDemand },
  }));
  jobs.push(launchJobs.startGenesis({
    pool, logger: jobLog, intervalMs: envInt(process.env, "GENESIS_JOB_INTERVAL_MS", 3_600_000, 60_000, 86_400_000),
    deps: {
      enrol: genesisRepo.enrol, listCreditCandidates: genesisRepo.listCreditCandidates,
      grantCredit: genesisRepo.grantCredit, matureCredits: genesisRepo.matureCredits,
    },
  }));
  const probeTargets = probeTargetsFromEnv();
  if (probeTargets.length > 0) {
    const probeIntervalMs = envInt(process.env, "PROBE_INTERVAL_MS", 900_000, 60_000, 86_400_000);
    jobs.push(probesJob.start({
      logger: jobLog, intervalMs: probeIntervalMs,
      // Random start offset per run (up to half the interval) so probe timing is unpredictable.
      jitterMs: Math.floor(probeIntervalMs / 2),
      deps: {
        ...makeProbeDeps(registry, probeHealth?.live ?? probeTargets, jobLog),
        isHealthy: () => probeHealth?.healthy ?? true,
        sampleSize: envInt(process.env, "PROBE_SAMPLE_SIZE", 20, 1, 1000),
        listNodes: () => [...registry.all()]
          .filter((n) => n.ready && n.status === "active" && n.tunnel.isOpen)
          .map((n) => toProbeNode(registry, n)),
      },
    }));
  } else {
    if (process.env["PROBES_DISABLED"] === "true") {
      jobLog.warn("PROBES_DISABLED=true: canary + egress probes disabled");
    } else if (process.env["NODE_ENV"] === "production") {
      // Loud, not fatal: existing deployments keep starting; set PROBE_URL
      // (or PROBES_DISABLED=true to acknowledge) to clear it.
      jobLog.error("PROBE_URL not set in production: canary + egress probes DISABLED (no tamper detection, peer-IP-only class). Set PROBE_URL or PROBES_DISABLED=true");
    } else {
      jobLog.warn("PROBE_URL not set: canary probes disabled");
    }
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
