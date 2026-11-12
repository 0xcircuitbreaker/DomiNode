package io.dominusnode.sdk;

import com.fasterxml.jackson.databind.JsonNode;
import io.dominusnode.sdk.errors.ValidationException;
import io.dominusnode.sdk.proxy.ProxyOptions;
import org.junit.jupiter.api.Test;

import java.util.ArrayList;
import java.util.Iterator;
import java.util.List;

import static io.dominusnode.sdk.TestSupport.connected;
import static org.junit.jupiter.api.Assertions.*;

/** 2.1 additions: masked exit class, node class fields, cursor paging. */
class MaskedTest {
    @Test
    void classMaskedUsername() {
        assertEquals("class-masked", ProxyOptions.create().ipClass("masked").buildUsername());
    }

    @Test
    void nodesIterateFollowsNextCursor() {
        MockTransport t = new MockTransport();
        DominusNodeClient c = connected(t);
        t.reply(200, "{\"nodes\":[{\"id\":\"a\",\"verifiedClass\":\"masked\",\"tierWeight\":0.25}],\"nextCursor\":\"abc=\"}");
        t.reply(200, "{\"nodes\":[{\"id\":\"b\"}],\"nextCursor\":null}");
        List<JsonNode> out = new ArrayList<>();
        Iterator<JsonNode> it = c.nodes().iterate(1);
        it.forEachRemaining(out::add);
        assertEquals(2, out.size());
        assertEquals(0.25, out.get(0).get("tierWeight").asDouble());
        assertTrue(t.last().url.contains("cursor=abc%3D"), t.last().url);
    }

    @Test
    void payoutsOffsetFallbackAndBadCursor() {
        MockTransport t = new MockTransport();
        DominusNodeClient c = connected(t);
        t.reply(200, "{\"payouts\":[{\"id\":\"1\"}]}");
        List<JsonNode> out = new ArrayList<>();
        c.payouts().iterate(5).forEachRemaining(out::add);
        assertEquals(1, out.size());
        assertThrows(ValidationException.class, () -> c.payouts().listAfter(null, "bad cursor"));
    }
}
