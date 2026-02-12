import { buildUpstreamProxy } from "./packetstream.js";
import type { ProxyOptions, UpstreamProxy } from "./packetstream.js";
import { PerProviderCircuitBreaker } from "./provider.js";
import type { ProxyProvider, ProviderStats } from "./provider.js";

export class PacketStreamProvider implements ProxyProvider {
  readonly name = "packetstream";
  readonly priority = 1;
  readonly fallbackOnly = false;
  private readonly cb = new PerProviderCircuitBreaker();

  isAvailable(): boolean {
    return this.cb.isAvailable();
  }

  getProxy(options?: ProxyOptions): UpstreamProxy {
    try {
      return buildUpstreamProxy(options);
    } catch (err) {
      // If country-specific request fails due to sanctions, rethrow
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes("sanctioned")) {
        throw err;
      }
      // For other errors (e.g., missing config), try without country as geo fallback
      if (options?.country) {
        return buildUpstreamProxy({ ...options, country: undefined });
      }
      throw err;
    }
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
