package dominusnode

import (
	"context"
	"encoding/json"
	"fmt"
	"strings"
	"testing"
)

func TestSecretRedaction(t *testing.T) {
	s := NewSecret(testKey)
	holder := struct{ K Secret }{s}
	outs := []string{
		s.String(), s.GoString(), fmt.Sprint(s), fmt.Sprintf("%v %+v %#v %s %q %x", s, s, s, s, s, s),
		fmt.Sprintf("%v %+v %#v", holder, holder, holder), fmt.Sprint(&s),
	}
	j, _ := json.Marshal(holder)
	outs = append(outs, string(j))
	for _, o := range outs {
		if strings.Contains(o, "abcdefgh") {
			t.Fatalf("leak: %s", o)
		}
		if !strings.Contains(o, "[REDACTED]") {
			t.Fatalf("no marker: %s", o)
		}
	}
	if s.Reveal() != testKey || s.Prefix() != "dn_live_" {
		t.Fatal("reveal/prefix")
	}
}

func TestClientAndTokenManagerRedaction(t *testing.T) {
	c, _ := newTestClient(t)
	j, _ := json.Marshal(c)
	tj, _ := json.Marshal(c.tokens)
	for _, o := range []string{c.String(), fmt.Sprint(c), fmt.Sprintf("%#v", c), string(j), c.tokens.String(), fmt.Sprintf("%v %#v", c.tokens, c.tokens), string(tj), fmt.Sprint(c.http)} {
		if strings.Contains(o, testKey) || strings.Contains(o, "eyJ") {
			t.Fatalf("leak: %s", o)
		}
	}
	if c.String() != "DominusNodeClient(connected=true)" || string(j) != `{"connected":true}` {
		t.Fatal(c.String(), string(j))
	}
}

func TestConnectWithKey(t *testing.T) {
	c, rt := bareClient(t)
	rt.push(ok(`{"valid":true,"token":"` + accessJWT + `","refreshToken":"` + refreshJWT + `","userId":"u1"}`))
	r, err := c.ConnectWithKey(context.Background(), testKey)
	if err != nil || r.MfaRequired || r.UserID != "u1" || c.key() != testKey || !c.tokens.hasTokens() {
		t.Fatalf("%+v %v", r, err)
	}
	if rt.last(t).Header.Get("Authorization") != "" {
		t.Fatal("verify-key must be unauthenticated")
	}

	c2, rt2 := bareClient(t)
	rt2.push(mockResp{status: 403, body: `{"error":"MFA","mfaRequired":true}`})
	r, err = c2.ConnectWithKey(context.Background(), testKey)
	if err != nil || !r.MfaRequired || c2.key() != testKey || c2.tokens.hasTokens() {
		t.Fatalf("mfa: %+v %v", r, err)
	}

	c3, rt3 := bareClient(t)
	rt3.push(mockResp{status: 401, body: `{"error":"bad"}`})
	if _, err := c3.ConnectWithKey(context.Background(), testKey); !isType[*AuthenticationError](err) || c3.IsConnected() {
		t.Fatalf("failure stored creds: %v", err)
	}
}

func TestDisconnectClearsEverythingAndKeepsRefreshFn(t *testing.T) {
	c, rt := newTestClient(t)
	rt.push(mockResp{status: 500, body: `{}`}) // logout failure is ignored
	c.Disconnect(context.Background())
	if rt.reqs[0].Path != "/api/auth/logout" {
		t.Fatal("logout not called")
	}
	if c.IsConnected() || c.key() != "" || c.tokens.access != "" || c.tokens.refresh != "" {
		t.Fatal("credentials remain")
	}
	if !c.tokens.hasRefreshFunc() {
		t.Fatal("clear() dropped the refresh callback")
	}
	// reconnect + refresh still works
	rt.push(ok(`{"token":"`+testJWT(1)+`","refreshToken":"`+refreshJWT+`","userId":"u"}`), ok(`{"token":"`+accessJWT+`"}`), ok(`{}`))
	if _, err := c.ConnectWithKey(context.Background(), testKey); err != nil {
		t.Fatal(err)
	}
	if _, err := c.Auth.Me(context.Background()); err != nil || rt.reqs[2].Path != "/api/auth/refresh" {
		t.Fatalf("refresh after reconnect: %v", err)
	}

	c2, rt2 := bareClient(t)
	c2.apiKey = testKey
	c2.Disconnect(context.Background())
	if len(rt2.reqs) != 0 || c2.IsConnected() {
		t.Fatal("no JWT -> no logout call; key cleared")
	}
}

func TestPreexistingTokens(t *testing.T) {
	c, err := NewClient(Config{AccessToken: accessJWT, RefreshToken: refreshJWT})
	if err != nil || !c.IsConnected() {
		t.Fatal(err)
	}
}
