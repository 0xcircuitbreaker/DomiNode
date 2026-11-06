package io.dominusnode.sdk.errors;

import java.util.Map;

/** HTTP 403. */
public class AuthorizationException extends DominusNodeException {
    private static final long serialVersionUID = 2L;

    public AuthorizationException(String message) { super(message, 403, null, null); }

    public AuthorizationException(String message, String code, Map<String, Object> details) { super(message, 403, code, details); }
}
