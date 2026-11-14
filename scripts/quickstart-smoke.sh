#!/usr/bin/env bash
# Five-minute agent quickstart smoke check (docs/agent-network/QUICKSTART.md).
#
#   1. GET /v1/policy            (public)
#   2. GET /v1/pricing           (public)
#   3. wallet balance            (GET /v1/wallet, raw API key; no token minted)
#   4. one fetch through the TLS (HTTPS) proxy on 8443
#
# The API key comes from DOMINUSNODE_API_KEY only. It reaches curl through
# stdin or a config file descriptor, never argv. On each failure the script
# prints the next step and exits non-zero.
#
# Optional: DN_API_URL, DN_PROXY_HOST, DN_PROXY_PORT (8443), DN_FLAGS (relay),
# DN_TARGET_URL, DN_CA_BUNDLE, DN_TIMEOUT_S (20).

set -euo pipefail
umask 077

DN_API_URL="${DN_API_URL:-https://api.dominusnode.com}"
DN_PROXY_HOST="${DN_PROXY_HOST:-proxy.dominusnode.com}"
DN_PROXY_PORT="${DN_PROXY_PORT:-8443}"   # HTTPS proxy; SOCKS5-TLS is 1443, node tunnel 9443
DN_FLAGS="${DN_FLAGS:-relay}"
DN_TARGET_URL="${DN_TARGET_URL:-https://example.com/}"
DN_CA_BUNDLE="${DN_CA_BUNDLE:-}"
DN_TIMEOUT_S="${DN_TIMEOUT_S:-20}"
STATUS_URL="${DN_API_URL%/}/status"

say() { printf '%s\n' "$*"; }
ok() { say "ok    $*"; }
fail() {
  say "FAIL  $1" >&2
  shift
  for line in "$@"; do say "      next: $line" >&2; done
  exit 1
}
die() { say "error $*" >&2; exit 2; }

command -v curl >/dev/null || die "curl is required"
command -v jq >/dev/null || die "jq is required"
if ! [[ "$DN_PROXY_PORT" =~ ^[0-9]{1,5}$ ]] || ((10#$DN_PROXY_PORT < 1 || 10#$DN_PROXY_PORT > 65535)); then
  die "DN_PROXY_PORT must be a port number"
fi
if ! [[ "$DN_TIMEOUT_S" =~ ^[0-9]{1,3}$ ]] || ((10#$DN_TIMEOUT_S < 1)); then
  die "DN_TIMEOUT_S must be 1..999"
fi
[[ "$DN_API_URL" =~ ^https?://[A-Za-z0-9.:-]+/?$ ]] || die "DN_API_URL must be an origin like https://api.example.org"
[[ "$DN_PROXY_HOST" =~ ^[A-Za-z0-9.-]+$ ]] || die "DN_PROXY_HOST must be a hostname"
[[ "$DN_FLAGS" =~ ^[A-Za-z0-9-]+$ ]] || die "DN_FLAGS must be hyphen-joined flags (e.g. country-US-class-dc) or relay"
[[ "$DN_TARGET_URL" =~ ^https?:// ]] || die "DN_TARGET_URL must be an http(s) URL"
DN_API_URL="${DN_API_URL%/}"
[[ -z "$DN_CA_BUNDLE" || -r "$DN_CA_BUNDLE" ]] || die "DN_CA_BUNDLE must be a readable file"

KEY="${DOMINUSNODE_API_KEY:-}"
[[ -n "$KEY" ]] || fail "DOMINUSNODE_API_KEY is not set" \
  "create a key after wallet sign-in (docs/agent-network/QUICKSTART.md, minute 1-3)" \
  "or skip keys and pay per request with x402: ${DN_API_URL}/api/x402/info"
[[ "$KEY" =~ ^dn_(live|test)_[A-Za-z0-9_-]+$ ]] || fail "DOMINUSNODE_API_KEY is not a dn_live_/dn_test_ key" \
  "copy the full key, starting with dn_live_"

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT INT TERM

CURL=(curl -sS --max-time "$DN_TIMEOUT_S" --proto "=https,http")

# 1-2. Public endpoints.
for path in /v1/policy /v1/pricing; do
  code="$("${CURL[@]}" -o "$WORK/body" -w '%{http_code}' "${DN_API_URL}${path}" || true)"
  if [[ "$code" != 200 ]] || ! jq -e . "$WORK/body" >/dev/null 2>&1; then
    fail "GET ${path} returned ${code:-no response}" \
      "check DN_API_URL (${DN_API_URL}) and your network" \
      "network status: ${STATUS_URL}"
  fi
  ok "GET ${path}"
done

# 3. Balance via GET /v1/wallet, authenticated with the raw API key. The key
# goes in a curl config on fd 3 (printf is a builtin, so it never shows in ps).
# No JWT or refresh token is minted, so nothing is left to revoke.
code="$("${CURL[@]}" -o "$WORK/wallet" -w '%{http_code}' -K /dev/fd/3 "${DN_API_URL}/v1/wallet" \
  3< <(printf 'header = "Authorization: Bearer %s"\n' "$KEY") || true)"
if [[ "$code" == 401 || "$code" == 403 ]]; then
  fail "API key rejected (HTTP ${code})" \
    "the key may be revoked or mistyped: sign in with your wallet and create a new dn_live_ key" \
    "or pay per request with x402 instead: ${DN_API_URL}/api/x402/info"
fi
[[ "$code" == 200 ]] || fail "GET /v1/wallet returned ${code:-no response}" "retry; if it persists see ${STATUS_URL}"
CENTS="$(jq -r '.balanceCents // 0' "$WORK/wallet")"
[[ "$CENTS" =~ ^[0-9]+$ ]] || CENTS=0
if ((CENTS <= 0)); then
  fail "wallet balance is 0" \
    "top up with crypto: POST ${DN_API_URL}/api/wallet/topup/crypto {\"amountUsd\":10,\"currency\":\"usdc\"} (SDK wallet.topUpCrypto, MCP topup tool)" \
    "or pay per request with x402/MPP on the proxy: ${DN_API_URL}/api/x402/info"
fi
ok "balance $(printf '%d.%02d' $((CENTS / 100)) $((CENTS % 100))) USD"

# 4. One fetch through the TLS proxy. Credentials go in a curl config on fd 3.
CA_ARGS=()
[[ -n "$DN_CA_BUNDLE" ]] && CA_ARGS=(--proxy-cacert "$DN_CA_BUNDLE")
code="$("${CURL[@]}" -o /dev/null -D "$WORK/hdr" -w '%{http_code}' "${CA_ARGS[@]}" \
  -x "https://${DN_PROXY_HOST}:${DN_PROXY_PORT}" -K /dev/fd/3 "$DN_TARGET_URL" \
  3< <(printf 'proxy-user = "%s:%s"\n' "$DN_FLAGS" "$KEY") || true)"
KEY=""
err="$(tr -d '\r' <"$WORK/hdr" | sed -n 's/^[Xx]-[Dd]ominus[Nn]ode-[Ee]rror: *//p' | tail -1 | tr -cd 'A-Z0-9_')"
case "$code:$err" in
  2??:* | 3??:*) ok "fetch ${DN_TARGET_URL} via ${DN_PROXY_HOST}:${DN_PROXY_PORT} (HTTP ${code})" ;;
  *:NO_NODES_AVAILABLE)
    fail "no exit node matches flags '${DN_FLAGS}'" \
      "drop or widen the country/class flags, or retry shortly" \
      "status page: ${STATUS_URL}; demand list: ${DN_API_URL}/v1/network/wanted" ;;
  *:INSUFFICIENT_BALANCE | *:INSUFFICIENT_FUNDS | 402:*)
    fail "payment required (${err:-402})" \
      "top up with crypto (POST ${DN_API_URL}/api/wallet/topup/crypto) or pay per request with x402: ${DN_API_URL}/api/x402/info" ;;
  407:* | *:AUTH_*)
    fail "proxy refused the credentials (${err:-HTTP 407})" "check the key and the username flags '${DN_FLAGS}'" ;;
  000:*)
    fail "could not reach the TLS proxy at ${DN_PROXY_HOST}:${DN_PROXY_PORT}" \
      "the HTTPS proxy is port 8443 (SOCKS5-TLS 1443); 8080/1080 refuse credentials in production" \
      "status page: ${STATUS_URL}" ;;
  *)
    fail "fetch failed (HTTP ${code}${err:+, ${err}})" "see the error codes in docs/agent-network/AGENT_API.md; status: ${STATUS_URL}" ;;
esac

say "done: first relayed request succeeded. Next: docs/agent-network/QUICKSTART.md#next"
