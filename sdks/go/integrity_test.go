package dominusnode

import (
	"context"
	"encoding/json"
	"strings"
	"testing"
)

const teamID = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee"

func TestTeamKeyPrefix(t *testing.T) {
	c, rt := newTestClient(t)
	ctx := context.Background()
	rt.push(ok(`{"id":"k","prefix":"dn_live_ab","label":"l","key":"` + testKey + `"}`))
	k, err := c.Teams.CreateKey(ctx, teamID, "l")
	if err != nil || k.Prefix != "dn_live_ab" || k.KeyPrefix != "dn_live_ab" {
		t.Fatalf("%+v %v", k, err)
	}
	rt.push(ok(`{"id":"k","keyPrefix":"dn_live_cd","label":"l","key":"` + testKey + `"}`))
	if k, _ = c.Teams.CreateKey(ctx, teamID, "l"); k.Prefix != "dn_live_cd" || k.KeyPrefix != "dn_live_cd" {
		t.Fatalf("fallback: %+v", k)
	}
	rt.push(ok(`{"keys":[{"id":"k1","userId":"u1","prefix":"dn_live_x","label":"a","teamId":"` + teamID + `","createdAt":"t","revokedAt":null},
		{"id":"k2","userId":"u2","keyPrefix":"dn_live_y","label":"b","teamId":"` + teamID + `","createdAt":"t","revokedAt":"r"}]}`))
	ks, err := c.Teams.ListKeys(ctx, teamID)
	if err != nil {
		t.Fatal(err)
	}
	a, b := ks.Keys[0], ks.Keys[1]
	if a.Prefix != "dn_live_x" || a.UserID != "u1" || a.TeamID != teamID || a.RevokedAt != nil {
		t.Fatalf("%+v", a)
	}
	if b.Prefix != "dn_live_y" || b.KeyPrefix != "dn_live_y" || a.KeyPrefix != "dn_live_x" || b.RevokedAt == nil || *b.RevokedAt != "r" {
		t.Fatalf("%+v", b)
	}
}

func TestHealthStatusOnly(t *testing.T) {
	c, rt := bareClient(t)
	rt.push(ok(`{"status":"ok","activeSessions":3}`))
	h, err := c.Proxy.GetHealth(context.Background())
	if err != nil || h.Status != "ok" {
		t.Fatalf("%+v %v", h, err)
	}
	if h.ActiveSessions != 0 || h.UptimeSeconds != 0 {
		t.Fatalf("%+v", h)
	}
}

func TestCursorRegex(t *testing.T) {
	c, rt := newTestClient(t)
	for _, cur := range []string{"0", "01", strings.Repeat("1", 20), "-1", "1a"} {
		_, err := c.Credits.Transactions(context.Background(), CreditTransactionsQuery{Cursor: cur})
		wantInvalid(t, err, rt, 0)
	}
	rt.push(ok(`{"transactions":[],"nextCursor":null}`))
	if _, err := c.Credits.Transactions(context.Background(), CreditTransactionsQuery{Cursor: strings.Repeat("9", 19)}); err != nil {
		t.Fatal(err)
	}
}

func TestNewFields(t *testing.T) {
	c, rt := newTestClient(t)
	ctx := context.Background()
	rt.push(ok(`{"invites":[{"id":"i","invitedBy":"u9","email":"e"}]}`))
	inv, err := c.Teams.ListInvites(ctx, teamID)
	if err != nil || inv.Invites[0].InvitedBy != "u9" {
		t.Fatalf("%+v %v", inv, err)
	}
	rt.push(ok(`{"buyerDiscounts":[{"tier":"Partner","rank":4,"buyerDiscountBps":500}]}`),
		ok(`{"onlineNodes":2,"seed":{"online":1,"paidBytes24h":"1099511627776"},"community":{"online":1,"paidBytes24h":7}}`),
		ok(`{"buyerDiscountBps":250}`),
		ok(`{"tier":{"buyerDiscountBps":100},"nextTier":null}`))
	p, _ := c.Network.Pricing(ctx)
	s, err := c.Network.Stats(ctx)
	if err != nil {
		t.Fatal(err)
	}
	cb, _ := c.Credits.Balance(ctx)
	tier, _ := c.Nodes.Tier(ctx)
	if p.BuyerDiscounts[0].BuyerDiscountBps != 500 || s.Seed.PaidBytes24h != 1099511627776 || s.Community.PaidBytes24h != 7 ||
		cb.BuyerDiscountBps != 250 || tier.Tier.BuyerDiscountBps != 100 {
		t.Fatalf("%+v %+v %+v %+v", p, s, cb, tier)
	}
}

func TestByteCountTolerant(t *testing.T) {
	var r UsageResult
	err := json.Unmarshal([]byte(`{"summary":{"totalBytes":"12345678901"},"records":[{"bytesIn":5,"bytesOut":"6","totalBytes":null}]}`), &r)
	if err != nil || r.Summary.TotalBytes != 12345678901 || r.Records[0].BytesIn != 5 || r.Records[0].BytesOut != 6 || r.Records[0].TotalBytes != 0 {
		t.Fatalf("%+v %v", r, err)
	}
	var d DailyUsage
	var h TopHosts
	if json.Unmarshal([]byte(`{"days":[{"totalBytes":"7"}]}`), &d) != nil || d.Days[0].TotalBytes != 7 ||
		json.Unmarshal([]byte(`{"hosts":[{"totalBytes":"8"}]}`), &h) != nil || h.Hosts[0].TotalBytes != 8 {
		t.Fatalf("%+v %+v", d, h)
	}
	for _, bad := range []string{`"abc"`, `"1.5"`, `1.5`, `"99999999999999999999"`, `true`} {
		var rec UsageRecord
		if json.Unmarshal([]byte(`{"bytesIn":`+bad+`}`), &rec) == nil {
			t.Fatalf("accepted %s", bad)
		}
	}
}

// Compile-time and runtime check that the 2.0.0 field names and types still work.
func TestBackwardCompatibleFields(t *testing.T) {
	var rec UsageRecord
	var n int64 = rec.BytesIn + rec.BytesOut + rec.TotalBytes
	var res UsageResult
	n += res.Summary.TotalBytes
	var d DailyUsage
	var h TopHosts
	_ = d
	_ = h
	var gs NetworkGroupStats
	n += gs.PaidBytes24h
	_ = n
	inv := TeamInvite{Token: ""}
	health := ProxyHealth{Status: "ok", ActiveSessions: 0, UptimeSeconds: 0}
	var key TeamKey
	if err := json.Unmarshal([]byte(`{"id":"k","prefix":"dn_live_p"}`), &key); err != nil || key.KeyPrefix != "dn_live_p" || key.Prefix != "dn_live_p" {
		t.Fatalf("%+v %v", key, err)
	}
	c, rt := newTestClient(t)
	rt.push(ok(`{"id":"k","prefix":"dn_live_ab","label":"l","key":"` + testKey + `"}`))
	k, err := c.Teams.CreateKey(context.Background(), teamID, "l")
	if err != nil || k.KeyPrefix != "dn_live_ab" {
		t.Fatalf("%+v %v", k, err)
	}
	_, _ = inv, health
}

func TestPayoutWalletBaseSepolia(t *testing.T) {
	c, rt := newTestClient(t)
	s := &fakeSigner{addr: testAddr}
	addr := "0x" + strings.Repeat("3", 40)
	nonce := strings.Repeat("c", 64)
	msg := BuildPayoutWalletMessage(testUUID, testAddr, addr, "base-sepolia", nonce)
	ch, _ := json.Marshal(map[string]any{"nonce": nonce, "message": msg, "expiresAt": "t", "signer": strings.ToLower(testAddr), "oldWalletSignatureRequired": false})
	rt.push(ok(string(ch)), ok(`{"payoutWallet":null,"changed":true,"cooldownHours":0}`))
	if _, err := c.PayoutWallet.Set(context.Background(), SetPayoutWalletOptions{Address: addr, Chain: "base-sepolia", Signer: s}); err != nil {
		t.Fatal(err)
	}
	jsonEq(t, rt.reqs[0].Body, `{"address":"`+addr+`","chain":"base-sepolia"}`)
	before := len(rt.reqs)
	_, err := c.PayoutWallet.Set(context.Background(), SetPayoutWalletOptions{Address: addr, Chain: "eth", Signer: s})
	wantInvalid(t, err, rt, before)
}

func TestReportLimitNotRetried(t *testing.T) {
	c, rt := newTestClient(t)
	rt.push(mockResp{status: 409, body: `{"error":"At most 20 reports","code":"REPORT_LIMIT"}`})
	_, err := c.Sessions.Report(context.Background(), testUUID, "blocked")
	if !isType[*ConflictError](err) {
		t.Fatalf("%T %v", err, err)
	}
	wantCode(t, err, "REPORT_LIMIT")
	if len(rt.reqs) != 1 {
		t.Fatalf("409 retried: %d requests", len(rt.reqs))
	}
	rt.push(mockResp{status: 429, body: `{}`, headers: map[string]string{"Retry-After": "0"}},
		mockResp{status: 429, body: `{"code":"REPORT_LIMIT"}`, headers: map[string]string{"Retry-After": "0"}})
	_, err = c.Sessions.Report(context.Background(), testUUID, "blocked")
	if !isType[*RateLimitError](err) || len(rt.reqs) != 3 {
		t.Fatalf("%T %v reqs=%d", err, err, len(rt.reqs))
	}
	wantCode(t, err, "REPORT_LIMIT")
}

func TestPagination(t *testing.T) {
	c, rt := newTestClient(t)
	ctx := context.Background()
	rt.push(ok(`{"transactions":[{"id":"3"},{"id":"2"}],"nextCursor":"2"}`), ok(`{"transactions":[{"id":"1"}],"nextCursor":null}`))
	var ids []string
	two := 2
	err := c.Credits.EachTransaction(ctx, CreditTransactionsQuery{Limit: &two, Type: "earn"}, func(tx CreditTransaction) error {
		ids = append(ids, tx.ID)
		return nil
	})
	if err != nil || strings.Join(ids, ",") != "3,2,1" || rt.reqs[1].Query != "limit=2&cursor=2&type=earn" {
		t.Fatalf("%v %v %q", ids, err, rt.reqs[1].Query)
	}

	rt.reqs = nil
	rt.push(ok(`{"payouts":[{"id":"a"},{"id":"b"}]}`), ok(`{"payouts":[{"id":"c"}]}`))
	n := 0
	if err := c.Payouts.Each(ctx, &two, func(Payout) error { n++; return nil }); err != nil || n != 3 || rt.reqs[1].Query != "limit=2&offset=2" {
		t.Fatalf("payouts %d %v", n, err)
	}

	rt.reqs = nil
	rt.push(ok(`{"nodes":[{"id":"a"},{"id":"b"}]}`))
	n = 0
	if err := c.Nodes.Each(ctx, &two, func(NodeInfo) error { n++; return ErrStopIteration }); err != nil || n != 1 || len(rt.reqs) != 1 {
		t.Fatalf("stop: %d %v", n, err)
	}

	rt.reqs = nil
	rt.push(ok(`{"records":[{"id":"a"},{"id":"b"}],"pagination":{"total":2}}`))
	n = 0
	if err := c.Usage.EachRecord(ctx, DateRange{From: "2026-01-01"}, &two, func(UsageRecord) error { n++; return nil }); err != nil || n != 2 || len(rt.reqs) != 1 {
		t.Fatalf("usage %d %v", n, err)
	}

	rt.reqs = nil
	rt.push(ok(`{"transactions":[{"id":"a"}]}`))
	n = 0
	if err := c.Wallet.EachTransaction(ctx, &two, func(WalletTransaction) error { n++; return nil }); err != nil || n != 1 {
		t.Fatalf("wallet %d %v", n, err)
	}
	big := 101
	err = c.Wallet.EachTransaction(ctx, &big, func(WalletTransaction) error { return nil })
	wantInvalid(t, err, rt, len(rt.reqs))
}
