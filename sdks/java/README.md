# Dominus Node Java SDK

Java client for the DominusNode relay network, built for AI agents and node operators.
It implements the language-neutral contract in [`sdks/SDK_SURFACE.md`](../SDK_SURFACE.md) (v2):
15 resources and 71 methods. The reference implementation is the Node SDK.

> Distributed via GitHub Packages (not yet on Maven Central).

## Requirements

- Java 11+
- Jackson Databind 2.17 (the only runtime dependency)

## Installation

The SDK is published to GitHub Packages, not Maven Central. GitHub Packages
always requires authentication for Maven, even for public packages: create a
personal access token (classic) with the `read:packages` scope and add it to
`~/.m2/settings.xml` (keep the token out of `pom.xml`):

```xml
<settings>
  <servers>
    <server>
      <id>github</id>
      <username>YOUR_GITHUB_USERNAME</username>
      <password>${env.GITHUB_TOKEN}</password>
    </server>
  </servers>
</settings>
```

Then in `pom.xml` (the repository `id` must match the server `id`):

```xml
<repositories>
  <repository>
    <id>github</id>
    <url>https://maven.pkg.github.com/0xcircuitbreaker/DomiNode</url>
  </repository>
</repositories>

<dependency>
  <groupId>io.dominusnode</groupId>
  <artifactId>dominusnode-sdk</artifactId>
  <version>2.0.1</version>
</dependency>
```

## Quick start

```java
try (DominusNodeClient dn = new DominusNodeClient()) {
    dn.connectWithKey(System.getenv("DOMINUSNODE_API_KEY"));

    JsonNode pricing = dn.network().pricing();          // live per-GB prices (µUSD strings)
    FetchResponse r = dn.proxy().fetch("https://example.com",
            ProxyOptions.create().country("US").ipClass("residential"));
    System.out.println(r.status + " " + r.text());
}
```

`connectWithKey` returns `ConnectResult{mfaRequired, userId}`. With MFA on, only the key is kept:
`/v1` agent routes and the proxy work, JWT-only `/api` routes raise `AuthenticationException`.

## Configuration

```java
Config cfg = Config.builder()
        .baseUrl("https://api.dominusnode.daedalusdevelopmentgroup.com")     // http(s), no userinfo
        .proxyHost("proxy.dominusnode.daedalusdevelopmentgroup.com")
        .httpProxyPort(8080).socks5ProxyPort(1080)
        .tokens(accessJwt, refreshJwt)               // optional existing JWT pair
        .transport(myTransport)                      // optional; must not follow redirects
        .build();
```

## Resources

| Accessor | Methods |
|---|---|
| `auth()` | verifyKey, refresh, logout, me |
| `walletAuth()` | challenge, verify, signIn, link |
| `keys()` | create, list, revoke |
| `wallet()` | getBalance, getTransactions, getForecast, topUpCrypto, getCryptoStatus |
| `agenticWallets()` | create, list, get, fund, updateWalletPolicy, transactions, freeze, unfreeze, delete |
| `teams()` | create, list, get, update, delete, fundWallet, getTransactions, listMembers, addMember, updateMemberRole, removeMember, createInvite, listInvites, cancelInvite, acceptInvite, createKey, listKeys, revokeKey |
| `usage()` | get, getDaily, getTopHosts, exportCsv |
| `sessions()` | getActive, report |
| `x402()` | getInfo |
| `network()` | policy, pricing, stats |
| `nodes()` | registerChallenge, register, list, revoke, updateCaps, tier |
| `credits()` | balance, transactions, convert, withdraw |
| `payoutWallet()` | get, set |
| `payouts()` | list |
| `proxy()` | buildUsername, buildUrl, fetch, getHealth, getConfig |

Most results are Jackson `JsonNode` trees mirroring the server JSON. Typed results are used where
the SDK must control the shape: `ConnectResult`, `KeysResource.CreatedKey`, `TeamsResource.CreatedTeamKey`,
`NodesResource.RegisteredNode`, `SessionsResource.ActiveSession` (id, startedAt, status only) and `FetchResponse`.

## Money

- Cents arguments are `long`, validated `0 < x <= 2,147,483,647` (or `>= 0` where noted).
- µUSD arguments (`credits().convert`, `credits().withdraw`) accept a `BigInteger`, a digit string or a `long`
  and are sent as decimal strings. Floats are refused. 1 USD = 1,000,000 µUSD.
- The SDK hardcodes no prices: use `network().pricing()` and `x402().getInfo()`.

## Signers

Signing is done by your code through a functional interface; the SDK has no crypto dependency.

```java
Signer signer = Signer.of(credentials.getAddress(), message -> personalSign(message)); // EIP-191
NodesResource.RegisteredNode node = dn.nodes().register(
        new NodesResource.RegisterOptions(signer).nodePubkey(pubkeyHex).maxStreams(16));
String nodeKey = node.nodeKey.reveal(); // returned once; store it 0600
```

For node registration, withdrawal and payout-wallet changes, the SDK rebuilds the message from values it
knows and compares it with the server's `message`. On any difference it raises `ProtocolException`
without calling the signer. Signatures returned by the signer are format-checked (0x + 130 hex).

## Proxy

Routing flags go in the proxy username (`country-XX`, `class-residential|dc|mobile`, `session-<id>`,
`wallet-<uuid>`, `allowhttp-1`); OFAC-sanctioned countries (CU, IR, KP, RU, SY) are refused.
`buildUrl` returns `http://<user>:<key>@host:8080` or `socks5://...:1080`. The URL contains your API key,
so do not log it.

`fetch` allows GET and HEAD only, on ports 80/443. It refuses local names and private IP literals in
any spelling, resolves the hostname and refuses if any address is private (DNS-rebinding check), never
follows redirects, caps bodies at 10 MB (`truncated`), and needs `allowHttp(true)` for `http://`.
HTTPS goes through a CONNECT tunnel with full TLS verification.

## Errors

All exceptions are unchecked and extend `DominusNodeException` (`getStatusCode()`, `getCode()`, `getDetails()`):
`ValidationException` (400 or client-side, code `INVALID_ARGUMENT`), `AuthenticationException` (401 or no
credential), `InsufficientBalanceException` (402), `AuthorizationException` (403), `NotFoundException` (404),
`ConflictException` (409), `RateLimitException` (429, `getRetryAfterSeconds()`), `ServerException` (5xx,
oversize or invalid JSON), `NetworkException`, `ProtocolException`, `ProxyException`.
Messages are scrubbed of `dn_live_`/`dn_test_`/`dn_node_`/`dn_proxy_` keys and JWTs.

## HTTP behaviour

java.net.http with `Redirect.NEVER`, 30 s timeout, 10 MB response cap, one 429 retry
(`min(Retry-After, 10 s)` ±10 %, floor 100 ms), one JWT refresh after a 401 (never for API-key auth).

## Credentials

`disconnect()` (also `close()`) logs out best-effort when a JWT is held, then overwrites the stored
API key and tokens (held as `char[]`). `Secret`, the client and the token manager print `[REDACTED]`.

## Building

```bash
mvn test
```

## License

MIT

## Node registration and the client IP

The node-registration proof-of-work is bound to the client IP that requested it.
Call the register-challenge and register methods from the same egress (same machine,
same outbound IP, no proxy or VPN switch in between); otherwise the server rejects
the solution with `INVALID_CHALLENGE`. Register from the host that will run the node.

## Troubleshooting

| Symptom | Meaning | What to do |
|---|---|---|
| HTTP 402 | API call: requester or agentic wallet balance is too low | Top up with crypto or fund the agentic wallet |
| HTTP 407 (proxy) | Gateway rejected the proxy credentials | Check the API key in the proxy password and the username flags (`country-XX-class-dc-...`, or `relay`) |
| `EMAIL_NOT_VERIFIED` | The route needs a verified account | Verify the account before financial calls |
| `NO_NODES_AVAILABLE` | No eligible exit node for the requested country/class | Relax the country/class flags or retry later; check network stats |
| `PAYOUTS_DISABLED` | Withdrawals are switched off server-side | Keep earning; the credits balance `payoutsEnabled` field shows the state |
| `REPORT_LIMIT` | Per-node daily session-report cap reached (HTTP 409 conflict error; older servers 429) | Do not retry today; the SDK never retries it |
