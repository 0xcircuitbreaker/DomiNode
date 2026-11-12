# Relay deployment notes

Short operator guide for the coordinator signing key, node-agent pin
embedding, the ASN database and the tunnel ingress. See DESIGN.md §2, §4, §11.

Every environment variable the server packages read is listed, with its
inline default and the files that read it, in
[ENV_REFERENCE.md](ENV_REFERENCE.md). That file is generated from the code
(`npm run docs:env`) and CI fails when it is stale (`npm run docs:env:check`).
Startup validation: the API refuses to start without `DATABASE_URL` and a
32+ character `JWT_SECRET`; the gateway refuses to start without
`DATABASE_URL`, without `COORD_SIGNING_KEY_FILE` in production, or when two
listener ports clash. Both list every problem in one error.

## 0. Hostname plan

DominusNode ships as a Daedalus Development Group product. Every SDK, the MCP
server, the node agent, the extension and the integrations default to these
hosts; each stays overridable through its existing env/config option
(`DOMINUSNODE_API_URL`, `DOMINUSNODE_PROXY_HOST`, `DN_NODE_API_URL`,
`DN_NODE_GATEWAY_URL`, `baseUrl`/`proxyHost` client options, and so on).

| Host | Serves | Points to | Ports | TLS |
|------|--------|-----------|-------|-----|
| `dominusnode.com` | Public site and admin dashboard (`packages/frontend`) | Static host (Netlify) or the frontend container behind Caddy/nginx | 443 (80 redirects) | Host-managed or Caddy ACME cert for this name |
| `www.dominusnode.com` | 301 redirect to `https://dominusnode.com{uri}` | Same as the site | 443 (80 redirects) | Same cert as the site (SAN) |
| `api.dominusnode.com` | REST API (`packages/dashboard`): `/v1`, `/api`, `/.well-known/*`, `/status` | Caddy (`infra/caddy/Caddyfile`) -> `api:3000` | 443 | Caddy ACME (HTTP-01/TLS-ALPN) |
| `proxy.dominusnode.com` | Relay gateway front end (`packages/proxy-gateway`) | Gateway host public IP, ports exposed directly (not via an HTTP reverse proxy) | 8080 HTTP proxy, 1080 SOCKS5, 8443 TLS proxy (`PROXY_TLS_PORT`) | Gateway terminates TLS on 8443 with `PROXY_TLS_CERT_FILE`/`PROXY_TLS_KEY_FILE`; cert issued via DNS-01 since 80/443 may not be on this host |
| `relay.dominusnode.com` | Node tunnel, `wss://relay.dominusnode.com/v1/tunnel` | Gateway host; :443 via Caddy layer4 SNI passthrough (§5 Option A) to `TUNNEL_PORT` (9443), or `TUNNEL_PORT` exposed directly (Option B) | 443 (or 9443 direct) | End-to-end TLS terminated by the gateway (`TUNNEL_TLS_CERT_FILE`/`TUNNEL_TLS_KEY_FILE`), never by Caddy, so channel binding holds |

DNS records (in the `dominusnode.com` zone):

| Name | Type | Value | Cloudflare proxy |
|------|------|-------|------------------|
| `@` | A / AAAA (or CNAME-flattened to the static host) | Site / web server | May be proxied (orange cloud) |
| `www` | CNAME | `dominusnode.com.` | May be proxied |
| `api` | A / AAAA | API/Caddy host | May be proxied (HTTP only; keep `TRUST_PROXY` correct) |
| `proxy` | A / AAAA | Gateway host | **DNS only (grey cloud).** Cloudflare cannot carry raw HTTP-proxy, SOCKS5 or TLS-proxy traffic on 8080/1080/8443 |
| `relay` | A / AAAA | Gateway host (or the Caddy layer4 host in front of it) | **DNS only (grey cloud).** The tunnel needs end-to-end TLS to the gateway for channel binding and the real client IP |

- Optional CAA record restricting issuance to the chosen CA.
- Mail aliases to set up on `dominusnode.com` (optional): `abuse@dominusnode.com`
  and `security@dominusnode.com`, both forwarding to the published contact
  `0xcircuitbreaker@protonmail.com`. That address stays the contact of record.

Secondary alias: `dominusnode.daedalusdevelopmentgroup.com` (DDG subdomain)

The previous primary names keep working so existing clients, nodes and links
do not break:

- `dominusnode.daedalusdevelopmentgroup.com`: 301 redirect to
  `https://dominusnode.com{uri}` (Netlify domain alias with a forced redirect,
  or `redir https://dominusnode.com{uri} permanent` in Caddy).
- `api.dominusnode.daedalusdevelopmentgroup.com`,
  `proxy.dominusnode.daedalusdevelopmentgroup.com` and
  `relay.dominusnode.daedalusdevelopmentgroup.com`: served directly (no
  redirect; proxy clients and node tunnels do not follow redirects), as extra
  SANs on the same certificates as the `dominusnode.com` names. Keep the same
  A/AAAA records and the same no-Cloudflare-proxy rule for `proxy.` and
  `relay.` in the `daedalusdevelopmentgroup.com` zone.
- List both names in `COORDINATOR_HOSTNAMES` and both site origins in
  `CORS_ORIGINS` (below).
- Synthetic wallet emails moved to `wallet.dominusnode.com`; rows created under
  `wallet.dominusnode.daedalusdevelopmentgroup.com` are still recognised by `isWalletEmail`.

Notes:

- Gateway ports (one reader, `getProxyPorts()` in `@dominusnode/shared`, used by
  the gateway and the API): `PROXY_LISTEN_PORT` 8080, `SOCKS5_LISTEN_PORT` 1080,
  `PROXY_TLS_PORT` (e.g. 8443, off when unset), `SOCKS5_TLS_PORT` (off when
  unset), `TUNNEL_PORT` 9443. The gateway refuses to start when two of them are
  equal. Route `relay.` SNI on :443 to `TUNNEL_PORT`.
- The API advertises the same ports; when a load balancer remaps them, set
  `PROXY_PUBLIC_HTTP_PORT`, `PROXY_PUBLIC_SOCKS5_PORT`, `PROXY_PUBLIC_TLS_PORT`,
  `PROXY_PUBLIC_SOCKS5_TLS_PORT` or `PROXY_PUBLIC_TUNNEL_PORT` on the API.
  `PROXY_INTERNAL_PORT` (default `PROXY_LISTEN_PORT`) is the port the API uses
  for gateway-internal calls.
- One certificate with SANs for `proxy.` and `relay.` may be reused by both
  gateway listeners.
- Dashboard env for this plan: `APP_URL=https://dominusnode.com`,
  `CORS_ORIGINS=https://dominusnode.com,https://www.dominusnode.com,https://dominusnode.daedalusdevelopmentgroup.com`,
  `DOMINUSNODE_DOMAIN=dominusnode.com` (SIWE domain),
  `COORDINATOR_HOSTNAMES=dominusnode.com,dominusnode.daedalusdevelopmentgroup.com`,
  `PROXY_PUBLIC_HOST=proxy.dominusnode.com`.


## 1. Coordinator signing key

The gateway signs every tunnel CHALLENGE with an ed25519 key. Node agents
verify the signature against pinned public keys and refuse to authenticate
to an unpinned coordinator.

Run from the repository root. Works on macOS, Linux and Windows (Node.js only):

```bash
npm run gen:coord-key -- ~/.dominusnode/coord-key.pem
# prints the 64-hex public key; the PEM (PKCS8) is written mode 0600
```

On a Linux server you can write straight to a root-owned path:
`sudo node scripts/gen-coord-key.mjs /etc/dominusnode/coord-key.pem`.
`scripts/gen-coord-key.sh` does the same with `openssl` (needs OpenSSL with
ed25519; macOS LibreSSL may lack it).

- Gateway: `COORD_SIGNING_KEY_FILE=/etc/dominusnode/coord-key.pem`.
  It is required when `NODE_ENV=production`. The gateway logs the public key
  at startup.
- Keep the PEM out of the repo and out of images. Mount it as a secret file.
  The script refuses to overwrite an existing file.

## 2. Embedding pins in node-agent builds

`packages/node-agent/src/coord-pins.generated.ts` holds the embedded pin list.
The committed copy is empty (dev). Release builds regenerate it:

```bash
DN_COORD_PUBKEYS=<hex64>[,<hex64>...] npm run build:release -w @dominusnode/node-agent
```

`build:release` runs `scripts/gen-coord-pins.mjs --require`, which fails the
build when the list is empty or holds an entry that is not 64 hex chars. The
list holds at most 16 pins. Operators can add pins at runtime with
`DN_NODE_COORD_PINS`, but they cannot remove embedded pins. Don't commit a
regenerated file.

## 3. Key rotation

1. Generate the new key: `scripts/gen-coord-key.sh new.pem`.
2. Ship agents whose pin list includes both keys:
   `DN_COORD_PUBKEYS=<old>,<new>`.
3. Wait until the fleet has upgraded. Old agents only know `<old>`.
4. Switch the gateway's `COORD_SIGNING_KEY_FILE` to `new.pem` and restart
   (rolling).
5. In a later release, drop `<old>` from `DN_COORD_PUBKEYS`. Destroy the old
   PEM.

For a compromised key, do steps 1, 2 and 4 together. Treat agents that never
upgrade as lost.

## 3b. API key pepper

`api_keys.key_hash` holds `HMAC-SHA256(pepper, key)` (v2) when
`API_KEY_PEPPER_FILE` is set, otherwise plain `SHA-256(key)` (v1). The pepper
lives outside the database, so a DB dump alone cannot confirm or correlate a
`dn_live_` key (SECURITY_ARCHITECTURE.md §2.6).

```bash
umask 077; openssl rand -hex 32 > secrets/api-key-pepper
```

- Mount the **same** file into the API and the gateway (Docker secret or
  systemd credential) and set `API_KEY_PEPPER_FILE` in both. A mismatch makes
  every migrated key fail on one side.
- Hex (64+ chars) or at least 32 raw bytes. A set but unreadable or short file
  stops startup. Each service logs `API key hashing {peppered}` at start.
- Migration is lazy: auth looks up the v2 and v1 hashes in one query,
  re-checks the match in constant time and rewrites a v1 row to v2. Keys never
  used again stay v1 and keep working. New keys are stored as v2.
- Do not remove or change the pepper once keys are migrated: that revokes them.
  Back it up with the coordinator key.
- Node keys (`dn_node_`) still use SHA-256; they are not covered yet.

## 3a. Federation documents

The API serves `/.well-known/dominusnode/coordinator.json` and `policy.json`
(see FEDERATION.md), signed with `COORD_SIGNING_KEY_FILE`. Both are built from
one policy read and cached together for 5 minutes. Settings:

| Variable | Meaning |
|---|---|
| `APP_URL` | Public API origin. Must be `https://`; otherwise the documents return 503 and the API logs why (node agents refuse http). |
| `COORDINATOR_HOSTNAMES` | Comma list of every domain this coordinator answers on (for example the apex domain and a DDG subdomain). Defaults to `DOMINUSNODE_DOMAIN`, then the `APP_URL` host. No host is hardcoded. |
| `COORD_TUNNEL_URL` | `wss://` tunnel URL. Default `wss://relay.<first hostname>/v1/tunnel`. |
| `PROXY_PUBLIC_HOST` | Public proxy host. Default `proxy.<first hostname>`. |
| `COORD_ADDITIONAL_PUBKEYS` | Rotation keys listed next to the signer (hex, comma list). A malformed entry is an error, not skipped. Agents pin them only when their fingerprints are passed to `--trust`. |
| `OFFICIAL_COORD_PUBKEYS` | Keys that get the official name and default contact. Other keys get neutral branding. |
| `SITE_NAME`, `OPERATOR_NAME`, `OPERATOR_CONTACT`, `ABUSE_CONTACT` | Branding and contacts shown in the document. |

A node joins with `--coordinator <domain> --trust sha256:<fp>[,sha256:<fp>...]`.
After that its tunnel pins are only the confirmed keys plus any
`DN_NODE_COORD_PINS`; the embedded official pins are not added.

Export a durable signed policy file with
`COORD_SIGNING_KEY_FILE=... node scripts/export-signed-policy.mjs [--out policy.json]`.
Policy files carry version and hash, so they do not expire.

## 4. ASN database

The gateway uses the iptoasn.com `ip2asn-combined.tsv.gz` dataset (Public
Domain, PDDL v1.0). It needs no license key and makes no runtime calls. It is
the only geo source: its country column drives the OFAC sanctions check on
destinations and node peers, and its ASN column drives the per-ASN node cap
and dc/residential classification. There is no separate GeoIP library.

```bash
scripts/update-asn-db.sh            # writes data/ip2asn-combined.tsv.gz (or $ASN_DB_FILE)
```

- Run it daily from cron, then roll the gateways.
- `ASN_DB_FILE`: path the gateway loads (default
  `data/ip2asn-combined.tsv.gz`).
- In production, a public node whose ASN is unknown is refused
  (`ASN_UNAVAILABLE`). This applies when the file is missing or the address
  is unrouted. Set `ASN_DB_OPTIONAL=true` to fall back to the shared
  unknown-ASN bucket.
- The file is required for traffic. If it is missing or corrupt, every public
  destination is refused (`UNKNOWN`) and every public node peer is refused
  (`GEO_UNAVAILABLE`), in every environment. `ASN_DB_OPTIONAL` does not relax
  this.
- In production, a public destination or peer with no country in the dataset
  (unrouted, or country `None`) is refused. Outside production such
  destinations are allowed.
- `SKIP_GEOIP=1` skips the file and disables geo checks for local dev and
  stress tests. It is ignored when `NODE_ENV=production`.
- `docker-compose.prod.yml` mounts `./data` read-only at `/app/data`; run the
  script on the host before starting the proxy.

`docker-compose.prod.yml` proxy service layout:

| Host | Container | Purpose |
|---|---|---|
| `./data` (ro) | `/app/data` | ASN database (`ASN_DB_FILE`) |
| `${PROXY_TLS_DIR:-./certs}` (ro) | `/app/certs` | `proxy.crt`/`proxy.key` (TLS proxy) and `tunnel.crt`/`tunnel.key` (node tunnel) |
| secret `coord_signing_key` from `${COORD_SIGNING_KEY_PATH:-./secrets/coord-signing-key.pem}` | `/run/secrets/coord_signing_key` | `COORD_SIGNING_KEY_FILE` |

Published ports: `8443` TLS proxy and `9443` node tunnel on all interfaces;
`8080`/`1080` plaintext on localhost only by default (`PROXY_*_HOST_PORT`
overrides). `./secrets` and `./certs` are git-ignored.
- `HOSTING_ASNS=1,2,3` adds ASNs to the built-in hosting list in
  `packages/proxy-gateway/src/asn-db.ts`. Peers on those ASNs are classified
  `dc`.

### 4a. Anonymizer list (masked exit class)

Nodes whose verified egress is an anonymizer are classed `masked`
(ECONOMICS.md §1a). Sources, checked in this order:

| Source | File / env | Licence / terms | Default |
|---|---|---|---|
| Anonymizer ASNs (WARP, Proton VPN, Mullvad, NordVPN/Surfshark operators) | `data/anonymizer-asns.json` (versioned in git, `ANONYMIZER_ASNS_FILE`), built-in copy in `packages/proxy-gateway/src/egress-class.ts`, extra `ANONYMIZER_ASNS=1,2,3` | facts (ASN numbers, operator names) from PeeringDB / RIR whois; no third-party database copied | on, offline |
| Tor exit IPs | `data/anonymizer-ips.txt` (`ANONYMIZER_IPS_FILE`), from `https://check.torproject.org/torbulkexitlist` | published by the Tor Project for exactly this use | fetched by `scripts/update-asn-db.sh` (`ANONYMIZER_TOR=0` disables) |
| iCloud Private Relay egress ranges | same file, from `https://mask-api.icloud.com/egress-ip-ranges.csv` | published by Apple; check Apple's terms before enabling | opt-in `ANONYMIZER_ICLOUD=1` |
| IPv6 transition tunnels (Teredo `2001::/32`, 6to4 `2002::/16`) | built in | n/a | on |

- The IP list is best effort: a failed download keeps the previous file and
  never fails the ASN update. Without any file the built-in ASN list still
  applies (offline-safe). Entries wider than /8 (IPv4) or /16 (IPv6) are ignored.
- Shared hosting ASNs that VPNs rent from (M247, Datacamp, Leaseweb, ...) stay
  `dc` through `HOSTING_ASNS`; known exits inside them are caught by the IP list.
- Review `data/anonymizer-asns.json` when you update the ASN database; bump
  `version` with each change.
- Egress is verified at connect (tunnel peer IP) and again by the canary probe
  job (`PROBE_URL`; `PROBE_INTERVAL_MS`, `PROBE_SAMPLE_SIZE` bound the load, each
  run starts after a random delay of up to half the interval, and nodes not
  yet probed on this gateway go first). Every connect is also queued for its
  own probe (`PROBE_CONNECT_CONCURRENCY`, default 4;
  `PROBE_CONNECT_MIN_INTERVAL_MS`, default 60000, between connect probes of
  the same node); until it passes, the node is `unknown` for `class-*`
  selection and tier weight. `PROBE_URL` accepts a comma-separated list (up to
  32); list several unpublished echo hostnames that all reach
  `/v1/probe/echo` so probes are harder to single out. Class verification is
  best effort and cannot detect a node agent built to split-route
  (ABUSE_CONTROLS.md).

### 4b. Running a node behind Cloudflare WARP or a VPN

Allowed. Run `packages/node-agent` with the host's traffic going through WARP
(or another VPN): the gateway sees the WARP/VPN egress address, never your
home IP, and classes the node `masked`. Consequences:

- It is served only to buyers who ask for `class-masked`, at the masked price
  (default $0.10/GB), and it counts 0.25 of an active IP toward your tier.
- Do not declare it `residential` at registration: a declared class above the
  verified one opens an admin review flag.
- Split tunnelling (tunnel to the gateway direct, target traffic through the
  VPN, or the reverse) is usually detected by the canary probe: a same-family
  mismatch between the tunnel IP and the probed egress IP is tamper evidence
  and quarantines the node; an other-family egress is classified and the more
  conservative class wins.
- Check your VPN provider's terms. Many consumer VPN and WARP terms forbid
  reselling bandwidth or running a proxy for third parties; that is between
  you and the provider.

## 5. Tunnel ingress

Agents dial `wss://<host>/v1/tunnel`. The gateway listens on `TUNNEL_PORT`.
The peer IP must be the node's real address, because sybil caps and geo
checks key on it. `X-Forwarded-For` is never trusted.

**Option A: Caddy layer4 TLS passthrough with PROXY protocol v2.** Caddy
forwards the raw TLS stream without terminating it and prepends a PROXY v2
header:

```caddyfile
{
  layer4 {
    :443 {
      @tunnel tls sni relay.dominusnode.com relay.dominusnode.daedalusdevelopmentgroup.com
      route @tunnel {
        proxy {
          proxy_protocol v2
          upstream gateway:9443
        }
      }
    }
  }
}
```

- Gateway: `TUNNEL_TRUSTED_PROXY_IPS=<caddy ip>`. The PROXY header is
  accepted only from these peers and is mandatory from them.
- Set `TUNNEL_TLS_CERT_FILE`/`TUNNEL_TLS_KEY_FILE` so the gateway terminates
  TLS. TLS stays end to end, so the agent's channel binding (TLS exporter)
  and SPKI pins keep working.

**Option B: gateway-terminated TLS.** Expose `TUNNEL_PORT` directly. Set
`TUNNEL_TLS_CERT_FILE` and `TUNNEL_TLS_KEY_FILE` (set both or neither), and
leave `TUNNEL_TRUSTED_PROXY_IPS` unset.

**Self-host compose (`docker-compose.selfhost.yml`).** Caddy terminates TLS
for the tunnel on `:8443` (same hostnames and certificates as the API) and
reverse-proxies to `gateway:8443` with `transport http { proxy_protocol v2 }`.
Caddy has a fixed address on the compose network (`172.29.53.2`), which is the
only entry in `TUNNEL_TRUSTED_PROXY_IPS`; the gateway does not publish 8443
itself. Channel binding is `none` in this setup (TLS ends at Caddy). With
`TLS_MODE=off` the tunnel is plain `ws://` and must be fronted by your own TLS.

In production, the gateway refuses tunnel upgrades from non-public peers. A
missing or misconfigured trusted-proxy list shows up as `403` with a log
line that mentions `TUNNEL_TRUSTED_PROXY_IPS`.

## 6. TLS proxy listener

The plaintext proxy ports (8080 HTTP, 1080 SOCKS5) carry the API key in
`Proxy-Authorization` (or the SOCKS5 password) in clear. The gateway can also
serve the proxy over TLS, so agents send credentials inside TLS
("https proxy": TLS to the gateway, then `CONNECT` inside it). It runs the same
auth, policy and billing path as the plain listener.

| Variable | Meaning |
|---|---|
| `PROXY_TLS_PORT` | HTTPS proxy port (e.g. `8443`). Off when unset. Validated 1-65535. |
| `PROXY_TLS_CERT_FILE` / `PROXY_TLS_KEY_FILE` | PEM certificate chain and key. Required with `PROXY_TLS_PORT`; set without it is a startup error. |
| `SOCKS5_TLS_PORT` | Optional SOCKS5-inside-TLS port. Needs `PROXY_TLS_PORT` (same cert). |
| `PROXY_REQUIRE_TLS` | Refuses credentials on the plaintext listeners: HTTP returns `403 TLS required: connect to the gateway's HTTPS proxy port`, SOCKS5 connections are closed. Needs `PROXY_TLS_PORT`. **Default `true` when `NODE_ENV=production`**, `false` otherwise. Only the exact value `false` turns it off in production. |

In production the gateway refuses credentials on 8080/1080 by default, and
refuses to start if `PROXY_TLS_PORT` is not set (the error names both fixes).
To keep accepting plaintext credentials during a migration, set
`PROXY_REQUIRE_TLS=false` explicitly; the gateway then logs a startup warning
and at most one warning per minute per listener when credentials arrive over
plaintext. Roll out: enable `PROXY_TLS_PORT`, move clients, then remove the
`false` override.

**Post-quantum key exchange.** Every TLS endpoint the gateway runs (HTTPS
proxy, SOCKS5-over-TLS, node tunnel) and the node agent's tunnel client
accept TLS 1.3 only and offer the hybrid group `X25519MLKEM768` first, with
`X25519` as fallback (`packages/shared/src/tls-pq.ts`). This needs OpenSSL
>= 3.5, i.e. Node >= 22.20; the Dockerfiles pin `node:22.23.5-alpine`. Each
service logs `TLS capability` once at startup (`openssl`, `groups`,
`pqHybrid`) and warns if the runtime falls back to X25519. Check from outside:

```bash
openssl s_client -connect proxy.example.org:8443 -groups X25519MLKEM768 -tls1_3 </dev/null
```

Caddy (`infra/caddy/Caddyfile`) sets `protocols tls1.3` and leaves `curves`
at the default, which in Caddy >= 2.10 includes `X25519MLKEM768`; pinning a
curve list would drop the hybrid.

Expose the TLS port directly (the gateway terminates TLS), or pass it through
Caddy layer4 without terminating. Use a certificate for the public proxy
hostname.

Clients:

- Node SDK: `new DominusNodeClient({ proxyHost, gatewayTls: true })`
  (port 8443) or `gatewayTls: { port, ca }`. `proxy.fetch` uses TLS and
  `buildUrl` returns `https://...`. Other SDKs: follow-up (SDK_SURFACE.md §5).
- MCP server: `DOMINUSNODE_PROXY_URL=https://proxy.dominusnode.com:8443`
  (optional `DOMINUSNODE_PROXY_CA_FILE` for a private CA). Preferred over
  `DOMINUSNODE_HTTP_PROXY_PORT` when set.
- curl: `curl -x https://relay:$KEY@proxy.dominusnode.com:8443 https://example.com`.

## 7. Seed nodes (operator-run)

Seed nodes are registered under a dedicated platform principal (DESIGN.md §11, LAUNCH_PLAN §4.1) and flagged `operator_run` so they are reported separately and never take genesis slots.

**Files**
- `packages/node-agent/Dockerfile`: multi-stage, runs as uid 1001, no node key, API key or wallet key in the image. Coordinator pins are a build arg (`DN_COORD_PUBKEYS`, public keys) and the build fails without them.
- `infra/systemd/dominusnode-node.service`: hardened unit (`ProtectSystem=strict`, no capabilities, IPv4/IPv6/unix sockets only), reads `/etc/dominusnode/node.env` and the key file `/etc/dominusnode/node.json` (0600, owner `dominusnode`).
- `scripts/seed/deploy-node.sh`: env-driven and idempotent (re-run to upgrade). It creates the service user, writes the non-secret env file, checks out `DN_REF`, builds the agent (or the image with `DN_MODE=docker`), registers the node once if no key file exists (`DN_API_KEY` and `DN_WALLET_KEY_FILE` from the environment only) and restarts the service.

```bash
sudo DN_COORD_PUBKEYS=<pins> DN_REF=<release tag> \
     DN_NODE_API_URL=https://api.example DN_NODE_GATEWAY_URL=wss://gw.example/tunnel \
     DN_API_KEY=$SEED_PRINCIPAL_KEY DN_WALLET_KEY_FILE=/root/seed-wallet.key \
     ./scripts/seed/deploy-node.sh
```

Docker only:
```bash
docker build -f packages/node-agent/Dockerfile --build-arg DN_COORD_PUBKEYS=<pins> -t dominusnode-node .
docker run -d --restart unless-stopped --env-file /etc/dominusnode/node.env \
  -v /etc/dominusnode/node.json:/run/dominusnode/node.json:ro dominusnode-node
```
The key file must be owned by uid 1001 with mode 0600 (the agent refuses group/world-readable key files).

### Published image (community nodes)

`.github/workflows/node-image.yml` publishes `ghcr.io/0xcircuitbreaker/dominusnode-node` for linux/amd64 and linux/arm64 (Raspberry Pi 4/5) on a `node-v*` tag or manual dispatch. The official coordinator pins come from the repository variable `DN_COORD_PUBKEYS` (public keys) and are baked in at build time; the job fails without them. A node pointed at another coordinator adds that coordinator's pins with `DN_NODE_COORD_PINS`.

First run, `register` subcommand (once; writes the node key file 0600 for uid 1001):
```bash
sudo install -d -o 1001 -g 1001 -m 700 /etc/dominusnode
sudo install -o 1001 -g 1001 -m 600 ./wallet.key /etc/dominusnode/wallet.key   # owner wallet, 32-byte hex
read -rs DN_API_KEY && export DN_API_KEY                                        # never on the command line
docker run --rm -it -e DN_API_KEY -e DN_WALLET_KEY_FILE=/run/dominusnode/wallet.key \
  -v /etc/dominusnode:/run/dominusnode ghcr.io/0xcircuitbreaker/dominusnode-node register
sudo rm /etc/dominusnode/wallet.key   # not needed after registration
```
`register` refuses if the server's message differs from the one it builds locally. Then run:
```bash
docker run -d --name dominusnode-node --restart unless-stopped \
  -e DN_NODE_GB_PER_DAY=2 -e DN_NODE_MAX_STREAMS=8 -e DN_NODE_MAX_MBPS=10 -e DN_NODE_REQ_PER_SEC=5 \
  -v /etc/dominusnode/node.json:/run/dominusnode/node.json:ro \
  ghcr.io/0xcircuitbreaker/dominusnode-node
```

**Recommended caps for home lines.** Start low and raise them once you have watched a week of traffic:

| Line | `DN_NODE_GB_PER_DAY` | `DN_NODE_MAX_STREAMS` | `DN_NODE_MAX_MBPS` | `DN_NODE_REQ_PER_SEC` |
|---|---|---|---|---|
| Metered or mobile hotspot | 1 | 4 | 5 | 2 |
| Typical home broadband (≤100 Mbps up) | 2 | 8 | 10 | 5 |
| Fibre (≥300 Mbps up) | 5 | 16 | 25 | 10 |

The caps are enforced by the agent itself and can only lower the floor, never raise it. Check your ISP's terms before sharing a residential line.

After the first registration, flag the node: admin panel → Launch controls → "Flag operator-run", or `POST /api/admin/network/nodes/:id/operator-run {"operatorRun": true}`. The flag takes effect on the node's next tunnel reconnect.

### Self-host installer notes

- `scripts/selfhost/install.sh` downloads the ASN/geo database with
  `scripts/update-asn-db.sh` when `data/ip2asn-combined.tsv.gz` is missing and
  fails if the download fails. `SKIP_ASN_DB=1` continues without it; the
  gateway then refuses all public peers and destinations until the file
  exists. `SKIP_GEOIP` is not passed through: it is ignored in production.
- The gateway runs as uid 1001 and never mounts `selfhost/coord-key.pem`
  directly (the host file stays 0600, owned by whoever ran the installer).
  The one-shot `keys` service (root, no network) copies it into the
  `gateway_secrets` volume as 0400 owned by 1001 on every `up`, so re-running
  the installer fixes existing installs. The `node` profile does the same for
  `selfhost/node.json` via `node-keys` / `node_secrets`. The installer also
  makes `data/` 0755 and the ASN database 0644, and fails before printing
  `up.` if the gateway cannot read its key.
- `OPERATOR_CONTACT` must be a plain email address; anything else (spaces,
  braces, quotes, newlines) is refused because it is written into the
  Caddyfile and `.env`.
- The optional `node` profile dials `${TUNNEL_SCHEME}://${DOMINUSNODE_DOMAIN}:8443/v1/tunnel`
  (`wss` unless `TLS_MODE=off`).

## 8. Launch jobs and settings

| Env var | Default | Meaning |
|---|---|---|
| `STARTER_CREDIT_RPC_URL` | unset | Base JSON-RPC (https only) for the starter-credit on-chain check; unset = only paid top-ups qualify |
| `STARTER_CREDIT_RPC_TIMEOUT_MS` | 3000 | Timeout for that RPC call (250–15000) |
| `STARTER_EXPIRY_JOB_INTERVAL_MS` | 3600000 | Starter-credit expiry job |
| `GENESIS_JOB_INTERVAL_MS` | 3600000 | Genesis enrolment, credit grant and maturity |
| `NETWORK_SNAPSHOT_INTERVAL_MS` | 3600000 | Hourly public network snapshot |
| `NETWORK_SNAPSHOT_RETENTION_DAYS` | 400 | Snapshot retention |
| `UNMET_DEMAND_FLUSH_INTERVAL_MS` | 60000 | Per-instance flush of unmet-demand counts |
| `UNMET_DEMAND_RETENTION_DAYS` | 90 | Unmet-demand retention |
| `PAYER_SDN_FILE` | `PAYOUT_SDN_FILE` | OFAC SDN address list for x402/MPP payer screening |
| `PAYER_SDN_REQUIRED` | `false` (always `true` in production) | Refuse paid requests when the list is missing |
| `ABUSE_REPORT_POW_DIFFICULTY` | 20 | Leading zero bits for abuse-report PoW |

The SDN list must be installed (and refreshed) on every gateway host before x402/MPP is enabled in production; without it paid requests return `503 PAYER_SCREENING_UNAVAILABLE`. The public status page is served by the API at `/status`; put it behind the same TLS proxy as `/v1`.

### Data retention

The dashboard's hourly retention job deletes rows older than `data_retention_policies.retention_days` (admin-tunable). The relay-related defaults are:

| Table | Days | Notes |
|---|---|---|
| `sessions` | 90 | Connection metadata. Purging a session sets `session_id` to NULL on rows that outlive it |
| `usage_records` | 365 | Kept after its session is purged (`session_id` ON DELETE SET NULL) |
| `agentic_wallet_transactions` | 730 | Financial record; kept after its session is purged (`session_id` ON DELETE SET NULL) |
| `relay_charges` | not purged | Split ledger; `session_id` ON DELETE SET NULL |
| `node_reports` | see policy | `session_id` ON DELETE SET NULL |
| `relay_settle_retries` | with its session | ON DELETE CASCADE; a retry still queued after 90 days is dropped |

Every foreign key to `sessions(id)` must have an ON DELETE action (`schema.test.ts` enforces this); with the default NO ACTION the sessions purge fails on every batch.

### Auto-payouts

The daily payout job queues one automatic withdrawal per eligible owner, for `min(available, tier daily withdraw limit minus today's payouts, $100k)`. The rest goes out on later days. Owners with less than $1 of today's limit left are skipped; any refused auto request is logged at warn level and the run logs an error summary.

## 8a. Human (admin) login

Agents never use email/password. Human login exists only for the admin panel
and is **off by default**.

| Env var | Default | Meaning |
|---|---|---|
| `ADMIN_HUMAN_LOGIN` | `false` | `true` enables `/api/auth/register`, `/login`, `/forgot-password`, `/reset-password` and `/mfa/*`. Off: those routes answer `404`. On: login succeeds only for users whose `admin_role` is not `none` (others get the same `401` as a wrong password) |
| `ADMIN_BOOTSTRAP_EMAIL` | unset | With `ADMIN_HUMAN_LOGIN=true`, allows exactly one registration: this address, while no admin exists. That account becomes `admin`. Any other registration answers `403 REGISTRATION_CLOSED` |

First admin:

1. Set `ADMIN_HUMAN_LOGIN=true` and `ADMIN_BOOTSTRAP_EMAIL=<your address>` on the API, restart.
2. Register that address through the admin panel login page (or `POST /api/auth/register`).
3. Unset `ADMIN_BOOTSTRAP_EMAIL` and restart. Enable MFA from the admin panel.

Keep `ADMIN_HUMAN_LOGIN=true` on the API that serves the admin panel; the
panel's login and MFA steps need it. `/api/auth/refresh`, `/me`, `/logout`,
`/verify-key` and wallet sign-in (`/api/auth/wallet/*`) are not affected by the flag.

## 9. Public product site (DDG subdomain)

`packages/frontend` is a static build: the public landing page at `/`, the
agent-discovery files, and the admin panel at `/admin` (reachable only by
typing the path; nothing on the public site links to it). Discovery files are
described in [DISCOVERY.md](DISCOVERY.md).

### Build

```bash
VITE_PUBLIC_ORIGIN=https://dominusnode.com \
VITE_API_BASE=https://api.dominusnode.com \
npm run build --workspace=packages/frontend      # -> packages/frontend/dist
```

`VITE_PUBLIC_ORIGIN` (default `https://dominusnode.com`)
is written into the canonical/OpenGraph tags, `sitemap.xml`, `robots.txt`,
`llms.txt`, `llms-full.txt`, `docs/*.md` and `.well-known/mcp/server.json` at
build time. A malformed value fails the build. `VITE_API_BASE` (default `https://api.dominusnode.com`) is where the
landing page fetches `/v1/pricing`, `/v1/network/stats` and `/v1/policy`
(client-side; the page shows fallback text if they fail), where `/report-abuse`
posts `POST /v1/abuse-reports` (proof of work solved in the browser), and
where the "Status" links point (`/status`, `/v1/network/history`). Optional
`VITE_ABUSE_URL` replaces the in-site abuse form with another URL.

The SDKs, MCP server and node agent still default to `https://api.dominusnode.com`;
the site's snippets and docs pass `https://api.dominusnode.com` explicitly
(`baseUrl`, `base_url`, `DOMINUSNODE_API_URL`, `DN_NODE_API_URL`).

After editing `public/docs/*.md` or `discovery/generate.mjs`, run
`node packages/frontend/discovery/generate.mjs` to refresh the committed copies;
a test fails if they are stale.

### DNS

```
dominusnode.com.      A/AAAA  <static host or web server>
www.dominusnode.com.  CNAME   dominusnode.com.
api.dominusnode.com.  A/AAAA  <API host>
```

Use an A/AAAA record instead of CNAME if the static host is your own VPS.

### Hosting option A: Netlify

`netlify.toml` at the repo root builds the frontend workspace, sets
`VITE_PUBLIC_ORIGIN`/`VITE_API_BASE`, serves discovery files with explicit
content types and `Access-Control-Allow-Origin: *`, caches hashed assets for a
year, adds `X-Robots-Tag: noindex` on `/admin` and `/login`, and falls back to
`index.html` for SPA routes. Add the subdomain as a custom domain in Netlify.

### Hosting option B: nginx

```nginx
server {
  listen 443 ssl http2;
  server_name dominusnode.com;
  root /srv/dominusnode/frontend/dist;

  types { text/markdown md; }
  charset utf-8;
  charset_types text/plain text/markdown application/json text/xml;

  add_header Strict-Transport-Security "max-age=63072000; includeSubDomains" always;
  add_header X-Content-Type-Options nosniff always;
  add_header Referrer-Policy strict-origin-when-cross-origin always;
  add_header Content-Security-Policy "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self' https://api.dominusnode.com; img-src 'self' data:; frame-ancestors 'none'; base-uri 'self'" always;

  location /assets/ { add_header Cache-Control "public, max-age=31536000, immutable"; try_files $uri =404; }
  location ~ ^/(llms(-full)?\.txt|robots\.txt|sitemap\.xml|docs/.+\.md|\.well-known/.+\.json)$ {
    add_header Access-Control-Allow-Origin "*";
    add_header Cache-Control "public, max-age=3600";
    try_files $uri =404;
  }
  location /admin { add_header X-Robots-Tag "noindex, nofollow" always; try_files $uri /index.html; }
  location / { add_header Cache-Control "no-cache"; try_files $uri /index.html; }
}
```

### Hosting option C: Caddy

```caddy
www.dominusnode.com, dominusnode.daedalusdevelopmentgroup.com {
  redir https://dominusnode.com{uri} permanent
}

dominusnode.com {
  root * /srv/dominusnode/frontend/dist
  encode zstd gzip
  @discovery path /llms.txt /llms-full.txt /robots.txt /sitemap.xml /docs/*.md /.well-known/*
  header @discovery Access-Control-Allow-Origin "*"
  header @discovery Cache-Control "public, max-age=3600"
  @md path *.md
  header @md Content-Type "text/markdown; charset=utf-8"
  @txt path *.txt
  header @txt Content-Type "text/plain; charset=utf-8"
  header /assets/* Cache-Control "public, max-age=31536000, immutable"
  header /admin* X-Robots-Tag "noindex, nofollow"
  try_files {path} /index.html
  file_server
}
```

### API origin and CORS

Run the API on its own host, `api.dominusnode.com`,
add the public origin to the API's allowlist, and set `APP_URL` so the
API-hosted `/llms.txt`, `/.well-known/agent-tool.json` and `/status` link the
right base:

```
CORS_ORIGINS=https://dominusnode.com,https://www.dominusnode.com,https://dominusnode.daedalusdevelopmentgroup.com
APP_URL=https://api.dominusnode.com
```

The site calls only public, unauthenticated routes with `credentials: "omit"`:
`/v1/pricing`, `/v1/network/stats`, `/v1/policy`, and (from `/report-abuse`)
`POST /v1/abuse-reports/challenge` and `POST /v1/abuse-reports`.
The site's `/llms.txt` and the API's `/llms.txt` state the same facts; the site
links to the API's copy (live prices) and its `agent-tool.json`. If the API
moves, rebuild with the new `VITE_API_BASE` and update the CSP `connect-src`.

### Linking from the DDG site

So existing crawlers and agents find it:

- DDG home page and products/services page: a "DominusNode: relay network for AI
  agents" card linking to `https://dominusnode.com/`.
- DDG footer: a plain link to the same URL.
- DDG agent-service pages (anything already describing agent tooling): a
  "Network egress for your agents" link to `/docs/agents.md` and to the MCP
  setup at `/docs/mcp.md`.
- DDG `sitemap.xml`: add the product URL, or a `<sitemap>` entry pointing to
  `https://dominusnode.com/sitemap.xml`.
- DDG JSON-LD Organization: list the product under `owns` or `makesOffer`.
- DDG `llms.txt`, under its products section:

```markdown
## Products

- [DominusNode](https://dominusnode.com/llms.txt): decentralized relay network for AI agents; buy egress through agent-contributed IPs with x402/MPP or a prepaid wallet, or run a node and earn. MCP server: @dominusnode/mcp-server.
```
