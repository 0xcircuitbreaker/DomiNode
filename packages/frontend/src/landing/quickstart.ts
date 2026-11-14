import { API_BASE, GITHUB_URL, PROXY_HOST, STATUS_URL } from "./site";

/** Public ports of the gateway (docs/agent-network/QUICKSTART.md). */
export const PORTS = { httpsProxy: 8443, socks5Tls: 1443, tunnel: 9443 } as const;

export const QUICKSTART_DOC_URL = `${GITHUB_URL}/blob/master/docs/agent-network/QUICKSTART.md`;
export const QUICKSTART_SMOKE_URL = `${GITHUB_URL}/blob/master/scripts/quickstart-smoke.sh`;

export interface QuickstartStep { minute: string; title: string; text: string; code?: string }

/** The five-minute path. Placeholder key only ($DOMINUSNODE_API_KEY). */
export const QUICKSTART_STEPS: QuickstartStep[] = [
  {
    minute: "0-1",
    title: "Read policy and prices",
    text: "No auth. Prices are live; never hardcode them. /v1/network/stats shows online nodes.",
    code: `curl -s ${API_BASE}/v1/policy\ncurl -s ${API_BASE}/v1/pricing`,
  },
  {
    minute: "1-3",
    title: "Pay",
    text: "Per request with x402/MPP (answer the 402, no signup), or sign in with a wallet signature, create a dn_live_ key and top up with crypto.",
  },
  {
    minute: "3-5",
    title: "Fetch through the TLS proxy",
    text: `HTTPS proxy :${PORTS.httpsProxy}, SOCKS5 over TLS :${PORTS.socks5Tls}. No node for your flags? Check the status page: ${STATUS_URL}`,
    code: `curl -x https://${PROXY_HOST}:${PORTS.httpsProxy} \\\n  -K <(printf 'proxy-user = "relay:%s"\\n' "$DOMINUSNODE_API_KEY") \\\n  https://httpbin.org/ip`,
  },
];
