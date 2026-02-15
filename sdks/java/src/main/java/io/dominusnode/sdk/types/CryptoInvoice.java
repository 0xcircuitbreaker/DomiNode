package io.dominusnode.sdk.types;

import com.fasterxml.jackson.annotation.JsonCreator;
import com.fasterxml.jackson.annotation.JsonIgnoreProperties;
import com.fasterxml.jackson.annotation.JsonProperty;

/**
 * Crypto payment invoice for wallet top-up via NOWPayments.
 */
@JsonIgnoreProperties(ignoreUnknown = true)
public final class CryptoInvoice {

    private final String invoiceId;
    private final String invoiceUrl;
    private final String payCurrency;
    private final double priceAmount;

    @JsonCreator
    public CryptoInvoice(
            @JsonProperty("invoiceId") String invoiceId,
            @JsonProperty("invoiceUrl") String invoiceUrl,
            @JsonProperty("payCurrency") String payCurrency,
            @JsonProperty("priceAmount") double priceAmount) {
        this.invoiceId = invoiceId;
        this.invoiceUrl = invoiceUrl;
        this.payCurrency = payCurrency;
        this.priceAmount = priceAmount;
    }

    /** NOWPayments invoice ID. */
    public String getInvoiceId() { return invoiceId; }

    /** Payment URL to redirect the user to. */
    public String getInvoiceUrl() { return invoiceUrl; }

    /** Cryptocurrency code (e.g., "btc", "eth", "xmr"). */
    public String getPayCurrency() { return payCurrency; }

    /** Price amount in USD. */
    public double getPriceAmount() { return priceAmount; }

    @Override
    public String toString() {
        return "CryptoInvoice{invoiceId='" + invoiceId + "', payCurrency='" + payCurrency
                + "', priceAmount=" + priceAmount + "}";
    }
}
