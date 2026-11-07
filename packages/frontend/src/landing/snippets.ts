import { API_BASE, GITHUB_URL, PROXY_HOST } from "./site";

/** Copy-paste quickstarts. Placeholder keys only (dn_live_YOUR_KEY / $DOMINUSNODE_API_KEY). */
export interface Snippet { id: string; label: string; lang: string; code: string }

export const SNIPPETS: Snippet[] = [
  {
    id: "mcp",
    label: "MCP server",
    lang: "json",
    code: `{
  "mcpServers": {
    "dominusnode": {
      "command": "npx",
      "args": ["-y", "@dominusnode/mcp-server"],
      "env": {
        "DOMINUSNODE_API_KEY": "dn_live_YOUR_KEY",
        "DOMINUSNODE_API_URL": "${API_BASE}"
      }
    }
  }
}
// No key? Omit "env": the server starts in bootstrap mode
// (wallet sign-in, crypto top-up, public pricing/policy/stats).`,
  },
  {
    id: "curl",
    label: "curl (API key)",
    lang: "bash",
    code: `export DOMINUSNODE_API_KEY=dn_live_YOUR_KEY
# US residential exit; HTTPS stays end-to-end TLS through the exit node
curl -x "http://country-US-class-residential:$DOMINUSNODE_API_KEY@${PROXY_HOST}:8080" \\
  https://httpbin.org/ip

# Sticky datacenter session over SOCKS5
curl -x "socks5h://class-dc-session-job42:$DOMINUSNODE_API_KEY@${PROXY_HOST}:1080" \\
  https://httpbin.org/ip`,
  },
  {
    id: "x402",
    label: "x402 (no signup)",
    lang: "bash",
    code: `# 1. Without credentials the gateway answers 402 with payment requirements
#    (x402 "accepts", plus an MPP WWW-Authenticate: Payment challenge when enabled).
curl -sv -x "http://${PROXY_HOST}:8080" https://example.com/ 2>&1 | grep -i "402\\|payment"

# 2. Pay with any x402 client, then retry with the proof on the proxy request:
curl -x "http://${PROXY_HOST}:8080" \\
  --proxy-header "X-PAYMENT: $X402_PAYMENT_PAYLOAD" \\
  https://example.com/
# The paid amount caps the bytes of that request. Live price: ${API_BASE}/v1/pricing`,
  },
  {
    id: "python",
    label: "Python SDK",
    lang: "python",
    code: `# pip install dominusnode
import os
from dominusnode import DominusNodeClient

with DominusNodeClient(base_url="${API_BASE}") as dn:
    dn.connect_with_key(os.environ["DOMINUSNODE_API_KEY"])
    print(dn.network.pricing())  # live per-GB prices
    res = dn.proxy.fetch("https://example.com", country="US", ip_class="residential")
    print(res.status, res.text()[:200])`,
  },
  {
    id: "node",
    label: "Node SDK",
    lang: "ts",
    code: `// npm install @dominusnode/sdk
import { DominusNodeClient } from "@dominusnode/sdk";

const dn = new DominusNodeClient({ baseUrl: "${API_BASE}" });
await dn.connectWithKey(process.env.DOMINUSNODE_API_KEY!);
const res = await dn.proxy.fetch("https://example.com/", { country: "DE", sessionId: "job42" });
console.log(res.status, res.text().slice(0, 200));`,
  },
  {
    id: "node-agent",
    label: "Run a node",
    lang: "bash",
    code: `git clone ${GITHUB_URL}.git && cd DomiNode
npm ci && npm run build -w @dominusnode/shared -w @dominusnode/node-agent
export DN_API_KEY=dn_live_YOUR_KEY   # env only, never an argument
export DN_NODE_API_URL=${API_BASE}
# Wallet key in a 0600 file; registration signs a consent attestation
node packages/node-agent/dist/src/main.js register --wallet-key-file ~/.dominusnode/wallet.key
# Dials OUT to the gateway (no inbound ports). Limits can only tighten:
node packages/node-agent/dist/src/main.js run --key-file ~/.dominusnode/node.json \\
  --max-streams 32 --gb-per-day 5`,
  },
];
