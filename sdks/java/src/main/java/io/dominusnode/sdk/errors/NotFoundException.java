package io.dominusnode.sdk.errors;

import java.util.Map;

/** HTTP 404. */
public class NotFoundException extends DominusNodeException {
    private static final long serialVersionUID = 2L;

    public NotFoundException(String message) { super(message, 404, null, null); }

    public NotFoundException(String message, String code, Map<String, Object> details) { super(message, 404, code, details); }
}
