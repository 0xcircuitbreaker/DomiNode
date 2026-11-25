package dominusnode

import (
	"context"
	"encoding/json"
	"fmt"
	"strings"
	"testing"
)

func TestProxyTokenCreateWrapsSecret(t *testing.T) {
	c, rt := newTestClient(t)
	tok := "dn_proxy_" + strings.Repeat("x", 43)
	rt.push(ok(`{"id":"` + testUUID + `","label":"ci","status":"active","expiresAt":"2027-01-01T00:00:00Z","maxBytes":null,"maxSpendMusd":"5","bytesUsed":"0","spendUsedMusd":"0","revokedAt":null,"createdAt":"2026-11-25T00:00:00Z","token":"` + tok + `"}`))
	r, err := c.ProxyTokens.Create(context.Background(), CreateProxyTokenOptions{})
	if err != nil {
		t.Fatal(err)
	}
	jsonEq(t, rt.last(t).Body, `{}`)
	if r.Token.Reveal() != tok || r.Status != "active" || r.MaxBytes != nil || *r.MaxSpendMusd != "5" {
		t.Fatalf("bad result %+v", r.ProxyTokenInfo)
	}
	b, _ := json.Marshal(r)
	for _, s := range []string{fmt.Sprintf("%v", r), fmt.Sprintf("%+v", r), fmt.Sprintf("%#v", r), string(b)} {
		if strings.Contains(s, tok) {
			t.Fatalf("token leaked: %s", s)
		}
	}
}

func TestProxyTokenCreateRefusesMalformedToken(t *testing.T) {
	for _, tok := range []string{"", "dn_live_" + strings.Repeat("x", 43), "dn_proxy_" + strings.Repeat("x", 42), "dn_proxy_" + strings.Repeat("!", 43)} {
		c, rt := newTestClient(t)
		rt.push(ok(`{"id":"x","token":"` + tok + `"}`))
		if _, err := c.ProxyTokens.Create(context.Background(), CreateProxyTokenOptions{}); !isType[*ProtocolError](err) {
			t.Fatalf("%q: want ProtocolError, got %v", tok, err)
		}
	}
}

func TestProxyTokenValidationSendsNothing(t *testing.T) {
	bad := []CreateProxyTokenOptions{
		{Label: String(strings.Repeat("a", 65))},
		{Label: String("a\nb")},
		{TTLSeconds: Int(59)},
		{TTLSeconds: Int(ProxyTokenMaxTTLSeconds + 1)},
		{MaxBytes: Int64(0)},
		{MaxBytes: Int64(ProxyTokenMaxBytes + 1)},
		{MaxSpendMusd: Int64(-1)},
		{MaxSpendMusd: Int64(ProxyTokenMaxSpendMusd + 1)},
	}
	for i, o := range bad {
		c, rt := newTestClient(t)
		if _, err := c.ProxyTokens.Create(context.Background(), o); !isType[*ValidationError](err) || len(rt.reqs) != 0 {
			t.Fatalf("case %d: err=%v reqs=%d", i, err, len(rt.reqs))
		}
	}
	c, rt := newTestClient(t)
	if _, err := c.ProxyTokens.Revoke(context.Background(), "not-a-uuid"); err == nil || len(rt.reqs) != 0 {
		t.Fatal("bad UUID must be refused before sending")
	}
	for _, d := range []int{0, 31} {
		if _, err := c.Nodes.EarningsProjection(context.Background(), Int(d)); err == nil || len(rt.reqs) != 0 {
			t.Fatalf("days %d must be refused before sending", d)
		}
	}
}

func TestEarningsProjectionDecodes(t *testing.T) {
	c, rt := newTestClient(t)
	view := `{"tier":{"id":1,"name":"Probation","nodeShareBps":2500,"holdDays":14},"dailyMusd":"125000","monthlyMusd":"3750000","windowMusd":"875000"}`
	rt.push(ok(`{"windowDays":7,"meteredBytes":"2000000000","current":` + view + `,"nextTier":null,"topTier":` + view +
		`,"byClass":[{"ipClass":"dc","bytes":"2000000000","pricePerGbMusd":"200000","tierWeight":0.4,"dailyMusd":"1","monthlyMusd":"30"}],"pricing":{"dc":"200000"},"maturity":{"holdDays":14,"firstWithdrawableDaysFromNow":14},"note":"n"}`))
	p, err := c.Nodes.EarningsProjection(context.Background(), nil)
	if err != nil {
		t.Fatal(err)
	}
	if p.Current.MonthlyMusd != "3750000" || p.NextTier != nil || p.ByClass[0].TierWeight != 0.4 || p.Pricing["dc"] != "200000" || p.Maturity.HoldDays != 14 {
		t.Fatalf("bad decode %+v", p)
	}
}
