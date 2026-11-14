#!/usr/bin/env bash
# Gateway VPS preflight (DEPLOYMENT.md "Gateway VPS checklist").
#
#   ./scripts/selfhost/preflight.sh          # reads RELAY_HOST, PROXY_HOST,
#                                            # GATEWAY_DATABASE_URL from .env
#
# Read-only: changes nothing. Checks, for a ROLE=gateway box:
#   dns    RELAY_HOST and PROXY_HOST resolve (A) to this host's public IPv4 and
#          not to a Cloudflare proxy address (they must be DNS-only, grey cloud)
#   ports  TCP 80 443 8443 1443 9443 free or held by Docker/Caddy, allowed by ufw
#   wg     WireGuard interface up with a recent handshake (< 180 s)
#   db     GATEWAY_DATABASE_URL host is routed over the WireGuard interface
#          and its port accepts TCP
#   clock  NTP synchronised
#   disk   at least PREFLIGHT_MIN_DISK_GB (default 10) free under the repo
# Overrides: PUBLIC_IP (this host's public IPv4, default: first global address),
# WG_IF (default wg0), RELAY_HOST, PROXY_HOST, GATEWAY_DATABASE_URL.
# Exit status: 0 when every check passes, 1 otherwise. Warnings do not fail.
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
ENV_FILE="$ROOT/.env"
case "${1:-}" in
  -h|--help) sed -n '2,20p' "$0"; exit 0 ;;
  "") ;;
  *) echo "unknown option: $1" >&2; exit 2 ;;
esac

env_get() {
  [ -f "$ENV_FILE" ] || return 0
  grep -E "^$1=" "$ENV_FILE" | tail -n1 | cut -d= -f2- || true
}
FAILS=0
ok()   { printf 'ok    %-5s %s\n' "$1" "$2"; }
warn() { printf 'warn  %-5s %s\n' "$1" "$2"; }
fail() { printf 'FAIL  %-5s %s\n' "$1" "$2"; FAILS=$((FAILS + 1)); }
has()  { command -v "$1" >/dev/null 2>&1; }

ipv4_ok() {
  printf '%s' "$1" | grep -Eq '^([0-9]{1,3}\.){3}[0-9]{1,3}$' || return 1
  local IFS=. o
  for o in $1; do [ "$o" -le 255 ] || return 1; done
}
ip2int() { local IFS=. a b c d; read -r a b c d <<<"$1"; echo $(((a << 24) + (b << 16) + (c << 8) + d)); }
in_cidr() {
  local net="${2%/*}" bits="${2#*/}" mask
  mask=$(((0xffffffff << (32 - bits)) & 0xffffffff))
  [ $(($(ip2int "$1") & mask)) -eq $(($(ip2int "$net") & mask)) ]
}
# Cloudflare's published proxy ranges (https://www.cloudflare.com/ips-v4).
CF_V4="173.245.48.0/20 103.21.244.0/22 103.22.200.0/22 103.31.4.0/22 141.101.64.0/18 108.162.192.0/18 190.93.240.0/20 188.114.96.0/20 197.234.240.0/22 198.41.128.0/17 162.158.0.0/15 104.16.0.0/13 104.24.0.0/14 172.64.0.0/13 131.0.72.0/22"
is_cloudflare() { local c; for c in $CF_V4; do in_cidr "$1" "$c" && return 0; done; return 1; }

ROLE="${ROLE:-$(env_get ROLE)}"
if [ -n "$ROLE" ] && [ "$ROLE" != gateway ]; then
  warn role "ROLE=$ROLE in .env; these checks are written for ROLE=gateway"
fi
RELAY="${RELAY_HOST:-$(env_get RELAY_HOST)}"
PROXYH="${PROXY_HOST:-$(env_get PROXY_HOST)}"
DB_URL="${GATEWAY_DATABASE_URL:-$(env_get GATEWAY_DATABASE_URL)}"
WG_IF="${WG_IF:-wg0}"
printf '%s' "$WG_IF" | grep -Eq '^[A-Za-z0-9_.-]{1,15}$' || { echo "invalid WG_IF" >&2; exit 2; }
MIN_GB="${PREFLIGHT_MIN_DISK_GB:-10}"
case "$MIN_GB" in ''|*[!0-9]*) echo "PREFLIGHT_MIN_DISK_GB must be a whole number" >&2; exit 2 ;; esac

# ─── dns ────────────────────────────────────────────────────────────
PUB_IP="${PUBLIC_IP:-}"
if [ -z "$PUB_IP" ] && has ip; then
  PUB_IP="$(ip -4 -o addr show scope global 2>/dev/null | awk '{print $4}' | cut -d/ -f1 |
    grep -Ev '^(10\.|192\.168\.|172\.(1[6-9]|2[0-9]|3[01])\.|100\.(6[4-9]|[7-9][0-9]|1[01][0-9]|12[0-7])\.)' | head -n1)"
fi
if [ -n "$PUB_IP" ] && ! ipv4_ok "$PUB_IP"; then echo "PUBLIC_IP must be an IPv4 address" >&2; exit 2; fi
[ -n "$PUB_IP" ] || warn dns "no public IPv4 on an interface (NAT?); set PUBLIC_IP to compare DNS"
for pair in "RELAY_HOST:$RELAY" "PROXY_HOST:$PROXYH"; do
  name="${pair%%:*}" host="${pair#*:}"
  if [ -z "$host" ]; then fail dns "$name is not set (.env or environment)"; continue; fi
  addrs="$(getent ahostsv4 "$host" 2>/dev/null | awk '{print $1}' | sort -u)"
  if [ -z "$addrs" ]; then fail dns "$name $host does not resolve (A record)"; continue; fi
  bad=0
  for a in $addrs; do
    if is_cloudflare "$a"; then
      fail dns "$name $host -> $a is a Cloudflare proxy address: set the record to DNS only (grey cloud)"; bad=1
    elif [ -n "$PUB_IP" ] && [ "$a" != "$PUB_IP" ]; then
      fail dns "$name $host -> $a, not this host ($PUB_IP)"; bad=1
    fi
  done
  if [ "$bad" -eq 0 ]; then ok dns "$name $host -> $(echo "$addrs" | tr '\n' ' ')"; fi
done

# ─── ports ──────────────────────────────────────────────────────────
LISTEN=""
if has ss; then LISTEN="$(ss -Hltnp 2>/dev/null || true)"; fi
UFW=""
if has ufw; then UFW="$(ufw status 2>/dev/null || true)"; fi
for port in 80 443 8443 1443 9443; do
  line="$(printf '%s\n' "$LISTEN" | awk -v p=":$port" '$4 ~ p"$"' | head -n1)"
  if [ -z "$line" ]; then
    ok ports "tcp/$port free"
  elif printf '%s' "$line" | grep -Eq 'docker-proxy|caddy|node'; then
    ok ports "tcp/$port held by the stack"
  else
    fail ports "tcp/$port held by another process: $(printf '%s' "$line" | grep -Eo 'users:\(\("[^"]+"' | cut -d'"' -f2)"
  fi
  if printf '%s' "$UFW" | grep -q '^Status: active' && ! printf '%s' "$UFW" | grep -Eq "^$port(/tcp)?[[:space:]]+ALLOW"; then
    fail ports "ufw is active and does not allow tcp/$port"
  fi
done
[ -n "$LISTEN" ] || warn ports "ss not available: listener check skipped"
warn ports "inbound reachability is not provable from this box; also check the provider firewall"

# ─── wg ─────────────────────────────────────────────────────────────
if ! has wg; then
  fail wg "wireguard-tools (wg) not installed"
else
  hs="$(wg show "$WG_IF" latest-handshakes 2>/dev/null | awk '{print $2}' | sort -n | tail -n1)"
  now="$(date +%s)"
  if [ -z "$hs" ]; then
    fail wg "$WG_IF is not up or has no peer (systemctl enable --now wg-quick@$WG_IF)"
  elif [ "$hs" -eq 0 ]; then
    fail wg "$WG_IF peer has never completed a handshake"
  elif [ $((now - hs)) -gt 180 ]; then
    fail wg "$WG_IF last handshake $((now - hs)) s ago (> 180 s); check Endpoint / UDP 51820 / PersistentKeepalive"
  else
    ok wg "$WG_IF handshake $((now - hs)) s ago"
  fi
fi

# ─── db ─────────────────────────────────────────────────────────────
if [ -z "$DB_URL" ]; then
  fail db "GATEWAY_DATABASE_URL is not set"
else
  hp="$(printf '%s' "$DB_URL" | sed -nE 's#^postgresql://[^@]+@([0-9.]+):([0-9]{1,5})/.*#\1 \2#p')"
  db_ip="${hp% *}" db_port="${hp#* }"
  if [ -z "$hp" ] || ! ipv4_ok "$db_ip"; then
    fail db "GATEWAY_DATABASE_URL host must be an IPv4 WireGuard address"
  else
    dev=""
    if has ip; then dev="$(ip -o route get "$db_ip" 2>/dev/null | sed -nE 's/.* dev ([^ ]+).*/\1/p' | head -n1)"; fi
    if [ "$dev" != "$WG_IF" ]; then
      fail db "$db_ip is routed via ${dev:-nothing}, not $WG_IF: Postgres must be reached over WireGuard only"
    elif timeout 5 bash -c "exec 3<>/dev/tcp/$db_ip/$db_port" 2>/dev/null; then
      ok db "$db_ip:$db_port reachable over $WG_IF"
    else
      fail db "$db_ip:$db_port does not accept TCP over $WG_IF (coordinator DB_WG_BIND, DOCKER-USER rules)"
    fi
  fi
fi

# ─── clock ──────────────────────────────────────────────────────────
if has timedatectl; then
  case "$(timedatectl show -p NTPSynchronized --value 2>/dev/null)" in
    yes) ok clock "NTP synchronised" ;;
    *) fail clock "clock not NTP-synchronised (timedatectl set-ntp true); signed CHALLENGEs and JWTs need a correct clock" ;;
  esac
else
  warn clock "timedatectl not available: check NTP by hand"
fi

# ─── disk ───────────────────────────────────────────────────────────
free_kb="$(df -Pk "$ROOT" 2>/dev/null | awk 'NR==2 {print $4}')"
if [ -z "$free_kb" ]; then
  warn disk "df failed"
elif [ "$free_kb" -lt $((MIN_GB * 1024 * 1024)) ]; then
  fail disk "$((free_kb / 1024 / 1024)) GB free under $ROOT (< $MIN_GB GB)"
else
  ok disk "$((free_kb / 1024 / 1024)) GB free"
fi

if [ "$FAILS" -gt 0 ]; then
  echo "preflight: $FAILS check(s) failed"
  exit 1
fi
echo "preflight: all checks passed"
