package io.dominusnode.sdk;

import io.dominusnode.sdk.errors.ProtocolException;
import io.dominusnode.sdk.errors.ValidationException;
import io.dominusnode.sdk.internal.Validation;

/**
 * Wallet signer: an address plus a {@link MessageSigner} callback.
 *
 * <pre>{@code
 * Signer signer = Signer.of(credentials.getAddress(), msg -> mySign(msg));
 * }</pre>
 */
public final class Signer {
    private final String address;
    private final MessageSigner messageSigner;

    private Signer(String address, MessageSigner messageSigner) {
        this.address = address;
        this.messageSigner = messageSigner;
    }

    /** @throws ValidationException when the address is not 0x + 40 hex or the callback is null */
    public static Signer of(String address, MessageSigner messageSigner) {
        Validation.address(address, "signer.address");
        if (messageSigner == null) throw ValidationException.invalidArg("signer.signMessage is required");
        return new Signer(address, messageSigner);
    }

    public String getAddress() { return address; }

    /** Sign and validate the signature format. Signer failures or bad formats raise ProtocolException. */
    public String sign(String message, String name) {
        String sig;
        try {
            sig = messageSigner.signMessage(message);
        } catch (Exception e) {
            throw new ProtocolException(name + ".signMessage failed: " + e.getMessage());
        }
        try {
            return Validation.signature(sig, name + " signature");
        } catch (ValidationException e) {
            throw new ProtocolException(e.getMessage());
        }
    }

    @Override
    public String toString() { return "Signer(" + address + ")"; }
}
