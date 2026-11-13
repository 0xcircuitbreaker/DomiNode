package io.dominusnode.sdk.resources;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.node.ObjectNode;
import io.dominusnode.sdk.Messages;
import io.dominusnode.sdk.Signer;
import io.dominusnode.sdk.errors.ProtocolException;
import io.dominusnode.sdk.errors.ValidationException;
import io.dominusnode.sdk.internal.ApiClient;
import io.dominusnode.sdk.internal.ApiClient.Auth;
import io.dominusnode.sdk.internal.Json;
import io.dominusnode.sdk.internal.Validation;

import java.util.List;
import java.util.Locale;
import java.util.Map;

import static io.dominusnode.sdk.internal.Validation.body;
import static io.dominusnode.sdk.internal.Validation.qs;

/**
 * Node-operator earnings in µUSD (/v1, agent). Amounts accept BigInteger, a digit string or a long;
 * they are sent as decimal strings.
 */
public final class CreditsResource {
    public static final List<String> TX_TYPES = List.of("earn", "mature", "clawback", "convert", "withdraw", "withdraw_reversal");
    public static final long MIN_CONVERT_MUSD = 10_000L;
    public static final long MAX_CONVERT_MUSD = 10_000_000_000L;
    public static final long MIN_WITHDRAW_MUSD = 1_000_000L;
    public static final long MAX_WITHDRAW_MUSD = 100_000_000_000L;
    private final ApiClient http;

    public CreditsResource(ApiClient http) { this.http = http; }

    /** GET /v1/credits. */
    public JsonNode balance() { return http.get("/v1/credits", Auth.AGENT); }

    public JsonNode transactions() { return transactions(null, null, null); }

    /** GET /v1/credits/transactions?limit&amp;cursor&amp;type. */
    public JsonNode transactions(Integer limit, String cursor, String type) {
        if (limit != null) Validation.intRange(limit, "limit", 1, 200);
        if (cursor != null && !Paging.CURSOR_RE.matcher(cursor).matches()) throw Validation.invalid("cursor must be a nextCursor value");
        if (type != null && !TX_TYPES.contains(type)) throw Validation.invalid("type must be one of " + String.join(", ", TX_TYPES));
        return http.get("/v1/credits/transactions" + qs("limit", limit, "cursor", cursor, "type", type), Auth.AGENT);
    }

    public JsonNode convert(Object amountMusd, Signer signer) { return convert(amountMusd, signer, null); }

    /**
     * POST /v1/credits/convert/challenge (Idempotency-Key header) -> check server signer and rebuild the
     * conversion message (refuse on mismatch, signer not called) -> sign -> POST /v1/credits/convert
     * {amountMusd, nonce, signature}. Returns {converted, convertedCents, duplicate, idempotencyKey}.
     */
    public JsonNode convert(Object amountMusd, Signer signer, String idempotencyKey) {
        if (signer == null) throw ValidationException.invalidArg("signer is required");
        String amount = Validation.musd(amountMusd, MIN_CONVERT_MUSD, MAX_CONVERT_MUSD, "amountMusd");
        String key = Validation.idempotencyKey(idempotencyKey == null ? Validation.newIdempotencyKey() : idempotencyKey);
        Map<String, String> headers = Map.of("Idempotency-Key", key);

        JsonNode ch = http.request("POST", "/v1/credits/convert/challenge", body("amountMusd", amount), Auth.AGENT, headers, false);
        String nonce = ch.path("nonce").isTextual() ? ch.get("nonce").asText() : "";
        if (!Validation.HEX64_RE.matcher(nonce).matches()) throw new ProtocolException("invalid challenge nonce");
        if (!ch.path("signer").isTextual()
                || !ch.get("signer").asText().toLowerCase(Locale.ROOT).equals(signer.getAddress().toLowerCase(Locale.ROOT))) {
            throw new ProtocolException("the account's linked wallet is not the signer's address; refusing to sign");
        }
        String serverMsg = ch.path("message").isTextual() ? ch.get("message").asText() : null;
        String local = Messages.convert(Messages.extractUserId(serverMsg), signer.getAddress(), amount, key, nonce);
        Messages.assertSame(serverMsg, local, "credit conversion");
        String signature = signer.sign(local, "signer");
        JsonNode r = http.request("POST", "/v1/credits/convert",
                body("amountMusd", amount, "nonce", nonce, "signature", signature), Auth.AGENT, headers, false);
        return withKey(r, key);
    }

    public JsonNode withdraw(Object amountMusd, Signer signer) { return withdraw(amountMusd, signer, null); }

    /**
     * challenge -> check server signer and rebuild the withdrawal message (refuse on mismatch, signer not
     * called) -> sign -> POST /v1/credits/withdraw. Returns {payout, duplicate, idempotencyKey}.
     */
    public JsonNode withdraw(Object amountMusd, Signer signer, String idempotencyKey) {
        if (signer == null) throw ValidationException.invalidArg("signer is required");
        String amount = Validation.musd(amountMusd, MIN_WITHDRAW_MUSD, MAX_WITHDRAW_MUSD, "amountMusd");
        String key = Validation.idempotencyKey(idempotencyKey == null ? Validation.newIdempotencyKey() : idempotencyKey);

        JsonNode ch = http.post("/v1/credits/withdraw/challenge", body("amountMusd", amount, "idempotencyKey", key), Auth.AGENT);
        String nonce = ch.path("nonce").isTextual() ? ch.get("nonce").asText() : "";
        if (!Validation.HEX64_RE.matcher(nonce).matches()) throw new ProtocolException("invalid challenge nonce");
        if (!ch.path("signer").isTextual()
                || !ch.get("signer").asText().toLowerCase(Locale.ROOT).equals(signer.getAddress().toLowerCase(Locale.ROOT))) {
            throw new ProtocolException("the account's linked wallet is not the signer's address; refusing to sign");
        }
        String serverMsg = ch.path("message").isTextual() ? ch.get("message").asText() : null;
        String local = Messages.withdraw(Messages.extractUserId(serverMsg), signer.getAddress(), amount, key, nonce);
        Messages.assertSame(serverMsg, local, "withdrawal");
        String signature = signer.sign(local, "signer");
        JsonNode r = http.post("/v1/credits/withdraw",
                body("amountMusd", amount, "idempotencyKey", key, "nonce", nonce, "signature", signature), Auth.AGENT);
        return withKey(r, key);
    }

    static JsonNode withKey(JsonNode r, String key) {
        ObjectNode o = r.isObject() ? (ObjectNode) r : Json.object();
        o.put("idempotencyKey", key);
        return o;
    }

    /** Every credit transaction (newest first), following nextCursor. {@code limit} is the page size (null = server default). */
    public java.util.Iterator<JsonNode> iterTransactions(Integer limit, String type) {
        if (limit != null) Validation.intRange(limit, "limit", 1, 200);
        return Paging.cursor(null, cur -> transactions(limit, cur, type));
    }

    /** Stream view of {@link #iterTransactions(Integer, String)}. */
    public java.util.stream.Stream<JsonNode> streamTransactions(Integer limit, String type) {
        return Paging.stream(iterTransactions(limit, type));
    }
}
