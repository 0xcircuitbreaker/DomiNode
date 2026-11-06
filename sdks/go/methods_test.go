package dominusnode

import (
	"context"
	"strings"
	"testing"
)

type methodCase struct {
	name   string
	resp   string
	call   func(ctx context.Context, c *Client) error
	method string
	path   string
	query  string
	body   string // "" = no body
	auth   string // none | jwt | agent
	header map[string]string
}

func e(_ any, err error) error { return err }

// TestEveryMethodRequest covers each API-calling method: HTTP method, path
// (incl. encoding), query, body and auth mode.
func TestEveryMethodRequest(t *testing.T) {
	id := testUUID
	odd := "a/b?c#d"
	oddEnc := "a%2Fb%3Fc%23d"
	cases := []methodCase{
		// auth (4)
		{name: "Auth.VerifyKey", call: func(x context.Context, c *Client) error { return e(c.Auth.VerifyKey(x, testKey)) },
			method: "POST", path: "/api/auth/verify-key", body: `{"apiKey":"` + testKey + `"}`, auth: "none"},
		{name: "Auth.Refresh", call: func(x context.Context, c *Client) error { return e(c.Auth.Refresh(x, "rt")) },
			method: "POST", path: "/api/auth/refresh", body: `{"refreshToken":"rt"}`, auth: "none"},
		{name: "Auth.Logout", call: func(x context.Context, c *Client) error { return c.Auth.Logout(x) },
			method: "POST", path: "/api/auth/logout", body: `{}`, auth: "jwt"},
		{name: "Auth.Me", call: func(x context.Context, c *Client) error { return e(c.Auth.Me(x)) },
			method: "GET", path: "/api/auth/me", auth: "jwt"},
		// walletAuth (3 here; SignIn in signer tests)
		{name: "WalletAuth.Challenge", call: func(x context.Context, c *Client) error { return e(c.WalletAuth.Challenge(x, testAddr)) },
			method: "POST", path: "/api/auth/wallet/challenge", body: `{"address":"` + testAddr + `"}`, auth: "none"},
		{name: "WalletAuth.Verify", call: func(x context.Context, c *Client) error { return e(c.WalletAuth.Verify(x, testAddr, testSig)) },
			method: "POST", path: "/api/auth/wallet/verify", body: `{"address":"` + testAddr + `","signature":"` + testSig + `"}`, auth: "none"},
		{name: "WalletAuth.Link", call: func(x context.Context, c *Client) error { return e(c.WalletAuth.Link(x, testAddr, testSig)) },
			method: "POST", path: "/api/auth/wallet/link", body: `{"address":"` + testAddr + `","signature":"` + testSig + `"}`, auth: "jwt"},
		// keys (3)
		{name: "Keys.Create", call: func(x context.Context, c *Client) error { return e(c.Keys.Create(x, "")) },
			method: "POST", path: "/api/keys", body: `{"label":"Default"}`, auth: "jwt"},
		{name: "Keys.List", call: func(x context.Context, c *Client) error { return e(c.Keys.List(x)) },
			method: "GET", path: "/api/keys", auth: "jwt"},
		{name: "Keys.Revoke", call: func(x context.Context, c *Client) error { return c.Keys.Revoke(x, odd) },
			method: "DELETE", path: "/api/keys/" + oddEnc, auth: "jwt"},
		// wallet (5)
		{name: "Wallet.GetBalance", call: func(x context.Context, c *Client) error { return e(c.Wallet.GetBalance(x)) },
			method: "GET", path: "/api/wallet", auth: "jwt"},
		{name: "Wallet.GetTransactions", call: func(x context.Context, c *Client) error { return e(c.Wallet.GetTransactions(x, Int(5), Int(10))) },
			method: "GET", path: "/api/wallet/transactions", query: "limit=5&offset=10", auth: "jwt"},
		{name: "Wallet.GetForecast", call: func(x context.Context, c *Client) error { return e(c.Wallet.GetForecast(x)) },
			method: "GET", path: "/api/wallet/forecast", auth: "jwt"},
		{name: "Wallet.TopUpCrypto", call: func(x context.Context, c *Client) error { return e(c.Wallet.TopUpCrypto(x, 1050, "USDC")) },
			method: "POST", path: "/api/wallet/topup/crypto", body: `{"amountUsd":10.5,"currency":"usdc"}`, auth: "jwt"},
		{name: "Wallet.GetCryptoStatus", call: func(x context.Context, c *Client) error { return e(c.Wallet.GetCryptoStatus(x, id)) },
			method: "GET", path: "/api/wallet/crypto/status/" + id, auth: "jwt"},
		// agenticWallets (9)
		{name: "AgenticWallets.Create", call: func(x context.Context, c *Client) error {
			return e(c.AgenticWallets.Create(x, "bot", CreateAgenticWalletOptions{DailyLimitCents: Int64(0), AllowedDomains: []string{"a.com"}}))
		}, method: "POST", path: "/api/agent-wallet", body: `{"label":"bot","spendingLimitCents":10000,"dailyLimitCents":0,"allowedDomains":["a.com"]}`, auth: "jwt"},
		{name: "AgenticWallets.List", call: func(x context.Context, c *Client) error { return e(c.AgenticWallets.List(x)) },
			method: "GET", path: "/api/agent-wallet", auth: "jwt"},
		{name: "AgenticWallets.Get", call: func(x context.Context, c *Client) error { return e(c.AgenticWallets.Get(x, odd)) },
			method: "GET", path: "/api/agent-wallet/" + oddEnc, auth: "jwt"},
		{name: "AgenticWallets.Fund", call: func(x context.Context, c *Client) error { return e(c.AgenticWallets.Fund(x, id, 500)) },
			method: "POST", path: "/api/agent-wallet/" + id + "/fund", body: `{"amountCents":500}`, auth: "jwt"},
		{name: "AgenticWallets.UpdateWalletPolicy", call: func(x context.Context, c *Client) error {
			return e(c.AgenticWallets.UpdateWalletPolicy(x, id, WalletPolicy{DailyLimitCents: Int64(100)}))
		}, method: "PATCH", path: "/api/agent-wallet/" + id + "/policy", body: `{"dailyLimitCents":100}`, auth: "jwt"},
		{name: "AgenticWallets.Transactions", call: func(x context.Context, c *Client) error { return e(c.AgenticWallets.Transactions(x, id, Int(3), nil)) },
			method: "GET", path: "/api/agent-wallet/" + id + "/transactions", query: "limit=3", auth: "jwt"},
		{name: "AgenticWallets.Freeze", call: func(x context.Context, c *Client) error { return e(c.AgenticWallets.Freeze(x, id)) },
			method: "POST", path: "/api/agent-wallet/" + id + "/freeze", body: `{}`, auth: "jwt"},
		{name: "AgenticWallets.Unfreeze", call: func(x context.Context, c *Client) error { return e(c.AgenticWallets.Unfreeze(x, id)) },
			method: "POST", path: "/api/agent-wallet/" + id + "/unfreeze", body: `{}`, auth: "jwt"},
		{name: "AgenticWallets.Delete", call: func(x context.Context, c *Client) error { return e(c.AgenticWallets.Delete(x, id)) },
			method: "DELETE", path: "/api/agent-wallet/" + id, auth: "jwt"},
		// teams (18)
		{name: "Teams.Create", call: func(x context.Context, c *Client) error { return e(c.Teams.Create(x, "t", Int(5))) },
			method: "POST", path: "/api/teams", body: `{"name":"t","maxMembers":5}`, auth: "jwt"},
		{name: "Teams.List", call: func(x context.Context, c *Client) error { return e(c.Teams.List(x)) },
			method: "GET", path: "/api/teams", auth: "jwt"},
		{name: "Teams.Get", call: func(x context.Context, c *Client) error { return e(c.Teams.Get(x, odd)) },
			method: "GET", path: "/api/teams/" + oddEnc, auth: "jwt"},
		{name: "Teams.Update", call: func(x context.Context, c *Client) error {
			n := "n"
			return e(c.Teams.Update(x, id, TeamUpdate{Name: &n}))
		}, method: "PATCH", path: "/api/teams/" + id, body: `{"name":"n"}`, auth: "jwt"},
		{name: "Teams.Delete", call: func(x context.Context, c *Client) error { return e(c.Teams.Delete(x, id)) },
			method: "DELETE", path: "/api/teams/" + id, auth: "jwt"},
		{name: "Teams.FundWallet", call: func(x context.Context, c *Client) error { return e(c.Teams.FundWallet(x, id, 700)) },
			method: "POST", path: "/api/teams/" + id + "/wallet/fund", body: `{"amountCents":700}`, auth: "jwt"},
		{name: "Teams.GetTransactions", call: func(x context.Context, c *Client) error { return e(c.Teams.GetTransactions(x, id, nil, Int(2))) },
			method: "GET", path: "/api/teams/" + id + "/wallet/transactions", query: "offset=2", auth: "jwt"},
		{name: "Teams.ListMembers", call: func(x context.Context, c *Client) error { return e(c.Teams.ListMembers(x, id)) },
			method: "GET", path: "/api/teams/" + id + "/members", auth: "jwt"},
		{name: "Teams.AddMember", call: func(x context.Context, c *Client) error { return e(c.Teams.AddMember(x, id, "a@b.c", "admin")) },
			method: "POST", path: "/api/teams/" + id + "/members", body: `{"email":"a@b.c","role":"admin"}`, auth: "jwt"},
		{name: "Teams.UpdateMemberRole", call: func(x context.Context, c *Client) error { return e(c.Teams.UpdateMemberRole(x, id, odd, "member")) },
			method: "PATCH", path: "/api/teams/" + id + "/members/" + oddEnc, body: `{"role":"member"}`, auth: "jwt"},
		{name: "Teams.RemoveMember", call: func(x context.Context, c *Client) error { return c.Teams.RemoveMember(x, id, id) },
			method: "DELETE", path: "/api/teams/" + id + "/members/" + id, auth: "jwt"},
		{name: "Teams.CreateInvite", call: func(x context.Context, c *Client) error { return e(c.Teams.CreateInvite(x, id, "a@b.c", "")) },
			method: "POST", path: "/api/teams/" + id + "/invites", body: `{"email":"a@b.c"}`, auth: "jwt"},
		{name: "Teams.ListInvites", call: func(x context.Context, c *Client) error { return e(c.Teams.ListInvites(x, id)) },
			method: "GET", path: "/api/teams/" + id + "/invites", auth: "jwt"},
		{name: "Teams.CancelInvite", call: func(x context.Context, c *Client) error { return c.Teams.CancelInvite(x, id, odd) },
			method: "DELETE", path: "/api/teams/" + id + "/invites/" + oddEnc, auth: "jwt"},
		{name: "Teams.AcceptInvite", call: func(x context.Context, c *Client) error { return e(c.Teams.AcceptInvite(x, odd)) },
			method: "POST", path: "/api/teams/invites/" + oddEnc + "/accept", body: `{}`, auth: "jwt"},
		{name: "Teams.CreateKey", call: func(x context.Context, c *Client) error { return e(c.Teams.CreateKey(x, id, "ci")) },
			method: "POST", path: "/api/teams/" + id + "/keys", body: `{"label":"ci"}`, auth: "jwt"},
		{name: "Teams.ListKeys", call: func(x context.Context, c *Client) error { return e(c.Teams.ListKeys(x, id)) },
			method: "GET", path: "/api/teams/" + id + "/keys", auth: "jwt"},
		{name: "Teams.RevokeKey", call: func(x context.Context, c *Client) error { return c.Teams.RevokeKey(x, id, odd) },
			method: "DELETE", path: "/api/teams/" + id + "/keys/" + oddEnc, auth: "jwt"},
		// usage (4)
		{name: "Usage.Get", call: func(x context.Context, c *Client) error {
			return e(c.Usage.Get(x, DateRange{From: "2026-01-01T00:00:00Z", To: "2026-02-01"}, Int(10), Int(0)))
		}, method: "GET", path: "/api/usage", query: "since=2026-01-01T00%3A00%3A00Z&until=2026-02-01&limit=10&offset=0", auth: "jwt"},
		{name: "Usage.GetDaily", call: func(x context.Context, c *Client) error { return e(c.Usage.GetDaily(x, DateRange{From: "2026-01-01"})) },
			method: "GET", path: "/api/usage/daily", query: "since=2026-01-01", auth: "jwt"},
		{name: "Usage.GetTopHosts", call: func(x context.Context, c *Client) error { return e(c.Usage.GetTopHosts(x, DateRange{}, Int(7))) },
			method: "GET", path: "/api/usage/top-hosts", query: "limit=7", auth: "jwt"},
		{name: "Usage.ExportCSV", call: func(x context.Context, c *Client) error { return e(c.Usage.ExportCSV(x, DateRange{To: "2026-02-01"})) },
			method: "GET", path: "/api/usage/export", query: "until=2026-02-01", auth: "jwt"},
		// sessions (2)
		{name: "Sessions.GetActive", call: func(x context.Context, c *Client) error { return e(c.Sessions.GetActive(x)) },
			method: "GET", path: "/api/sessions/active", auth: "jwt"},
		{name: "Sessions.Report", call: func(x context.Context, c *Client) error { return e(c.Sessions.Report(x, id, "captcha")) },
			method: "POST", path: "/v1/sessions/" + id + "/report", body: `{"reason":"captcha"}`, auth: "agent"},
		// x402 (1)
		{name: "X402.GetInfo", call: func(x context.Context, c *Client) error { return e(c.X402.GetInfo(x)) },
			method: "GET", path: "/api/x402/info", auth: "none"},
		// network (3)
		{name: "Network.Policy", call: func(x context.Context, c *Client) error { return e(c.Network.Policy(x)) },
			method: "GET", path: "/v1/policy", auth: "none"},
		{name: "Network.Pricing", call: func(x context.Context, c *Client) error { return e(c.Network.Pricing(x)) },
			method: "GET", path: "/v1/pricing", auth: "none"},
		{name: "Network.Stats", call: func(x context.Context, c *Client) error { return e(c.Network.Stats(x)) },
			method: "GET", path: "/v1/network/stats", auth: "none"},
		// nodes (5 here; Register in signer tests)
		{name: "Nodes.RegisterChallenge", call: func(x context.Context, c *Client) error {
			return e(c.Nodes.RegisterChallenge(x, strings.Repeat("AB", 32)))
		},
			method: "POST", path: "/v1/nodes/challenge", body: `{"nodePubkey":"` + strings.Repeat("ab", 32) + `"}`, auth: "agent"},
		{name: "Nodes.RegisterChallenge(empty)", call: func(x context.Context, c *Client) error { return e(c.Nodes.RegisterChallenge(x, "")) },
			method: "POST", path: "/v1/nodes/challenge", body: `{}`, auth: "agent"},
		{name: "Nodes.List", call: func(x context.Context, c *Client) error { return e(c.Nodes.List(x, Int(500), Int(1))) },
			method: "GET", path: "/v1/nodes", query: "limit=500&offset=1", auth: "agent"},
		{name: "Nodes.Revoke", call: func(x context.Context, c *Client) error { return e(c.Nodes.Revoke(x, id)) },
			method: "DELETE", path: "/v1/nodes/" + id, auth: "agent"},
		{name: "Nodes.UpdateCaps", call: func(x context.Context, c *Client) error {
			return e(c.Nodes.UpdateCaps(x, id, NodeCaps{GbPerDay: Int(10)}))
		},
			method: "PATCH", path: "/v1/nodes/" + id, body: `{"gbPerDay":10}`, auth: "agent"},
		{name: "Nodes.Tier", call: func(x context.Context, c *Client) error { return e(c.Nodes.Tier(x)) },
			method: "GET", path: "/v1/node/tier", auth: "agent"},
		// credits (3 here; Withdraw in signer tests)
		{name: "Credits.Balance", call: func(x context.Context, c *Client) error { return e(c.Credits.Balance(x)) },
			method: "GET", path: "/v1/credits", auth: "agent"},
		{name: "Credits.Transactions", call: func(x context.Context, c *Client) error {
			return e(c.Credits.Transactions(x, CreditTransactionsQuery{Limit: Int(200), Cursor: "123", Type: "withdraw_reversal"}))
		}, method: "GET", path: "/v1/credits/transactions", query: "limit=200&cursor=123&type=withdraw_reversal", auth: "agent"},
		{name: "Credits.Convert", call: func(x context.Context, c *Client) error { return e(c.Credits.Convert(x, int64(10_000), "my-key-123")) },
			method: "POST", path: "/v1/credits/convert", body: `{"amountMusd":"10000"}`, auth: "agent",
			header: map[string]string{"Idempotency-Key": "my-key-123"}},
		// payoutWallet (1 here; Set in signer tests)
		{name: "PayoutWallet.Get", call: func(x context.Context, c *Client) error { return e(c.PayoutWallet.Get(x)) },
			method: "GET", path: "/v1/payout-wallet", auth: "agent"},
		// payouts (1)
		{name: "Payouts.List", call: func(x context.Context, c *Client) error { return e(c.Payouts.List(x, Int(1), Int(1_000_000))) },
			method: "GET", path: "/v1/payouts", query: "limit=1&offset=1000000", auth: "agent"},
		// proxy (2 HTTP methods; BuildUsername/BuildURL/Fetch in proxy tests)
		{name: "Proxy.GetHealth", call: func(x context.Context, c *Client) error { return e(c.Proxy.GetHealth(x)) },
			method: "GET", path: "/api/proxy/health", auth: "none"},
		{name: "Proxy.GetConfig", call: func(x context.Context, c *Client) error { return e(c.Proxy.GetConfig(x)) },
			method: "GET", path: "/api/proxy/config", auth: "jwt"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			c, rt := newTestClient(t)
			resp := tc.resp
			if resp == "" {
				resp = `{}`
			}
			if strings.HasPrefix(tc.name, "Keys.Create") || strings.HasPrefix(tc.name, "Teams.CreateKey") {
				resp = `{"id":"k","key":"` + testKey + `"}`
			}
			rt.push(ok(resp))
			if err := tc.call(context.Background(), c); err != nil {
				t.Fatalf("call: %v", err)
			}
			if len(rt.reqs) != 1 {
				t.Fatalf("sent %d requests", len(rt.reqs))
			}
			r := rt.last(t)
			if r.Method != tc.method || r.Path != tc.path || r.Query != tc.query {
				t.Fatalf("got %s %s?%s, want %s %s?%s", r.Method, r.Path, r.Query, tc.method, tc.path, tc.query)
			}
			jsonEq(t, r.Body, tc.body)
			if (tc.body != "") != (r.Header.Get("Content-Type") == "application/json") {
				t.Fatalf("Content-Type %q with body %q", r.Header.Get("Content-Type"), tc.body)
			}
			if r.Header.Get("User-Agent") != "dominusnode-sdk-go/2.0.0" || r.Header.Get("Accept") != "application/json" {
				t.Fatalf("bad UA/Accept: %v", r.Header)
			}
			got := r.Header.Get("Authorization")
			want := map[string]string{"none": "", "jwt": "Bearer " + accessJWT, "agent": "Bearer " + testKey}[tc.auth]
			if got != want {
				t.Fatalf("Authorization = %q, want mode %s", got, tc.auth)
			}
			for k, v := range tc.header {
				if r.Header.Get(k) != v {
					t.Fatalf("header %s = %q, want %q", k, r.Header.Get(k), v)
				}
			}
		})
	}
}

func TestAgentModeFallsBackToWalletJWT(t *testing.T) {
	c, rt := newTestClient(t)
	c.apiKey = ""
	rt.push(ok(`{}`))
	if _, err := c.Credits.Balance(context.Background()); err != nil {
		t.Fatal(err)
	}
	if rt.last(t).Header.Get("Authorization") != "Bearer "+accessJWT {
		t.Fatal("agent mode without key must use the wallet JWT")
	}
}

func TestNoCredentialSendsNothing(t *testing.T) {
	c, rt := bareClient(t)
	_, err := c.Auth.Me(context.Background())
	if !isType[*AuthenticationError](err) || len(rt.reqs) != 0 {
		t.Fatalf("err=%v reqs=%d", err, len(rt.reqs))
	}
	_, err = c.Credits.Balance(context.Background())
	if !isType[*AuthenticationError](err) || len(rt.reqs) != 0 {
		t.Fatalf("agent: err=%v", err)
	}
}

func TestResponsesDecode(t *testing.T) {
	c, rt := newTestClient(t)
	ctx := context.Background()
	rt.push(ok(`{"sessions":[{"id":"s1","startedAt":"t","status":"active","proxyIp":"1.2.3.4","nodeIp":"5.6.7.8"}]}`))
	s, err := c.Sessions.GetActive(ctx)
	if err != nil || len(s.Sessions) != 1 || s.Sessions[0] != (ActiveSession{"s1", "t", "active"}) {
		t.Fatalf("GetActive = %+v %v", s, err)
	}
	rt.push(ok(`{"tier":{"id":1,"name":"probation","rank":0,"nodeShareBps":2500,"holdDays":14,"maxNodes":3,"dailyWithdrawLimitMusd":"100000000"},"nextTier":null,"progress":null,"changedAt":null,"uptimeGraceUntil":null,"demotionReason":null}`))
	tier, err := c.Nodes.Tier(ctx)
	if err != nil || tier.Tier.DailyWithdrawLimitMusd != "100000000" {
		t.Fatalf("tier %+v %v", tier, err)
	}
	rt.push(mockResp{status: 200, body: "a,b\n1,2\n"})
	csv, err := c.Usage.ExportCSV(ctx, DateRange{})
	if err != nil || csv != "a,b\n1,2\n" {
		t.Fatalf("csv %q %v", csv, err)
	}
	rt.push(mockResp{status: 200, body: ""})
	if _, err := c.Auth.Me(ctx); err != nil {
		t.Fatalf("empty body must decode as {}: %v", err)
	}
	rt.push(ok(`{"policy":{"__proto__":{"x":1},"constructor":2,"ok":{"prototype":3,"y":4}}}`))
	cfg, err := c.Proxy.GetConfig(ctx)
	if err != nil {
		t.Fatal(err)
	}
	pol := cfg["policy"].(map[string]any)
	if _, bad := pol["__proto__"]; bad || pol["constructor"] != nil || pol["ok"].(map[string]any)["prototype"] != nil {
		t.Fatalf("dangerous keys not stripped: %v", cfg)
	}
	rt.push(mockResp{status: 200, body: "{not json"})
	if _, err := c.Auth.Me(ctx); !isType[*ServerError](err) {
		t.Fatalf("invalid JSON -> ServerError, got %v", err)
	}
}

func TestSecretsWrapped(t *testing.T) {
	c, rt := newTestClient(t)
	rt.push(ok(`{"id":"k1","prefix":"dn_live_","label":"x","created_at":"t","key":"` + testKey + `"}`))
	k, err := c.Keys.Create(context.Background(), "x")
	if err != nil || k.Key.Reveal() != testKey || k.Key.String() != "[REDACTED]" {
		t.Fatalf("%v %v", k, err)
	}
	rt.push(ok(`{"id":"k2","keyPrefix":"dn_live_","label":"ci","key":"` + testKey + `"}`))
	tk, err := c.Teams.CreateKey(context.Background(), testUUID, "ci")
	if err != nil || tk.Key.Reveal() != testKey {
		t.Fatalf("%v %v", tk, err)
	}
}
