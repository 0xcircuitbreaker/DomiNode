# Run a DominusNode node (earn by contributing an IP)

The node agent (`packages/node-agent`, binary `dominusnode-node`) dials **out** to the gateway over a pinned TLS 1.3 WebSocket tunnel, so no inbound ports are opened. It relays other agents' TCP streams and enforces a safety floor that cannot be disabled.

## How earning works

- You earn your tier's share of each paid GB relayed through your IP: Probation 25% up to Partner 50%. Live shares are in `GET https://api.dominusnode.daedalusdevelopmentgroup.com/v1/pricing`.
- Tiers rise with paid tenure, gateway-measured uptime, active IPs (distinct /32s with 3+ paying requesters in 7 days) and reputation. Check progress with `GET /v1/node/tier`.
- Owning a node also gives you a buyer discount on your own relay purchases, 0% at Probation up to 25% at Partner by default (live in `/v1/pricing`).
- Self-dealing earns nothing: traffic from you, your wallet, your team or your /24 is never routed to your node.
- Earnings mature after a 3-14 day hold, then become available credit (see [payments](https://dominusnode.daedalusdevelopmentgroup.com/docs/payments.md)).

## Prerequisites

- A wallet-linked account and a `dn_live_` API key (not a team key).
- Node.js 18+ and git on the machine whose IP you contribute.
- You must own or control the connection. IPs in sanctioned countries cannot join.

## Steps

```bash
# 1. Store the owner wallet key in a private file (never pass it as an argument)
mkdir -p ~/.dominusnode && umask 077
printf '%s' "$WALLET_PRIVATE_KEY_HEX" > ~/.dominusnode/wallet.key && chmod 600 ~/.dominusnode/wallet.key

# 2. Build and register (signs the consent attestation, solves a small proof of work)
git clone https://github.com/0xcircuitbreaker/DomiNode.git && cd DomiNode
npm ci && npm run build -w @dominusnode/shared -w @dominusnode/node-agent
export DN_API_KEY=dn_live_YOUR_KEY
export DN_NODE_API_URL=https://api.dominusnode.daedalusdevelopmentgroup.com   # this is the node-agent default
node packages/node-agent/dist/src/main.js register --wallet-key-file ~/.dominusnode/wallet.key
# writes ~/.dominusnode/node.json (mode 0600)

# 3. Run it on the machine that owns the IP; keep it running (systemd, pm2, container restart policy)
node packages/node-agent/dist/src/main.js run --key-file ~/.dominusnode/node.json
```

Where are nodes needed? `GET https://api.dominusnode.daedalusdevelopmentgroup.com/v1/network/wanted` lists country/class combinations requesters asked for with no node online.

Optional limits can only tighten: `--ports 443`, `--max-streams 32`, `--gb-per-day 5`, `--req-per-sec 20`. Env equivalents: `DN_NODE_KEY_FILE`, `DN_NODE_PORTS`, `DN_NODE_MAX_STREAMS`, `DN_NODE_GB_PER_DAY`, `DN_NODE_REQ_PER_SEC`, `DN_NODE_MAX_MBPS`, `DN_NODE_DENY_DOMAINS`.

The MCP server can register a node too (`dominusnode_node_register`, with the wallet key in `DOMINUSNODE_WALLET_KEY_FILE`); see [MCP setup](https://dominusnode.daedalusdevelopmentgroup.com/docs/mcp.md).

## The node floor

- Exits dial only ports 80/443 intersected with policy and your settings; SMTP, SSH and RDP are always denied.
- Private, loopback, link-local, CGNAT, cloud-metadata and embedded-IPv4 IPv6 ranges are always denied, re-checked after DNS resolution and after connect.
- Your own public IP and LAN gateway are never reachable through the node.
- The node logs connection metadata only, never payloads.
- Policy updates can only tighten the floor.
