/**
 * Public-site configuration. Origins come from build-time env vars so the same
 * build can be deployed under any DDG subdomain. Nothing here is a secret.
 */
export const DEFAULT_PUBLIC_ORIGIN = "https://dominusnode.daedalusdevelopmentgroup.com";
export const DEFAULT_API_BASE = "https://api.dominusnode.com";

export function cleanOrigin(raw: string | undefined, fallback: string): string {
  if (!raw) return fallback;
  try {
    const u = new URL(raw);
    if (u.protocol !== "https:" && u.protocol !== "http:") return fallback;
    return (u.origin + u.pathname).replace(/\/+$/, "");
  } catch {
    return fallback;
  }
}

const env = import.meta.env as Record<string, string | undefined>;

export const PUBLIC_ORIGIN = cleanOrigin(env["VITE_PUBLIC_ORIGIN"], DEFAULT_PUBLIC_ORIGIN);
export const API_BASE = cleanOrigin(env["VITE_API_BASE"], DEFAULT_API_BASE);

export const DDG_URL = "https://daedalusdevelopmentgroup.com";
export const GITHUB_URL = "https://github.com/0xcircuitbreaker/DomiNode";
export const DOCS_URL = `${GITHUB_URL}/tree/master/docs/agent-network`;
/** The API exposes a health endpoint, not a status page. */
export const STATUS_URL = `${API_BASE}/api/health`;
/** The API has no dedicated abuse intake yet; reports go to the repo's issue tracker. */
export const ABUSE_URL = env["VITE_ABUSE_URL"] || `${GITHUB_URL}/issues/new?labels=abuse&title=Abuse+report`;
export const PROXY_HOST = "proxy.dominusnode.com";
