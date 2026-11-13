import { API_BASE, NODE_IMAGE, PROXY_HOST } from "./site";

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
# US residential exit over the TLS proxy (the key never travels in clear);
# HTTPS stays end-to-end TLS through the exit node
curl -x "https://country-US-class-residential:$DOMINUSNODE_API_KEY@${PROXY_HOST}:8443" \\
  https://httpbin.org/ip

# Sticky datacenter session; class-masked (VPN/WARP exits) is the cheapest, opt-in
curl -x "https://class-dc-session-job42:$DOMINUSNODE_API_KEY@${PROXY_HOST}:8443" \\
  https://httpbin.org/ip
# Plaintext :8080 / socks5 :1080 are for a local gateway only; production refuses credentials there.`,
  },
  {
    id: "x402",
    label: "x402 (no signup)",
    lang: "bash",
    code: `# 1. Without credentials the gateway answers 402 with payment requirements
#    (x402 "accepts", plus an MPP WWW-Authenticate: Payment challenge when enabled).
curl -sv -x "https://${PROXY_HOST}:8443" https://example.com/ 2>&1 | grep -i "402\\|payment"

# 2. Pay with any x402 client, then retry with the proof on the proxy request
#    (over TLS: the gateway treats X-PAYMENT as a credential and refuses it in clear):
curl -x "https://${PROXY_HOST}:8443" \\
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
    code: `# Published image: official coordinator pins baked in (a plain source build has none)
sudo install -d -o 1001 -g 1001 -m 700 /etc/dominusnode
sudo install -o 1001 -g 1001 -m 600 ./wallet.key /etc/dominusnode/wallet.key
read -rs DN_API_KEY && export DN_API_KEY   # env only, never an argument
# Registration signs a consent attestation locally
docker run --rm -e DN_API_KEY -e DN_WALLET_KEY_FILE=/run/dominusnode/wallet.key \\
  -v /etc/dominusnode:/run/dominusnode ${NODE_IMAGE} register
sudo rm /etc/dominusnode/wallet.key   # not needed after registration
# Dials OUT to the gateway (no inbound ports). Limits can only tighten:
docker run -d --name dominusnode-node --restart unless-stopped \\
  -e DN_NODE_GB_PER_DAY=5 -e DN_NODE_MAX_STREAMS=32 \\
  -v /etc/dominusnode/node.json:/run/dominusnode/node.json:ro ${NODE_IMAGE}`,
  },
];
