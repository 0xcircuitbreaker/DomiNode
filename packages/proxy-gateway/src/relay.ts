/**
 * Relay upstream: select a live node and open a mux stream through its
 * tunnel (DESIGN.md §4, §8). Replaces the pool-manager ProviderSelector.
 */
import type { Duplex } from "node:stream";
import { createLogger, type KillSwitchView, type NetworkPolicy } from "@dominusnode/shared";
import { NodeSelectionError, type NodeSelector, type SelectOpts } from "./node-tunnel/selector.js";
import { TunnelOpenError, mapOpenError } from "./node-tunnel/mux.js";
import type { LiveNode } from "./node-tunnel/registry.js";
import { withNodeRetry } from "./retry.js";
import { recordUnmetDemand } from "./unmet-demand.js";

const log = createLogger("proxy:relay");

export interface RelayRuntime {
  selector: NodeSelector;
  getPolicy: () => NetworkPolicy;
  /** Live node count, for /internal/stats. */
  nodeCount?: () => number;
  /**
   * Open failure attributable to the node (DIAL_FAIL/DNS_FAIL/TIMEOUT): lowers its
   * reputation. Reported only once another node reached the same target in the
   * same open, so an unreachable target (chosen by the requester) penalises no one.
   */
  onNodeFailure?: (nodeId: string, code: string) => void;
  /**
   * Admin kill switches (ADMIN_API.md §17). main.ts always wires the polled,
   * fail-closed cache; absent only in unit tests.
   */
  killSwitches?: () => KillSwitchView;
}

const NODE_FAILURE_CODES: ReadonlySet<string> = new Set(["DIAL_FAIL", "DNS_FAIL", "TIMEOUT"]);

/** Failure opening a relay upstream, carrying the HTTP contract. */
export class RelayOpenError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly nodeId: string | null = null,
    readonly retryable = false,
  ) {
    super(message);
    this.name = "RelayOpenError";
  }
}

export interface RelayUpstream {
  node: LiveNode;
  stream: Duplex;
  latencyMs: number;
  retries: number;
}

function toRelayError(err: unknown, nodeId: string | null): RelayOpenError {
  if (err instanceof RelayOpenError) return err;
  if (err instanceof NodeSelectionError) return new RelayOpenError(err.status, err.code, err.message, null);
  if (err instanceof TunnelOpenError) {
    const m = err.mapping;
    return new RelayOpenError(m.status, m.code, `relay open failed: ${m.code}`, nodeId, m.retryable);
  }
  const m = mapOpenError("DIAL_FAIL");
  return new RelayOpenError(m.status, m.code, "relay open failed", nodeId, m.retryable);
}

/**
 * Attach a default 'error' listener the moment a relay stream exists. Callers
 * await DB work (startSession etc.) before wiring their own handlers; a node
 * RST or tunnel drop in that gap destroys the stream with an error, which
 * without a listener is an uncaught exception that takes the gateway down.
 * Callers detect the dead stream via `stream.destroyed` / 'close'.
 */
export function guardRelayStream(stream: Duplex, nodeId: string): void {
  stream.on("error", (err: NodeJS.ErrnoException) => {
    log.warn("relay stream error", { nodeId, code: err?.code ?? "UNKNOWN", error: (err?.message ?? "").slice(0, 120) });
  });
}

/**
 * Select a node and open a stream to host:port. DIAL_FAIL/DNS_FAIL retry once
 * on a different node; FLOOR_BLOCKED/PORT_BLOCKED surface as 403 with no retry.
 */
export async function openRelayStream(rt: RelayRuntime, opts: SelectOpts): Promise<RelayUpstream> {
  const start = Date.now();
  // Admin kill switches (ADMIN_API.md §17): checked before any node is chosen.
  const ks = rt.killSwitches?.();
  if (ks) {
    const block = ks.checkRelay(opts.ipClass);
    if (block) throw new RelayOpenError(block.status, block.code, block.message);
    const paused = ks.pausedClasses();
    const drained = ks.drainedNodeIds();
    if (paused.length > 0 || drained.length > 0) {
      opts = { ...opts, excludeIpClasses: paused, excludeNodeIds: [...(opts.excludeNodeIds ?? []), ...drained] };
    }
  }
  const failed: Array<{ nodeId: string; code: string }> = [];
  const r = await withNodeRetry<{ node: LiveNode; stream: Duplex }>(
    async (exclude) => {
      const node = (() => {
        try {
          return rt.selector.select({ ...opts, excludeNodeIds: [...(opts.excludeNodeIds ?? []), ...exclude] });
        } catch (err) {
          // Only a first-attempt miss is demand we could not serve (retries exclude nodes).
          if (err instanceof NodeSelectionError && err.kind === "unavailable" && exclude.length === 0) {
            recordUnmetDemand(opts.country, opts.ipClass);
          }
          throw toRelayError(err, null);
        }
      })();
      try {
        const stream = await node.tunnel.openStream(opts.targetHost, opts.port);
        guardRelayStream(stream, node.nodeId);
        return { nodeId: node.nodeId, value: { node, stream } };
      } catch (err) {
        const re = toRelayError(err, node.nodeId);
        if (err instanceof TunnelOpenError && NODE_FAILURE_CODES.has(err.code)) {
          failed.push({ nodeId: node.nodeId, code: err.code });
        }
        throw re;
      }
    },
    (err) => (err instanceof RelayOpenError ? err.nodeId : null),
    (err) => (err instanceof RelayOpenError ? err.code : null),
  );
  // The target is reachable (another node just opened it): earlier failures are the nodes' fault.
  if (rt.onNodeFailure) {
    for (const f of failed) {
      if (f.nodeId === r.value.node.nodeId) continue;
      try { rt.onNodeFailure(f.nodeId, f.code); } catch { /* never break the data path */ }
    }
  }
  return { node: r.value.node, stream: r.value.stream, latencyMs: Date.now() - start, retries: r.retries };
}
