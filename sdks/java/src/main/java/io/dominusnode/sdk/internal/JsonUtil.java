package io.dominusnode.sdk.internal;

import com.fasterxml.jackson.core.JsonProcessingException;
import com.fasterxml.jackson.databind.DeserializationFeature;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;

/**
 * Internal JSON serialization utilities backed by Jackson.
 *
 * <p>This class is not part of the public API and may change without notice.</p>
 */
public final class JsonUtil {

    private static final ObjectMapper MAPPER = new ObjectMapper()
            .configure(DeserializationFeature.FAIL_ON_UNKNOWN_PROPERTIES, false);

    private JsonUtil() {} // utility class

    /**
     * Serialize an object to a JSON string.
     *
     * @param value the object to serialize
     * @return JSON string representation
     */
    public static String toJson(Object value) {
        try {
            return MAPPER.writeValueAsString(value);
        } catch (JsonProcessingException e) {
            throw new RuntimeException("Failed to serialize to JSON", e);
        }
    }

    /**
     * Deserialize a JSON string to the specified type.
     *
     * @param json  the JSON string
     * @param clazz the target class
     * @param <T>   target type
     * @return deserialized object
     */
    public static <T> T fromJson(String json, Class<T> clazz) {
        try {
            return MAPPER.readValue(json, clazz);
        } catch (JsonProcessingException e) {
            throw new RuntimeException("Failed to deserialize JSON: " + e.getMessage(), e);
        }
    }

    /**
     * Parse a JSON string into a Jackson tree node.
     *
     * @param json the JSON string
     * @return root JsonNode
     */
    public static JsonNode parseTree(String json) {
        try {
            return MAPPER.readTree(json);
        } catch (JsonProcessingException e) {
            throw new RuntimeException("Failed to parse JSON tree", e);
        }
    }

    /**
     * Extract an error message from a JSON error response body.
     *
     * <p>Tries the "error" field first, then "message", then falls back to
     * the raw body string.</p>
     *
     * @param body the response body string
     * @return extracted error message
     */
    public static String extractErrorMessage(String body) {
        if (body == null || body.isEmpty()) {
            return "Unknown error";
        }
        try {
            JsonNode node = MAPPER.readTree(body);
            if (node.has("error") && !node.get("error").isNull()) {
                String msg = node.get("error").asText();
                return msg.length() > 500 ? msg.substring(0, 500) + "... [truncated]" : msg;
            }
            if (node.has("message") && !node.get("message").isNull()) {
                String msg = node.get("message").asText();
                return msg.length() > 500 ? msg.substring(0, 500) + "... [truncated]" : msg;
            }
        } catch (JsonProcessingException ignored) {
            // Not JSON -- fall through
        }
        // Truncate error message to prevent unbounded body in exception strings
        if (body.length() > 500) {
            return body.substring(0, 500) + "... [truncated]";
        }
        return body;
    }

    /**
     * Get the shared ObjectMapper instance.
     *
     * @return the ObjectMapper
     */
    public static ObjectMapper getMapper() {
        return MAPPER;
    }
}
