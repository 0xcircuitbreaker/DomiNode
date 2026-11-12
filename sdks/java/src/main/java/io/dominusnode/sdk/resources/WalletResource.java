package io.dominusnode.sdk.resources;

import com.fasterxml.jackson.databind.JsonNode;
import io.dominusnode.sdk.internal.ApiClient;
import io.dominusnode.sdk.internal.ApiClient.Auth;
import io.dominusnode.sdk.internal.Validation;

import java.util.List;
import java.util.Locale;

import static io.dominusnode.sdk.internal.Validation.body;
import static io.dominusnode.sdk.internal.Validation.qs;
import static io.dominusnode.sdk.internal.Validation.seg;

/** Requester prepaid wallet (cents). */
public final class WalletResource {
    public static final List<String> CRYPTO_CURRENCIES =
            List.of("btc", "eth", "ltc", "xmr", "zec", "usdc", "sol", "usdt", "dai", "bnb", "link");
    private final ApiClient http;

    public WalletResource(ApiClient http) { this.http = http; }

    /** GET /api/wallet. */
    public JsonNode getBalance() { return http.get("/api/wallet", Auth.JWT); }

    public JsonNode getTransactions() { return getTransactions(null, null); }

    /** GET /api/wallet/transactions?limit&amp;offset. */
    public JsonNode getTransactions(Integer limit, Integer offset) {
        return http.get("/api/wallet/transactions" + qs("limit", limit, "offset", offset), Auth.JWT);
    }

    /** GET /api/wallet/forecast. */
    public JsonNode getForecast() { return http.get("/api/wallet/forecast", Auth.JWT); }

    /** POST /api/wallet/topup/crypto; 1000..100000 cents. */
    public JsonNode topUpCrypto(long amountCents, String currency) {
        Validation.cents(amountCents, "amountCents", false);
        if (amountCents < 1000 || amountCents > 100_000) throw Validation.invalid("crypto top-up must be between 1000 and 100000 cents ($10-$1,000)");
        String c = currency == null ? "" : currency.toLowerCase(Locale.ROOT);
        if (!CRYPTO_CURRENCIES.contains(c)) throw Validation.invalid("currency must be one of " + String.join(", ", CRYPTO_CURRENCIES));
        Object usd = amountCents % 100 == 0 ? (Object) (amountCents / 100) : (Object) (amountCents / 100.0);
        return http.post("/api/wallet/topup/crypto", body("amountUsd", usd, "currency", c), Auth.JWT);
    }

    /** GET /api/wallet/crypto/status/{invoiceId} (UUID). */
    public JsonNode getCryptoStatus(String invoiceId) {
        return http.get("/api/wallet/crypto/status/" + seg(Validation.uuid(invoiceId, "invoiceId")), Auth.JWT);
    }

    /** Every wallet transaction (offset pagination; page size default 50, server max 100). */
    public java.util.Iterator<JsonNode> iterTransactions(Integer limit) {
        int l = Paging.pageSize(limit, 50, 100);
        return Paging.offset(l, "transactions", false, this::getTransactions);
    }

    public java.util.stream.Stream<JsonNode> streamTransactions(Integer limit) { return Paging.stream(iterTransactions(limit)); }
}
