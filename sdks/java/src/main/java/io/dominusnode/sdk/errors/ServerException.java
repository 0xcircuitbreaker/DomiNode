package io.dominusnode.sdk.errors;

import java.util.Map;

/** HTTP >= 500, oversize body or invalid JSON. */
public class ServerException extends DominusNodeException {
    private static final long serialVersionUID = 2L;

    public ServerException(String message, Integer status) { super(message, status, null, null); }

    public ServerException(String message, Integer status, String code, Map<String, Object> details) {
        super(message, status, code, details);
    }
}
