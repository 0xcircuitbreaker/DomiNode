package io.dominusnode.sdk.errors;

import java.util.Map;

/** HTTP 409. */
public class ConflictException extends DominusNodeException {
    private static final long serialVersionUID = 2L;

    public ConflictException(String message) { super(message, 409, null, null); }

    public ConflictException(String message, String code, Map<String, Object> details) { super(message, 409, code, details); }
}
