#!/usr/bin/env bash
# Gateway VPS preflight (DEPLOYMENT.md "Gateway VPS checklist").
#
#   ./scripts/selfhost/preflight.sh          # reads RELAY_HOST, PROXY_HOST,
#                                            # GATEWAY_DATABASE_URL from .env
#
# Read-only: changes nothing. Checks, for a ROLE=gateway box:
#   dns    RELAY_HOST and PROXY_HOST resolve (A) to this host's public IPv4 and
#          not to a Cloudflare proxy address (they must be DNS-only, grey cloud);
#          AAAA records must not be Cloudflare either, and one that is not this
#          host's IPv6 is a warning. Cloudflare ranges are fetched at runtime
#          (cloudflare.com/ips-v4, ips-v6); a built-in list is the fallback.
#   ports  TCP 80 443 8443 1443 9443 free or held by Docker/Caddy, allowed by ufw
#   reach  optional external check: PREFLIGHT_REACH_URL (https, with {host}
#          and {port} placeholders) is fetched per port; 2xx = reachable
#   wg     WireGuard interface up with a recent handshake (< 180 s); with
#          WG_SERVER=1, UDP WG_PORT (default 51820) listening and allowed by ufw
#   db     GATEWAY_DATABASE_URL host is routed over the WireGuard interface
#          and its port accepts TCP
#   clock  NTP synchronised
#   disk   at least PREFLIGHT_MIN_DISK_GB (default 10) free under the repo
# Overrides: PUBLIC_IP / PUBLIC_IP6 (default: first global address), WG_IF
# (default wg0), WG_SERVER, WG_PORT, RELAY_HOST, PROXY_HOST,
# GATEWAY_DATABASE_URL, PREFLIGHT_REACH_URL, PREFLIGHT_CF_FETCH=0 (offline).
# Exit status: 0 when every check passes, 1 otherwise. Warnings do not fail.
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
ENV_FILE="$ROOT/.env"
case "${1:-}" in
  -h|--help) sed -n '2,28p' "$0"; exit 0 ;;
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
# IPv6: expand to 8 hextets as 32-hex-digit string; non-zero on bad input.
expand6() {
  local a="${1,,}" head tail h out="" n i
  printf '%s' "$a" | grep -Eq '^[0-9a-f:]{2,39}$' || return 1
  case "$a" in *::*::*) return 1 ;; esac
  if [[ "$a" == *::* ]]; then head="${a%%::*}" tail="${a#*::}"; else head="$a" tail=""; fi
  local -a H T
  IFS=: read -r -a H <<<"$head"
  IFS=: read -r -a T <<<"$tail"
  n=$((8 - ${#H[@]} - ${#T[@]}))
  if [[ "$a" == *::* ]]; then [ "$n" -ge 1 ] || return 1; else [ "$n" -eq 0 ] || return 1; fi
  for h in "${H[@]}"; do [ ${#h} -le 4 ] && [ -n "$h" ] || return 1; out+="$(printf '%04x' "0x$h")"; done
  for ((i = 0; i < n; i++)); do out+="0000"; done
  for h in "${T[@]}"; do [ ${#h} -le 4 ] && [ -n "$h" ] || return 1; out+="$(printf '%04x' "0x$h")"; done
  echo "$out"
}
in_cidr6() {
  local a n bits="${2#*/}" i x y m
  a="$(expand6 "$1")" || return 1
  n="$(expand6 "${2%/*}")" || return 1
  for ((i = 0; i < 32 && bits > 0; i++, bits -= 4)); do
    x=$((16#${a:i:1})) y=$((16#${n:i:1}))
    if [ "$bits" -ge 4 ]; then m=15; else m=$(((15 << (4 - bits)) & 15)); fi
    [ $((x & m)) -eq $((y & m)) ] || return 1
  done
}
cidr4_ok() {
  ipv4_ok "${1%/*}" && [[ "$1" =~ /([0-9]{1,2})$ ]] && [ "${BASH_REMATCH[1]}" -le 32 ]
}
cidr6_ok() {
  [[ "$1" =~ ^([0-9a-fA-F:]+)/([0-9]{1,3})$ ]] && [ "${BASH_REMATCH[2]}" -le 128 ] && expand6 "${BASH_REMATCH[1]}" >/dev/null
}
# Fallback: Cloudflare's published proxy ranges (https://www.cloudflare.com/ips-v4, ips-v6).
CF_V4="173.245.48.0/20 103.21.244.0/22 103.22.200.0/22 103.31.4.0/22 141.101.64.0/18 108.162.192.0/18 190.93.240.0/20 188.114.96.0/20 197.234.240.0/22 198.41.128.0/17 162.158.0.0/15 104.16.0.0/13 104.24.0.0/14 172.64.0.0/13 131.0.72.0/22"
CF_V6="2400:cb00::/32 2606:4700::/32 2803:f800::/32 2405:b500::/32 2405:8100::/32 2a06:98c0::/29 2c0f:f248::/32"
# Fetch the live lists; every line must be a valid CIDR or the list is ignored.
cf_fetch() {
  local body line out=""
  has curl || return 1
  body="$(curl -fsS --proto =https --max-time 10 --max-filesize 65536 "https://www.cloudflare.com/$1" 2>/dev/null)" || return 1
  while IFS= read -r line; do
    line="${line%$'\r'}"
    [ -n "$line" ] || continue
    "$2" "$line" || return 1
    out+="$line "
  done <<<"$body"
  [ -n "$out" ] || return 1
  echo "$out"
}
if [ "${PREFLIGHT_CF_FETCH:-1}" = 0 ]; then
  CF_SRC="built-in (PREFLIGHT_CF_FETCH=0)"
elif v4="$(cf_fetch ips-v4 cidr4_ok)" && v6="$(cf_fetch ips-v6 cidr6_ok)"; then
  CF_V4="$v4" CF_V6="$v6" CF_SRC="cloudflare.com"
else
  CF_SRC="built-in (fetch from cloudflare.com failed)"
fi
is_cloudflare() { local c; for c in $CF_V4; do in_cidr "$1" "$c" && return 0; done; return 1; }
is_cloudflare6() { local c; for c in $CF_V6; do in_cidr6 "$1" "$c" && return 0; done; return 1; }

ROLE="${ROLE:-$(env_get ROLE)}"
if [ -n "$ROLE" ] && [ "$ROLE" != gateway ]; then
  warn role "ROLE=$ROLE in .env; these checks are written for ROLE=gateway"
fi
RELAY="${RELAY_HOST:-$(env_get RELAY_HOST)}"
PROXYH="${PROXY_HOST:-$(env_get PROXY_HOST)}"
DB_URL="${GATEWAY_DATABASE_URL:-$(env_get GATEWAY_DATABASE_URL)}"
WG_IF="${WG_IF:-wg0}"
printf '%s' "$WG_IF" | grep -Eq '^[A-Za-z0-9_.-]{1,15}$' || { echo "invalid WG_IF" >&2; exit 2; }
WG_SERVER="${WG_SERVER:-$(env_get WG_SERVER)}"
case "${WG_SERVER:-0}" in 0|1) ;; *) echo "WG_SERVER must be 0 or 1" >&2; exit 2 ;; esac
WG_PORT="${WG_PORT:-51820}"
case "$WG_PORT" in ''|*[!0-9]*) echo "WG_PORT must be a port number" >&2; exit 2 ;; esac
{ [ "$WG_PORT" -ge 1 ] && [ "$WG_PORT" -le 65535 ]; } || { echo "WG_PORT must be 1-65535" >&2; exit 2; }
REACH_URL="${PREFLIGHT_REACH_URL:-}"
if [ -n "$REACH_URL" ]; then
  printf '%s' "$REACH_URL" | grep -Eq '^https://[^[:space:]]+$' || { echo "PREFLIGHT_REACH_URL must be an https:// URL" >&2; exit 2; }
fi
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
PUB_IP6="${PUBLIC_IP6:-}"
if [ -z "$PUB_IP6" ] && has ip; then
  PUB_IP6="$(ip -6 -o addr show scope global 2>/dev/null | awk '{print $4}' | cut -d/ -f1 | grep -Eiv '^f[cd]' | head -n1)"
fi
if [ -n "$PUB_IP6" ] && ! expand6 "$PUB_IP6" >/dev/null; then echo "PUBLIC_IP6 must be an IPv6 address" >&2; exit 2; fi
ok dns "Cloudflare ranges: $CF_SRC"
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
  # AAAA: clients prefer IPv6, so a proxied or stale AAAA breaks them too.
  addrs6="$(getent ahostsv6 "$host" 2>/dev/null | awk '{print $1}' | grep ':' | grep -Eiv '^::ffff:' | sort -u)"
  for a in $addrs6; do
    if is_cloudflare6 "$a"; then
      fail dns "$name $host -> $a (AAAA) is a Cloudflare proxy address: set the record to DNS only (grey cloud)"
    elif [ -z "$PUB_IP6" ]; then
      warn dns "$name $host has AAAA $a but this host has no public IPv6: remove the AAAA or set PUBLIC_IP6"
    elif [ "$(expand6 "$a")" != "$(expand6 "$PUB_IP6")" ]; then
      warn dns "$name $host -> $a (AAAA), not this host ($PUB_IP6): IPv6 clients will go elsewhere"
    else
      ok dns "$name $host -> $a (AAAA)"
    fi
  done
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
  # ufw lists single ports ("443/tcp") and multiport rules ("80,443/tcp").
  if printf '%s' "$UFW" | grep -q '^Status: active' && ! printf '%s' "$UFW" | grep -Eq "^([0-9:]+,)*$port(,[0-9:]+)*(/tcp)?[[:space:]]+ALLOW"; then
    fail ports "ufw is active and does not allow tcp/$port"
  fi
done
[ -n "$LISTEN" ] || warn ports "ss not available: listener check skipped"

# ─── reach ──────────────────────────────────────────────────────────
if [ -z "$REACH_URL" ]; then
  warn reach "external reachability skipped: inbound is not provable from this box; set PREFLIGHT_REACH_URL to an outside checker or test from outside (curl -v https://$RELAY:9443/) and check the provider firewall"
elif ! has curl; then
  fail reach "PREFLIGHT_REACH_URL set but curl is not installed"
elif [ -z "$RELAY" ]; then
  fail reach "RELAY_HOST is not set: nothing to check"
else
  for port in 80 443 8443 1443 9443; do
    u="${REACH_URL//\{host\}/$RELAY}"; u="${u//\{port\}/$port}"
    if curl -fsS -o /dev/null --proto =https --max-redirs 0 --max-time 15 "$u" 2>/dev/null; then
      ok reach "tcp/$port reachable from outside"
    else
      fail reach "tcp/$port not reachable from outside (checker at PREFLIGHT_REACH_URL); check the provider firewall"
    fi
  done
fi

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
if [ "${WG_SERVER:-0}" = 1 ]; then
  # Kernel WireGuard listens without a process, so match the port only.
  if ! has ss; then
    warn wg "ss not available: udp/$WG_PORT listener check skipped"
  elif ss -Hlun 2>/dev/null | awk -v p=":$WG_PORT" '$4 ~ p"$"' | grep -q .; then
    ok wg "udp/$WG_PORT listening (WireGuard server)"
  else
    fail wg "udp/$WG_PORT not listening: WG_SERVER=1 needs ListenPort = $WG_PORT in $WG_IF.conf"
  fi
  if printf '%s' "$UFW" | grep -q '^Status: active' && ! printf '%s' "$UFW" | grep -Eq "^([0-9:]+,)*$WG_PORT(,[0-9:]+)*/udp[[:space:]]+ALLOW|^([0-9:]+,)*$WG_PORT(,[0-9:]+)*[[:space:]]+ALLOW"; then
    fail wg "ufw is active and does not allow udp/$WG_PORT (ufw allow $WG_PORT/udp)"
  fi
fi

# ─── db ─────────────────────────────────────────────────────────────
if [ -z "$DB_URL" ]; then
  fail db "GATEWAY_DATABASE_URL is not set"
else
  # postgres:// and postgresql:// are both valid; the port defaults to 5432.
  hp="$(printf '%s' "$DB_URL" | sed -nE 's#^postgres(ql)?://[^@/]+@([0-9.]+)(:([0-9]{1,5}))?(/.*)?$#\2 \4#p')"
  db_ip="${hp% *}" db_port="${hp#* }"
  db_port="${db_port:-5432}"
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
