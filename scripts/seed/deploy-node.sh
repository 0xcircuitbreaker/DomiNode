#!/usr/bin/env bash
# Deploy (or update) an operator-run seed node on this host. Idempotent: safe to
# re-run; it upgrades the checkout, rebuilds and restarts the service.
#
# Configuration is read from the environment only (never from arguments, so
# secrets never show up in `ps`):
#   DN_REPO_URL          git URL (default https://github.com/0xcircuitbreaker/DomiNode.git)
#   DN_REF               git ref to deploy (default master); pin a release tag in production
#   DN_COORD_PUBKEYS     REQUIRED: comma-separated coordinator public keys (pins; not secret)
#   DN_NODE_API_URL      API base URL (https://...)
#   DN_NODE_GATEWAY_URL  gateway tunnel URL (wss://...)
#   DN_NODE_MAX_STREAMS / DN_NODE_GB_PER_DAY / DN_NODE_REQ_PER_SEC   optional caps
#   DN_API_KEY           only for first registration: dn_live_ key of the platform seed principal
#   DN_WALLET_KEY_FILE   only for first registration: path to the platform wallet key file (0600)
#   DN_MODE              "systemd" (default) or "docker"
#
# After the first registration, flag the node as operator-run in the admin panel
# (Nodes → node → "Operator-run seed") or with
#   POST /api/admin/network/nodes/:id/operator-run {"operatorRun": true}
set -euo pipefail

DN_REPO_URL="${DN_REPO_URL:-https://github.com/0xcircuitbreaker/DomiNode.git}"
DN_REF="${DN_REF:-master}"
DN_MODE="${DN_MODE:-systemd}"
PREFIX="/opt/dominusnode"
ETC="/etc/dominusnode"
KEY_FILE="$ETC/node.json"
SVC_USER="dominusnode"
cleanup() { rm -f "$ETC/node.env.tmp"; }
trap cleanup EXIT INT TERM

log() { printf '[deploy-node] %s\n' "$*" >&2; }
die() { log "ERROR: $*"; exit 1; }

[ "$(id -u)" -eq 0 ] || die "run as root"
[ -n "${DN_COORD_PUBKEYS:-}" ] || die "DN_COORD_PUBKEYS is required (release builds embed coordinator pins)"
case "$DN_MODE" in systemd|docker) ;; *) die "DN_MODE must be systemd or docker";; esac
for v in DN_NODE_API_URL DN_NODE_GATEWAY_URL; do
  val="${!v:-}"
  [ -z "$val" ] || [[ "$val" =~ ^(https|wss):// ]] || die "$v must be https:// or wss://"
done

# 1. Service user and directories
if ! id "$SVC_USER" >/dev/null 2>&1; then
  useradd --system --uid 1001 --home-dir /nonexistent --shell /usr/sbin/nologin "$SVC_USER" 2>/dev/null \
    || useradd --system --home-dir /nonexistent --shell /usr/sbin/nologin "$SVC_USER"
fi
install -d -m 0750 -o root -g "$SVC_USER" "$ETC"

# 2. Non-secret runtime config (rewritten every run)
umask 077
{
  for v in DN_NODE_API_URL DN_NODE_GATEWAY_URL DN_NODE_MAX_STREAMS DN_NODE_GB_PER_DAY DN_NODE_REQ_PER_SEC; do
    [ -n "${!v:-}" ] && printf '%s=%s\n' "$v" "${!v}"
  done
  true
} > "$ETC/node.env.tmp"
install -m 0640 -o root -g "$SVC_USER" "$ETC/node.env.tmp" "$ETC/node.env"
rm -f "$ETC/node.env.tmp"
umask 022

# 3. Checkout + build (systemd mode) or image build (docker mode)
command -v git >/dev/null || die "git is required"
if [ -d "$PREFIX/.git" ]; then
  git -C "$PREFIX" fetch --quiet --tags origin
else
  git clone --quiet "$DN_REPO_URL" "$PREFIX"
fi
git -C "$PREFIX" checkout --quiet --force "$DN_REF"
git -C "$PREFIX" reset --quiet --hard "origin/$DN_REF" 2>/dev/null || true

if [ "$DN_MODE" = "systemd" ]; then
  command -v node >/dev/null || die "node 22+ is required"
  (cd "$PREFIX" \
    && npm ci --ignore-scripts --workspace=@dominusnode/shared --workspace=@dominusnode/node-agent --include-workspace-root \
    && npm rebuild bcrypt \
    && DN_COORD_PUBKEYS="$DN_COORD_PUBKEYS" node packages/node-agent/scripts/gen-coord-pins.mjs --require \
    && npx tsc --build packages/node-agent)
else
  command -v docker >/dev/null || die "docker is required for DN_MODE=docker"
  docker build -q -f "$PREFIX/packages/node-agent/Dockerfile" \
    --build-arg DN_COORD_PUBKEYS="$DN_COORD_PUBKEYS" -t dominusnode-node:"${DN_REF//\//-}" "$PREFIX" >/dev/null
fi

# 4. First registration (only when no key file exists yet)
if [ ! -s "$KEY_FILE" ]; then
  [ -n "${DN_API_KEY:-}" ] || die "no $KEY_FILE yet: set DN_API_KEY and DN_WALLET_KEY_FILE for the first registration"
  [ -r "${DN_WALLET_KEY_FILE:-}" ] || die "DN_WALLET_KEY_FILE must point to a readable wallet key file"
  log "registering node (key will be written to $KEY_FILE)"
  # DN_API_KEY reaches the agent through the environment only.
  (cd "$PREFIX" && DN_NODE_KEY_FILE="$KEY_FILE" DN_API_KEY="$DN_API_KEY" \
    node packages/node-agent/dist/src/main.js register --wallet-key-file "$DN_WALLET_KEY_FILE") \
    || die "registration failed (in docker mode, build the agent on the host once or register from another machine)"
fi
unset DN_API_KEY
chown "$SVC_USER:$SVC_USER" "$KEY_FILE"
chmod 0600 "$KEY_FILE"

# 5. Service
if [ "$DN_MODE" = "systemd" ]; then
  install -m 0644 "$PREFIX/infra/systemd/dominusnode-node.service" /etc/systemd/system/dominusnode-node.service
  systemctl daemon-reload
  systemctl enable --quiet dominusnode-node
  systemctl restart dominusnode-node
  log "systemd unit dominusnode-node restarted"
else
  docker rm -f dominusnode-node >/dev/null 2>&1 || true
  docker run -d --name dominusnode-node --restart unless-stopped \
    --env-file "$ETC/node.env" \
    -v "$KEY_FILE:/run/dominusnode/node.json:ro" \
    dominusnode-node:"${DN_REF//\//-}" >/dev/null
  log "container dominusnode-node restarted"
fi
log "done; flag this node as operator-run in the admin panel if it is a seed node"
