#!/usr/bin/env bash
# Staging smoke gate for the agent relay network (DESIGN.md section 15, "Rollout gate").
#
# Checks, in order:
#   1. at least MIN_NODES healthy (active + online) nodes for HEALTH_DURATION_S
#   2. HTTPS fetch through the gateway's TLS proxy (GATEWAY_TLS_PORT); the
#      plaintext HTTP proxy and SOCKS5 ports only with PLAINTEXT_PROXY=1 (a
#      production gateway refuses credentials there: PROXY_REQUIRE_TLS)
#   3. plaintext http:// is refused without allowhttp-1 (PLAINTEXT_DISABLED)
#   4. cloud metadata IP (169.254.169.254) is refused (TARGET_BLOCKED)
#   Refusal checks go through the TLS proxy and pass only on the expected
#   X-DominusNode-Error code, never on an unrelated 403 (e.g. "TLS required").
#   5. relay_charges (admin overview) and node-owner credits move after traffic
#   6. optional: one testnet (base-sepolia) withdrawal when payouts are enabled
#      and maturation_hours = 0
#
# All secrets come from environment variables or files. They are passed to curl
# through config on a file descriptor (curl -K) or stdin (--data @-), never argv.
# See scripts/smoke/README.md for the full variable list.

set -euo pipefail
umask 077

# ── configuration ─────────────────────────────────────────────────────────────
API_URL="${API_URL:?set API_URL, e.g. https://api.staging.example}"
GATEWAY_HOST="${GATEWAY_HOST:?set GATEWAY_HOST}"
GATEWAY_HTTP_PORT="${GATEWAY_HTTP_PORT:-8080}"
GATEWAY_SOCKS_PORT="${GATEWAY_SOCKS_PORT:-1080}"
GATEWAY_TLS_PORT="${GATEWAY_TLS_PORT:-8443}"       # 8443 compose/prod, 8444 self-host
PLAINTEXT_PROXY="${PLAINTEXT_PROXY:-0}"            # 1: also test plaintext 8080/1080 (dev, TLS_MODE=off)
GATEWAY_TLS_CA="${GATEWAY_TLS_CA:-}"            # optional CA bundle for the TLS proxy
REQUESTER_API_KEY="${REQUESTER_API_KEY:?set REQUESTER_API_KEY (dn_live_/dn_test_)}"
NODE_OWNER_API_KEY="${NODE_OWNER_API_KEY:-}"      # agent key of the node owner (credits checks)
NODE_KEY_FILES="${NODE_KEY_FILES:-}"              # comma-separated dn_node_ key files of the staging nodes
ADMIN_TOKEN="${ADMIN_TOKEN:-}"                    # admin JWT access token, or
ADMIN_TOKEN_FILE="${ADMIN_TOKEN_FILE:-}"          # a file holding it (re-read on every call so it can be refreshed)
MIN_NODES="${MIN_NODES:-3}"
HEALTH_DURATION_S="${HEALTH_DURATION_S:-7200}"    # 2 h per the smoke gate
HEALTH_INTERVAL_S="${HEALTH_INTERVAL_S:-60}"
TARGET_URL="${TARGET_URL:-https://example.com/}"
PLAINTEXT_URL="${PLAINTEXT_URL:-http://example.com/}"
COUNTRY="${COUNTRY:-}"                             # optional country-XX flag
CREDIT_WAIT_S="${CREDIT_WAIT_S:-300}"
WITHDRAW="${WITHDRAW:-auto}"                       # auto | yes | no
WITHDRAW_MUSD="${WITHDRAW_MUSD:-100000}"           # $0.10 (server enforces its own minimum)
NODE_OWNER_WALLET_KEY_FILE="${NODE_OWNER_WALLET_KEY_FILE:-}"  # linked wallet private key file (signs withdraw)
PAYOUT_ADDRESS="${PAYOUT_ADDRESS:-}"               # base-sepolia payout address to register if none
PAYOUT_WAIT_S="${PAYOUT_WAIT_S:-900}"
REPO_ROOT="${REPO_ROOT:-$(cd "$(dirname "$0")/../.." && pwd)}"

PASS=0
FAIL=0
SKIP=0

log() { printf '%s %s\n' "$(date -u +%H:%M:%S)" "$*" >&2; }
pass() { PASS=$((PASS + 1)); log "PASS $*"; }
fail() { FAIL=$((FAIL + 1)); log "FAIL $*"; }
skip() { SKIP=$((SKIP + 1)); log "SKIP $*"; }
die() { log "FATAL $*"; exit 2; }

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT INT TERM

for bin in curl jq; do command -v "$bin" >/dev/null || die "$bin is required"; done

for n in MIN_NODES HEALTH_DURATION_S HEALTH_INTERVAL_S CREDIT_WAIT_S PAYOUT_WAIT_S WITHDRAW_MUSD \
  GATEWAY_HTTP_PORT GATEWAY_SOCKS_PORT GATEWAY_TLS_PORT; do
  [[ "${!n}" =~ ^[0-9]+$ ]] || die "$n must be a non-negative integer"
done
((HEALTH_INTERVAL_S > 0)) || die "HEALTH_INTERVAL_S must be > 0"
[[ "$PLAINTEXT_PROXY" =~ ^[01]$ ]] || die "PLAINTEXT_PROXY must be 0 or 1"

# Redact anything key-like before it reaches the log.
scrub() {
  sed -E 's/dn_(live|test|node|proxy)_[A-Za-z0-9_-]+/dn_\1_[REDACTED]/g; s/eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/[JWT]/g'
}

admin_token() {
  if [[ -n "$ADMIN_TOKEN_FILE" ]]; then tr -d '\r\n' <"$ADMIN_TOKEN_FILE"; else printf '%s' "$ADMIN_TOKEN"; fi
}
have_admin() { [[ -n "$ADMIN_TOKEN" || -n "$ADMIN_TOKEN_FILE" ]]; }

# api METHOD PATH TOKEN [JSON_BODY]  -> prints body; status via api_status
API_STATUS=0
api() {
  local method="$1" path="$2" token="$3" body="${4:-}" out
  out="$(mktemp "$WORK/resp.XXXXXX")"
  if [[ -n "$body" ]]; then
    API_STATUS="$(printf '%s' "$body" | curl -sS -o "$out" -w '%{http_code}' -X "$method" \
      -K <(printf 'header = "Authorization: Bearer %s"\n' "$token") \
      -H 'Content-Type: application/json' --data @- "$API_URL$path")" || API_STATUS=000
  else
    API_STATUS="$(curl -sS -o "$out" -w '%{http_code}' -X "$method" \
      -K <(printf 'header = "Authorization: Bearer %s"\n' "$token") "$API_URL$path")" || API_STATUS=000
  fi
  printf '%s' "$API_STATUS" >"$WORK/status"
  cat "$out"
  rm -f "$out"
}
# api runs inside $(...) so its status variable does not survive; read it back from the file.
api_status() { cat "$WORK/status" 2>/dev/null || printf 000; }

proxy_user() {
  local flags="${1:-}"
  local u="user"
  [[ -n "$COUNTRY" ]] && u="$u-country-$COUNTRY"
  [[ -n "$flags" ]] && u="$u-$flags"
  printf '%s' "$u"
}

# proxy_fetch SCHEME PORT URL [FLAGS]
#   -> prints "<http_code> <connect_code> <exit> <X-DominusNode-Error or ->"
# The headers file includes the proxy's CONNECT response (curl -D).
proxy_fetch() {
  local scheme="$1" port="$2" url="$3" flags="${4:-}" code rc=0 hdr err
  local extra=()
  [[ "$scheme" == https && -n "$GATEWAY_TLS_CA" ]] && extra+=(--proxy-cacert "$GATEWAY_TLS_CA")
  hdr="$(mktemp "$WORK/hdr.XXXXXX")"
  code="$(curl -sS -o /dev/null -D "$hdr" --max-time 60 -w '%{http_code} %{http_connect}' "${extra[@]}" \
    -K <(printf 'proxy = "%s://%s:%s"\nproxy-user = "%s:%s"\n' \
      "$scheme" "$GATEWAY_HOST" "$port" "$(proxy_user "$flags")" "$REQUESTER_API_KEY") \
    "$url" 2>/dev/null)" || rc=$?
  err="$(proxy_error_code <"$hdr")"
  rm -f "$hdr"
  printf '%s %s %s\n' "${code:-000 000}" "$rc" "${err:--}"
}

# First X-DominusNode-Error value in a header dump (stdin).
proxy_error_code() {
  tr -d '\r' | sed -n 's/^[Xx]-[Dd]ominus[Nn]ode-[Ee]rror: *\([A-Z0-9_]*\).*/\1/p' | head -n1
}

overview_charges() {
  api GET /api/admin/network/overview "$(admin_token)" | jq -r '.traffic["24h"].charges // empty'
}

owner_credits_musd() {
  api GET /v1/credits "$NODE_OWNER_API_KEY" | jq -r '((.pending.musd // "0") | tonumber) + ((.available.musd // "0") | tonumber)'
}

# sign_message KEYFILE  (message on stdin) -> 0x signature; needs ethers from the repo install
sign_message() {
  (cd "$REPO_ROOT" && SIGN_KEY_FILE="$1" node -e '
    const fs = require("fs");
    const { Wallet } = require("ethers");
    const key = fs.readFileSync(process.env.SIGN_KEY_FILE, "utf8").trim();
    const msg = fs.readFileSync(0, "utf8");
    new Wallet(key.startsWith("0x") ? key : "0x" + key).signMessage(msg).then((s) => process.stdout.write(s));
  ')
}

# ── 0. node key files ─────────────────────────────────────────────────────────
if [[ -n "$NODE_KEY_FILES" ]]; then
  IFS=',' read -r -a files <<<"$NODE_KEY_FILES"
  for f in "${files[@]}"; do
    if [[ ! -r "$f" ]]; then fail "node key file $f is not readable"; continue; fi
    perm="$(stat -c '%a' "$f" 2>/dev/null || stat -f '%Lp' "$f")"
    [[ "$perm" == 600 || "$perm" == 400 ]] || log "WARN $f has mode $perm (expected 600)"
  done
  ((${#files[@]} >= MIN_NODES)) || log "WARN only ${#files[@]} node key files for MIN_NODES=$MIN_NODES"
else
  log "NODE_KEY_FILES not set: start $MIN_NODES node agents yourself (see README) before running"
fi

# ── 1. healthy nodes over time ────────────────────────────────────────────────
if have_admin; then
  deadline=$((SECONDS + HEALTH_DURATION_S))
  samples=0
  bad=0
  while :; do
    online="$(api GET '/api/admin/network/nodes?status=active&online=true&limit=1' "$(admin_token)" | jq -r '.total // empty')"
    samples=$((samples + 1))
    if [[ "$(api_status)" != 200 || -z "$online" ]]; then
      bad=$((bad + 1)); log "health sample $samples: admin API status $(api_status)"
    elif ((online < MIN_NODES)); then
      bad=$((bad + 1)); log "health sample $samples: $online/$MIN_NODES nodes online"
    else
      log "health sample $samples: $online nodes online"
    fi
    ((SECONDS >= deadline)) && break
    sleep "$HEALTH_INTERVAL_S"
  done
  if ((bad == 0)); then pass "$MIN_NODES+ healthy nodes for ${HEALTH_DURATION_S}s ($samples samples)"
  else fail "node health: $bad of $samples samples below $MIN_NODES"; fi
else
  skip "node health (set ADMIN_TOKEN or ADMIN_TOKEN_FILE)"
fi

charges_before=""
credits_before=""
have_admin && charges_before="$(overview_charges || true)"
[[ -n "$NODE_OWNER_API_KEY" ]] && credits_before="$(owner_credits_musd || true)"

# ── 2. HTTPS fetches ──────────────────────────────────────────────────────────
check_ok() {
  local label="$1" res code
  res="$2"
  code="${res%% *}"
  if [[ "$code" =~ ^2|^3 ]]; then pass "$label ($res)"; else fail "$label ($res)"; fi
}
check_ok "HTTPS via TLS proxy" "$(proxy_fetch https "$GATEWAY_TLS_PORT" "$TARGET_URL")"
if [[ "$PLAINTEXT_PROXY" == 1 ]]; then
  check_ok "HTTPS via plaintext HTTP proxy" "$(proxy_fetch http "$GATEWAY_HTTP_PORT" "$TARGET_URL")"
  check_ok "HTTPS via SOCKS5" "$(proxy_fetch socks5h "$GATEWAY_SOCKS_PORT" "$TARGET_URL")"
else
  skip "plaintext HTTP proxy and SOCKS5 ports (PLAINTEXT_PROXY=1 to test; production refuses credentials there)"
fi

# ── 3. plaintext refusal / 4. metadata refusal ────────────────────────────────
# check_refused LABEL "<proxy_fetch output>" EXPECTED_CODE...
# Passes only when the gateway answered with one of the expected policy codes:
# any other refusal (TLS required, auth, rate limit) means the policy under test
# never ran, so the check fails instead of passing vacuously.
check_refused() {
  local label="$1" res="$2" code connect err want
  shift 2
  read -r code connect _ err <<<"$res"
  if [[ "$code" == 000 && "$connect" == 000 ]]; then fail "$label: no response from gateway ($res)"; return; fi
  if [[ "$code" =~ ^2 && "$connect" =~ ^(000|200)$ ]]; then fail "$label was NOT refused ($res)"; return; fi
  for want in "$@"; do
    if [[ "$err" == "$want" ]]; then pass "$label refused with $err ($res)"; return; fi
  done
  fail "$label: refused for another reason (X-DominusNode-Error ${err}, want $*): policy not exercised ($res)"
}
check_refused "plaintext http without allowhttp-1" "$(proxy_fetch https "$GATEWAY_TLS_PORT" "$PLAINTEXT_URL")" PLAINTEXT_DISABLED
check_refused "metadata IP over HTTPS" "$(proxy_fetch https "$GATEWAY_TLS_PORT" "https://169.254.169.254/latest/meta-data/")" TARGET_BLOCKED
check_refused "metadata IP over plaintext (allowhttp-1)" \
  "$(proxy_fetch https "$GATEWAY_TLS_PORT" "http://169.254.169.254/latest/meta-data/" allowhttp-1)" TARGET_BLOCKED

# ── 5. charges and credits progression ────────────────────────────────────────
waited=0
charges_ok=""
credits_ok=""
while ((waited <= CREDIT_WAIT_S)); do
  if have_admin && [[ -z "$charges_ok" && -n "$charges_before" ]]; then
    now="$(overview_charges || true)"
    [[ -n "$now" ]] && ((now > charges_before)) && charges_ok="$charges_before -> $now"
  fi
  if [[ -n "$NODE_OWNER_API_KEY" && -z "$credits_ok" && -n "$credits_before" ]]; then
    now="$(owner_credits_musd || true)"
    [[ -n "$now" ]] && ((now > credits_before)) && credits_ok="$credits_before -> $now µUSD"
  fi
  { (have_admin && [[ -z "$charges_ok" ]]) || [[ -n "$NODE_OWNER_API_KEY" && -z "$credits_ok" ]]; } || break
  sleep 15
  waited=$((waited + 15))
done
if have_admin; then
  if [[ -n "$charges_ok" ]]; then pass "relay_charges increased ($charges_ok)"; else fail "relay_charges did not increase within ${CREDIT_WAIT_S}s"; fi
else skip "relay_charges progression (no admin token)"; fi
if [[ -n "$NODE_OWNER_API_KEY" ]]; then
  if [[ -n "$credits_ok" ]]; then pass "node owner credits increased ($credits_ok)"; else fail "node owner credits did not increase within ${CREDIT_WAIT_S}s"; fi
else skip "credits progression (set NODE_OWNER_API_KEY)"; fi

# ── 6. testnet withdrawal ─────────────────────────────────────────────────────
withdraw_cycle() {
  local credits maturation enabled
  credits="$(api GET /v1/credits "$NODE_OWNER_API_KEY")"
  enabled="$(jq -r '.payoutsEnabled' <<<"$credits")"
  maturation="$(api GET /api/admin/network/split "$(admin_token)" | jq -r '.current.maturationHours // empty')"
  if [[ "$enabled" != true || "$maturation" != 0 ]]; then
    if [[ "$WITHDRAW" == yes ]]; then fail "withdraw requested but payoutsEnabled=$enabled maturation_hours=$maturation"
    else skip "withdraw (payoutsEnabled=$enabled maturation_hours=${maturation:-unknown})"; fi
    return
  fi
  [[ -r "$NODE_OWNER_WALLET_KEY_FILE" ]] || { fail "withdraw needs NODE_OWNER_WALLET_KEY_FILE"; return; }

  local pw chain
  pw="$(api GET /v1/payout-wallet "$NODE_OWNER_API_KEY")"
  chain="$(jq -r '.payoutWallet.chain // empty' <<<"$pw")"
  if [[ -z "$chain" ]]; then
    [[ "$PAYOUT_ADDRESS" =~ ^0x[0-9a-fA-F]{40}$ ]] || { fail "no payout wallet; set PAYOUT_ADDRESS to register one on base-sepolia"; return; }
    local ch msg nonce sig
    ch="$(api POST /v1/payout-wallet/challenge "$NODE_OWNER_API_KEY" \
      "$(jq -nc --arg a "${PAYOUT_ADDRESS,,}" '{address:$a, chain:"base-sepolia"}')")"
    [[ "$(api_status)" == 200 || "$(api_status)" == 201 ]] || { fail "payout wallet challenge: $(api_status) $(scrub <<<"$ch")"; return; }
    msg="$(jq -r .message <<<"$ch")"; nonce="$(jq -r .nonce <<<"$ch")"
    sig="$(printf '%s' "$msg" | sign_message "$NODE_OWNER_WALLET_KEY_FILE")"
    pw="$(api PUT /v1/payout-wallet "$NODE_OWNER_API_KEY" \
      "$(jq -nc --arg a "${PAYOUT_ADDRESS,,}" --arg n "$nonce" --arg s "$sig" '{address:$a, chain:"base-sepolia", nonce:$n, signature:$s}')")"
    [[ "$(api_status)" == 200 || "$(api_status)" == 201 ]] || { fail "register payout wallet: $(api_status) $(scrub <<<"$pw")"; return; }
    chain=base-sepolia
  fi
  [[ "$chain" == base-sepolia ]] || { fail "payout wallet is on $chain, refusing a non-testnet withdraw"; return; }

  local key ch msg nonce sig res id status deadline
  key="smoke-$(date -u +%Y%m%d%H%M%S)-$RANDOM"
  ch="$(api POST /v1/credits/withdraw/challenge "$NODE_OWNER_API_KEY" \
    "$(jq -nc --arg m "$WITHDRAW_MUSD" --arg k "$key" '{amountMusd:$m, idempotencyKey:$k}')")"
  [[ "$(api_status)" == 200 || "$(api_status)" == 201 ]] || { fail "withdraw challenge: $(api_status) $(scrub <<<"$ch")"; return; }
  msg="$(jq -r .message <<<"$ch")"; nonce="$(jq -r .nonce <<<"$ch")"
  sig="$(printf '%s' "$msg" | sign_message "$NODE_OWNER_WALLET_KEY_FILE")"
  res="$(api POST /v1/credits/withdraw "$NODE_OWNER_API_KEY" \
    "$(jq -nc --arg m "$WITHDRAW_MUSD" --arg k "$key" --arg n "$nonce" --arg s "$sig" '{amountMusd:$m, idempotencyKey:$k, nonce:$n, signature:$s}')")"
  [[ "$(api_status)" == 201 || "$(api_status)" == 200 ]] || { fail "withdraw: $(api_status) $(scrub <<<"$res")"; return; }
  id="$(jq -r .payout.id <<<"$res")"
  log "payout $id created; waiting up to ${PAYOUT_WAIT_S}s for confirmation"
  deadline=$((SECONDS + PAYOUT_WAIT_S))
  while ((SECONDS < deadline)); do
    status="$(api GET '/v1/payouts?limit=50' "$NODE_OWNER_API_KEY" | jq -r --arg id "$id" '.payouts[] | select(.id == $id) | "\(.status) \(.txHash // "")"')"
    case "$status" in
      confirmed*) pass "testnet withdraw confirmed ($status)"; return ;;
      failed* | reversed*) fail "testnet withdraw $status"; return ;;
    esac
    sleep 20
  done
  fail "testnet withdraw not confirmed in ${PAYOUT_WAIT_S}s (last: ${status:-unknown})"
}

if [[ "$WITHDRAW" == no ]]; then skip "withdraw (WITHDRAW=no)"
elif [[ -z "$NODE_OWNER_API_KEY" ]] || ! have_admin; then skip "withdraw (needs NODE_OWNER_API_KEY and admin token)"
else withdraw_cycle; fi

log "summary: $PASS passed, $FAIL failed, $SKIP skipped"
((FAIL == 0))
