package io.dominusnode.sdk.proxy;

import io.dominusnode.sdk.errors.ProxyException;

import java.net.InetAddress;
import java.net.URI;
import java.util.List;
import java.util.Locale;
import java.util.Set;

/**
 * Client-side SSRF guard for proxy.fetch. Never performs DNS on its own except in
 * {@link #assertPublicResolution}, which checks EVERY resolved address (DNS-rebinding guard).
 */
public final class Ssrf {
    private Ssrf() {}

    private static final Set<String> BLOCKED_HOSTNAMES = Set.of("localhost", "localhost.localdomain", "ip6-localhost", "ip6-loopback");
    private static final String[] BLOCKED_SUFFIXES = {".localhost", ".local", ".internal", ".arpa"};

    /** Decode decimal/hex/octal/short IPv4 forms (inet_aton). Returns 4 bytes or null if not IPv4-like. */
    public static int[] normalizeIpv4(String host) {
        if (host == null || host.isEmpty() || host.endsWith(".") || host.startsWith(".")) return null;
        String[] parts = host.split("\\.", -1);
        if (parts.length < 1 || parts.length > 4) return null;
        long[] nums = new long[parts.length];
        for (int i = 0; i < parts.length; i++) {
            String p = parts[i];
            try {
                if (p.matches("(?i)^0x[0-9a-f]+$")) nums[i] = p.length() > 18 ? Long.MAX_VALUE : Long.parseLong(p.substring(2), 16);
                else if (p.matches("^0[0-7]+$")) nums[i] = p.length() > 22 ? Long.MAX_VALUE : Long.parseLong(p, 8);
                else if (p.matches("^(0|[1-9][0-9]*)$")) nums[i] = p.length() > 18 ? Long.MAX_VALUE : Long.parseLong(p);
                else return null;
            } catch (NumberFormatException e) {
                return null;
            }
        }
        long last = nums[nums.length - 1];
        for (int i = 0; i < nums.length - 1; i++) if (nums[i] > 255) return null;
        int rem = 4 - (nums.length - 1);
        if (last < 0 || last >= (1L << (8 * rem))) return null;
        int[] b = new int[4];
        for (int i = 0; i < nums.length - 1; i++) b[i] = (int) nums[i];
        for (int i = 0; i < rem; i++) b[nums.length - 1 + i] = (int) ((last >> (8 * (rem - 1 - i))) & 0xff);
        return b;
    }

    static boolean isPrivateV4(int a, int b) {
        return a == 0 || a == 10 || a == 127
                || (a == 169 && b == 254)
                || (a == 172 && b >= 16 && b <= 31)
                || (a == 192 && b == 168)
                || (a == 100 && b >= 64 && b <= 127)
                || (a == 192 && b == 0)
                || (a == 198 && (b == 18 || b == 19))
                || a >= 224;
    }

    /** Parse an IPv6 literal into 16 bytes (handles ::, embedded dotted IPv4). Null if not IPv6. */
    static int[] ipv6Bytes(String ip) {
        if (ip.indexOf(':') < 0 || !ip.matches("^[0-9a-fA-F:.]+$")) return null;
        int[] tail = null;
        String s = ip;
        int lastColon = s.lastIndexOf(':');
        String last = s.substring(lastColon + 1);
        if (last.contains(".")) {
            if (!last.matches("^\\d{1,3}(\\.\\d{1,3}){3}$")) return null;
            String[] q = last.split("\\.");
            tail = new int[4];
            for (int i = 0; i < 4; i++) {
                tail[i] = Integer.parseInt(q[i]);
                if (tail[i] > 255) return null;
            }
            s = s.substring(0, lastColon + 1) + "0:0";
        }
        int dbl = s.indexOf("::");
        if (dbl != s.lastIndexOf("::") && dbl >= 0) return null;
        String[] groups;
        if (dbl >= 0) {
            String head = s.substring(0, dbl);
            String rest = s.substring(dbl + 2);
            String[] h = head.isEmpty() ? new String[0] : head.split(":", -1);
            String[] r = rest.isEmpty() ? new String[0] : rest.split(":", -1);
            int fill = 8 - h.length - r.length;
            if (fill < 1) return null;
            groups = new String[8];
            int k = 0;
            for (String g : h) groups[k++] = g;
            for (int i = 0; i < fill; i++) groups[k++] = "0";
            for (String g : r) groups[k++] = g;
        } else {
            groups = s.split(":", -1);
        }
        if (groups.length != 8) return null;
        int[] bytes = new int[16];
        for (int i = 0; i < 8; i++) {
            String g = groups[i];
            if (g.isEmpty() || g.length() > 4) return null;
            int n;
            try { n = Integer.parseInt(g, 16); } catch (NumberFormatException e) { return null; }
            bytes[2 * i] = n >> 8;
            bytes[2 * i + 1] = n & 0xff;
        }
        if (tail != null) System.arraycopy(tail, 0, bytes, 12, 4);
        return bytes;
    }

    /** True for private/reserved IPv4 (any spelling) or IPv6 per SDK_SURFACE 3.15. False for non-IP strings. */
    public static boolean isPrivateIp(String host) {
        if (host == null) return false;
        String ip = host;
        if (ip.startsWith("[") && ip.endsWith("]")) ip = ip.substring(1, ip.length() - 1);
        int zone = ip.indexOf('%');
        if (zone >= 0) ip = ip.substring(0, zone);
        int[] v4 = normalizeIpv4(ip);
        if (v4 != null) return isPrivateV4(v4[0], v4[1]);
        int[] b = ipv6Bytes(ip.toLowerCase(Locale.ROOT));
        if (b == null) return false;
        boolean zero10 = true;
        for (int i = 0; i < 10; i++) if (b[i] != 0) { zero10 = false; break; }
        if (zero10 && b[10] == 0xff && b[11] == 0xff) return isPrivateV4(b[12], b[13]);
        if (zero10 && b[10] == 0 && b[11] == 0) {
            return (b[12] == 0 && b[13] == 0 && b[14] == 0) || isPrivateV4(b[12], b[13]);
        }
        if (b[0] == 0x00 && b[1] == 0x64 && b[2] == 0xff && b[3] == 0x9b) return isPrivateV4(b[12], b[13]);
        if ((b[0] & 0xfe) == 0xfc) return true;
        if (b[0] == 0xfe && (b[1] & 0xc0) == 0x80) return true;
        if (b[0] == 0xfe && (b[1] & 0xc0) == 0xc0) return true;
        if (b[0] == 0xff) return true;
        if (b[0] == 0x20 && b[1] == 0x01 && b[2] == 0 && b[3] == 0) return true;
        if (b[0] == 0x20 && b[1] == 0x02) return true;
        return b[0] == 0x20 && b[1] == 0x01 && b[2] == 0x0d && b[3] == 0xb8;
    }

    static boolean isIpLiteral(String host) {
        String h = host.startsWith("[") ? host.substring(1, host.length() - 1) : host;
        int z = h.indexOf('%');
        if (z >= 0) h = h.substring(0, z);
        return normalizeIpv4(h) != null || ipv6Bytes(h) != null;
    }

    /** Validate a proxy.fetch target URL. Returns the parsed URI. */
    public static URI validateTargetUrl(String url) {
        URI u;
        try {
            u = new URI(url);
        } catch (Exception e) {
            throw new ProxyException("Invalid URL");
        }
        String scheme = u.getScheme() == null ? "" : u.getScheme().toLowerCase(Locale.ROOT);
        if (!scheme.equals("http") && !scheme.equals("https")) throw new ProxyException("Only http: and https: URLs are supported");
        if (u.getRawUserInfo() != null || (u.getRawAuthority() != null && u.getRawAuthority().contains("@"))) {
            throw new ProxyException("URLs with embedded credentials are not allowed");
        }
        if (u.getPort() != -1 && u.getPort() != 80 && u.getPort() != 443) {
            throw new ProxyException("Only ports 80 and 443 are reachable through the relay network");
        }
        if (u.getHost() == null) throw new ProxyException("URL has no host");
        String host = hostOf(u);
        if (host.isEmpty()) throw new ProxyException("URL has no host");
        if (BLOCKED_HOSTNAMES.contains(host)) throw new ProxyException("Requests to local/internal hostnames are blocked");
        for (String s : BLOCKED_SUFFIXES) if (host.endsWith(s)) throw new ProxyException("Requests to local/internal hostnames are blocked");
        if (isPrivateIp(host)) throw new ProxyException("Requests to private/internal IP addresses are blocked");
        return u;
    }

    /** Lowercased host with the trailing dot removed (brackets kept for IPv6). */
    static String hostOf(URI u) {
        String h = u.getHost().toLowerCase(Locale.ROOT);
        return h.endsWith(".") ? h.substring(0, h.length() - 1) : h;
    }

    /** DNS-rebinding guard: resolve ALL addresses and fail if any is private, none returned, or lookup fails. */
    public static void assertPublicResolution(String hostname, HostResolver resolver) {
        String host = hostname.startsWith("[") ? hostname.substring(1, hostname.length() - 1) : hostname;
        if (isIpLiteral(host)) {
            if (isPrivateIp(host)) throw new ProxyException("Requests to private/internal IP addresses are blocked");
            return;
        }
        List<InetAddress> addrs;
        try {
            addrs = resolver.resolveAll(host);
        } catch (Exception e) {
            throw new ProxyException("DNS resolution failed for " + host);
        }
        if (addrs == null || addrs.isEmpty()) throw new ProxyException("DNS resolution returned no addresses for " + host);
        for (InetAddress a : addrs) {
            if (a == null || isPrivateIp(a.getHostAddress())) {
                throw new ProxyException("Hostname resolves to a private/internal IP address (blocked)");
            }
        }
    }
}
