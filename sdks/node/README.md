# @dominusnode/sdk

Official Node.js/TypeScript SDK for the **DominusNode relay network**: AI agents
buy exit traffic per GB and earn credits by running relay nodes.

- Zero runtime dependencies (Node >= 18 `fetch`, `node:http`, `node:crypto`)
- Dual ESM + CJS, TypeScript strict, full type definitions
- Reference implementation of [`sdks/SDK_SURFACE.md`](../SDK_SURFACE.md)

```bash
npm install @dominusnode/sdk
```

## Quick start

```ts
import { DominusNodeClient } from "@dominusnode/sdk";

const dn = new DominusNodeClient();
await dn.connectWithKey(process.env.DOMINUSNODE_API_KEY!); // dn_live_...

// Fetch through the relay (GET/HEAD, https via CONNECT, 10 MB cap, no redirects)
const res = await dn.proxy.fetch("https://example.com/", { country: "US", ipClass: "residential" });
console.log(res.status, res.text().slice(0, 200));

// Or hand a proxy URL to any HTTP client (the URL contains your key: do not log it)
const proxyUrl = dn.proxy.buildUrl({ country: "DE", sessionId: "job42" });
// http://country-DE-session-job42:dn_live_...@proxy.dominusnode.daedalusdevelopmentgroup.com:8080
```

Routing flags go in the proxy **username**, hyphen-joined; the API key is the **password**:

| Option | Username flag |
|---|---|
| `country: "US"` | `country-US` (OFAC countries CU, IR, KP, RU, SY are refused) |
| `ipClass: "residential" \| "dc" \| "mobile"` | `class-residential` |
| `sessionId: "abc123"` (1-64 alphanumeric) | `session-abc123` (sticky exit) |
| `allowHttp: true` | `allowhttp-1` (plaintext `http://` is exit-visible) |
| `agenticWalletId: "<uuid>"` | `wallet-<uuid>` (spend from an agentic wallet) |
| none | `relay` |

Prices are live: `await dn.network.pricing()` returns µUSD per GB by IP class.

## Authentication

```ts
await dn.connectWithKey("dn_live_...");           // API key (recommended for agents)
await dn.walletAuth.signIn(signer);                // or EIP-191 wallet sign-in
await dn.disconnect();                             // revokes and clears every credential
```

`connectWithKey` returns `{ mfaRequired }`. If the account has MFA, `/api` routes are
unavailable but all `/v1` agent routes and the proxy still work with the key.

## Signers (EIP-191)

Node registration, payout-wallet changes and withdrawals need a `personal_sign`
signature from the wallet linked to your account. The SDK stays dependency-free:
you pass a signer.

```ts
import { Wallet } from "ethers";
const w = new Wallet(process.env.WALLET_PRIVATE_KEY!);
const signer = { address: w.address, signMessage: (m: string) => w.signMessage(m) };
```

The SDK never signs a server string blindly. It rebuilds each message from values it
knows and throws `ProtocolError` (without calling your signer) if the server's text differs.

## Earning: run a relay node

```ts
const node = await dn.nodes.register({ signer, nodePubkey /* optional ed25519 hex */ });
saveSecurely(node.nodeId, node.nodeKey.reveal()); // dn_node_ key, shown ONCE
console.log(node.nodeKey);                        // Secret([REDACTED])

await dn.nodes.list();
await dn.nodes.updateCaps(node.nodeId, { maxStreams: 8 }); // lower only
await dn.nodes.tier();
await dn.nodes.revoke(node.nodeId);
```

`register` fetches a challenge, checks the attestation text, solves the proof of work
locally, asks your signer, and submits.

## Credits and payouts (µUSD)

Money is `{ musd: "<integer string>", usd: "<6 decimals>" }`; 1 USD = 1,000,000 µUSD.
Amount arguments accept `bigint`, digit strings or safe integers.

```ts
await dn.credits.balance();
await dn.credits.transactions({ limit: 50, type: "earn" });
await dn.credits.convert(1_500_000n);                          // into your requester wallet
await dn.payoutWallet.set({ address: "0x...", signer });       // + oldWalletSigner when changing
await dn.credits.withdraw({ amountMusd: 2_000_000n, signer }); // returns idempotencyKey for retries
await dn.payouts.list();
```

## Resources

| Resource | Methods |
|---|---|
| `auth` | `verifyKey`, `refresh`, `logout`, `me` |
| `walletAuth` | `challenge`, `verify`, `signIn`, `link` |
| `keys` | `create`, `list`, `revoke` |
| `wallet` | `getBalance`, `getTransactions`, `getForecast`, `topUpCrypto`, `getCryptoStatus` |
| `agenticWallets` | `create`, `list`, `get`, `fund`, `updateWalletPolicy`, `transactions`, `freeze`, `unfreeze`, `delete` |
| `teams` | 18 methods: `create`, `list`, `get`, `update`, `delete`, `fundWallet`, `getTransactions`, `listMembers`, `addMember`, `updateMemberRole`, `removeMember`, `createInvite`, `listInvites`, `cancelInvite`, `acceptInvite`, `createKey`, `listKeys`, `revokeKey` |
| `usage` | `get`, `getDaily`, `getTopHosts`, `exportCsv` |
| `sessions` | `getActive`, `report` |
| `x402` | `getInfo` |
| `network` | `policy`, `pricing`, `stats` |
| `nodes` | `registerChallenge`, `register`, `list`, `revoke`, `updateCaps`, `tier` |
| `credits` | `balance`, `transactions`, `convert`, `withdraw` |
| `payoutWallet` | `get`, `set` |
| `payouts` | `list` |
| `proxy` | `buildUsername`, `buildUrl`, `fetch`, `getHealth`, `getConfig` |

## Errors

All errors extend `DominusNodeError` with `statusCode`, `code` (server code such as
`INVALID_CHALLENGE`, `PAYOUTS_DISABLED`, `CAP_ABOVE_DEFAULT`) and `details`.
Subclasses: `ValidationError` (400, or client-side with `code: "INVALID_ARGUMENT"`),
`AuthenticationError`, `InsufficientBalanceError`, `AuthorizationError`, `NotFoundError`,
`ConflictError`, `RateLimitError` (`retryAfterSeconds`), `ServerError`, `NetworkError`,
`ProtocolError`, `ProxyError`. Messages are scrubbed of `dn_live_`/`dn_test_`/`dn_node_`/`dn_proxy_` keys and JWTs.

## Security behaviour

- Redirects are never followed (API and `proxy.fetch`); responses are capped at 10 MB.
- One 429 retry: `min(Retry-After, 10s)` with ±10% jitter, at least 100 ms; the 429 body is cancelled.
- Path parameters are URL-encoded; amounts and ids are validated before any request.
- The client, token store and `Secret` print `[REDACTED]` in `toString`, JSON and `util.inspect`.
- `sessions.getActive()` returns only `id`, `startedAt`, `status` (never proxy or node IPs).
- JSON responses are stripped of `__proto__`/`constructor`/`prototype` keys.

## Development

```bash
npm install
npm run build
npm test
```

MIT License.
