#!/usr/bin/env bash
# One-command self-host installer (BOOTSTRAP_PLAN §7 E1).
#
#   ./scripts/selfhost/install.sh            # interactive
#   DOMINUSNODE_HOSTNAMES="dominusnode.com relay.example.org" TLS_MODE=auto \
#     ./scripts/selfhost/install.sh --yes    # non-interactive
#
# Idempotent: the first run generates the coordinator key (scripts/gen-coord-key.mjs),
# a .env with random secrets and selfhost/Caddyfile. Later runs keep existing secrets
# and the key, refresh the Caddyfile, rebuild images and restart (upgrade).
#
# Hostnames are config only. Give one or more public hostnames separated by spaces
# or commas; the first is the primary DOMINUSNODE_DOMAIN, all are served by Caddy.
# TLS_MODE: auto (Let's Encrypt via Caddy), internal (Caddy self-signed),
#           off (plain HTTP on :80; terminate TLS in front of this box),
#           cloudflare (site/API only through a Cloudflare Tunnel, no inbound
#           ports for them; token in CLOUDFLARE_TUNNEL_TOKEN_FILE, mode 0600).
# ROLE: all (default, one box), coordinator (postgres/api, no gateway),
#       gateway (gateway + Caddy for RELAY_HOST only; DB over WireGuard).
# RELAY_HOST / PROXY_HOST: public gateway hostnames (default: primary hostname).
# See docs/agent-network/DEPLOYMENT.md "Split self-host" for the layout.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT"
ENV_FILE="$ROOT/.env"
SH_DIR="$ROOT/selfhost"
ASSUME_YES=0
NO_START=0
for arg in "$@"; do
  case "$arg" in
    --yes|-y) ASSUME_YES=1 ;;
    --no-start) NO_START=1 ;;
    -h|--help) sed -n '2,23p' "$0"; exit 0 ;;
    *) echo "unknown option: $arg" >&2; exit 2 ;;
  esac
done

die() { echo "install: $*" >&2; exit 1; }
need() { command -v "$1" >/dev/null 2>&1 || die "$1 is required"; }
need node
need openssl
if [ "$NO_START" -eq 0 ]; then need docker; fi

# Read KEY from .env (no sourcing: values are never executed).
env_get() {
  [ -f "$ENV_FILE" ] || return 0
  grep -E "^$1=" "$ENV_FILE" | tail -n1 | cut -d= -f2- || true
}
# Set KEY=VALUE in .env, replacing an existing line.
env_set() {
  local key="$1" val="$2" tmp
  case "$val" in *$'\n'*|*$'\r'*) die "refusing to write a multi-line value for $key" ;; esac
  tmp="$(mktemp "$ROOT/.env.XXXXXX")"
  if [ -f "$ENV_FILE" ]; then grep -vE "^$key=" "$ENV_FILE" > "$tmp" || true; fi
  printf '%s=%s\n' "$key" "$val" >> "$tmp"
  chmod 600 "$tmp"
  mv "$tmp" "$ENV_FILE"
}
secret() { openssl rand -hex "$1"; }
ensure_secret() {
  local key="$1" bytes="$2"
  if [ -z "$(env_get "$key")" ]; then env_set "$key" "$(secret "$bytes")"; fi
}

in_list() { local x; for x in $2; do [ "$x" = "$1" ] && return 0; done; return 1; }
private_ipv4() {
  printf '%s' "$1" | grep -Eq '^(10\.[0-9]{1,3}|192\.168|172\.(1[6-9]|2[0-9]|3[01]))\.[0-9]{1,3}\.[0-9]{1,3}$'
}
hex64() { printf '%s' "$1" | grep -Eq '^[0-9a-f]{64}$'; }
valid_host() {
  case "$1" in *$'\n'*|*$'\r'*) return 1 ;; esac
  printf '%s' "$1" | grep -Eq '^([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z][a-z0-9-]{0,62}$|^localhost$'
}

ask() {
  local prompt="$1" def="$2" ans
  if [ "$ASSUME_YES" -eq 1 ] || [ ! -t 0 ]; then printf '%s' "$def"; return; fi
  read -r -p "$prompt [$def]: " ans
  printf '%s' "${ans:-$def}"
}

umask 077
trap 'rm -f "$ROOT"/.env.?????? "$SH_DIR/Caddyfile.tmp"' EXIT INT TERM
mkdir -p "$SH_DIR"

# ─── Role ───────────────────────────────────────────────────────────
ROLE_DEFAULT="${ROLE:-$(env_get ROLE)}"
ROLE_SEL="$(ask "Role (all|coordinator|gateway)" "${ROLE_DEFAULT:-all}")"
case "$ROLE_SEL" in all|coordinator|gateway) ;; *) die "ROLE must be all, coordinator or gateway" ;; esac

# ─── Hostnames ──────────────────────────────────────────────────────
HOSTS_DEFAULT="${DOMINUSNODE_HOSTNAMES:-$(env_get PUBLIC_HOSTNAMES | tr ',' ' ')}"
HOSTS_DEFAULT="${HOSTS_DEFAULT:-localhost}"
HOSTS_RAW="$(ask "Public hostname(s), space or comma separated (first is primary)" "$HOSTS_DEFAULT")"
HOSTS="$(printf '%s' "$HOSTS_RAW" | tr ',' ' ' | tr '[:upper:]' '[:lower:]' | xargs)"
[ -n "$HOSTS" ] || die "at least one hostname is required"
for h in $HOSTS; do valid_host "$h" || die "invalid hostname: $h"; done
PRIMARY="${HOSTS%% *}"

TLS_DEFAULT="${TLS_MODE:-$(env_get TLS_MODE)}"
TLS_DEFAULT="${TLS_DEFAULT:-auto}"
TLS="$(ask "TLS mode (auto|internal|off|cloudflare)" "$TLS_DEFAULT")"
case "$TLS" in auto|internal|off|cloudflare) ;; *) die "TLS mode must be auto, internal, off or cloudflare" ;; esac
if [ "$ROLE_SEL" = gateway ] && [ "$TLS" = cloudflare ]; then
  die "ROLE=gateway cannot use TLS_MODE=cloudflare: proxy and relay traffic must not go through the tunnel"
fi

# Public gateway hostnames: advertised endpoints, coordinator.json, node tunnel URL.
RELAY_DEFAULT="${RELAY_HOST:-$(env_get RELAY_HOST)}"
RELAY="$(ask "Relay (node tunnel) hostname" "${RELAY_DEFAULT:-$PRIMARY}" | tr '[:upper:]' '[:lower:]')"
PROXY_DEFAULT="${PROXY_HOST:-$(env_get PROXY_HOST)}"
PROXYH="$(ask "Proxy hostname for agents" "${PROXY_DEFAULT:-$PRIMARY}" | tr '[:upper:]' '[:lower:]')"
valid_host "$RELAY" || die "invalid RELAY_HOST: $RELAY"
valid_host "$PROXYH" || die "invalid PROXY_HOST: $PROXYH"
CF_FILE=""
if [ "$TLS" = cloudflare ]; then
  if in_list "$RELAY" "$HOSTS"; then die "RELAY_HOST must not be a tunnel hostname: relay traffic must not go through Cloudflare"; fi
  if in_list "$PROXYH" "$HOSTS"; then die "PROXY_HOST must not be a tunnel hostname: proxy traffic must not go through Cloudflare"; fi
  CF_DEFAULT="${CLOUDFLARE_TUNNEL_TOKEN_FILE:-$(env_get CLOUDFLARE_TUNNEL_TOKEN_FILE)}"
  CF_FILE="$(ask "Cloudflare tunnel token file (mode 0600)" "${CF_DEFAULT:-./selfhost/cloudflared.token}")"
  printf '%s' "$CF_FILE" | grep -Eq '^[A-Za-z0-9._/-]+$' || die "invalid CLOUDFLARE_TUNNEL_TOKEN_FILE path"
  case "$CF_FILE" in /*) CF_ABS="$CF_FILE" ;; *) CF_ABS="$ROOT/$CF_FILE" ;; esac
  if [ ! -f "$CF_ABS" ] || [ -L "$CF_ABS" ]; then die "Cloudflare tunnel token file not found (regular file): $CF_FILE"; fi
  [ -s "$CF_ABS" ] || die "Cloudflare tunnel token file is empty: $CF_FILE"
  case "$(stat -c %a "$CF_ABS" 2>/dev/null || stat -f %Lp "$CF_ABS")" in
    600|400) ;; *) die "Cloudflare tunnel token file must be mode 0600 or 0400: $CF_FILE" ;;
  esac
  [ "$(wc -l < "$CF_ABS" | tr -d ' ')" -le 1 ] || die "Cloudflare tunnel token file must hold one line (the token only)"
fi

# ROLE=gateway: the coordinator's Postgres over WireGuard (private address only).
GW_DB_URL=""; HOME_PUB=""
if [ "$ROLE_SEL" = gateway ]; then
  GW_DB_URL="${GATEWAY_DATABASE_URL:-$(env_get GATEWAY_DATABASE_URL)}"
  if [ -z "$GW_DB_URL" ] && [ "$ASSUME_YES" -eq 0 ] && [ -t 0 ]; then
    read -r -s -p "Coordinator DATABASE_URL over WireGuard (postgresql://dominusnode:<pw>@10.x.x.x:5432/dominusnode): " GW_DB_URL; echo
  fi
  printf '%s' "$GW_DB_URL" | grep -Eq '^postgresql://dominusnode:[A-Za-z0-9]{24,}@[0-9.]+:[0-9]{1,5}/dominusnode$' ||
    die "GATEWAY_DATABASE_URL must be postgresql://dominusnode:<password, 24+ alphanumerics>@<wireguard ip>:<port>/dominusnode"
  GW_DB_IP="${GW_DB_URL#*@}"; GW_DB_IP="${GW_DB_IP%%:*}"
  private_ipv4 "$GW_DB_IP" || die "GATEWAY_DATABASE_URL host must be a private (WireGuard) IPv4 address, not $GW_DB_IP"
  HOME_PUB="${COORD_PUBKEY:-$(env_get COORD_PUBKEY)}"
  HOME_PUB="$(ask "Coordinator (home) public key from its selfhost/coord.pub" "$HOME_PUB")"
  hex64 "$HOME_PUB" || die "COORD_PUBKEY must be the 64-hex public key printed on the coordinator"
fi
DB_WG=""; GW_PUB=""
if [ "$ROLE_SEL" = coordinator ]; then
  DB_WG="$(ask "Publish Postgres for a gateway VPS on this WireGuard address (empty: no)" "${DB_WG_BIND:-$(env_get DB_WG_BIND)}")"
  if [ -n "$DB_WG" ]; then
    private_ipv4 "$DB_WG" || die "DB_WG_BIND must be a private (WireGuard) IPv4 address"
    # Refuse a LAN address: it must be assigned to a WireGuard interface.
    if [ "${ALLOW_NON_WG_DB_BIND:-0}" != 1 ]; then
      command -v ip >/dev/null 2>&1 || die "cannot verify DB_WG_BIND without the ip tool (ALLOW_NON_WG_DB_BIND=1 overrides)"
      ip -o -4 addr show type wireguard 2>/dev/null | awk '{split($4,a,"/"); print a[1]}' | grep -qxF "$DB_WG" \
        || die "DB_WG_BIND $DB_WG is not assigned to a WireGuard interface (bring wg0 up first; ALLOW_NON_WG_DB_BIND=1 overrides)"
    fi
    # Docker must start after wg0, or the Postgres bind fails at boot.
    if [ "$NO_START" -eq 0 ] && [ -d /run/systemd/system ]; then
      dropin=/etc/systemd/system/docker.service.d/10-after-wg.conf
      if [ ! -f "$dropin" ]; then
        echo "installing $dropin (docker After=/Wants=wg-quick@wg0.service)"
        { sudo mkdir -p "$(dirname "$dropin")" \
          && printf '[Unit]\nWants=wg-quick@wg0.service\nAfter=wg-quick@wg0.service\n' | sudo tee "$dropin" >/dev/null \
          && sudo systemctl daemon-reload; } \
          || echo "warning: could not install $dropin; add it by hand (DEPLOYMENT.md 7c)" >&2
      fi
    fi
  fi
  GW_PUB="$(ask "Gateway VPS public key (its selfhost/coord.pub; empty: none yet)" "${GATEWAY_PUBKEY:-$(env_get GATEWAY_PUBKEY)}")"
  if [ -n "$GW_PUB" ]; then hex64 "$GW_PUB" || die "GATEWAY_PUBKEY must be a 64-hex public key"; fi
fi

CONTACT_DEFAULT="${OPERATOR_CONTACT:-$(env_get OPERATOR_CONTACT)}"
CONTACT="$(ask "Operator/abuse contact email (required for ACME and abuse reports)" "$CONTACT_DEFAULT")"
if [ "$TLS" = auto ] && [ -z "$CONTACT" ]; then die "TLS mode auto needs a contact email for ACME"; fi
# The contact is written into the Caddyfile and .env verbatim: plain address only.
case "$CONTACT" in *$'\n'*|*$'\r'*) die "invalid contact email: multi-line value" ;; esac
if [ -n "$CONTACT" ] && ! printf '%s' "$CONTACT" | grep -Eq '^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$'; then
  die "invalid contact email: must be a plain address like ops@example.org"
fi

# ─── Secrets and key (generated once, kept on re-run) ───────────────
ensure_secret POSTGRES_PASSWORD 24
ensure_secret JWT_SECRET 48
ensure_secret MFA_ENCRYPTION_KEY 32
env_set DOMINUSNODE_DOMAIN "$PRIMARY"
env_set PUBLIC_HOSTNAMES "$(printf '%s' "$HOSTS" | tr ' ' ',')"
env_set TLS_MODE "$TLS"
env_set ROLE "$ROLE_SEL"
env_set RELAY_HOST "$RELAY"
env_set PROXY_HOST "$PROXYH"
if [ "$TLS" = cloudflare ]; then env_set CLOUDFLARE_TUNNEL_TOKEN_FILE "$CF_FILE"; fi
# Always write every role-specific key so a role change clears stale values
# (a former gateway must not keep a remote DATABASE_URL; a former coordinator
# must not keep advertising a retired gateway key).
if [ "$ROLE_SEL" != gateway ]; then GW_DB_URL=""; HOME_PUB=""; fi
env_set GATEWAY_DATABASE_URL "$GW_DB_URL"; env_set COORD_PUBKEY "$HOME_PUB"
env_set DB_WG_BIND "$DB_WG"; env_set GATEWAY_PUBKEY "$GW_PUB"; env_set COORD_ADDITIONAL_PUBKEYS "$GW_PUB"
env_set OPERATOR_CONTACT "$CONTACT"
if [ "$TLS" = off ]; then
  env_set COOKIE_SECURE false; env_set TUNNEL_SCHEME ws
else
  env_set COOKIE_SECURE true; env_set TUNNEL_SCHEME wss
fi
CORS=""
for h in $HOSTS; do CORS="${CORS:+$CORS,}https://$h"; done
env_set CORS_ORIGINS "$CORS"

if [ ! -f "$SH_DIR/coord-key.pem" ]; then
  node "$ROOT/scripts/gen-coord-key.mjs" "$SH_DIR/coord-key.pem" > "$SH_DIR/coord.pub"
fi
PUB="$(tr -d '[:space:]' < "$SH_DIR/coord.pub")"
printf '%s' "$PUB" | grep -Eq '^[0-9a-f]{64}$' || die "selfhost/coord.pub is not a 64-hex public key"
# Pins: this box's key plus the other half of a split install. On ROLE=gateway
# the key above is the VPS's own CHALLENGE key; the coordinator key stays home.
PINS="$PUB"
if [ -n "$HOME_PUB" ] && [ "$HOME_PUB" != "$PUB" ]; then PINS="$HOME_PUB,$PUB"; fi
if [ -n "$GW_PUB" ] && [ "$GW_PUB" != "$PUB" ]; then PINS="$PUB,$GW_PUB"; fi
env_set DN_COORD_PUBKEYS "$PINS"

# ─── Caddyfile (regenerated every run) ──────────────────────────────
{
  echo "# Generated by scripts/selfhost/install.sh; re-run it instead of editing."
  echo "{"
  if [ -n "$CONTACT" ]; then echo "  email $CONTACT"; fi
  if [ "$TLS" = off ]; then echo "  auto_https off"; fi
  echo "}"
  # Site/API: only where the API runs and Cloudflare does not front it.
  if [ "$ROLE_SEL" != gateway ] && [ "$TLS" != cloudflare ]; then
    SITES=""
    for h in $HOSTS; do
      if [ "$TLS" = off ]; then SITES="${SITES:+$SITES, }http://$h"; else SITES="${SITES:+$SITES, }$h"; fi
    done
    echo "$SITES {"
    if [ "$TLS" = internal ]; then echo "  tls internal"; fi
    echo "  encode gzip"
    echo "  reverse_proxy api:3000"
    echo "}"
  fi
  # Node tunnel on :8443: Caddy terminates TLS and passes the node's real address
  # to the gateway in a PROXY v2 header (the gateway trusts only Caddy's address).
  # Single-box non-tunnel installs serve every hostname (plus RELAY_HOST);
  # gateway and cloudflare installs serve RELAY_HOST only; coordinator none.
  case "$ROLE_SEL:$TLS" in
    coordinator:*) THOSTS="" ;;
    all:cloudflare|gateway:*) THOSTS="$RELAY" ;;
    *) THOSTS="$HOSTS"; in_list "$RELAY" "$HOSTS" || THOSTS="$HOSTS $RELAY" ;;
  esac
  if [ -n "$THOSTS" ]; then
    TSITES=""
    for h in $THOSTS; do
      if [ "$TLS" = off ]; then TSITES="${TSITES:+$TSITES, }http://$h:8443"; else TSITES="${TSITES:+$TSITES, }$h:8443"; fi
    done
    echo "$TSITES {"
    if [ "$TLS" = internal ]; then echo "  tls internal"; fi
    echo "  reverse_proxy gateway:8443 {"
    echo "    transport http {"
    echo "      proxy_protocol v2"
    echo "    }"
    echo "  }"
    echo "}"
  fi
} > "$SH_DIR/Caddyfile.tmp"
mv "$SH_DIR/Caddyfile.tmp" "$SH_DIR/Caddyfile"
chmod 644 "$SH_DIR/Caddyfile"

# Compose profiles and files for this ROLE x TLS_MODE.
case "$ROLE_SEL" in
  all) PROFILES="coordinator gateway caddy" ;;
  coordinator) PROFILES="coordinator"; if [ "$TLS" != cloudflare ]; then PROFILES="$PROFILES caddy"; fi ;;
  *) PROFILES="gateway caddy" ;;
esac
if [ "$TLS" = cloudflare ]; then PROFILES="$PROFILES cloudflare"; fi
COMPOSE=(docker compose -f docker-compose.selfhost.yml)
if [ -n "$DB_WG" ]; then COMPOSE+=(-f docker-compose.selfhost.wg-db.yml); fi
COMPOSE+=(--env-file "$ENV_FILE")
for p in $PROFILES; do COMPOSE+=(--profile "$p"); done

echo "config written: .env (0600), selfhost/Caddyfile, selfhost/coord-key.pem"
echo "role: $ROLE_SEL; primary domain: $PRIMARY; all hostnames: $HOSTS; TLS: $TLS"
echo "relay: $RELAY; proxy: $PROXYH; compose profiles: $PROFILES"
echo "this box's signing public key (selfhost/coord.pub): $PUB; DN_COORD_PUBKEYS=$PINS"
# ─── ASN/geo database (without it the gateway refuses all public traffic) ───
ASN_DB="$ROOT/data/ip2asn-combined.tsv.gz"
if [ ! -f "$ASN_DB" ] && [ "$ROLE_SEL" != coordinator ]; then
  if [ "${SKIP_ASN_DB:-0}" = 1 ]; then
    echo "warning: SKIP_ASN_DB=1: no ASN/geo database; the gateway refuses ALL public peers and destinations until scripts/update-asn-db.sh is run" >&2
  else
    echo "downloading ASN/geo database (scripts/update-asn-db.sh)"
    ASN_DB_FILE="$ASN_DB" bash "$ROOT/scripts/update-asn-db.sh" ||
      die "ASN/geo database download failed; retry, or set SKIP_ASN_DB=1 to continue without it (the relay then refuses public traffic)"
    [ -f "$ASN_DB" ] || die "ASN/geo database missing after download: $ASN_DB"
  fi
fi

# umask 077 above would leave a freshly created data/ as 0700 owned by the
# installing user; the gateway (uid 1001) must be able to traverse it.
if [ -d "$ROOT/data" ]; then
  chmod 0755 "$ROOT/data"
  if [ -f "$ASN_DB" ]; then chmod 0644 "$ASN_DB"; fi
fi

if [ "$NO_START" -eq 1 ]; then exit 0; fi
# The one-shot key copiers run the api image; ROLE=gateway builds it too.
if [ "$ROLE_SEL" = gateway ]; then
  docker compose -f docker-compose.selfhost.yml --env-file "$ENV_FILE" --profile coordinator build migrate
fi
"${COMPOSE[@]}" build
"${COMPOSE[@]}" up -d --remove-orphans
# The keys service copies selfhost/coord-key.pem into a volume owned by uid
# 1001 (0400); fail loudly if the gateway still cannot read it.
if [ "$ROLE_SEL" != coordinator ]; then
  "${COMPOSE[@]}" exec -T gateway \
    test -r /run/dominusnode/coord-key.pem ||
    die "gateway cannot read its coordinator key; see: docker compose -f docker-compose.selfhost.yml logs keys gateway"
fi
if [ "$ROLE_SEL" = gateway ]; then
  echo "up. proxy $PROXYH:8080 (HTTP) / :1080 (SOCKS5); node tunnel wss://$RELAY:8443/v1/tunnel"
else
  echo "up. status page: https://$PRIMARY/status"
fi
