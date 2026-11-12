package io.dominusnode.sdk.resources;

import com.fasterxml.jackson.databind.JsonNode;
import io.dominusnode.sdk.Messages;
import io.dominusnode.sdk.Signer;
import io.dominusnode.sdk.errors.ProtocolException;
import io.dominusnode.sdk.errors.ValidationException;
import io.dominusnode.sdk.internal.ApiClient;
import io.dominusnode.sdk.internal.ApiClient.Auth;
import io.dominusnode.sdk.internal.Validation;

import java.util.Locale;

import static io.dominusnode.sdk.internal.Validation.body;

/** Where withdrawals are sent (/v1, agent). */
public final class PayoutWalletResource {
    private final ApiClient http;

    public PayoutWalletResource(ApiClient http) { this.http = http; }

    /** GET /v1/payout-wallet. */
    public JsonNode get() { return http.get("/v1/payout-wallet", Auth.AGENT); }

    public JsonNode set(String address, Signer signer) { return set(address, signer, "base", null); }

    /**
     * challenge -> rebuild the payout-wallet message (refuse on mismatch) -> check the old-wallet signer when
     * required -> sign (and old signer signs the SAME message) -> PUT /v1/payout-wallet.
     */
    public JsonNode set(String address, Signer signer, String chain, Signer oldWalletSigner) {
        if (signer == null) throw ValidationException.invalidArg("signer is required");
        String addr = Validation.address(address, "address").toLowerCase(Locale.ROOT);
        String c = chain == null ? "base" : chain;
        // base-sepolia is an explicit staging opt-in; the server decides whether it is accepted.
        if (!"base".equals(c) && !"base-sepolia".equals(c)) throw Validation.invalid("chain must be 'base' or 'base-sepolia'");

        JsonNode ch = http.post("/v1/payout-wallet/challenge", body("address", addr, "chain", c), Auth.AGENT);
        String nonce = ch.path("nonce").isTextual() ? ch.get("nonce").asText() : "";
        if (!Validation.HEX64_RE.matcher(nonce).matches()) throw new ProtocolException("invalid challenge nonce");
        if (!ch.path("signer").isTextual()
                || !ch.get("signer").asText().toLowerCase(Locale.ROOT).equals(signer.getAddress().toLowerCase(Locale.ROOT))) {
            throw new ProtocolException("the account's linked wallet is not the signer's address; refusing to sign");
        }
        String serverMsg = ch.path("message").isTextual() ? ch.get("message").asText() : null;
        String local = Messages.payoutWallet(Messages.extractUserId(serverMsg), signer.getAddress(), addr, c, nonce);
        Messages.assertSame(serverMsg, local, "payout wallet");

        boolean oldRequired = ch.path("oldWalletSignatureRequired").asBoolean(false);
        if (oldRequired) {
            if (oldWalletSigner == null) {
                throw Validation.invalid("changing the payout wallet requires oldWalletSigner for " + ch.path("oldWalletAddress").asText());
            }
            if (!ch.path("oldWalletAddress").isTextual() || !ch.get("oldWalletAddress").asText().toLowerCase(Locale.ROOT)
                    .equals(oldWalletSigner.getAddress().toLowerCase(Locale.ROOT))) {
                throw Validation.invalid("oldWalletSigner.address is not the current payout wallet");
            }
        }
        String signature = signer.sign(local, "signer");
        String oldSig = oldRequired ? oldWalletSigner.sign(local, "oldWalletSigner") : null;
        return http.put("/v1/payout-wallet",
                body("address", addr, "chain", c, "nonce", nonce, "signature", signature, "oldWalletSignature", oldSig), Auth.AGENT);
    }
}
