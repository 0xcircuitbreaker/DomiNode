/**
 * Floor-checked dialer (DESIGN.md §3, §11 row 4):
 * resolve ALL records -> every IP must pass the floor -> connect to a checked IP
 * literal (no second resolution) -> re-check socket.remoteAddress after connect.
 */
import * as dns from "node:dns";
import * as net from "node:net";
import { floorAllowsHost, floorAllowsIp, floorAllowsPort } from "./floor.js";
import { isDeniedDomain } from "./config.js";

export type OpenErrCode = "FLOOR_BLOCKED" | "PORT_BLOCKED" | "DNS_FAIL" | "DIAL_FAIL" | "CAP_EXCEEDED";

export type DialResult = { ok: true; socket: net.Socket; ip: string } | { ok: false; code: OpenErrCode };

export type Resolver = (host: string) => Promise<string[]>;
export type Connector = (ip: string, port: number) => net.Socket;

export interface DialerOptions {
  allowedPorts: () => readonly number[];
  denyDomains?: readonly string[];
  resolver?: Resolver;
  connector?: Connector;
  timeoutMs?: number;
  maxAttempts?: number;
}

const MAX_ADDRESSES = 64;

export const defaultResolver: Resolver = async (host) => {
  const [v4, v6] = await Promise.allSettled([dns.promises.resolve4(host), dns.promises.resolve6(host)]);
  const out: string[] = [];
  for (const r of [v4, v6]) if (r.status === "fulfilled" && Array.isArray(r.value)) out.push(...r.value);
  return out;
};

export const defaultConnector: Connector = (ip, port) => net.connect({ host: ip, port, family: net.isIP(ip) });

function connectOnce(connector: Connector, ip: string, port: number, timeoutMs: number): Promise<net.Socket | null> {
  return new Promise((resolve) => {
    let done = false;
    const sock = connector(ip, port);
    const finish = (ok: boolean): void => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      sock.removeListener("connect", onConnect);
      sock.removeListener("error", onError);
      if (!ok) sock.destroy();
      resolve(ok ? sock : null);
    };
    const onConnect = (): void => finish(true);
    const onError = (): void => finish(false);
    const timer = setTimeout(() => finish(false), timeoutMs);
    sock.once("connect", onConnect);
    sock.once("error", onError);
  });
}

function sameIp(a: string, b: string): boolean {
  const n = (s: string): string => {
    const l = s.toLowerCase();
    return l.startsWith("::ffff:") && net.isIP(l.slice(7)) === 4 ? l.slice(7) : l;
  };
  return n(a) === n(b);
}

export async function dial(host: string, port: number, opts: DialerOptions): Promise<DialResult> {
  if (!floorAllowsPort(port) || !opts.allowedPorts().includes(port)) return { ok: false, code: "PORT_BLOCKED" };
  if (typeof host !== "string") return { ok: false, code: "FLOOR_BLOCKED" };
  const bare = host.startsWith("[") && host.endsWith("]") ? host.slice(1, -1) : host;
  if (!floorAllowsHost(bare)) return { ok: false, code: "FLOOR_BLOCKED" };
  if (net.isIP(bare) === 0 && isDeniedDomain(bare, opts.denyDomains ?? [])) return { ok: false, code: "FLOOR_BLOCKED" };

  let addrs: string[];
  if (net.isIP(bare) !== 0) {
    addrs = [bare];
  } else {
    try {
      addrs = await (opts.resolver ?? defaultResolver)(bare);
    } catch {
      return { ok: false, code: "DNS_FAIL" };
    }
    if (!Array.isArray(addrs) || addrs.length === 0) return { ok: false, code: "DNS_FAIL" };
    addrs = addrs.slice(0, MAX_ADDRESSES);
  }
  // Every resolved address must pass: one private record poisons the whole name (rebinding defence).
  for (const a of addrs) if (typeof a !== "string" || !floorAllowsIp(a)) return { ok: false, code: "FLOOR_BLOCKED" };

  const connector = opts.connector ?? defaultConnector;
  const timeoutMs = opts.timeoutMs ?? 10_000;
  const attempts = Math.min(addrs.length, opts.maxAttempts ?? 3);
  for (let i = 0; i < attempts; i++) {
    const ip = addrs[i];
    const sock = await connectOnce(connector, ip, port, timeoutMs);
    if (!sock) continue;
    const remote = sock.remoteAddress;
    if (typeof remote !== "string" || !floorAllowsIp(remote) || !sameIp(remote, ip)) {
      sock.destroy();
      return { ok: false, code: "FLOOR_BLOCKED" };
    }
    return { ok: true, socket: sock, ip };
  }
  return { ok: false, code: "DIAL_FAIL" };
}
