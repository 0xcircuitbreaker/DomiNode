package io.dominusnode.sdk.resources;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.node.ObjectNode;
import io.dominusnode.sdk.Signer;
import io.dominusnode.sdk.errors.ProtocolException;
import io.dominusnode.sdk.errors.ValidationException;
import io.dominusnode.sdk.internal.ApiClient;
import io.dominusnode.sdk.internal.ApiClient.Auth;
import io.dominusnode.sdk.internal.Json;
import io.dominusnode.sdk.internal.TokenManager;
import io.dominusnode.sdk.internal.Validation;

import java.util.Locale;

import static io.dominusnode.sdk.internal.Validation.body;

/** EIP-191 wallet sign-in. */
public final class WalletAuthResource {
    private final ApiClient http;
    private final TokenManager tokens;

    public WalletAuthResource(ApiClient http, TokenManager tokens) {
        this.http = http;
        this.tokens = tokens;
    }

    /** POST /api/auth/wallet/challenge [none] -> {message, nonce, challenge, expiresAt}. */
    public JsonNode challenge(String address) {
        return http.post("/api/auth/wallet/challenge", body("address", Validation.address(address, "address")), Auth.NONE);
    }

    /**
     * POST /api/auth/wallet/verify [none]. If the response says mfaRequired, returns
     * {mfaRequired, mfaChallengeToken} and stores nothing; otherwise stores the JWT pair.
     */
    public JsonNode verify(String address, String signature) {
        JsonNode r = http.post("/api/auth/wallet/verify",
                body("address", Validation.address(address, "address"), "signature", Validation.signature(signature, "signature")), Auth.NONE);
        if (r.path("mfaRequired").asBoolean(false) && r.path("mfaRequired").isBoolean()) {
            ObjectNode o = Json.object();
            o.put("mfaRequired", true);
            o.set("mfaChallengeToken", r.get("mfaChallengeToken"));
            return o;
        }
        if (r.path("token").isTextual() && r.path("refreshToken").isTextual()) {
            tokens.setTokens(r.get("token").asText(), r.get("refreshToken").asText());
        }
        return r;
    }

    /** challenge -> refuse unless the message names the signer -> sign -> verify. */
    public JsonNode signIn(Signer signer) {
        if (signer == null) throw ValidationException.invalidArg("signer is required");
        JsonNode ch = challenge(signer.getAddress());
        JsonNode m = ch.get("message");
        if (m == null || !m.isTextual()
                || !m.asText().toLowerCase(Locale.ROOT).contains(signer.getAddress().toLowerCase(Locale.ROOT))) {
            throw new ProtocolException("wallet challenge does not name the signer's address; refusing to sign");
        }
        String sig = signer.sign(m.asText(), "signer");
        return verify(signer.getAddress(), sig);
    }

    /** POST /api/auth/wallet/link [jwt] -> {success, walletAddress}. */
    public JsonNode link(String address, String signature) {
        return http.post("/api/auth/wallet/link",
                body("address", Validation.address(address, "address"), "signature", Validation.signature(signature, "signature")), Auth.JWT);
    }
}
