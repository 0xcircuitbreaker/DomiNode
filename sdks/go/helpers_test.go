package dominusnode

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"
)

const (
	testKey  = "dn_live_abcdefgh12345678"
	testUUID = "123e4567-e89b-42d3-a456-426614174000"
	testAddr = "0xAbCdEf0123456789abcdef0123456789ABCDEF01"
)

var testSig = "0x" + strings.Repeat("ab", 65)

func testJWT(exp int64) string {
	p := base64.RawURLEncoding.EncodeToString([]byte(`{"sub":"u","exp":` + strconv.FormatInt(exp, 10) + `}`))
	return "eyJhbGciOiJIUzI1NiJ9." + p + ".c2ln"
}

var (
	accessJWT  = testJWT(time.Now().Add(time.Hour).Unix())
	refreshJWT = testJWT(time.Now().Add(24 * time.Hour).Unix())
)

type mockResp struct {
	status  int
	body    string
	headers map[string]string
	// contentLength overrides the declared length (-1 = unknown).
	contentLength int64
	err           error
}

type recorded struct {
	Method string
	Path   string
	Query  string
	Body   string
	Header http.Header
}

type mockRT struct {
	mu       sync.Mutex
	queue    []mockResp
	reqs     []recorded
	closed   int
	fallback *mockResp
}

type trackBody struct {
	io.Reader
	rt *mockRT
}

func (b *trackBody) Close() error {
	b.rt.mu.Lock()
	b.rt.closed++
	b.rt.mu.Unlock()
	return nil
}

func (m *mockRT) RoundTrip(r *http.Request) (*http.Response, error) {
	var body string
	if r.Body != nil {
		b, _ := io.ReadAll(r.Body)
		body = string(b)
	}
	m.mu.Lock()
	m.reqs = append(m.reqs, recorded{r.Method, r.URL.EscapedPath(), r.URL.RawQuery, body, r.Header.Clone()})
	var mr mockResp
	if len(m.queue) > 0 {
		mr = m.queue[0]
		m.queue = m.queue[1:]
	} else if m.fallback != nil {
		mr = *m.fallback
	} else {
		mr = mockResp{status: 200, body: "{}"}
	}
	m.mu.Unlock()
	if mr.err != nil {
		return nil, mr.err
	}
	h := http.Header{}
	for k, v := range mr.headers {
		h.Set(k, v)
	}
	cl := int64(len(mr.body))
	if mr.contentLength != 0 {
		cl = mr.contentLength
	}
	return &http.Response{
		StatusCode: mr.status, Status: strconv.Itoa(mr.status), Header: h, ContentLength: cl,
		Body: &trackBody{strings.NewReader(mr.body), m}, Request: r,
	}, nil
}

func (m *mockRT) push(rs ...mockResp) { m.queue = append(m.queue, rs...) }

func (m *mockRT) last(t *testing.T) recorded {
	t.Helper()
	if len(m.reqs) == 0 {
		t.Fatal("no request sent")
	}
	return m.reqs[len(m.reqs)-1]
}

func ok(body string) mockResp { return mockResp{status: 200, body: body} }

// newTestClient: connected with an API key and a valid JWT pair; retries do not sleep.
func newTestClient(t *testing.T) (*Client, *mockRT) {
	t.Helper()
	rt := &mockRT{}
	c, err := NewClient(Config{BaseURL: "https://api.test", HTTPClient: &http.Client{Transport: rt}})
	if err != nil {
		t.Fatal(err)
	}
	c.http.sleep = func(context.Context, time.Duration) error { return nil }
	c.apiKey = testKey
	c.tokens.setTokens(accessJWT, refreshJWT)
	return c, rt
}

func bareClient(t *testing.T) (*Client, *mockRT) {
	t.Helper()
	rt := &mockRT{}
	c, err := NewClient(Config{BaseURL: "https://api.test", HTTPClient: &http.Client{Transport: rt}})
	if err != nil {
		t.Fatal(err)
	}
	c.http.sleep = func(context.Context, time.Duration) error { return nil }
	return c, rt
}

func jsonEq(t *testing.T, got, want string) {
	t.Helper()
	if got == "" && want == "" {
		return
	}
	var a, b any
	if err := json.Unmarshal([]byte(got), &a); err != nil {
		t.Fatalf("body %q is not JSON: %v", got, err)
	}
	if err := json.Unmarshal([]byte(want), &b); err != nil {
		t.Fatalf("want %q is not JSON: %v", want, err)
	}
	ga, _ := json.Marshal(a)
	gb, _ := json.Marshal(b)
	if string(ga) != string(gb) {
		t.Fatalf("body = %s, want %s", ga, gb)
	}
}

func wantCode(t *testing.T, err error, code string) {
	t.Helper()
	var de *DominusNodeError
	if !errors.As(err, &de) {
		t.Fatalf("err = %v (%T), want DominusNodeError", err, err)
	}
	if de.Code != code {
		t.Fatalf("code = %q, want %q (%v)", de.Code, code, err)
	}
}

func wantInvalid(t *testing.T, err error, rt *mockRT, before int) {
	t.Helper()
	var ve *ValidationError
	if !errors.As(err, &ve) || ve.Code != CodeInvalidArgument || ve.StatusCode != 0 {
		t.Fatalf("err = %v (%T), want client-side ValidationError", err, err)
	}
	if len(rt.reqs) != before {
		t.Fatalf("a request was sent despite validation failure")
	}
}

func isType[T error](err error) bool {
	var target T
	return errors.As(err, &target)
}

// fakeSigner records calls and returns a fixed signature (or sig/err overrides).
type fakeSigner struct {
	addr  string
	sig   string
	err   error
	calls []string
}

func (f *fakeSigner) Address() string { return f.addr }
func (f *fakeSigner) SignMessage(_ context.Context, m string) (string, error) {
	f.calls = append(f.calls, m)
	if f.err != nil {
		return "", f.err
	}
	if f.sig != "" {
		return f.sig, nil
	}
	return testSig, nil
}
