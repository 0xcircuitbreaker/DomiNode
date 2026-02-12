import type { UpstreamProxy, ProxyOptions } from "./packetstream.js";
import { PerProviderCircuitBreaker } from "./provider.js";
import type { ProxyProvider, ProviderStats } from "./provider.js";

export interface DirectProviderConfig {
  host: string;
  port: number;
  username?: string;
  password?: string;
  name?: string;
}

export class DirectProvider implements ProxyProvider {
  readonly name: string;
  readonly priority = 10;
  readonly fallbackOnly = true;
  private readonly cb = new PerProviderCircuitBreaker();
  private readonly config: DirectProviderConfig;

  constructor(config: DirectProviderConfig) {
    this.config = config;
    this.name = config.name ?? `direct-${config.host}`;
  }

  isAvailable(): boolean {
    return this.cb.isAvailable();
  }

  getProxy(_options?: ProxyOptions): UpstreamProxy {
    const username = this.config.username ?? "";
    const password = this.config.password ?? "";
    const proxyAuth = (username || password)
      ? Buffer.from(`${username}:${password}`).toString("base64")
      : "";

    const proxy: UpstreamProxy = {
      host: this.config.host,
      port: this.config.port,
      username,
      password,
      proxyAuth,
    };

    // Make sensitive fields non-enumerable
    Object.defineProperties(proxy, {
      password: { enumerable: false },
      proxyAuth: { enumerable: false },
    });

    return proxy;
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
