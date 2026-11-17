# Observability

An operator kit for the relay gateway and the API: Prometheus scrape config,
alert rules, a Grafana dashboard and an optional compose overlay. None of it
needs the gateway VPS to exist yet; set it up on the coordinator first and add
the gateway target when the VPS is up.

| File | Purpose |
|------|---------|
| `infra/observability/prometheus.yml` | Scrape jobs for gateway and API `/metrics` |
| `infra/observability/alerts.yml` | Alert rules (runbooks below) |
| `infra/observability/grafana-dashboard.json` | Importable Grafana dashboard |
| `docker-compose.observability.yml` | Optional Prometheus + Grafana overlay |

`packages/shared/tests/observability-kit.test.ts` fails if an alert or panel
references a metric the code does not emit, or an alert has no runbook here.

## What is exported

| Endpoint | Access | Metrics |
|----------|--------|---------|
| Gateway `/metrics` on every proxy HTTP listener; scrape the TLS proxy `:8443` (production publishes `:8080` on loopback only) | Loopback without auth; otherwise `Authorization: Bearer <PROXY_STATS_SECRET>` (when unset, derived from `JWT_SECRET` by HMAC; with neither, non-loopback gets 403) | `dominusnode_proxy_requests_total`, `_errors_total`, `_sessions_total`, `_active_sessions`, `_bytes_in_total`, `_bytes_out_total`, `_latency_ms{quantile}`, `_uptime_seconds`, `_status` |
| API `:3000/metrics` | Loopback without auth; otherwise `Authorization: Bearer <API_METRICS_SECRET>` (32+ chars; unset or shorter means non-loopback gets 403) | `dominusnode_api_up` (0 when `SELECT 1` fails), `_uptime_seconds`, `_memory_rss_bytes`, `_memory_heap_used_bytes`, `_memory_heap_total_bytes` |

All gateway series are process-wide: no labels for exit class, tier or node.

## Setup

1. Set `PROXY_STATS_SECRET` explicitly on the gateway (`openssl rand -hex 32`)
   so the token does not change when `JWT_SECRET` rotates.
2. Pick an `API_METRICS_SECRET` the same way and put it in the coordinator's
   `.env` (the overlay refuses to start without it and passes it to the API).
3. On the coordinator write the secret files (the directory is git-ignored):
   ```bash
   install -d -m 0755 infra/observability/secrets
   cd infra/observability/secrets
   printf '%s' "$PROXY_STATS_SECRET" > proxy_stats_secret
   printf '%s' "$API_METRICS_SECRET" > api_metrics_secret
   openssl rand -hex 24 > grafana_admin_password
   sudo chown 65534:65534 proxy_stats_secret api_metrics_secret  # Prometheus user
   sudo chown 472:472 grafana_admin_password                      # Grafana user
   sudo chmod 0400 proxy_stats_secret api_metrics_secret grafana_admin_password
   ```
4. Edit `infra/observability/prometheus.yml`: replace `gateway.example.org`
   with the gateway's TLS proxy host (the name on its certificate). The scrape
   uses `https://…:8443/metrics`, so the token never crosses the network in
   plaintext; the plaintext `:8080` listener is loopback-only in production.
5. Start: `docker compose -f docker-compose.prod.yml -f docker-compose.observability.yml up -d`.
   Prometheus and Grafana join the `backend` network (Prometheus scrapes
   `api:3000`) and are published on `127.0.0.1` only (Prometheus `:9090`,
   Grafana `:3001`). Reach them over SSH port forwarding or WireGuard. Log in
   to Grafana as `admin` with the password from `grafana_admin_password`.
6. In Grafana add a Prometheus data source at `http://prometheus:9090`, then
   Dashboards, Import, upload `grafana-dashboard.json` and pick that source.
7. Uncomment the `alerting:` block in `prometheus.yml` and point it at an
   Alertmanager that routes `severity="page"` to your pager and
   `severity="warn"` to chat.

Check: `curl -s localhost:9090/api/v1/targets | jq '.data.activeTargets[].health'`
should print `"up"` for each job.

## Alerts and runbooks

### GatewayDown
Prometheus cannot scrape the gateway. Check the gateway process
(`docker compose ps` / `systemctl status`), the VPS itself, the WireGuard
link, that `:8443` is reachable from the coordinator and its certificate is
valid for the scrape host, and that the token file matches `PROXY_STATS_SECRET`
(a 401 or 403 also shows as down; see the target's last error in Prometheus).

### ApiDown
API `/metrics` unreachable. Check the API container/service and logs. A 403
means `API_METRICS_SECRET` is unset or shorter than 32 characters in the API's
environment, or does not match `secrets/api_metrics_secret`.

### ApiDatabaseUnhealthy
The API answered but `SELECT 1` failed. Check PostgreSQL (`pg_isready`), disk
space, connection limits (`SELECT count(*) FROM pg_stat_activity`), and the
WireGuard link if the DB is remote. Payments and settlement stop while this fires.

### GatewayDegraded
The gateway's own stats flag it degraded. Look at `/internal/stats` from
loopback and gateway logs; check how many nodes are connected
(`relayNodes` in that output, or the `/api/admin/network` routes in ADMIN_API.md).

### GatewayRestarting
Gateway uptime reset recently. One restart after a deploy is expected; repeated
ones mean a crash loop: read the logs around the restart and check OOM kills
(`dmesg | grep -i oom`).

### ApiRestarting
Same as above for the API.

### GatewayHighErrorRate
More than 10% of relay requests end in an error for 10 minutes. Common causes:
no ready node for the requested class or country, nodes flapping, upstream DNS
trouble, or a burst of bad credentials. Check gateway logs by error code and
the admin node list for ready counts; a sudden spike after a deploy means roll back.

### GatewayNoTraffic
No requests for 30 minutes while the gateway has been up. Either nobody is
using the network (fine in early alpha; silence it) or the front end is
unreachable: test with `curl -x https://relay:$DOMINUSNODE_API_KEY@gateway.example.org:8443 https://example.org`
(key from an env var), and check DNS, firewall and the TLS listener (8443
HTTPS proxy, 1443 SOCKS5 over TLS, 9443 node tunnel).

### GatewayHighLatency
p95 connect latency above 5 s for 15 minutes. Usually slow or overloaded exit
nodes; check node health in the admin UI and the gateway VPS CPU/network.

### ApiHighMemory
API RSS above 1.5 GB for 15 minutes. Possible leak or oversized in-memory maps;
take a heap snapshot if you can, then restart the API.

### ApiHeapNearLimit
Heap almost full; GC thrash and OOM follow. Same action as ApiHighMemory.

## Not covered yet (no metric exists)

The kit only uses metrics the code emits today. These checks are wanted but
need new exports first, so until then run them by hand or from cron with SQL /
the admin API:

- Ready nodes total and by exit class / tier (no-ready-node and low-count alerts).
- Bytes by exit class, payouts and settlement totals.
- 5xx vs auth-failure split (the gateway exports one error counter).
- Unverified-node backlog.
- Settlement and `job_runs` staleness (check `SELECT job_name, last_ok, last_success_at, now() - last_success_at AS age FROM job_runs ORDER BY age DESC`).
- DB pool saturation.
- TLS certificate expiry (add a blackbox exporter `probe_ssl_earliest_cert_expiry`
  probe of your own if you want it; it is outside this kit).
