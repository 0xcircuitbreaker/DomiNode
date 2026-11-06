package io.dominusnode.sdk.errors;

import java.util.Map;

/** HTTP 400, or a client-side argument check (statusCode null, code INVALID_ARGUMENT); no request is sent. */
public class ValidationException extends DominusNodeException {
    private static final long serialVersionUID = 2L;
    public static final String INVALID_ARGUMENT = "INVALID_ARGUMENT";

    public ValidationException(String message, Integer statusCode, String code, Map<String, Object> details) {
        super(message, statusCode, code, details);
    }

    /** Client-side argument failure. */
    public static ValidationException invalidArg(String message) {
        return new ValidationException(message, null, INVALID_ARGUMENT, null);
    }
}
