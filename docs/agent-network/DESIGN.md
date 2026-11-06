# DomiNode Agent Relay Network: Technical Design

Status: accepted for implementation. Supersedes the Webshare/pool-manager upstream model.
Inputs: the codebase pivot map, `docs/agent-network/ABUSE_CONTROLS.md`, and three candidate designs (MVP-first, security-first, economics-first).

**Synthesis approach**
- The base is the security-first design, which scored highest overall. It contributes the threat model, gateway-only byte billing, self-dealing defences, the plaintext-HTTP default and maturity holds.
- The commit order follows the MVP-first plan: reuse existing code, keep the schema additive, ship value early and defer heavy coordinator jobs.
- Money is stored as integer micro-USD and every split is snapshotted, as in the economics-first design. The full double-entry ledger and wallet rewrite are deliberately **not** adopted.

Flaws flagged in review, and how this design resolves them:

| Flaw | Resolution |
|---|---|
| Whole-cent splits lose sub-cent sessions | Split ledger and node credits use `BIGINT` micro-USD (µUSD). The requester wallet still debits whole cents (§6.2). |
| Mixed cents and micro units in credit tables | All new money columns are `_musd`. Only the legacy `wallets.balance_cents` stays in cents, with an explicit conversion rule. |
| `floorHash` presented as enforcement | It is advisory telemetry only (§2.6). The floor protects the node's own operator, so a modified client hurts only itself. Gateway-side checks never depend on it. |
| A PROBE frame type contradicts "indistinguishable" | No PROBE frame exists. Canaries are ordinary `OPEN`s, and the marker lives only on the coordinator. |
| `UNIQUE(observed_ip)` blocks NATed users | Replaced by admin-tunable caps per /32, /24 and ASN (default 2 per /32), enforced at AUTH and not by a unique index. |
| `CREATE TABLE` and `ADD CONSTRAINT` not idempotent | Every statement is `IF NOT EXISTS`, or uses a `DO $$ … $$` guard. |
| The abuse log sits outside the settle transaction | The abuse-log row is written inside `settleRelayCharge`. |
| ASN CHECK cast overflow | `asn BIGINT CHECK (asn BETWEEN 0 AND 4294967295)`. |
| Reputation from requester reports is gameable | Reports are capped per requester per node per day and weighted by the requester's paid spend. Paid traffic from distinct requesters, probes and disputes dominate. |
| Removing `email_verified` and MFA globally | They are removed only for **wallet-identity** principals, via `requireAgentPrincipal`. Human admin login keeps MFA, behind `ADMIN_HUMAN_LOGIN`. |
| Big-bang wallet migration | No migration. Existing `wallets` and `walletRepo.reserveBalance`/`settleSession` are reused unchanged inside a new transaction wrapper. |
| Hard cutover with no supply | The `UPSTREAM_MODE` switch exists only in dev and staging. Production ships with `relay` and seeded operator-run nodes (§11). |

---

## 0. Principles

1. **Exit nodes are untrusted.** A node is treated as malicious until it earns reputation, and even then it is trusted only statistically.
2. **Requesters are untrusted.** Contributors are protected by abuse controls 2–9.
3. **Only the gateway counts billable bytes.** The node's own counts are used solely for dispute detection.
4. **The node-side floor cannot be disabled.** There is no flag, env var or policy key for it, and the platform cannot turn it off either.
5. **No third-party IP upstream.** `packages/pool-manager` is removed, and production never loads it.
6. **Fail closed.** With no policy snapshot, no split config or no eligible node, the request is rejected with 503 or 403. It never becomes free or direct.
7. **Repo conventions apply** (`.claude/rules`):
   - no `SELECT *` or `RETURNING *`;
   - every numeric CHECK has a floor and a ceiling;
   - check-then-act runs in `BEGIN/COMMIT` with `FOR UPDATE`;
   - every in-memory Map has a size cap and a sweep;
   - `connectWithRetry` is called in every `main.ts`;
   - credentials are scrubbed from errors (add `dn_node_`).

## 1. Threat model

| # | Threat | Mitigation |
|---|---|---|
| T1 | A node MITMs HTTPS | CONNECT and SOCKS5 carry a raw TCP stream, and TLS runs end to end between requester and origin. The protocol has no terminate or inject frame. The SDK and MCP `proxy-fetch` keep `rejectUnauthorized: true`, and a test asserts it. |
| T2 | A node sniffs or tampers with plain HTTP | Plain HTTP is rejected with `400 PLAINTEXT_DISABLED` unless the username carries `allowhttp-1`. `/v1/policy` and the MCP tool docs state that HTTP is visible to the exit. Canary probes detect tampering. |
| T3 | A node lies about bytes | Billing uses the gateway `ByteCounter` on the requester socket. The node's `CLOSE{bytes}` only feeds `byte_disputes`, and a charge is marked `disputed` when the mismatch exceeds 10% **and** 1 MB. |
| T4 | Slowloris or padding | 60 s idle timeout per stream. TTFB and throughput feed health. |
| T5 | Sybil credit farming | (a) Caps per observed /32, /24 and ASN. (b) Registration needs a wallet signature **and** a PoW (reuse `pow_challenges`). (c) Credit is earned only from paid traffic of *other* principals. (d) 7-day maturity hold with clawback. (e) New nodes start at reputation 0.3 with a reduced GB/day cap. |
| T6 | Wrong geo, DC sold as residential, content injection | Canary `OPEN`s to `/v1/probe/echo` check the egress IP, an unmodified nonce body, and server-side GeoIP and ASN classification into `ip_class`. A failure quarantines the node. **Post-MVP** (commit 26); the MVP sets geo from the tunnel peer IP. |
| T7 | Self-dealing or wash trading | Selection excludes nodes whose owner user, wallet, team or egress /24 matches the requester. Settle re-checks inside the transaction. A match gives a `node_musd=0` row with `zero_reason='self_dealing'`. A collusion detector runs post-MVP. |
| T8 | A node claims an IP it does not own | The node never declares an IP. The coordinator records the TCP peer of the tunnel. |
| T9 | A requester attacks the contributor's LAN or metadata service | The gateway runs `validateTarget`. The node then re-resolves DNS itself, checks **all** IPs, dials the checked IP, and re-checks `socket.remoteAddress` after connect. Ports are limited to 80/443 ∩ policy ∩ local, with a hard deny list. |
| T10 | A requester burns the contributor's IP | Port policy, category denylist, per-node and per-requester caps, burn cooldown per (node, eTLD+1), and the metadata log. |
| T11 | Forged coordinator or tunnel hijack | TLS 1.3 to the relay host, with an SPKI pin set in node-agent (overridable only toward stricter pins). The CHALLENGE is signed by a coordinator ed25519 key embedded in node-agent. |
| T12 | Stolen node credentials | The `dn_node_` key can run a tunnel only. Credit conversion and withdrawal need a fresh EIP-191 signature from the owner wallet. Keys are SHA-256 hashed and revocable. |
| T13 | x402 or MPP replay, or facilitator spoofing | Keep `claimPaymentHash`/`releasePaymentHash`. `validateSettleResponse` runs per adapter. Facilitator URLs come from a hardcoded allowlist. |
| T14 | Requesters de-anonymise nodes | Node IDs and the node↔IP mapping are never returned to requesters. Stats are aggregate only. This matches the SDK rule that `ActiveSession` carries no `proxy_ip`. |

## 2. Tunnel protocol (node-agent ↔ gateway)

### 2.1 Transport
- The node dials out with a single WSS connection to `wss://relay.<domain>/v1/tunnel`, on 443 behind Caddy.
- Locally the gateway listens on `TUNNEL_PORT` (default 8443). The handler lives in `proxy-gateway/src/node-tunnel/`; a separate `packages/relay` is **not** created in v1.
- Binary WebSocket messages carry our own mux framing.
- **Peer IP** (used for geo/sanctions and per-/32,/24 caps) comes from the raw TCP socket, or from a PROXY protocol v2 header **only** when the TCP peer is listed in `TUNNEL_TRUSTED_PROXY_IPS` (header then mandatory). `X-Forwarded-For` is never read. Deploy one of: (a) Caddy `layer4` TLS passthrough to `TUNNEL_PORT` with `proxy_protocol v2`, plus `TUNNEL_TLS_CERT_FILE`/`TUNNEL_TLS_KEY_FILE` so the gateway terminates TLS and the `tls-exporter` binding works; (b) a TCP proxy sending PROXY v2 with TLS terminated upstream (binding `none`); (c) the gateway exposed directly. With `NODE_ENV=production` and neither trusted proxies nor gateway TLS configured, the gateway logs a warning at startup, and non-public peer IPs are refused in production in every mode.
- Pre-auth limits on the upgrade, applied before the key lookup: a token bucket per source IP, a global cap on lookups in flight, and a short negative cache of unknown key hashes. All maps are size-capped and swept.
- Dependency: `ws`, which the gateway may already have. Otherwise it is the only new runtime dependency.

### 2.2 Frame (big-endian, 12-byte header)
```
u8  version   (=1; anything else -> close 1002)
u8  type
u32 stream_id (0 = control; streams are allocated by the gateway only, odd ids)
u16 flags     (bit0 FIN, bit1 RST)
u32 length    (<= 65536; larger -> protocol error, close)
u8[length] payload
```
Codec: `shared/src/tunnel/frame.ts` (`encodeFrame`, `FrameDecoder` with a bounded buffer). Control payloads are JSON, passed through `stripDangerousKeys` and capped at 4 KiB.

### 2.3 Frame types

| Code | Name | Dir | Payload |
|---|---|---|---|
| 0x01 | HELLO | N→G | `{nodeId, agentVersion, caps:{maxStreams,maxMbps,gbPerDay,ports[]}, floorHash}` |
| 0x02 | CHALLENGE | G→N | `{nonce(32B hex), policyVersion, serverTime, coordSig}`. The ed25519 `coordSig` covers `nonce‖policyVersion‖serverTime`. |
| 0x03 | AUTH | N→G | `{sig}`: ed25519 by the node key over `"dominode-tunnel-v1"‖nonce‖nodeId‖tlsExporter(32)`. Not required for the MVP; it lands in commit 20. |
| 0x04 | AUTH_OK | G→N | `{heartbeatMs, initialWindow, policyHash}` |
| 0x05 | AUTH_FAIL | G→N | `{code}`, then close |
| 0x10 | OPEN | G→N | `{host, port}`. The node resolves the name. Canary probes use this same frame. |
| 0x11 | OPEN_OK | N→G | `{}` |
| 0x12 | OPEN_ERR | N→G | `{code: FLOOR_BLOCKED, PORT_BLOCKED, DNS_FAIL, DIAL_FAIL, CAP_EXCEEDED}` |
| 0x13 | DATA | both | raw bytes |
| 0x14 | WINDOW | both | u32 credit increment |
| 0x15 | CLOSE | both | `{bytesIn, bytesOut, reason}` (node counts, used for disputes). Flags FIN or RST. |
| 0x20 | PING / 0x21 PONG | both | `{seq, ts}` |
| 0x22 | DRAIN | G→N | Stop accepting OPEN and finish streams within 30 s. |
| 0x23 | POLICY_UPDATE | G→N | `{policyVersion, ports[], categoriesVersion}`. The node applies the **intersection** with its local policy. |

### 2.4 Handshake
1. The WS upgrade carries `Authorization: Bearer dn_node_<key>`. The gateway checks `SHA-256 → nodes.node_key_hash` with `status IN ('pending','active')` and an active owner. The MVP's identity is this key plus the wallet attestation captured at registration.
2. HELLO, then CHALLENGE, then AUTH (the ed25519 channel-binding signature from commit 20 onward), then AUTH_OK.
3. Coordinator-side checks before AUTH_OK:
   - geo of the peer IP is not sanctioned (`sanctions.ts`, `geo-data.ts`);
   - the per-/32, /24 and ASN node caps hold (counted under `FOR UPDATE` on a `node_ip_slots` advisory lock);
   - `attestation_version >= policy.attestation.minVersion`.
4. Deadline: 10 s from upgrade, with pre-auth frames capped at 4 KiB. An unknown frame type closes the tunnel.

### 2.5 Mux, flow control and liveness
- Each stream starts with a 256 KiB window. The receiver sends `WINDOW` after consuming half of it.
- Per-tunnel buffer cap: `maxStreams × 256 KiB`.
- Concurrent streams are limited to `min(node caps, policy caps)`. Above that the gateway does not send `OPEN`; the node answers `CAP_EXCEEDED` defensively.
- PING every 15 s. Three misses close the tunnel and RST its streams, which settle with gateway bytes so far. RTT feeds a health EWMA.
- The node reconnects with jittered exponential backoff from 1 to 60 s.

### 2.6 `floorHash` semantics
`floorHash` is SHA-256 of the floor constants plus the agent version. It is **advisory**: it is logged and shown on the admin Nodes page, and unknown hashes lower selection weight. It is not a security boundary. The floor protects the node operator, and the gateway runs its own `validateTarget` independently.

## 3. Node agent (`packages/node-agent`)

| File | Responsibility |
|---|---|
| `src/main.ts` | CLI: `register`, `run`. Validates numeric env with NaN and range checks. Zeroizes the key material on exit. |
| `src/config.ts` | Operator overrides that can only tighten: ports subset, caps lower, extra deny domains. |
| `src/register.ts` | Calls `/v1/nodes/challenge`, signs the attestation (EIP-191) with a wallet key read from a file path (never argv), solves the PoW, generates an ed25519 key, and stores `dn_node_` with mode 0600. |
| `src/tunnel-client.ts` | WSS with SPKI pin, framing, mux, reconnect. |
| `src/floor.ts` | Imports `shared/src/net-guard.ts`. Has no config inputs. |
| `src/dialer.ts` | `resolveAll` → check every IP → `net.connect` to the first allowed IP → re-check `remoteAddress` → stream. |
| `src/limits.ts` | Local req/s, stream and GB/day caps. |

**Floor (non-disableable).**
- Everything in `net-guard`: private, loopback, link-local, CGNAT, metadata (169.254.169.254, fd00:ec2::254), Teredo/6to4-embedded, IPv4-compatible and mapped IPv6, the `.localhost`/`.local`/`.internal`/`.arpa` names, and hex, octal and decimal IP forms.
- The node's own public IP and LAN gateway, discovered at startup.
- `HARD_DENY_PORTS = {22,23,25,465,587,3389,6667}`.
- `FLOOR_PORTS = {80,443}`. Effective ports are `FLOOR_PORTS ∩ policy.ports ∩ local.ports`.
- A test asserts that no env, CLI flag or policy key changes any of these. A hostile `POLICY_UPDATE` that adds port 25 or `127.0.0.1` has no effect.
- The node logs metadata only (ts, stream, host, bytes), never payloads.

## 4. Node registry and selection

**DB repo** `shared/src/repositories/node-repo.ts`:
- `createChallenge`
- `registerNode` (transaction; per-owner cap of 5 using `FOR UPDATE` on the user row)
- `getNodeForTunnelAuth(keyHash)`
- `markOnline(nodeId, ip, country, asn)`, `markOffline`
- `flushHealth(batch)` (LIMIT 1000)
- `setStatus`, `listForOwner`, `listAdmin`

**Live registry** `proxy-gateway/src/node-tunnel/registry.ts`:
- `Map<nodeId, LiveNode>`, capped at 100k and swept every 60 s.
- Index `Map<country, Set<nodeId>>`.
- `LiveNode` holds the tunnel, country, asn, ipClass, ownerUserId, ownerWallet, ownerTeamId, prefix24, health, reputation, openStreams, bytesToday and cooldown map.

**`NodeSelector.select(opts)`** replaces `ProviderSelector.select` with the same error contract: `sanctioned` → 403, `unavailable` → 503 `NO_NODES_AVAILABLE`.
```ts
interface SelectOpts { country?: string; ipClass?: 'residential'|'dc'|'mobile'; requesterUserId: string;
  requesterWallet?: string; requesterTeamId?: string; clientIp: string; targetHost: string; port: number;
  sticky?: string; excludeNodeIds?: string[]; }
```
1. **Filter:**
   - `status='active'`, online, and not in quarantine or cooldown;
   - not sanctioned, and matches the requested country;
   - matches ipClass if given;
   - not self-dealing (owner, wallet, team, or /24 of `clientIp`);
   - stream, GB/day and req/s within caps;
   - port allowed;
   - no burn cooldown for (node, eTLD+1).
2. **Score:** `w = reputation² · health · 1/(1+openStreams) · fairness`, where `fairness` downweights nodes far above the median of today's earnings.
3. **Pick:** weighted random over the top K=10.
4. **Sticky:** `session-<id>` maps to nodeId in an LRU (TTL 10 min, cap 100k) while the node stays healthy.
5. **Retry:** `OPEN_ERR DIAL_FAIL/DNS_FAIL` retries once on another node (`retry.ts`). `FLOOR_BLOCKED` or `PORT_BLOCKED` returns 403 with no retry.

**Reputation** is stored as an integer from 0 to 10000 and starts at 3000.
- It rises with gateway-measured paid bytes from distinct requesters.
- It falls with disputes, probe failures, burn signals and admin action. Burn signals are 403/429 or a captcha on plaintext responses, plus `POST /v1/sessions/:id/report`, which is capped at 5 per requester per node per day and weighted by the requester's 30-day spend.
- Below 1000 the node is `quarantined`.
- Counters flush every 60 s to `node_daily_stats` and `node_reputation`.

## 5. Schema (`packages/shared/src/schema.sql`, appended, idempotent)

```sql
-- ===== Nodes =====
CREATE TABLE IF NOT EXISTS nodes (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_user_id       UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  owner_wallet        TEXT NOT NULL CHECK (owner_wallet ~ '^0x[0-9a-f]{40}$'),
  node_key_hash       TEXT NOT NULL UNIQUE CHECK (length(node_key_hash) = 64),
  node_pubkey         TEXT UNIQUE CHECK (node_pubkey IS NULL OR node_pubkey ~ '^[0-9a-f]{64}$'),
  status              TEXT NOT NULL DEFAULT 'pending'
                      CHECK (status IN ('pending','active','cooldown','quarantined','suspended','revoked')),
  attestation_version INTEGER NOT NULL CHECK (attestation_version BETWEEN 1 AND 100000),
  attestation_sig     TEXT NOT NULL CHECK (length(attestation_sig) BETWEEN 132 AND 200),
  observed_ip         INET,
  ip_prefix24         CIDR,
  asn                 BIGINT CHECK (asn IS NULL OR asn BETWEEN 0 AND 4294967295),
  country             CHAR(2) CHECK (country IS NULL OR country ~ '^[A-Z]{2}$'),
  ip_class            TEXT CHECK (ip_class IS NULL OR ip_class IN ('residential','dc','mobile','unknown')),
  max_streams         INTEGER NOT NULL DEFAULT 32 CHECK (max_streams BETWEEN 1 AND 1024),
  max_gb_day          INTEGER NOT NULL DEFAULT 5  CHECK (max_gb_day BETWEEN 1 AND 10000),
  reputation          INTEGER NOT NULL DEFAULT 3000 CHECK (reputation BETWEEN 0 AND 10000),
  byte_disputes       INTEGER NOT NULL DEFAULT 0 CHECK (byte_disputes BETWEEN 0 AND 1000000),
  agent_version       TEXT CHECK (agent_version IS NULL OR length(agent_version) <= 32),
  floor_hash          TEXT CHECK (floor_hash IS NULL OR length(floor_hash) = 64),
  last_seen_at        TIMESTAMPTZ,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_nodes_owner ON nodes(owner_user_id);
CREATE INDEX IF NOT EXISTS idx_nodes_select ON nodes(status, country, ip_class);
CREATE INDEX IF NOT EXISTS idx_nodes_prefix ON nodes(ip_prefix24) WHERE status IN ('pending','active');

CREATE TABLE IF NOT EXISTS node_challenges (       -- like wallet_challenges; consumed via DELETE...RETURNING
  nonce_hash   TEXT PRIMARY KEY CHECK (length(nonce_hash) = 64),
  user_id      UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at   TIMESTAMPTZ NOT NULL,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS node_daily_stats (
  node_id   UUID NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
  day       DATE NOT NULL,
  bytes     BIGINT  NOT NULL DEFAULT 0 CHECK (bytes BETWEEN 0 AND 1000000000000000),
  streams   INTEGER NOT NULL DEFAULT 0 CHECK (streams BETWEEN 0 AND 2000000000),
  failures  INTEGER NOT NULL DEFAULT 0 CHECK (failures BETWEEN 0 AND 2000000000),
  burns     INTEGER NOT NULL DEFAULT 0 CHECK (burns BETWEEN 0 AND 2000000000),
  PRIMARY KEY (node_id, day)
);

CREATE TABLE IF NOT EXISTS node_reputation (
  node_id      UUID NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
  target_etld1 TEXT NOT NULL CHECK (length(target_etld1) BETWEEN 1 AND 253),
  ok_count     INTEGER NOT NULL DEFAULT 0 CHECK (ok_count BETWEEN 0 AND 2147483647),
  burn_count   INTEGER NOT NULL DEFAULT 0 CHECK (burn_count BETWEEN 0 AND 2147483647),
  cooldown_until TIMESTAMPTZ,
  PRIMARY KEY (node_id, target_etld1)
);

-- ===== Pricing + split (append-only, versioned; current = max(effective_from) <= now()) =====
CREATE TABLE IF NOT EXISTS revenue_split_config (
  id                 SERIAL PRIMARY KEY,
  node_share_bps     INTEGER NOT NULL CHECK (node_share_bps BETWEEN 0 AND 10000),
  maturation_hours   INTEGER NOT NULL DEFAULT 168 CHECK (maturation_hours BETWEEN 0 AND 2160),
  effective_from     TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by         UUID REFERENCES users(id),
  note               TEXT CHECK (note IS NULL OR length(note) <= 500),
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);
INSERT INTO revenue_split_config (node_share_bps, note)
  SELECT 7000, 'seed' WHERE NOT EXISTS (SELECT 1 FROM revenue_split_config);

CREATE TABLE IF NOT EXISTS network_pricing (        -- per ip_class; 'any' = default
  ip_class          TEXT PRIMARY KEY CHECK (ip_class IN ('any','residential','dc','mobile')),
  price_per_gb_musd BIGINT NOT NULL CHECK (price_per_gb_musd BETWEEN 1000 AND 5000000), -- $0.001..$5
  updated_by        UUID REFERENCES users(id),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);
INSERT INTO network_pricing (ip_class, price_per_gb_musd) VALUES ('any', 200000)
  ON CONFLICT (ip_class) DO NOTHING;                -- $0.20/GB placeholder

-- ===== Per-charge split ledger (source of the admin revenue dashboard) =====
CREATE TABLE IF NOT EXISTS relay_charges (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id         UUID NOT NULL UNIQUE REFERENCES sessions(id),   -- idempotent settle
  requester_user_id  UUID NOT NULL REFERENCES users(id),
  node_id            UUID NOT NULL REFERENCES nodes(id),
  node_owner_user_id UUID NOT NULL REFERENCES users(id),
  payment_rail       TEXT NOT NULL CHECK (payment_rail IN ('wallet','team','agentic_wallet','x402','mpp','free')),
  bytes_gateway      BIGINT NOT NULL CHECK (bytes_gateway BETWEEN 0 AND 1099511627776),
  bytes_node         BIGINT CHECK (bytes_node IS NULL OR bytes_node BETWEEN 0 AND 1099511627776),
  price_per_gb_musd  BIGINT NOT NULL CHECK (price_per_gb_musd BETWEEN 1000 AND 5000000),
  gross_musd         BIGINT NOT NULL CHECK (gross_musd BETWEEN 0 AND 2147483647000000),
  node_musd          BIGINT NOT NULL CHECK (node_musd BETWEEN 0 AND 2147483647000000),
  platform_musd      BIGINT NOT NULL CHECK (platform_musd BETWEEN 0 AND 2147483647000000),
  split_config_id    INTEGER NOT NULL REFERENCES revenue_split_config(id),
  node_share_bps     INTEGER NOT NULL CHECK (node_share_bps BETWEEN 0 AND 10000),
  zero_reason        TEXT CHECK (zero_reason IS NULL OR zero_reason IN ('self_dealing','quarantined','collusion_hold','free_tier')),
  disputed           BOOLEAN NOT NULL DEFAULT false,
  matures_at         TIMESTAMPTZ NOT NULL,
  matured            BOOLEAN NOT NULL DEFAULT false,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (node_musd + platform_musd = gross_musd)
);
CREATE INDEX IF NOT EXISTS idx_rc_created ON relay_charges(created_at);
CREATE INDEX IF NOT EXISTS idx_rc_node ON relay_charges(node_id, created_at);
CREATE INDEX IF NOT EXISTS idx_rc_mature ON relay_charges(matures_at) WHERE NOT matured AND NOT disputed;

-- ===== Node credits (withdrawable later) =====
CREATE TABLE IF NOT EXISTS node_credit_accounts (
  user_id         UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  pending_musd    BIGINT NOT NULL DEFAULT 0 CHECK (pending_musd   BETWEEN 0 AND 1000000000000000),
  available_musd  BIGINT NOT NULL DEFAULT 0 CHECK (available_musd BETWEEN 0 AND 1000000000000000),
  frozen          BOOLEAN NOT NULL DEFAULT false,
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS node_credit_transactions (
  id              BIGSERIAL PRIMARY KEY,
  user_id         UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  type            TEXT NOT NULL CHECK (type IN ('earn','mature','clawback','convert_to_wallet','withdraw','withdraw_reversal')),
  amount_musd     BIGINT NOT NULL CHECK (amount_musd BETWEEN 1 AND 1000000000000000),
  relay_charge_id UUID REFERENCES relay_charges(id),
  external_ref    TEXT CHECK (external_ref IS NULL OR length(external_ref) <= 128),
  created_by      UUID REFERENCES users(id),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_nct_user ON node_credit_transactions(user_id, created_at);

-- ===== Coordinator policy (published at /v1/policy) =====
CREATE TABLE IF NOT EXISTS network_policy (
  version      SERIAL PRIMARY KEY,
  body         JSONB NOT NULL CHECK (pg_column_size(body) <= 262144),
  body_sha256  TEXT NOT NULL CHECK (length(body_sha256) = 64),
  created_by   UUID REFERENCES users(id),
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ===== Metadata-only abuse log (control 9): no payload/path/query columns by design =====
CREATE TABLE IF NOT EXISTS relay_abuse_log (
  id                BIGSERIAL PRIMARY KEY,
  ts                TIMESTAMPTZ NOT NULL DEFAULT now(),
  session_id        UUID NOT NULL,
  requester_user_id UUID NOT NULL,
  node_id           UUID NOT NULL,
  dest_host         TEXT NOT NULL CHECK (length(dest_host) BETWEEN 1 AND 253),
  dest_port         INTEGER NOT NULL CHECK (dest_port BETWEEN 1 AND 65535),
  bytes             BIGINT NOT NULL CHECK (bytes BETWEEN 0 AND 1099511627776)
);
CREATE INDEX IF NOT EXISTS idx_ral_node_ts ON relay_abuse_log(node_id, ts);
CREATE INDEX IF NOT EXISTS idx_ral_ts ON relay_abuse_log(ts);

-- ===== MPP idempotency (x402 keeps x402_transactions) =====
ALTER TABLE x402_transactions ADD COLUMN IF NOT EXISTS facilitator TEXT;
DO $$ BEGIN
  ALTER TABLE x402_transactions ADD CONSTRAINT x402_facilitator_chk
    CHECK (facilitator IS NULL OR facilitator IN ('coinbase','payai','selfhosted'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
CREATE TABLE IF NOT EXISTS mpp_transactions (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  payment_hash TEXT NOT NULL UNIQUE CHECK (length(payment_hash) = 64),
  user_id      UUID REFERENCES users(id),
  amount_musd  BIGINT NOT NULL CHECK (amount_musd BETWEEN 1 AND 10000000000),
  status       TEXT NOT NULL CHECK (status IN ('claimed','verified','settled','failed','released')),
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ===== Existing-table changes =====
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS node_id UUID REFERENCES nodes(id);
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS dest_port INTEGER CHECK (dest_port IS NULL OR dest_port BETWEEN 1 AND 65535);
ALTER TABLE usage_records DROP CONSTRAINT IF EXISTS usage_records_proxy_type_check;
DO $$ BEGIN
  ALTER TABLE usage_records ADD CONSTRAINT usage_records_proxy_type_check
    CHECK (proxy_type IN ('dc','residential','relay'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
-- sessions.provider: if constrained, extend to include 'relay' using the same DO-block pattern.
-- payment_invoices.provider: extend CHECK to include 'tempo'.
```

**Rules.**
- `api_keys` is not used for node keys. `nodes.node_key_hash` keeps node credentials out of the user-auth lookup path, so a `dn_node_` key can never authenticate the REST API.
- GDPR delete (`admin.ts` delete flow): add `nodes`, `node_challenges`, `node_credit_*` and `relay_charges` (anonymize `requester_user_id` and `node_owner_user_id` through a tombstone user, because the ledger must remain) inside the existing single transaction. `relay_abuse_log` is retained by retention policy, holds UUIDs only, and is purged by job.

## 6. Money flow

### 6.1 Units
- All new money is integer µUSD in TypeScript `bigint`; floats are never used.
- `1 cent = 10_000 µUSD`.
- Legacy `wallets.balance_cents` stays the requester's spend balance, in cents.

### 6.2 Charge math (`packages/metering/src/relay.ts`, pure)
```ts
export function computeRelayCharge(bytes: bigint, pricePerGbMusd: bigint, nodeShareBps: number) {
  const gross = (bytes * pricePerGbMusd + 999_999_999n) / 1_000_000_000n;   // ceil, GB = 1e9 bytes
  const node  = (gross * BigInt(nodeShareBps)) / 10_000n;                    // floor
  return { grossMusd: gross, nodeMusd: node, platformMusd: gross - node };   // residue -> platform
}
export const walletDebitCents = (grossMusd: bigint) => (grossMusd + 9_999n) / 10_000n; // ceil to cents
```

The requester's wallet is debited `walletDebitCents(gross)` whole cents. The difference `debitCents*10000 − gross` (less than 1 cent per session) is booked to the platform. The `relay_charges` row stores `gross_musd = debitCents*10000` for wallet rails, so the invariant `node+platform=gross` holds exactly and reconciles against `wallet_transactions`. The node share is computed on the un-rounded µUSD gross, so nodes are never short-changed by rounding.

### 6.3 `settleRelayCharge` (`shared/src/repositories/relay-charge-repo.ts`)
This reuses the existing `walletRepo.settleSession` logic, refactored to accept a `PoolClient` (`settleSessionTx(client, …)`), and does the same for `teamRepo.settleTeamSession`. Everything runs in **one** `BEGIN … COMMIT`:
1. `SELECT 1 FROM relay_charges WHERE session_id=$1` returns early if a row exists (idempotency). The UNIQUE constraint backs this up.
2. Requester settle: `settleSessionTx` (wallet or team) releases the reservation and debits actual cents. x402 and MPP rails were prepaid and are only recorded.
3. Load `nodes.owner_user_id, owner_wallet, status` `FOR SHARE`, and re-check self-dealing (owner, wallet or team equal to the requester). On a match: `node=0`, `platform=gross`, `zero_reason`.
4. Use the split config id and bps **locked at `startSession`**, not the current values, so a mid-session admin change does not reprice.
5. `INSERT relay_charges (...)` with an explicit column list, `RETURNING id`.
6. If `node_musd > 0`: `INSERT … ON CONFLICT (user_id) DO UPDATE SET pending_musd = pending_musd + $n`, plus a `node_credit_transactions('earn')`.
7. `INSERT relay_abuse_log` with metadata only.
8. `usageRepo.endSessionTx` plus the usage record with `proxy_type='relay'`.

`endSession` in `session-manager.ts` calls this in place of the separate `recordUsage` + `settleSession` + `usageRepo.endSession`.

### 6.4 Jobs (`packages/proxy-gateway/src/jobs/`)
- **Maturity** (hourly): `SELECT … FROM relay_charges WHERE NOT matured AND NOT disputed AND matures_at <= now() FOR UPDATE SKIP LOCKED LIMIT 1000`. For each row, move `pending → available` (skipped if the account is `frozen`) and write a `mature` transaction.
- **Clawback** (admin): debit pending first, then available, flooring both at 0, with `clawback` transactions.
- **Convert** (`POST /v1/credits/convert`, needs a fresh wallet signature): move available µUSD to `wallets` via `creditWallet` in whole cents. The sub-cent remainder stays in credits.
- **Withdraw**: the endpoint exists and returns `501` in v1. The ledger already supports it.
- **Abuse-log retention:** delete in batches of 1000 where `ts < now() - policy.logRetentionDays`.

## 7. Payment adapters (`packages/billing/src/adapters/`)

```ts
// types.ts
export interface PaymentRequirement { amountMusd: bigint; resource: string; payTo: string; network: string; asset: string; expiresAt: number; }
export interface VerifyResult { ok: boolean; payer?: string; paymentHash: string; amountMusd?: bigint; reason?: string; }
export interface SettleResult { ok: boolean; txRef?: string; reason?: string; }

export interface X402Facilitator {                 // pluggable under the x402 rail
  readonly id: 'coinbase' | 'payai' | 'selfhosted';
  verify(payload: string, req: PaymentRequirement): Promise<VerifyResult>;
  settle(payload: string, req: PaymentRequirement): Promise<SettleResult>;   // response passes validateSettleResponse
}
export interface PerRequestRail {                  // used by gateway 402 path
  readonly id: 'x402' | 'mpp';
  requirements(r: { amountMusd: bigint; resource: string }): unknown;        // one accepts[] entry
  parseHeader(h: IncomingHttpHeaders): string | null;                        // size-capped, stripDangerousKeys
  verify(p: string, req: PaymentRequirement): Promise<VerifyResult>;
  settle(p: string, req: PaymentRequirement): Promise<SettleResult>;
}
export interface PrepaidRail {                     // top-up rails
  readonly id: 'nowpayments' | 'tempo' | 'stripe' | 'paypal';
  createCharge(userId: string, amountCents: number): Promise<{ chargeId: string; instructions: unknown }>;
  handleCallback(rawBody: Buffer, headers: IncomingHttpHeaders): Promise<{ chargeId: string; status: 'paid'|'failed'|'pending'; amountCents: number } | null>;
}
```

| File | Content |
|---|---|
| `facilitators/coinbase.ts`, `facilitators/payai.ts` | Lifted verbatim from the inline branches of `verifyX402Payment` (L395) and `settleX402Payment` (L619). |
| `facilitators/selfhosted.ts` | Stub: `ok:false, reason:'NOT_CONFIGURED'`. |
| `facilitators/index.ts` | `getFacilitator(id)`. URLs come from a hardcoded allowlist, and `X402_FACILITATOR` env overrides `detectFacilitator`. |
| `x402.ts` | Keeps `claimPaymentHash`, `releasePaymentHash`, `validateSettleResponse` and `updateX402Transaction`, and delegates the network call. `buildX402Requirements(poolType)` becomes `buildX402Requirements({amountMusd})`. |
| `rails/x402-rail.ts`, `rails/mpp-rail.ts` | `PerRequestRail`. MPP uses claim-hash idempotency on `mpp_transactions`. Exact Tempo wire format is confirmed against the Tempo docs in its commit, behind the interface. |
| `rails/nowpayments.ts` | Wraps `createCryptoInvoice` and `handleIpnCallback`. The 16 KB body limit is kept, and crediting goes through `atomicCompleteInvoiceAndCredit`. |
| `rails/tempo.ts` | Prepaid MPP top-up: provider `'tempo'`, signature-verified callback, `atomicCompleteInvoiceAndCredit`. |
| Stripe and PayPal | Unchanged. Mounted only on human/admin routes, and removed from MCP and SDK agent surfaces. |

**Gateway.**
- `x402-handler.ts` drops `poolType`. A 402 lists `accepts[]` from every enabled `PerRequestRail` (env `PAYMENT_RAILS`, checked against an allowlist).
- The price per request is `price_per_gb_musd × X402_BYTES_PER_REQUEST`, which defaults to 10 MB, and the paid amount caps the session bytes.
- On settle, `settleRelayCharge` runs with `payment_rail='x402'|'mpp'` and `gross` set to the paid µUSD; unused bytes are not refunded in v1.

## 8. Gateway integration points

| File | Change |
|---|---|
| `proxy-gateway/src/server.ts` L6, L282, L598, L918, L1138–1143 | `ProviderSelector` becomes `NodeSelector`. The upstream dial becomes `liveNode.tunnel.openStream(host, port): Promise<Duplex>`, piped where the upstream socket is piped today, through `ByteCounter`. HTTP non-CONNECT: when `allowhttp-1` is present, the gateway rewrites to origin-form and writes it to a port-80 stream; otherwise it returns 400 `PLAINTEXT_DISABLED`. The lazy pool-manager import is removed. The `allowedProxyTypes` gating at L275/L590 is removed. |
| `proxy-gateway/src/socks5.ts` L93, L387, L709–719 | Same swap. |
| `proxy-gateway/src/auth.ts` `ProxyOptions`, `socks5.ts parseProxyOptions` | Keep `country-XX` and `session-<id>`. Add `class-residential\|dc\|mobile` and `allowhttp-1`. `dc-`/`residential-` are deprecated aliases mapped to `ipClass` for one release. `node-<id>` pins are allowed for admin principals only. |
| `proxy-gateway/src/main.ts` L5, L58, L71–95 | Remove `validateConfig`, `createProviderSelector`, `getBandwidthUsage` and the monitor. Start the tunnel server, policy snapshot loader (30 s) and jobs. Call `connectWithRetry`. |
| `proxy-gateway/src/target-validator.ts` | Re-exports from `shared/src/net-guard.ts`. `validateTarget` stays as the gateway pre-check. The stale L267 comment is fixed: the gateway resolves for the check and the node re-resolves for the dial. |
| new `proxy-gateway/src/policy-enforcer.ts` | Runs after auth and before `select`: ports, category denylist (exact-or-suffix domain list in v1), OFAC destination (`geo-check.ts`), and per-requester req/s and spend caps from policy. |
| `proxy-gateway/src/session-manager.ts` L230 | `startSession(…, nodeId, ipClass)`. The price comes from `network_pricing` and the split from `revenue_split_config`, both locked on the session object. `createSession(userId, 'relay', nodeId)` replaces `"webshare"` at L362. Reserve: `reserveCents = min(balance, ceil(price × byteCap))`, reusing the L420 byte cap and `registerSessionDestroy`. |
| `session-manager.ts` L461–486 | `endSession` calls `settleRelayCharge` (§6.3). |
| `proxy-gateway/src/retry.ts` | Retries on a new node for `DIAL_FAIL`/`DNS_FAIL` only. |
| `balance-check.ts`, `wallet-policy.ts` | Unchanged. |
| `proxy-gateway/src/node-tunnel/{server,mux,registry,selector}.ts` | New (§2, §4). |

## 9. Policy (`/v1/policy`)

**Body schema** (zod-style, validated in `shared/src/policy.ts`):
```json
{ "ports": [80, 443], "categoriesVersion": 3, "denyDomains": ["example-bank.com"],
  "nodeDefaults": {"maxStreams": 32, "maxGbDay": 5},
  "requesterLimits": {"reqPerSec": 20, "dailySpendMusd": 50000000},
  "sanctionedCountries": ["CU","IR","KP","RU","SY"],
  "attestation": {"minVersion": 1, "text": "..."},
  "plaintextHttp": "opt-in", "logRetentionDays": 90,
  "nodeCapsPerPrefix": {"per32": 2, "per24": 8, "perAsn": 500} }
```

**Enforcement and publishing.**
- The validator rejects unknown keys and any floor key (`floor*`, `hardDenyPorts`, `privateRanges`, `ssrf*`). `sanctionedCountries` may only **add** to the code constant, because the OFAC master switch is compiled in.
- `GET /v1/policy` (no auth) returns `{version, sha256, body, floorGuarantees}`. `floorGuarantees` is static text. The response is cached for 30 s, with the ETag set to `sha256`.
- An admin PUT inserts a new version and broadcasts `POLICY_UPDATE`. Raising `attestation.minVersion` sends DRAIN to older nodes and sets them to `pending` until they re-attest.

## 10. API endpoints

**Public**
- `GET /v1/policy`
- `GET /v1/pricing`: per-class price, node share bps and enabled rails.
- `GET /v1/network/stats`: aggregate online nodes by country and class.
- `GET /v1/probe/echo`: IP-allowlisted to the gateway (post-MVP).

**Agent** (wallet-JWT or `dn_live_`, `requireAgentPrincipal`)

| Route | Notes |
|---|---|
| `POST /v1/nodes/challenge` | Returns `{nonce, attestationText, attestationVersion, powChallenge}`. |
| `POST /v1/nodes` | `{walletSignature, nodePubkey, pow}`. Verifies the EIP-191 signature recovers to the user's wallet, consumes the challenge with `DELETE…RETURNING`, enforces a cap of 5 per owner, and returns `{nodeId, nodeKey}` once. |
| `GET /v1/nodes`, `PATCH /v1/nodes/:id`, `DELETE /v1/nodes/:id` | PATCH can only lower caps. DELETE revokes and sends DRAIN. |
| `GET /v1/credits`, `GET /v1/credits/transactions?cursor=` | |
| `POST /v1/credits/convert` | Needs a fresh signature. |
| `POST /v1/credits/withdraw` | Implemented per §15 (gated by `PAYOUTS_ENABLED`). Shapes for all agent routes: `AGENT_API.md`. |
| `POST /v1/sessions/:id/report` | Burn signal, rate-limited. |
| `POST /api/wallet/topup/crypto` (existing), `POST /v1/topup/mpp`, `POST /api/webhooks/tempo` | |
| `GET /api/x402/info` | Single relay price plus the facilitator list. |

**`requireAgentPrincipal` middleware** (`dashboard/src/middleware/agent.ts`):
- Accepts wallet-identity users (`isWalletEmail`) and API keys.
- Treats wallet users as verified by signature, so the `email_verified` gate is skipped **only for them**.
- Never calls reCAPTCHA or MFA.
- Rejects `dn_node_` keys.

Human `/api/auth/register|login|verify-email|forgot-password` (with MFA) stay for admin panel login only, behind `ADMIN_HUMAN_LOGIN=true`.

**Admin** (`/api/admin`, existing admin gate; writes re-check the role `FOR UPDATE`)
- `GET/POST /network/split`: append-only, and `effective_from` must be ≥ now.
- `GET/PUT /network/pricing`.
- `GET/PUT /network/policy`.
- `GET /network/revenue?from&to&groupBy=day|node|rail|class`: sums of gross, node and platform µUSD and bytes from `relay_charges`.
- `GET /network/nodes`, `POST /network/nodes/:id/{suspend,quarantine,restore,revoke}`. These RST the live tunnel through the registry.
- `POST /network/credits/:userId/{freeze,unfreeze,clawback}`.
- `POST /network/charges/:id/{dispute,resolve}`.
- `GET /network/abuse-log?nodeId&from&to`: window ≤ 31 days, and each access is audited.

## 11. Abuse-control placement (ABUSE_CONTROLS.md)

| # | Control | Where | Toggleable |
|---|---|---|---|
| 1 | Attestation | `POST /v1/nodes` plus a version check at tunnel auth | Text and min version via policy |
| 2 | Ports | Gateway `policy-enforcer`, then node `floor.ts` (80/443 ∩ policy ∩ local, hard deny) | Gateway list: yes. Floor: **no** |
| 3 | Category denylist | Gateway `policy-enforcer`; optional node-local list | Yes |
| 4 | SSRF / private ranges | Gateway `validateTarget` plus the node's own DNS check, dial of the checked IP and post-connect re-check (shared `net-guard`) | **No** |
| 5 | OFAC | Tunnel auth (peer-IP geo), selection filter, destination geo | The list can only grow. The master switch is a constant |
| 6 | Per-node caps | Registry counters plus node `limits.ts` | Defaults via policy; operator can only lower |
| 7 | Per-requester limits | `checkSessionRateLimit`, velocity checks, `wallet-policy.ts`, policy spend caps | Yes |
| 8 | Reputation and burn | Registry counters → `node_reputation` → score and cooldown | Thresholds |
| 9 | Metadata log | Inside the `settleRelayCharge` transaction → `relay_abuse_log` | Retention only. The payload-free guarantee is structural |

## 12. Migration and removal

1. Additive schema. Old `sessions.provider='webshare'` rows remain for history.
2. Dev and staging only: `UPSTREAM_MODE=webshare|relay` exists for exactly the window of commits 13–17. Production deploys only after commit 18, with `relay` hard-coded and pool-manager not in the dependency graph.
3. Supply on day 1: the operator runs at least N seeded nodes, each registered under a platform user with `node_share_bps` effectively retained. The rollout gate is "≥ 20 healthy nodes in staging for 72 h".
4. Delete `packages/pool-manager`, `WEBSHARE_*` (`.env.example`, compose, infra), the tsconfig refs and the workspace entry.
5. Deprecate `PRICE_PER_GB_CENTS*` and `COST_PER_GB_CENTS_RESIDENTIAL` in `types.ts`, then remove them.
6. Plans stay for free tier and limits only. The free tier is booked as `payment_rail='free'` with `node_musd=0`, so nodes do not earn on free traffic.
7. Existing wallets are reused as is, so no balance migration is needed.
8. Rules: add `dn_node_` to the scrub regexes and `security.md`. Add µUSD and relay-charge rules to `database.md`. Update the tool counts in `CLAUDE.md` and `integration-patterns.md`.

## 13. Ordered implementation plan

Each commit must pass `npm run build && npx vitest run && npm run lint`. **MVP = commits 1–18.**

| # | Commit | Files |
|---|---|---|
| 1 | shared: extract net-guard from target-validator (pure move) | `shared/src/net-guard.ts` (new), `shared/src/index.ts`, `proxy-gateway/src/target-validator.ts`, tests re-pointed |
| 2 | shared: tunnel frame codec + fuzz tests | `shared/src/tunnel/frame.ts`, `shared/src/tunnel/frame.test.ts` |
| 3 | schema: nodes, node_challenges, node_daily_stats, node_reputation, network_policy, network_pricing, revenue_split_config | `shared/src/schema.sql`, `shared/src/schema.test.ts` |
| 4 | schema: relay_charges, node_credit_*, relay_abuse_log, mpp_transactions, sessions.node_id, proxy_type 'relay' | `shared/src/schema.sql` |
| 5 | metering: computeRelayCharge (BigInt) + property tests | `metering/src/relay.ts`, `metering/src/index.ts`, tests |
| 6 | shared: policy schema validator (rejects floor keys) + policy-repo | `shared/src/policy.ts`, `shared/src/repositories/policy-repo.ts` |
| 7 | shared: node-repo (challenge, register with caps in a transaction, auth lookup, status) | `shared/src/repositories/node-repo.ts` |
| 8 | shared: settleSessionTx/settleTeamSessionTx refactor (client-accepting, behaviour-preserving) | `wallet-repo.ts`, `team-repo.ts`, `usage-repo.ts` |
| 9 | shared: relay-charge-repo settleRelayCharge + node-credit-repo (earn/mature/clawback/convert) | `repositories/relay-charge-repo.ts`, `repositories/node-credit-repo.ts` |
| 10 | shared: dn_node_ credential scrubbing | scrub util in `shared/src`, `.claude/rules/security.md` |
| 11 | dashboard: /v1 router; GET /v1/policy, /v1/pricing; admin policy/pricing/split CRUD | `dashboard/src/routes/v1/public.ts`, `routes/admin-network.ts`, `server.ts` |
| 12 | dashboard: requireAgentPrincipal + /v1/nodes registration (EIP-191, PoW, challenge consume) | `middleware/agent.ts`, `routes/v1/nodes.ts` |
| 13 | node-agent: scaffold, floor (no config) + tests, dialer with post-connect re-check, limits, config | `packages/node-agent/*`, root `tsconfig.json`, `package.json` workspaces |
| 14 | node-agent: register CLI + tunnel client (reconnect, mux, POLICY_UPDATE intersection) | `node-agent/src/{register,tunnel-client}.ts` |
| 15 | proxy-gateway: node-tunnel server (WS upgrade, dn_node_ auth, CHALLENGE, heartbeat) + registry | `proxy-gateway/src/node-tunnel/{server,mux,registry}.ts` |
| 16 | proxy-gateway: NodeSelector (filters incl. self-dealing, score, top-K, sticky) | `node-tunnel/selector.ts` |
| 17 | proxy-gateway: policy-enforcer; route HTTP/CONNECT/SOCKS5 via NodeSelector (UPSTREAM_MODE dev switch); plaintext opt-in; username flags | `server.ts`, `socks5.ts`, `auth.ts`, `policy-enforcer.ts`, `retry.ts`, `main.ts` |
| 18 | proxy-gateway: session-manager relay price/split lock, createSession('relay',nodeId), endSession → settleRelayCharge; remove pool-manager usage and Webshare monitor | `session-manager.ts`, `main.ts`, `server.ts` L1143, `socks5.ts` L719 |
| 19 | remove packages/pool-manager and WEBSHARE_* config | `packages/pool-manager/` (delete), `.env.example`, `infra/`, `docker-compose*.yml`, tsconfig |
| 20 | tunnel: SPKI pinning, coordinator-signed CHALLENGE, ed25519 AUTH with TLS-exporter binding | `node-tunnel/server.ts`, `node-agent/src/tunnel-client.ts`, `shared/src/tunnel/auth.ts` |
| 21 | proxy-gateway: byte-dispute check, reputation/burn counters, flush job, report endpoint | `node-tunnel/registry.ts`, `jobs/reputation.ts`, `dashboard/routes/v1/sessions.ts` |
| 22 | jobs: credit maturity, abuse-log retention | `proxy-gateway/src/jobs/{maturity,retention}.ts` |
| 23 | billing: X402Facilitator adapters (coinbase/payai/selfhosted), no behaviour change | `billing/src/adapters/**`, `billing/src/x402.ts` |
| 24 | billing+gateway: PerRequestRail; relay x402 price; x402 settle writes relay_charges | `billing/src/adapters/rails/x402-rail.ts`, `proxy-gateway/src/x402-handler.ts` |
| 25 | billing: PrepaidRail; wrap NOWPayments; Tempo top-up + MPP rail + webhook | `rails/{nowpayments,tempo,mpp-rail}.ts`, `dashboard/routes/webhooks.ts`, `routes/wallet.ts`, schema provider CHECK |
| 26 | coordinator: canary probes + /v1/probe/echo + ip_class classification | `jobs/probes.ts`, `dashboard/routes/v1/probe.ts` |
| 27 | dashboard: admin network routes (revenue, nodes, credits, disputes, abuse-log); gate human auth behind ADMIN_HUMAN_LOGIN; GDPR additions | `routes/admin-network.ts`, `routes/auth.ts`, `routes/admin.ts` |
| 28 | frontend: admin Revenue Split / Nodes / Policy / Abuse Log tabs; unroute human pages; drop recaptcha.d.ts | `frontend/src/pages/AdminPage.tsx`, `pages/admin/*`, router |
| 29 | mcp-server: node/policy/pricing/credits tools; relay-only proxy/fetch/plans; drop stripe/paypal | `mcp-server/src/tools/*`, `proxy-fetch.ts` |
| 30 | sdks/node + sdks/go: Nodes/Credits/Policy/Pricing; ipClass proxy URL | `sdks/node/src/*`, `sdks/go/*` |
| 31 | sdks/python, rust, java, cpp: parity (one commit each) | `sdks/*` |
| 32 | integrations: ipClass, plaintext refusal, tool counts | `integrations/*` |
| 33 | collusion detector + credit freeze | `jobs/collusion.ts` |
| 34 | docs: CLAUDE.md, ARCHITECTURE.md, rules (µUSD, dn_node_, tool counts) | docs and rules |

## 14. Verification

**Unit tests that lock the invariants:**
- `node+platform=gross` holds, with rounding residue going to the platform.
- Settle is idempotent per session.
- A self-dealing settle gives `node=0`.
- The floor rejects `127/8`, `10/8`, `169.254.169.254`, `::ffff:127.0.0.1`, `::127.0.0.1`, Teredo/6to4-embedded private addresses, port 25 and `localhost.` even under a hostile policy, and no config path disables it.
- The abuse log has no path or query.
- The policy validator rejects floor keys.

**End to end after commit 18:**
1. Run `docker compose up -d`, `npm run db:migrate`, `start:api`, `start:proxy`.
2. Run `node packages/node-agent/dist/src/main.js register`, then `run`.
3. `curl -x http://country-US:dn_live_KEY@localhost:8080 https://httpbin.org/ip` should return the node's egress IP. Repeat through `socks5h://…@localhost:1080`.
4. `curl -x … http://httpbin.org/ip` should return 400 `PLAINTEXT_DISABLED`. With the `allowhttp-1` username flag it should return 200.
5. `curl -x … http://169.254.169.254/` should return 403 at the gateway. A test-only gateway bypass with a pinned node should get `OPEN_ERR FLOOR_BLOCKED`.
6. `SELECT gross_musd,node_musd,platform_musd,payment_rail FROM relay_charges ORDER BY created_at DESC LIMIT 1;` should show the invariant holding and a matching `node_credit_transactions('earn')` row.

## 15. Revision 1 — economics, tiers, payouts, policy (supersedes earlier sections where they conflict)

Source research and citations: `ECONOMICS.md`.

- **Pricing (§5):** `network_pricing` seeds `residential` = 500000 µUSD ($0.50/GB) and `dc` = 200000 µUSD ($0.20/GB). No minimum purchase. Admin-editable.
- **Tiers (replaces the 7000 bps split seed):** new `node_tiers` table, per beneficial owner, recalculated daily, promote one step at a time, demote immediately on quality failure (3-day grace for uptime misses).

  | Tier | Node share | Paid-tenure days | 30d uptime | Active IPs | Reputation | Hold |
  |---|---|---|---|---|---|---|
  | Probation | 25% | 0 | — | ≥1 | ≥0.30 | 14 d |
  | Bronze | 30% | ≥7 | ≥80% | ≥1 | ≥0.50 | 7 d |
  | Silver | 35% | ≥30 | ≥90% | ≥3 | ≥0.60 | 7 d |
  | Gold | 40% | ≥60 | ≥93% | ≥10 | ≥0.70 | 5 d |
  | Platinum | 45% | ≥90 | ≥95% | ≥25 | ≥0.80 | 3 d |
  | Partner | 50% | ≥180 | ≥97% | ≥50 | ≥0.85, no clawback in 90 d | 3 d |

  Hard ceiling: `CHECK (node_share_bps BETWEEN 0 AND 5000)`. Thresholds are admin-editable rows.
  - Tenure days and active IPs count only matured, undisputed paid traffic from other principals.
  - An active IP is a distinct /32 with at least 3 distinct paying requesters in 7 days.
  - Tier inputs are aggregated per beneficial owner, linked by payout wallet, funding source or team.
  - `relay_charges` snapshots both `tier_id` and `node_share_bps` at session start.
  - `GET /v1/node/tier` returns the current tier, progress to the next tier and any demotion reason.
- **Per-owner node cap (§4):** the flat cap of 5 is removed. Node caps scale by tier: Probation 10, Bronze 25, Silver 100, Gold 500, Platinum and Partner 2000. The per-/32, /24 and ASN sybil caps stay as they are.
- **Payouts (replaces the §6.4 501):** off-chain earnings ledger, then a USDC push on Base.
  - Daily automatic push once available credit is at least $1. The platform pays gas, and payouts are batched.
  - `POST /v1/credits/withdraw` lets an agent withdraw on demand. Minimum $1, fresh wallet signature, idempotency key.
  - Optional `auto_convert_pct` turns credit into requester balance.
  - Payout wallets are OFAC-screened at registration and again before each payout.
  - Changing the payout wallet needs a signature from the old wallet and a 72 h cooldown.
  - Daily withdrawal limit per tier: $50 (Probation) up to $5,000 (Partner).
  - Tax: request a W-9/W-8 at $1,500 cumulative per year, and hold payouts above $2,000 until it is received.
  - New tables: `payout_wallets`, `node_payouts`.
  - Credits are never transferable between users, and buyers' prepaid balances are never withdrawable.
- **Plaintext HTTP (§1 T2):** this is policy-driven rather than fixed.
  - `policy.plaintext` is one of `deny`, `opt_in` or `allow`. The default is `opt_in`.
  - Opting in is a single `allowhttp-1` username flag, with no extra round-trip.
  - The response carries `X-DominusNode-Exit-Visible: 1` so agents know the exit can read the traffic.
  - All other abuse controls follow ABUSE_CONTROLS.md: coordinator rules are admin-editable, and the node floor is fixed.
- **Rollout gate (§12.3):** there are two stages.
  - Smoke gate: at least 3 healthy nodes for 2 h in staging, plus one full earn → mature → withdraw cycle with `maturation_hours=0` and a $0.10 minimum on Base Sepolia.
  - Production soak gate: at least 20 nodes for 72 h.
- **Plan (§13) additions:**
  - 9b: `node_tiers`, `payout_wallets`, `node_payouts` schema and repositories.
  - 22b: tier job and payout job.
  - 27b: admin Tiers and Payouts tabs.
  - Payouts stay disabled until counsel signs off on the open items in ECONOMICS.md §4.
