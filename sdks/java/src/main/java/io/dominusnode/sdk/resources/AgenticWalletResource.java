package io.dominusnode.sdk.resources;

import com.fasterxml.jackson.databind.JsonNode;
import io.dominusnode.sdk.internal.ApiClient;
import io.dominusnode.sdk.internal.ApiClient.Auth;
import io.dominusnode.sdk.internal.Validation;

import java.util.List;
import java.util.Map;

import static io.dominusnode.sdk.internal.Validation.body;
import static io.dominusnode.sdk.internal.Validation.qs;
import static io.dominusnode.sdk.internal.Validation.seg;

/** Agentic sub-wallets (/api/agent-wallet, jwt). */
public final class AgenticWalletResource {
    private static final String BASE = "/api/agent-wallet";
    private final ApiClient http;

    public AgenticWalletResource(ApiClient http) { this.http = http; }

    public JsonNode create(String label) { return create(label, 10_000, null, null); }

    /** POST /api/agent-wallet. Limits in cents, 0..2147483647. */
    public JsonNode create(String label, long spendingLimitCents, Long dailyLimitCents, List<String> allowedDomains) {
        Validation.cents(spendingLimitCents, "spendingLimitCents", true);
        if (dailyLimitCents != null) Validation.cents(dailyLimitCents, "dailyLimitCents", true);
        return http.post(BASE, body("label", label, "spendingLimitCents", spendingLimitCents,
                "dailyLimitCents", dailyLimitCents, "allowedDomains", allowedDomains), Auth.JWT);
    }

    public JsonNode list() { return http.get(BASE, Auth.JWT); }

    public JsonNode get(String walletId) { return http.get(BASE + "/" + seg(walletId), Auth.JWT); }

    /** POST /{id}/fund {amountCents} (> 0). */
    public JsonNode fund(String walletId, long amountCents) {
        Validation.cents(amountCents, "amountCents", false);
        return http.post(BASE + "/" + seg(walletId) + "/fund", body("amountCents", amountCents), Auth.JWT);
    }

    /** PATCH /{id}/policy; null arguments are omitted. */
    public JsonNode updateWalletPolicy(String walletId, Long dailyLimitCents, List<String> allowedDomains) {
        if (dailyLimitCents != null) Validation.cents(dailyLimitCents, "dailyLimitCents", true);
        Map<String, Object> b = body("dailyLimitCents", dailyLimitCents, "allowedDomains", allowedDomains);
        return http.patch(BASE + "/" + seg(walletId) + "/policy", b, Auth.JWT);
    }

    public JsonNode transactions(String walletId) { return transactions(walletId, null, null); }

    public JsonNode transactions(String walletId, Integer limit, Integer offset) {
        return http.get(BASE + "/" + seg(walletId) + "/transactions" + qs("limit", limit, "offset", offset), Auth.JWT);
    }

    public JsonNode freeze(String walletId) { return http.post(BASE + "/" + seg(walletId) + "/freeze", body(), Auth.JWT); }

    public JsonNode unfreeze(String walletId) { return http.post(BASE + "/" + seg(walletId) + "/unfreeze", body(), Auth.JWT); }

    /** DELETE /{id} -> {deleted, refundedCents}. */
    public JsonNode delete(String walletId) { return http.delete(BASE + "/" + seg(walletId), Auth.JWT); }
}
