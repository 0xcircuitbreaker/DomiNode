#!/usr/bin/env bash
# One-command installer for a community DomiNode exit node.
#
#   read -rs DN_API_KEY && export DN_API_KEY           # your dn_live_ key, never on the command line
#   sudo -E DN_WALLET_KEY_FILE=./wallet.key ./scripts/node/install.sh
#
# It pulls the published node image, registers the node once (if no key file
# exists), runs `selfcheck`, and starts the agent under Docker's restart policy
# (DN_INSTALL_MODE=docker, default) or a systemd unit that supervises the
# container (DN_INSTALL_MODE=systemd). Re-running it upgrades the image and
# restarts the node; registration is skipped once the key file exists, and caps
# or URLs not set in the environment keep the values the last run wrote.
#
# Configuration comes from the environment only; secrets are never accepted as
# arguments and are never written to the unit or env file:
#   DN_API_KEY           first registration only: owner dn_live_ key (passed to the container by name)
#   DN_WALLET_KEY_FILE   first registration only: owner wallet key file (copied 0600, deleted afterwards)
#   DN_INSTALL_MODE      docker (default) | systemd
#   DN_NODE_IMAGE        image (default ghcr.io/0xcircuitbreaker/dominusnode-node:latest)
#   DN_NODE_API_URL / DN_NODE_GATEWAY_URL   only to point at another coordinator (https:// / wss://)
#   DN_NODE_GB_PER_DAY / DN_NODE_MAX_STREAMS / DN_NODE_MAX_MBPS / DN_NODE_REQ_PER_SEC   caps
#   DN_SKIP_SELFCHECK=1  start even if selfcheck fails (not recommended)
#
# See docs/agent-network/NODE_OPERATOR.md.
set -euo pipefail

MODE="${DN_INSTALL_MODE:-docker}"
IMAGE="${DN_NODE_IMAGE:-ghcr.io/0xcircuitbreaker/dominusnode-node:latest}"
ETC="/etc/dominusnode"
KEY_FILE="$ETC/node.json"
ENV_FILE="$ETC/node.env"
NAME="dominusnode-node"
UNIT="/etc/systemd/system/$NAME.service"
UID_NODE=1001

log() { printf '[install-node] %s\n' "$*" >&2; }
die() { log "ERROR: $*"; exit 1; }
cleanup() { rm -f "$ETC/wallet.key" "$ENV_FILE.tmp"; }
trap cleanup EXIT INT TERM

[ "$#" -eq 0 ] || die "no arguments are accepted; configure with environment variables (see the header of this script)"
[ "$(id -u)" -eq 0 ] || die "run as root (sudo -E keeps DN_API_KEY in the environment)"
case "$MODE" in docker|systemd) ;; *) die "DN_INSTALL_MODE must be docker or systemd";; esac
command -v docker >/dev/null 2>&1 || die "docker is required (https://docs.docker.com/engine/install/)"
if [ "$MODE" = systemd ]; then command -v systemctl >/dev/null 2>&1 || die "systemctl not found; use DN_INSTALL_MODE=docker"; fi
[[ "$IMAGE" =~ ^[a-z0-9./:@_-]+$ ]] || die "DN_NODE_IMAGE has unexpected characters"

# Value a previous install wrote, so a plain re-run (upgrade) keeps the operator's caps and URLs.
prev() { [ -f "$ENV_FILE" ] && sed -n "s/^$1=\([A-Za-z0-9.:\/_-]*\)\$/\1/p" "$ENV_FILE" | tail -n 1; return 0; }
for v in DN_NODE_GB_PER_DAY DN_NODE_MAX_STREAMS DN_NODE_MAX_MBPS DN_NODE_REQ_PER_SEC DN_NODE_API_URL DN_NODE_GATEWAY_URL; do
  [ -n "${!v:-}" ] || printf -v "$v" '%s' "$(prev "$v")"
done

for v in DN_NODE_API_URL DN_NODE_GATEWAY_URL; do
  val="${!v:-}"
  [ -z "$val" ] || [[ "$val" =~ ^(https|wss)://[A-Za-z0-9.:/_-]+$ ]] || die "$v must be an https:// or wss:// URL"
done
for v in DN_NODE_GB_PER_DAY DN_NODE_MAX_STREAMS DN_NODE_MAX_MBPS DN_NODE_REQ_PER_SEC; do
  val="${!v:-}"
  [ -z "$val" ] || [[ "$val" =~ ^[0-9]{1,6}$ ]] || die "$v must be a whole number"
done

# Non-secret env file shared by register, selfcheck and run (conservative home-line caps by default).
install -d -o "$UID_NODE" -g "$UID_NODE" -m 700 "$ETC"
{
  printf 'NODE_ENV=production\n'
  printf 'DN_NODE_KEY_FILE=/run/dominusnode/node.json\n'
  printf 'DN_NODE_GB_PER_DAY=%s\n' "${DN_NODE_GB_PER_DAY:-2}"
  printf 'DN_NODE_MAX_STREAMS=%s\n' "${DN_NODE_MAX_STREAMS:-8}"
  printf 'DN_NODE_MAX_MBPS=%s\n' "${DN_NODE_MAX_MBPS:-10}"
  printf 'DN_NODE_REQ_PER_SEC=%s\n' "${DN_NODE_REQ_PER_SEC:-5}"
  [ -z "${DN_NODE_API_URL:-}" ] || printf 'DN_NODE_API_URL=%s\n' "$DN_NODE_API_URL"
  [ -z "${DN_NODE_GATEWAY_URL:-}" ] || printf 'DN_NODE_GATEWAY_URL=%s\n' "$DN_NODE_GATEWAY_URL"
} > "$ENV_FILE.tmp"
chmod 600 "$ENV_FILE.tmp"
mv "$ENV_FILE.tmp" "$ENV_FILE"

log "pulling $IMAGE"
docker pull "$IMAGE" >/dev/null

if [ ! -s "$KEY_FILE" ]; then
  [ -n "${DN_API_KEY:-}" ] || die "first install: export DN_API_KEY (your dn_live_ key) before running"
  [[ "$DN_API_KEY" == dn_live_* ]] || die "DN_API_KEY must be a dn_live_ key"
  [ -n "${DN_WALLET_KEY_FILE:-}" ] && [ -f "$DN_WALLET_KEY_FILE" ] || die "first install: DN_WALLET_KEY_FILE must point at your owner wallet key file"
  install -o "$UID_NODE" -g "$UID_NODE" -m 600 "$DN_WALLET_KEY_FILE" "$ETC/wallet.key"
  log "registering node (the agent shows the attestation it signs)"
  # -e DN_API_KEY passes the value from this environment by name; it never appears in argv.
  docker run --rm --env-file "$ENV_FILE" -e DN_API_KEY -e DN_WALLET_KEY_FILE=/run/dominusnode/wallet.key \
    -v "$ETC:/run/dominusnode" "$IMAGE" register
  rm -f "$ETC/wallet.key"
  chown "$UID_NODE:$UID_NODE" "$KEY_FILE"
  chmod 600 "$KEY_FILE"
  log "node registered; key stored at $KEY_FILE (0600)"
fi
unset DN_API_KEY

log "running selfcheck"
if ! docker run --rm --env-file "$ENV_FILE" -v "$KEY_FILE:/run/dominusnode/node.json:ro" "$IMAGE" selfcheck; then
  [ "${DN_SKIP_SELFCHECK:-}" = 1 ] || die "selfcheck failed; fix the items above and re-run (DN_SKIP_SELFCHECK=1 to start anyway)"
  log "WARNING: selfcheck failed, starting anyway (DN_SKIP_SELFCHECK=1)"
fi

docker rm -f "$NAME" >/dev/null 2>&1 || true
if [ "$MODE" = docker ]; then
  # Switching from systemd mode: the old unit would keep recreating the container.
  if [ -f "$UNIT" ]; then
    systemctl disable --now "$NAME.service" >/dev/null 2>&1 || true
    rm -f "$UNIT"
    systemctl daemon-reload >/dev/null 2>&1 || true
  fi
  docker run -d --name "$NAME" --restart unless-stopped --env-file "$ENV_FILE" \
    -v "$KEY_FILE:/run/dominusnode/node.json:ro" "$IMAGE" run >/dev/null
  log "started container $NAME (docker logs -f $NAME)"
else
  cat > "$UNIT" <<UNIT
# Installed by scripts/node/install.sh. No secrets here; the node key is mounted read-only.
[Unit]
Description=DomiNode relay node agent (container)
Wants=network-online.target docker.service
After=network-online.target docker.service

[Service]
Restart=always
RestartSec=5
ExecStartPre=-/usr/bin/docker rm -f $NAME
ExecStart=/usr/bin/docker run --rm --name $NAME --env-file $ENV_FILE -v $KEY_FILE:/run/dominusnode/node.json:ro $IMAGE run
ExecStop=/usr/bin/docker stop $NAME

[Install]
WantedBy=multi-user.target
UNIT
  chmod 644 "$UNIT"
  systemctl daemon-reload
  systemctl enable --now "$NAME.service" >/dev/null
  systemctl restart "$NAME.service"
  log "started $NAME.service (journalctl -u $NAME -f)"
fi
log "done. Check earnings with GET /v1/nodes/earnings/projection; re-run selfcheck any time:"
log "  docker run --rm --env-file $ENV_FILE -v $KEY_FILE:/run/dominusnode/node.json:ro $IMAGE selfcheck"
