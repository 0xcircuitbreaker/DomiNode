package dominusnode

import (
	"bufio"
	"context"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/tls"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/base64"
	"encoding/pem"
	"io"
	"math/big"
	"net"
	"net/http"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"
)

// selfSigned returns a TLS certificate for the given names plus its PEM.
func selfSigned(t *testing.T, dns []string, ips []net.IP) (tls.Certificate, []byte) {
	t.Helper()
	k, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	tpl := &x509.Certificate{
		SerialNumber: big.NewInt(time.Now().UnixNano()), Subject: pkix.Name{CommonName: dns[0]},
		NotBefore: time.Now().Add(-time.Hour), NotAfter: time.Now().Add(time.Hour),
		DNSNames: dns, IPAddresses: ips, KeyUsage: x509.KeyUsageDigitalSignature,
		ExtKeyUsage: []x509.ExtKeyUsage{x509.ExtKeyUsageServerAuth},
	}
	der, err := x509.CreateCertificate(rand.Reader, tpl, tpl, &k.PublicKey, k)
	if err != nil {
		t.Fatal(err)
	}
	return tls.Certificate{Certificate: [][]byte{der}, PrivateKey: k}, pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: der})
}

// tlsGateway is a fake HTTPS proxy. On CONNECT it answers 200 and then itself terminates the
// inner TLS (as the "target") on the same connection, so a successful response proves the inner
// request rode the tunnel. Plain requests get "via-gw <uri>".
type tlsGateway struct {
	ln       net.Listener
	mu       sync.Mutex
	accepted int
	connects []string
	auth     []string
}

func newTLSGateway(t *testing.T, gwCert, originCert tls.Certificate) *tlsGateway {
	t.Helper()
	ln, err := tls.Listen("tcp", "127.0.0.1:0", &tls.Config{Certificates: []tls.Certificate{gwCert}})
	if err != nil {
		t.Fatal(err)
	}
	g := &tlsGateway{ln: ln}
	t.Cleanup(func() { _ = ln.Close() })
	go func() {
		for {
			conn, err := ln.Accept()
			if err != nil {
				return
			}
			go g.handle(conn, originCert)
		}
	}()
	return g
}

func (g *tlsGateway) handle(conn net.Conn, originCert tls.Certificate) {
	defer conn.Close()
	_ = conn.SetDeadline(time.Now().Add(5 * time.Second))
	g.mu.Lock()
	g.accepted++
	g.mu.Unlock()
	br := bufio.NewReader(conn)
	req, err := http.ReadRequest(br)
	if err != nil {
		return
	}
	g.mu.Lock()
	g.auth = append(g.auth, req.Header.Get("Proxy-Authorization"))
	if req.Method == http.MethodConnect {
		g.connects = append(g.connects, req.Host)
	}
	g.mu.Unlock()
	if req.Method != http.MethodConnect {
		body := "via-gw " + req.RequestURI
		_, _ = io.WriteString(conn, "HTTP/1.1 200 OK\r\nContent-Length: "+strconv.Itoa(len(body))+"\r\nConnection: close\r\n\r\n"+body)
		return
	}
	_, _ = io.WriteString(conn, "HTTP/1.1 200 Connection established\r\n\r\n")
	inner := tls.Server(conn, &tls.Config{Certificates: []tls.Certificate{originCert}})
	ir, err := http.ReadRequest(bufio.NewReader(inner))
	if err != nil {
		return
	}
	body := "tunneled " + ir.Host + ir.URL.RequestURI()
	_, _ = io.WriteString(inner, "HTTP/1.1 200 OK\r\nContent-Length: "+strconv.Itoa(len(body))+"\r\nConnection: close\r\n\r\n"+body)
	_ = inner.Close()
}

func (g *tlsGateway) port() int { return g.ln.Addr().(*net.TCPAddr).Port }

func TestGatewayTLSConnectInsideTLS(t *testing.T) {
	gwCert, gwPEM := selfSigned(t, []string{"localhost"}, []net.IP{net.ParseIP("127.0.0.1")})
	originCert, originPEM := selfSigned(t, []string{"example.com"}, nil)
	g := newTLSGateway(t, gwCert, originCert)
	c, err := NewClient(Config{ProxyHost: "localhost", Lookup: publicLookup, GatewayTLS: &GatewayTLS{Port: g.port(), CA: gwPEM}})
	if err != nil {
		t.Fatal(err)
	}
	c.apiKey = testKey
	pool := x509.NewCertPool()
	pool.AppendCertsFromPEM(originPEM)
	c.Proxy.tlsRoots = pool
	r, err := c.Proxy.Fetch(context.Background(), "https://example.com/a?b=1", FetchOptions{Routing: RoutingOptions{Country: "US"}, Timeout: 5 * time.Second})
	if err != nil || r.Status != 200 || r.Text() != "tunneled example.com/a?b=1" {
		t.Fatalf("%+v %v", r, err)
	}
	if len(g.connects) != 1 || g.connects[0] != "example.com:443" {
		t.Fatalf("connects %v", g.connects)
	}
	if g.auth[0] != "Basic "+base64.StdEncoding.EncodeToString([]byte("country-US:"+testKey)) {
		t.Fatal(g.auth[0])
	}
	// http:// absolute-URI request also goes over the TLS channel; IP host + ServerName override.
	c2, err := NewClient(Config{ProxyHost: "127.0.0.1", Lookup: publicLookup, GatewayTLS: &GatewayTLS{Port: g.port(), CA: gwPEM, ServerName: "localhost"}})
	if err != nil {
		t.Fatal(err)
	}
	c2.apiKey = testKey
	r, err = c2.Proxy.Fetch(context.Background(), "http://example.com/p", FetchOptions{Routing: RoutingOptions{AllowHTTP: true}, Timeout: 5 * time.Second})
	if err != nil || r.Text() != "via-gw http://example.com/p" {
		t.Fatalf("%+v %v", r, err)
	}
}

func TestGatewayTLSUnverifiedRefused(t *testing.T) {
	gwCert, gwPEM := selfSigned(t, []string{"localhost"}, nil)
	g := newTLSGateway(t, gwCert, gwCert)
	for name, cfg := range map[string]*GatewayTLS{
		"no ca":    {Port: g.port()},
		"bad name": {Port: g.port(), CA: gwPEM, ServerName: "other.example"},
	} {
		c, err := NewClient(Config{ProxyHost: "localhost", Lookup: publicLookup, GatewayTLS: cfg})
		if err != nil {
			t.Fatal(err)
		}
		c.apiKey = testKey
		_, err = c.Proxy.Fetch(context.Background(), "https://example.com/", FetchOptions{Timeout: 5 * time.Second})
		if !isType[*ProxyError](err) || strings.Contains(err.Error(), testKey) {
			t.Fatalf("%s: %v", name, err)
		}
	}
	time.Sleep(50 * time.Millisecond)
	g.mu.Lock()
	defer g.mu.Unlock()
	if len(g.auth) != 0 {
		t.Fatalf("request sent over unverified TLS: %v", g.auth)
	}
}

func TestGatewayTLSBuildURLAndConfig(t *testing.T) {
	c, err := NewClient(Config{ProxyHost: "proxy.example.com", GatewayTLS: &GatewayTLS{}})
	if err != nil {
		t.Fatal(err)
	}
	c.apiKey = testKey
	u, _ := c.Proxy.BuildURL(RoutingOptions{}, "", "")
	if !strings.HasPrefix(u, "https://relay:dn_live_") || !strings.HasSuffix(u, "@proxy.example.com:8443") {
		t.Fatal(u)
	}
	if u, _ = c.Proxy.BuildURL(RoutingOptions{}, "http", ""); !strings.HasSuffix(u, ":8080") {
		t.Fatal(u)
	}
	dflt, _ := NewClient(Config{ProxyHost: "proxy.example.com"})
	dflt.apiKey = testKey
	if u, _ = dflt.Proxy.BuildURL(RoutingOptions{}, "", ""); !strings.HasPrefix(u, "https://") || !strings.HasSuffix(u, ":8443") {
		t.Fatalf("2.2 default must be TLS: %s", u)
	}
	plain, _ := NewClient(Config{ProxyHost: "proxy.example.com", GatewayTLS: &GatewayTLS{Disabled: true}})
	plain.apiKey = testKey
	if u, _ = plain.Proxy.BuildURL(RoutingOptions{}, "", ""); !strings.HasPrefix(u, "http://") {
		t.Fatal(u)
	}
	if _, err := plain.Proxy.BuildURL(RoutingOptions{}, "https", ""); !isType[*ValidationError](err) {
		t.Fatal(err)
	}
	for _, g := range []*GatewayTLS{{Port: 70000}, {Port: -1}, {ServerName: "bad name"}, {CA: []byte("not pem")}} {
		if _, err := NewClient(Config{GatewayTLS: g}); !isType[*ValidationError](err) {
			t.Fatalf("%+v: %v", g, err)
		}
	}
}
