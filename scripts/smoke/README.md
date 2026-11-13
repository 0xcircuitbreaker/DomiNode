# Relay smoke gate (staging)

`relay-smoke.sh` runs the staging smoke gate from `docs/agent-network/DESIGN.md` §15
("Rollout gate"): at least 3 healthy nodes for 2 h, plus one full
earn → mature → withdraw cycle with `maturation_hours=0` on Base Sepolia.

It exits 0 only if every check that ran passed. Checks whose inputs are missing are
reported as `SKIP`.

## Requirements

- `bash`, `curl` (with SOCKS5 and HTTPS-proxy support), `jq`
- For the withdraw step: `node` and a repo install (`npm ci`), because the script signs
  the EIP-191 challenge with `ethers` from `node_modules`.

## Before you run it

1. Staging API runs with `PAYOUTS_ENABLED=true` and `PAYOUT_ALLOW_TESTNET=true` (or a
   non-production `NODE_ENV`) so `base-sepolia` payout wallets are accepted.
2. Admin panel: set the revenue split to `maturationHours: 0` (`POST /api/admin/network/split`).
3. Start at least 3 node agents on separate IPs (different /24s, so sybil caps do not
   merge them), each with its own `dn_node_` key file (chmod 600):

   ```bash
   DN_NODE_API_URL=https://api.staging.example \
   DN_NODE_GATEWAY_URL=wss://gw.staging.example \
   DN_NODE_KEY_FILE=$HOME/.dominusnode/node.key \
   DN_NODE_COORD_PINS=<staging coordinator ed25519 pubkey, 64 hex> \
   node packages/node-agent/dist/src/main.js run
   ```

   The node owner account must have a linked wallet; its private key file is
   `NODE_OWNER_WALLET_KEY_FILE` below.

## Environment

Secrets are only read from the environment or from files; the script hands them to
curl via config on a file descriptor (`curl -K`) and request bodies via `--data @-`,
so they never appear in the process list.

| Variable | Required | Default | Meaning |
|---|---|---|---|
| `API_URL` | yes | | API base URL |
| `GATEWAY_HOST` | yes | | Gateway hostname |
| `GATEWAY_TLS_PORT` | | 8443 | TLS proxy port: all fetches and the policy refusal checks go here (self-host: 8444) |
| `PLAINTEXT_PROXY` | | 0 | 1 also tests plaintext `GATEWAY_HTTP_PORT` / `GATEWAY_SOCKS_PORT` (8080 / 1080); production gateways refuse credentials there |
| `GATEWAY_HTTP_PORT` / `GATEWAY_SOCKS_PORT` | | 8080 / 1080 | Plaintext listeners (only with `PLAINTEXT_PROXY=1`) |
| `GATEWAY_TLS_CA` | | | CA bundle for the TLS proxy listener |
| `REQUESTER_API_KEY` | yes | | Requester agent key (`dn_live_`/`dn_test_`), with balance |
| `NODE_OWNER_API_KEY` | | | Node owner's agent key; enables credits + withdraw checks |
| `NODE_OWNER_WALLET_KEY_FILE` | for withdraw | | Linked wallet private key file (signs challenges) |
| `PAYOUT_ADDRESS` | | | Base Sepolia address to register if no payout wallet exists |
| `NODE_KEY_FILES` | | | Comma-separated `dn_node_` key files (presence/mode check only) |
| `ADMIN_TOKEN` or `ADMIN_TOKEN_FILE` | | | Admin JWT; the file is re-read on every call so it can be refreshed during the 2 h run |
| `MIN_NODES` | | 3 | Healthy node threshold |
| `HEALTH_DURATION_S` / `HEALTH_INTERVAL_S` | | 7200 / 60 | Health window and sampling interval |
| `TARGET_URL` / `PLAINTEXT_URL` | | `https://example.com/` / `http://example.com/` | Fetch targets |
| `COUNTRY` | | | Optional `country-XX` username flag |
| `CREDIT_WAIT_S` | | 300 | How long to wait for charges/credits to move |
| `WITHDRAW` | | `auto` | `auto` (run if payouts enabled and maturation 0), `yes` (fail if not possible), `no` |
| `WITHDRAW_MUSD` | | 100000 | Withdraw amount in µUSD ($0.10); the server enforces its minimum |
| `PAYOUT_WAIT_S` | | 900 | How long to wait for the payout to confirm |

## Checks

1. Active + online node count (`GET /api/admin/network/nodes?status=active&online=true`) ≥ `MIN_NODES`
   on every sample for `HEALTH_DURATION_S`.
2. `TARGET_URL` fetched through the HTTP proxy, SOCKS5 (`socks5h`) and the TLS proxy.
3. `PLAINTEXT_URL` without `allowhttp-1` is refused.
4. `169.254.169.254` is refused over HTTPS and over plaintext with `allowhttp-1`.
5. `traffic.24h.charges` in `GET /api/admin/network/overview` increases, and the node owner's
   `pending + available` in `GET /v1/credits` increases.
6. Withdraw: registers a `base-sepolia` payout wallet if needed, signs
   `POST /v1/credits/withdraw/challenge`, calls `POST /v1/credits/withdraw`, then polls
   `GET /v1/payouts` until the payout is `confirmed`. It refuses to withdraw to a
   non-testnet payout wallet.

## Example

```bash
export API_URL=https://api.staging.example GATEWAY_HOST=gw.staging.example
export REQUESTER_API_KEY NODE_OWNER_API_KEY   # set from your secret store, not on the command line
export ADMIN_TOKEN_FILE=$HOME/.dominusnode/admin.jwt
export NODE_OWNER_WALLET_KEY_FILE=$HOME/.dominusnode/wallet.key
scripts/smoke/relay-smoke.sh
```
