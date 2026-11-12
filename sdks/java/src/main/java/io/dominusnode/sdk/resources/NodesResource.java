package io.dominusnode.sdk.resources;

import com.fasterxml.jackson.databind.JsonNode;
import io.dominusnode.sdk.Messages;
import io.dominusnode.sdk.Secret;
import io.dominusnode.sdk.Signer;
import io.dominusnode.sdk.errors.ProtocolException;
import io.dominusnode.sdk.errors.ValidationException;
import io.dominusnode.sdk.internal.ApiClient;
import io.dominusnode.sdk.internal.ApiClient.Auth;
import io.dominusnode.sdk.internal.Pow;
import io.dominusnode.sdk.internal.Validation;

import java.util.Locale;
import java.util.Map;
import java.util.regex.Pattern;

import static io.dominusnode.sdk.internal.Validation.body;
import static io.dominusnode.sdk.internal.Validation.qs;
import static io.dominusnode.sdk.internal.Validation.seg;

/** Relay nodes you own. All routes are /v1 agent routes. */
public final class NodesResource {
    private static final Pattern NODE_KEY_RE = Pattern.compile("^dn_node_[0-9a-f]{64}$");
    private static final int MAX_ATTESTATION_TEXT = 64 * 1024;
    public static final long DEFAULT_MAX_POW_ITERATIONS = 200_000_000L;
    private final ApiClient http;

    public NodesResource(ApiClient http) { this.http = http; }

    /** Options for {@link #register(RegisterOptions)}. */
    public static final class RegisterOptions {
        private final Signer signer;
        private String nodePubkey;
        private JsonNode challenge;
        private Integer maxStreams;
        private Integer maxGbDay;
        private long maxPowIterations = DEFAULT_MAX_POW_ITERATIONS;
        private String declaredClass;

        public RegisterOptions(Signer signer) { this.signer = signer; }

        /** ed25519 public key, 64 hex. */
        public RegisterOptions nodePubkey(String v) { nodePubkey = v; return this; }

        /** Challenge from {@link #registerChallenge(String)} (same nodePubkey). */
        public RegisterOptions challenge(JsonNode v) { challenge = v; return this; }

        public RegisterOptions maxStreams(int v) { maxStreams = v; return this; }

        public RegisterOptions maxGbDay(int v) { maxGbDay = v; return this; }

        public RegisterOptions maxPowIterations(long v) { maxPowIterations = v; return this; }

        /** Informational class claim (2.1): residential, mobile, dc or masked. The effective class is gateway-verified. */
        public RegisterOptions declaredClass(String v) { declaredClass = v; return this; }
    }

    /** Exit classes a node may declare (2.1). */
    public static final java.util.Set<String> EXIT_CLASSES = java.util.Set.of("residential", "mobile", "dc", "masked");

    /** Result of a registration; {@code nodeKey} is returned once and prints as [REDACTED]. */
    public static final class RegisteredNode {
        public final String nodeId;
        public final String status;
        public final int attestationVersion;
        public final Secret nodeKey;

        RegisteredNode(String nodeId, String status, int attestationVersion, Secret nodeKey) {
            this.nodeId = nodeId;
            this.status = status;
            this.attestationVersion = attestationVersion;
            this.nodeKey = nodeKey;
        }

        @Override
        public String toString() { return "RegisteredNode(nodeId=" + nodeId + ", status=" + status + ", nodeKey=[REDACTED])"; }
    }

    private static String normPubkey(String v) {
        if (v == null) return null;
        String k = v.toLowerCase(Locale.ROOT);
        if (!Validation.HEX64_RE.matcher(k).matches()) throw Validation.invalid("nodePubkey must be 64 hex characters (32-byte ed25519 public key)");
        return k;
    }

    private static void checkChallenge(JsonNode ch) {
        if (ch == null || !ch.isObject()) throw new ProtocolException("invalid node challenge");
        JsonNode nonce = ch.get("nonce");
        if (nonce == null || !nonce.isTextual() || !Validation.HEX64_RE.matcher(nonce.asText()).matches()) throw new ProtocolException("invalid challenge nonce");
        JsonNode text = ch.get("attestationText");
        if (text == null || !text.isTextual() || text.asText().isEmpty() || text.asText().length() > MAX_ATTESTATION_TEXT) {
            throw new ProtocolException("invalid attestation text");
        }
        JsonNode ver = ch.get("attestationVersion");
        if (ver == null || !ver.isIntegralNumber() || ver.asLong() < 1 || ver.asLong() > 100_000) throw new ProtocolException("invalid attestation version");
        JsonNode p = ch.get("powChallenge");
        if (p == null || !p.path("prefix").isTextual() || !p.path("difficulty").isNumber() || !p.path("challengeId").isTextual()
                || !Validation.UUID_RE.matcher(p.get("challengeId").asText()).matches()) {
            throw new ProtocolException("invalid PoW challenge");
        }
    }

    public JsonNode registerChallenge() { return registerChallenge(null); }

    /** POST /v1/nodes/challenge {nodePubkey?}. */
    public JsonNode registerChallenge(String nodePubkey) {
        String k = normPubkey(nodePubkey);
        return http.post("/v1/nodes/challenge", body("nodePubkey", k), Auth.AGENT);
    }

    public RegisteredNode register(Signer signer) { return register(new RegisterOptions(signer)); }

    /**
     * challenge -> rebuild the attestation locally (refuse on mismatch) -> PoW -> sign -> POST /v1/nodes.
     */
    public RegisteredNode register(RegisterOptions o) {
        if (o == null || o.signer == null) throw ValidationException.invalidArg("signer is required");
        Signer signer = o.signer;
        String pubkey = normPubkey(o.nodePubkey);
        if (o.maxStreams != null) Validation.intRange(o.maxStreams, "maxStreams", 1, 1024);
        if (o.maxGbDay != null) Validation.intRange(o.maxGbDay, "maxGbDay", 1, 10_000);
        if (o.declaredClass != null && !EXIT_CLASSES.contains(o.declaredClass)) {
            throw ValidationException.invalidArg("declaredClass must be residential, mobile, dc or masked");
        }

        JsonNode ch = o.challenge != null ? o.challenge : registerChallenge(pubkey);
        checkChallenge(ch);
        int version = ch.get("attestationVersion").asInt();
        String nonce = ch.get("nonce").asText();
        String message = Messages.attestation(signer.getAddress(), nonce, version, ch.get("attestationText").asText(), pubkey);
        JsonNode serverMsg = ch.get("message");
        Messages.assertSame(serverMsg != null && serverMsg.isTextual() ? serverMsg.asText() : null, message, "node attestation");
        JsonNode pow = ch.get("powChallenge");
        double diff = pow.get("difficulty").asDouble();
        if (diff != Math.rint(diff)) throw new ProtocolException("invalid PoW difficulty");
        String powNonce = Pow.solve(pow.get("prefix").asText(), (int) Math.max(Math.min(diff, 1000), -1), o.maxPowIterations);
        String walletSignature = signer.sign(message, "signer");

        Map<String, Object> b = body("nonce", nonce, "walletSignature", walletSignature, "attestationVersion", version,
                "pow", body("challengeId", pow.get("challengeId").asText(), "nonce", powNonce),
                "nodePubkey", pubkey, "maxStreams", o.maxStreams, "maxGbDay", o.maxGbDay);
        if (o.declaredClass != null) b.put("declaredClass", o.declaredClass);
        JsonNode r = http.post("/v1/nodes", b, Auth.AGENT);
        JsonNode id = r.get("nodeId");
        if (id == null || !id.isTextual() || !Validation.UUID_RE.matcher(id.asText()).matches()) throw new ProtocolException("invalid nodeId in response");
        JsonNode key = r.get("nodeKey");
        if (key == null || !key.isTextual() || !NODE_KEY_RE.matcher(key.asText()).matches()) throw new ProtocolException("invalid node key in response");
        return new RegisteredNode(id.asText(), r.path("status").asText(), r.path("attestationVersion").asInt(), new Secret(key.asText()));
    }

    public JsonNode list() { return list(null, null); }

    /** GET /v1/nodes?limit&amp;offset (limit 1..500, offset 0..1,000,000). */
    public JsonNode list(Integer limit, Integer offset) {
        if (limit != null) Validation.intRange(limit, "limit", 1, 500);
        if (offset != null) Validation.intRange(offset, "offset", 0, 1_000_000);
        return http.get("/v1/nodes" + qs("limit", limit, "offset", offset), Auth.AGENT);
    }

    /** GET /v1/nodes?limit&amp;cursor: the page after a previous nextCursor (2.1). */
    public JsonNode listAfter(Integer limit, String cursor) {
        if (limit != null) Validation.intRange(limit, "limit", 1, 500);
        Paging.checkPageCursor(cursor);
        return http.get("/v1/nodes" + qs("limit", limit, "cursor", cursor), Auth.AGENT);
    }

    /** DELETE /v1/nodes/{id} (irreversible). */
    public JsonNode revoke(String nodeId) {
        return http.delete("/v1/nodes/" + seg(Validation.uuid(nodeId, "nodeId")), Auth.AGENT);
    }

    /** PATCH /v1/nodes/{id} with only the non-null caps (each 1..1,000,000, at least one). */
    public JsonNode updateCaps(String nodeId, Integer maxStreams, Integer gbPerDay, Integer reqPerSec) {
        Validation.uuid(nodeId, "nodeId");
        if (maxStreams != null) Validation.intRange(maxStreams, "maxStreams", 1, 1_000_000);
        if (gbPerDay != null) Validation.intRange(gbPerDay, "gbPerDay", 1, 1_000_000);
        if (reqPerSec != null) Validation.intRange(reqPerSec, "reqPerSec", 1, 1_000_000);
        Map<String, Object> b = body("maxStreams", maxStreams, "gbPerDay", gbPerDay, "reqPerSec", reqPerSec);
        if (b.isEmpty()) throw Validation.invalid("updateCaps needs at least one of maxStreams, gbPerDay, reqPerSec");
        return http.patch("/v1/nodes/" + seg(nodeId), b, Auth.AGENT);
    }

    /** GET /v1/node/tier. */
    public JsonNode tier() { return http.get("/v1/node/tier", Auth.AGENT); }

    /** Every node you own (follows nextCursor, offset fallback; page size default 100, max 500). */
    public java.util.Iterator<JsonNode> iterate(Integer limit) {
        int l = Paging.pageSize(limit, 100, 500);
        return Paging.offsetOrCursor(l, "nodes", this::list, this::listAfter);
    }

    public java.util.stream.Stream<JsonNode> stream(Integer limit) { return Paging.stream(iterate(limit)); }
}
