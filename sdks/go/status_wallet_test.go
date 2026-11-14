package dominusnode

import (
	"context"
	"testing"
)

func TestNetworkStatusDecodes(t *testing.T) {
	c, m := newTestClient(t)
	m.push(ok(`{"status":"degraded","coordinator":{"status":"operational","policyVersion":4},` +
		`"gateway":{"status":"operational","instancesOnline":2,"lastHeartbeatAt":"t"},` +
		`"availability":{"last24h":99.5,"last7d":null},` +
		`"nodes":{"onlineNodes":7,"byClass":{"dc":7},"byCountry":[{"country":"DE","online":7}],"otherCountries":0,"countriesAvailable":1},` +
		`"incidents":[{"title":"x","body":"","severity":"major","status":"investigating","startedAt":"t","resolvedAt":null,"updatedAt":"t"}],"generatedAt":"t"}`))
	s, err := c.Network.Status(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if s.Status != "degraded" || s.Coordinator.PolicyVersion == nil || *s.Coordinator.PolicyVersion != 4 ||
		s.Gateway.InstancesOnline != 2 || s.Availability.Last24h == nil || *s.Availability.Last24h != 99.5 ||
		s.Availability.Last7d != nil || s.Nodes == nil || s.Nodes.CountriesAvailable != 1 ||
		len(s.Incidents) != 1 || s.Incidents[0].ResolvedAt != nil {
		t.Fatalf("decoded %+v", s)
	}
	r := m.last(t)
	if r.Method != "GET" || r.Path != "/v1/status" || r.Header.Get("Authorization") != "" {
		t.Fatalf("request %+v", r)
	}
}

func TestWalletGetUsesRawKey(t *testing.T) {
	c, m := newTestClient(t)
	m.push(ok(`{"balanceCents":1234,"currency":"usd","lastToppedUp":null}`))
	w, err := c.Wallet.Get(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if w.BalanceCents != 1234 || w.Currency != "usd" || w.LastToppedUp != nil {
		t.Fatalf("decoded %+v", w)
	}
	r := m.last(t)
	if r.Method != "GET" || r.Path != "/v1/wallet" || r.Header.Get("Authorization") != "Bearer "+testKey {
		t.Fatalf("request %+v", r)
	}
}
