import type { ProxyOptions, UpstreamProxy } from "./webshare.js";
import type { ProxyProvider, ProviderStats } from "./provider.js";
import { WebshareDCProvider, WebshareResidentialProvider } from "./webshare-provider.js";
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
    const type = options?.proxyType; // "dc" | "residential" | "auto" | undefined

    // Filter by proxyType preference if specified
    let candidates = this.providers.filter((p) => p.isAvailable());
    if (type === "dc") {
      candidates = candidates.filter((p) => p.name === "webshare-dc");
    } else if (type === "residential") {
      candidates = candidates.filter((p) => p.name === "webshare-residential");
    }

    // 1. Try primary providers first (fallbackOnly=false), then fallbacks
    const primaries = candidates.filter((p) => !p.fallbackOnly);
    if (primaries.length > 0) {
      const provider = primaries[0];
      return { provider, proxy: provider.getProxy(options) };
    }

    // 2. Primary down — try fallback providers in priority order
    const fallbacks = candidates.filter((p) => p.fallbackOnly);
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

  // Add Webshare DC as primary (priority 1)
  // Two modes:
  //   "gateway" — rotating DC via p.webshare.io (needs WEBSHARE_DC_USERNAME/PASSWORD)
  //   "static"  — static proxy list via API (needs WEBSHARE_API_KEY, no DC credentials)
  const dcUser = process.env["WEBSHARE_DC_USERNAME"] ?? "";
  const dcPass = process.env["WEBSHARE_DC_PASSWORD"] ?? "";
  const apiKey = process.env["WEBSHARE_API_KEY"] ?? "";
  const hasGatewayDC = !!(dcUser && dcPass);
  const hasStaticDC = !hasGatewayDC && !!apiKey;

  if (hasGatewayDC) {
    providers.push(new WebshareDCProvider("gateway"));
  } else if (hasStaticDC) {
    providers.push(new WebshareDCProvider("static"));
  }

  // Add Webshare Residential as secondary (priority 2)
  const resUser = process.env["WEBSHARE_RES_USERNAME"] ?? "";
  const resPass = process.env["WEBSHARE_RES_PASSWORD"] ?? "";
  if (resUser && resPass) {
    providers.push(new WebshareResidentialProvider());
  }

  // Parse FALLBACK_PROXY_* env vars (supports gaps, e.g. _1_ and _3_ without _2_)
  for (let i = 1; i <= 10; i++) {
    const host = process.env[`FALLBACK_PROXY_${i}_HOST`];
    if (!host) continue;
    // H-1: Validate fallback host — block SSRF via config injection (parity with WEBSHARE_PROXY_HOST)
    if (/[\s\/\\@]/.test(host)) {
      throw new Error(`FALLBACK_PROXY_${i}_HOST must be a plain hostname`);
    }
    const lowerFbHost = host.toLowerCase();
    if (lowerFbHost === "localhost" || lowerFbHost === "127.0.0.1" || lowerFbHost === "0.0.0.0" ||
        lowerFbHost.endsWith(".internal") || lowerFbHost.endsWith(".local") || lowerFbHost.endsWith(".localhost")) {
      throw new Error(`FALLBACK_PROXY_${i}_HOST must not be a private/internal hostname`);
    }
    const fbIpParts = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
    if (fbIpParts) {
      const a = parseInt(fbIpParts[1], 10);
      const b = parseInt(fbIpParts[2], 10);
      if (a === 127 || a === 10 || a === 0 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 169 && b === 254)) {
        throw new Error(`FALLBACK_PROXY_${i}_HOST must not be a private/loopback IP`);
      }
    }
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
