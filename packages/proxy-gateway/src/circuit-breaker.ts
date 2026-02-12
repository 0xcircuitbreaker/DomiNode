/**
 * @deprecated Use per-provider circuit breakers via ProviderSelector instead.
 * This global circuit breaker is kept for backward compatibility with tests
 * but is no longer used by server.ts or socks5.ts.
 */

import { createLogger } from "@dominode/shared";

const log = createLogger("proxy:circuit-breaker");

export type CircuitState = "closed" | "open" | "half-open";

export interface CircuitBreakerStats {
  state: CircuitState;
  failures: number;
  lastFailure: Date | null;
  lastSuccess: Date | null;
}

const FAILURE_THRESHOLD = parseInt(process.env["CIRCUIT_BREAKER_FAILURE_THRESHOLD"] ?? "5", 10);
const COOLDOWN_MS = parseInt(process.env["CIRCUIT_BREAKER_COOLDOWN_MS"] ?? "30000", 10);

let state: CircuitState = "closed";
let consecutiveFailures = 0;
let lastFailure: Date | null = null;
let lastSuccess: Date | null = null;
let openedAt: number = 0;

export function recordSuccess(): void {
  if (state === "half-open") {
    log.info("circuit breaker closed after successful probe");
  }
  state = "closed";
  consecutiveFailures = 0;
  lastSuccess = new Date();
}

export function recordFailure(): void {
  consecutiveFailures++;
  lastFailure = new Date();

  if (state === "half-open") {
    state = "open";
    openedAt = Date.now();
    log.warn("circuit breaker re-opened after failed probe", { consecutiveFailures });
    return;
  }

  if (state === "closed" && consecutiveFailures >= FAILURE_THRESHOLD) {
    state = "open";
    openedAt = Date.now();
    log.warn("circuit breaker tripped", { consecutiveFailures, threshold: FAILURE_THRESHOLD });
  }
}

/** Shared transition: if OPEN and cooldown has elapsed, move to HALF-OPEN. */
function transitionIfCooledDown(): void {
  if (state === "open" && Date.now() - openedAt >= COOLDOWN_MS) {
    state = "half-open";
    log.info("circuit breaker entering half-open state");
  }
}

export function isOpen(): boolean {
  transitionIfCooledDown();
  return state === "open";
}

export function getState(): CircuitState {
  transitionIfCooledDown();
  return state;
}

export function getStats(): CircuitBreakerStats {
  return {
    state: getState(),
    failures: consecutiveFailures,
    lastFailure,
    lastSuccess,
  };
}

/** Reset for testing */
export function _reset(): void {
  state = "closed";
  consecutiveFailures = 0;
  lastFailure = null;
  lastSuccess = null;
  openedAt = 0;
}
