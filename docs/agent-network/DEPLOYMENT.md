# Relay deployment notes

Short operator guide for the coordinator signing key, node-agent pin
embedding, the ASN database and the tunnel ingress. See DESIGN.md §2, §4, §11.

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

## 4. ASN database

The gateway uses the iptoasn.com `ip2asn-combined.tsv.gz` dataset (Public
Domain, PDDL v1.0). It needs no license key and makes no runtime calls. The
per-ASN node cap and dc/residential classification depend on it.

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
- `HOSTING_ASNS=1,2,3` adds ASNs to the built-in hosting list in
  `packages/proxy-gateway/src/asn-db.ts`. Peers on those ASNs are classified
  `dc`.

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
      @tunnel tls sni relay.example.com
      route @tunnel {
        proxy {
          proxy_protocol v2
          upstream gateway:8443
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
| `PROXY_REQUIRE_TLS` | `true` refuses credentials on the plaintext listeners: HTTP returns `403 TLS required`, SOCKS5 connections are closed. Needs `PROXY_TLS_PORT`. Default off. |

In production without `PROXY_REQUIRE_TLS=true`, the gateway logs a startup
warning and at most one warning per minute per listener when credentials
arrive over plaintext. Roll out in two steps: enable `PROXY_TLS_PORT`, move
clients, then set `PROXY_REQUIRE_TLS=true`.

Expose the TLS port directly (the gateway terminates TLS), or pass it through
Caddy layer4 without terminating. Use a certificate for the public proxy
hostname.

Clients:

- Node SDK: `new DominusNodeClient({ proxyHost, gatewayTls: true })`
  (port 8443) or `gatewayTls: { port, ca }`. `proxy.fetch` uses TLS and
  `buildUrl` returns `https://...`. Other SDKs: follow-up (SDK_SURFACE.md §5).
- MCP server: `DOMINUSNODE_PROXY_URL=https://proxy.example.com:8443`
  (optional `DOMINUSNODE_PROXY_CA_FILE` for a private CA). Preferred over
  `DOMINUSNODE_HTTP_PROXY_PORT` when set.
- curl: `curl -x https://relay:$KEY@proxy.example.com:8443 https://example.com`.
