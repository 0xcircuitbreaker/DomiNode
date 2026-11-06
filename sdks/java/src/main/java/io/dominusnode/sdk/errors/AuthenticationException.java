package io.dominusnode.sdk.errors;

import java.util.Map;

/** HTTP 401, or no credential held. */
public class AuthenticationException extends DominusNodeException {
    private static final long serialVersionUID = 2L;

    public AuthenticationException(String message) { super(message, 401, null, null); }

    public AuthenticationException(String message, String code, Map<String, Object> details) { super(message, 401, code, details); }
}
