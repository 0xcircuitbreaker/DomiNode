/**
 * Wires the PostgreSQL shared-limit store (relay-limits-repo) into the
 * gateway: node IP slot claims for the tunnel server, and the requester
 * spend/req-per-sec store for policy-enforcer. Each instance has a random
 * id; a heartbeat keeps its rows alive and sweeps those of dead instances.
 */
import { randomBytes } from "node:crypto";
import { hostname } from "node:os";
import { relayLimitsRepo } from "@dominusnode/shared";
import { setSharedLimitStore } from "./policy-enforcer.js";

export const HEARTBEAT_MS = 30_000;

export interface SharedLimits {
  instanceId: string;
  claimIpSlot: (s: Omit<relayLimitsRepo.SlotClaim, "instanceId">) => Promise<boolean>;
  releaseIpSlot: (nodeId: string) => Promise<void>;
  stop: () => Promise<void>;
}

export function makeInstanceId(): string {
  const host = hostname().replace(/[^A-Za-z0-9.-]/g, "").slice(0, 40) || "gw";
  return `${host}:${process.pid}:${randomBytes(4).toString("hex")}`.slice(0, 64);
}

export function installSharedLimits(
  log: { warn(msg: string, meta?: Record<string, unknown>): void },
  repo: typeof relayLimitsRepo = relayLimitsRepo,
  instanceId = makeInstanceId(),
): SharedLimits {
  const errMeta = (op: string, err: unknown) => ({ op, error: err instanceof Error ? err.message.slice(0, 100) : "unknown" });
  setSharedLimitStore({
    reserve: (i) => repo.reserveRequester({ ...i, instanceId }),
    settle: (userId, release, settled) => repo.settleRequester(userId, instanceId, release, settled),
  }, (op, err) => log.warn("shared limit store error", errMeta(op, err)));
  const hb = setInterval(() => {
    repo.heartbeat(instanceId).catch((err) => log.warn("shared limit heartbeat failed", errMeta("heartbeat", err)));
  }, HEARTBEAT_MS);
  hb.unref();
  return {
    instanceId,
    claimIpSlot: (s) => repo.claimNodeSlot({ ...s, instanceId }),
    releaseIpSlot: (nodeId) => repo.releaseNodeSlot(nodeId, instanceId),
    stop: async () => {
      clearInterval(hb);
      setSharedLimitStore(null);
      await repo.releaseInstance(instanceId).catch(() => undefined);
    },
  };
}
