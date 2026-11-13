package dominusnode

import (
	"bufio"
	"context"
	"crypto/x509"
	"encoding/base64"
	"errors"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"strconv"
	"strings"
	"testing"
	"time"
)

func TestBuildUsername(t *testing.T) {
	cases := []struct {
		o    RoutingOptions
		want string
	}{
		{RoutingOptions{}, "relay"},
		{RoutingOptions{Country: "us"}, "country-US"},
		{RoutingOptions{Country: "de", IPClass: "residential", SessionID: "abc123", AgenticWalletID: strings.ToUpper(testUUID), AllowHTTP: true},
			"country-DE-class-residential-session-abc123-wallet-" + testUUID + "-allowhttp-1"},
		{RoutingOptions{IPClass: "mobile"}, "class-mobile"},
	}
	for _, tc := range cases {
		got, err := BuildProxyUsername(tc.o)
		if err != nil || got != tc.want {
			t.Fatalf("%+v -> %q %v", tc.o, got, err)
		}
	}
	for _, bad := range []RoutingOptions{
		{Country: "CU"}, {Country: "ir"}, {Country: "KP"}, {Country: "ru"}, {Country: "SY"},
		{Country: "USA"}, {Country: "1a"}, {IPClass: "auto"}, {IPClass: "DC"},
		{SessionID: "has-hyphen"}, {SessionID: strings.Repeat("a", 65)}, {AgenticWalletID: "nope"},
	} {
		if _, err := BuildProxyUsername(bad); !isType[*ValidationError](err) {
			t.Fatalf("%+v accepted", bad)
		}
	}
}

func TestBuildURL(t *testing.T) {
	c, _ := newTestClient(t)
	u, err := c.Proxy.BuildURL(RoutingOptions{Country: "US", IPClass: "dc"}, "", "")
	if err != nil || u != "https://country-US-class-dc:"+testKey+"@proxy.dominusnode.com:8443" {
		t.Fatalf("%q %v", u, err)
	}
	u, _ = c.Proxy.BuildURL(RoutingOptions{}, "socks5", "dn_test_otherkey123")
	if u != "socks5://relay:dn_test_otherkey123@proxy.dominusnode.com:1080" {
		t.Fatal(u)
	}
	if _, err := c.Proxy.BuildURL(RoutingOptions{}, "ftp", ""); !isType[*ValidationError](err) {
		t.Fatal("protocol")
	}
	if _, err := c.Proxy.BuildURL(RoutingOptions{}, "", "bogus"); !isType[*ValidationError](err) {
		t.Fatal("bad key")
	}
	c.apiKey = ""
	if _, err := c.Proxy.BuildURL(RoutingOptions{}, "", ""); !isType[*AuthenticationError](err) {
		t.Fatal("no key")
	}
}

func TestPrivateIPTable(t *testing.T) {
	private := []string{
		"0.0.0.0", "10.1.2.3", "127.0.0.1", "169.254.169.254", "172.16.0.1", "172.31.255.255", "192.168.1.1",
		"100.64.0.1", "100.127.255.255", "192.0.0.1", "192.0.2.5", "192.0.1.1", "192.0.255.255", "198.18.0.1", "198.19.255.1", "224.0.0.1", "255.255.255.255",
		"2130706433", "0x7f000001", "0177.0.0.1", "127.1", "0x7f.1", "10.0x10.0.1",
		"::", "::1", "[::1]", "::ffff:127.0.0.1", "::ffff:7f00:1", "::127.0.0.1", "::7f00:1", "::ffff:10.0.0.1",
		"64:ff9b::7f00:1", "64:ff9b::10.0.0.1", "fc00::1", "fd12::1", "fe80::1%eth0", "[fe80::1%25eth0]", "fec0::1", "ff02::1",
		"2001:0000:4136:e378::1", "2001::1", "2002:7f00:1::", "2001:db8::1",
	}
	public := []string{
		"8.8.8.8", "1.1.1.1", "172.32.0.1", "100.63.255.255", "100.128.0.1", "192.1.0.1", "198.20.0.1", "223.255.255.255",
		"2606:4700::1111", "::ffff:8.8.8.8", "64:ff9b::808:808", "2001:4860::8888", "example.com", "1.2.3.example",
	}
	for _, ip := range private {
		if !IsPrivateIP(ip) {
			t.Errorf("%s should be private", ip)
		}
	}
	for _, ip := range public {
		if IsPrivateIP(ip) {
			t.Errorf("%s should be public", ip)
		}
	}
}

func fetchClient(t *testing.T, gateway string, lookup LookupFunc) *Client {
	t.Helper()
	host, port, _ := net.SplitHostPort(gateway)
	p, _ := strconv.Atoi(port)
	c, err := NewClient(Config{ProxyHost: host, HTTPProxyPort: p, Lookup: lookup, GatewayTLS: &GatewayTLS{Disabled: true}})
	if err != nil {
		t.Fatal(err)
	}
	c.apiKey = testKey
	return c
}

func publicLookup(context.Context, string) ([]string, error) { return []string{"93.184.216.34"}, nil }

func TestFetchURLRefusalsBeforeNetwork(t *testing.T) {
	called := false
	lookup := func(context.Context, string) ([]string, error) { called = true; return []string{"93.184.216.34"}, nil }
	c := fetchClient(t, "127.0.0.1:1", lookup)
	ctx := context.Background()
	for _, u := range []string{
		"ftp://example.com/", "file:///etc/passwd", "https://user:pw@example.com/", "https://example.com:8443/",
		"https://localhost/", "https://LOCALHOST./", "https://ip6-localhost/", "https://foo.localhost/", "https://printer.local/",
		"https://svc.internal/", "https://1.0.0.127.in-addr.arpa/", "https://127.0.0.1/", "https://[::1]/", "https://2130706433/",
		"https://0x7f000001/", "https://10.0.0.1:443/", "https://[::ffff:7f00:1]/", "https://169.254.169.254/",
	} {
		_, err := c.Proxy.Fetch(ctx, u, FetchOptions{})
		if !isType[*ProxyError](err) {
			t.Errorf("%s: %v", u, err)
		}
	}
	if _, err := c.Proxy.Fetch(ctx, "https://example.com/", FetchOptions{Method: "POST"}); !isType[*ValidationError](err) {
		t.Error("POST allowed")
	}
	if _, err := c.Proxy.Fetch(ctx, "http://example.com/", FetchOptions{}); !isType[*ValidationError](err) {
		t.Error("http without AllowHTTP")
	}
	if _, err := c.Proxy.Fetch(ctx, "https://example.com/", FetchOptions{Routing: RoutingOptions{Country: "RU"}}); !isType[*ValidationError](err) {
		t.Error("OFAC")
	}
	if _, err := c.Proxy.Fetch(ctx, "https://example.com/", FetchOptions{Headers: map[string]string{"X-A": "b\r\nInjected: 1"}}); !isType[*ValidationError](err) {
		t.Error("CRLF header")
	}
	if _, err := c.Proxy.Fetch(ctx, "https://example.com/", FetchOptions{Headers: map[string]string{"Bad Name": "x"}}); !isType[*ValidationError](err) {
		t.Error("bad header name")
	}
	if called {
		t.Fatal("DNS resolved before validation finished")
	}
}

func TestFetchDNSRebinding(t *testing.T) {
	ctx := context.Background()
	for name, lookup := range map[string]LookupFunc{
		"mixed": func(context.Context, string) ([]string, error) { return []string{"93.184.216.34", "10.0.0.5"}, nil },
		"v6": func(context.Context, string) ([]string, error) {
			return []string{"2606:4700::1", "::ffff:127.0.0.1"}, nil
		},
		"empty": func(context.Context, string) ([]string, error) { return nil, nil },
		"fail":  func(context.Context, string) ([]string, error) { return nil, errors.New("nxdomain") },
	} {
		c := fetchClient(t, "127.0.0.1:1", lookup)
		_, err := c.Proxy.Fetch(ctx, "https://rebind.example/", FetchOptions{})
		var pe *ProxyError
		if !errors.As(err, &pe) || strings.Contains(err.Error(), "connect") {
			t.Fatalf("%s: %v", name, err)
		}
	}
}

func TestFetchHTTPViaGateway(t *testing.T) {
	var gotAuth, gotURI, gotHost, gotDropped string
	gw := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotAuth = r.Header.Get("Proxy-Authorization")
		gotURI = r.RequestURI
		gotHost = r.Host
		gotDropped = r.Header.Get("Authorization") + r.Header.Get("X-Custom")
		switch r.URL.Path {
		case "/redirect":
			w.Header().Set("Location", "https://elsewhere.example/")
			w.WriteHeader(302)
		case "/big":
			_, _ = w.Write([]byte(strings.Repeat("z", 5000)))
		default:
			_, _ = w.Write([]byte("hello"))
		}
	}))
	defer gw.Close()
	c := fetchClient(t, gw.Listener.Addr().String(), publicLookup)
	ctx := context.Background()
	opts := FetchOptions{Routing: RoutingOptions{Country: "US", AllowHTTP: true}, Headers: map[string]string{"Authorization": "x", "X-Custom": "1"}}
	r, err := c.Proxy.Fetch(ctx, "http://example.com/path?q=1", opts)
	if err != nil || r.Status != 200 || r.Text() != "hello" || r.Truncated {
		t.Fatalf("%+v %v", r, err)
	}
	wantAuth := "Basic " + base64.StdEncoding.EncodeToString([]byte("country-US-allowhttp-1:"+testKey))
	if gotAuth != wantAuth || gotURI != "http://example.com/path?q=1" || gotHost != "example.com" || gotDropped != "1" {
		t.Fatalf("auth=%q uri=%q host=%q hdr=%q", gotAuth, gotURI, gotHost, gotDropped)
	}
	r, err = c.Proxy.Fetch(ctx, "http://example.com/redirect", opts)
	if err != nil || r.Status != 302 || r.Headers["location"] != "https://elsewhere.example/" {
		t.Fatalf("redirect: %+v %v", r, err)
	}
	opts.MaxBytes = 1000
	r, err = c.Proxy.Fetch(ctx, "http://example.com/big", opts)
	if err != nil || len(r.Body) != 1000 || !r.Truncated {
		t.Fatalf("truncate: %d %v %v", len(r.Body), r.Truncated, err)
	}
	r, err = c.Proxy.Fetch(ctx, "http://example.com/big", FetchOptions{Routing: RoutingOptions{AllowHTTP: true}, Method: "HEAD"})
	if err != nil || len(r.Body) != 0 {
		t.Fatalf("head: %v", err)
	}
}

func TestFetchConnectRefused(t *testing.T) {
	gw := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodConnect || r.Host != "example.com:443" {
			t.Errorf("got %s %s", r.Method, r.Host)
		}
		w.Header().Set("X-DominusNode-Error", "INVALID_API_KEY")
		w.Header().Set("Retry-After", "7")
		w.WriteHeader(http.StatusProxyAuthRequired)
	}))
	defer gw.Close()
	c := fetchClient(t, gw.Listener.Addr().String(), publicLookup)
	_, err := c.Proxy.Fetch(context.Background(), "https://example.com/", FetchOptions{})
	var pe *ProxyError
	if !errors.As(err, &pe) || pe.StatusCode != 407 || strings.Contains(err.Error(), testKey) {
		t.Fatalf("%v", err)
	}
	// The relay error code from X-DominusNode-Error is surfaced.
	if pe.Code != "INVALID_API_KEY" || pe.Details["retryAfter"] != 7 || !strings.Contains(err.Error(), "INVALID_API_KEY") {
		t.Fatalf("code=%q details=%v", pe.Code, pe.Details)
	}
}

// A CONNECT gateway that tunnels to a local TLS server; verifies end-to-end TLS.
func TestFetchConnectTunnel(t *testing.T) {
	origin := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = w.Write([]byte("secure " + r.URL.RequestURI() + " " + r.Host))
	}))
	defer origin.Close()
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer ln.Close()
	var connectAuth string
	go func() {
		conn, err := ln.Accept()
		if err != nil {
			return
		}
		defer conn.Close()
		br := bufio.NewReader(conn)
		req, err := http.ReadRequest(br)
		if err != nil {
			return
		}
		connectAuth = req.Header.Get("Proxy-Authorization")
		up, err := net.Dial("tcp", origin.Listener.Addr().String())
		if err != nil {
			return
		}
		defer up.Close()
		_, _ = io.WriteString(conn, "HTTP/1.1 200 Connection established\r\n\r\n")
		go func() { _, _ = io.Copy(up, br) }()
		_, _ = io.Copy(conn, up)
	}()
	c := fetchClient(t, ln.Addr().String(), publicLookup)
	pool := x509.NewCertPool()
	pool.AddCert(origin.Certificate())
	c.Proxy.tlsRoots = pool
	// httptest certs are valid for "example.com".
	r, err := c.Proxy.Fetch(context.Background(), "https://example.com/a?b=1", FetchOptions{Routing: RoutingOptions{SessionID: "s1"}, Timeout: 5 * time.Second})
	if err != nil || r.Status != 200 || r.Text() != "secure /a?b=1 example.com" {
		t.Fatalf("%+v %v", r, err)
	}
	if connectAuth != "Basic "+base64.StdEncoding.EncodeToString([]byte("session-s1:"+testKey)) {
		t.Fatal(connectAuth)
	}
}

func TestFetchTLSVerificationOn(t *testing.T) {
	origin := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {}))
	defer origin.Close()
	ln, _ := net.Listen("tcp", "127.0.0.1:0")
	defer ln.Close()
	go func() {
		conn, err := ln.Accept()
		if err != nil {
			return
		}
		defer conn.Close()
		br := bufio.NewReader(conn)
		if _, err := http.ReadRequest(br); err != nil {
			return
		}
		up, _ := net.Dial("tcp", origin.Listener.Addr().String())
		defer up.Close()
		_, _ = io.WriteString(conn, "HTTP/1.1 200 OK\r\n\r\n")
		go func() { _, _ = io.Copy(up, br) }()
		_, _ = io.Copy(conn, up)
	}()
	c := fetchClient(t, ln.Addr().String(), publicLookup) // no test roots: self-signed must fail
	_, err := c.Proxy.Fetch(context.Background(), "https://example.com/", FetchOptions{Timeout: 5 * time.Second})
	if !isType[*ProxyError](err) {
		t.Fatalf("untrusted cert accepted: %v", err)
	}
}

func TestFetchTimeout(t *testing.T) {
	ln, _ := net.Listen("tcp", "127.0.0.1:0")
	defer ln.Close()
	go func() {
		conn, err := ln.Accept()
		if err == nil {
			time.Sleep(500 * time.Millisecond)
			conn.Close()
		}
	}()
	c := fetchClient(t, ln.Addr().String(), publicLookup)
	_, err := c.Proxy.Fetch(context.Background(), "https://example.com/", FetchOptions{Timeout: 50 * time.Millisecond})
	if !isType[*ProxyError](err) || !strings.Contains(err.Error(), "timed out") {
		t.Fatalf("%v", err)
	}
}

func TestFetchNeedsKey(t *testing.T) {
	c := fetchClient(t, "127.0.0.1:1", publicLookup)
	c.apiKey = ""
	if _, err := c.Proxy.Fetch(context.Background(), "https://example.com/", FetchOptions{}); !isType[*AuthenticationError](err) {
		t.Fatal(err)
	}
}

func TestDefaultHosts(t *testing.T) {
	if DefaultBaseURL != "https://api.dominusnode.com" {
		t.Fatalf("DefaultBaseURL = %q", DefaultBaseURL)
	}
	if DefaultProxyHost != "proxy.dominusnode.com" {
		t.Fatalf("DefaultProxyHost = %q", DefaultProxyHost)
	}
}
