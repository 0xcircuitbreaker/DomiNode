package io.dominusnode.sdk.proxy;

import io.dominusnode.sdk.internal.Validation;

import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Set;

/**
 * Gateway routing flags encoded into the proxy USERNAME (hyphen-joined, this order):
 * country-XX, class-&lt;c&gt;, session-&lt;id&gt;, wallet-&lt;uuid&gt;, allowhttp-1. None gives "relay".
 * Also carries the fetch-only options (method, headers, timeoutMs, maxBytes, apiKey).
 */
public final class ProxyOptions {
    private static final Set<String> OFAC = Set.of("CU", "IR", "KP", "RU", "SY");
    private static final Set<String> IP_CLASSES = Set.of("residential", "dc", "mobile", "masked");
    public static final int DEFAULT_TIMEOUT_MS = 30_000;
    public static final int MAX_TIMEOUT_MS = 120_000;
    public static final int MAX_BYTES = 10 * 1024 * 1024;

    String country;
    String ipClass;
    String sessionId;
    String agenticWalletId;
    boolean allowHttp;
    String method = "GET";
    final Map<String, String> headers = new LinkedHashMap<>();
    int timeoutMs = DEFAULT_TIMEOUT_MS;
    int maxBytes = MAX_BYTES;
    String apiKey;

    public static ProxyOptions create() { return new ProxyOptions(); }

    /** ISO 3166-1 alpha-2; OFAC-sanctioned countries are refused. */
    public ProxyOptions country(String v) { country = v; return this; }

    /** residential, dc, mobile or masked (VPN/WARP/Tor exits: cheapest, opt-in). */
    public ProxyOptions ipClass(String v) { ipClass = v; return this; }

    /** Sticky session id, 1-64 alphanumeric. */
    public ProxyOptions sessionId(String v) { sessionId = v; return this; }

    /** Spend from an agentic wallet (UUID). */
    public ProxyOptions agenticWalletId(String v) { agenticWalletId = v; return this; }

    /** Opt in to plaintext http:// (exit-visible). */
    public ProxyOptions allowHttp(boolean v) { allowHttp = v; return this; }

    /** fetch: GET (default) or HEAD. */
    public ProxyOptions method(String v) { method = v; return this; }

    /** fetch: add a request header. */
    public ProxyOptions header(String name, String value) { headers.put(name, value); return this; }

    /** fetch: timeout, clamped to 1..120,000 ms. */
    public ProxyOptions timeoutMs(int v) { timeoutMs = v; return this; }

    /** fetch: body cap, clamped to 1..10 MB. */
    public ProxyOptions maxBytes(int v) { maxBytes = v; return this; }

    /** Override the connected API key. */
    public ProxyOptions apiKey(String v) { apiKey = v; return this; }

    public String getApiKey() { return apiKey; }

    /** Build the gateway username; validates every flag. */
    public String buildUsername() {
        List<String> parts = new ArrayList<>();
        if (country != null) {
            if (!country.matches("^[A-Za-z]{2}$")) throw Validation.invalid("country must be a 2-letter ISO code");
            String c = country.toUpperCase(Locale.ROOT);
            if (OFAC.contains(c)) throw Validation.invalid("country " + c + " is sanctioned (OFAC) and cannot be targeted");
            parts.add("country-" + c);
        }
        if (ipClass != null) {
            if (!IP_CLASSES.contains(ipClass)) throw Validation.invalid("ipClass must be residential, dc, mobile or masked");
            parts.add("class-" + ipClass);
        }
        if (sessionId != null) {
            if (!sessionId.matches("^[A-Za-z0-9]{1,64}$")) throw Validation.invalid("sessionId must be 1-64 alphanumeric characters");
            parts.add("session-" + sessionId);
        }
        if (agenticWalletId != null) {
            Validation.uuid(agenticWalletId, "agenticWalletId");
            parts.add("wallet-" + agenticWalletId.toLowerCase(Locale.ROOT));
        }
        if (allowHttp) parts.add("allowhttp-1");
        return parts.isEmpty() ? "relay" : String.join("-", parts);
    }

    @Override
    public String toString() { return "ProxyOptions(" + buildUsernameSafe() + ")"; }

    private String buildUsernameSafe() {
        try { return buildUsername(); } catch (RuntimeException e) { return "invalid"; }
    }
}
