package io.dominusnode.sdk.errors;

import java.util.Map;

/** HTTP 402. */
public class InsufficientBalanceException extends DominusNodeException {
    private static final long serialVersionUID = 2L;

    public InsufficientBalanceException(String message) { super(message, 402, null, null); }

    public InsufficientBalanceException(String message, String code, Map<String, Object> details) { super(message, 402, code, details); }
}
