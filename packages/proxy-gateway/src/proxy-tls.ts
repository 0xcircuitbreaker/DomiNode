import * as fs from "node:fs";
import * as tls from "node:tls";
import { pqTlsOptions } from "@dominusnode/shared";

/** TLS listener config for the HTTPS proxy / SOCKS5-over-TLS ports. */
export interface ProxyTlsConfig {
  port: number;
  socks5Port: number | null;
  cert: Buffer;
  key: Buffer;
  certFile: string;
  keyFile: string;
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
  return { port, socks5Port, cert: readFile(c), key: readFile(k), certFile: c, keyFile: k };
}

/**
 * PROXY_REQUIRE_TLS refuses proxy credentials on the plaintext listeners.
 * "true"/"false" are explicit; unset (or anything else) defaults to true in
 * production and false elsewhere. Only the exact string "false" turns it off
 * in production, so a typo cannot open the plaintext path.
 */
export function parseRequireTls(env: NodeJS.ProcessEnv, production = false): boolean {
  const v = env["PROXY_REQUIRE_TLS"];
  if (v === "true") return true;
  if (v === "false") return false;
  return production;
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

/** A TLS listener whose certificate can be swapped in place (https.Server / tls.Server). */
export interface ReloadableTlsServer {
  setSecureContext(options: tls.SecureContextOptions): void;
}

/**
 * Hot-reload the proxy TLS certificate (renewals) without restarting or
 * dropping connections: every intervalMs, re-read the cert and key files; when
 * either changed and the pair forms a valid context (same TLS 1.3 + hybrid
 * group options as at startup), apply it to every TLS listener. Existing
 * connections keep their session; new handshakes get the new cert. A bad or
 * half-written pair is skipped and the last good cert stays in place.
 */
export function watchProxyTlsCert(opts: {
  certFile: string;
  keyFile: string;
  servers: ReloadableTlsServer[];
  initial: { cert: Buffer; key: Buffer };
  log: { info: (m: string, meta?: Record<string, unknown>) => void; warn: (m: string, meta?: Record<string, unknown>) => void };
  intervalMs?: number;
  readFile?: (p: string) => Buffer;
}): { check: () => boolean; stop: () => void } {
  const read = opts.readFile ?? ((p: string) => fs.readFileSync(p));
  let cert = opts.initial.cert;
  let key = opts.initial.key;
  const check = (): boolean => {
    let c: Buffer, k: Buffer;
    try {
      c = read(opts.certFile);
      k = read(opts.keyFile);
    } catch (err) {
      opts.log.warn("proxy TLS cert reload: read failed, keeping current cert", { error: err instanceof Error ? err.message.slice(0, 100) : "unknown" });
      return false;
    }
    if (c.equals(cert) && k.equals(key)) return false;
    const ctx = { cert: c, key: k, ...pqTlsOptions() };
    try {
      tls.createSecureContext(ctx);
    } catch (err) {
      opts.log.warn("proxy TLS cert reload: invalid cert/key pair, keeping current cert", { error: err instanceof Error ? err.message.slice(0, 100) : "unknown" });
      return false;
    }
    for (const s of opts.servers) s.setSecureContext(ctx);
    cert = c;
    key = k;
    opts.log.info("proxy TLS certificate reloaded", { servers: opts.servers.length });
    return true;
  };
  const t = setInterval(check, opts.intervalMs ?? 60_000);
  t.unref();
  return { check, stop: () => clearInterval(t) };
}
