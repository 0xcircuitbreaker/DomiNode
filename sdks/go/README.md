# DominusNode Go SDK (v2)

Go client for the DominusNode relay network. Standard library only, Go 1.22+.
Implements the language-neutral contract in `sdks/SDK_SURFACE.md`
(15 resources, 71 methods); the reference implementation is `sdks/node`.

```bash
go get github.com/0xcircuitbreaker/DomiNode/sdks/go/v2@v2.0.1
```

Defaults: API `https://api.dominusnode.daedalusdevelopmentgroup.com`, relay gateway `proxy.dominusnode.daedalusdevelopmentgroup.com` (HTTP proxy :8080, SOCKS5 :1080). Both can be overridden in the client configuration.

`go get` resolves through proxy.golang.org, which only serves public
repositories. While the DomiNode repository is private, set
`GOPRIVATE=github.com/0xcircuitbreaker/DomiNode` and give the go command
HTTPS credentials with read access to it.

v2 is a breaking release: the module path gained the `/v2` suffix, and plans,
slots, admin, Stripe/PayPal top-ups, email/password login, human MFA and the
legacy `dc-`/`residential-`/`auto-` proxy prefixes were removed. Prices are no
longer hardcoded; read them from `Network.Pricing` or `X402.GetInfo`.

## Quick start

```go
ctx := context.Background()
c, err := dominusnode.NewClient(dominusnode.Config{})
if err != nil { log.Fatal(err) }
if _, err := c.ConnectWithKey(ctx, os.Getenv("DOMINUSNODE_API_KEY")); err != nil { log.Fatal(err) }
defer c.Disconnect(ctx)

res, err := c.Proxy.Fetch(ctx, "https://example.com", dominusnode.FetchOptions{
	Routing: dominusnode.RoutingOptions{Country: "US", IPClass: "residential"},
})
fmt.Println(res.Status, res.Text())

pricing, _ := c.Network.Pricing(ctx)
```

## Resources

| Field | Methods |
|---|---|
| `Auth` | VerifyKey, Refresh, Logout, Me |
| `WalletAuth` | Challenge, Verify, SignIn, Link |
| `Keys` | Create, List, Revoke |
| `Wallet` | GetBalance, GetTransactions, GetForecast, TopUpCrypto, GetCryptoStatus |
| `AgenticWallets` | Create, List, Get, Fund, UpdateWalletPolicy, Transactions, Freeze, Unfreeze, Delete |
| `Teams` | Create, List, Get, Update, Delete, FundWallet, GetTransactions, ListMembers, AddMember, UpdateMemberRole, RemoveMember, CreateInvite, ListInvites, CancelInvite, AcceptInvite, CreateKey, ListKeys, RevokeKey |
| `Usage` | Get, GetDaily, GetTopHosts, ExportCSV |
| `Sessions` | GetActive, Report |
| `X402` | GetInfo |
| `Network` | Policy, Pricing, Stats |
| `Nodes` | RegisterChallenge, Register, List, Revoke, UpdateCaps, Tier |
| `Credits` | Balance, Transactions, Convert, Withdraw |
| `PayoutWallet` | Get, Set |
| `Payouts` | List |
| `Proxy` | BuildUsername, BuildURL, Fetch, GetHealth, GetConfig |

Client members: `ConnectWithKey`, `Disconnect`, `IsConnected`.
Every method takes `context.Context` first. Optional integers are `*int`
(use `dominusnode.Int(5)`); optional cents are `*int64` (`dominusnode.Int64`).

## Signers

The SDK has no crypto dependency. Supply an EIP-191 (`personal_sign`) signer:

```go
signer := dominusnode.SignerFunc{
	Addr: wallet.Address,
	Sign: func(ctx context.Context, msg string) (string, error) { return wallet.PersonalSign(msg) },
}
node, err := c.Nodes.Register(ctx, dominusnode.RegisterNodeOptions{Signer: signer})
fmt.Println(node.NodeKey) // [REDACTED]; node.NodeKey.Reveal() for the value
```

For node registration, withdrawals and payout-wallet changes the SDK rebuilds
the message locally byte-for-byte and refuses (`*ProtocolError`) without calling
the signer if the server's message differs.

## Money

- Cents arguments: `int64`, `0 < x <= 2,147,483,647` (or `>= 0` where noted).
- µUSD arguments (`Credits.Convert`, `WithdrawOptions.AmountMusd`): `*big.Int`, a
  digit string, or a Go integer — never a float. Sent as decimal strings.
- Server amounts are `Money{Musd, Usd}` strings.

## Errors

All errors match `*dominusnode.DominusNodeError` with `errors.As`, plus a
specific type: `ValidationError` (400 or client-side `INVALID_ARGUMENT`),
`AuthenticationError`, `InsufficientBalanceError`, `AuthorizationError`,
`NotFoundError`, `ConflictError`, `RateLimitError` (`RetryAfterSeconds`),
`ServerError`, `NetworkError`, `ProtocolError`, `ProxyError`. `Code` carries the
server code (e.g. `INVALID_CHALLENGE`, `MFA_REQUIRED`); `Details` carries
`max`/`cap`/`limitPerDay`. API keys, node keys and JWTs are scrubbed from every message.

## Security behaviour

- Redirects are never followed (a caller-supplied `http.Client` is copied and its
  `CheckRedirect` replaced); bodies are capped at 10 MB; a 429 is retried once
  (`min(Retry-After, 10s)` ±10 %, floor 100 ms); a 401 on JWT auth triggers one refresh.
- `Secret`, the client and the token manager print and marshal as `[REDACTED]`.
- `Disconnect` logs out (best effort) and clears the API key and both tokens.
- `Proxy.Fetch` allows only GET/HEAD to http(s) ports 80/443, refuses private,
  local and encoded-IP targets, resolves the host and refuses if ANY address is
  private (DNS rebinding), tunnels https with verified TLS >= 1.2, returns 3xx
  unfollowed, and requires `AllowHTTP` for plaintext http.
- `Proxy.BuildURL` returns a URL that contains your API key: do not log it.
- OFAC-sanctioned countries (CU, IR, KP, RU, SY) cannot be targeted.

## Tests

```bash
go test ./...
go vet ./...
```

`testdata/messages.json` is generated from the Node SDK builders by
`testdata/gen-messages.ts`.

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
