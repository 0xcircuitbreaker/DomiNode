#!/usr/bin/env bash
# Dominus Node Database Backup Script
# Usage: ./scripts/backup.sh [daily|weekly]
#
# Environment variables:
#   DATABASE_URL  - PostgreSQL connection string (required)
#   BACKUP_DIR    - Backup destination directory (default: /var/backups/dominusnode)
#   KEEP_DAILY    - Number of daily backups to retain (default: 7)
#   KEEP_WEEKLY   - Number of weekly backups to retain (default: 4)
#
# Cron examples:
#   0 2 * * * /opt/dominusnode/scripts/backup.sh daily
#   0 3 * * 0 /opt/dominusnode/scripts/backup.sh weekly

set -euo pipefail

# H-3 fix: Restrictive permissions on all created files and directories
umask 077

BACKUP_TYPE="${1:-daily}"
BACKUP_DIR="${BACKUP_DIR:-/var/backups/dominusnode}"
KEEP_DAILY="${KEEP_DAILY:-7}"
KEEP_WEEKLY="${KEEP_WEEKLY:-4}"
TIMESTAMP="$(date +%Y%m%d_%H%M%S)"

# H-4 fix: Validate backup type BEFORE any file operations
if [ "${BACKUP_TYPE}" != "daily" ] && [ "${BACKUP_TYPE}" != "weekly" ]; then
  echo "ERROR: Unknown backup type: ${BACKUP_TYPE}. Must be 'daily' or 'weekly'." >&2
  exit 1
fi

if [ -z "${DATABASE_URL:-}" ]; then
  echo "ERROR: DATABASE_URL is required" >&2
  exit 1
fi

# Create backup directories (umask 077 ensures owner-only access)
mkdir -p "${BACKUP_DIR}/daily" "${BACKUP_DIR}/weekly"

BACKUP_FILE="${BACKUP_DIR}/${BACKUP_TYPE}/dominusnode_${BACKUP_TYPE}_${TIMESTAMP}.sql.gz"

echo "[$(date -Iseconds)] Starting ${BACKUP_TYPE} backup..."

# M-5 mitigation: Use PGPASSWORD env var instead of URL in command line
# Extract components from DATABASE_URL to avoid password in process list
export PGDATABASE PGHOST PGPORT PGUSER PGPASSWORD
eval "$(echo "${DATABASE_URL}" | python3 -c "
import sys, urllib.parse
url = urllib.parse.urlparse(sys.stdin.read().strip())
print(f'PGUSER={urllib.parse.unquote(url.username or \"\")}')
print(f'PGPASSWORD={urllib.parse.unquote(url.password or \"\")}')
print(f'PGHOST={url.hostname or \"localhost\"}')
print(f'PGPORT={url.port or 5432}')
print(f'PGDATABASE={url.path.lstrip(\"/\")}')
" 2>/dev/null)" || {
  # Fallback: use DATABASE_URL directly if python3 is unavailable
  pg_dump "${DATABASE_URL}" \
    --no-owner \
    --no-privileges \
    --clean \
    --if-exists \
    --format=plain \
    | gzip -9 > "${BACKUP_FILE}"
  echo "[$(date -Iseconds)] WARNING: Used DATABASE_URL directly (python3 not available for credential extraction)"
}

# If we extracted components, run pg_dump without URL in command line
if [ -n "${PGHOST:-}" ]; then
  pg_dump \
    --no-owner \
    --no-privileges \
    --clean \
    --if-exists \
    --format=plain \
    | gzip -9 > "${BACKUP_FILE}"
fi

# Ensure backup file has restrictive permissions
chmod 600 "${BACKUP_FILE}"

BACKUP_SIZE=$(du -h "${BACKUP_FILE}" | cut -f1)
echo "[$(date -Iseconds)] Backup created: ${BACKUP_FILE} (${BACKUP_SIZE})"

# Verify backup is not empty
if [ ! -s "${BACKUP_FILE}" ]; then
  echo "ERROR: Backup file is empty, aborting" >&2
  rm -f "${BACKUP_FILE}"
  exit 1
fi

# Rotate old backups
if [ "${BACKUP_TYPE}" = "daily" ]; then
  KEEP="${KEEP_DAILY}"
else
  KEEP="${KEEP_WEEKLY}"
fi

# Delete old backups beyond retention count
BACKUP_COUNT=$(find "${BACKUP_DIR}/${BACKUP_TYPE}" -name "dominusnode_${BACKUP_TYPE}_*.sql.gz" | wc -l)
if [ "${BACKUP_COUNT}" -gt "${KEEP}" ]; then
  DELETE_COUNT=$((BACKUP_COUNT - KEEP))
  find "${BACKUP_DIR}/${BACKUP_TYPE}" -name "dominusnode_${BACKUP_TYPE}_*.sql.gz" \
    | sort \
    | head -n "${DELETE_COUNT}" \
    | xargs rm -f
  echo "[$(date -Iseconds)] Rotated ${DELETE_COUNT} old ${BACKUP_TYPE} backup(s)"
fi

# Clear sensitive env vars
unset PGPASSWORD

echo "[$(date -Iseconds)] Backup complete. Retained: ${KEEP} ${BACKUP_TYPE} backups."
