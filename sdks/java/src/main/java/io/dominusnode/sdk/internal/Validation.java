package io.dominusnode.sdk.internal;

import io.dominusnode.sdk.errors.ValidationException;

import java.math.BigInteger;
import java.net.URLEncoder;
import java.nio.charset.StandardCharsets;
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.UUID;
import java.util.regex.Pattern;

/** Client-side validation (raises ValidationException, code INVALID_ARGUMENT, before any request). Internal. */
public final class Validation {
    private Validation() {}

    public static final Pattern ETH_ADDRESS_RE = Pattern.compile("^0x[0-9a-fA-F]{40}$");
    public static final Pattern SIGNATURE_RE = Pattern.compile("^0x[0-9a-fA-F]{130}$");
    public static final int MAX_SIGNATURE_LENGTH = 200;
    public static final Pattern UUID_RE = Pattern.compile("^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$");
    public static final Pattern HEX64_RE = Pattern.compile("^[0-9a-f]{64}$");
    public static final Pattern IDEMPOTENCY_KEY_RE = Pattern.compile("^[A-Za-z0-9_-]{8,120}$");
    public static final Pattern API_KEY_RE = Pattern.compile("^dn_(live|test)_[A-Za-z0-9_-]{8,200}$");
    private static final Pattern MUSD_RE = Pattern.compile("^[1-9][0-9]{0,15}$");
    public static final long MAX_AMOUNT_CENTS = 2_147_483_647L;
    private static final long MAX_SAFE_INTEGER = 9_007_199_254_740_991L;

    public static ValidationException invalid(String m) { return ValidationException.invalidArg(m); }

    public static String address(String a, String name) {
        if (a == null || !ETH_ADDRESS_RE.matcher(a).matches()) {
            throw invalid(name + " must be an Ethereum address (0x followed by 40 hex characters)");
        }
        return a;
    }

    public static String signature(String s, String name) {
        if (s == null) throw invalid(name + " must be a string");
        if (s.length() > MAX_SIGNATURE_LENGTH) throw invalid(name + " must not exceed " + MAX_SIGNATURE_LENGTH + " characters");
        if (!SIGNATURE_RE.matcher(s).matches()) throw invalid(name + " must be an EIP-191 signature (0x followed by 130 hex characters)");
        return s;
    }

    public static long cents(long v, String name, boolean allowZero) {
        boolean ok = (allowZero ? v >= 0 : v > 0) && v <= MAX_AMOUNT_CENTS;
        if (!ok) throw invalid(name + " must be an integer " + (allowZero ? ">= 0" : "> 0") + " and <= " + MAX_AMOUNT_CENTS);
        return v;
    }

    /** Normalise a µUSD amount (BigInteger, Long/Integer safe integer, or digit string) and check bounds. */
    public static String musd(Object v, long min, long max, String name) {
        BigInteger n;
        if (v instanceof BigInteger) n = (BigInteger) v;
        else if ((v instanceof Long || v instanceof Integer) && Math.abs(((Number) v).longValue()) <= MAX_SAFE_INTEGER) {
            n = BigInteger.valueOf(((Number) v).longValue());
        } else if (v instanceof String && MUSD_RE.matcher((String) v).matches()) n = new BigInteger((String) v);
        else throw invalid(name + " must be a positive integer number of µUSD (BigInteger, digit string or long)");
        if (n.compareTo(BigInteger.valueOf(min)) < 0 || n.compareTo(BigInteger.valueOf(max)) > 0) {
            throw invalid(name + " must be between " + min + " and " + max + " µUSD");
        }
        return n.toString();
    }

    public static String idempotencyKey(String k) {
        if (k == null || !IDEMPOTENCY_KEY_RE.matcher(k).matches()) throw invalid("idempotencyKey must be 8-120 characters of [A-Za-z0-9_-]");
        return k;
    }

    public static String newIdempotencyKey() { return "dn-" + UUID.randomUUID(); }

    public static String uuid(String v, String name) {
        if (v == null || !UUID_RE.matcher(v).matches()) throw invalid(name + " must be a UUID");
        return v;
    }

    public static String nonEmpty(String v, String name, int max) {
        if (v == null || v.isEmpty() || v.length() > max) throw invalid(name + " must be a non-empty string (max " + max + ")");
        return v;
    }

    public static int intRange(int v, String name, int min, int max) {
        if (v < min || v > max) throw invalid(name + " must be an integer in [" + min + ", " + max + "]");
        return v;
    }

    public static String apiKey(String k) {
        if (k == null || !API_KEY_RE.matcher(k).matches()) throw invalid("apiKey must be a dn_live_ or dn_test_ key");
        return k;
    }

    /** encodeURIComponent semantics on top of URLEncoder. */
    public static String seg(String v) {
        if (v == null) throw invalid("path parameter is required");
        return URLEncoder.encode(v, StandardCharsets.UTF_8)
                .replace("+", "%20").replace("%21", "!").replace("%27", "'")
                .replace("%28", "(").replace("%29", ")").replace("%7E", "~");
    }

    /** Build a query string from alternating key/value pairs; null values are omitted. */
    public static String qs(Object... kv) {
        StringBuilder sb = new StringBuilder();
        for (int i = 0; i + 1 < kv.length; i += 2) {
            if (kv[i + 1] == null) continue;
            sb.append(sb.length() == 0 ? '?' : '&').append(seg(String.valueOf(kv[i]))).append('=').append(seg(String.valueOf(kv[i + 1])));
        }
        return sb.toString();
    }

    /** Ordered map from alternating key/value pairs; null values are omitted. */
    public static Map<String, Object> body(Object... kv) {
        Map<String, Object> m = new LinkedHashMap<>();
        for (int i = 0; i + 1 < kv.length; i += 2) if (kv[i + 1] != null) m.put((String) kv[i], kv[i + 1]);
        return m;
    }
}
