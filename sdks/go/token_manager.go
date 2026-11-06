package dominusnode

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"strings"
	"sync"
	"time"
)

// TokenRefreshBuffer: JWTs are refreshed this long before expiry.
const TokenRefreshBuffer = 60 * time.Second

type refreshFunc func(ctx context.Context, refreshToken string) (access, refresh string, err error)

type refreshCall struct {
	done  chan struct{}
	token string
	err   error
}

// tokenManager holds the JWT pair. clear() drops tokens but keeps refreshFn.
type tokenManager struct {
	mu        sync.Mutex
	access    string
	refresh   string
	inflight  *refreshCall
	refreshFn refreshFunc
	now       func() time.Time
}

func newTokenManager() *tokenManager { return &tokenManager{now: time.Now} }

func (t *tokenManager) setTokens(access, refresh string) {
	t.mu.Lock()
	defer t.mu.Unlock()
	t.access = access
	if refresh != "" {
		t.refresh = refresh
	}
}

func (t *tokenManager) setRefreshFunc(fn refreshFunc) {
	t.mu.Lock()
	t.refreshFn = fn
	t.mu.Unlock()
}

func (t *tokenManager) hasRefreshFunc() bool {
	t.mu.Lock()
	defer t.mu.Unlock()
	return t.refreshFn != nil
}

func (t *tokenManager) hasTokens() bool {
	t.mu.Lock()
	defer t.mu.Unlock()
	return t.access != "" || t.refresh != ""
}

func (t *tokenManager) refreshToken() string {
	t.mu.Lock()
	defer t.mu.Unlock()
	return t.refresh
}

func (t *tokenManager) isExpired(tok string) bool {
	parts := strings.Split(tok, ".")
	if len(parts) != 3 {
		return true
	}
	raw, err := base64.RawURLEncoding.DecodeString(strings.TrimRight(parts[1], "="))
	if err != nil {
		return true
	}
	var p struct {
		Exp *float64 `json:"exp"`
	}
	if json.Unmarshal(raw, &p) != nil || p.Exp == nil {
		return true
	}
	exp := time.Unix(int64(*p.Exp), 0)
	return exp.Before(t.now().Add(TokenRefreshBuffer))
}

func (t *tokenManager) validToken(ctx context.Context) (string, error) {
	t.mu.Lock()
	a := t.access
	t.mu.Unlock()
	if a != "" && !t.isExpired(a) {
		return a, nil
	}
	return t.forceRefresh(ctx)
}

// forceRefresh refreshes regardless of expiry; concurrent callers share one refresh.
func (t *tokenManager) forceRefresh(ctx context.Context) (string, error) {
	t.mu.Lock()
	if t.refresh == "" || t.refreshFn == nil {
		t.mu.Unlock()
		return "", authErr("No valid token and cannot refresh")
	}
	if c := t.inflight; c != nil {
		t.mu.Unlock()
		<-c.done
		return c.token, c.err
	}
	c := &refreshCall{done: make(chan struct{})}
	t.inflight = c
	fn, rt := t.refreshFn, t.refresh
	t.mu.Unlock()

	access, refresh, err := fn(ctx, rt)
	t.mu.Lock()
	if t.inflight == c {
		if err != nil {
			t.access, t.refresh = "", ""
		} else {
			t.access = access
			if refresh != "" {
				t.refresh = refresh
			}
		}
		t.inflight = nil
	}
	t.mu.Unlock()
	c.token, c.err = access, err
	if err != nil {
		c.token = ""
	}
	close(c.done)
	return c.token, c.err
}

// clear drops tokens and any in-flight refresh. It does NOT clear refreshFn.
func (t *tokenManager) clear() {
	t.mu.Lock()
	t.access, t.refresh, t.inflight = "", "", nil
	t.mu.Unlock()
}

func (t *tokenManager) String() string               { return "TokenManager(" + redacted + ")" }
func (t *tokenManager) GoString() string             { return t.String() }
func (t *tokenManager) MarshalJSON() ([]byte, error) { return []byte(`"` + redacted + `"`), nil }
