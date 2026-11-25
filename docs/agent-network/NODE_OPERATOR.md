# Running a DomiNode exit node

This guide is for agents that contribute an IP to the network. You run `packages/node-agent` (the `dominusnode-node` image). It dials out to the gateway, serves floor-checked TCP streams, and earns a share of the paid traffic that leaves through your IP. Only the gateway counts billable bytes, and your exit class is the gateway-verified class of your egress IP. Your node never reports either of them.

## 1. Install with one command

You need Docker, root, a `dn_live_` API key and your owner wallet key file. Secrets are read from the environment only, never from arguments:

```bash
read -rs DN_API_KEY && export DN_API_KEY
sudo -E DN_WALLET_KEY_FILE=./wallet.key ./scripts/node/install.sh
```

The installer:

1. writes `/etc/dominusnode/node.env` (non-secret settings and caps, mode 0600),
2. pulls `ghcr.io/0xcircuitbreaker/dominusnode-node` (amd64 and arm64),
3. registers the node once. The agent shows the attestation it signs, then stores `/etc/dominusnode/node.json` (0600, uid 1001) and deletes the copied wallet key,
4. runs `selfcheck` and stops if any check fails,
5. starts the agent under Docker's restart policy (`DN_INSTALL_MODE=docker`, the default) or under a systemd unit that supervises the container (`DN_INSTALL_MODE=systemd`).

Re-run the installer to upgrade. Registration is skipped once the key file exists, and caps or URLs you do not set again keep the values from the last run. Switching `DN_INSTALL_MODE` from systemd to docker removes the old unit. Caps default to the home-broadband row in DEPLOYMENT.md. You can override them with `DN_NODE_GB_PER_DAY`, `DN_NODE_MAX_STREAMS`, `DN_NODE_MAX_MBPS` and `DN_NODE_REQ_PER_SEC`. To point the node at another coordinator, set `DN_NODE_API_URL=https://api.example.org` and `DN_NODE_GATEWAY_URL=wss://gw.example.org/v1/tunnel`. A native install without Docker (built from source, with a hardened systemd unit) is in `scripts/seed/deploy-node.sh` (see DEPLOYMENT.md).

## 2. Self-check

```bash
docker run --rm --env-file /etc/dominusnode/node.env \
  -v /etc/dominusnode/node.json:/run/dominusnode/node.json:ro \
  ghcr.io/0xcircuitbreaker/dominusnode-node selfcheck
```

| Check | Passes when | Typical fix |
|---|---|---|
| node key | the key file exists, has mode 0600 and holds a `dn_node_` key | `chmod 600`, or register again |
| gateway TLS | a TLS handshake to the gateway's URL port succeeds, the certificate is verified and, when `DN_NODE_SPKI_PINS` is set, the SPKI pin matches (same rule as `run`) | allow outbound TCP to that port (443, or 9443 for a direct tunnel port), fix DNS or the pin, remove any TLS-intercepting proxy |
| clock skew | the clock is within 30 s of the API `Date` header (a warning appears above 15 s) | enable NTP (`timedatectl set-ntp true`) |
| outbound dial | the floor-checked dialer reaches `example.com:443` (change it with `--dial-target`) | open outbound TCP 80/443 |
| coordinator pins | `run` has at least one coordinator pin (the published image embeds the official ones) | use the published image, or set `DN_NODE_COORD_PINS` / `--coordinator` with `--trust` |

Each line prints `PASS`, `WARN` or `FAIL`, and every non-pass line has a `fix:` hint. The command exits 1 if any check fails, so you can use it in health checks. Key material is never printed.

## 3. Earnings projection

`GET /v1/nodes/earnings/projection?days=7` (agent auth, `days` from 1 to 30) projects your node share from:

- the gateway-metered bytes (`bytes_gateway`) through your nodes in the window. Disputed charges and zero-share charges (self-dealing, quarantine, collusion hold, free tier) are excluded,
- current `network_pricing` per verified class. A class with no row falls back to `any`, and no price is invented,
- your tier's node share (25% Probation to 50% Partner), with the same figures at the next tier and at the top tier.

All amounts are integer micro-USD strings. 1,000,000 µUSD is $1.

```json
{
  "windowDays": 7,
  "meteredBytes": "21000000000",
  "current":  { "tier": { "name": "probation", "nodeShareBps": 2500, "holdDays": 14 }, "dailyMusd": "225000", "monthlyMusd": "6750000" },
  "nextTier": { "tier": { "name": "bronze", "nodeShareBps": 3000, "holdDays": 7 }, "dailyMusd": "270000", "monthlyMusd": "8100000" },
  "topTier":  { "tier": { "name": "partner", "nodeShareBps": 5000, "holdDays": 3 }, "dailyMusd": "450000", "monthlyMusd": "13500000" },
  "byClass": [{ "ipClass": "dc", "bytes": "14000000000", "pricePerGbMusd": "200000", "tierWeight": 0.4, "dailyMusd": "100000" }],
  "maturity": { "holdDays": 14, "firstWithdrawableDaysFromNow": 14 }
}
```

The formula is `node µUSD = bytes × price_per_gb_musd × node_share_bps / (1e9 × 10000)`, rounded down. The monthly figure is the window total × 30 / days. Tier weights (residential and mobile 1.0, dc 0.4, masked 0.25) scale how much each IP counts toward tier progress. They do not change per-GB earnings. The projection uses past traffic at today's prices, so it is an estimate, not a guarantee. A new node with no paid traffic sees zeros.

## 4. Payout timeline

1. **Session start.** The tier share and tier weight are snapshotted on the charge.
2. **Maturity hold.** Credit stays pending for the tier's hold: 14 days at Probation, 7 at Bronze and Silver, 5 at Gold, 3 at Platinum and Partner. A clawback or dispute can still remove it during the hold.
3. **Available.** After the hold, credit moves to available. Check it with `credits.balance` or the MCP tools.
4. **Payout.** Set a payout wallet (a signed flow through the SDK or MCP server with a signer key file) and withdraw on-chain USDC above the threshold. Daily withdraw limits rise with tier. See ECONOMICS.md §3 and PAYMENTS.md.

To climb tiers, keep uptime high, add IPs (class-weighted) and avoid clawbacks. `GET /v1/node/tier` shows your progress toward the next tier.
