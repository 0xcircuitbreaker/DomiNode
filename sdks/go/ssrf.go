package dominusnode

import (
	"context"
	"net"
	"net/url"
	"strconv"
	"strings"
)

var blockedHostnames = map[string]bool{
	"localhost": true, "localhost.localdomain": true, "ip6-localhost": true, "ip6-loopback": true,
}
var blockedSuffixes = []string{".localhost", ".local", ".internal", ".arpa"}

// normalizeIPv4 decodes decimal/hex/octal/short IPv4 forms (2130706433,
// 0x7f000001, 0177.0.0.1, 127.1) with inet_aton semantics. ok=false if not IPv4-like.
func normalizeIPv4(host string) (net.IP, bool) {
	parts := strings.Split(host, ".")
	if len(parts) < 1 || len(parts) > 4 {
		return nil, false
	}
	nums := make([]uint64, 0, 4)
	for _, p := range parts {
		var v uint64
		var err error
		lp := strings.ToLower(p)
		switch {
		case len(lp) > 2 && strings.HasPrefix(lp, "0x"):
			v, err = strconv.ParseUint(lp[2:], 16, 64)
		case len(p) > 1 && p[0] == '0':
			v, err = strconv.ParseUint(p[1:], 8, 64)
		case p != "" && p[0] >= '0' && p[0] <= '9':
			v, err = strconv.ParseUint(p, 10, 64)
		default:
			return nil, false
		}
		if err != nil {
			return nil, false
		}
		nums = append(nums, v)
	}
	last := nums[len(nums)-1]
	head := nums[:len(nums)-1]
	for _, n := range head {
		if n > 255 {
			return nil, false
		}
	}
	rem := 4 - len(head)
	if last >= uint64(1)<<(8*uint(rem)) {
		return nil, false
	}
	b := make([]byte, 0, 4)
	for _, n := range head {
		b = append(b, byte(n))
	}
	for i := rem - 1; i >= 0; i-- {
		b = append(b, byte(last>>(8*uint(i))))
	}
	return net.IPv4(b[0], b[1], b[2], b[3]).To4(), true
}

func isPrivateV4(ip net.IP) bool {
	a, b := ip[0], ip[1]
	return a == 0 || a == 10 || a == 127 ||
		(a == 169 && b == 254) ||
		(a == 172 && b >= 16 && b <= 31) ||
		(a == 192 && b == 168) ||
		(a == 100 && b >= 64 && b <= 127) ||
		(a == 192 && b == 0 && (ip[2] == 0 || ip[2] == 2)) ||
		(a == 198 && (b == 18 || b == 19)) ||
		a >= 224
}

// IsPrivateIP reports whether host (an IP literal in any spelling, brackets and
// %zone allowed) is private/internal/reserved. Non-IP strings return false.
func IsPrivateIP(host string) bool {
	ip := strings.TrimSuffix(strings.TrimPrefix(host, "["), "]")
	if i := strings.IndexByte(ip, '%'); i >= 0 {
		ip = ip[:i]
	}
	if v4, ok := normalizeIPv4(ip); ok {
		return isPrivateV4(v4)
	}
	if !strings.Contains(ip, ":") {
		return false
	}
	p := net.ParseIP(ip)
	if p == nil {
		return false
	}
	b := p.To16()
	zero10 := true
	for _, x := range b[:10] {
		if x != 0 {
			zero10 = false
		}
	}
	tail := net.IP(b[12:16])
	if zero10 && b[10] == 0xff && b[11] == 0xff {
		return isPrivateV4(tail) // ::ffff:a.b.c.d
	}
	if zero10 && b[10] == 0 && b[11] == 0 {
		if b[12] == 0 && b[13] == 0 && b[14] == 0 {
			return true // :: and ::1 (and ::0.0.0.x)
		}
		return isPrivateV4(tail) // IPv4-compatible
	}
	switch {
	case b[0] == 0x00 && b[1] == 0x64 && b[2] == 0xff && b[3] == 0x9b:
		return isPrivateV4(tail) // NAT64 64:ff9b::/96
	case b[0]&0xfe == 0xfc: // fc00::/7
		return true
	case b[0] == 0xfe && b[1]&0xc0 == 0x80: // fe80::/10
		return true
	case b[0] == 0xfe && b[1]&0xc0 == 0xc0: // fec0::/10
		return true
	case b[0] == 0xff: // multicast
		return true
	case b[0] == 0x20 && b[1] == 0x01 && b[2] == 0 && b[3] == 0: // Teredo
		return true
	case b[0] == 0x20 && b[1] == 0x02: // 6to4
		return true
	case b[0] == 0x20 && b[1] == 0x01 && b[2] == 0x0d && b[3] == 0xb8: // documentation
		return true
	}
	return false
}

// validateTargetURL: http(s), no userinfo, port 80/443, no local names or private literals.
func validateTargetURL(raw string) (*url.URL, string, error) {
	u, err := url.Parse(raw)
	if err != nil {
		return nil, "", proxyErr(0, "Invalid URL")
	}
	if u.Scheme != "http" && u.Scheme != "https" {
		return nil, "", proxyErr(0, "Only http: and https: URLs are supported")
	}
	if u.User != nil {
		return nil, "", proxyErr(0, "URLs with embedded credentials are not allowed")
	}
	if p := u.Port(); p != "" && p != "80" && p != "443" {
		return nil, "", proxyErr(0, "Only ports 80 and 443 are reachable through the relay network")
	}
	host := strings.TrimSuffix(strings.ToLower(u.Hostname()), ".")
	if host == "" {
		return nil, "", proxyErr(0, "URL has no host")
	}
	if blockedHostnames[host] {
		return nil, "", proxyErr(0, "Requests to local/internal hostnames are blocked")
	}
	for _, s := range blockedSuffixes {
		if strings.HasSuffix(host, s) {
			return nil, "", proxyErr(0, "Requests to local/internal hostnames are blocked")
		}
	}
	if IsPrivateIP(host) {
		return nil, "", proxyErr(0, "Requests to private/internal IP addresses are blocked")
	}
	return u, host, nil
}

func defaultLookup(ctx context.Context, host string) ([]string, error) {
	addrs, err := net.DefaultResolver.LookupIPAddr(ctx, host)
	if err != nil {
		return nil, err
	}
	out := make([]string, 0, len(addrs))
	for _, a := range addrs {
		out = append(out, a.IP.String())
	}
	return out, nil
}

// assertPublicResolution is the DNS-rebinding guard: resolve and reject if ANY address is private.
func assertPublicResolution(ctx context.Context, host string, lookup LookupFunc) error {
	h := strings.TrimSuffix(strings.TrimPrefix(host, "["), "]")
	if _, isV4 := normalizeIPv4(h); isV4 || net.ParseIP(h) != nil {
		if IsPrivateIP(h) {
			return proxyErr(0, "Requests to private/internal IP addresses are blocked")
		}
		return nil
	}
	if lookup == nil {
		lookup = defaultLookup
	}
	addrs, err := lookup(ctx, h)
	if err != nil {
		return proxyErr(0, "DNS resolution failed for %s", h)
	}
	if len(addrs) == 0 {
		return proxyErr(0, "DNS resolution returned no addresses for %s", h)
	}
	for _, a := range addrs {
		if IsPrivateIP(a) || (net.ParseIP(a) == nil && !isV4Like(a)) {
			return proxyErr(0, "Hostname resolves to a private/internal IP address (blocked)")
		}
	}
	return nil
}

func isV4Like(s string) bool { _, ok := normalizeIPv4(s); return ok }
