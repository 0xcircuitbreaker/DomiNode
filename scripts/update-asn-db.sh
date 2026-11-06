#!/usr/bin/env bash
# Download the iptoasn.com IP-to-ASN dataset (Public Domain, PDDL v1.0) used by
# the proxy gateway for node ASN caps and dc/residential classification.
# No license key or account required. Run from cron (e.g. daily) and restart
# or roll the gateway to pick up the new file.
#
# Usage: scripts/update-asn-db.sh [dest]   (default: data/ip2asn-combined.tsv.gz,
#        or $ASN_DB_FILE). The gateway reads ASN_DB_FILE (same default).
set -euo pipefail

URL="https://iptoasn.com/data/ip2asn-combined.tsv.gz"
DEST="${1:-${ASN_DB_FILE:-data/ip2asn-combined.tsv.gz}}"
MIN_BYTES=1000000      # a real file is ~10 MB; refuse truncated downloads
MAX_BYTES=200000000

mkdir -p "$(dirname "$DEST")"
TMP="$(mktemp "$(dirname "$DEST")/.ip2asn.XXXXXX")"
trap 'rm -f "$TMP"' EXIT

curl -fsSL --proto '=https' --max-time 300 --max-filesize "$MAX_BYTES" -o "$TMP" "$URL"

SIZE=$(wc -c < "$TMP")
if [ "$SIZE" -lt "$MIN_BYTES" ]; then
  echo "update-asn-db: download too small ($SIZE bytes), keeping existing file" >&2
  exit 1
fi
# Validate: gzip integrity and the expected 5-column TSV shape.
gzip -t "$TMP"
if ! gzip -dc "$TMP" | head -n 100 | awk -F'\t' 'NF < 5 { bad=1 } END { exit bad }'; then
  echo "update-asn-db: unexpected file format, keeping existing file" >&2
  exit 1
fi

chmod 0644 "$TMP"
mv -f "$TMP" "$DEST"
trap - EXIT
echo "update-asn-db: wrote $DEST ($SIZE bytes)"
