package io.dominusnode.sdk.internal;

import com.fasterxml.jackson.core.JsonProcessingException;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ObjectNode;

import java.util.ArrayList;
import java.util.Iterator;
import java.util.List;
import java.util.Set;

/** JSON helpers. Parsing recursively removes __proto__/constructor/prototype keys (depth 50). Internal. */
public final class Json {
    private Json() {}

    public static final ObjectMapper MAPPER = new ObjectMapper();
    private static final Set<String> DANGEROUS = Set.of("__proto__", "constructor", "prototype");

    public static JsonNode parse(String text) throws JsonProcessingException {
        JsonNode n = MAPPER.readTree(text);
        strip(n, 0);
        return n;
    }

    public static void strip(JsonNode n, int depth) {
        if (depth > 50 || n == null) return;
        if (n.isArray()) {
            for (JsonNode c : n) strip(c, depth + 1);
        } else if (n.isObject()) {
            ObjectNode o = (ObjectNode) n;
            List<String> remove = new ArrayList<>();
            for (Iterator<String> it = o.fieldNames(); it.hasNext(); ) {
                String k = it.next();
                if (DANGEROUS.contains(k)) remove.add(k);
                else strip(o.get(k), depth + 1);
            }
            o.remove(remove);
        }
    }

    public static String write(Object v) {
        try {
            return MAPPER.writeValueAsString(v);
        } catch (JsonProcessingException e) {
            throw new IllegalArgumentException("cannot serialise request body", e);
        }
    }

    public static ObjectNode object() { return MAPPER.createObjectNode(); }
}
