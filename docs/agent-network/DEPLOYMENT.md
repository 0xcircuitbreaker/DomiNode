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
sudo chown 1001:1001 secrets/api-key-pepper   # the api and proxy images run as uid 1001
```

Compose file secrets (non-swarm) are bind mounts that keep the host owner and
mode, so a 0600 file owned by you or root is unreadable in the containers and
both services stop at startup. The same applies to `coord-key.pem`.

- Mount the **same** file into the API and the gateway (Docker secret or
  systemd credential) and set `API_KEY_PEPPER_FILE` in both. A mismatch makes
  every migrated key fail on one side. `docker-compose.prod.yml` mounts
  `secrets/api-key-pepper` (`API_KEY_PEPPER_PATH`) into both as the
  `api_key_pepper` secret; create it before `up`. The self-host installer
  generates `selfhost/api-key-pepper` once and copies it into both services;
  on a split install, give the gateway VPS the coordinator's file (hidden
  prompt or `API_KEY_PEPPER`) and compare the "API key pepper check value"
  both installers print.
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
one policy read and cached together for 5 minutes.

Until the first network policy is published, `/.well-known/dominusnode/coordinator.json` and `policy.json` return 503 (the built-in default is version 0, and signed documents need version 1 or later); node agents cannot join until then. Publish it once as an admin: in the admin panel, or with `PUT /api/admin/network/policy` and the policy body (`GET` the same path returns the current default to start from). Example with an admin access token:

```bash
curl -sS https://<domain>/api/admin/network/policy -H "Authorization: Bearer $ADMIN_JWT" |
  jq .body |
  curl -sS -X PUT https://<domain>/api/admin/network/policy \
    -H "Authorization: Bearer $ADMIN_JWT" -H 'Content-Type: application/json' --data @-
curl -sS -o /dev/null -w '%{http_code}\n' https://<domain>/.well-known/dominusnode/policy.json  # 200
```

The cache holds for up to 5 minutes after publishing. Settings:

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
- Exit classification is allowlist-based (fails closed). Only ASNs in the
  access-network allowlist (`ACCESS_ASNS` in
  `packages/proxy-gateway/src/asn-db.ts`: eyeball ISPs and mobile carriers)
  are classed `residential`. Every other routed ASN that is not an anonymizer
  is classed `dc`, so an unlisted hoster or VPN provider is never sold as
  residential. Extend the allowlist with `ACCESS_ASNS=1,2,3` or
  `ACCESS_ASNS_FILE` (one ASN per line, `#` comments; for example the PeeringDB
  networks with info_type "Cable/DSL/ISP" in your markets). A residential node
  on an unlisted ISP is served (and earns) as `dc` until its ASN is added.
- `HOSTING_ASNS=1,2,3` adds ASNs to the built-in hosting list. Peers on those
  ASNs are classified `dc` even if they also appear in the access allowlist.

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
- Shared hosting ASNs that VPNs rent from (M247, Datacamp/CDN77 AS60068 and
  AS212238, Leaseweb, ...) stay `dc` through `HOSTING_ASNS` (and any unlisted
  ASN is `dc` anyway); known exits inside them are caught by the IP list.
- Review `data/anonymizer-asns.json` when you update the ASN database; bump
  `version` with each change.
- Egress is verified at connect (tunnel peer IP) and again by the canary probe
  job (`PROBE_URL`; `PROBE_INTERVAL_MS`, `PROBE_SAMPLE_SIZE` bound the load, each
  run starts after a random delay of up to half the interval, and nodes not
  yet probed on this gateway go first). Every connect is also queued for its
  own probe (`PROBE_CONNECT_CONCURRENCY`, default 4;
  `PROBE_CONNECT_MIN_INTERVAL_MS`, default 60000, between connect probes of
  the same node, not applied while the node is still unclassified); until a
  probe classifies it the node serves no traffic. A probe that errors or
  comes back without a verdict is retried with backoff (30 s, 1 m, 2 m, then
  every 5 m), and every periodic run probes all still-unclassified nodes on
  top of the sample. The first periodic run starts 30 s after startup.
  `PROBE_URL` accepts a comma-separated list (up to
  32); list several unpublished echo hostnames that all reach
  `/v1/probe/echo` so probes are harder to single out. Class verification is
  best effort and cannot detect a node agent built to split-route
  (ABUSE_CONTROLS.md).
- The echo URL must be the API on a public hostname with a publicly trusted
  certificate: exit nodes refuse private and loopback destinations, and the
  probe verifies TLS. The gateway checks every echo URL itself at startup and
  every `PROBE_SELFCHECK_INTERVAL_MS` (default 60000) and uses only those that
  return a 200 echoing its nonce. While none passes (API still starting,
  `TLS_MODE=internal`, a host with no API that answers 404) it logs an error,
  runs no probes, records no tamper strikes and does not hold nodes pending:
  nodes serve at their connect class, as with probes off.
- `PROBES_DISABLED=true` turns probes off and wins over `PROBE_URL` (the
  gateway ignores `PROBE_URL`). `install.sh` honours it from the environment
  or `.env` and then removes `PROBE_URL` from `.env`. Without it the installer
  sets `PROBE_URL=https://<primary>/v1/probe/echo` only for `ROLE=all` with
  `TLS_MODE=auto` or `cloudflare` and a public primary name; for
  `ROLE=gateway` it asks for the coordinator's public API hostname
  (`PROBE_API_HOST` in non-interactive runs). In every other case it prints a
  warning and leaves probes off.
- `docker-compose.prod.yml` passes `PROBE_URL` to the gateway, defaulting to
  `https://${DOMINUSNODE_DOMAIN}/v1/probe/echo`, so probes are on unless
  `PROBES_DISABLED=true`. `docker-compose.selfhost.yml` passes the value
  `install.sh` wrote to `.env`.

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
for the tunnel on `:9443` (same hostnames and certificates as the API) and
reverse-proxies to `gateway:9443` with `transport http { proxy_protocol v2 }`.
Caddy has a fixed address on the compose network (`172.29.53.2`), which is the
only entry in `TUNNEL_TRUSTED_PROXY_IPS`; the gateway does not publish 9443
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

**Breaking default:** any deployment with `NODE_ENV=production` and no
`PROXY_TLS_PORT` now fails at gateway startup. `docker-compose.selfhost.yml`
runs the TLS proxy on 8443 / 1443 with Caddy's certificate and
`PROXY_REQUIRE_TLS=true` (only `TLS_MODE=off` turns it off; see "Self-host
gateway TLS proxy" below); `docker-compose.prod.yml` sets `PROXY_TLS_PORT`
with the cert files.

**Certificate renewal.** The gateway re-reads `PROXY_TLS_CERT_FILE` /
`PROXY_TLS_KEY_FILE` every 60 s and, when they changed and form a valid pair,
swaps the certificate in place on every TLS listener (`setSecureContext`):
no restart, open connections keep running, new handshakes get the new cert.
A half-written or mismatched pair is skipped (logged) and retried next minute.

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
  `buildUrl` returns `https://...`. All six SDKs implement `gatewayTls`
  (SDK_SURFACE.md).
- MCP server: `DOMINUSNODE_PROXY_URL=https://proxy.dominusnode.com:8443`
  (optional `DOMINUSNODE_PROXY_CA_FILE` for a private CA). Preferred over
  `DOMINUSNODE_HTTP_PROXY_PORT` when set.
- curl: `curl -x https://relay:$KEY@proxy.dominusnode.com:8443 https://example.com`.

Client addresses: the OFAC client-country check and per-IP limits need the
real client address. In production a proxy-listener connection from a
private, non-loopback address (for example Docker's userland proxy, which
shows IPv6 clients of an IPv4-only bridge as the bridge gateway) is refused
as unknown. The self-host compose enables IPv6 on its published network so
the source is kept; list deliberate private client ranges (an agent LAN) in
`PROXY_TRUSTED_CLIENT_CIDRS` (passed through by `docker-compose.prod.yml` and
`docker-compose.selfhost.yml`). Host-local clients of the plaintext ports
published on `127.0.0.1` (8080/1080) reach the gateway through docker-proxy
and appear as the bridge gateway address (e.g. `172.x.0.1`): either list that
address (`/32`) in `PROXY_TRUSTED_CLIENT_CIDRS`, or connect from inside the
compose network. A trusted address skips the client-country check, so list
only addresses that cannot carry remote traffic.

Restarts: each relay session's settle payload and gateway-counted bytes are
stored on its `sessions` row and heartbeated every 15 s. Sessions of a
gateway that stopped heartbeating for 2 minutes (crash, SIGKILL, previous
run) are settled by any live gateway with the last flushed bytes; the rest of
the reservation is refunded. Give the gateway container a stop timeout above
its 20 s drain (`stop_grace_period: 60s` in the compose files).

Probes: set the same `PROBE_AUTH_SECRET` (32+ chars; the self-host installer
generates it) on the API and gateways so canary probes get their own budget
on `/v1/probe/echo`.

Logs: compose files rotate container logs (json-file, 5 x 20 MB per
container). Per-request lines (`CONNECT`, `session started/ended`) are at
debug level; byte-report mismatches are logged only at the dispute threshold,
at most once per node per minute.

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
docker run --rm -e DN_API_KEY -e DN_WALLET_KEY_FILE=/run/dominusnode/wallet.key \
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
  the installer fixes existing installs. It copies `selfhost/api-key-pepper`
  the same way (`API_KEY_PEPPER_FILE` on api and gateway). The installer also
  makes `data/` 0755 and the ASN database 0644, and fails before printing
  `up.` if the gateway cannot read its key.
- `OPERATOR_CONTACT` must be a plain email address; anything else (spaces,
  braces, quotes, newlines) is refused because it is written into the
  Caddyfile and `.env`.
- There is no in-stack exit node. A node on the gateway's own box reaches it
  from a private address and is refused as a private peer, so run nodes on
  other hosts (published image above). The installer prints the join command
  with the `sha256:` fingerprint of every pinned key
  (`dominusnode-node run --coordinator <domain> --trust <fp>[,<fp>]`); confirm
  each out of band.
- `OPERATOR_CONTACT`, `ABUSE_CONTACT`, `OPERATOR_NAME` and `SITE_NAME` reach
  the API: `/.well-known/security.txt` answers with `Contact: mailto:<abuse
  contact>` and coordinator.json carries the contacts.
- ASN/geo refresh: re-runs refresh a database older than 7 days, and the
  installer schedules `scripts/selfhost/refresh-asn.sh` weekly (systemd timer
  `dominusnode-asn-refresh.timer`, or a cron job without systemd;
  `SKIP_ASN_TIMER=1` skips it). The script downloads a fresh database and
  restarts the gateway, which reads it once at start.
- Certificates: with `TLS_MODE=auto` and HTTP-01 the installer warns when
  `PROXY_HOST`/`RELAY_HOST` do not resolve, and if Caddy has not issued the
  `PROXY_HOST` certificate after `up` it stops with a checklist (DNS pointed
  here and not proxied, inbound 80/443 or `ACME_CHALLENGE=dns-cloudflare`,
  `docker compose ... logs caddy proxy-certs gateway`). Fix it and re-run.

### Self-host admin

The coordinator profile runs the admin UI (`frontend` service, nginx serving
the React build with `infra/nginx/selfhost.conf`: plain HSTS, no
`includeSubDomains`/`preload`, `connect-src 'self'`). Caddy sends `/api/*`,
`/v1/*`, `/.well-known/*`, `/status` and `/llms.txt` to the API, only the admin
paths (`/admin*`, `/login`, `/forgot-password`, `/reset-password`,
`/verify-email`, `/assets/*`, icons, manifest) to the admin UI, redirects `/` to
`/admin` and answers 404 elsewhere. The public DominusNode site pages
(landing, pricing, report-abuse, terms, privacy, AUP) are not served on a
self-host: they carry the official operator's contacts and terms. Abuse and
operator contacts for your install come from `security.txt` and
`coordinator.json` (`ABUSE_CONTACT`, `OPERATOR_CONTACT`).

With `TLS_MODE=cloudflare`, give the admin hostname path-based ingress rules in
the tunnel, in this order: `/api/*`, `/v1/*`, `/.well-known/*`, `/status*` and
`/llms.txt` to `http://api:3000`, then everything else to
`http://frontend:8080`. Do not send `/api` through the frontend: nginx adds a
hop the api does not trust (`TRUST_PROXY=1`), so every client would share the
cloudflared address for login rate limits and lockouts.

First admin (§8a, with the installer doing the env part):

1. Run the installer with `ADMIN_BOOTSTRAP_EMAIL=<you@example.org>` (or answer
   the prompt). It sets `ADMIN_HUMAN_LOGIN=true` for the API.
2. Register that address once (no captcha on a self-host without
   `RECAPTCHA_SECRET_KEY`). The password is read from a 0600 file, never argv:

   ```bash
   jq -n --arg e you@example.org --rawfile p ./admin-password.txt \
     '{email:$e, password:($p|rtrimstr("\n"))}' |
     curl -sS https://<domain>/api/auth/register -H 'Content-Type: application/json' --data @-
   ```

3. Re-run the installer with `ADMIN_BOOTSTRAP_EMAIL=` (empty) to close
   registration, then sign in at `https://<domain>/` and enable MFA.
4. Publish the first network policy (§3a). Until then
   `/.well-known/dominusnode/coordinator.json` and `policy.json` return 503
   and no node can join.

Without human login, an existing wallet user can be promoted by SQL on the
coordinator: `docker compose -f docker-compose.selfhost.yml --env-file .env
exec postgres psql -U dominusnode -d dominusnode -c "UPDATE users SET
admin_role = 'admin' WHERE wallet_address = lower('<0x...>')"`, then use its
wallet JWT with the admin API.

### Self-host backup

`scripts/selfhost/backup.sh` writes one encrypted archive with everything a
rebuild needs: a `pg_dump -Fc` taken inside the postgres container (the host
has no route to it), `selfhost/` (`coord-key.pem`, which every node image pins,
`api-key-pepper`, the gateway DB URL, token files) and `.env` (`JWT_SECRET`,
`MFA_ENCRYPTION_KEY`, `POSTGRES_PASSWORD`). It refuses to write an unencrypted
archive:

- `BACKUP_AGE_RECIPIENT=age1...`: encrypt to an age public key whose private
  key lives off this box (preferred), or
- `BACKUP_PASSPHRASE_FILE=<file>`: OpenSSL AES-256 with PBKDF2 (600k rounds);
  keep the passphrase off-box too.

`BACKUP_DIR` (default `./backups`) and `BACKUP_KEEP` (default 14) control
rotation. Run it daily from cron as the installing user and copy the archives
off the box. A ROLE=gateway box has no database; its archive holds its own key,
pepper and `.env`.

Restore onto a fresh checkout of the same release:

```bash
BACKUP_PASSPHRASE_FILE=/path/pass ./scripts/selfhost/restore.sh backups/dominusnode-<ts>.tar.gz.enc
# or AGE_IDENTITY=/path/age-key.txt ... .tar.gz.age
```

Order: keys and `.env` first (refused over existing ones unless `--force`),
then Postgres starts and the dump is loaded with `pg_restore --clean`, then
`install.sh --yes` migrates (schema.sql is safe to re-run), recreates the
gateway role and starts everything. `--no-start` restores the files only.
Restore the coordinator key and pepper exactly: a new key strands every node
that pins the old one, and a new pepper revokes every peppered API key.

### Self-host gateway TLS proxy (8443 / 1443)

Agents send their API key to the gateway only over TLS. On `ROLE=all|gateway`
with `TLS_MODE` `auto`, `internal` or `cloudflare`:

| Port | Listener | Published |
|---|---|---|
| 8443 | HTTPS proxy (`PROXY_TLS_PORT`): `curl -x https://relay:$KEY@PROXY_HOST:8443 https://httpbin.org/ip` | yes (`PROXY_TLS_HOST_PORT`) |
| 1443 | SOCKS5 inside TLS (`SOCKS5_TLS_PORT`) | yes (`SOCKS5_TLS_HOST_PORT`) |
| 9443 | node tunnel (Caddy, PROXY v2 to the gateway) | yes (Caddy, `TUNNEL_HOST_PORT`) |
| 8080 / 1080 | plaintext HTTP / SOCKS5 | no: only with `TLS_MODE=off` or `PUBLISH_PLAINTEXT_PROXY=1` (`docker-compose.selfhost.plain.yml`); credentials are refused there unless `TLS_MODE=off` |

The HTTPS proxy is on 8443, the port the SDKs (`gatewayTls.port`) and the MCP
server (`DOMINUSNODE_PROXY_URL=https://PROXY_HOST:8443`) default to, matching
`docker-compose.prod.yml`. The node tunnel is on 9443 (the node agent takes
its URL from `coordinator.json` `gateway.tunnel_url`, or
`DN_NODE_GATEWAY_URL=wss://RELAY_HOST:9443/v1/tunnel`).
`/api/proxy/config` (`tlsProxy`), the discovery document (`proxy.https`,
listed first, and the example) and `coordinator.json`
(`gateway.https_proxy`, `gateway.socks5_tls_proxy`) advertise the port from
`PROXY_PUBLIC_TLS_PORT` / `PROXY_PUBLIC_SOCKS5_TLS_PORT`.

`coordinator.json` lists the plaintext `gateway.http_proxy` /
`gateway.socks5_proxy` only when they are published
(`PROXY_PUBLISH_PLAINTEXT`; install.sh writes `PLAINTEXT_PROXY_PUBLISHED=1`
for `TLS_MODE=off` or `PUBLISH_PLAINTEXT_PROXY=1`, otherwise 0;
`docker-compose.prod.yml` sets it false because 8080/1080 are loopback-only
there). Unset, plaintext is listed only when no TLS listener is advertised.

**Upgrading an install from before this layout** (HTTPS proxy on 8444, node
tunnel on 8443): re-run `install.sh`, open 9443 and close 8444 in the
firewall, and point each node at the new tunnel URL
(`wss://RELAY_HOST:9443/v1/tunnel`, re-run its setup against
`coordinator.json` or set `DN_NODE_GATEWAY_URL`). Until then old nodes reach
the HTTPS proxy on 8443 and fail the tunnel handshake. Agents configured for
`:8444` move to the default `:8443`. Previously, an agent left on the default
8443 sent its key to Caddy's tunnel site.

**Certificate.** Caddy obtains and renews the certificate for `PROXY_HOST`
(the installer adds a `PROXY_HOST` site block when no site block already
covers it; it answers 404 on 443). The `proxy-certs` service (profile
`proxytls`, root, no network, `cap_drop: ALL` plus CHOWN/DAC_OVERRIDE/FOWNER)
mounts Caddy's storage read-only, finds `certificates/<issuer>/PROXY_HOST/PROXY_HOST.{crt,key}`
(any issuer: Let's Encrypt, the ZeroSSL fallback or `tls internal`), and copies
the newest pair into the `proxy_tls` volume as 0400 owned by uid 1001, every 5
minutes. The gateway mounts only that volume and hot-reloads (see above). The
gateway waits for `proxy-certs` to be healthy (a cert exists), so the first
start takes as long as Caddy's first issuance.

Why not the alternatives: sharing `caddy_data` with the gateway would expose
Caddy's ACME account key and every other site key to the gateway, and Caddy
writes keys 0600 as root, which uid 1001 cannot read. Caddy layer4 TLS
termination needs a custom Caddy build and puts a second TLS hop plus PROXY v2
parsing on the proxy path; the gateway already terminates TLS 1.3 with the
hybrid group (`pqTlsOptions()`), which Caddy's front would replace.

`TLS_MODE=internal`: the cert chains to Caddy's local CA. Give clients
`/data/caddy/pki/authorities/local/root.crt` from the `caddy_data` volume
(`gatewayTls.ca` / `DOMINUSNODE_PROXY_CA_FILE`).

`TLS_MODE=off`: no certificate, so the TLS listeners are off, 8080/1080 are
published and `PROXY_REQUIRE_TLS=false` (credentials in plaintext; the gateway
logs warnings). Use it only behind your own TLS front end or for tests.

**Firewall.** Open TCP 80 and 443 (ACME HTTP-01 and the site / cert host),
9443 (node tunnel), 8443 (HTTPS proxy) and 1443 (SOCKS5 over TLS) on the
gateway box. Close 8080/1080 unless you set `PUBLISH_PLAINTEXT_PROXY=1`.
Example (ufw): `sudo ufw allow 80,443,8443,9443,1443/tcp`; firewalld:
`sudo firewall-cmd --permanent --add-port={80,443,8443,9443,1443}/tcp && sudo firewall-cmd --reload`.
Docker-published ports bypass ufw's INPUT chain; the cloud provider's firewall
is the reliable place to restrict them. `PROXY_HOST` must be DNS only (grey
cloud) on Cloudflare.

Verify after install:
`openssl s_client -connect PROXY_HOST:8443 -servername PROXY_HOST -tls1_3 -groups X25519MLKEM768 </dev/null`
shows `Negotiated TLS1.3 group: X25519MLKEM768`, and
`curl -x https://relay:$DOMINUSNODE_API_KEY@PROXY_HOST:8443 https://httpbin.org/ip`
returns an exit IP.

### Split self-host: ROLE, RELAY_HOST/PROXY_HOST, Cloudflare Tunnel

The installer picks compose profiles from two settings (stored in `.env`):

| `ROLE` | Runs | Typical box |
|---|---|---|
| `all` (default) | postgres, migrate, api, gateway, Caddy | one box, current behaviour |
| `coordinator` | postgres, migrate, api (+ Caddy unless `TLS_MODE=cloudflare`) | home server |
| `gateway` | gateway + Caddy for `RELAY_HOST` only | small VPS |

| `TLS_MODE` | Site/API front end |
|---|---|
| `auto` / `internal` / `off` | Caddy, as before |
| `cloudflare` | `cloudflared` (outbound-only tunnel). No host ports for site/API. Not allowed with `ROLE=gateway` |

`RELAY_HOST` and `PROXY_HOST` are the gateway's public names (for example
`relay.dominusnode.com`, `proxy.dominusnode.com`). They feed
`PROXY_PUBLIC_HOST` (advertised proxy endpoint), `COORD_TUNNEL_URL`
(`wss://RELAY_HOST:9443/v1/tunnel` in coordinator.json) and the node tunnel
URL. With `TLS_MODE=cloudflare` the installer refuses a `RELAY_HOST` or
`PROXY_HOST` that is also a tunnel hostname: **proxy and relay traffic must
never go through Cloudflare** (long-lived raw TCP/WebSocket on ports 8443, 1443,
9443 and, when published, 8080/1080, which the tunnel's HTTP hostnames do not carry and Cloudflare's terms
do not allow for proxying). Point those DNS records (grey cloud, DNS only) at
the box that runs the gateway.

All new inputs are validated: hostnames by regex with no newlines, the token
path by `[A-Za-z0-9._/-]`, WireGuard addresses must be private IPv4 and the
public keys 64 hex. `env_set` refuses multi-line values. Re-runs keep secrets.

#### Cloudflare Tunnel (TLS_MODE=cloudflare)

1. Cloudflare dashboard → Zero Trust → Networks → Tunnels → Create a tunnel →
   Cloudflared. Name it (e.g. `dominusnode-home`). Copy the token from the
   install command shown (the long string after `--token`). Do not run that
   command.
2. On the server, store only the token in a 0600 file:
   `install -m 600 /dev/null selfhost/cloudflared.token && read -rs T && printf '%s' "$T" > selfhost/cloudflared.token; unset T`.
   The installer refuses the file unless it is a regular one-line file with mode
   0600/0400. Its path (never the token) goes in `.env` as
   `CLOUDFLARE_TUNNEL_TOKEN_FILE`. A root-only one-shot service copies it into
   a volume readable only by cloudflared's uid (65532), and cloudflared reads it
   with `--token-file` (cloudflared ≥ 2025.4.0). The image is pinned by version
   and digest in `docker-compose.selfhost.yml`.
3. In the tunnel → Public Hostnames, add one entry per site hostname, each with
   service type `HTTP` and URL `api:3000`: `dominusnode.com`, `www.dominusnode.com`,
   `api.dominusnode.com` and any alias hostnames (for example the DDG alias
   domain and its `www`). List the same names in `DOMINUSNODE_HOSTNAMES`.
   Cloudflare creates the proxied DNS records.
4. Do **not** add `proxy.` or `relay.` hostnames to the tunnel.
5. Remove any old A/AAAA records and router port forwards for the site
   hostnames: nothing inbound is needed on the coordinator.

#### ACME DNS-01 through Cloudflare (ACME_CHALLENGE=dns-cloudflare)

By default (`ACME_CHALLENGE=http`) Caddy proves control of each hostname to
Let's Encrypt over inbound port 80/443 (HTTP-01 / TLS-ALPN-01). With
`ACME_CHALLENGE=dns-cloudflare` it publishes a `_acme-challenge` TXT record
through the Cloudflare API instead (DNS-01), so **no inbound 80/443 is needed**
for any certificate. It is required (and the default) when `TLS_MODE=cloudflare`
and the box runs a gateway (`ROLE=all`): such a box has no inbound 80/443, so
HTTP-01 for `RELAY_HOST`/`PROXY_HOST` can never succeed and the installer
refuses to continue without a DNS token. It is also the recommended mode for a
`ROLE=gateway` VPS. Not available with `TLS_MODE=internal|off` or on a
`ROLE=coordinator TLS_MODE=cloudflare` box (no Caddy there).

Caddy is built locally by the installer as `dominusnode-caddy:selfhost` from
`infra/docker/caddy.Dockerfile`: `xcaddy` adds `github.com/caddy-dns/cloudflare`
to the pinned Caddy release, and both base images (builder and runtime) are
pinned by digest. Bump the Caddy version, module tag and both digests together.

1. Cloudflare dashboard → My Profile → API Tokens → Create Token → **Create
   Custom Token**. Name it `dominusnode-acme`. Permissions, least privilege:
   - `Zone` → `DNS` → `Edit`
   - `Zone` → `Zone` → `Read`

   Zone Resources: `Include` → `Specific zone` → your zone only (for example
   `dominusnode.com`). Optionally restrict Client IP Address Filtering to the
   box's egress address and set a TTL you will rotate before. Do not reuse the
   tunnel token or a Global API Key.
2. On the server, store only the token in a 0600 file (separate from the
   tunnel token file):
   `install -m 600 /dev/null selfhost/cloudflare-dns.token && read -rs T && printf '%s' "$T" > selfhost/cloudflare-dns.token; unset T`.
   The installer refuses it unless it is a regular one-line file, mode
   0600/0400, at a path matching `[A-Za-z0-9._/-]+`, and different from
   `CLOUDFLARE_TUNNEL_TOKEN_FILE`.
3. Re-run the installer:
   `ACME_CHALLENGE=dns-cloudflare CLOUDFLARE_DNS_TOKEN_FILE=./selfhost/cloudflare-dns.token ./scripts/selfhost/install.sh`.
   Only the path and `ACME_CHALLENGE` go in `.env`. A root-only, no-network
   one-shot (`caddy-dns-keys`, compose profile `dnscf`) copies the file into the
   `caddy_secrets` volume (0400, directory 0500), mounted read-only only by
   Caddy. The generated Caddyfile adds to every public-cert site block (site
   hostnames with `TLS_MODE=auto`, `RELAY_HOST:9443`, `PROXY_HOST`):

   ```
   tls {
     dns cloudflare {file./run/caddy-secrets/cloudflare-dns.token}
     resolvers 1.1.1.1 1.0.0.1
   }
   ```

   `{file.*}` is resolved by Caddy when it loads the config (Caddy ≥ 2.7,
   trailing newline stripped since 2.8.5), so the token never appears in `.env`,
   compose, the Caddyfile, any command line or log line. `resolvers` makes Caddy
   check TXT propagation against Cloudflare's public resolvers rather than a
   local or split-horizon resolver (the module's recommendation).
4. Once certificates are issued you may close inbound 80/443 on a gateway-only
   box (the gateway's 8443, 9443 and 1443 stay open). On a `TLS_MODE=auto` box
   that serves the site, 443 must stay open for visitors.

Switching back: `ACME_CHALLENGE=http ./scripts/selfhost/install.sh` removes the
`tls { dns … }` blocks and `CLOUDFLARE_DNS_TOKEN_FILE` from `.env` and
deletes the token copy from `caddy_secrets`
(re-open inbound 80/443 first). Re-runs in either direction are idempotent.

Renewal: Caddy renews about 30 days before expiry (Let's Encrypt, ZeroSSL as
fallback issuer) with the same DNS-01 challenge; nothing to schedule. DNS-01
certificates are stored in the same layout
(`caddy_data:/caddy/certificates/<issuer>/<host>/<host>.crt`), so `proxy-certs`
finds and hot-swaps the `PROXY_HOST` certificate exactly as with HTTP-01. If the
token is rotated, replace the file and re-run the installer (the one-shot
copies the new token and restarts Caddy, which reads the token only at startup).

Troubleshooting (`docker compose -f docker-compose.selfhost.yml logs caddy caddy-dns-keys`):

- `caddy-dns-keys` exited non-zero: the token file path in `.env` is wrong or
  not readable by root; re-run the installer.
- `HTTP 403` / `Authentication error` / `9109`: wrong token, token without
  `Zone:DNS:Edit`, or scoped to another zone. `expected 1 zone, got 0`: missing
  `Zone:Zone:Read`, or the hostname is not in the token's zone.
- `timed out waiting for record to fully propagate`: check that the zone is
  really on Cloudflare (`dig NS dominusnode.com`), that no leftover
  `_acme-challenge` CNAME exists, and that the box can reach 1.1.1.1:53.
- `module not registered: dns.providers.cloudflare`: Caddy is not the locally
  built image; re-run the installer (it builds `dominusnode-caddy:selfhost`).
  Check with `docker compose -f docker-compose.selfhost.yml exec caddy caddy list-modules | grep dns.providers.cloudflare`.
- Rate limits after repeated failures: Let's Encrypt limits failed validations
  per hostname per hour; fix the cause, then wait before retrying.

#### Gateway on a VPS, coordinator at home (WireGuard)

**Who signs.** The gateway signs every node-tunnel CHALLENGE
(`COORD_SIGNING_KEY_FILE`, `packages/proxy-gateway/src/node-tunnel/coord-key.ts`),
so the box running the gateway must hold a signing key. There is no subkey or
remote-signing mechanism in the code today. The installer therefore uses **two
independent keys**:

- the coordinator key (`selfhost/coord-key.pem` on the home box) never leaves home;
- the VPS generates its **own** key on first run (`selfhost/coord-key.pem` on
  the VPS). Its public key is pinned next to the home key
  (`DN_COORD_PUBKEYS=<home>,<vps>` on the VPS; `GATEWAY_PUBKEY` /
  `COORD_ADDITIONAL_PUBKEYS` on the coordinator so coordinator.json lists it).

Trade-off: a stolen VPS key can impersonate the gateway to nodes (and, being a
pinned key, sign documents) until it is rotated out (§3); a stolen home key is
not exposed by a VPS compromise. Keep the VPS key only on the VPS, rotate it on
any suspicion, and ship node builds pinning both. A remote signing endpoint
over WireGuard (key stays home, gateway asks per CHALLENGE) would be safer but
needs gateway code changes and is not implemented.

**WireGuard (both boxes).** Generate keys on each box; private keys never
leave it:

```bash
sudo apt install wireguard
umask 077; wg genkey | sudo tee /etc/wireguard/wg0.key | wg pubkey   # prints this box's public key
```

Home (`/etc/wireguard/wg0.conf`, 10.66.0.1):

```ini
[Interface]
Address = 10.66.0.1/24
ListenPort = 51820
PostUp = wg set %i private-key /etc/wireguard/wg0.key
[Peer]
PublicKey = <VPS public key>
AllowedIPs = 10.66.0.2/32
```

VPS (10.66.0.2; the VPS dials home, so home needs UDP 51820 forwarded; for
the reverse, home dials a listening VPS, see "Gateway VPS checklist"):

```ini
[Interface]
Address = 10.66.0.2/24
PostUp = wg set %i private-key /etc/wireguard/wg0.key
[Peer]
PublicKey = <home public key>
Endpoint = <home public IP or DDNS>:51820
AllowedIPs = 10.66.0.1/32
PersistentKeepalive = 25
```

`sudo systemctl enable --now wg-quick@wg0` on both. Firewall on the home box so
only the VPS reaches Postgres, and only over wg0 (Docker-published ports bypass
the INPUT chain, so filter in `DOCKER-USER`):

```bash
sudo iptables -I DOCKER-USER -p tcp --dport 5432 ! -i wg0 -j DROP
sudo iptables -I DOCKER-USER -i wg0 -p tcp --dport 5432 ! -s 10.66.0.2 -j DROP
```

Persist these with your distribution's tool (`iptables-persistent`, nftables).

**Database link.** The coordinator publishes Postgres only on `DB_WG_BIND`
(its WireGuard address) through `docker-compose.selfhost.wg-db.yml`, which the
installer adds automatically. The gateway never gets the Postgres superuser:
after `migrate` the coordinator's installer applies
`scripts/selfhost/gateway-role.sql`, which creates `dominusnode_gateway`
(NOSUPERUSER, no DDL, no server program or file access, row access on the
tables the gateway uses, none on MFA, agent secrets or root-admin identity),
and writes its URL to `selfhost/gateway-database-url` (0600). Use that as the
gateway's
`GATEWAY_DATABASE_URL=postgresql://dominusnode_gateway:<GATEWAY_DB_PASSWORD>@10.66.0.1:5432/dominusnode`.
The gateway installer refuses the `dominusnode` superuser, accepts only a
private IPv4 host and a password of 24+ alphanumerics. Docker NATs the
published port, so `pg_hba.conf` cannot tell the VPS apart by address: keep the
`DOCKER-USER` rules above. The
link is encrypted by WireGuard; Postgres itself runs without TLS (`DB_SSL=false`),
so never publish it on any other interface. Pass the URL through the
environment or the hidden prompt, not as a command-line argument; it is stored
only in the 0600 `.env`.

**Boot order.** Docker can bind `DB_WG_BIND` only while wg0 is up. If Docker
starts first, the postgres container fails and takes api and migrate with it.
On systemd the installer adds this drop-in when it starts the stack; otherwise
add it by hand:

```ini
# /etc/systemd/system/docker.service.d/10-after-wg.conf
[Unit]
Wants=wg-quick@wg0.service
After=wg-quick@wg0.service
```

then run `sudo systemctl daemon-reload`. The installer also refuses a
`DB_WG_BIND` that is not assigned to a WireGuard interface, so a LAN address
such as 192.168.1.10 cannot publish Postgres to the home network. Bring wg0 up
before running it. `ALLOW_NON_WG_DB_BIND=1` overrides the check (tests only).

**Changing role.** Every run rewrites all role-specific keys
(`GATEWAY_DATABASE_URL`, `COORD_PUBKEY`, `DB_WG_BIND`, `GATEWAY_PUBKEY`,
`COORD_ADDITIONAL_PUBKEYS`) and clears those that do not belong to the new
role. To retire a gateway key, rerun the coordinator with an empty
`GATEWAY_PUBKEY`.

**Nodes trust both keys.** The VPS signs CHALLENGEs with its own key, so a
node must confirm the home key and the VPS key:
`--trust sha256:<home>,sha256:<vps>`. The installer prints both fingerprints in
its join command, and a node that is not yet trusted prints the full list.

**Suspend and erase.** Admin suspend and account deletion also POST to
`PROXY_INTERNAL_HOST`, which does not reach a gateway on another box. Every
gateway runs a user-status sweep (`USER_STATUS_SWEEP_INTERVAL_MS`, default
30 s): sessions of users that are no longer `active` in the database are
settled and closed, so a suspended requester loses open tunnels within one
interval. The suspend response carries a `warning` when the direct signal
failed.

**Wallet proxy-session tokens (`dn_proxy_`).** The coordinator's api signs
them with its `JWT_SECRET`; the gateway verifies them with its own. Give the
VPS installer the coordinator's value (`COORD_JWT_SECRET=<JWT_SECRET from the
coordinator's .env>`, or the hidden prompt) and compare the "JWT secret check
value" both installers print. Without it, `dn_proxy_` tokens are rejected on
the split gateway; `dn_live_` keys are unaffected.

**Upgrading a split install.** The coordinator re-run creates
`selfhost/api-key-pepper` (if missing) and the api starts storing keys as v2
and rewriting v1 rows as keys authenticate there. The gateway cannot go first
(its installer needs that pepper and the new `selfhost/gateway-database-url`).
So: (1) re-run the coordinator installer; (2) straight away copy
`selfhost/api-key-pepper` and `selfhost/gateway-database-url` to the VPS (scp,
mode 0600) and re-run the VPS installer with `API_KEY_PEPPER`/the pepper file,
`GATEWAY_DATABASE_URL` and `COORD_JWT_SECRET`; (3) compare the pepper and JWT
check values. Between (1) and (2) the gateway answers 407 for every key
created or used on the api since the upgrade; keep that window short or do it
in a maintenance window.

Admin live gateway stats (`PROXY_INTERNAL_HOST`) are not wired across the split.

#### Gateway VPS checklist

The order for bringing up a fresh gateway VPS (`gateway.example.org` below; the
coordinator stays at home). Hostnames are placeholders.

1. **DNS.** Point `relay.example.org` and `proxy.example.org` (A records) at
   the VPS's public IPv4. Both must be **DNS only** (grey cloud) in Cloudflare:
   relay and proxy traffic must never go through the Cloudflare proxy, and
   Caddy needs inbound 80/443 for HTTP-01.
2. **Firewall.** Open TCP 80, 443 (ACME + relay site), 8443 (HTTPS proxy),
   1443 (SOCKS5 over TLS), 9443 (node tunnel) and, for the direction below,
   UDP 51820, at the provider and in `ufw`. Nothing else, and never 5432.
3. **WireGuard.** Either direction from "Gateway on a VPS, coordinator at
   home" works. Recommended for a home box behind NAT/CGNAT: **home dials the
   VPS**, so nothing is forwarded at home. The VPS listens:

   ```ini
   # VPS /etc/wireguard/wg0.conf (10.66.0.2)
   [Interface]
   Address = 10.66.0.2/24
   ListenPort = 51820
   PostUp = wg set %i private-key /etc/wireguard/wg0.key
   [Peer]
   PublicKey = <home public key>
   AllowedIPs = 10.66.0.1/32
   ```

   and the home box dials out and keeps the NAT mapping open:

   ```ini
   # home /etc/wireguard/wg0.conf (10.66.0.1)
   [Interface]
   Address = 10.66.0.1/24
   PostUp = wg set %i private-key /etc/wireguard/wg0.key
   [Peer]
   PublicKey = <VPS public key>
   Endpoint = gateway.example.org:51820
   AllowedIPs = 10.66.0.2/32
   PersistentKeepalive = 25
   ```

   Postgres still only listens on home's `DB_WG_BIND` (10.66.0.1); the
   `DOCKER-USER` rules above apply unchanged. The VPS cannot reach home until
   home has dialed, so start wg on home after the VPS.
4. **Coordinator.** On the home box, with wg up:
   `DB_WG_BIND=10.66.0.1 ./scripts/selfhost/install.sh --yes`, then copy
   `selfhost/gateway-database-url` and `selfhost/api-key-pepper` to the VPS
   (scp, mode 0600).
5. **Gateway.** On the VPS:
   `ROLE=gateway RELAY_HOST=relay.example.org PROXY_HOST=proxy.example.org
   COORD_PUBKEY=<home coord.pub> ./scripts/selfhost/install.sh` (the
   database URL, pepper and `COORD_JWT_SECRET` through the hidden prompts or
   environment, never argv). The VPS generates its **own** signing key
   (`selfhost/coord-key.pem`); the coordinator key is never copied to it. The
   installer prints `gateway public key (hex): <vps>`.
6. **Preflight.** `./scripts/selfhost/preflight.sh` on the VPS. Read-only; it
   checks that both hostnames resolve to this host and not to a Cloudflare
   address, the gateway ports are free or held by the stack (and allowed by
   ufw), wg0 has a handshake under 180 s, the `GATEWAY_DATABASE_URL` host is
   routed over wg0 and accepts TCP, NTP is synchronised and there is at least
   `PREFLIGHT_MIN_DISK_GB` (default 10) free. `PUBLIC_IP` overrides the address
   it compares DNS against (NAT'd VPS). Inbound reachability from the internet
   cannot be proven from the box itself; test from outside with
   `curl -v https://relay.example.org:9443/` and a proxied request.
7. **Add the gateway key to the coordinator.** On the home box:
   `GATEWAY_PUBKEY=<vps> ./scripts/selfhost/install.sh --yes`. That sets
   `GATEWAY_PUBKEY` and `COORD_ADDITIONAL_PUBKEYS` so coordinator.json lists
   the key, and `DN_COORD_PUBKEYS=<home>,<vps>`.
8. **Node images.** Release node-agent builds and the published node image
   must pin both keys (§2):
   `DN_COORD_PUBKEYS=<home>,<vps> npm run build:release -w @dominusnode/node-agent`.
   Nodes already running confirm both with `--trust sha256:<home>,sha256:<vps>`
   (printed by the installer). Until a node trusts the VPS key it refuses the
   gateway's CHALLENGE.
9. Compare the pepper and JWT check values printed on both boxes.

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
4. Publish the first network policy (§3a). Until then the federation documents
   (`coordinator.json`, `policy.json`) return 503.

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
