package dominusnode

import (
	"bufio"
	"context"
	"crypto/tls"
	"crypto/x509"
	"encoding/base64"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"regexp"
	"strconv"
	"strings"
	"time"
)

// RoutingOptions are the gateway routing flags, encoded into the proxy USERNAME.
type RoutingOptions struct {
	// Country: ISO 3166-1 alpha-2 -> country-XX (OFAC CU IR KP RU SY refused).
	Country string
	// IPClass: "residential", "dc" or "mobile" -> class-<c>.
	IPClass string
	// SessionID: 1-64 alphanumeric -> session-<id>.
	SessionID string
	// AgenticWalletID: UUID -> wallet-<uuid>.
	AgenticWalletID string
	// AllowHTTP opts in to plaintext http:// -> allowhttp-1.
	AllowHTTP bool
}

var (
	countryRE   = regexp.MustCompile(`^[A-Za-z]{2}$`)
	sessionIDRE = regexp.MustCompile(`^[A-Za-z0-9]{1,64}$`)
	proxyHostRE = regexp.MustCompile(`^[A-Za-z0-9.-]{1,253}$|^\[[0-9A-Fa-f:.]+\]$`)
	headerTokRE = regexp.MustCompile("^[!#$%&'*+.^_`|~0-9A-Za-z-]+$")
	ofacBlocked = map[string]bool{"CU": true, "IR": true, "KP": true, "RU": true, "SY": true}
)

// BuildProxyUsername builds the hyphen-joined username ("relay" when no flags).
func BuildProxyUsername(o RoutingOptions) (string, error) {
	var parts []string
	if o.Country != "" {
		if !countryRE.MatchString(o.Country) {
			return "", invalidArg("country must be a 2-letter ISO code")
		}
		c := strings.ToUpper(o.Country)
		if ofacBlocked[c] {
			return "", invalidArg("country %s is sanctioned (OFAC) and cannot be targeted", c)
		}
		parts = append(parts, "country-"+c)
	}
	if o.IPClass != "" {
		if !oneOf(o.IPClass, []string{"residential", "dc", "mobile"}) {
			return "", invalidArg("ipClass must be residential, dc or mobile")
		}
		parts = append(parts, "class-"+o.IPClass)
	}
	if o.SessionID != "" {
		if !sessionIDRE.MatchString(o.SessionID) {
			return "", invalidArg("sessionId must be 1-64 alphanumeric characters")
		}
		parts = append(parts, "session-"+o.SessionID)
	}
	if o.AgenticWalletID != "" {
		if !uuidRE.MatchString(o.AgenticWalletID) {
			return "", invalidArg("agenticWalletId must be a UUID")
		}
		parts = append(parts, "wallet-"+strings.ToLower(o.AgenticWalletID))
	}
	if o.AllowHTTP {
		parts = append(parts, "allowhttp-1")
	}
	if len(parts) == 0 {
		return "relay", nil
	}
	return strings.Join(parts, "-"), nil
}

// ProxyResource: gateway helpers. API key in the PASSWORD, flags in the USERNAME.
type ProxyResource struct {
	h         *httpClient
	host      string
	httpPort  int
	socksPort int
	apiKey    func() string
	lookup    LookupFunc
	tlsRoots  *x509.CertPool // tests only
}

func newProxyResource(h *httpClient, cfg Config, apiKey func() string) (*ProxyResource, error) {
	host := cfg.ProxyHost
	if host == "" {
		host = DefaultProxyHost
	}
	if !proxyHostRE.MatchString(host) {
		return nil, invalidArg("proxyHost contains invalid characters")
	}
	hp, sp := cfg.HTTPProxyPort, cfg.SOCKS5ProxyPort
	if hp == 0 {
		hp = DefaultHTTPProxyPort
	}
	if sp == 0 {
		sp = DefaultSOCKS5ProxyPort
	}
	if hp < 1 || hp > 65535 {
		return nil, invalidArg("httpProxyPort must be a TCP port")
	}
	if sp < 1 || sp > 65535 {
		return nil, invalidArg("socks5ProxyPort must be a TCP port")
	}
	return &ProxyResource{h: h, host: host, httpPort: hp, socksPort: sp, apiKey: apiKey, lookup: cfg.Lookup}, nil
}

func (p *ProxyResource) key(override string) (string, error) {
	k := override
	if k == "" {
		k = p.apiKey()
	}
	if k == "" {
		return "", authErr("proxy access needs an API key: call ConnectWithKey() or pass apiKey")
	}
	if err := ValidateAPIKey(k); err != nil {
		return "", err
	}
	return k, nil
}

// BuildUsername returns the gateway username for the flags ("relay" when none).
func (p *ProxyResource) BuildUsername(o RoutingOptions) (string, error) { return BuildProxyUsername(o) }

// BuildURL returns <protocol>://<user>:<key>@<host>:<port>. protocol "" = "http",
// or "socks5". apiKey "" = the connected key. The result CONTAINS the key: do not log it.
func (p *ProxyResource) BuildURL(o RoutingOptions, protocol, apiKey string) (string, error) {
	if protocol == "" {
		protocol = "http"
	}
	if protocol != "http" && protocol != "socks5" {
		return "", invalidArg("protocol must be http or socks5")
	}
	port := p.httpPort
	if protocol == "socks5" {
		port = p.socksPort
	}
	user, err := BuildProxyUsername(o)
	if err != nil {
		return "", err
	}
	k, err := p.key(apiKey)
	if err != nil {
		return "", err
	}
	return fmt.Sprintf("%s://%s:%s@%s:%d", protocol, url.QueryEscape(user), url.QueryEscape(k), p.host, port), nil
}

// ProxyHealth is the response of GET /api/proxy/health.
type ProxyHealth struct {
	Status         string  `json:"status"`
	ActiveSessions int     `json:"activeSessions"`
	UptimeSeconds  float64 `json:"uptimeSeconds"`
}

// GetHealth: GET /api/proxy/health [none].
func (p *ProxyResource) GetHealth(ctx context.Context) (*ProxyHealth, error) {
	var out ProxyHealth
	return &out, p.h.get(ctx, "/api/proxy/health", authNone, &out)
}

// GetConfig: GET /api/proxy/config [jwt].
func (p *ProxyResource) GetConfig(ctx context.Context) (map[string]any, error) {
	out := map[string]any{}
	return out, p.h.get(ctx, "/api/proxy/config", authJWT, &out)
}

// FetchOptions configures Proxy.Fetch.
type FetchOptions struct {
	Routing RoutingOptions
	// Method: "GET" (default) or "HEAD".
	Method  string
	Headers map[string]string
	// Timeout: default 30s, clamped to 1ms..120s.
	Timeout time.Duration
	// MaxBytes: default and maximum 10 MB; longer bodies are truncated.
	MaxBytes int
	// APIKey overrides the connected key.
	APIKey string
}

// FetchResponse is the result of Proxy.Fetch.
type FetchResponse struct {
	Status     int
	StatusText string
	Headers    map[string]string
	Body       []byte
	// Truncated is true when the body was cut at MaxBytes.
	Truncated bool
}

// Text returns the body as a string.
func (r *FetchResponse) Text() string { return string(r.Body) }

var forbiddenHeaders = map[string]bool{
	"host": true, "connection": true, "content-length": true, "transfer-encoding": true,
	"proxy-authorization": true, "proxy-connection": true, "authorization": true, "upgrade": true,
	"te": true, "trailer": true, "keep-alive": true,
}

func cleanHeaders(h map[string]string) (map[string]string, error) {
	out := map[string]string{}
	for k, v := range h {
		if strings.ContainsAny(k, "\r\n\x00") || strings.ContainsAny(v, "\r\n\x00") || !headerTokRE.MatchString(k) {
			n := k
			if len(n) > 40 {
				n = n[:40]
			}
			return nil, invalidArg("header %q contains invalid characters", n)
		}
		if !forbiddenHeaders[strings.ToLower(k)] {
			out[k] = v
		}
	}
	return out, nil
}

// Fetch GETs/HEADs url through the relay gateway. https:// uses a CONNECT tunnel
// with end-to-end TLS (>= 1.2, verified); http:// needs Routing.AllowHTTP and is
// sent as an absolute-URI request. Ports 80/443 only; private targets and names
// resolving to ANY private address are refused; redirects are returned, not followed.
func (p *ProxyResource) Fetch(ctx context.Context, rawURL string, o FetchOptions) (*FetchResponse, error) {
	method := strings.ToUpper(o.Method)
	if method == "" {
		method = "GET"
	}
	if method != "GET" && method != "HEAD" {
		return nil, invalidArg("proxy.fetch only allows GET and HEAD")
	}
	target, host, err := validateTargetURL(rawURL)
	if err != nil {
		return nil, err
	}
	if target.Scheme == "http" && !o.Routing.AllowHTTP {
		return nil, invalidArg("plaintext http:// requires AllowHTTP (the exit node can read and modify it); prefer https://")
	}
	username, err := BuildProxyUsername(o.Routing)
	if err != nil {
		return nil, err
	}
	headers, err := cleanHeaders(o.Headers)
	if err != nil {
		return nil, err
	}
	timeout := o.Timeout
	if timeout == 0 {
		timeout = 30 * time.Second
	}
	if timeout < time.Millisecond {
		timeout = time.Millisecond
	}
	if timeout > 120*time.Second {
		timeout = 120 * time.Second
	}
	maxBytes := o.MaxBytes
	if maxBytes <= 0 || maxBytes > MaxResponseBytes {
		maxBytes = MaxResponseBytes
	}
	apiKey, err := p.key(o.APIKey)
	if err != nil {
		return nil, err
	}
	ctx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()
	if err := assertPublicResolution(ctx, host, p.lookup); err != nil {
		return nil, err
	}
	auth := "Basic " + base64.StdEncoding.EncodeToString([]byte(username+":"+apiKey))
	res, err := p.roundTrip(ctx, auth, target, method, headers, maxBytes)
	if err != nil {
		var pe *ProxyError
		if errors.As(err, &pe) {
			return nil, err
		}
		if ctx.Err() != nil {
			return nil, proxyErr(0, "Proxy request timed out after %s", timeout)
		}
		return nil, proxyErr(0, "Proxy request failed: %s", ScrubCredentials(err.Error()))
	}
	return res, nil
}

func (p *ProxyResource) roundTrip(ctx context.Context, auth string, target *url.URL, method string, headers map[string]string, maxBytes int) (*FetchResponse, error) {
	proxyHost := strings.TrimSuffix(strings.TrimPrefix(p.host, "["), "]")
	var d net.Dialer
	conn, err := d.DialContext(ctx, "tcp", net.JoinHostPort(proxyHost, strconv.Itoa(p.httpPort)))
	if err != nil {
		return nil, err
	}
	defer conn.Close()
	if dl, ok := ctx.Deadline(); ok {
		_ = conn.SetDeadline(dl)
	}
	stop := context.AfterFunc(ctx, func() { _ = conn.SetDeadline(time.Unix(1, 0)) })
	defer stop()

	hostHeader := target.Host
	var rw io.ReadWriter = conn
	var requestTarget string
	if target.Scheme == "https" {
		port := target.Port()
		if port == "" {
			port = "443"
		}
		authority := net.JoinHostPort(target.Hostname(), port)
		if _, err := fmt.Fprintf(conn, "CONNECT %s HTTP/1.1\r\nHost: %s\r\nProxy-Authorization: %s\r\n\r\n", authority, authority, auth); err != nil {
			return nil, err
		}
		br := bufio.NewReader(conn)
		cres, err := http.ReadResponse(br, &http.Request{Method: "CONNECT"})
		if err != nil {
			return nil, err
		}
		_ = cres.Body.Close()
		if cres.StatusCode != 200 {
			return nil, proxyErr(cres.StatusCode, "Proxy refused CONNECT (HTTP %d)", cres.StatusCode)
		}
		if br.Buffered() > 0 {
			return nil, proxyErr(0, "Proxy sent unexpected data after CONNECT")
		}
		tc := tls.Client(conn, &tls.Config{ServerName: target.Hostname(), MinVersion: tls.VersionTLS12, RootCAs: p.tlsRoots})
		if err := tc.HandshakeContext(ctx); err != nil {
			return nil, err
		}
		defer tc.Close()
		rw = tc
		requestTarget = target.EscapedPath()
		if requestTarget == "" {
			requestTarget = "/"
		}
		if target.RawQuery != "" {
			requestTarget += "?" + target.RawQuery
		}
	} else {
		u := *target
		u.Fragment, u.RawFragment = "", ""
		requestTarget = u.String()
		if u.Path == "" && u.RawQuery == "" {
			requestTarget += "/"
		}
	}

	var sb strings.Builder
	fmt.Fprintf(&sb, "%s %s HTTP/1.1\r\nHost: %s\r\n", method, requestTarget, hostHeader)
	for k, v := range headers {
		fmt.Fprintf(&sb, "%s: %s\r\n", k, v)
	}
	if target.Scheme == "http" {
		fmt.Fprintf(&sb, "Proxy-Authorization: %s\r\n", auth)
	}
	sb.WriteString("Connection: close\r\n\r\n")
	if _, err := io.WriteString(rw, sb.String()); err != nil {
		return nil, err
	}
	res, err := http.ReadResponse(bufio.NewReader(rw), &http.Request{Method: method})
	if err != nil {
		return nil, err
	}
	defer res.Body.Close()
	out := &FetchResponse{
		Status:     res.StatusCode,
		StatusText: strings.TrimSpace(strings.TrimPrefix(res.Status, strconv.Itoa(res.StatusCode))),
		Headers:    map[string]string{},
	}
	for k, v := range res.Header {
		out.Headers[strings.ToLower(k)] = strings.Join(v, ", ")
	}
	if method == "HEAD" {
		return out, nil
	}
	body, err := io.ReadAll(io.LimitReader(res.Body, int64(maxBytes)+1))
	if err != nil && len(body) == 0 {
		return nil, err
	}
	if len(body) > maxBytes {
		body = body[:maxBytes]
		out.Truncated = true
	}
	out.Body = body
	return out, nil
}
