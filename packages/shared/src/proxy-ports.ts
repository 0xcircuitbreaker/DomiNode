/**
 * Gateway port configuration, shared by the gateway (listeners) and the API
 * (advertised endpoints, internal calls). One reader for one set of env names:
 *
 *   PROXY_LISTEN_PORT   HTTP proxy (plaintext)          default 8080
 *   SOCKS5_LISTEN_PORT  SOCKS5 (plaintext)              default 1080
 *   PROXY_TLS_PORT      HTTPS proxy (TLS)               off when unset
 *   SOCKS5_TLS_PORT     SOCKS5 over TLS                 off when unset
 *   TUNNEL_PORT         node tunnel (wss)               default 9443
 *
 * Advertised (public) ports default to the listening ports and can be
 * overridden when a load balancer remaps them: PROXY_PUBLIC_HTTP_PORT,
 * PROXY_PUBLIC_SOCKS5_PORT, PROXY_PUBLIC_TLS_PORT, PROXY_PUBLIC_SOCKS5_TLS_PORT,
 * PROXY_PUBLIC_TUNNEL_PORT.
 */

export const DEFAULT_PROXY_HTTP_PORT = 8080;
export const DEFAULT_SOCKS5_PORT = 1080;
export const DEFAULT_TUNNEL_PORT = 9443;

export interface ProxyPorts {
  http: number;
  socks5: number;
  /** HTTPS proxy listener, null when off. */
  tls: number | null;
  /** SOCKS5-over-TLS listener, null when off. */
  socks5Tls: number | null;
  tunnel: number;
}

type Env = Record<string, string | undefined>;

/** Parse a port env value: undefined/empty -> null; otherwise 1..65535 or throw. */
export function parsePortEnv(name: string, raw: string | undefined): number | null {
  if (raw === undefined || raw.trim() === "") return null;
  const t = raw.trim();
  if (!/^\d{1,5}$/.test(t)) throw new Error(`${name} must be an integer port (1-65535)`);
  const n = parseInt(t, 10);
  if (n < 1 || n > 65535) throw new Error(`${name} must be in 1..65535`);
  return n;
}

/** Ports the gateway listens on. Throws on an invalid value. */
export function getProxyPorts(env: Env = process.env): ProxyPorts {
  return {
    http: parsePortEnv("PROXY_LISTEN_PORT", env["PROXY_LISTEN_PORT"]) ?? DEFAULT_PROXY_HTTP_PORT,
    socks5: parsePortEnv("SOCKS5_LISTEN_PORT", env["SOCKS5_LISTEN_PORT"]) ?? DEFAULT_SOCKS5_PORT,
    tls: parsePortEnv("PROXY_TLS_PORT", env["PROXY_TLS_PORT"]),
    socks5Tls: parsePortEnv("SOCKS5_TLS_PORT", env["SOCKS5_TLS_PORT"]),
    tunnel: parsePortEnv("TUNNEL_PORT", env["TUNNEL_PORT"]) ?? DEFAULT_TUNNEL_PORT,
  };
}

/** Ports to advertise to clients (PROXY_PUBLIC_* overrides, else the listening ports). */
export function getPublicProxyPorts(env: Env = process.env): ProxyPorts {
  const l = getProxyPorts(env);
  return {
    http: parsePortEnv("PROXY_PUBLIC_HTTP_PORT", env["PROXY_PUBLIC_HTTP_PORT"]) ?? l.http,
    socks5: parsePortEnv("PROXY_PUBLIC_SOCKS5_PORT", env["PROXY_PUBLIC_SOCKS5_PORT"]) ?? l.socks5,
    tls: parsePortEnv("PROXY_PUBLIC_TLS_PORT", env["PROXY_PUBLIC_TLS_PORT"]) ?? l.tls,
    socks5Tls: parsePortEnv("PROXY_PUBLIC_SOCKS5_TLS_PORT", env["PROXY_PUBLIC_SOCKS5_TLS_PORT"]) ?? l.socks5Tls,
    tunnel: parsePortEnv("PROXY_PUBLIC_TUNNEL_PORT", env["PROXY_PUBLIC_TUNNEL_PORT"]) ?? l.tunnel,
  };
}

/** Internal HTTP endpoint of the gateway for API -> gateway calls. */
export function getProxyInternalPort(env: Env = process.env): number {
  return parsePortEnv("PROXY_INTERNAL_PORT", env["PROXY_INTERNAL_PORT"]) ?? getProxyPorts(env).http;
}

const PORT_ENV: Record<keyof ProxyPorts, string> = {
  http: "PROXY_LISTEN_PORT",
  socks5: "SOCKS5_LISTEN_PORT",
  tls: "PROXY_TLS_PORT",
  socks5Tls: "SOCKS5_TLS_PORT",
  tunnel: "TUNNEL_PORT",
};

/** Throw a clear error when two enabled listeners share a port. */
export function assertDistinctProxyPorts(p: ProxyPorts): void {
  const seen = new Map<number, keyof ProxyPorts>();
  for (const k of Object.keys(PORT_ENV) as Array<keyof ProxyPorts>) {
    const v = p[k];
    if (v === null) continue;
    const prev = seen.get(v);
    if (prev) {
      throw new Error(`Port clash: ${PORT_ENV[prev]} and ${PORT_ENV[k]} are both ${v}. Give each gateway listener its own port.`);
    }
    seen.set(v, k);
  }
}
