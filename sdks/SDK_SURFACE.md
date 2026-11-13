# DominusNode SDK surface (v2)

Language-neutral contract for all six SDKs. The reference implementation is
`sdks/node` (2.1.0; the Rust crate ships the same surface as 3.0.0 because a new enum variant is a semver break in Rust); Python, Go, Rust, Java and C++ must expose the same
resources, methods, parameters, results, errors and security behaviour.
Use each language's naming convention (`register_challenge`, `RegisterChallenge`,
`registerChallenge`), but keep the names below recognisable.

Server sources: `docs/agent-network/AGENT_API.md`, `packages/dashboard/src/routes/v1/*`,
`packages/dashboard/src/routes/{auth,wallet-auth,keys,wallet,agent-wallet,teams,usage,sessions,x402,proxy-health,proxy-config}.ts`,
`packages/proxy-gateway/src/auth.ts` (`parseProxyOptions`).

**Totals: 15 resources, 71 resource methods, plus 3 client members.** Pagination helpers (section 3.16)
are conveniences on top and are not counted.

| Resource | Methods |
|---|---|
| auth | 4 |
| walletAuth | 4 |
| keys | 3 |
| wallet | 5 |
| agenticWallets | 9 |
| teams | 18 |
| usage | 4 |
| sessions | 2 |
| x402 | 1 |
| network | 3 |
| nodes | 6 |
| credits | 4 |
| payoutWallet | 2 |
| payouts | 1 |
| proxy | 5 |

## 0. Removed (do NOT implement)

Plans, slots/waitlist, admin resources, Stripe and PayPal top-ups, email/password
register/login, password change/reset, human MFA setup/enable/disable/verify,
`completeMfa`, `connectWithCredentials`, the agent-secret (`X-DominusNode-Agent*`)
headers, `proxy.getStatus`, legacy `dc-`/`residential-`/`auto-` username prefixes,
`state-`/`city-`/`asn-` targeting, and every hardcoded price ($3/$5 per GB).
Prices come only from `network.pricing()` and `x402.getInfo()`.

## 1. Conventions

### 1.1 Client configuration

| Field | Default | Notes |
|---|---|---|
| baseUrl | `https://api.dominusnode.com` | http(s) only; refuse userinfo in the URL; strip trailing `/` |
| proxyHost | `proxy.dominusnode.com` | `[A-Za-z0-9.-]{1,253}` or bracketed IPv6; else INVALID_ARGUMENT |
| httpProxyPort | 8080 | integer 1..65535 |
| socks5ProxyPort | 1080 | integer 1..65535 |
| gatewayTls | off | optional. `true` or `{ port = 8443, ca?, servername? }`: TLS to the gateway's HTTPS proxy listener (`PROXY_TLS_PORT`), so `Proxy-Authorization` is encrypted. Certificate verification always on. `ca` is a PEM root ADDED to the system roots (append, never replace: Node passes `[...tls.rootCertificates, ca]`, C++ prepends the default CA bundle to `CURLOPT_PROXY_CAINFO_BLOB`, Go/Rust/Python/Java add it to the default store). `servername` overrides SNI and the verified name (default proxyHost; useful when proxyHost is an IP). When set, `proxy.fetch` uses it and `buildUrl` defaults to `https://`. All six SDKs. |
| accessToken, refreshToken | none | optional pre-existing JWT pair |
| HTTP transport | platform default | injectable for tests; must not follow redirects |

### 1.2 Auth modes

Every method below is tagged with one mode.

| Mode | Header |
|---|---|
| `none` | no Authorization |
| `jwt` | `Authorization: Bearer <access JWT>`; refresh before expiry (60 s buffer) and once after a 401 |
| `agent` | `Authorization: Bearer <dn_live_/dn_test_ API key>` when connected with a key, else the wallet JWT. `/v1` routes reject JWTs of non-wallet users, so the raw key MUST be sent. No 401 refresh when the key was used |

Calling a `jwt`/`agent` method with no credential raises AuthenticationError
(no request is sent).

### 1.3 Money

- Server money object `Money = { musd: string /* integer µUSD */, usd: string /* 6 decimals */ }`; 1 USD = 1,000,000 µUSD.
- µUSD **inputs** (`amountMusd`) accept a big integer, a digit string `^[1-9][0-9]{0,15}$`, or a safe integer; send them as a **decimal string**. Never use floats.
- Cents inputs (`*Cents`): integer, `0 < x <= 2,147,483,647` (or `>= 0` where noted). Validate client-side.

### 1.4 Validation before sending (raise ValidationError, code `INVALID_ARGUMENT`, no request)

- Ethereum address `^0x[0-9a-fA-F]{40}$`.
- EIP-191 signature: length <= 200, then `^0x[0-9a-fA-F]{130}$`.
- UUID ids: `^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$` (case-insensitive).
- Idempotency key `^[A-Za-z0-9_-]{8,120}$`. Default when omitted: `"dn-" + UUIDv4`.
- API key `^dn_(live|test)_[A-Za-z0-9_-]{8,200}$`.
- Every user-supplied path parameter is URL-encoded (encodeURIComponent semantics).
- Query strings: omit unset parameters; values as decimal strings.

### 1.5 Signer callback (EIP-191)

```
Signer {
  address: string                      // 0x + 40 hex
  signMessage(message: string) -> string (sync or async)  // personal_sign over the exact UTF-8 string
}
```

The SDK has no crypto dependency; callers wrap ethers/viem/web3/eth-account/a HSM.
After calling the signer, validate the returned signature format (section 1.4); a
bad format or a signer exception raises ProtocolError.

**Message rule.** The SDK never signs a server string blindly. For every signed flow
it rebuilds the message byte-for-byte from values it knows and compares it with the
server's `message` (exact string equality). If they differ: raise ProtocolError and
do NOT call the signer. Builders (lines joined with `\n`, no trailing newline):

Node attestation (`packages/shared/src/attestation.ts`):
```
DomiNode node attestation
Version: <attestationVersion>
Wallet: <signer.address lowercased>
Nonce: <nonce>
Node pubkey: <64 lowercase hex | "none">
<empty line>
<attestationText>
```

Payout wallet (`routes/v1/credits.ts payoutWalletMessage`):
```
DominusNode payout wallet
Action: payout_wallet_set
User: <userId>
Account wallet: <signer.address lowercased>
Payout address: <address lowercased>
Chain: <chain>
Nonce: <nonce>
```

Withdrawal (`routes/v1/credits.ts withdrawMessage`):
```
DominusNode withdrawal
Action: withdraw
User: <userId>
Account wallet: <signer.address lowercased>
Amount (µUSD): <amountMusd>
Idempotency key: <idempotencyKey>
Nonce: <nonce>
```

`userId` for payout/withdraw: take line 3 of the server message (`User: <value>`);
the value MUST be a UUID, else ProtocolError. Then rebuild and compare the whole message.

### 1.6 Secret wrapper

Credentials returned once by the server (new API key, team key, `dn_node_` key) are
wrapped in `Secret`:
- `reveal() -> string` returns the value;
- `prefix` returns the first 8 characters;
- string conversion, debug print (`repr`, `Debug`, `String()`, `operator<<`, `toString`) and JSON serialisation all yield `[REDACTED]`.
Store the raw value in a private field so reflection/key listing does not show it.

### 1.7 HTTP behaviour

- Header `User-Agent: dominusnode-sdk-<lang>/<version>`; `Accept: application/json`; `Content-Type: application/json` only when a body is sent.
- Timeout 30 s per request.
- **Redirects disabled.** A 3xx raises an error and is never followed.
- **Response cap 10 MB.** Reject when `Content-Length` > 10 MB (cancel the body) or when the read body exceeds 10 MB.
  Read the body as a stream with a byte counter and cancel it as soon as the count passes 10 MB; never buffer a
  chunked (no `Content-Length`) body in full first. A malformed `Content-Length` (not 1..19 digits) raises ServerError.
- **409 is never retried** (e.g. `REPORT_LIMIT`, `ALREADY_REPORTED`); it surfaces as ConflictError with `code`.
- **429:** retry at most once. Wait `min(Retry-After seconds (default 5), 10 s)`, apply ±10 % jitter, floor 100 ms. Cancel/close the 429 body without reading it. If the retry is also 429, raise RateLimitError with `retryAfterSeconds` (Retry-After, default 60).
- **401 with JWT auth:** force one token refresh (singleton refresh for concurrent callers), retry once. Refresh failure clears both tokens and raises AuthenticationError.
- JSON parse: recursively delete `__proto__`, `constructor`, `prototype` keys (depth limit 50) or the language equivalent. Empty body -> empty object.
- `raw` text responses (CSV export) are returned unparsed.

### 1.8 Errors

Base `DominusNodeError { message, statusCode?, code?, details? }`.

| Class | When |
|---|---|
| ValidationError | HTTP 400; also client-side checks (statusCode null, code `INVALID_ARGUMENT`) |
| AuthenticationError | 401, or no credential held |
| InsufficientBalanceError | 402 |
| AuthorizationError | 403 |
| NotFoundError | 404 |
| ConflictError | 409 |
| RateLimitError | 429 (`retryAfterSeconds`) |
| ServerError | >= 500, oversize body, invalid JSON |
| NetworkError | transport failure |
| ProtocolError | server data the SDK refuses to act on (message mismatch, bad challenge, bad node key) or a signer failure |
| ProxyError | `proxy.fetch` failure (blocked target, refused tunnel with `statusCode`, timeout) |

- `message` = body `error` (or `message`), truncated to 500 chars + `... [truncated]`.
- `code` = body `code`; if absent and body has `mfaRequired: true`, code `MFA_REQUIRED`.
- `details` = numeric/string fields `max`, `cap`, `limitPerDay` when present.
- **Every** message (including transport errors) passes through credential scrubbing: replace `dn_(live|test|node|proxy)_[A-Za-z0-9_-]+` and `eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]*` with `[REDACTED]`.

Server codes SDK users will see: `EMAIL_NOT_VERIFIED`, `NO_LINKED_WALLET`, `RATE_LIMITED`,
`ACCOUNT_FROZEN`, `INSUFFICIENT_CREDIT`, `WALLET_CAP`, `NO_WALLET`, `INVALID_CHALLENGE`,
`BAD_SIGNATURE`, `OLD_WALLET_SIGNATURE_REQUIRED`, `COOLDOWN_ACTIVE`, `SAME_ADDRESS`,
`ALREADY_REGISTERED`, `SCREENING_UNAVAILABLE`, `SANCTIONED`, `PAYOUTS_DISABLED`,
`NO_PAYOUT_WALLET`, `PAYOUT_WALLET_COOLDOWN`, `DAILY_LIMIT_EXCEEDED`, `AMOUNT_OUT_OF_RANGE`,
`CAP_ABOVE_DEFAULT` (`details.max`), `NOT_RELAY_SESSION`, `SESSION_TOO_OLD`,
`ALREADY_REPORTED`, `REPORT_LIMIT`, `MFA_REQUIRED`.

### 1.9 Credential lifecycle and redaction

- Client holds: API key, access JWT, refresh JWT. Nothing else secret.
- `disconnect()`: if a JWT is held, call `auth.logout()` best-effort (ignore errors); then clear the API key, access token and refresh token (zeroize where the language allows: Rust `zeroize`, C++ `secure_zero_string`, Java char[]/overwrite). In Rust call logout BEFORE clearing the token manager.
- `TokenManager.clear()` clears tokens and any in-flight refresh but MUST NOT clear the refresh callback (reconnect must work).
- Client, HTTP client and token manager print/serialise without credentials (`DominusNodeClient(connected=true)`, `[REDACTED]`).
- The proxy URL from `proxy.buildUrl` contains the key by design; document "do not log".

## 2. Client

| Member | Behaviour |
|---|---|
| `connectWithKey(apiKey) -> ConnectResult { mfaRequired: bool, userId?: string }` | Validate key format. POST `/api/auth/verify-key` (`none`) body `{apiKey}`. On success store the key and the JWT pair, return `{mfaRequired:false, userId}`. If the error code is `MFA_REQUIRED` (403 + `mfaRequired:true`), store only the key and return `{mfaRequired:true}` (agent routes and the proxy still work). Other errors propagate and nothing is stored. |
| `disconnect()` | Section 1.9. |
| `isConnected -> bool` | API key or any token held. |

## 3. Resources

Notation: `METHOD path` `[mode]` `body`/`query` -> result. Optional parameters in `?`.

### 3.1 auth (4)

| Method | Request | Result |
|---|---|---|
| `verifyKey(apiKey)` | POST `/api/auth/verify-key` [none] `{apiKey}` | `{valid, token, refreshToken, userId, email}` |
| `refresh(refreshToken)` | POST `/api/auth/refresh` [none] `{refreshToken}` | `{token, refreshToken?}` |
| `logout()` | POST `/api/auth/logout` [jwt] `{}` | void |
| `me()` | GET `/api/auth/me` [jwt] | `{user: {id, email, wallet_address?, email_verified?, ...}}` |

### 3.2 walletAuth (4)

| Method | Request | Result |
|---|---|---|
| `challenge(address)` | POST `/api/auth/wallet/challenge` [none] `{address}` | `{message, nonce, challenge, expiresAt}` |
| `verify(address, signature)` | POST `/api/auth/wallet/verify` [none] `{address, signature}` | `{token?, refreshToken?, user?, mfaRequired?, mfaChallengeToken?}`. If `mfaRequired === true` return `{mfaRequired, mfaChallengeToken}` and store NOTHING; else store the JWT pair. |
| `signIn(signer)` | `challenge(signer.address)`; refuse (ProtocolError) unless the message contains the signer address (case-insensitive); sign; `verify` | as `verify` |
| `link(address, signature)` | POST `/api/auth/wallet/link` [jwt] `{address, signature}` | `{success, walletAddress}` |

### 3.3 keys (3)

| Method | Request | Result |
|---|---|---|
| `create(label = "Default")` | label 1..100 chars; POST `/api/keys` [jwt] `{label}` | `{id, prefix, label, created_at, key: Secret}` |
| `list()` | GET `/api/keys` [jwt] | `{keys: [{id, prefix, label, created_at, revoked_at}]}` |
| `revoke(id)` | DELETE `/api/keys/{id}` [jwt] | void |

### 3.4 wallet (5) — requester prepaid wallet, cents

| Method | Request | Result |
|---|---|---|
| `getBalance()` | GET `/api/wallet` [jwt] | `{balanceCents, balanceUsd, currency, lastToppedUp}` |
| `getTransactions(limit?, offset?)` | GET `/api/wallet/transactions?limit&offset` [jwt] | `{transactions: [{id, type, amountCents, amountUsd, description, paymentProvider, createdAt}]}` |
| `getForecast()` | GET `/api/wallet/forecast` [jwt] | `{dailyAvgCents, daysRemaining, trend, trendPct}` |
| `topUpCrypto(amountCents, currency)` | cents 1000..100000; currency (case-insensitive) in `btc eth ltc xmr zec usdc sol usdt dai bnb link`; POST `/api/wallet/topup/crypto` [jwt] `{amountUsd: amountCents/100, currency: lowercased}` | `{invoiceId, invoiceUrl, payCurrency, priceAmount}` |
| `getCryptoStatus(invoiceId)` | UUID; GET `/api/wallet/crypto/status/{invoiceId}` [jwt] | `{invoiceId, status, amountCents, provider, createdAt}` |

### 3.5 agenticWallets (9) — `/api/agent-wallet` [jwt]

| Method | Request |
|---|---|
| `create(label, spendingLimitCents = 10000, dailyLimitCents?, allowedDomains?)` | spending/daily cents `>= 0` and <= 2147483647; POST `/api/agent-wallet` `{label, spendingLimitCents, dailyLimitCents?, allowedDomains?}` -> AgenticWallet |
| `list()` | GET `/api/agent-wallet` -> `{wallets}` |
| `get(walletId)` | GET `/api/agent-wallet/{id}` |
| `fund(walletId, amountCents)` | cents > 0; POST `/{id}/fund` `{amountCents}` -> `{transaction}` |
| `updateWalletPolicy(walletId, {dailyLimitCents?, allowedDomains?})` | PATCH `/{id}/policy` |
| `transactions(walletId, limit?, offset?)` | GET `/{id}/transactions?limit&offset` -> `{transactions}` |
| `freeze(walletId)` | POST `/{id}/freeze` `{}` |
| `unfreeze(walletId)` | POST `/{id}/unfreeze` `{}` |
| `delete(walletId)` | DELETE `/{id}` -> `{deleted, refundedCents}` |

AgenticWallet = `{id, label, balanceCents, spendingLimitCents, dailyLimitCents, allowedDomains, status, createdAt}`.

### 3.6 teams (18) — `/api/teams` [jwt]

| Method | Request |
|---|---|
| `create(name, maxMembers?)` | POST `/api/teams` `{name, maxMembers?}` |
| `list()` | GET `/api/teams` |
| `get(teamId)` | GET `/{teamId}` |
| `update(teamId, {name?, maxMembers?})` | PATCH `/{teamId}` |
| `delete(teamId)` | DELETE `/{teamId}` -> `{refundedCents}` |
| `fundWallet(teamId, amountCents)` | cents > 0; POST `/{teamId}/wallet/fund` `{amountCents}` |
| `getTransactions(teamId, limit?, offset?)` | GET `/{teamId}/wallet/transactions?limit&offset` |
| `listMembers(teamId)` | GET `/{teamId}/members` |
| `addMember(teamId, email, role?)` | POST `/{teamId}/members` `{email, role?}` |
| `updateMemberRole(teamId, userId, role)` | PATCH `/{teamId}/members/{userId}` `{role}` |
| `removeMember(teamId, userId)` | DELETE `/{teamId}/members/{userId}` |
| `createInvite(teamId, email, role?)` | POST `/{teamId}/invites` `{email, role?}` |
| `listInvites(teamId)` | GET `/{teamId}/invites` |
| `cancelInvite(teamId, inviteId)` | DELETE `/{teamId}/invites/{inviteId}` |
| `acceptInvite(token)` | POST `/api/teams/invites/{token}/accept` `{}` |
| `createKey(teamId, label)` | label 1..100; POST `/{teamId}/keys` `{label}` -> `{id, prefix, label, createdAt, key: Secret}` (read `prefix`; accept legacy `keyPrefix`) |
| `listKeys(teamId)` | GET `/{teamId}/keys` -> `{keys: [{id, prefix, label, userId, teamId, createdAt, revokedAt}]}` (legacy `keyPrefix` mapped to `prefix`) |
| `revokeKey(teamId, keyId)` | DELETE `/{teamId}/keys/{keyId}` |

Team API keys cannot call `/v1` agent routes (server 403).

TeamInvite = `{id, teamId, email, role, invitedBy, expiresAt, createdAt}`. The invite token is never returned by
list/create (it is delivered to the invitee). SDKs that exposed a `token` member in 2.0.0 keep it as a
deprecated optional/empty member ("never sent by the server"); likewise `activeSessions`/`uptimeSeconds` on
ProxyHealth. 2.0.x is non-breaking: renamed fields keep their 2.0.0 name (e.g. `keyPrefix`) next to the new one.

### 3.7 usage (4) — [jwt]

Date range: `from` -> query `since`, `to` -> `until` (ISO 8601).

| Method | Request |
|---|---|
| `get(from?, to?, limit?, offset?)` | GET `/api/usage?since&until&limit&offset` -> `{summary, records, pagination, period}` |
| `getDaily(from?, to?)` | GET `/api/usage/daily` -> `{days, period}` |
| `getTopHosts(from?, to?, limit?)` | GET `/api/usage/top-hosts` -> `{hosts, period}` |
| `exportCsv(from?, to?)` | GET `/api/usage/export` -> raw CSV string |

Byte counts (`bytesIn`, `bytesOut`, `totalBytes`, and `paidBytes24h` in network stats) are integers but may
arrive as numbers or numeric strings; typed SDKs (Go, Rust, Java, C++) accept both (`^-?[0-9]{1,19}$` for
strings, null -> 0) and refuse anything else.

### 3.8 sessions (2)

| Method | Request | Result |
|---|---|---|
| `getActive()` | GET `/api/sessions/active` [jwt] | `{sessions: [ActiveSession]}`. ActiveSession = `{id, startedAt, status}` ONLY: build it field by field; never include proxy_ip, node IP or any other field the server might add. |
| `report(sessionId, reason)` | sessionId UUID; reason in `blocked captcha rate_limited slow bad_content other`; POST `/v1/sessions/{id}/report` [agent] `{reason}` | `{reportId, reportsToday, limitPerDay}` |

### 3.9 x402 (1)

`getInfo()` GET `/api/x402/info` [none] -> `{supported, enabled, protocol, version, facilitators: map<name, {network, receivingAddress, currency}>, pricing: map<string, string|number>, currencies, walletType, agenticWallets}`.

### 3.10 network (3) — public, [none]

| Method | Request | Result |
|---|---|---|
| `policy()` | GET `/v1/policy` | `{version, sha256, body: object, floorGuarantees: [string]}` |
| `pricing()` | GET `/v1/pricing` | `{currency:"USD", unit:"musd_per_gb", prices:[{ipClass, pricePerGbMusd}], nodeShare:[{tier, rank, nodeShareBps}], buyerDiscounts:[{tier, rank, buyerDiscountBps}], maturationHours, rails:[string]}` |
| `stats()` | GET `/v1/network/stats` | `{onlineNodes, byClass: map, byCountry: [{country, online}], otherCountries, seed:{online, paidBytes24h}, community:{online, paidBytes24h}, generatedAt}` (seed = operator-run, community = agent-run; paidBytes24h is a decimal string) |

### 3.11 nodes (6) — [agent]

| Method | Request | Result |
|---|---|---|
| `registerChallenge(nodePubkey?)` | pubkey 64 hex, lowercased; POST `/v1/nodes/challenge` `{nodePubkey?}` (empty object when absent) | NodeChallenge `{nonce, attestationText, attestationVersion, policyVersion, message, expiresAt, powChallenge:{challengeId, prefix, difficulty, algorithm, expiresAt}}` |
| `register(signer, nodePubkey?, challenge?, maxStreams?, maxGbDay?, maxPowIterations? = 200,000,000, declaredClass?)` | see flow | RegisteredNode `{nodeId, status, attestationVersion, nodeKey: Secret}` |
| `list(limit?, offset?)` | limit 1..500, offset 0..1,000,000; GET `/v1/nodes?limit&offset` | `{nodes:[NodeInfo], limit, offset, nextCursor?}` |
| `revoke(nodeId)` | UUID; DELETE `/v1/nodes/{id}` | `{id, status}` |
| `updateCaps(nodeId, maxStreams?, gbPerDay?, reqPerSec?)` | UUID; each present value integer 1..1,000,000; at least one; PATCH `/v1/nodes/{id}` with only the present keys | `{id, status, caps, effective, appliesOn}` |
| `tier()` | GET `/v1/node/tier` | `{tier, nextTier, progress, changedAt, uptimeGraceUntil, demotionReason, tierWeights?}` (`tierWeights` maps exit class -> decimal weight, 2.1); TierView `{id, name, rank, nodeShareBps, holdDays, maxNodes, dailyWithdrawLimitMusd (string), buyerDiscountBps}` |

**register flow**
1. Validate signer, pubkey, `maxStreams` 1..1024, `maxGbDay` 1..10000, `declaredClass` in `residential mobile dc masked` (before any request).
2. Use `challenge` if given, else `registerChallenge(nodePubkey)`.
3. Validate the challenge: nonce `^[0-9a-f]{64}$`; attestationText non-empty string <= 64 KiB; attestationVersion integer 1..100000; powChallenge.challengeId UUID, prefix string, difficulty number. Else ProtocolError.
4. Build the attestation message (1.5) with `signer.address` and the pubkey (or `none`); exact compare with `challenge.message`; mismatch -> ProtocolError, signer not called.
5. Solve PoW: smallest decimal n >= 0 with `sha256(prefix + str(n))` having >= difficulty leading zero bits. Refuse difficulty outside 1..32 or prefix length outside 1..256; give up after `maxPowIterations` (ProtocolError).
6. `walletSignature = signer.signMessage(message)`, format-checked.
7. POST `/v1/nodes` `{nonce, walletSignature, attestationVersion, pow:{challengeId, nonce:n}, nodePubkey?, maxStreams?, maxGbDay?, declaredClass?}`. `declaredClass` is informational; the effective class is always gateway-verified.
8. Response must have `nodeId` UUID and `nodeKey` `^dn_node_[0-9a-f]{64}$` (else ProtocolError). Wrap the key in Secret.

NodeInfo = `{id, status, walletAddress, nodePubkey, attestationVersion, observedIp, country, ipClass, maxStreams, maxGbDay, reputation, agentVersion, lastSeenAt, createdAt, verifiedClass?, declaredClass?, classVerifiedAt?, tierWeight?}` (the caller's own nodes only). The four 2.1 fields are optional: older servers omit them. `verifiedClass` = `ipClass` (`unknown` until classified); `tierWeight` is a decimal (defaults residential/mobile 1, dc 0.4, masked 0.25).

### 3.12 credits (4) — [agent], µUSD

| Method | Request | Result |
|---|---|---|
| `balance()` | GET `/v1/credits` | `{pending, available, frozen, autoConvertPct, tier:{id, name, rank, holdDays, dailyWithdrawLimit}, taxFormStatus, ytdPaid, payoutsEnabled, minWithdraw, buyerDiscountBps}` (Money fields; buyerDiscountBps is 0 unless the account runs a node) |
| `transactions(limit?, cursor?, type?)` | limit 1..200; cursor `^[1-9][0-9]{0,18}$` (same as the server); type in `earn mature clawback convert withdraw withdraw_reversal`; GET `/v1/credits/transactions?limit&cursor&type` | `{transactions:[{id, type, amount, relayChargeId, reference, createdAt}], nextCursor}` |
| `convert(amountMusd, idempotencyKey?)` | 10,000 <= amount <= 10,000,000,000; POST `/v1/credits/convert` header `Idempotency-Key: <key>` body `{amountMusd:"<string>"}`. **RELEASE BLOCKER: the server now requires a wallet signature; this branch must not ship until all 6 SDKs and the 27 integrations' `credits_convert` tool send it (or the tool is removed):** POST `/v1/credits/convert/challenge` with the same header and amount, rebuild and sign the message like withdraw (signer callback), then send `{amountMusd, nonce, signature}`. Until the SDKs add the signer, an unsigned call gets `400 SIGNATURE_REQUIRED` | `{converted, convertedCents, duplicate, idempotencyKey}` (key echoed so callers can retry) |
| `withdraw(amountMusd, signer, idempotencyKey?)` | see flow | `{payout, duplicate, idempotencyKey}` |

**withdraw flow**: amount 1,000,000..100,000,000,000; key default `dn-<uuid>`.
POST `/v1/credits/withdraw/challenge` `{amountMusd, idempotencyKey}` -> `{nonce, message, expiresAt, signer}`.
Check nonce hex64; check `signer` (server) equals `signer.address` case-insensitively else ProtocolError;
rebuild the withdrawal message (1.5) and compare; sign; POST `/v1/credits/withdraw`
`{amountMusd, idempotencyKey, nonce, signature}`.
Payout = `{id, amount, trigger, status, txHash, createdAt, failureReason?, address?, chain?, updatedAt?}`;
status in `pending held_tax held_frozen submitted confirmed failed reversed`.

### 3.13 payoutWallet (2) — [agent]

| Method | Request | Result |
|---|---|---|
| `get()` | GET `/v1/payout-wallet` | `{payoutWallet: {address, chain, status: active|pending, activeFrom} | null, cooldownHours}` |
| `set(address, signer, chain = "base", oldWalletSigner?)` | chain `base` or `base-sepolia`; see flow | `{payoutWallet, changed, cooldownHours}` |

**set flow**: validate address (lowercase it) and chain in `base`, `base-sepolia`, validate both signers.
`base-sepolia` is an explicit opt-in for staging; the SDK sends it as given and the server decides (it accepts it
only outside production). The chain goes into the signed message's `Chain:` line.
POST `/v1/payout-wallet/challenge` `{address, chain}` ->
`{nonce, message, expiresAt, signer, oldWalletSignatureRequired, oldWalletAddress}`.
Check nonce, server `signer` == `signer.address`, rebuild + compare the payout-wallet message.
If `oldWalletSignatureRequired`: require `oldWalletSigner` whose address equals
`oldWalletAddress` (case-insensitive) else ValidationError, all BEFORE any signer call.
Sign with `signer`; when required, sign the SAME message with `oldWalletSigner`.
PUT `/v1/payout-wallet` `{address, chain, nonce, signature, oldWalletSignature?}`.

### 3.14 payouts (1)

`list(limit?, offset?)`: limit 1..200, offset 0..1,000,000; GET `/v1/payouts?limit&offset` [agent] -> `{payouts:[Payout], limit, offset, nextCursor?}`.

**Cursor paging (2.1, additive).** `GET /v1/nodes` and `GET /v1/payouts` also accept `cursor=<nextCursor>` (opaque, validated client-side as `^[A-Za-z0-9_\-=+/.:]{1,512}$`). Node and Python take an optional `cursor` on `list`; Rust, Java and C++ add `listAfter(limit?, cursor)` (`list_after`); Go keeps `List` unchanged and exposes `NextCursor` on `NodeList`/`PayoutList`. These additions are not counted in the 71.

### 3.15 proxy (5)

**Username flags** (`buildUsername(options)`, hyphen-joined in this order; none -> `relay`):

| Option | Validation | Flag |
|---|---|---|
| country | `^[A-Za-z]{2}$`, uppercased; refuse OFAC `CU IR KP RU SY` | `country-XX` |
| ipClass | `residential` / `dc` / `mobile` / `masked` (2.1; VPN/WARP/Tor egress, cheapest, opt-in: never used unless requested) | `class-<c>` |
| sessionId | `^[A-Za-z0-9]{1,64}$` | `session-<id>` |
| agenticWalletId | UUID, lowercased | `wallet-<uuid>` |
| allowHttp | true | `allowhttp-1` |

| Method | Behaviour |
|---|---|
| `buildUsername(options)` | as above |
| `buildUrl(options, protocol = http|https|socks5, apiKey?)` | `<protocol>://<urlenc(username)>:<urlenc(apiKey)>@<proxyHost>:<port>`; port = httpProxyPort, gatewayTls.port or socks5ProxyPort. Default protocol: `https` when gatewayTls is set, else `http`; `https` without gatewayTls is INVALID_ARGUMENT. Key = argument or the connected key (AuthenticationError if none; validated). |
| `fetch(url, options)` | see below -> `{status, statusText, headers: map, body: bytes, truncated: bool, text()}` |
| `getHealth()` | GET `/api/proxy/health` [none] -> `{status}` only (build it field by field; never default missing counters to 0) |
| `getConfig()` | GET `/api/proxy/config` [jwt] -> object |

**fetch** options: routing flags above + `method` (GET default | HEAD), `headers`,
`timeoutMs` (default 30,000, clamp 1..120,000), `maxBytes` (default and max 10 MB), `apiKey?`.
Order (all checks before any network I/O except step 6):
1. Method must be GET or HEAD (else INVALID_ARGUMENT). No request body ever.
2. URL: http/https only; no userinfo; port empty, 80 or 443; hostname (trailing dot removed, lowercased) not `localhost`, `localhost.localdomain`, `ip6-localhost`, `ip6-loopback`, nor ending in `.localhost` `.local` `.internal` `.arpa`; not a private IP literal (rules below). Failures raise ProxyError.
3. `http://` requires `allowHttp: true` (INVALID_ARGUMENT otherwise).
4. Build the username (validates flags).
5. Headers: refuse names not matching the HTTP token grammar and any CR, LF or NUL in names/values; silently drop `host connection content-length transfer-encoding proxy-authorization proxy-connection authorization upgrade te trailer keep-alive`.
6. **DNS rebinding check**: resolve the hostname to ALL addresses (A + AAAA); fail if resolution fails, returns nothing, or ANY address is private.
7. `Proxy-Authorization: Basic base64(username + ":" + apiKey)` to `proxyHost:httpProxyPort` over plain TCP, or, with `gatewayTls`, to `proxyHost:gatewayTls.port` over TLS (>= 1.2, verified, SNI = proxyHost) and the steps below run inside that channel (TLS-in-TLS for https targets).
   The inner request must really ride the tunnel socket (Node: do not pass `agent: false` together with `createConnection`; Node then ignores `createConnection` and dials the target directly).
   - https: `CONNECT host:port` (port default 443). Non-200 -> ProxyError with that status. Then TLS (>= 1.2, certificate and hostname verification ON, SNI = host) over the tunnel and send the request with `Host`, `Connection: close`.
   - http: absolute-URI request line (`GET http://host/path?q HTTP/1.1`) with `Host`, `Connection: close`.
8. Never follow redirects: return 3xx as-is. Read at most `maxBytes` of body; on overflow keep the first `maxBytes`, set `truncated`, close the connection. HEAD reads no body.
9. Timeout -> ProxyError. Every error message is credential-scrubbed.

**Private address rules** (IPv4 after decoding decimal/hex/octal/short forms such as `2130706433`, `0x7f000001`, `0177.0.0.1`, `127.1`):
`0/8, 10/8, 127/8, 169.254/16, 172.16/12, 192.168/16, 100.64/10, 192.0/16, 198.18/15, >= 224.0.0.0`.
`192.0/16` is deliberately the whole `192.0.0.0 - 192.0.255.255` block (it covers 192.0.0/24 IETF and 192.0.2/24 TEST-NET-1); every SDK uses this exact table (Node `ssrf.ts` is the reference).
IPv6 (strip brackets and `%zone`, fully expand incl. embedded dotted IPv4):
`::`, `::1`, IPv4-mapped `::ffff:a.b.c.d` and IPv4-compatible `::a.b.c.d` (check the embedded IPv4, any spelling incl. hex `::ffff:7f00:1`),
NAT64 `64:ff9b::/96` (embedded IPv4), `fc00::/7`, `fe80::/10`, `fec0::/10`, `ff00::/8`,
Teredo `2001:0000::/32`, 6to4 `2002::/16`, documentation `2001:db8::/32`.

### 3.16 Pagination helpers (not counted in the 71)

Lazy: fetch the next page only when the current one is used up. `limit` is the page size and is validated
before the first request. Stop on a short page (fewer than `limit` items), on an empty page, at
`pagination.total` (usage) or when `nextCursor` is null, invalid or repeats (credits; and payouts/nodes once the server sends `nextCursor`). An API error ends
the iteration and propagates.

| Helper | Pages over | Default / max page |
|---|---|---|
| credits transactions | `credits.transactions` via `nextCursor` (optional `type`) | server default / 200 |
| payouts | `payouts.list` via `nextCursor`, offset fallback on servers without it | 50 / 200 |
| nodes | `nodes.list` via `nextCursor`, offset fallback on servers without it | 100 / 500 |
| usage records | `usage.get` (offset, `from`/`to`) | 200 / 1000 |
| wallet transactions | `wallet.getTransactions` (offset) | 50 / 100 |

Shape per language: Node `async *iterTransactions()` / `iterate()` / `iterRecords()`; Python generators
(`iter_transactions`, `iterate`, `iter_records`; async generators on the async client); Go callbacks
(`EachTransaction`, `Each`, `EachRecord`; return `ErrStopIteration` to stop; go.mod targets 1.22, so no
range-over-func); Rust `Stream`s (`iter_transactions`, `iter`, `iter_records`); Java `Iterator` + `Stream`
(`iterTransactions`/`streamTransactions`, `iterate`/`stream`, `iterRecords`/`streamRecords`); C++ callbacks
returning `false` to stop (`for_each_transaction`, `for_each`, `for_each_record`).

### 3.17 README requirements

Every SDK README documents: node-registration PoW is bound to the client IP (call `registerChallenge` and
`register` from the same egress), and a troubleshooting table covering 402 vs 407, `EMAIL_NOT_VERIFIED`,
`NO_NODES_AVAILABLE`, `PAYOUTS_DISABLED` and `REPORT_LIMIT`.

## 4. Tests every SDK must have

Mock the HTTP transport (return bodies through the text()/raw-body path).
- One test per method asserting HTTP method, path (incl. encoding), query, body and auth mode.
- Validation failures send no request (cents bounds 0 / 2147483648, µUSD bounds, bad UUID, bad address, signature length 129 / > 200 / non-hex, idempotency key).
- Error mapping for 400/401/402/403/404/409/429/5xx incl. `code` and `details`; credential scrubbing of key/node key/JWT in messages.
- 429: one retry then success; second 429 -> RateLimitError; delay bounds (10 s cap ±10 %, 100 ms floor).
- 401 JWT refresh + retry; no refresh for API-key auth; refresh failure clears tokens.
- 10 MB cap by Content-Length and by actual size; redirects disabled.
- 409 (`REPORT_LIMIT`) not retried and carries `code`; 429 retried exactly once.
- Team keys read `prefix` with `keyPrefix` fallback; health returns `{status}` only; cursor regex; `base-sepolia`
  accepted and other chains refused; byte counts as numbers or numeric strings (typed SDKs); pagination helpers.
- Signer flows: node register (PoW solution verifies), withdraw, payout-wallet first set and change (old signer signs the same message); **message mismatch refusal** for each flow with the signer never called; server `signer` != signer.address refusal; bad signature format from the signer.
- Redaction: Secret, client, token manager in string/debug/JSON; `disconnect()` clears key + tokens; `clear()` keeps the refresh callback.
- `getActive()` drops unknown fields such as `proxyIp`.
- Proxy: username building + flag validation (incl. OFAC), URL building, private-IP table (both lists above, incl. 192.0.1.1 private / 192.1.0.1 public), URL refusals, DNS-rebinding with a mixed public/private answer, and a local fake gateway for the http path (auth header, absolute URI, redirect not followed, truncation) and CONNECT refusal (ProxyError carries the status).
- Tunnel integrity: for an https target the fake gateway must receive the CONNECT and then the target's TLS ClientHello (SNI = target host) on the SAME connection, proving the request never dials the target directly.
- gatewayTls: a TLS fake gateway with a self-signed cert generated in the test; CONNECT (with Proxy-Authorization) arrives inside TLS, http absolute-URI over TLS (IP host + servername), unverifiable cert / wrong servername refused before any request bytes are sent, `buildUrl` defaults to `https://...:8443`, config validation.
- Attestation message parity with `packages/shared/src/attestation.ts`.

## 5. Follow-ups

None open.
