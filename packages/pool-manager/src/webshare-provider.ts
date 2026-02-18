import { buildUpstreamProxy, StaticProxyPool } from "./webshare.js";
import type { ProxyOptions, UpstreamProxy, WebsharePool } from "./webshare.js";
import { PerProviderCircuitBreaker } from "./provider.js";
import type { ProxyProvider, ProviderStats } from "./provider.js";

export type DCMode = "gateway" | "static";

export class WebshareDCProvider implements ProxyProvider {
  readonly name = "webshare-dc";
  readonly priority = 1;
  readonly fallbackOnly = false;
  private readonly cb = new PerProviderCircuitBreaker();
  private readonly mode: DCMode;
  private staticPool: StaticProxyPool | null = null;
  private staticReady = false;

  constructor(mode: DCMode = "gateway") {
    this.mode = mode;
    if (mode === "static") {
      this.staticPool = new StaticProxyPool();
      this.staticPool.init()
        .then(() => { this.staticReady = true; })
        .catch(() => {
          // Will retry on periodic refresh inside StaticProxyPool
          // Provider reports unavailable until list loads
        });
    }
  }

  isAvailable(): boolean {
    if (this.mode === "static") {
      return this.cb.isAvailable() && this.staticReady && (this.staticPool?.count ?? 0) > 0;
    }
    return this.cb.isAvailable();
  }

  getProxy(options?: ProxyOptions): UpstreamProxy {
    if (this.mode === "static") {
      if (!this.staticPool || !this.staticReady) {
        throw new Error("DC proxy pool not yet loaded");
      }
      return this.staticPool.getProxy(options);
    }

    // Gateway mode (rotating DC via p.webshare.io)
    // R28 WARNING-2 fix: Do NOT silently drop country filter on error.
    // Users requesting a specific country should get that country or an error.
    return buildUpstreamProxy("dc", options);
  }

  recordSuccess(latencyMs?: number): void {
    this.cb.recordSuccess(latencyMs);
  }

  recordFailure(): void {
    this.cb.recordFailure();
  }

  getStats(): ProviderStats {
    const stats: ProviderStats = {
      name: this.name,
      state: this.cb.getState(),
      consecutiveFailures: this.cb.getConsecutiveFailures(),
      totalRequests: this.cb.getTotalRequests(),
      totalErrors: this.cb.getTotalErrors(),
      avgLatencyMs: this.cb.getAvgLatencyMs(),
      fallbackOnly: this.fallbackOnly,
    };
    return stats;
  }

  /** Number of static proxies loaded (0 in gateway mode). */
  getStaticProxyCount(): number {
    return this.staticPool?.count ?? 0;
  }
}

export class WebshareResidentialProvider implements ProxyProvider {
  readonly name = "webshare-residential";
  readonly priority = 2;
  readonly fallbackOnly = false;
  private readonly cb = new PerProviderCircuitBreaker();

  isAvailable(): boolean {
    return this.cb.isAvailable();
  }

  getProxy(options?: ProxyOptions): UpstreamProxy {
    // R28 WARNING-2 fix: Do NOT silently drop country filter on error.
    // Users requesting a specific country should get that country or an error.
    return buildUpstreamProxy("residential", options);
  }

  recordSuccess(latencyMs?: number): void {
    this.cb.recordSuccess(latencyMs);
  }

  recordFailure(): void {
    this.cb.recordFailure();
  }

  getStats(): ProviderStats {
    return {
      name: this.name,
      state: this.cb.getState(),
      consecutiveFailures: this.cb.getConsecutiveFailures(),
      totalRequests: this.cb.getTotalRequests(),
      totalErrors: this.cb.getTotalErrors(),
      avgLatencyMs: this.cb.getAvgLatencyMs(),
      fallbackOnly: this.fallbackOnly,
    };
  }
}
