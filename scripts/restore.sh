#!/usr/bin/env bash
# Dominus Node Database Restore Script
# Usage: ./scripts/restore.sh <backup_file.sql.gz>
#
# Environment variables:
#   DATABASE_URL - PostgreSQL connection string (required)
#
# WARNING: This will DROP and recreate tables in the target database.
# Always verify you are restoring to the correct database.

set -euo pipefail

BACKUP_FILE="${1:-}"

if [ -z "${BACKUP_FILE}" ]; then
  echo "Usage: $0 <backup_file.sql.gz>" >&2
  echo "" >&2
  echo "Available backups:" >&2
  BACKUP_DIR="${BACKUP_DIR:-/var/backups/dominusnode}"
  find "${BACKUP_DIR}" -name "*.sql.gz" -type f | sort -r | head -20 2>/dev/null || echo "  No backups found in ${BACKUP_DIR}"
  exit 1
fi

if [ ! -f "${BACKUP_FILE}" ]; then
  echo "ERROR: Backup file not found: ${BACKUP_FILE}" >&2
  exit 1
fi

if [ -z "${DATABASE_URL:-}" ]; then
  echo "ERROR: DATABASE_URL is required" >&2
  exit 1
fi

# Extract database name from URL for confirmation
DB_NAME=$(echo "${DATABASE_URL}" | sed -n 's|.*/\([^?]*\).*|\1|p')

echo "WARNING: This will restore ${BACKUP_FILE} to database '${DB_NAME}'"
echo "This will DROP and recreate all tables."
echo ""
read -r -p "Type 'yes' to confirm: " CONFIRM

if [ "${CONFIRM}" != "yes" ]; then
  echo "Aborted."
  exit 0
fi

echo "[$(date -Iseconds)] Restoring from ${BACKUP_FILE}..."

# Extract credentials from DATABASE_URL to avoid password in process list
# H-27: Use read-based parsing instead of eval to prevent command injection
_pg_creds="$(echo "${DATABASE_URL}" | python3 -c "
import sys, urllib.parse
url = urllib.parse.urlparse(sys.stdin.read().strip())
print(urllib.parse.unquote(url.username or ''))
print(urllib.parse.unquote(url.password or ''))
print(url.hostname or 'localhost')
print(url.port or 5432)
print(url.path.lstrip('/'))
" 2>/dev/null)" || { echo 'ERROR: Failed to parse DATABASE_URL' >&2; exit 1; }

PGUSER="$(echo "$_pg_creds" | sed -n '1p')"
PGPASSWORD="$(echo "$_pg_creds" | sed -n '2p')"
PGHOST="$(echo "$_pg_creds" | sed -n '3p')"
PGPORT="$(echo "$_pg_creds" | sed -n '4p')"
PGDATABASE="$(echo "$_pg_creds" | sed -n '5p')"
export PGUSER PGPASSWORD PGHOST PGPORT PGDATABASE

if [ -z "${PGUSER}" ] || [ -z "${PGDATABASE}" ]; then
  echo "ERROR: Failed to extract valid credentials from DATABASE_URL" >&2
  exit 1
fi

gunzip -c "${BACKUP_FILE}" | psql --single-transaction --set ON_ERROR_STOP=on

unset PGPASSWORD

echo "[$(date -Iseconds)] Restore complete."
echo ""
echo "Post-restore checklist:"
echo "  1. Verify table counts: psql \$DATABASE_URL -c 'SELECT relname, n_live_tup FROM pg_stat_user_tables ORDER BY n_live_tup DESC;'"
echo "  2. Run migrations if backup is from an older schema: npm run db:migrate"
echo "  3. Restart services: docker compose -f docker-compose.prod.yml restart api proxy"
