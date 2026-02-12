import type { ProxyOptions, UpstreamProxy } from "./packetstream.js";
import type { ProxyProvider, ProviderStats } from "./provider.js";
import { PacketStreamProvider } from "./packetstream-provider.js";
import { DirectProvider } from "./direct-provider.js";

export interface SelectedProxy {
  provider: ProxyProvider;
  proxy: UpstreamProxy;
}

export class ProviderSelector {
  private readonly providers: ProxyProvider[];

  constructor(providers: ProxyProvider[]) {
    // Sort by priority (lower = preferred)
    this.providers = [...providers].sort((a, b) => a.priority - b.priority);
  }

  select(options?: ProxyOptions): SelectedProxy {
    // 1. Try primary providers first (fallbackOnly=false), then fallbacks
    const primaries = this.providers.filter((p) => !p.fallbackOnly && p.isAvailable());
    if (primaries.length > 0) {
      const provider = primaries[0];
      return { provider, proxy: provider.getProxy(options) };
    }

    // 2. Primary down — try fallback providers in priority order
    const fallbacks = this.providers.filter((p) => p.fallbackOnly && p.isAvailable());
    if (fallbacks.length > 0) {
      const provider = fallbacks[0];
      return { provider, proxy: provider.getProxy(options) };
    }

    // 3. All down
    throw new Error("All proxy providers are unavailable");
  }

  recordSuccess(providerName: string, latencyMs?: number): void {
    const provider = this.providers.find((p) => p.name === providerName);
    provider?.recordSuccess(latencyMs);
  }

  recordFailure(providerName: string): void {
    const provider = this.providers.find((p) => p.name === providerName);
    provider?.recordFailure();
  }

  getStats(): ProviderStats[] {
    return this.providers.map((p) => p.getStats());
  }

  getProviderCount(): number {
    return this.providers.length;
  }
}

export function createProviderSelector(): ProviderSelector {
  const providers: ProxyProvider[] = [];

  // Always add PacketStream as primary
  providers.push(new PacketStreamProvider());

  // Parse FALLBACK_PROXY_* env vars (supports gaps, e.g. _1_ and _3_ without _2_)
  for (let i = 1; i <= 10; i++) {
    const host = process.env[`FALLBACK_PROXY_${i}_HOST`];
    if (!host) continue;
    const port = parseInt(process.env[`FALLBACK_PROXY_${i}_PORT`] ?? "8080", 10);
    if (isNaN(port) || port <= 0 || port > 65535) {
      throw new Error(`Invalid FALLBACK_PROXY_${i}_PORT: must be 1-65535`);
    }
    const username = process.env[`FALLBACK_PROXY_${i}_USER`];
    const password = process.env[`FALLBACK_PROXY_${i}_PASS`];
    providers.push(
      new DirectProvider({
        host,
        port,
        username,
        password,
        name: `fallback-${i}`,
      }),
    );
  }

  return new ProviderSelector(providers);
}
