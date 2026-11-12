package dominusnode

import (
	"context"
	"strings"
	"testing"
)

func TestMaskedClassUsername(t *testing.T) {
	got, err := BuildProxyUsername(RoutingOptions{Country: "us", IPClass: "masked"})
	if err != nil || got != "country-US-class-masked" {
		t.Fatalf("got %q %v", got, err)
	}
	if _, err := BuildProxyUsername(RoutingOptions{IPClass: "isp"}); err == nil {
		t.Fatal("isp accepted")
	}
}

func TestNodesEachFollowsNextCursor(t *testing.T) {
	c, rt := newTestClient(t)
	rt.push(ok(`{"nodes":[{"id":"a","verifiedClass":"masked","tierWeight":0.25}],"nextCursor":"abc="}`),
		ok(`{"nodes":[{"id":"b"}],"nextCursor":null}`))
	var ids []string
	var w float64
	err := c.Nodes.Each(context.Background(), Int(1), func(n NodeInfo) error {
		ids = append(ids, n.ID)
		if n.TierWeight != nil {
			w = *n.TierWeight
		}
		return nil
	})
	if err != nil || strings.Join(ids, ",") != "a,b" || w != 0.25 {
		t.Fatalf("ids=%v w=%v err=%v", ids, w, err)
	}
	if q := rt.last(t).Query; !strings.Contains(q, "cursor=abc%3D") {
		t.Fatalf("query %q", q)
	}
}

func TestPayoutsEachOffsetFallback(t *testing.T) {
	c, rt := newTestClient(t)
	rt.push(ok(`{"payouts":[{"id":"1"}]}`))
	n := 0
	if err := c.Payouts.Each(context.Background(), Int(5), func(Payout) error { n++; return nil }); err != nil || n != 1 {
		t.Fatalf("n=%d err=%v", n, err)
	}
}

func TestNodeTierWeights(t *testing.T) {
	c, rt := newTestClient(t)
	rt.push(ok(`{"tier":{},"tierWeights":{"masked":0.25,"dc":0.4}}`))
	tr, err := c.Nodes.Tier(context.Background())
	if err != nil || tr.TierWeights["masked"] != 0.25 {
		t.Fatalf("%v %v", tr, err)
	}
}
