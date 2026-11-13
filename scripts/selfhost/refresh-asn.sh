#!/usr/bin/env bash
# Weekly ASN/geo refresh for a self-hosted gateway (installed as a systemd
# timer or cron job by scripts/selfhost/install.sh). Downloads a fresh
# ip2asn/Tor/iCloud dataset and restarts the gateway, which reads the file once
# at start. The old file stays in place when the download fails.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT"
ASN_DB="$ROOT/data/ip2asn-combined.tsv.gz"

ASN_DB_FILE="$ASN_DB" bash "$ROOT/scripts/update-asn-db.sh"
chmod 0644 "$ASN_DB"
docker compose -f docker-compose.selfhost.yml --env-file "$ROOT/.env" --profile gateway restart gateway
echo "refresh-asn: ASN/geo database refreshed, gateway restarted"
