import { BLOCK_PROXY } from "../shared/constants.js";

export interface GatewayCreds {
  host: string;
  port: number;
  /** null while blocked (spend cap) or without a key: challenges are cancelled. */
  auth: { username: string; password: string } | null;
}

const HOST_RE = /^[a-zA-Z0-9.-]{1,253}$/;

function bypassConditions(apiHost: string): string {
  const hosts = [apiHost, "localhost", "127.0.0.1"].filter((h) => HOST_RE.test(h));
  const exact = hosts.map((h) => `host === ${JSON.stringify(h)}`);
  return [
    ...exact,
    `host === "[::1]"`,
    `dnsDomainIs(host, ".localhost")`,
    `isPlainHostName(host)`,
  ].join(" || ");
}

/**
 * PAC script. "proxy": everything except the API host, loopback and plain host names
 * goes through the gateway. "block": the same traffic goes to a dead loopback port so
 * it fails instead of leaking out DIRECT with the machine's real IP.
 */
export function buildPac(mode: "proxy" | "block", gatewayHost: string, gatewayPort: number, apiHost: string): string {
  if (!HOST_RE.test(gatewayHost)) throw new Error("Invalid gateway host");
  if (!Number.isInteger(gatewayPort) || gatewayPort < 1 || gatewayPort > 65535) throw new Error("Invalid gateway port");
  const target = mode === "proxy" ? `PROXY ${gatewayHost}:${gatewayPort}` : BLOCK_PROXY;
  return `function FindProxyForURL(url, host) {
  if (${bypassConditions(apiHost)}) return "DIRECT";
  return ${JSON.stringify(target)};
}`;
}

export async function setPac(pac: string): Promise<void> {
  await chrome.proxy.settings.set({ value: { mode: "pac_script", pacScript: { data: pac, mandatory: true } }, scope: "regular" });
}

export async function clearProxy(): Promise<void> {
  await chrome.proxy.settings.clear({ scope: "regular" });
}

type AuthDetails = Pick<chrome.webRequest.OnAuthRequiredDetails, "requestId" | "isProxy" | "challenger">;
type AuthResponse = chrome.webRequest.BlockingResponse;

const MAX_TRACKED = 2000;

/**
 * Proxy auth handler (webRequest.onAuthRequired, asyncBlocking).
 * - Only answers proxy challenges from the configured gateway host:port.
 * - Never answers origin-server (non-proxy) challenges, so sites cannot phish the key.
 * - Answers each request at most once; a second challenge means the key was rejected,
 *   so it cancels instead of looping.
 * - Cancels gateway challenges while blocked or keyless (auth is null).
 */
export function createAuthHandler(getCreds: () => GatewayCreds | null) {
  const answered = new Set<string>();
  return (details: AuthDetails): AuthResponse => {
    if (!details.isProxy) return {};
    const creds = getCreds();
    const ch = details.challenger;
    if (!creds || !ch || ch.host.toLowerCase() !== creds.host.toLowerCase() || ch.port !== creds.port) return {};
    if (!creds.auth) return { cancel: true };
    if (answered.has(details.requestId)) return { cancel: true };
    if (answered.size >= MAX_TRACKED) answered.clear();
    answered.add(details.requestId);
    return { authCredentials: { username: creds.auth.username, password: creds.auth.password } };
  };
}
