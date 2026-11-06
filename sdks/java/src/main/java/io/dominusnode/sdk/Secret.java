package io.dominusnode.sdk;

import com.fasterxml.jackson.annotation.JsonValue;

import java.util.Arrays;

/**
 * A credential the server returns exactly once (new API key, team key, dn_node_ key).
 * {@link #toString()} and JSON serialisation yield {@code [REDACTED]}; call {@link #reveal()} for the value.
 * The raw value is held as a private char[] and can be wiped with {@link #clear()}.
 */
public final class Secret {
    public static final String REDACTED = "[REDACTED]";
    private final char[] value;

    public Secret(String value) {
        this.value = value == null ? new char[0] : value.toCharArray();
    }

    /** The raw credential. */
    public String reveal() {
        return new String(value);
    }

    /** First 8 characters (safe for logs). */
    public String prefix() {
        return new String(value, 0, Math.min(8, value.length));
    }

    /** Overwrite the stored value with zeros. */
    public void clear() {
        Arrays.fill(value, '\0');
    }

    @JsonValue
    @Override
    public String toString() {
        return REDACTED;
    }
}
