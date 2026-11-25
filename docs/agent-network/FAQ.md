# FAQ

## What is DominusNode?

A bandwidth relay network for AI agents only. Agents buy bandwidth through an operator-run gateway, and agents contribute the exit IPs by running the node agent. Humans use the platform only as admins.

## Can humans sign up?

No. Agents authenticate with a wallet signature and an API key (`dn_live_`). There is no email/password signup. Humans have admin access only.

## How do I start?

Follow [QUICKSTART.md](QUICKSTART.md): get a wallet-signed API key, top up or pay per request, then send traffic through the gateway with the key in the proxy password field.

## How much does it cost?

Prices per GB are set per IP class by the operator in `network_pricing` and are always readable live at `GET /v1/pricing` (and in `/.well-known/agent-tool.json`). The documented defaults are $0.50/GB residential and mobile, $0.20/GB datacenter and $0.10/GB masked. Always read the live endpoint rather than hardcoding a price. See [ECONOMICS.md](ECONOMICS.md).

## How do I pay?

Per request with x402 or MPP (no account needed), or with prepaid wallet top-ups via Tempo or NOWPayments crypto. See [PAYMENTS.md](PAYMENTS.md).

## Is my HTTPS traffic visible to the exit node?

No. HTTPS stays end-to-end TLS between you and the origin. Plain HTTP is refused unless you set `allowhttp-1`, because the exit node can read it.

## What is `class-masked`?

Exits whose egress the gateway detects as VPN, WARP or Tor. It is the cheapest class and strictly opt-in: unflagged requests never use it.

## Which countries are blocked?

OFAC-sanctioned countries: Cuba, Iran, North Korea, Russia and Syria, both as exit targets and as payers.

## How do I run a node and earn?

Run `packages/node-agent` on a residential, mobile or datacenter connection. You earn 25% (Probation) to 50% (Partner) of paid traffic through your IPs, with a 3 to 14 day maturity hold. The gateway verifies the exit class and counts the bytes; nodes are untrusted. See [DESIGN.md](DESIGN.md), [ECONOMICS.md](ECONOMICS.md) and [DEPLOYMENT.md](DEPLOYMENT.md).

## Can I withdraw earnings?

Matured credits convert into bandwidth today. USDC withdrawals are built but disabled during alpha.

## What can I not do?

Anything in the Acceptable Use Policy (`/aup`). The node floor blocks private ranges and SSRF targets and cannot be switched off. Report abuse at `/report-abuse`.

## How do I report a security issue?

See [SECURITY.md](../../SECURITY.md) and `/.well-known/security.txt`.
