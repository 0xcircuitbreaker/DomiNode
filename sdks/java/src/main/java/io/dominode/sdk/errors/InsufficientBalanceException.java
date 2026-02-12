package io.dominode.sdk.errors;

/**
 * Thrown when the wallet balance is insufficient for the requested operation (HTTP 402).
 */
public class InsufficientBalanceException extends DomiNodeException {

    public InsufficientBalanceException(String message) {
        super(message, 402);
    }
}
