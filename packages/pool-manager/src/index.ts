export {
  buildUpstreamProxy,
  generateStickySession,
  getConfig,
  validateConfig,
  getBandwidthUsage,
  fetchProxyList,
  StaticProxyPool,
} from "./webshare.js";

export type {
  WebshareConfig,
  WebsharePoolConfig,
  WebsharePool,
  ProxyOptions,
  UpstreamProxy,
  BandwidthUsage,
  StaticProxy,
} from "./webshare.js";

export type {
  ProxyProvider,
  ProviderStats,
  CircuitState,
} from "./provider.js";
export { PerProviderCircuitBreaker } from "./provider.js";

export { WebshareDCProvider, WebshareResidentialProvider } from "./webshare-provider.js";
export type { DCMode } from "./webshare-provider.js";

export { DirectProvider } from "./direct-provider.js";
export type { DirectProviderConfig } from "./direct-provider.js";

export {
  ProviderSelector,
  createProviderSelector,
} from "./provider-selector.js";
export type { SelectedProxy } from "./provider-selector.js";
