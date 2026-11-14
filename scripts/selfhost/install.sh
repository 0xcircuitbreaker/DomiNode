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
# ACME_CHALLENGE: http (default; Let's Encrypt HTTP-01/TLS-ALPN-01, inbound 80/443)
#           or dns-cloudflare (DNS-01 through the Cloudflare API, no inbound
#           80/443; token in CLOUDFLARE_DNS_TOKEN_FILE, mode 0600, Zone:DNS:Edit
#           + Zone:Zone:Read for the one zone). Required when TLS_MODE=cloudflare
#           and this box runs the gateway (it has no inbound 80/443).
# ROLE: all (default, one box), coordinator (postgres/api, no gateway),
#       gateway (gateway + Caddy for RELAY_HOST only; DB over WireGuard).
# RELAY_HOST / PROXY_HOST: public gateway hostnames (default: primary hostname).
# Agents use the TLS proxy: https://PROXY_HOST:8443 (HTTPS proxy) and SOCKS5
# inside TLS on :1443, with Caddy's certificate for PROXY_HOST (hot-reloaded on
# renewal). Plaintext 8080/1080 are published only with TLS_MODE=off or
# PUBLISH_PLAINTEXT_PROXY=1 (they refuse credentials unless TLS_MODE=off).
# See docs/agent-network/DEPLOYMENT.md "Split self-host" for the layout.
# ADMIN_BOOTSTRAP_EMAIL: first admin's address (enables the admin UI login;
#           DEPLOYMENT.md "Self-host admin"). ABUSE_CONTACT, OPERATOR_NAME,
#           SITE_NAME: optional, shown in security.txt and coordinator.json.
# Secrets kept in selfhost/ (back them up: scripts/selfhost/backup.sh):
#   coord-key.pem, api-key-pepper; .env holds the generated passwords.
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
    -h|--help) sed -n '2,37p' "$0"; exit 0 ;;
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
  # Replace in place so re-runs keep .env byte-stable (restores compare it).
  if [ -f "$ENV_FILE" ] && grep -qE "^$key=" "$ENV_FILE"; then
    KEY="$key" VAL="$val" awk 'index($0, ENVIRON["KEY"] "=") == 1 { if (!done) print ENVIRON["KEY"] "=" ENVIRON["VAL"]; done = 1; next } { print }' "$ENV_FILE" > "$tmp"
  else
    if [ -f "$ENV_FILE" ]; then cat "$ENV_FILE" > "$tmp"; fi
    printf '%s=%s\n' "$key" "$val" >> "$tmp"
  fi
  chmod 600 "$tmp"
  mv "$tmp" "$ENV_FILE"
}
# Remove KEY from .env (compose then uses its default).
env_unset() {
  local tmp
  [ -f "$ENV_FILE" ] || return 0
  tmp="$(mktemp "$ROOT/.env.XXXXXX")"
  grep -vE "^$1=" "$ENV_FILE" > "$tmp" || true
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

# A secret file: safe path, regular one-line file, mode 0600/0400. Never read here.
check_token_file() {
  local label="$1" key="$2" file="$3" abs
  printf '%s' "$file" | grep -Eq '^[A-Za-z0-9._/-]+$' || die "invalid $key path"
  case "$file" in /*) abs="$file" ;; *) abs="$ROOT/$file" ;; esac
  if [ ! -f "$abs" ] || [ -L "$abs" ]; then die "$label not found (regular file): $file"; fi
  [ -s "$abs" ] || die "$label is empty: $file"
  case "$(stat -c %a "$abs" 2>/dev/null || stat -f %Lp "$abs")" in
    600|400) ;; *) die "$label must be mode 0600 or 0400: $file" ;;
  esac
  [ "$(wc -l < "$abs" | tr -d ' ')" -le 1 ] || die "$label must hold one line (the token only)"
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
  check_token_file "Cloudflare tunnel token file" CLOUDFLARE_TUNNEL_TOKEN_FILE "$CF_FILE"
fi

# ACME challenge for Caddy's public certificates.
ACME_DEFAULT="${ACME_CHALLENGE:-$(env_get ACME_CHALLENGE)}"
GW_CF=0
if [ "$TLS" = cloudflare ] && [ "$ROLE_SEL" != coordinator ]; then GW_CF=1; ACME_DEFAULT="${ACME_CHALLENGE:-dns-cloudflare}"; fi
ACME="$(ask "ACME challenge (http|dns-cloudflare)" "${ACME_DEFAULT:-http}")"
case "$ACME" in http|dns-cloudflare) ;; *) die "ACME_CHALLENGE must be http or dns-cloudflare" ;; esac
DNS_TOKEN_HELP="create a Cloudflare API token (My Profile > API Tokens > Create Token > Custom token) with Zone:DNS:Edit and Zone:Zone:Read for this zone only, store it in a 0600 file and set CLOUDFLARE_DNS_TOKEN_FILE (DEPLOYMENT.md 'ACME DNS-01')"
if [ "$GW_CF" -eq 1 ] && [ "$ACME" != dns-cloudflare ]; then
  die "TLS_MODE=cloudflare with a gateway on this box needs ACME_CHALLENGE=dns-cloudflare (no inbound 80/443 for HTTP-01): $DNS_TOKEN_HELP"
fi
DNS_FILE=""
if [ "$ACME" = dns-cloudflare ]; then
  case "$ROLE_SEL:$TLS" in
    coordinator:cloudflare) die "ACME_CHALLENGE=dns-cloudflare does nothing for ROLE=coordinator TLS_MODE=cloudflare (no Caddy); use http" ;;
    *:internal|*:off) die "ACME_CHALLENGE=dns-cloudflare needs TLS_MODE auto or cloudflare (public certificates)" ;;
  esac
  DNS_DEFAULT="${CLOUDFLARE_DNS_TOKEN_FILE:-$(env_get CLOUDFLARE_DNS_TOKEN_FILE)}"
  DNS_FILE="$(ask "Cloudflare DNS API token file (mode 0600)" "${DNS_DEFAULT:-}")"
  [ -n "$DNS_FILE" ] || die "ACME_CHALLENGE=dns-cloudflare needs CLOUDFLARE_DNS_TOKEN_FILE: $DNS_TOKEN_HELP"
  check_token_file "Cloudflare DNS token file" CLOUDFLARE_DNS_TOKEN_FILE "$DNS_FILE"
  if [ -n "$CF_FILE" ] && [ "$DNS_FILE" = "$CF_FILE" ]; then
    die "CLOUDFLARE_DNS_TOKEN_FILE must differ from CLOUDFLARE_TUNNEL_TOKEN_FILE (separate tokens)"
  fi
fi

# ROLE=gateway: the coordinator's Postgres over WireGuard (private address only).
GW_DB_URL=""; HOME_PUB=""
if [ "$ROLE_SEL" = gateway ]; then
  GW_DB_URL="${GATEWAY_DATABASE_URL:-$(env_get GATEWAY_DATABASE_URL)}"
  if [ -z "$GW_DB_URL" ] && [ "$ASSUME_YES" -eq 0 ] && [ -t 0 ]; then
    read -r -s -p "Coordinator gateway DATABASE_URL (from the coordinator's selfhost/gateway-database-url): " GW_DB_URL; echo
  fi
  # The gateway is the internet-facing box: it gets the least-privilege role the
  # coordinator's installer creates, never the Postgres superuser.
  if printf '%s' "$GW_DB_URL" | grep -Eq '^postgresql://dominusnode:'; then
    die "GATEWAY_DATABASE_URL uses the coordinator's Postgres superuser; re-run install.sh on the coordinator (it creates the dominusnode_gateway role) and use the URL in its selfhost/gateway-database-url"
  fi
  printf '%s' "$GW_DB_URL" | grep -Eq '^postgresql://dominusnode_gateway:[A-Za-z0-9]{24,}@[0-9.]+:[0-9]{1,5}/dominusnode$' ||
    die "GATEWAY_DATABASE_URL must be postgresql://dominusnode_gateway:<password, 24+ alphanumerics>@<wireguard ip>:<port>/dominusnode"
  GW_DB_IP="${GW_DB_URL#*@}"; GW_DB_IP="${GW_DB_IP%%:*}"
  private_ipv4 "$GW_DB_IP" || die "GATEWAY_DATABASE_URL host must be a private (WireGuard) IPv4 address, not $GW_DB_IP"
  HOME_PUB="${COORD_PUBKEY:-$(env_get COORD_PUBKEY)}"
  HOME_PUB="$(ask "Coordinator (home) public key from its selfhost/coord.pub" "$HOME_PUB")"
  hex64 "$HOME_PUB" || die "COORD_PUBKEY must be the 64-hex public key printed on the coordinator"
  # API key pepper: must be the coordinator's (keys hashed there must verify here).
  PEPPER_HEX=""
  if [ ! -s "$SH_DIR/api-key-pepper" ]; then
    PEPPER_HEX="${API_KEY_PEPPER:-}"
    if [ -z "$PEPPER_HEX" ] && [ "$ASSUME_YES" -eq 0 ] && [ -t 0 ]; then
      read -r -s -p "API key pepper (contents of the coordinator's selfhost/api-key-pepper): " PEPPER_HEX; echo
    fi
    printf '%s' "$PEPPER_HEX" | grep -Eq '^[0-9a-f]{64}$' ||
      die "ROLE=gateway needs the coordinator's API key pepper: copy its selfhost/api-key-pepper here (mode 0600) or pass API_KEY_PEPPER (64 hex)"
  fi
  # JWT secret: wallet proxy-session tokens (dn_proxy_) are signed by the
  # coordinator's api and verified here, so both boxes need the same value.
  COORD_JWT="${COORD_JWT_SECRET:-}"
  if [ -z "$COORD_JWT" ] && [ "$ASSUME_YES" -eq 0 ] && [ -t 0 ]; then
    read -r -s -p "Coordinator JWT_SECRET (from its .env; empty: dn_proxy_ tokens will not work here): " COORD_JWT; echo
  fi
  if [ -n "$COORD_JWT" ]; then
    printf '%s' "$COORD_JWT" | grep -Eq '^[0-9a-f]{64,}$' || die "COORD_JWT_SECRET must be the coordinator's JWT_SECRET (hex)"
  fi
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
          || echo "warning: could not install $dropin; add it by hand (DEPLOYMENT.md 'Gateway on a VPS, coordinator at home')" >&2
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
plain_email() { printf '%s' "$1" | grep -Eq '^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$'; }
one_line() { case "$1" in *$'\n'*|*$'\r'*) return 1 ;; esac; [ "${#1}" -le 128 ]; }
ABUSE="${ABUSE_CONTACT:-$(env_get ABUSE_CONTACT)}"
if [ -n "$ABUSE" ] && ! plain_email "$ABUSE"; then die "invalid ABUSE_CONTACT: must be a plain address"; fi
OPNAME="${OPERATOR_NAME:-$(env_get OPERATOR_NAME)}"; SITENAME="${SITE_NAME:-$(env_get SITE_NAME)}"
one_line "$OPNAME" || die "OPERATOR_NAME must be one line of at most 128 characters"
one_line "$SITENAME" || die "SITE_NAME must be one line of at most 128 characters"

# First admin (admin UI login). Only where the API runs.
ADMIN_EMAIL=""; ADMIN_LOGIN="${ADMIN_HUMAN_LOGIN:-$(env_get ADMIN_HUMAN_LOGIN)}"
if [ "$ROLE_SEL" != gateway ]; then
  ADMIN_EMAIL="$(ask "First admin email for the admin UI (empty: none)" "${ADMIN_BOOTSTRAP_EMAIL-$(env_get ADMIN_BOOTSTRAP_EMAIL)}")"
  if [ -n "$ADMIN_EMAIL" ]; then
    plain_email "$ADMIN_EMAIL" || die "invalid ADMIN_BOOTSTRAP_EMAIL: must be a plain address"
    ADMIN_LOGIN=true
  fi
fi
case "${ADMIN_LOGIN:-false}" in true|false) ;; *) die "ADMIN_HUMAN_LOGIN must be true or false" ;; esac

# ─── Secrets and key (generated once, kept on re-run) ───────────────
ensure_secret POSTGRES_PASSWORD 24
if [ -n "${COORD_JWT:-}" ]; then env_set JWT_SECRET "$COORD_JWT"; fi
ensure_secret JWT_SECRET 48
ensure_secret MFA_ENCRYPTION_KEY 32
ensure_secret PROBE_AUTH_SECRET 32
env_set DOMINUSNODE_DOMAIN "$PRIMARY"
env_set PUBLIC_HOSTNAMES "$(printf '%s' "$HOSTS" | tr ' ' ',')"
env_set TLS_MODE "$TLS"
env_set ROLE "$ROLE_SEL"
env_set RELAY_HOST "$RELAY"
env_set PROXY_HOST "$PROXYH"
if [ "$TLS" = cloudflare ]; then env_set CLOUDFLARE_TUNNEL_TOKEN_FILE "$CF_FILE"; fi
env_set ACME_CHALLENGE "$ACME"
# Canary + egress probes (ABUSE_CONTROLS T6). Exit nodes dial the echo URL, so
# it must be the API over publicly trusted TLS on a public name. The default is
# set only where that holds: ROLE=all with TLS auto or cloudflare, or
# ROLE=gateway with the coordinator's public API hostname (PROBE_API_HOST).
# An operator value (a comma list of echo URLs) is kept on re-run.
# PROBES_DISABLED=true (environment or .env) is the explicit opt-out and wins.
public_name() {
  case "$1" in localhost|*.localhost|*.local|*.internal|*.lan|*.home.arpa|*.arpa) return 1 ;; esac
  valid_host "$1" || return 1
  local a
  if command -v getent >/dev/null 2>&1; then
    for a in $(getent ahosts "$1" 2>/dev/null | awk '{print $1}' | sort -u); do
      if private_ipv4 "$a"; then return 1; fi
      case "$a" in 127.*|0.*|169.254.*|::1|fe80:*|fc*|fd*) return 1 ;; esac
      if printf '%s' "$a" | grep -Eq '^100\.(6[4-9]|[7-9][0-9]|1[01][0-9]|12[0-7])\.'; then return 1; fi
    done
  fi
  return 0
}
PROBES_OFF="${PROBES_DISABLED:-$(env_get PROBES_DISABLED)}"
if [ "$PROBES_OFF" = true ]; then
  env_set PROBES_DISABLED true
  env_unset PROBE_URL
  echo "install: PROBES_DISABLED=true: canary + egress probes are off" >&2
else
  env_unset PROBES_DISABLED
  if [ -z "$(env_get PROBE_URL)" ] && [ "$ROLE_SEL" != coordinator ]; then
    PROBE_HOST=""
    case "$ROLE_SEL:$TLS" in
      all:auto|all:cloudflare) PROBE_HOST="$PRIMARY" ;;
      gateway:*)
        PROBE_HOST="$(ask "Coordinator public API hostname for egress probes (blank = probes off)" "${PROBE_API_HOST:-}" | tr '[:upper:]' '[:lower:]')" ;;
    esac
    if [ -n "$PROBE_HOST" ] && public_name "$PROBE_HOST"; then
      env_set PROBE_URL "https://$PROBE_HOST/v1/probe/echo"
    else
      echo "install: WARNING: egress probes are OFF (no publicly trusted API hostname for ROLE=$ROLE_SEL TLS_MODE=$TLS${PROBE_HOST:+, $PROBE_HOST is not public})." >&2
      echo "install:   Exit classes then rest on the tunnel peer IP only and tampering goes undetected." >&2
      echo "install:   Set PROBE_URL=https://<public api host>/v1/probe/echo in .env, or PROBES_DISABLED=true to acknowledge." >&2
    fi
  fi
fi
if [ -n "$DNS_FILE" ]; then env_set CLOUDFLARE_DNS_TOKEN_FILE "$DNS_FILE"; else env_unset CLOUDFLARE_DNS_TOKEN_FILE; fi
# Always write every role-specific key so a role change clears stale values
# (a former gateway must not keep a remote DATABASE_URL; a former coordinator
# must not keep advertising a retired gateway key).
if [ "$ROLE_SEL" != gateway ]; then GW_DB_URL=""; HOME_PUB=""; fi
env_set GATEWAY_DATABASE_URL "$GW_DB_URL"; env_set COORD_PUBKEY "$HOME_PUB"
env_set DB_WG_BIND "$DB_WG"; env_set GATEWAY_PUBKEY "$GW_PUB"; env_set COORD_ADDITIONAL_PUBKEYS "$GW_PUB"
env_set OPERATOR_CONTACT "$CONTACT"
env_set ABUSE_CONTACT "$ABUSE"; env_set OPERATOR_NAME "$OPNAME"; env_set SITE_NAME "$SITENAME"
env_set ADMIN_HUMAN_LOGIN "${ADMIN_LOGIN:-false}"; env_set ADMIN_BOOTSTRAP_EMAIL "$ADMIN_EMAIL"
if [ -n "$DB_WG" ]; then ensure_secret GATEWAY_DB_PASSWORD 24; fi
if [ "$TLS" = off ]; then
  env_set COOKIE_SECURE false; env_set TUNNEL_SCHEME ws
else
  env_set COOKIE_SECURE true; env_set TUNNEL_SCHEME wss
fi
# Gateway TLS proxy (8443 HTTPS proxy, 1443 SOCKS5-over-TLS). TLS_MODE=off has
# no certificate: listeners off, plaintext credentials accepted (warned).
PLAIN="${PUBLISH_PLAINTEXT_PROXY:-$(env_get PUBLISH_PLAINTEXT_PROXY)}"
case "${PLAIN:-0}" in 0|1) ;; *) die "PUBLISH_PLAINTEXT_PROXY must be 0 or 1" ;; esac
env_set PUBLISH_PLAINTEXT_PROXY "${PLAIN:-0}"
TLS_KEYS="GATEWAY_PROXY_TLS_PORT GATEWAY_SOCKS5_TLS_PORT GATEWAY_PROXY_TLS_CERT_FILE GATEWAY_PROXY_TLS_KEY_FILE PROXY_PUBLIC_TLS_PORT PROXY_PUBLIC_SOCKS5_TLS_PORT"
if [ "$TLS" = off ]; then
  for k in $TLS_KEYS; do env_set "$k" ""; done
  env_set PROXY_REQUIRE_TLS false
  PLAIN=1
else
  for k in $TLS_KEYS; do env_unset "$k"; done
  env_set PROXY_REQUIRE_TLS true
fi
# What the API lists in coordinator.json: plaintext only when published.
env_set PLAINTEXT_PROXY_PUBLISHED "${PLAIN:-0}"
CORS=""
for h in $HOSTS; do CORS="${CORS:+$CORS,}https://$h"; done
env_set CORS_ORIGINS "$CORS"

if [ ! -f "$SH_DIR/coord-key.pem" ]; then
  node "$ROOT/scripts/gen-coord-key.mjs" "$SH_DIR/coord-key.pem" > "$SH_DIR/coord.pub"
fi
# API key pepper: generated once on the coordinator, never regenerated (that
# would invalidate every peppered key). ROLE=gateway must use the coordinator's.
PEPPER="$SH_DIR/api-key-pepper"
if [ ! -s "$PEPPER" ]; then
  if [ "$ROLE_SEL" = gateway ]; then
    printf '%s\n' "$PEPPER_HEX" > "$PEPPER"
    PEPPER_HEX=""
  else
    openssl rand -hex 32 > "$PEPPER"
  fi
fi
chmod 600 "$PEPPER"
grep -Eqx '[0-9a-f]{64}' "$PEPPER" || die "selfhost/api-key-pepper must hold 64 hex characters"
# Same value on every box: compare this check value between coordinator and gateway.
PEPPER_CHECK="$(node -e 'const c=require("crypto"),f=require("fs");process.stdout.write(c.createHmac("sha256",Buffer.from(f.readFileSync(process.argv[1],"utf8").trim(),"hex")).update("dominusnode-pepper-check").digest("hex").slice(0,16))' "$PEPPER")"
PUB="$(tr -d '[:space:]' < "$SH_DIR/coord.pub")"
printf '%s' "$PUB" | grep -Eq '^[0-9a-f]{64}$' || die "selfhost/coord.pub is not a 64-hex public key"
# Pins: this box's key plus the other half of a split install. On ROLE=gateway
# the key above is the VPS's own CHALLENGE key; the coordinator key stays home.
PINS="$PUB"
if [ -n "$HOME_PUB" ] && [ "$HOME_PUB" != "$PUB" ]; then PINS="$HOME_PUB,$PUB"; fi
if [ -n "$GW_PUB" ] && [ "$GW_PUB" != "$PUB" ]; then PINS="$PUB,$GW_PUB"; fi
env_set DN_COORD_PUBKEYS "$PINS"

# ─── Caddyfile (regenerated every run) ──────────────────────────────
# tls block for each public-cert site: internal, DNS-01 via Cloudflare, or none.
# Caddy reads the DNS token from its own volume ({file.*}, Caddy >= 2.7); the
# Caddyfile holds only the path.
tls_block() {
  if [ "$TLS" = internal ]; then
    echo "  tls internal"
  elif [ "$ACME" = dns-cloudflare ]; then
    echo "  tls {"
    echo "    dns cloudflare {file./run/caddy-secrets/cloudflare-dns.token}"
    echo "    resolvers 1.1.1.1 1.0.0.1"
    echo "  }"
  fi
}
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
    tls_block
    echo "  encode gzip"
    echo "  @api path /api/* /v1/* /v1 /.well-known/* /status /status/* /llms.txt"
    echo "  handle @api {"
    echo "    reverse_proxy api:3000"
    echo "  }"
    echo "  # Admin UI only (nginx). The public DominusNode site pages are not served"
    echo "  # on a self-host: they carry the official operator's contacts and terms."
    echo "  @admin path /admin /admin/* /login /forgot-password /reset-password /verify-email /assets/* /favicon.ico /favicon-192.png /apple-touch-icon.png /icon-512.png /icon-mask.svg /icon-maskable-512.png /logo.svg /site.webmanifest"
    echo "  handle @admin {"
    echo "    reverse_proxy frontend:8080"
    echo "  }"
    echo "  handle / {"
    echo "    redir /admin 302"
    echo "  }"
    echo "  handle {"
    echo "    respond 404"
    echo "  }"
    echo "}"
  fi
  # Node tunnel on :9443: Caddy terminates TLS and passes the node's real address
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
      if [ "$TLS" = off ]; then TSITES="${TSITES:+$TSITES, }http://$h:9443"; else TSITES="${TSITES:+$TSITES, }$h:9443"; fi
    done
    echo "$TSITES {"
    tls_block
    echo "  reverse_proxy gateway:9443 {"
    echo "    transport http {"
    echo "      proxy_protocol v2"
    echo "    }"
    echo "  }"
    echo "}"
  fi
  # Certificate for the gateway's TLS proxy (8443/1443): Caddy obtains and
  # renews it; proxy-certs copies it to the gateway. Only needed when no site
  # block above already covers PROXY_HOST on :443.
  if [ "$ROLE_SEL" != coordinator ] && [ "$TLS" != off ]; then
    if [ "$ROLE_SEL" = gateway ] || [ "$TLS" = cloudflare ] || ! in_list "$PROXYH" "$HOSTS"; then
      echo "$PROXYH {"
      tls_block
      echo "  respond \"DominusNode relay gateway: use the HTTPS proxy on port 8443\" 404"
      echo "}"
    fi
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
if [ "$ROLE_SEL" != coordinator ] && [ "$TLS" != off ]; then PROFILES="$PROFILES proxytls"; fi
if [ "$ACME" = dns-cloudflare ]; then PROFILES="$PROFILES dnscf"; fi
COMPOSE=(docker compose -f docker-compose.selfhost.yml)
if [ -n "$DB_WG" ]; then COMPOSE+=(-f docker-compose.selfhost.wg-db.yml); fi
if [ "$ROLE_SEL" != coordinator ] && [ "$PLAIN" = 1 ]; then COMPOSE+=(-f docker-compose.selfhost.plain.yml); fi
COMPOSE+=(--env-file "$ENV_FILE")
for p in $PROFILES; do COMPOSE+=(--profile "$p"); done

echo "config written: .env (0600), selfhost/Caddyfile, selfhost/coord-key.pem"
echo "role: $ROLE_SEL; primary domain: $PRIMARY; all hostnames: $HOSTS; TLS: $TLS"
echo "relay: $RELAY; proxy: $PROXYH; ACME challenge: $ACME; compose profiles: $PROFILES"
echo "this box's signing public key (selfhost/coord.pub): $PUB; DN_COORD_PUBKEYS=$PINS"
echo "API key pepper check value (must match on coordinator and gateway): $PEPPER_CHECK"
JWT_CHECK="$(env_get JWT_SECRET | node -e 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>process.stdout.write(require("crypto").createHmac("sha256",d.trim()).update("dominusnode-jwt-check").digest("hex").slice(0,16)))')"
echo "JWT secret check value (must match on coordinator and gateway for dn_proxy_ tokens): $JWT_CHECK"
fp() { node -e 'process.stdout.write("sha256:"+require("crypto").createHash("sha256").update(Buffer.from(process.argv[1],"hex")).digest("hex"))' "$1"; }
TRUST="$(for k in $(printf '%s' "$PINS" | tr ',' ' '); do fp "$k"; echo; done | paste -sd, -)"
echo "exit nodes run on other hosts (a node on this box is refused as a private peer). Join command:"
echo "  dominusnode-node run --coordinator $PRIMARY --trust $TRUST"
echo "  (verify every fingerprint out of band; a split install lists the gateway key too)"
# ─── ASN/geo database (without it the gateway refuses all public traffic) ───
ASN_DB="$ROOT/data/ip2asn-combined.tsv.gz"
# Re-runs refresh a database older than 7 days (re-allocated ranges, Tor list).
if [ -f "$ASN_DB" ] && [ "$ROLE_SEL" != coordinator ] && [ "${SKIP_ASN_DB:-0}" != 1 ] && [ -n "$(find "$ASN_DB" -mtime +7 2>/dev/null)" ]; then
  echo "ASN/geo database is older than 7 days: refreshing"
  ASN_DB_FILE="$ASN_DB" bash "$ROOT/scripts/update-asn-db.sh" || echo "warning: ASN/geo refresh failed; keeping the old database" >&2
fi
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
# Caddy must get a certificate for PROXY_HOST before the gateway's TLS proxy
# starts; with HTTP-01 that needs DNS pointing here and 80/443 reachable.
if [ "$TLS" = auto ] && [ "$ACME" = http ] && [ "$ROLE_SEL" != coordinator ]; then
  for h in $PROXYH $RELAY; do
    if ! getent ahosts "$h" >/dev/null 2>&1; then
      echo "warning: $h does not resolve yet: Caddy cannot get its certificate and the gateway waits for it (up to ~10 minutes)" >&2
    fi
  done
fi
cert_hint() {
  echo "install: the certificate for $PROXYH was not issued. Check:" >&2
  echo "  - DNS A/AAAA for $PROXYH and $RELAY point at this host (not proxied/orange-clouded)" >&2
  echo "  - inbound 80 and 443 reach this host (ACME_CHALLENGE=http), or use ACME_CHALLENGE=dns-cloudflare" >&2
  echo "  - logs: ${COMPOSE[*]} logs caddy proxy-certs gateway" >&2
  echo "  Fix it and re-run install.sh." >&2
}
# The one-shot key copiers run the api image; ROLE=gateway builds it too.
if [ "$ROLE_SEL" = gateway ]; then
  docker compose -f docker-compose.selfhost.yml --env-file "$ENV_FILE" --profile coordinator build migrate
fi
"${COMPOSE[@]}" build
if ! "${COMPOSE[@]}" up -d --remove-orphans; then
  if in_list proxytls "$PROFILES"; then cert_hint; fi
  die "docker compose up failed"
fi
if in_list proxytls "$PROFILES" && ! "${COMPOSE[@]}" exec -T proxy-certs test -s /dst/proxy.crt 2>/dev/null; then
  cert_hint
  die "no TLS proxy certificate for $PROXYH"
fi
# Least-privilege Postgres role for a separate gateway VPS (never the superuser).
if [ -n "$DB_WG" ]; then
  { printf '\\set pw %s\n' "$(env_get GATEWAY_DB_PASSWORD)"; cat "$ROOT/scripts/selfhost/gateway-role.sql"; } |
    "${COMPOSE[@]}" exec -T postgres psql -q -1 -v ON_ERROR_STOP=1 -U dominusnode -d dominusnode >/dev/null ||
    die "could not create the dominusnode_gateway role"
  ( umask 077; printf 'postgresql://dominusnode_gateway:%s@%s:5432/dominusnode\n' "$(env_get GATEWAY_DB_PASSWORD)" "$DB_WG" > "$SH_DIR/gateway-database-url" )
  echo "gateway DB URL (least-privilege role) written to selfhost/gateway-database-url (0600); use it as GATEWAY_DATABASE_URL on the gateway VPS"
fi
# Weekly ASN/geo refresh + gateway restart (the gateway loads the file at start).
if [ "$ROLE_SEL" != coordinator ] && [ "${SKIP_ASN_TIMER:-0}" != 1 ]; then
  if [ -d /run/systemd/system ] && command -v systemctl >/dev/null 2>&1; then
    unit=/etc/systemd/system/dominusnode-asn-refresh
    { printf '[Unit]\nDescription=DominusNode ASN/geo database refresh\n[Service]\nType=oneshot\nUser=%s\nExecStart=%s\n' \
        "$(id -un)" "$ROOT/scripts/selfhost/refresh-asn.sh" | sudo tee "$unit.service" >/dev/null \
      && printf '[Unit]\nDescription=Weekly DominusNode ASN/geo refresh\n[Timer]\nOnCalendar=weekly\nRandomizedDelaySec=6h\nPersistent=true\n[Install]\nWantedBy=timers.target\n' \
        | sudo tee "$unit.timer" >/dev/null \
      && sudo systemctl daemon-reload && sudo systemctl enable --now dominusnode-asn-refresh.timer >/dev/null; } \
      || echo "warning: could not install the weekly ASN refresh timer; schedule scripts/selfhost/refresh-asn.sh weekly by hand" >&2
  elif command -v crontab >/dev/null 2>&1; then
    line="17 4 * * 0 $ROOT/scripts/selfhost/refresh-asn.sh >/dev/null 2>&1"
    { crontab -l 2>/dev/null | grep -vF "scripts/selfhost/refresh-asn.sh"; echo "$line"; } | crontab - ||
      echo "warning: could not install the weekly ASN refresh cron job; schedule scripts/selfhost/refresh-asn.sh weekly by hand" >&2
  else
    echo "warning: no systemd or cron: run scripts/selfhost/refresh-asn.sh weekly" >&2
  fi
fi
# The DNS provider reads its token once at provision: restart Caddy so a
# rotated token (just copied by caddy-dns-keys) takes effect.
if [ "$ACME" = dns-cloudflare ]; then
  "${COMPOSE[@]}" restart caddy
fi
# Back on HTTP-01: drop any DNS token copy left in Caddy's secret volume.
if [ "$ACME" = http ] && in_list caddy "$PROFILES"; then
  docker run --rm --network none --user 0:0 -v dominusnode_caddy_secrets:/dst \
    dominusnode-api:selfhost rm -f /dst/cloudflare-dns.token >/dev/null 2>&1 || true
fi
# The keys service copies selfhost/coord-key.pem into a volume owned by uid
# 1001 (0400); fail loudly if the gateway still cannot read it.
if [ "$ROLE_SEL" != coordinator ]; then
  "${COMPOSE[@]}" exec -T gateway \
    test -r /run/dominusnode/coord-key.pem ||
    die "gateway cannot read its coordinator key; see: docker compose -f docker-compose.selfhost.yml logs keys gateway"
fi
if [ "$ROLE_SEL" != coordinator ]; then
  if [ "$TLS" = off ]; then
    echo "proxy (plaintext, TLS_MODE=off): http://$PROXYH:8080 / socks5h://$PROXYH:1080"
  else
    echo "proxy: https://$PROXYH:8443 (HTTPS proxy), SOCKS5 over TLS $PROXYH:1443; node tunnel wss://$RELAY:9443/v1/tunnel"
  fi
fi
SCHEME=https; if [ "$TLS" = off ]; then SCHEME=http; fi
echo "backups: scripts/selfhost/backup.sh (Postgres + keys + .env, encrypted); restore: scripts/selfhost/restore.sh"
if [ "$ROLE_SEL" = gateway ]; then
  echo "up."
else
  if [ -n "$ADMIN_EMAIL" ]; then
    echo "first admin: register $ADMIN_EMAIL (DEPLOYMENT.md 'Self-host admin'), then re-run with ADMIN_BOOTSTRAP_EMAIL= (empty) to close registration"
  fi
  echo "up. admin UI: $SCHEME://$PRIMARY/  status page: $SCHEME://$PRIMARY/status"
fi
