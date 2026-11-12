#!/usr/bin/env node
/**
 * dominusnode-node CLI.
 *   dominusnode-node register --wallet-key-file <path>   (owner API key in DN_API_KEY env)
 *   dominusnode-node run
 * Secrets are never accepted as arguments.
 */
import { loadConfig, ConfigError, isDemoMode, type FlagMap } from "./config.js";
import { dial } from "./dialer.js";
import { Limits } from "./limits.js";
import { readNodeFile, registerNode } from "./register.js";
import { effectiveCoordPins } from "./coord-pins.js";
import { TunnelClient, scrub, stderrLogger } from "./tunnel-client.js";
import { startSelfDiscovery, type SelfDiscoveryOptions } from "./self-discovery.js";

export const AGENT_VERSION = "0.1.0";
const SECRET_FLAGS = new Set(["api-key", "key", "node-key", "wallet-key", "private-key", "password", "token"]);

export function parseFlags(argv: readonly string[]): FlagMap {
  const out: Record<string, string> = Object.create(null) as Record<string, string>;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith("--")) throw new ConfigError(`unexpected argument`);
    const eq = a.indexOf("=");
    const name = eq === -1 ? a.slice(2) : a.slice(2, eq);
    if (!/^[a-z][a-z-]{0,31}$/.test(name)) throw new ConfigError("invalid flag name");
    if (SECRET_FLAGS.has(name)) throw new ConfigError(`--${name} is not accepted; secrets must come from env or files`);
    const val = eq === -1 ? argv[++i] : a.slice(eq + 1);
    if (val === undefined) throw new ConfigError(`--${name} needs a value`);
    out[name] = val;
  }
  return out;
}

/**
 * Populate the floor's self-block set (interfaces, IPv6 prefixes, public IP, gateway) and keep
 * it fresh. Until the first pass succeeds the floor refuses every OPEN with FLOOR_BLOCKED.
 */
export function startFloorDiscovery(apiUrl: string, deps: Omit<SelfDiscoveryOptions, "apiUrl"> = {}): ReturnType<typeof startSelfDiscovery> {
  return startSelfDiscovery({
    apiUrl,
    log: (msg, meta) => stderrLogger.warn(msg, meta),
    ...deps,
  });
}

const USAGE = "usage: dominusnode-node <register --wallet-key-file PATH | run> [--key-file PATH] [--ports 80,443] [--max-streams N] [--req-per-sec N] [--gb-per-day N]";

async function main(argv: string[]): Promise<number> {
  const [cmd, ...rest] = argv;
  if (cmd !== "register" && cmd !== "run") {
    process.stderr.write(USAGE + "\n");
    return 2;
  }
  const flags = parseFlags(rest);
  const cfg = loadConfig(process.env, flags);
  if (isDemoMode(process.env)) {
    process.stderr.write("\n*** DEMO MODE, NOT FOR PRODUCTION: plaintext gateway allowed, local demo coordinator only ***\n\n");
  }

  if (cmd === "register") {
    const walletKeyFile = flags["wallet-key-file"] ?? process.env["DN_WALLET_KEY_FILE"];
    let apiKey = process.env["DN_API_KEY"] ?? "";
    delete process.env["DN_API_KEY"];
    if (!walletKeyFile) throw new ConfigError("--wallet-key-file (or DN_WALLET_KEY_FILE) is required");
    if (!apiKey) throw new ConfigError("DN_API_KEY env is required");
    try {
      const node = await registerNode({ apiUrl: cfg.apiUrl, apiKey, walletKeyFile, outFile: cfg.keyFile });
      process.stderr.write(`registered node ${node.nodeId}; key stored at ${cfg.keyFile} (mode 0600)\n`);
    } finally {
      apiKey = "";
    }
    return 0;
  }

  const stored = readNodeFile(cfg.keyFile);
  const discovery = startFloorDiscovery(cfg.apiUrl);
  const limits = new Limits({ maxStreams: cfg.maxStreams, reqPerSec: cfg.reqPerSec, gbPerDay: cfg.gbPerDay });
  const client = new TunnelClient({
    url: cfg.gatewayUrl,
    nodeKey: stored.nodeKey,
    nodeId: stored.nodeId,
    agentVersion: AGENT_VERSION,
    localPorts: cfg.ports,
    caps: { maxStreams: cfg.maxStreams, maxMbps: cfg.maxMbps, gbPerDay: cfg.gbPerDay },
    limits,
    spkiPins: cfg.spkiPins,
    nodePrivateKeyPem: stored.nodePrivateKeyPem,
    coordPins: effectiveCoordPins(cfg.coordPins),
    dial: (host, port, allowedPorts) => dial(host, port, { allowedPorts: () => allowedPorts, denyDomains: cfg.denyDomains }),
  });
  stored.nodeKey = "";
  stored.nodePrivateKeyPem = "";
  return await new Promise<number>((resolve) => {
    const shutdown = (): void => {
      client.stop();
      discovery.stop();
      resolve(0);
    };
    process.once("SIGINT", shutdown);
    process.once("SIGTERM", shutdown);
    client.start();
  });
}

if (require.main === module) {
  main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (err: unknown) => {
      stderrLogger.warn("fatal", { error: scrub(err instanceof Error ? err.message : String(err)) });
      process.exit(err instanceof ConfigError ? 2 : 1);
    },
  );
}
