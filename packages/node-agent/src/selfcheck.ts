/**
 * `dominusnode-node selfcheck`: preflight checks an operator runs before (or
 * while) serving traffic. Each check prints PASS/FAIL with a remediation line;
 * any FAIL makes the command exit non-zero.
 *
 * Checks:
 *   1. node key file: present, mode 0600, dn_node_ key format
 *   2. gateway reachable over TLS (certificate verified, no plaintext)
 *   3. clock skew against the API's Date header (channel binding and
 *      signed challenges have short validity windows)
 *   4. outbound dial: the floor-checked dialer can reach a public host:443
 *   5. coordinator pins: `run` refuses to start without at least one
 *      (checked only when the caller passes the resolved pin count)
 *
 * Secrets are never printed: key material is only tested, not echoed.
 */
import * as tls from "node:tls";
import { dial } from "./dialer.js";
import { NODE_KEY_RE, readNodeFile } from "./register.js";
import { scrub, spkiFingerprint } from "./tunnel-client.js";

export type CheckStatus = "pass" | "fail" | "warn";

export interface CheckResult {
  name: string;
  status: CheckStatus;
  detail: string;
  remediation?: string;
}

/** Clock skew above this fails; above half of it warns. */
export const MAX_CLOCK_SKEW_MS = 30_000;
export const DEFAULT_DIAL_TARGET = "example.com";
const TIMEOUT_MS = 10_000;

export interface SelfcheckDeps {
  readNodeFile?: (file: string) => { nodeKey: string; nodeId: string };
  /** Opens a verified TLS connection; resolves the negotiated protocol or rejects. */
  tlsProbe?: (host: string, port: number, timeoutMs: number, spkiPins: readonly string[]) => Promise<string>;
  /** Returns the server's Date header (ms since epoch) for the URL, or null. */
  serverTime?: (url: string, timeoutMs: number) => Promise<number | null>;
  now?: () => number;
  /** Dials host:443 through the floor; resolves true on connect. */
  outboundDial?: (host: string, port: number) => Promise<boolean>;
}

export interface SelfcheckOptions {
  keyFile: string;
  gatewayUrl: string;
  apiUrl: string;
  dialTarget?: string;
  denyDomains?: readonly string[];
  /** DN_NODE_SPKI_PINS: when set, the probe enforces them exactly as `run` does. */
  spkiPins?: readonly string[];
  /** Coordinator pins `run` would use; 0 means `run` exits immediately. */
  coordPinCount?: number;
}

const errMsg = (e: unknown): string => scrub(e instanceof Error ? e.message : String(e)).slice(0, 200);

export function checkKeyFormat(keyFile: string, read: NonNullable<SelfcheckDeps["readNodeFile"]>): CheckResult {
  const name = "node key";
  try {
    const n = read(keyFile);
    if (!NODE_KEY_RE.test(n.nodeKey)) {
      return { name, status: "fail", detail: "key is not a dn_node_ key", remediation: "Re-run `dominusnode-node register` to get a fresh node key file." };
    }
    return { name, status: "pass", detail: `node ${n.nodeId}, dn_node_ key, file mode ok` };
  } catch (e) {
    const msg = errMsg(e);
    const missing = /ENOENT/.test(msg);
    return {
      name,
      status: "fail",
      detail: missing ? `no key file at ${keyFile}` : msg,
      remediation: missing
        ? "Register first: DN_API_KEY=... dominusnode-node register --wallet-key-file <path> (or set DN_NODE_KEY_FILE)."
        : /0600/.test(msg)
          ? `Restrict the file: chmod 600 ${keyFile}`
          : "Re-run `dominusnode-node register` to rewrite the key file.",
    };
  }
}

export async function checkGatewayTls(
  gatewayUrl: string,
  probe: NonNullable<SelfcheckDeps["tlsProbe"]>,
  spkiPins: readonly string[] = [],
): Promise<CheckResult> {
  const name = "gateway TLS";
  let u: URL;
  try {
    u = new URL(gatewayUrl);
  } catch {
    return { name, status: "fail", detail: "gateway URL is invalid", remediation: "Fix DN_NODE_GATEWAY_URL (wss://host/v1/tunnel)." };
  }
  if (u.protocol !== "wss:") {
    return { name, status: "fail", detail: `gateway URL uses ${u.protocol} (plaintext)`, remediation: "Use a wss:// gateway URL; plaintext is demo-only." };
  }
  const port = u.port ? Number(u.port) : 443;
  try {
    const proto = await probe(u.hostname, port, TIMEOUT_MS, spkiPins);
    const pinned = spkiPins.length > 0 ? ", SPKI pin matched" : "";
    return { name, status: "pass", detail: `${u.hostname}:${port} reachable, certificate verified${pinned} (${proto})` };
  } catch (e) {
    return {
      name,
      status: "fail",
      detail: `${u.hostname}:${port}: ${errMsg(e)}`,
      remediation: `Allow outbound TCP ${port} to the gateway, check DNS, check DN_NODE_SPKI_PINS if set, and check that no TLS-intercepting proxy sits in the path.`,
    };
  }
}

export async function checkClockSkew(apiUrl: string, serverTime: NonNullable<SelfcheckDeps["serverTime"]>, now: () => number): Promise<CheckResult> {
  const name = "clock skew";
  try {
    const before = now();
    const server = await serverTime(apiUrl, TIMEOUT_MS);
    const after = now();
    if (server === null || !Number.isFinite(server)) {
      return { name, status: "fail", detail: "API returned no Date header", remediation: "Check DN_NODE_API_URL points at the DomiNode API." };
    }
    const local = Math.round((before + after) / 2);
    const skew = local - server;
    const abs = Math.abs(skew);
    // HTTP Date has 1 s resolution; allow for it.
    const detail = `${skew >= 0 ? "+" : "-"}${(abs / 1000).toFixed(1)}s vs API`;
    const remediation = "Enable time sync (e.g. `timedatectl set-ntp true` or chrony/systemd-timesyncd).";
    if (abs > MAX_CLOCK_SKEW_MS) return { name, status: "fail", detail, remediation };
    if (abs > MAX_CLOCK_SKEW_MS / 2) return { name, status: "warn", detail, remediation };
    return { name, status: "pass", detail };
  } catch (e) {
    return { name, status: "fail", detail: `API unreachable: ${errMsg(e)}`, remediation: "Allow outbound HTTPS to the API host and check DN_NODE_API_URL." };
  }
}

export async function checkOutboundDial(target: string, outbound: NonNullable<SelfcheckDeps["outboundDial"]>): Promise<CheckResult> {
  const name = "outbound dial";
  try {
    if (await outbound(target, 443)) return { name, status: "pass", detail: `${target}:443 reachable through the floor-checked dialer` };
    return {
      name,
      status: "fail",
      detail: `could not reach ${target}:443`,
      remediation: "This host must be able to open outbound TCP 80/443 to the internet; check firewall and egress rules.",
    };
  } catch (e) {
    return { name, status: "fail", detail: errMsg(e), remediation: "Check DNS resolution and outbound firewall rules." };
  }
}

export function coordPinsCheck(count: number): CheckResult {
  const name = "coordinator pins";
  if (count > 0) return { name, status: "pass", detail: `${count} coordinator pin(s) configured` };
  return {
    name,
    status: "fail",
    detail: "no coordinator pins; `run` will refuse to start",
    remediation: "Use the published image (it embeds the official pins) or set DN_NODE_COORD_PINS / --coordinator with --trust.",
  };
}

/** Same server-identity rule the tunnel uses: hostname + CA, then the SPKI pin when pins are set. */
export function pinnedIdentity(spkiPins: readonly string[]) {
  return (host: string, cert: tls.PeerCertificate): Error | undefined => {
    const base = tls.checkServerIdentity(host, cert);
    if (base) return base;
    if (spkiPins.length === 0) return undefined;
    const fp = spkiFingerprint(cert);
    return fp && spkiPins.includes(fp) ? undefined : new Error("SPKI pin mismatch");
  };
}

const defaultTlsProbe: NonNullable<SelfcheckDeps["tlsProbe"]> = (host, port, timeoutMs, spkiPins) =>
  new Promise((resolve, reject) => {
    const sock = tls.connect({
      host,
      port,
      servername: host,
      rejectUnauthorized: true,
      ALPNProtocols: ["http/1.1"],
      checkServerIdentity: pinnedIdentity(spkiPins),
    });
    const timer = setTimeout(() => {
      sock.destroy();
      reject(new Error("timed out"));
    }, timeoutMs);
    sock.once("secureConnect", () => {
      clearTimeout(timer);
      const proto = sock.getProtocol() ?? "tls";
      sock.end();
      resolve(proto);
    });
    sock.once("error", (e) => {
      clearTimeout(timer);
      sock.destroy();
      reject(e);
    });
  });

const defaultServerTime: NonNullable<SelfcheckDeps["serverTime"]> = async (url, timeoutMs) => {
  const res = await fetch(url, { method: "HEAD", redirect: "manual", signal: AbortSignal.timeout(timeoutMs) });
  await res.body?.cancel().catch(() => undefined);
  const d = res.headers.get("date");
  if (!d) return null;
  const t = Date.parse(d);
  return Number.isFinite(t) ? t : null;
};

export async function runSelfcheck(opts: SelfcheckOptions, deps: SelfcheckDeps = {}): Promise<CheckResult[]> {
  const outbound =
    deps.outboundDial ??
    (async (host: string, port: number) => {
      const r = await dial(host, port, { allowedPorts: () => [port], denyDomains: opts.denyDomains ?? [], timeoutMs: TIMEOUT_MS });
      if (r.ok) r.socket.destroy();
      return r.ok;
    });
  const key = checkKeyFormat(opts.keyFile, deps.readNodeFile ?? readNodeFile);
  const [gw, clock, out] = await Promise.all([
    checkGatewayTls(opts.gatewayUrl, deps.tlsProbe ?? defaultTlsProbe, opts.spkiPins ?? []),
    checkClockSkew(opts.apiUrl, deps.serverTime ?? defaultServerTime, deps.now ?? Date.now),
    checkOutboundDial(opts.dialTarget ?? DEFAULT_DIAL_TARGET, outbound),
  ]);
  const results = [key, gw, clock, out];
  if (opts.coordPinCount !== undefined) results.push(coordPinsCheck(opts.coordPinCount));
  return results;
}

export function formatResults(results: readonly CheckResult[]): string {
  const lines = results.map((r) => {
    const tag = r.status === "pass" ? "PASS" : r.status === "warn" ? "WARN" : "FAIL";
    const fix = r.status !== "pass" && r.remediation ? `\n       fix: ${r.remediation}` : "";
    return `[${tag}] ${r.name}: ${r.detail}${fix}`;
  });
  const failed = results.filter((r) => r.status === "fail").length;
  lines.push(failed === 0 ? "selfcheck: all checks passed" : `selfcheck: ${failed} check(s) failed`);
  return lines.join("\n") + "\n";
}

/** 0 when no check failed (warnings allowed), 1 otherwise. */
export function exitCodeFor(results: readonly CheckResult[]): number {
  return results.some((r) => r.status === "fail") ? 1 : 0;
}
