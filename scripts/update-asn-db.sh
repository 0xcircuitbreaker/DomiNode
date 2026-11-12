#!/usr/bin/env bash
# Download the iptoasn.com IP-to-ASN dataset (Public Domain, PDDL v1.0) used by
# the proxy gateway for node ASN caps and dc/residential classification.
# No license key or account required. Run from cron (e.g. daily) and restart
# or roll the gateway to pick up the new file.
#
# Usage: scripts/update-asn-db.sh [dest]   (default: data/ip2asn-combined.tsv.gz,
#        or $ASN_DB_FILE). The gateway reads ASN_DB_FILE (same default).
#
# Also refreshes the optional anonymizer IP list used for the 'masked' exit
# class (ANONYMIZER_IPS_FILE, default data/anonymizer-ips.txt). Best effort:
# a failed download keeps the previous list and never fails the ASN update.
#   - Tor exit list (https://check.torproject.org/torbulkexitlist, public;
#     disable with ANONYMIZER_TOR=0)
#   - iCloud Private Relay egress ranges (https://mask-api.icloud.com/egress-ip-ranges.csv,
#     published by Apple; opt-in with ANONYMIZER_ICLOUD=1 after checking Apple's terms)
# The anonymizer ASN list itself is versioned in data/anonymizer-asns.json.
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

# ─── Optional anonymizer IP list (best effort) ─────────────────────
ANON_DEST="${ANONYMIZER_IPS_FILE:-data/anonymizer-ips.txt}"
mkdir -p "$(dirname "$ANON_DEST")"
ANON_TMP="$(mktemp "$(dirname "$ANON_DEST")/.anon.XXXXXX")"
PART="$(mktemp "$(dirname "$ANON_DEST")/.anonpart.XXXXXX")"
trap 'rm -f "$ANON_TMP" "$PART"' EXIT
printf '# anonymizer egress IPs/CIDRs for the masked exit class; generated %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" > "$ANON_TMP"
GOT=0
if [ "${ANONYMIZER_TOR:-1}" != "0" ]; then
  if curl -fsSL --proto '=https' --max-time 120 --max-filesize 10000000 -o "$PART" \
      "https://check.torproject.org/torbulkexitlist"; then
    grep -E '^[0-9a-fA-F:.]+$' "$PART" >> "$ANON_TMP" || true
    GOT=1
  else
    echo "update-asn-db: Tor exit list download failed (keeping previous anonymizer list)" >&2
  fi
fi
if [ "${ANONYMIZER_ICLOUD:-0}" = "1" ]; then
  if curl -fsSL --proto '=https' --max-time 300 --max-filesize 100000000 -o "$PART" \
      "https://mask-api.icloud.com/egress-ip-ranges.csv"; then
    cut -d, -f1 "$PART" | grep -E '^[0-9a-fA-F:.]+/[0-9]{1,3}$' >> "$ANON_TMP" || true
    GOT=1
  else
    echo "update-asn-db: iCloud Private Relay list download failed (keeping previous anonymizer list)" >&2
  fi
fi
if [ "$GOT" = "1" ]; then
  chmod 0644 "$ANON_TMP"
  mv -f "$ANON_TMP" "$ANON_DEST"
  echo "update-asn-db: wrote $ANON_DEST ($(grep -vc '^#' "$ANON_DEST" || true) entries)"
fi
rm -f "$PART" "$ANON_TMP"
trap - EXIT
