#!/usr/bin/env bash
# Generate the coordinator CHALLENGE signing key (ed25519, PKCS8 PEM).
# The private key is written with mode 0600 and never printed; only the raw
# 32-byte public key is printed as 64 hex chars, for DN_COORD_PUBKEYS
# (node-agent release builds) and the gateway's COORD_SIGNING_KEY_FILE.
#
# Usage: scripts/gen-coord-key.sh <output.pem>
# See docs/agent-network/DEPLOYMENT.md for embedding and rotation.
set -euo pipefail

OUT="${1:-}"
if [ -z "$OUT" ]; then
  echo "usage: $0 <output.pem>" >&2
  exit 2
fi
if [ -e "$OUT" ]; then
  echo "gen-coord-key: $OUT already exists; refusing to overwrite" >&2
  exit 1
fi

umask 077
# Generate into the final path with a restrictive umask (no world-readable window).
openssl genpkey -algorithm ed25519 -out "$OUT" 2>/dev/null
chmod 0600 "$OUT"

# Raw public key = last 32 bytes of the DER SubjectPublicKeyInfo.
PUB_HEX=$(openssl pkey -in "$OUT" -pubout -outform DER 2>/dev/null | tail -c 32 | od -An -tx1 -v | tr -d ' \n')
if ! [[ "$PUB_HEX" =~ ^[0-9a-f]{64}$ ]]; then
  echo "gen-coord-key: failed to derive public key" >&2
  rm -f "$OUT"
  exit 1
fi
echo "$PUB_HEX"
