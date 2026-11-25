# Gateway capacity procedure

How to measure what one relay gateway can carry on its HTTP CONNECT, SOCKS5 and
node-tunnel path, how to read the numbers, which knobs move them, and how to
record a baseline. The tool is `scripts/loadtest/loadtest.mjs` (`npm run loadtest`).
It uses only Node built-ins.

## 1. What the harness does

```
 N clients (CONNECT / SOCKS5)          relay gateway             mock node agents         local sink
 ─────────────────────────── ──▶ :8080 / :1080 ──▶ node tunnel ──▶ (real tunnel client, ──▶ reads request bytes,
                                                                    every OPEN dialled       sends response bytes,
                                                                    to the sink)             closes
```

- Each client opens a tunnel, sends `--request-bytes`, reads `--response-bytes`
  and closes. With `--rate 0` (the default) each client loops as fast as it can
  (closed loop). With `--rate R`, new tunnels across all clients are spaced to
  at most R per second (open loop, rate-limited).
- The mock node agents are the real `TunnelClient` from
  `packages/node-agent/dist`, so the gateway sees a normal authenticated node.
  Only the dial step is replaced: every OPEN goes to the local sink, whatever the
  target. The gateway still applies its own target policy to `--target` (default
  `loadtest.example.org:443`), so the name must pass the gateway's checks.
- The run records, per protocol: tunnel-established latency (`connect`),
  full round-trip latency (`total`), p50/p95/p99/max, requests per second,
  throughput, and error counts by class. With `--gateway-pid`, it samples the
  gateway's RSS and open file descriptors from `/proc`. With `--api-url`, it
  compares billed bytes (`/api/usage`) with the bytes the clients pushed through
  established tunnels.
- Output: `<out>.json` (machine readable) and `<out>.txt` (the same summary as
  stdout).

Safety:

- The gateway, tunnel and API hosts must be local addresses (loopback, RFC 1918,
  ULA, `localhost`) unless `--allow-remote` is passed. Loading a remote gateway
  costs real money and real node bandwidth; only do it against staging that you
  own.
- Keys come from the environment only. No flag accepts a key, and errors are
  scrubbed of `dn_*` keys.

| Variable | Used for |
|---|---|
| `DN_LOADTEST_API_KEY` | Requester `dn_live_` key: proxy password, `/api/usage` bearer |
| `DN_LOADTEST_NODE_KEY_FILES` | Comma-separated node key files (mode 0600) from `node-agent register` |
| `DN_LOADTEST_COORD_PINS` | Coordinator ed25519 public keys (hex), comma-separated |
| `DN_LOADTEST_TUNNEL_CA_FILE` | Optional PEM CA when the local tunnel uses a self-signed certificate |

These are harness variables, not service configuration, so they are not in
`ENV_REFERENCE.md`.

## 2. Procedure

### 2.1 Harness baseline (no gateway)

Measure the load generator on its own first. If the box running it cannot beat
these numbers by a wide margin, the gateway numbers measure the client, not the
gateway.

```bash
npm run loadtest -- --mock-gateway --http-port 18080 --socks-port 11080 \
  --concurrency 200 --duration 60 --out reports/harness-baseline
```

### 2.2 Local gateway with mock nodes

1. Start PostgreSQL, migrate, build, generate the coordinator key and start the
   API and gateway as in the root quick start. Use a scratch database.
2. Create a requester agent with a dedicated key and fund its wallet (admin
   credit) well beyond the bytes you plan to send. A dedicated key matters: the
   metering check reads all usage for that key since the run started.
3. Register 1 to 5 nodes with `node-agent register` (different `nodeId`s, files
   mode 0600). Approve them in the admin panel if your staging requires it.
4. Raise the per-user and global caps so they do not mask the gateway limit
   (section 4), then restart the gateway.
5. Run:

```bash
export DN_LOADTEST_API_KEY=...                     # from a file or secret store
export DN_LOADTEST_NODE_KEY_FILES=$HOME/.dominusnode/lt1.key,$HOME/.dominusnode/lt2.key
export DN_LOADTEST_COORD_PINS=<coordinator pubkey hex>
npm run loadtest -- --mock-nodes --tunnel-url wss://127.0.0.1:9443/v1/tunnel \
  --gateway-pid "$(pgrep -f proxy-gateway/dist/src/main.js)" \
  --api-url http://127.0.0.1:3000 \
  --concurrency 50 --duration 120 --out reports/gw-c50
```

Use the tunnel URL and port your gateway listens on (`TUNNEL_PORT`, default 9443, path `/v1/tunnel`).

6. Step the load: repeat with `--concurrency` 50, 100, 200, 400, 800 (or
   `--rate` steps with a high concurrency) until p99 or the error rate breaks
   the targets in section 3. The last step that passes is the capacity for that
   payload shape.
7. Repeat for the payload shapes that matter: small (`--request-bytes 512
   --response-bytes 4096`, API-like), medium (defaults), bulk
   (`--response-bytes 5242880`, page or file fetch).

### 2.3 Soak

```bash
npm run loadtest -- --soak --duration 43200 --report-interval 300 \
  --mock-nodes --tunnel-url wss://127.0.0.1:9443/v1/tunnel \
  --gateway-pid "$(pgrep -f proxy-gateway/dist/src/main.js)" \
  --api-url http://127.0.0.1:3000 --rate 100 --concurrency 100 \
  --out reports/soak-12h
```

Run it at about 60% of the capacity found in 2.2. The report files are
rewritten every `--report-interval` seconds, and a progress line goes to stderr,
so a crash still leaves data. Latency samples are kept in a bounded reservoir
(200k per series), so memory stays flat on long runs. Stop early with Ctrl-C;
the final report is still written.

### 2.4 Against staging

Only with `--allow-remote`, a dedicated funded key, and real nodes (no
`--mock-nodes` unless the staging tunnel is reachable). Tunnels then exit through
real nodes to `--target`, which must be a sink you run (for example a TCP sink on
a host you own at `sink.example.org:443`). Never point it at third-party sites.
`--gateway-pid` is refused for remote gateways: sample RSS and fds on the
gateway host itself (or from the observability stack, OBSERVABILITY.md).

## 3. Reading the results

| Field | Pass target (launch) | Notes |
|---|---|---|
| `totals.errorRatePct` | < 0.1% | Under load the first errors are usually `http_429_TOO_MANY_CONNECTIONS` (a cap, not a crash) |
| `connectMs.p99` | < 250 ms local, < 1 s staging | Auth, balance check, node selection and tunnel OPEN |
| `totalMs.p99` | shape-dependent | Should grow with payload size, not with concurrency |
| `gateway.rssBytes.growth` | flat after warm-up on a soak | Steady growth over hours suggests a leak |
| `gateway.fds.growth` | back near `first` after the run | fds that stay open point at leaked sockets |
| `metering.verdict` | `ok` (within 1%) | See below |

Error classes:

- `http_<status>_<CODE>`: the gateway's CONNECT reply with its `X-DominusNode-Error`
  code. 407 is auth, 402 is balance, 429 is a connection cap, 502/503/504 come
  from the node side (`mapOpenError`).
- `socks5_<reason>`: the SOCKS5 reply code.
- `conn_refused`, `conn_reset`, `timeout_handshake`, `timeout_transfer`,
  `short_response`, `handshake_closed`: transport failures.
- `local_fd_exhausted`, `local_ports_exhausted`: the load generator ran out of
  file descriptors or ephemeral ports. Fix the client box (section 4) and rerun;
  these say nothing about the gateway.

Metering: the harness counts payload bytes after the tunnel is established, both
directions. The gateway bills the bytes it relays on the tunnel, so the two
should agree within about 1%. A small positive delta is normal if the gateway
counts protocol overhead. `under_billed` beyond 1% is a revenue bug; report it to
Core Platform. Usage is written asynchronously, so `--metering-wait` (default 15
s) waits for the flush. If the verdict changes when you rerun with a longer
wait, raise the wait rather than trusting the first read.

## 4. Scaling knobs

Gateway (see ENV_REFERENCE.md for ranges and defaults):

- `PROXY_MAX_CONNECTIONS`: global concurrent client connections (default 5000).
- `PROXY_MAX_PER_USER`: concurrent connections per requester. A single load-test
  key hits this first; raise it on the test gateway only.
- `PROXY_CONNECT_TIMEOUT_MS`, `TUNNEL_IDLE_TIMEOUT_MS`: how long stuck tunnels hold
  sockets.
- `DB_POOL_MAX`: auth and balance lookups on new connections; raise it if
  `connectMs` climbs while CPU is low.
- Node side (mock nodes use generous caps automatically): `maxStreams`, request
  rate and daily byte caps per node. Real capacity is bounded by the sum over
  healthy nodes.

Operating system (gateway and client hosts):

- `ulimit -n` (or `LimitNOFILE=` in the systemd unit) at least 4x the target
  concurrent connections: each relayed connection holds a client socket plus a
  tunnel stream.
- `net.ipv4.ip_local_port_range = 1024 65535` and `net.ipv4.tcp_tw_reuse = 1` on
  the client box for high connection churn.
- `net.core.somaxconn` and `net.ipv4.tcp_max_syn_backlog` for bursts.
- Node.js is single-threaded per process: when one core sits at 100%, scale out
  (more gateway processes or hosts behind the load balancer), not up.

## 5. Recording a baseline

For every release candidate and for every gateway host size, keep:

1. The JSON report of each step in 2.2 and of the soak, named
   `<date>-<gitsha>-<host-size>-<shape>-c<concurrency>.json`.
2. The commit (`git rev-parse HEAD`), Node version, host vCPU/RAM, gateway
   environment caps, number of mock or real nodes, and payload shape.
3. A row in the release notes or ops log:

| Date | Commit | Host | Shape | Max passing concurrency | rps | p99 connect | p99 total | Mbit/s | Soak RSS growth | Metering |
|---|---|---|---|---|---|---|---|---|---|---|
| YYYY-MM-DD | abc1234 | 2 vCPU / 4 GB | 1 KiB / 16 KiB | ... | ... | ... ms | ... ms | ... | ... MiB / 12 h | ok |

A regression is a drop of more than 15% in max passing concurrency or rps, or a
rise of more than 25% in p99, against the last baseline on the same host size.
Investigate before shipping.

## 6. Known limits of the harness

- One Node process drives all clients. Past a few thousand concurrent tunnels,
  run several harness processes (different `--out`) and add the results.
- Mock nodes run in the harness process, so they compete with the clients for
  CPU. For the highest loads, run node agents on separate hosts.
- RSS and fd sampling needs Linux `/proc` and permission to read the gateway's
  process (same user or root).
- The metering check reads `/api/usage` totals for the key; other traffic on
  that key during the run skews it.
