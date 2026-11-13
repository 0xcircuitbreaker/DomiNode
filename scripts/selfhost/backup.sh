#!/usr/bin/env bash
# Encrypted backup of a self-hosted DominusNode box (run from cron, as the user
# that ran install.sh). One archive holds everything a rebuild needs:
#
#   db.dump      pg_dump -Fc of the coordinator database (ROLE=all|coordinator),
#                taken inside the postgres container (the backend network is
#                internal, so the host has no route to Postgres)
#   selfhost/    coord-key.pem (pinned in every node image: losing it strands
#                all nodes), api-key-pepper (losing it invalidates every
#                peppered API key), gateway-database-url, token files, Caddyfile
#   .env         JWT_SECRET, MFA_ENCRYPTION_KEY, POSTGRES_PASSWORD, settings
#
# The archive is never written unencrypted. Choose one:
#   BACKUP_AGE_RECIPIENT=age1...      encrypt to an age public key whose private
#                                     key lives OFF this box (preferred)
#   BACKUP_PASSPHRASE_FILE=/path      openssl AES-256-CBC + PBKDF2 (600k rounds);
#                                     keep a copy of the passphrase off-box
# Options (env): BACKUP_DIR (default ./backups), BACKUP_KEEP (default 14).
# Restore: scripts/selfhost/restore.sh <archive> (DEPLOYMENT.md "Self-host backup").
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT"
DOCKER="${DOCKER:-docker}"
BACKUP_DIR="${BACKUP_DIR:-$ROOT/backups}"
BACKUP_KEEP="${BACKUP_KEEP:-14}"

die() { echo "backup: $*" >&2; exit 1; }
case "$BACKUP_KEEP" in ''|*[!0-9]*) die "BACKUP_KEEP must be a positive integer" ;; esac
[ "$BACKUP_KEEP" -ge 1 ] || die "BACKUP_KEEP must be at least 1"
[ -f "$ROOT/.env" ] || die "no .env: run scripts/selfhost/install.sh first"
[ -d "$ROOT/selfhost" ] || die "no selfhost/ directory"

if [ -n "${BACKUP_AGE_RECIPIENT:-}" ]; then
  command -v age >/dev/null 2>&1 || die "BACKUP_AGE_RECIPIENT needs the age tool"
  EXT=tar.gz.age
  encrypt() { age -r "$BACKUP_AGE_RECIPIENT"; }
elif [ -n "${BACKUP_PASSPHRASE_FILE:-}" ]; then
  [ -s "$BACKUP_PASSPHRASE_FILE" ] || die "BACKUP_PASSPHRASE_FILE is missing or empty"
  command -v openssl >/dev/null 2>&1 || die "openssl is required"
  EXT=tar.gz.enc
  encrypt() { openssl enc -aes-256-cbc -pbkdf2 -iter 600000 -salt -pass "file:$BACKUP_PASSPHRASE_FILE"; }
else
  die "refusing to write an unencrypted backup: set BACKUP_AGE_RECIPIENT or BACKUP_PASSPHRASE_FILE"
fi

ROLE="$(grep -E '^ROLE=' "$ROOT/.env" | tail -n1 | cut -d= -f2- || true)"
umask 077
STAGE="$(mktemp -d "${TMPDIR:-/tmp}/dn-backup.XXXXXX")"
trap 'rm -rf "$STAGE"; rm -f "$BACKUP_DIR"/.partial.*' EXIT INT TERM

if [ "${ROLE:-all}" != gateway ]; then
  "$DOCKER" compose -f docker-compose.selfhost.yml --env-file "$ROOT/.env" --profile coordinator \
    exec -T postgres pg_dump -U dominusnode -d dominusnode -Fc > "$STAGE/db.dump" ||
    die "pg_dump failed (is the postgres service running?)"
  [ -s "$STAGE/db.dump" ] || die "pg_dump produced an empty dump"
fi
cp -a "$ROOT/selfhost" "$STAGE/selfhost"
cp -a "$ROOT/.env" "$STAGE/env"

mkdir -p "$BACKUP_DIR"
chmod 700 "$BACKUP_DIR"
NAME="dominusnode-$(date -u +%Y%m%dT%H%M%SZ).$EXT"
PARTIAL="$BACKUP_DIR/.partial.$NAME"
tar -C "$STAGE" -czf - . | encrypt > "$PARTIAL"
[ -s "$PARTIAL" ] || die "encryption produced no output"
mv -f "$PARTIAL" "$BACKUP_DIR/$NAME"
echo "backup: $BACKUP_DIR/$NAME"

# Rotation: keep the newest BACKUP_KEEP archives.
find "$BACKUP_DIR" -maxdepth 1 -type f -name 'dominusnode-*.tar.gz.*' -printf '%T@ %p\n' 2>/dev/null |
  sort -rn | tail -n +"$((BACKUP_KEEP + 1))" | cut -d' ' -f2- |
  while IFS= read -r old; do rm -f -- "$old"; done
