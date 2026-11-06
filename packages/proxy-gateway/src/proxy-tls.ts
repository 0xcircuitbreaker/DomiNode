import * as fs from "node:fs";

/** TLS listener config for the HTTPS proxy / SOCKS5-over-TLS ports. */
export interface ProxyTlsConfig {
  port: number;
  socks5Port: number | null;
  cert: Buffer;
  key: Buffer;
}

function parsePort(name: string, raw: string | undefined): number | null {
  if (raw === undefined || raw.trim() === "") return null;
  const t = raw.trim();
  const n = /^\d{1,5}$/.test(t) ? parseInt(t, 10) : NaN;
  if (isNaN(n) || n < 1 || n > 65535) throw new Error(`${name} must be a valid port number (1-65535)`);
  return n;
}

/**
 * Read PROXY_TLS_PORT / PROXY_TLS_CERT_FILE / PROXY_TLS_KEY_FILE (and the
 * optional SOCKS5_TLS_PORT). Returns null when the TLS listener is off.
 * Throws on a half-configured or invalid setup (fail closed at startup).
 */
export function loadProxyTls(
  env: NodeJS.ProcessEnv,
  readFile: (p: string) => Buffer = (p) => fs.readFileSync(p),
): ProxyTlsConfig | null {
  const port = parsePort("PROXY_TLS_PORT", env["PROXY_TLS_PORT"]);
  const socks5Port = parsePort("SOCKS5_TLS_PORT", env["SOCKS5_TLS_PORT"]);
  const c = env["PROXY_TLS_CERT_FILE"];
  const k = env["PROXY_TLS_KEY_FILE"];
  if (port === null) {
    if (socks5Port !== null) throw new Error("SOCKS5_TLS_PORT requires PROXY_TLS_PORT");
    if (c || k) throw new Error("PROXY_TLS_CERT_FILE/PROXY_TLS_KEY_FILE set without PROXY_TLS_PORT");
    return null;
  }
  if (!c || !k) throw new Error("PROXY_TLS_PORT requires PROXY_TLS_CERT_FILE and PROXY_TLS_KEY_FILE");
  if (socks5Port !== null && socks5Port === port) throw new Error("SOCKS5_TLS_PORT must differ from PROXY_TLS_PORT");
  return { port, socks5Port, cert: readFile(c), key: readFile(k) };
}

/** PROXY_REQUIRE_TLS=true refuses proxy credentials on the plaintext listeners. */
export function parseRequireTls(env: NodeJS.ProcessEnv): boolean {
  return env["PROXY_REQUIRE_TLS"] === "true";
}

/** Called when credentials arrive on a plaintext listener. false = refuse. */
export type PlaintextAuthGuard = (listener: "http" | "socks5") => boolean;

/**
 * Plaintext proxy auth policy: refuse when requireTls, otherwise warn in
 * production (rate limited to one line per listener per interval).
 */
export function createPlaintextAuthGuard(opts: {
  production: boolean;
  requireTls: boolean;
  warn: (msg: string, meta?: Record<string, unknown>) => void;
  now?: () => number;
  intervalMs?: number;
}): PlaintextAuthGuard {
  const now = opts.now ?? Date.now;
  const interval = opts.intervalMs ?? 60_000;
  const last = new Map<string, number>();
  return (listener) => {
    if (opts.requireTls) return false;
    if (opts.production) {
      const t = now();
      const prev = last.get(listener);
      if (prev === undefined || t - prev >= interval) {
        last.set(listener, t);
        opts.warn(
          "proxy credentials received over plaintext; use the TLS listener (PROXY_TLS_PORT) or set PROXY_REQUIRE_TLS=true",
          { listener },
        );
      }
    }
    return true;
  };
}
