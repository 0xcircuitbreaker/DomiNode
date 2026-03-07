# DomiNode Infrastructure

Team: **Infrastructure**

Docker, nginx, Caddy configuration for deployment.

## Directories
- `docker/` — Dockerfiles for services
- `caddy/` — Caddy reverse proxy config (production)
- `nginx/` — nginx reverse proxy config (alternative)

## Rules
- Docker prod proxy ports: bind to 127.0.0.1, not 0.0.0.0 (use env vars for external exposure)
- Proxy Dockerfile: include healthcheck
- Frontend Docker: bind to 127.0.0.1
- nginx: X-Frame-Options DENY, proxy_hide_header X-Powered-By+Server, non-root user
- Caddy: CSP header configured
- GitHub Actions: pin to full SHA, not mutable tags
