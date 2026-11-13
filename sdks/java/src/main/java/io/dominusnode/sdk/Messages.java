package io.dominusnode.sdk;

import io.dominusnode.sdk.errors.ProtocolException;
import io.dominusnode.sdk.internal.Validation;

import java.util.Locale;

/**
 * Byte-exact builders for every message the SDK asks a signer to sign. The SDK never signs a
 * server string blindly: it rebuilds the message and refuses (ProtocolException) on any difference.
 * Sources: packages/shared/src/attestation.ts, packages/dashboard/src/routes/v1/credits.ts.
 */
public final class Messages {
    private Messages() {}

    public static String attestation(String wallet, String nonce, long attestationVersion,
                                     String attestationText, String nodePubkey) {
        return String.join("\n",
                "DomiNode node attestation",
                "Version: " + attestationVersion,
                "Wallet: " + wallet.toLowerCase(Locale.ROOT),
                "Nonce: " + nonce,
                "Node pubkey: " + (nodePubkey == null ? "none" : nodePubkey),
                "",
                attestationText);
    }

    public static String payoutWallet(String userId, String wallet, String address, String chain, String nonce) {
        return String.join("\n",
                "DominusNode payout wallet",
                "Action: payout_wallet_set",
                "User: " + userId,
                "Account wallet: " + wallet.toLowerCase(Locale.ROOT),
                "Payout address: " + address.toLowerCase(Locale.ROOT),
                "Chain: " + chain,
                "Nonce: " + nonce);
    }

    public static String withdraw(String userId, String wallet, String amountMusd, String idempotencyKey, String nonce) {
        return String.join("\n",
                "DominusNode withdrawal",
                "Action: withdraw",
                "User: " + userId,
                "Account wallet: " + wallet.toLowerCase(Locale.ROOT),
                "Amount (µUSD): " + amountMusd,
                "Idempotency key: " + idempotencyKey,
                "Nonce: " + nonce);
    }

    public static String convert(String userId, String wallet, String amountMusd, String idempotencyKey, String nonce) {
        return String.join("\n",
                "DominusNode credit conversion",
                "Action: convert",
                "User: " + userId,
                "Account wallet: " + wallet.toLowerCase(Locale.ROOT),
                "Amount (µUSD): " + amountMusd,
                "Idempotency key: " + idempotencyKey,
                "Nonce: " + nonce);
    }

    /** Line 3 of a payout/withdraw message must be "User: &lt;uuid&gt;". */
    public static String extractUserId(String message) {
        String[] lines = message == null ? new String[0] : message.split("\n", -1);
        String line = lines.length > 2 ? lines[2] : "";
        if (!line.startsWith("User: ")) throw new ProtocolException("challenge message has no valid User line");
        String id = line.substring(6);
        if (!Validation.UUID_RE.matcher(id).matches()) throw new ProtocolException("challenge message has no valid User line");
        return id;
    }

    public static void assertSame(String server, String local, String what) {
        if (server == null || !server.equals(local)) {
            throw new ProtocolException(what + ": the server's message differs from the one built locally; refusing to sign "
                    + "(wrong signer for the linked wallet, mismatched parameters, or protocol change)");
        }
    }
}
