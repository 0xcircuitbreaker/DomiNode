package io.dominusnode.sdk;

/**
 * EIP-191 {@code personal_sign} over the exact UTF-8 string given; returns a 0x + 130 hex signature.
 * Wrap web3j, an HSM or any other key store. The SDK has no crypto dependency.
 */
@FunctionalInterface
public interface MessageSigner {
    String signMessage(String message) throws Exception;
}
