import type { ProxyOptions, UpstreamProxy } from "./packetstream.js";

export type CircuitState = "closed" | "open" | "half-open";

export interface ProviderStats {
  name: string;
  state: CircuitState;
  consecutiveFailures: number;
  totalRequests: number;
  totalErrors: number;
  avgLatencyMs: number;
  fallbackOnly: boolean;
}

export interface ProxyProvider {
  readonly name: string;
  readonly priority: number;
  readonly fallbackOnly: boolean;
  isAvailable(): boolean;
  getProxy(options?: ProxyOptions): UpstreamProxy;
  recordSuccess(latencyMs?: number): void;
  recordFailure(): void;
  getStats(): ProviderStats;
}

// ─── Per-provider circuit breaker ──────────────────────────────────

const DEFAULT_FAILURE_THRESHOLD = parseInt(
  process.env["CIRCUIT_BREAKER_FAILURE_THRESHOLD"] ?? "5",
  10,
);
const DEFAULT_COOLDOWN_MS = parseInt(
  process.env["CIRCUIT_BREAKER_COOLDOWN_MS"] ?? "30000",
  10,
);

export class PerProviderCircuitBreaker {
  private state: CircuitState = "closed";
  private consecutiveFailures = 0;
  private openedAt = 0;
  private totalRequests = 0;
  private totalErrors = 0;
  private latencies: number[] = [];
  private readonly latencyWindow = 100;

  constructor(
    private readonly failureThreshold = DEFAULT_FAILURE_THRESHOLD,
    private readonly cooldownMs = DEFAULT_COOLDOWN_MS,
  ) {}

  private transitionIfCooledDown(): void {
    if (this.state === "open" && Date.now() - this.openedAt >= this.cooldownMs) {
      this.state = "half-open";
    }
  }

  isAvailable(): boolean {
    this.transitionIfCooledDown();
    return this.state !== "open";
  }

  getState(): CircuitState {
    this.transitionIfCooledDown();
    return this.state;
  }

  recordSuccess(latencyMs?: number): void {
    this.totalRequests++;
    this.state = "closed";
    this.consecutiveFailures = 0;
    if (latencyMs !== undefined) {
      this.latencies.push(latencyMs);
      if (this.latencies.length > this.latencyWindow) {
        this.latencies.shift();
      }
    }
  }

  recordFailure(): void {
    this.totalRequests++;
    this.totalErrors++;
    this.consecutiveFailures++;

    if (this.state === "half-open") {
      this.state = "open";
      this.openedAt = Date.now();
      return;
    }

    if (this.state === "closed" && this.consecutiveFailures >= this.failureThreshold) {
      this.state = "open";
      this.openedAt = Date.now();
    }
  }

  getAvgLatencyMs(): number {
    if (this.latencies.length === 0) return 0;
    const sum = this.latencies.reduce((a, b) => a + b, 0);
    return Math.round(sum / this.latencies.length);
  }

  getConsecutiveFailures(): number {
    return this.consecutiveFailures;
  }

  getTotalRequests(): number {
    return this.totalRequests;
  }

  getTotalErrors(): number {
    return this.totalErrors;
  }

  /** Reset for testing */
  _reset(): void {
    this.state = "closed";
    this.consecutiveFailures = 0;
    this.openedAt = 0;
    this.totalRequests = 0;
    this.totalErrors = 0;
    this.latencies.length = 0;
  }
}
