package io.dominusnode.sdk.resources;

import com.fasterxml.jackson.databind.JsonNode;
import io.dominusnode.sdk.Secret;
import io.dominusnode.sdk.errors.ProtocolException;
import io.dominusnode.sdk.errors.ValidationException;
import io.dominusnode.sdk.internal.ApiClient;
import io.dominusnode.sdk.internal.ApiClient.Auth;
import io.dominusnode.sdk.internal.Validation;

import java.util.LinkedHashMap;
import java.util.Map;
import java.util.regex.Pattern;

import static io.dominusnode.sdk.internal.Validation.seg;

/**
 * Scoped, revocable dn_proxy_ tokens (AGENT_API.md "Proxy tokens"). Use the token as the
 * proxy password instead of the dn_live_ key. All routes are /v1 agent routes.
 */
public final class ProxyTokensResource {
    public static final Pattern PROXY_TOKEN_RE = Pattern.compile("^dn_proxy_[A-Za-z0-9_-]{43}$");
    public static final int MIN_TTL_SECONDS = 60;
    public static final int MAX_TTL_SECONDS = 365 * 24 * 3600;
    public static final long MAX_BYTES = 1_000_000_000_000_000L;
    public static final long MAX_SPEND_MUSD = 10_000_000_000_000L;
    private static final Pattern CTL_RE = Pattern.compile("[\\x00-\\x1f\\x7f]");
    private final ApiClient http;

    public ProxyTokensResource(ApiClient http) { this.http = http; }

    /** Options for {@link #create(CreateProxyTokenOptions)}; every field optional. */
    public static final class CreateProxyTokenOptions {
        private String label;
        private Integer ttlSeconds;
        private Object maxBytes;
        private Object maxSpendMusd;

        /** At most 64 printable characters. */
        public CreateProxyTokenOptions label(String v) { this.label = v; return this; }
        /** Lifetime 60..31536000 seconds (server default 30 days). */
        public CreateProxyTokenOptions ttlSeconds(Integer v) { this.ttlSeconds = v; return this; }
        /** Byte cap 1..10^15 (BigInteger, Long/Integer or digit string). */
        public CreateProxyTokenOptions maxBytes(Object v) { this.maxBytes = v; return this; }
        /** Spend cap in µUSD 1..10^13 (BigInteger, Long/Integer or digit string). */
        public CreateProxyTokenOptions maxSpendMusd(Object v) { this.maxSpendMusd = v; return this; }
    }

    /** A newly created token. {@code token} is returned once and prints as [REDACTED]. */
    public static final class CreatedProxyToken {
        public final String id;
        public final String label;
        public final String status;
        public final String expiresAt;
        /** Integer strings; null means no cap. */
        public final String maxBytes;
        public final String maxSpendMusd;
        public final String bytesUsed;
        public final String spendUsedMusd;
        public final String revokedAt;
        public final String createdAt;
        public final Secret token;

        CreatedProxyToken(JsonNode r, String tok) {
            id = text(r, "id");
            label = text(r, "label");
            status = text(r, "status");
            expiresAt = text(r, "expiresAt");
            maxBytes = text(r, "maxBytes");
            maxSpendMusd = text(r, "maxSpendMusd");
            bytesUsed = text(r, "bytesUsed");
            spendUsedMusd = text(r, "spendUsedMusd");
            revokedAt = text(r, "revokedAt");
            createdAt = text(r, "createdAt");
            token = new Secret(tok);
        }

        private static String text(JsonNode r, String k) {
            JsonNode v = r.get(k);
            return v == null || v.isNull() ? null : v.asText();
        }

        @Override
        public String toString() {
            return "CreatedProxyToken(id=" + id + ", label=" + label + ", status=" + status + ", expiresAt=" + expiresAt + ", token=[REDACTED])";
        }
    }

    private static String cap(Object v, long max, String name) {
        try {
            return Validation.musd(v, 1, max, name);
        } catch (ValidationException e) {
            throw Validation.invalid(name + " must be an integer between 1 and " + max);
        }
    }

    public CreatedProxyToken create() { return create(new CreateProxyTokenOptions()); }

    /** POST /v1/proxy-tokens; caps are sent as decimal strings. */
    public CreatedProxyToken create(CreateProxyTokenOptions o) {
        Map<String, Object> b = new LinkedHashMap<>();
        if (o.label != null) {
            if (o.label.codePointCount(0, o.label.length()) > 64 || CTL_RE.matcher(o.label).find()) {
                throw Validation.invalid("label must be at most 64 printable characters");
            }
            b.put("label", o.label);
        }
        if (o.ttlSeconds != null) b.put("ttlSeconds", Validation.intRange(o.ttlSeconds, "ttlSeconds", MIN_TTL_SECONDS, MAX_TTL_SECONDS));
        if (o.maxBytes != null) b.put("maxBytes", cap(o.maxBytes, MAX_BYTES, "maxBytes"));
        if (o.maxSpendMusd != null) b.put("maxSpendMusd", cap(o.maxSpendMusd, MAX_SPEND_MUSD, "maxSpendMusd"));
        JsonNode r = http.post("/v1/proxy-tokens", b, Auth.AGENT);
        JsonNode t = r.get("token");
        if (t == null || !t.isTextual() || !PROXY_TOKEN_RE.matcher(t.asText()).matches()) {
            throw new ProtocolException("server returned a malformed proxy token");
        }
        return new CreatedProxyToken(r, t.asText());
    }

    /** GET /v1/proxy-tokens -> {tokens, maxActive} (metadata only). */
    public JsonNode list() { return http.get("/v1/proxy-tokens", Auth.AGENT); }

    /** DELETE /v1/proxy-tokens/{id} -> {id, revoked}. */
    public JsonNode revoke(String id) {
        return http.delete("/v1/proxy-tokens/" + seg(Validation.uuid(id, "id")), Auth.AGENT);
    }
}
