# DomiNode Scripts

Team: **Infrastructure**

Build, deployment, backup and testing scripts.

## Key Scripts
- `gen-coord-key.mjs` / `gen-coord-key.sh` — Generate the coordinator ed25519 signing key (see docs/agent-network/DEPLOYMENT.md)
- `update-asn-db.sh` — Refresh the ASN database used for node IP classification
- `backup.sh` / `restore.sh` — Database backup/restore
- `e2e-test.sh` — End-to-end testing

## Rules
- Credential exposure: use `printf | curl --data @-` not `curl -d '{"password":"..."}'`
- API keys: pass via env var (e.g. DOMINUSNODE_API_KEY), NOT command-line arguments
- Cleanup: use `trap 'rm -f sensitive_file' EXIT` for credential files
- Log redaction: only show 8 chars of API key prefix
- .env.example files: NEVER include real email addresses — use placeholder@yourdomain.com
- Scripts that create temp credential files must clean them up on EXIT/SIGTERM/SIGINT
