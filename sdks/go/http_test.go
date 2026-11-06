package dominusnode

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

func TestErrorMapping(t *testing.T) {
	cases := []struct {
		status int
		check  func(error) bool
	}{
		{400, isType[*ValidationError]},
		{401, isType[*AuthenticationError]},
		{402, isType[*InsufficientBalanceError]},
		{403, isType[*AuthorizationError]},
		{404, isType[*NotFoundError]},
		{409, isType[*ConflictError]},
		{429, isType[*RateLimitError]},
		{500, isType[*ServerError]},
		{503, isType[*ServerError]},
	}
	for _, tc := range cases {
		c, rt := newTestClient(t)
		c.tokens.refresh = "" // no 401 refresh path here
		body := `{"error":"boom","code":"CAP_ABOVE_DEFAULT","max":100,"cap":"7","limitPerDay":5}`
		rt.push(mockResp{status: tc.status, body: body, headers: map[string]string{"Retry-After": "3"}})
		rt.push(mockResp{status: tc.status, body: body, headers: map[string]string{"Retry-After": "3"}})
		_, err := c.Credits.Balance(context.Background())
		if !tc.check(err) {
			t.Fatalf("%d: got %T %v", tc.status, err, err)
		}
		var de *DominusNodeError
		if !errors.As(err, &de) || de.StatusCode != tc.status || de.Message != "boom" || de.Code != "CAP_ABOVE_DEFAULT" {
			t.Fatalf("%d: %+v", tc.status, de)
		}
		if de.Details["max"] != int64(100) || de.Details["cap"] != "7" || de.Details["limitPerDay"] != int64(5) {
			t.Fatalf("details %v", de.Details)
		}
		if tc.status == 429 {
			var rl *RateLimitError
			errors.As(err, &rl)
			if rl.RetryAfterSeconds != 3 {
				t.Fatalf("retryAfter %d", rl.RetryAfterSeconds)
			}
		}
	}
}

func TestErrorMessageRulesAndMFA(t *testing.T) {
	c, rt := newTestClient(t)
	rt.push(mockResp{status: 403, body: `{"message":"need mfa","mfaRequired":true}`})
	_, err := c.Credits.Balance(context.Background())
	wantCode(t, err, CodeMFARequired)

	rt.push(mockResp{status: 400, body: `{"error":"` + strings.Repeat("x", 600) + `"}`})
	_, err = c.Credits.Balance(context.Background())
	var ve *ValidationError
	if !errors.As(err, &ve) || len(ve.Message) != 500+len("... [truncated]") || ve.StatusCode != 400 {
		t.Fatalf("truncation: %v", err)
	}

	jwt := "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ4In0.sig_part"
	rt.push(mockResp{status: 400, body: `{"error":"bad key dn_live_SECRET123 node dn_node_` + strings.Repeat("a", 64) + ` jwt ` + jwt + ` test dn_test_zz proxy dn_proxy_q"}`})
	_, err = c.Credits.Balance(context.Background())
	for _, leak := range []string{"SECRET123", "dn_node_a", "eyJ", "dn_test_zz", "dn_proxy_q"} {
		if strings.Contains(err.Error(), leak) {
			t.Fatalf("leaked %q in %q", leak, err.Error())
		}
	}

	rt.push(mockResp{err: errors.New("dial failed for " + testKey)})
	_, err = c.Credits.Balance(context.Background())
	if !isType[*NetworkError](err) || strings.Contains(err.Error(), testKey) {
		t.Fatalf("network err %v", err)
	}
}

func TestRateLimitRetry(t *testing.T) {
	c, rt := newTestClient(t)
	var waits []time.Duration
	c.http.sleep = func(_ context.Context, d time.Duration) error { waits = append(waits, d); return nil }
	rt.push(mockResp{status: 429, body: `{"error":"slow"}`, headers: map[string]string{"Retry-After": "2"}}, ok(`{"onlineNodes":4}`))
	st, err := c.Network.Stats(context.Background())
	if err != nil || st.OnlineNodes != 4 || len(rt.reqs) != 2 || len(waits) != 1 {
		t.Fatalf("retry: %v %v reqs=%d", st, err, len(rt.reqs))
	}
	if waits[0] < 1800*time.Millisecond || waits[0] > 2200*time.Millisecond {
		t.Fatalf("wait %v", waits[0])
	}
	if rt.closed < 1 {
		t.Fatal("429 body not closed")
	}

	rt.push(mockResp{status: 429, body: `{}`}, mockResp{status: 429, body: `{}`})
	_, err = c.Network.Stats(context.Background())
	var rl *RateLimitError
	if !errors.As(err, &rl) || rl.RetryAfterSeconds != 60 || len(rt.reqs) != 4 {
		t.Fatalf("second 429: %v reqs=%d", err, len(rt.reqs))
	}
}

func TestRetryDelayBounds(t *testing.T) {
	for i := 0; i < 2000; i++ {
		if d := retryDelay(3600); d < 9*time.Second || d > 11*time.Second {
			t.Fatalf("cap: %v", d)
		}
		if d := retryDelay(0); d != MinRetryWait {
			t.Fatalf("floor: %v", d)
		}
		if d := retryDelay(5); d < 4500*time.Millisecond || d > 5500*time.Millisecond {
			t.Fatalf("jitter: %v", d)
		}
	}
}

func TestJWTRefreshOn401(t *testing.T) {
	c, rt := newTestClient(t)
	newAccess := testJWT(time.Now().Add(2 * time.Hour).Unix())
	rt.push(mockResp{status: 401, body: `{"error":"expired"}`},
		ok(`{"token":"`+newAccess+`","refreshToken":"`+refreshJWT+`"}`),
		ok(`{"user":{"id":"u1"}}`))
	me, err := c.Auth.Me(context.Background())
	if err != nil || me.User.ID != "u1" {
		t.Fatalf("%v %v", me, err)
	}
	if rt.reqs[1].Path != "/api/auth/refresh" || rt.reqs[2].Header.Get("Authorization") != "Bearer "+newAccess {
		t.Fatalf("refresh flow wrong: %+v", rt.reqs)
	}
}

func TestNoRefreshForAPIKey(t *testing.T) {
	c, rt := newTestClient(t)
	rt.push(mockResp{status: 401, body: `{"error":"bad key"}`})
	_, err := c.Credits.Balance(context.Background())
	if !isType[*AuthenticationError](err) || len(rt.reqs) != 1 {
		t.Fatalf("%v reqs=%d", err, len(rt.reqs))
	}
}

func TestRefreshFailureClearsTokens(t *testing.T) {
	c, rt := newTestClient(t)
	rt.push(mockResp{status: 401, body: `{}`}, mockResp{status: 401, body: `{"error":"revoked"}`})
	_, err := c.Auth.Me(context.Background())
	if !isType[*AuthenticationError](err) {
		t.Fatalf("%v", err)
	}
	if c.tokens.hasTokens() {
		t.Fatal("tokens not cleared after refresh failure")
	}
}

func TestExpiredAccessRefreshedBeforeRequest(t *testing.T) {
	c, rt := newTestClient(t)
	c.tokens.setTokens(testJWT(time.Now().Add(30*time.Second).Unix()), "") // inside 60s buffer
	rt.push(ok(`{"token":"`+accessJWT+`"}`), ok(`{}`))
	if _, err := c.Auth.Me(context.Background()); err != nil {
		t.Fatal(err)
	}
	if rt.reqs[0].Path != "/api/auth/refresh" {
		t.Fatal("expected proactive refresh")
	}
}

func TestResponseSizeCap(t *testing.T) {
	c, rt := newTestClient(t)
	rt.push(mockResp{status: 200, body: "{}", contentLength: MaxResponseBytes + 1})
	if _, err := c.Network.Stats(context.Background()); !isType[*ServerError](err) {
		t.Fatalf("content-length cap: %v", err)
	}
	rt.push(mockResp{status: 200, body: `"` + strings.Repeat("a", MaxResponseBytes) + `"`, contentLength: -1})
	if _, err := c.Network.Stats(context.Background()); !isType[*ServerError](err) || !strings.Contains(err.Error(), "size limit") {
		t.Fatalf("actual-size cap: %v", err)
	}
}

func TestRedirectsNotFollowed(t *testing.T) {
	hits := 0
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		hits++
		if r.URL.Path == "/elsewhere" {
			t.Error("redirect was followed")
		}
		http.Redirect(w, r, "/elsewhere", http.StatusFound)
	}))
	defer srv.Close()
	// caller-supplied client with a permissive CheckRedirect must still not follow
	hc := &http.Client{CheckRedirect: func(*http.Request, []*http.Request) error { return nil }}
	c, err := NewClient(Config{BaseURL: srv.URL + "/", HTTPClient: hc})
	if err != nil {
		t.Fatal(err)
	}
	_, err = c.Network.Stats(context.Background())
	var de *DominusNodeError
	if !errors.As(err, &de) || de.StatusCode != 302 || hits != 1 {
		t.Fatalf("err=%v hits=%d", err, hits)
	}
	if hc.CheckRedirect == nil {
		t.Fatal("caller's client mutated")
	}
}

func TestConfigValidation(t *testing.T) {
	for _, cfg := range []Config{
		{BaseURL: "ftp://x"}, {BaseURL: "https://u:p@x"}, {BaseURL: "::"},
		{ProxyHost: "bad host"}, {ProxyHost: "a/b"}, {HTTPProxyPort: 70000}, {SOCKS5ProxyPort: -1},
	} {
		if _, err := NewClient(cfg); !isType[*ValidationError](err) {
			t.Fatalf("%+v accepted: %v", cfg, err)
		}
	}
	c, err := NewClient(Config{BaseURL: "https://x.test///", ProxyHost: "[::1]"})
	if err != nil || c.http.baseURL != "https://x.test" {
		t.Fatalf("%v %v", c, err)
	}
}
