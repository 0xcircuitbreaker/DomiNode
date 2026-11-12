/**
 * Post-quantum hybrid TLS settings for every TLS endpoint we control
 * (SECURITY_ARCHITECTURE.md §2.2, §2.3). One place decides the protocol floor
 * and the key-exchange groups so the gateway listeners, the node tunnel and the
 * node-agent client cannot drift apart.
 *
 * X25519MLKEM768 is the IETF hybrid group (X25519 + ML-KEM-768, FIPS 203). It
 * needs OpenSSL >= 3.5 (bundled with Node >= 22.20). On an older OpenSSL we fall
 * back to X25519 alone and say so once at startup.
 *
 * Kept free of DB/auth imports so the node agent can deep-import it.
 */
import * as tls from "node:tls";

export const PQ_HYBRID_GROUP = "X25519MLKEM768";
export const PQ_ECDH_CURVE = `${PQ_HYBRID_GROUP}:X25519`;
export const CLASSIC_ECDH_CURVE = "X25519";
export const MIN_OPENSSL = [3, 5] as const;

let cachedSupport: boolean | null = null;

/** True when the runtime OpenSSL accepts the hybrid group. Cached. */
export function pqHybridSupported(): boolean {
  if (cachedSupport !== null) return cachedSupport;
  try {
    tls.createSecureContext({ ecdhCurve: PQ_ECDH_CURVE });
    cachedSupport = true;
  } catch {
    cachedSupport = false;
  }
  return cachedSupport;
}

/** Group list to configure: hybrid first, X25519 fallback for peers without it. */
export function pqEcdhCurve(): string {
  return pqHybridSupported() ? PQ_ECDH_CURVE : CLASSIC_ECDH_CURVE;
}

/** TLS options for servers and clients we control: TLS 1.3 only + hybrid KEX. */
export function pqTlsOptions(): { minVersion: "TLSv1.3"; ecdhCurve: string } {
  return { minVersion: "TLSv1.3", ecdhCurve: pqEcdhCurve() };
}

/** Parse "3.5.1" / "3.0.13+quic" into [major, minor]; null when unparseable. */
export function parseOpenSslVersion(v: string | undefined): [number, number] | null {
  const m = /^(\d+)\.(\d+)/.exec(v ?? "");
  return m ? [parseInt(m[1], 10), parseInt(m[2], 10)] : null;
}

export function openSslAtLeast35(v: string | undefined): boolean {
  const p = parseOpenSslVersion(v);
  if (!p) return false;
  return p[0] > MIN_OPENSSL[0] || (p[0] === MIN_OPENSSL[0] && p[1] >= MIN_OPENSSL[1]);
}

type Log = { info: (msg: string, meta?: Record<string, unknown>) => void; warn: (msg: string, meta?: Record<string, unknown>) => void };

let reported = false;

/**
 * Log the TLS capability once per process: OpenSSL version, whether the hybrid
 * group is available, and a warning when OpenSSL < 3.5 or the group is missing.
 */
export function reportTlsCapability(log: Log, component: string): void {
  if (reported) return;
  reported = true;
  const openssl = process.versions.openssl;
  const hybrid = pqHybridSupported();
  log.info("TLS capability", { component, node: process.version, openssl, groups: pqEcdhCurve(), pqHybrid: hybrid });
  if (!openSslAtLeast35(openssl) || !hybrid) {
    log.warn(`OpenSSL ${openssl} lacks ${PQ_HYBRID_GROUP}; TLS falls back to X25519 (not quantum resistant). Use Node >= 22.20 (OpenSSL >= 3.5)`, { component });
  }
}

/** Test hook. */
export function _resetTlsCapabilityForTest(): void {
  reported = false;
  cachedSupport = null;
}
