#!/usr/bin/env bash
# Restore a scripts/selfhost/backup.sh archive onto a fresh checkout.
#
#   BACKUP_PASSPHRASE_FILE=/path ./scripts/selfhost/restore.sh backups/dominusnode-<ts>.tar.gz.enc
#   AGE_IDENTITY=/path/key.txt     ./scripts/selfhost/restore.sh backups/dominusnode-<ts>.tar.gz.age
#
# Order (DEPLOYMENT.md "Self-host backup"):
#   1. keys and .env go back first (selfhost/, .env); existing ones are kept
#      unless --force, so a live box is never overwritten by accident
#   2. Postgres starts empty and the dump is loaded (pg_restore --clean)
#   3. scripts/selfhost/install.sh --yes runs: migrate (schema.sql is re-run
#      safe), gateway role, images, start
# --no-start stops after step 1 (files only).
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT"
DOCKER="${DOCKER:-docker}"
FORCE=0; NO_START=0; ARCHIVE=""
for arg in "$@"; do
  case "$arg" in
    --force) FORCE=1 ;;
    --no-start) NO_START=1 ;;
    -h|--help) sed -n '2,14p' "$0"; exit 0 ;;
    -*) echo "unknown option: $arg" >&2; exit 2 ;;
    *) ARCHIVE="$arg" ;;
  esac
done
die() { echo "restore: $*" >&2; exit 1; }
[ -n "$ARCHIVE" ] && [ -f "$ARCHIVE" ] || die "usage: restore.sh [--force] [--no-start] <archive>"

case "$ARCHIVE" in
  *.age)
    [ -n "${AGE_IDENTITY:-}" ] || die "set AGE_IDENTITY to the age private key file"
    decrypt() { age -d -i "$AGE_IDENTITY" "$ARCHIVE"; } ;;
  *.enc)
    [ -s "${BACKUP_PASSPHRASE_FILE:-}" ] || die "set BACKUP_PASSPHRASE_FILE"
    decrypt() { openssl enc -d -aes-256-cbc -pbkdf2 -iter 600000 -pass "file:$BACKUP_PASSPHRASE_FILE" -in "$ARCHIVE"; } ;;
  *) die "unknown archive type (expected .age or .enc)" ;;
esac

if [ "$FORCE" -eq 0 ] && { [ -e "$ROOT/.env" ] || [ -e "$ROOT/selfhost/coord-key.pem" ]; }; then
  die ".env or selfhost/coord-key.pem already exists; pass --force to replace them"
fi

umask 077
STAGE="$(mktemp -d "${TMPDIR:-/tmp}/dn-restore.XXXXXX")"
trap 'rm -rf "$STAGE"' EXIT INT TERM
decrypt | tar -C "$STAGE" -xzf - || die "could not decrypt/extract the archive (wrong key or passphrase?)"
[ -f "$STAGE/env" ] && [ -f "$STAGE/selfhost/coord-key.pem" ] || die "archive is missing .env or selfhost/coord-key.pem"

# 1. keys and .env
mkdir -p "$ROOT/selfhost"
cp -a "$STAGE/selfhost/." "$ROOT/selfhost/"
cp -a "$STAGE/env" "$ROOT/.env"
chmod 600 "$ROOT/.env" "$ROOT/selfhost/coord-key.pem"
if [ -f "$ROOT/selfhost/api-key-pepper" ]; then chmod 600 "$ROOT/selfhost/api-key-pepper"; fi
echo "restore: selfhost/ and .env restored"
if [ "$NO_START" -eq 1 ]; then exit 0; fi

# 2. database
if [ -f "$STAGE/db.dump" ]; then
  C=("$DOCKER" compose -f docker-compose.selfhost.yml --env-file "$ROOT/.env" --profile coordinator)
  "${C[@]}" up -d postgres
  for _ in $(seq 1 60); do
    if "${C[@]}" exec -T postgres pg_isready -U dominusnode -d dominusnode >/dev/null 2>&1; then break; fi
    sleep 2
  done
  # --no-acl: a split install's dump grants to dominusnode_gateway, a cluster
  # role pg_dump does not carry; install.sh re-applies gateway-role.sql below.
  "${C[@]}" exec -T postgres pg_restore -U dominusnode -d dominusnode --clean --if-exists --no-owner --no-acl <"$STAGE/db.dump" ||
    die "pg_restore failed"
  echo "restore: database loaded"
fi

# 3. migrate + start
bash "$ROOT/scripts/selfhost/install.sh" --yes
