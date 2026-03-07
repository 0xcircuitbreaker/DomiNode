# DomiNode Scripts

Team: **Infrastructure**

Build, deployment, testing, and swarm orchestration scripts.

## Key Scripts
- `swarm.sh` — Unified swarm launcher (team mode + solo mode)
- `ai-swarm.sh` — SGLang + AI orchestrator launcher
- `ai-swarm-orchestrator.py` — Python/CrewAI orchestration
- `swarm-showcase.py` — Curses TUI for 24 integrations
- `backup.sh` / `restore.sh` — Database backup/restore
- `e2e-test.sh` — End-to-end testing

## Rules
- Credential exposure: use `printf | curl --data @-` not `curl -d '{"password":"..."}'`
- API keys: pass via env var (SWARM_API_KEY), NOT command-line arguments
- Cleanup: use `trap 'rm -f sensitive_file' EXIT` for credential files
- Log redaction: only show 8 chars of API key prefix
- .env.example files: NEVER include real email addresses — use placeholder@yourdomain.com
- Scripts that create temp credential files must clean them up on EXIT/SIGTERM/SIGINT
