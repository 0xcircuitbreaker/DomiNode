package dominusnode

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"math/rand"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"time"
)

const (
	// MaxResponseBytes caps any response body the SDK reads (API or proxy fetch).
	MaxResponseBytes = 10 * 1024 * 1024
	// RequestTimeout is the per-request API timeout.
	RequestTimeout = 30 * time.Second
	// MaxRetryWait caps the 429 retry wait.
	MaxRetryWait = 10 * time.Second
	// MinRetryWait is the floor of the 429 retry wait.
	MinRetryWait = 100 * time.Millisecond
)

type authMode int

const (
	authJWT authMode = iota
	authAgent
	authNone
)

var dangerousKeys = map[string]bool{"__proto__": true, "constructor": true, "prototype": true}

// stripDangerousKeys recursively deletes prototype-pollution keys (depth limit 50).
func stripDangerousKeys(v any, depth int) {
	if depth > 50 {
		return
	}
	switch x := v.(type) {
	case map[string]any:
		for k, c := range x {
			if dangerousKeys[k] {
				delete(x, k)
				continue
			}
			stripDangerousKeys(c, depth+1)
		}
	case []any:
		for _, c := range x {
			stripDangerousKeys(c, depth+1)
		}
	}
}

func safeJSONParse(data []byte) (any, error) {
	d := json.NewDecoder(bytes.NewReader(data))
	d.UseNumber()
	var v any
	if err := d.Decode(&v); err != nil {
		return nil, err
	}
	if d.More() {
		return nil, errors.New("trailing data")
	}
	stripDangerousKeys(v, 0)
	return v, nil
}

// retryDelay = min(retryAfter, 10s) +/-10% jitter, floor 100ms.
func retryDelay(retryAfterSeconds int) time.Duration {
	if retryAfterSeconds < 0 {
		retryAfterSeconds = 0
	}
	base := time.Duration(retryAfterSeconds) * time.Second
	if base > MaxRetryWait {
		base = MaxRetryWait
	}
	jitter := time.Duration(float64(base) * 0.2 * (rand.Float64() - 0.5))
	d := base + jitter
	if d < MinRetryWait {
		d = MinRetryWait
	}
	return d
}

func parseRetryAfter(h string, fallback int) int {
	n, err := strconv.Atoi(strings.TrimSpace(h))
	if err != nil || n < 0 {
		return fallback
	}
	return n
}

type httpClient struct {
	baseURL string
	client  *http.Client
	tokens  *tokenManager
	apiKey  func() string
	sleep   func(ctx context.Context, d time.Duration) error
}

func sleepCtx(ctx context.Context, d time.Duration) error {
	t := time.NewTimer(d)
	defer t.Stop()
	select {
	case <-ctx.Done():
		return ctx.Err()
	case <-t.C:
		return nil
	}
}

func newHTTPClient(baseURL string, hc *http.Client, tokens *tokenManager, apiKey func() string) (*httpClient, error) {
	u, err := url.Parse(baseURL)
	if err != nil || u.Host == "" {
		return nil, invalidArg("baseUrl is not a valid URL")
	}
	if u.Scheme != "https" && u.Scheme != "http" {
		return nil, invalidArg("baseUrl must be http(s)")
	}
	if u.User != nil {
		return nil, invalidArg("baseUrl must not contain credentials")
	}
	var c http.Client
	if hc != nil {
		c = *hc // shallow copy: never mutate the caller's client
	}
	if c.Timeout == 0 {
		c.Timeout = RequestTimeout
	}
	// Never follow redirects (credential leakage); the 3xx surfaces as an error.
	c.CheckRedirect = func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }
	return &httpClient{
		baseURL: strings.TrimRight(baseURL, "/"),
		client:  &c,
		tokens:  tokens,
		apiKey:  apiKey,
		sleep:   sleepCtx,
	}, nil
}

func (h *httpClient) String() string   { return "HttpClient(" + h.baseURL + ")" }
func (h *httpClient) GoString() string { return h.String() }

func (h *httpClient) bearer(ctx context.Context, mode authMode, force bool) (string, error) {
	if mode == authNone {
		return "", nil
	}
	if mode == authAgent {
		if k := h.apiKey(); k != "" {
			return k, nil
		}
	}
	if !h.tokens.hasTokens() {
		return "", authErr("Not authenticated. Call ConnectWithKey() or WalletAuth.Verify() first.")
	}
	if force {
		return h.tokens.forceRefresh(ctx)
	}
	return h.tokens.validToken(ctx)
}

type request struct {
	method  string
	path    string
	body    any // nil = no body
	headers map[string]string
	auth    authMode
}

func (h *httpClient) send(ctx context.Context, r request, bearer string) (*http.Response, error) {
	var body io.Reader
	if r.body != nil {
		b, err := json.Marshal(r.body)
		if err != nil {
			return nil, invalidArg("request body: %v", err)
		}
		body = bytes.NewReader(b)
	}
	req, err := http.NewRequestWithContext(ctx, r.method, h.baseURL+r.path, body)
	if err != nil {
		return nil, networkErr(ScrubCredentials(err.Error()))
	}
	req.Header.Set("User-Agent", UserAgent)
	req.Header.Set("Accept", "application/json")
	for k, v := range r.headers {
		req.Header.Set(k, v)
	}
	if r.body != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	if bearer != "" {
		req.Header.Set("Authorization", "Bearer "+bearer)
	}
	res, err := h.client.Do(req)
	if err != nil {
		return nil, networkErr(ScrubCredentials(err.Error()))
	}
	return res, nil
}

func discard(res *http.Response) { _ = res.Body.Close() }

func (h *httpClient) readBody(res *http.Response) ([]byte, error) {
	defer res.Body.Close()
	if res.ContentLength > MaxResponseBytes {
		return nil, serverErr("Response body too large", res.StatusCode)
	}
	b, err := io.ReadAll(io.LimitReader(res.Body, MaxResponseBytes+1))
	if err != nil {
		return nil, networkErr(ScrubCredentials(err.Error()))
	}
	if len(b) > MaxResponseBytes {
		return nil, serverErr("Response body exceeds size limit", res.StatusCode)
	}
	return b, nil
}

// do performs the request and returns the raw body of a 2xx response.
func (h *httpClient) do(ctx context.Context, r request) ([]byte, error) {
	bearer, err := h.bearer(ctx, r.auth, false)
	if err != nil {
		return nil, err
	}
	res, err := h.send(ctx, r, bearer)
	if err != nil {
		return nil, err
	}
	if res.StatusCode == http.StatusTooManyRequests {
		wait := retryDelay(parseRetryAfter(res.Header.Get("Retry-After"), 5))
		discard(res) // do not read the 429 body
		if err := h.sleep(ctx, wait); err != nil {
			return nil, networkErr(err.Error())
		}
		if bearer, err = h.bearer(ctx, r.auth, false); err != nil {
			return nil, err
		}
		if res, err = h.send(ctx, r, bearer); err != nil {
			return nil, err
		}
	}
	usedJWT := bearer != "" && !strings.HasPrefix(bearer, "dn_")
	if res.StatusCode == http.StatusUnauthorized && usedJWT && h.tokens.refreshToken() != "" {
		discard(res)
		refreshed, rerr := h.bearer(ctx, r.auth, true)
		if rerr != nil || refreshed == "" {
			return nil, authErr("Session expired and token refresh failed")
		}
		if res, err = h.send(ctx, r, refreshed); err != nil {
			return nil, err
		}
	}
	body, err := h.readBody(res)
	if err != nil {
		return nil, err
	}
	if res.StatusCode >= 300 {
		return nil, errorFromResponse(res, body)
	}
	return body, nil
}

func errorFromResponse(res *http.Response, body []byte) error {
	msg := string(body)
	code := ""
	var details map[string]any
	if v, err := safeJSONParse(body); err == nil {
		if m, ok := v.(map[string]any); ok {
			if s, ok := m["error"].(string); ok {
				msg = s
			} else if s, ok := m["message"].(string); ok {
				msg = s
			}
			if s, ok := m["code"].(string); ok {
				code = s
			} else if b, ok := m["mfaRequired"].(bool); ok && b {
				code = CodeMFARequired
			}
			for _, k := range []string{"max", "cap", "limitPerDay"} {
				switch x := m[k].(type) {
				case json.Number:
					if details == nil {
						details = map[string]any{}
					}
					if i, err := x.Int64(); err == nil {
						details[k] = i
					} else if f, err := x.Float64(); err == nil {
						details[k] = f
					}
				case string:
					if details == nil {
						details = map[string]any{}
					}
					details[k] = x
				}
			}
		}
	}
	if msg == "" {
		msg = "HTTP " + strconv.Itoa(res.StatusCode)
	}
	if len(msg) > 500 {
		msg = msg[:500] + "... [truncated]"
	}
	if res.StatusCode >= 300 && res.StatusCode < 400 {
		msg = "unexpected redirect (HTTP " + strconv.Itoa(res.StatusCode) + "); redirects are not followed"
	}
	return errorForStatus(res.StatusCode, msg, code, details, parseRetryAfter(res.Header.Get("Retry-After"), 60))
}

// call decodes the JSON response into out (may be nil).
func (h *httpClient) call(ctx context.Context, r request, out any) error {
	body, err := h.do(ctx, r)
	if err != nil {
		return err
	}
	if out == nil {
		return nil
	}
	if len(bytes.TrimSpace(body)) == 0 {
		body = []byte("{}")
	}
	v, err := safeJSONParse(body)
	if err != nil {
		return serverErr("Invalid JSON in response", 200)
	}
	clean, err := json.Marshal(v)
	if err != nil {
		return serverErr("Invalid JSON in response", 200)
	}
	d := json.NewDecoder(bytes.NewReader(clean))
	d.UseNumber()
	if err := d.Decode(out); err != nil {
		return serverErr("Unexpected JSON in response: "+err.Error(), 200)
	}
	return nil
}

func (h *httpClient) get(ctx context.Context, path string, mode authMode, out any) error {
	return h.call(ctx, request{method: "GET", path: path, auth: mode}, out)
}

func (h *httpClient) post(ctx context.Context, path string, body any, mode authMode, out any) error {
	if body == nil {
		body = map[string]any{}
	}
	return h.call(ctx, request{method: "POST", path: path, body: body, auth: mode}, out)
}

func (h *httpClient) put(ctx context.Context, path string, body any, mode authMode, out any) error {
	return h.call(ctx, request{method: "PUT", path: path, body: body, auth: mode}, out)
}

func (h *httpClient) patch(ctx context.Context, path string, body any, mode authMode, out any) error {
	return h.call(ctx, request{method: "PATCH", path: path, body: body, auth: mode}, out)
}

func (h *httpClient) del(ctx context.Context, path string, mode authMode, out any) error {
	return h.call(ctx, request{method: "DELETE", path: path, auth: mode}, out)
}
