# Security Architecture and Post-Quantum Plan

Status: plan, November 2026. Audience: the owner and core maintainers. Scope: every cryptographic surface in this repo plus the non-crypto hardening that decides most real incidents.

Ground rule for this document: no "quantum-proof" claims. The target is **"hybrid post-quantum key exchange on every channel we control, hybrid PQ signatures on every trust anchor we control, and classical-only where an external dependency (blockchains, payment providers, browsers' CAs) gives us no choice, stated plainly."**

Facts marked *(verify)* were current as of writing and must be rechecked against the live stack before implementation (`node -p process.versions.openssl`, `openssl list -kem-algorithms`, Caddy/Go release notes).

---

## 1. Standards baseline

| Item | What it is | Relevance |
|---|---|---|
| FIPS 203 (Aug 2024) | ML-KEM (Kyber). ML-KEM-768 ≈ category 3 | Key exchange (TLS hybrid) |
| FIPS 204 (Aug 2024) | ML-DSA (Dilithium). ML-DSA-65 ≈ category 3; pk 1952 B, sig 3309 B | Coordinator / federation / release signatures |
| FIPS 205 (Aug 2024) | SLH-DSA (SPHINCS+), hash-based, stateless; large sigs (≈7.8–49 KB), slow signing | Long-lived root / offline key where conservative assumptions matter |
| SP 800-208 | Stateful hash sigs (LMS/XMSS) | Possible for firmware-style release roots; state management makes it a poor fit here |
| NIST IR 8547 (ipd Nov 2024) | Transition: 112-bit classical (RSA-2048, P-256, Ed25519 class) deprecated after 2030, disallowed after 2035 | Our hard outer deadline; we aim far earlier |
| CNSA 2.0 (NSA) | ML-KEM-1024, ML-DSA-87, LMS/XMSS for firmware; prefer/exclusive PQ by 2030–2033 | Reference ceiling. We do not need NSS compliance; we use category 3 hybrids, with -1024/-87 as an option for the root key |
| `X25519MLKEM768` (IANA TLS group 0x11EC, draft-ietf-tls-ecdhe-mlkem) | Hybrid TLS 1.3 key share | Default in Chrome/Firefox, Cloudflare, Go ≥1.24 `crypto/tls`, OpenSSL ≥3.5 default keyshares, BoringSSL, rustls ≥0.23.x *(verify exact versions)* |
| IETF LAMPS composite ML-DSA (draft-ietf-lamps-pq-composite-sigs) | Single OID combining ML-DSA + classical | Useful for X.509; we do not need X.509 for our own protocols, so we use **explicit dual signatures** instead |
| HNDL (harvest-now-decrypt-later) | Record ciphertext today, decrypt with a CRQC later | Applies to **confidentiality** (KEX) now. Signatures are only forgeable once a CRQC exists, so PQ signatures are about **long-lived trust anchors** and migration lead time, not past traffic |

Key consequence: **KEX first, signatures second, hashes/symmetric last** (SHA-256, HMAC-SHA256, AES-256-GCM, ChaCha20-Poly1305 are fine; Grover gives at most a square-root speedup that is impractical at these sizes).

Runtime facts in this repo:
- Containers: `node:22-alpine` (`infra/docker/proxy.Dockerfile`, `packages/node-agent/Dockerfile`). The dev box runs Node v22.23.4 with OpenSSL 3.5.9, so **X25519MLKEM768 is available to Node `tls` today**, but **`crypto.generateKeyPair('ml-dsa-65')` is not exposed in Node 22** (tested: "must be a supported key type"). ML-DSA in `node:crypto` arrived in the Node 24 line *(verify the minor)*. Alpine's OpenSSL vs Node's bundled OpenSSL must be checked inside the image.
- Caddy is built on Go; Go ≥1.24 enables X25519MLKEM768 by default, so a current Caddy (2.10+) already negotiates hybrid with modern clients *(verify with a capture)*.

---

## 2. Surface-by-surface plan

Effort: S ≤ 1 day, M 2–5 days, L 1–3 weeks.

### 2.1 Public TLS (site, API, admin) via Caddy
- **Current:** `infra/caddy/Caddyfile`, HSTS preload, CSP, `reverse_proxy api:3000`. Certificates: ACME (ECDSA/RSA WebPKI).
- **Threat:** HNDL on agent API traffic (API keys in headers, wallet data). WebPKI certs are classical, but cert forgery requires a live CRQC, not a recording.
- **Target:** TLS 1.3 only for `api.` and admin; key-share preference `X25519MLKEM768, X25519`. In Caddy: `tls { protocols tls1.3; curves x25519mlkem768 x25519 }` *(verify directive name in the deployed Caddy version)*. Remove the stale `frame-src https://checkout.stripe.com` from CSP if Stripe is admin-only and not framed.
- **Migration:** non-breaking; clients without ML-KEM fall back to X25519.
- **Verify:** `openssl s_client -groups X25519MLKEM768 -connect api…:443 -tls1_3` shows `Negotiated TLS1.3 group: X25519MLKEM768`; Chrome DevTools Security panel; SSL Labs grade. **Effort S.**
- **Note:** if Cloudflare fronts the site, the browser↔CF leg is hybrid by default, and the CF↔origin leg needs origin support (Caddy) as well; check that CF's origin pulls offer the hybrid group *(verify)*.

### 2.2 Relay gateway front end (HTTP :8080, SOCKS5 :1080, TLS variants)
- **Current:** TLS proxy listeners already exist. `packages/proxy-gateway/src/main.ts:153-168` loads `loadProxyTls(process.env)`: `PROXY_TLS_PORT` starts an HTTPS proxy (`server.ts:1212`) and an optional SOCKS5-over-TLS port (`socks5.ts:586`). `PROXY_REQUIRE_TLS=true` (requires `PROXY_TLS_PORT`) plus `createPlaintextAuthGuard` refuse credentials on the plaintext 8080/1080 listeners; in production without it the gateway logs a warning that credentials travel in plaintext. Both TLS servers use `minVersion: "TLSv1.2"` and the default group list (no PQ hybrid pinned). HTTPS through the relay is end-to-end CONNECT TLS between requester and target, which we do not touch (correct: the exit node cannot read it).
- **Threat:** proxy credentials (`dn_live_` in Proxy-Authorization / SOCKS5 user/pass) cross the network to the gateway in **plaintext** on the plaintext listeners whenever a deployment leaves `PROXY_REQUIRE_TLS` off or a client uses 8080/1080. That is a present-day problem, bigger than quantum.
- **Target (narrow; the listeners are built):** (1) in `server.ts:1212` and `socks5.ts:586` raise `minVersion` to `"TLSv1.3"` and set `ecdhCurve: "X25519MLKEM768:X25519"` (S); (2) set `PROXY_REQUIRE_TLS=true` in production so the plaintext auth guard rejects credentials on 8080/1080 (S, config); (3) SDKs/MCP default to the TLS proxy URL (M across 6 SDKs); (4) consider per-key proxy passwords distinct from the API key (scoped "proxy tokens", `dn_proxy_` already reserved in scrubbers) so a leaked proxy credential cannot call `/v1` money routes.
- **Verify:** `curl --proxy https://…:$PROXY_TLS_PORT` works and `openssl s_client -groups X25519MLKEM768` negotiates the hybrid group; with `PROXY_REQUIRE_TLS=true` a credentialed request on 8080/1080 is refused; packet capture shows no `dn_live_` on the wire. **Effort S** for the gateway change, **M** overall with SDK defaults and proxy tokens.

### 2.3 Node tunnel (gateway ↔ node-agent)
- **Current:** `packages/proxy-gateway/src/node-tunnel/server.ts:431` `minVersion: "TLSv1.3"`. Handshake in `packages/shared/src/tunnel/auth-sig.ts`: coordinator Ed25519 CHALLENGE over `"dominode-challenge-v1"‖nonce‖policyVersion‖serverTime‖binding`; node Ed25519 AUTH over `"dominode-tunnel-v1"‖nonce‖nodeId‖exporter`, exporter = RFC 5705 / RFC 9266-style keying material (`EXPORTER-dominode-tunnel-v1`, 32 B). Nodes pin coordinator keys (`packages/node-agent/src/coord-pins.ts`, `coord-pins.generated.ts`, multi-key). Binding falls back to `"none"` behind a TLS-terminating proxy.
- **Threat:** (a) HNDL on tunnel contents: target-bound HTTPS is end-to-end, but `allowhttp-1` plaintext and CONNECT metadata (target hosts, timing, which agent uses which node) are recorded; (b) a CRQC forging the coordinator Ed25519 key could impersonate the coordinator to every node; (c) binding `"none"` deployments lose MITM resistance between edge and gateway.
- **Target:**
  1. TLS: `ecdhCurve: "X25519MLKEM768:X25519"` on both ends (node-agent `ws` client options and the gateway secure context). Node 22 + OpenSSL 3.5 supports it today. **S.**
  2. Make `tls-exporter` binding **mandatory** for production (gateway terminates the tunnel TLS itself, i.e. Caddy uses layer4/TCP passthrough for `tunnel.` or the tunnel host is exposed directly). Today `packages/node-agent/src/tunnel-client.ts:359-371` accepts `"none"` from a correctly signed CHALLENGE (the binding byte is signed, so a network MITM cannot downgrade it; but any production gateway behind a TLS-terminating proxy legitimately sends `"none"`). Rollout order: (a) move every production gateway to direct or passthrough TLS termination and confirm from gateway telemetry that every CHALLENGE carries `tls-exporter`; (b) only then ship a node-agent release that refuses `"none"` unless `ALLOW_UNBOUND_TUNNEL=1`, gated by a signed policy flag (e.g. `requireTunnelBinding`) rather than hard-coded, so it can be switched on after (a) and rolled back without a release. Shipping the refusal first would cut off existing nodes. **M.**
  3. Hybrid CHALLENGE signature: new domain `"dominode-challenge-v2"`, message unchanged plus `u8(sig_suite)`. CHALLENGE carries `{ed25519_sig, mldsa65_sig, key_id}`; node requires **both** to verify against pins (AND, not OR; OR-composition gives you the strength of the weaker one). Pins become `{ed25519_pub, mldsa65_pub}` pairs. **M.**
  4. Node AUTH key: keep Ed25519 for now (node identity forgery needs a CRQC per node; impact bounded to one node's earnings). Add optional ML-DSA node key in registration v2 once Node 24 is the floor. **M, later.**
- **Migration that keeps old nodes working:** gateway sends both v1 and v2 fields during a transition window (v1 nodes ignore unknown fields; confirm parser is tolerant, otherwise version the frame). New node-agent releases ship pins with ML-DSA keys and a `minChallengeVersion` that the policy doc raises only when telemetry shows ≥95% of online nodes on v2; `attestation.minVersion` in the policy already gives a lever to kick stragglers. Pin rotation reuses the existing multi-key pin list.
- **Library:** Node 22 lacks ML-DSA; options: (i) move gateway and node-agent images to Node 24 LTS and use `node:crypto` (preferred, OpenSSL-backed, FIPS 204 final); (ii) `@noble/post-quantum` (pure JS, audited status to verify; acceptable for **verify** on nodes, less ideal for signing keys at rest). Do not hand-roll.
- **Verify:** golden-vector tests for v2 messages; negative tests (ed25519-only valid, mldsa-only valid ⇒ reject); interop test old-node/new-gateway and new-node/old-gateway; capture shows hybrid group.

### 2.4 Federation documents
- **Current:** `packages/shared/src/federation.ts`: envelope `{payload, signatures:[{alg:"ed25519", public_key, sig}]}`, domain-separated `${domain}\n${canonicalJson(payload)}`, `coordinator_keys` list, fingerprint `sha256:` of raw key. Served under `/.well-known/dominusnode/`.
- **Threat:** these are the long-lived trust root of federation; they are exactly what a future CRQC would forge, and documents/pins persist for years.
- **Compatibility constraint (from the code):** `coordinatorKeys()` (`federation.ts:161-168`) returns `null` for the whole document if any `coordinator_keys` entry has `alg !== "ed25519"`, and requires `doc_version === 1`. Adding ML-DSA entries to `coordinator_keys` or bumping `doc_version` would make every deployed verifier reject the document. It does tolerate extra properties on each key object, and `verifySignedDocument` (`:150`) skips signatures with unknown `alg` via `continue`, so extra signatures are safe. Note it also returns ok on the **first** valid ed25519 signature (OR semantics).
- **Target:** keep each `coordinator_keys` entry `alg: "ed25519"` and add the paired PQ key as an extra property (`mldsa65_public_key`, same `fingerprint` binding the pair) or in a new top-level `pq_coordinator_keys` field that old parsers ignore; keep `doc_version: 1` during the transition (or serve v1 and v2 documents side by side). Add `alg: "ml-dsa-65"` entries to `signatures`. New verifiers require one valid signature per alg from the **same** key pair (bind by fingerprint/`key_id` so an attacker cannot mix keys). **AND-verification is enforced by verifier code and pins** (a minimum required-alg set baked into the node-agent/client release), not by a field in the document: a signed `required_algs` field cannot force a verifier that does not read it, and stripping the ML-DSA signature still passes every un-upgraded verifier. A document field can at most announce intent. Canonical JSON must be pinned to RFC 8785 (JCS) semantics if not already; add vectors. Optionally a **root SLH-DSA-SHA2-192s offline key** that signs only the `coordinator_keys` list (rare, slow, conservative assumption: hash functions only).
- **Migration:** (1) ship a verifier release that parses the new field and verifies both algs, still accepting ed25519-only; (2) only then publish documents carrying the PQ keys and signatures; (3) add an interop test where the current (old) verifier reads a new document and still returns ok, plus one where a new verifier rejects a doc with the ML-DSA signature stripped once its required set includes ML-DSA; (4) flip the baked-in required set to `{ed25519, ml-dsa-65}` in a release, and treat the population as cut over only when the same telemetry gate used for `minChallengeVersion` shows the old verifiers gone. **Effort M.**

### 2.5 JWT (`/api` routes, admin)
- **Current:** `packages/shared/src/auth.ts`: HS256 with separate secrets for access, refresh and MFA challenge, ≥32 chars, default-value rejection, `algorithms: ["HS256"]` pinned on verify (good: no `alg` confusion). 15 min access, 7 d refresh, family rotation; `refresh_tokens.token_hash` stored hashed (`schema.sql:318`).
- **Threat:** symmetric HMAC-SHA256 with a ≥256-bit secret is not meaningfully weakened by quantum. Real risks: secret leakage via env/logs, no `kid`/rotation, single secret shared by every API replica.
- **Target:** keep HS256 (or move to HS512, cosmetic). Add `kid` header and a keyring (`JWT_SECRETS=kid1:…,kid2:…`) to rotate without logging everyone out; load secrets from files (`*_FILE`) mounted by systemd credentials or Docker secrets, not env. Add `iss`/`aud` checks. Do **not** move to asymmetric JWT unless a third party must verify tokens (then Ed25519 now, ML-DSA when JOSE registers it). **Effort S–M.**

### 2.6 API keys, node keys, refresh tokens
- **Current:** `dn_live_`/`dn_node_` keys stored as SHA-256 hex (`hashApiKey`), chosen for O(1) proxy lookup.
- **Threat:** keys are high-entropy random, so plain SHA-256 is not crackable offline; preimage resistance is unaffected by quantum in practice (Grover on 256-bit ⇒ 128-bit). The realistic risk is DB exfiltration enabling **lookup confirmation** and correlation, not recovery.
- **Target:** move to `HMAC-SHA256(pepper, key)` with the pepper outside the DB (file/TPM-sealed), keyed by `hash_version` column to migrate lazily on next successful auth (dual lookup during transition: try v2, fall back to v1 and rewrite). Argon2id is **not** appropriate for random 256-bit API keys (adds latency on every proxy request, no security gain); Argon2id (m=64 MiB, t=3, p=1, per RFC 9106 second recommendation) is for **human admin passwords**, replacing bcrypt in `dashboard/src/routes/auth.ts` on next login. Confirm key entropy ≥ 128 bits in the generator. **Effort M.**

### 2.7 Wallet signatures (EIP-191 / secp256k1) and payment rails
- **Current:** wallet-identity principals sign EIP-191 challenges; x402 (`packages/billing/src/adapters/rails/x402-rail.ts`, Coinbase facilitator JWT with Ed25519/ES256 in `facilitators/coinbase.ts`), MPP HMAC (`mpp-rail.ts`), Tempo webhook HMAC (`tempo.ts`), NOWPayments HMAC-SHA512 IPN (`billing/src/nowpayments.ts`).
- **Threat:** secp256k1 falls to Shor. **We cannot fix this**: the chains, USDC contracts and facilitators are classical, and an attacker with a CRQC can steal the funds directly from the chain, which is a larger loss than forging our login challenge.
- **Target:** (1) treat wallet signature login as "as strong as the chain" and say so; (2) bind EIP-191 challenges to domain, chain id, nonce, expiry (EIP-4361/SIWE style) if not already; single-use nonce consumed atomically; (3) **require an API key or a second factor for withdrawals/payout-wallet changes** so wallet compromise alone is not total; (4) payout-wallet change cool-down (e.g. 72 h hold plus notification) already partially implied by maturity holds; make it explicit; (5) webhook HMACs: constant-time compare, timestamp tolerance ≤5 min, raw-body verification (verify each rail does this; `tempo.ts` uses `t.` prefix, good). PQ on-chain settlement is **out of scope** until chains provide it (Ethereum research exists, nothing deployable). **Effort S–M.**

### 2.8 Secrets at rest (coordinator keys, DB, env)
- **Current:** coordinator Ed25519 key file via `npm run gen:coord-key` (`packages/proxy-gateway/src/node-tunnel/coord-key.ts`); JWT/webhook/facilitator secrets in env; PostgreSQL in Docker.
- **Target:**
  - Coordinator signing key: file mode 0400, owned by the gateway user, loaded via systemd `LoadCredentialEncrypted=` (TPM2-sealed with `systemd-creds encrypt --with-key=tpm2`) on the homelab. Generate the **long-term root** (federation `coordinator_keys` signer, SLH-DSA or ML-DSA-87 + Ed25519) on an offline machine; only an **online subkey** with a 90-day validity lives on the gateway. HSM options: YubiHSM 2 or Nitrokey HSM 2 support Ed25519 but **not ML-DSA** today *(verify)*; so the PQ half must be software key sealed by TPM, with the classical half optionally in the HSM.
  - DB: full-disk encryption (LUKS2) on hosts, `scram-sha-256` auth, TLS between API and Postgres if they ever leave one host, least-privilege DB roles (API role cannot `DROP`, read-only role for analytics).
  - Env secrets → `*_FILE` pattern everywhere; add a startup check that refuses to run if a secret is readable by group/other.
- **Effort M.**

### 2.9 Backups
- Encrypt with **age** using a hybrid recipient (age ≥1.3 supports ML-KEM-768+X25519 recipients *(verify)*), or restic with a strong repo key. Offline copy, quarterly restore drill, backup key held separately from the host. HNDL matters most here: backups are the longest-lived ciphertext we produce. **Effort S.**

### 2.10 Supply chain
- **Current:** GitHub Actions publish SDK/node images (see `packages/node-agent/src/node-image-workflow.test.ts`); npm workspace with native `bcrypt` rebuild in the node image.
- **Target:** pin Actions by commit SHA; `permissions:` least privilege; npm publish with `--provenance` (SLSA build L3 via GitHub OIDC); PyPI Trusted Publishing with attestations; container images signed with **cosign keyless** (Sigstore Fulcio + Rekor) and SLSA provenance via `slsa-github-generator`; node-agent verifies image signature in the installer (`cosign verify --certificate-identity … --certificate-oidc-issuer https://token.actions.githubusercontent.com`). Reproducible node image: pin base by digest, `SOURCE_DATE_EPOCH`, `npm ci` with lockfile, publish the digest in the signed federation policy doc so nodes can check they run a blessed build. Drop `bcrypt` from the node image (node-agent does not need it; it comes transitively via `@dominusnode/shared`; split shared or switch to a pure dependency). Sigstore itself is classical (ECDSA P-256); acceptable for now, track Sigstore PQ work. Renovate/Dependabot + `npm audit signatures`. **Effort M.**

### 2.11 Operational security
- **Key ceremony:** offline laptop, two people or recorded single-operator ceremony, generate root keys, print fingerprints, store encrypted copies in two locations (e.g. age-encrypted to two YubiKey-backed identities), publish fingerprints in the repo and in `coord-pins.generated.ts`.
- **Rotation:** online subkeys every 90 days, root every 2 years or on suspicion; multi-key pins already allow overlap. Write a runbook with the exact commands and a revocation path (policy doc lists revoked key ids; nodes refuse them).
- **Admin access:** admin UI behind WireGuard (or Tailscale) only; hardware-key WebAuthn for `ADMIN_HUMAN_LOGIN`; no admin routes on the public hostname.

---

## 3. Non-crypto hardening (where breaches actually happen)

1. **Gateway DoS/abuse.** Per-IP and per-key connection caps and handshake-rate limits on 8080/1080/tunnel before auth (cheap rejection paths, no DB hit for unknown keys: in-memory negative cache with size cap); slowloris timeouts on header read; max concurrent streams per node and per requester; kernel: SYN cookies, `nftables` rate limits, conntrack sizing.
2. **Cloudflare vs direct.** Put `www.`, `api.`, admin (if public at all) behind Cloudflare proxy (WAF, bot management, origin IP hidden, Authenticated Origin Pulls / mTLS so the origin accepts only CF). **Proxy/relay/tunnel hosts cannot sit behind Cloudflare's HTTP proxy** (CONNECT/SOCKS5/long-lived WS tunnels with exporter binding; ToS for proxy traffic). Expose them directly on separate IPs (different from the API origin, so revealing them does not reveal the API origin), with upstream DDoS protection from the hosting provider or Cloudflare Spectrum/Magic Transit if budget permits. On a homelab, front with a VPS that has volumetric DDoS protection and forward over WireGuard; never publish the home IP.
3. **WAF placement:** CF WAF for API; app-level validation remains authoritative (Zod/schema on every route, body size caps, `stripDangerousKeys`).
4. **Rate limits:** auth endpoints, challenge issuance (PoW already used for abuse reports), key creation, withdrawals; store counters in Postgres or Redis with caps, not unbounded maps.
5. **Logging:** structured logs, key prefix ≤8 chars, central append-only sink (separate host), alerts on: auth failure spikes, payout-wallet change, admin login, coordinator key use outside the gateway, schema change.
6. **Exit-node trust:** exit nodes are untrusted by design; keep it that way (gateway-only metering, plaintext only with `allowhttp-1`, warn agents that the exit sees SNI and timing).
7. **Incident response:** written runbook (key compromise, DB leak, payment fraud, node abuse report), contact `security@` + `/.well-known/security.txt` (RFC 9116), kill switches (global policy `minVersion` bump, revoke coordinator subkey, freeze withdrawals).
8. **Bug bounty:** start private (invite-only on a platform or self-hosted with clear scope and safe harbor), public after launch; payouts for gateway auth bypass, metering fraud, SSRF, wallet takeover.
9. **External audit:** two scopes: (a) protocol/crypto review of tunnel handshake, federation docs, payment rails (a firm with protocol experience, e.g. NCC, Trail of Bits, Cure53, Least Authority, or an independent cryptographer); (b) pentest of API/gateway/admin. Budget it before public launch; publish the report.

---

## 4. Prioritized roadmap

**Now (this month)**
- Hybrid `X25519MLKEM768` on Caddy, node tunnel, existing gateway TLS listeners (raise their `minVersion` to TLS 1.3); `PROXY_REQUIRE_TLS=true` in production (S).
- Move production gateways to direct/passthrough tunnel TLS so every CHALLENGE carries `tls-exporter` (M); node-side refusal of `"none"` follows later behind a policy flag.
- Secrets via `*_FILE` + systemd TPM-sealed credentials; coordinator key permissions (M).
- Encrypted, tested backups with hybrid age recipients (S).
- Pin Actions by SHA, npm `--provenance`, cosign keyless on images (M).

**Before public launch**
- Existing TLS proxy port as SDK/MCP default; scoped `dn_proxy_` tokens (M).
- Admin behind WireGuard + WebAuthn; Argon2id for admin passwords (M).
- API key hashing → HMAC with pepper, lazy migration (M).
- Gateway pre-auth rate limits, direct exposure layout for relay hosts, CF for API (M).
- JWT keyring with `kid`, `iss`/`aud` (S).
- External protocol review + pentest; security.txt; private bug bounty (L, mostly calendar).

**3 months**
- Node 24 LTS floor for gateway + node-agent; hybrid Ed25519+ML-DSA-65 CHALLENGE v2 and federation docs with AND-verification; pins carry both (M–L).
- Offline root + online subkey ceremony; documented rotation and revocation (M).
- Reproducible node image, digest published in signed policy (M).

**12 months**
- Raise `minChallengeVersion` / policy cutover: reject classical-only coordinator signatures.
- Optional ML-DSA node identity keys; SLH-DSA root for federation key lists.
- Track IETF: ML-KEM-only TLS groups, ML-DSA in JOSE/COSE, Sigstore PQ; reassess against NIST IR 8547 final.

---

## 5. What we will not claim

- **Not "quantum-proof".** Hybrid PQ key exchange protects confidentiality against a future CRQC under the assumption that ML-KEM *or* X25519 holds. That is the honest phrasing: "hybrid post-quantum encryption (ML-KEM-768 + X25519, FIPS 203) on all connections we operate".
- **Not PQ end-to-end for target sites.** Agent → target HTTPS is negotiated between the agent's client and the target; we cannot upgrade it.
- **Not PQ settlement.** Wallets, x402, USDC and facilitators use secp256k1/ECDSA/P-256. A CRQC breaks those at the chain level regardless of us.
- **Not PQ WebPKI.** Public certificates stay classical until CAs and browsers ship PQ/Merkle-tree certificates.
- **Exit nodes see metadata.** SNI, destination IPs, timing and any `allowhttp-1` plaintext are visible to the exit operator; no crypto removes that (ECH helps SNI only where targets support it).
- **HSM coverage of ML-DSA** on consumer hardware is not there yet; PQ private keys are TPM-sealed software keys.

## 6. Verification checklist (per change)

- Unit vectors for every signed message format (v1 and v2), plus negative tests for each single-signature-valid case.
- Interop matrix: old/new node × old/new gateway.
- `openssl s_client -groups X25519MLKEM768` / packet capture showing group `0x11ec` on each endpoint.
- `npm run build && npx vitest run`; `cosign verify` in CI on the published image; `npm audit signatures`.
- Restore drill from backup on a clean host.
