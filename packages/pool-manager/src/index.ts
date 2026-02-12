export {
  buildUpstreamProxy,
  generateStickySession,
  addBalance,
  getUserInfo,
  getConfig,
  validateConfig,
} from "./packetstream.js";

export type {
  PacketStreamConfig,
  ProxyOptions,
  UpstreamProxy,
} from "./packetstream.js";

export type {
  ProxyProvider,
  ProviderStats,
  CircuitState,
} from "./provider.js";
export { PerProviderCircuitBreaker } from "./provider.js";

export { PacketStreamProvider } from "./packetstream-provider.js";

export { DirectProvider } from "./direct-provider.js";
export type { DirectProviderConfig } from "./direct-provider.js";

export {
  ProviderSelector,
  createProviderSelector,
} from "./provider-selector.js";
export type { SelectedProxy } from "./provider-selector.js";
