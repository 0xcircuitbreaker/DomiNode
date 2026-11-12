package io.dominusnode.sdk;

import com.fasterxml.jackson.databind.JsonNode;
import io.dominusnode.sdk.errors.ConflictException;
import io.dominusnode.sdk.errors.RateLimitException;
import io.dominusnode.sdk.errors.ServerException;
import io.dominusnode.sdk.errors.ValidationException;
import io.dominusnode.sdk.resources.TeamsResource;
import io.dominusnode.sdk.resources.UsageResource;
import org.junit.jupiter.api.Test;

import java.util.ArrayList;
import java.util.Iterator;
import java.util.List;
import java.util.stream.Collectors;

import static io.dominusnode.sdk.TestSupport.*;
import static org.junit.jupiter.api.Assertions.*;

/** 2.0.1 server-alignment fixes. */
class IntegrityTest {
    static final String TEAM = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";

    @Test
    void teamKeyPrefix() {
        MockTransport t = new MockTransport();
        DominusNodeClient c = connected(t);
        t.reply(201, "{\"id\":\"k\",\"prefix\":\"dn_live_ab\",\"label\":\"l\",\"key\":\"" + API_KEY + "\"}");
        TeamsResource.CreatedTeamKey k = c.teams().createKey(TEAM, "l");
        assertEquals("dn_live_ab", k.prefix);
        t.reply(201, "{\"id\":\"k\",\"keyPrefix\":\"dn_live_cd\",\"label\":\"l\",\"key\":\"" + API_KEY + "\"}");
        assertEquals("dn_live_cd", c.teams().createKey(TEAM, "l").prefix);
        t.reply(200, "{\"keys\":[{\"id\":\"k1\",\"userId\":\"u1\",\"prefix\":\"dn_live_x\",\"teamId\":\"" + TEAM + "\",\"revokedAt\":null},"
                + "{\"id\":\"k2\",\"keyPrefix\":\"dn_live_y\",\"revokedAt\":\"r\"}]}");
        JsonNode keys = c.teams().listKeys(TEAM).get("keys");
        assertEquals("dn_live_x", keys.get(0).get("prefix").asText());
        assertEquals("u1", keys.get(0).get("userId").asText());
        assertEquals(TEAM, keys.get(0).get("teamId").asText());
        assertTrue(keys.get(0).get("revokedAt").isNull());
        assertEquals("dn_live_y", keys.get(1).get("prefix").asText());
    }

    @Test
    void healthStatusOnly() {
        MockTransport t = new MockTransport();
        DominusNodeClient c = client(t);
        t.reply(200, "{\"status\":\"ok\",\"activeSessions\":3}");
        assertEquals("{\"status\":\"ok\"}", c.proxy().getHealth().toString());
    }

    @Test
    void cursorRegex() {
        MockTransport t = new MockTransport();
        DominusNodeClient c = connected(t);
        for (String bad : new String[] {"0", "01", "1".repeat(20), "-1", "1a"}) {
            assertThrows(ValidationException.class, () -> c.credits().transactions(null, bad, null), bad);
        }
        assertTrue(t.requests.isEmpty());
        t.reply(200, "{\"transactions\":[],\"nextCursor\":null}");
        c.credits().transactions(null, "9".repeat(19), null);
        assertTrue(t.requests.get(0).url.contains("cursor=" + "9".repeat(19)));
    }

    @Test
    void byteCounts() {
        assertEquals(12345678901L, UsageResource.byteCount(MockTransport.M.valueToTree("12345678901")));
        assertEquals(5L, UsageResource.byteCount(MockTransport.M.valueToTree(5)));
        assertEquals(0L, UsageResource.byteCount(null));
        for (Object bad : new Object[] {"abc", "1.5", 1.5, "99999999999999999999", true}) {
            assertThrows(ServerException.class, () -> UsageResource.byteCount(MockTransport.M.valueToTree(bad)), String.valueOf(bad));
        }
    }

    @Test
    void payoutWalletBaseSepolia() {
        MockTransport t = new MockTransport();
        DominusNodeClient c = connected(t);
        SignerFlowsTest.Recorder rec = new SignerFlowsTest.Recorder();
        String msg = Messages.payoutWallet(UUID, WALLET, SignerFlowsTest.PAYOUT, "base-sepolia", SignerFlowsTest.NONCE);
        t.reply(200, SignerFlowsTest.payoutChallenge(msg, false, null));
        t.reply(200, "{\"payoutWallet\":null,\"changed\":true,\"cooldownHours\":0}");
        c.payoutWallet().set(SignerFlowsTest.PAYOUT, rec.signer(WALLET), "base-sepolia", null);
        assertEquals("{\"address\":\"" + SignerFlowsTest.PAYOUT.toLowerCase() + "\",\"chain\":\"base-sepolia\"}", t.requests.get(0).body);
        int before = t.requests.size();
        assertThrows(ValidationException.class, () -> c.payoutWallet().set(SignerFlowsTest.PAYOUT, rec.signer(WALLET), "eth", null));
        assertEquals(before, t.requests.size());
    }

    @Test
    void reportLimitNotRetried() {
        MockTransport t = new MockTransport();
        DominusNodeClient c = connected(t);
        t.reply(409, "{\"error\":\"At most 20 reports\",\"code\":\"REPORT_LIMIT\"}");
        ConflictException e = assertThrows(ConflictException.class, () -> c.sessions().report(TEAM, "blocked"));
        assertEquals("REPORT_LIMIT", e.getCode());
        assertEquals(1, t.requests.size());
        t.reply(429, "{}", "retry-after", "0");
        t.reply(429, "{\"code\":\"REPORT_LIMIT\"}", "retry-after", "0");
        RateLimitException r = assertThrows(RateLimitException.class, () -> c.sessions().report(TEAM, "blocked"));
        assertEquals("REPORT_LIMIT", r.getCode());
        assertEquals(3, t.requests.size());
    }

    @Test
    void pagination() {
        MockTransport t = new MockTransport();
        DominusNodeClient c = connected(t);
        t.reply(200, "{\"transactions\":[{\"id\":\"3\"},{\"id\":\"2\"}],\"nextCursor\":\"2\"}");
        t.reply(200, "{\"transactions\":[{\"id\":\"1\"}],\"nextCursor\":null}");
        List<String> ids = c.credits().streamTransactions(2, "earn").map(n -> n.get("id").asText()).collect(Collectors.toList());
        assertEquals(List.of("3", "2", "1"), ids);
        assertTrue(t.requests.get(1).url.endsWith("/v1/credits/transactions?limit=2&cursor=2&type=earn"), t.requests.get(1).url);

        t.requests.clear();
        t.reply(200, "{\"payouts\":[{\"id\":\"a\"},{\"id\":\"b\"}]}");
        t.reply(200, "{\"payouts\":[{\"id\":\"c\"}]}");
        assertEquals(3, c.payouts().stream(2).count());
        assertTrue(t.requests.get(1).url.endsWith("/v1/payouts?limit=2&offset=2"));

        t.requests.clear();
        t.reply(200, "{\"nodes\":[{\"id\":\"a\"},{\"id\":\"b\"}]}");
        Iterator<JsonNode> it = c.nodes().iterate(2);
        assertTrue(it.hasNext());
        it.next();
        assertEquals(1, t.requests.size(), "lazy: second page not fetched yet");

        t.requests.clear();
        t.reply(200, "{\"records\":[{\"id\":\"a\"},{\"id\":\"b\"}],\"pagination\":{\"total\":2}}");
        List<JsonNode> recs = new ArrayList<>();
        c.usage().iterRecords("2026-01-01", null, 2).forEachRemaining(recs::add);
        assertEquals(2, recs.size());
        assertEquals(1, t.requests.size());

        t.requests.clear();
        t.reply(200, "{\"transactions\":[{\"id\":\"a\"}]}");
        assertEquals(1, c.wallet().streamTransactions(5).count());
        assertThrows(ValidationException.class, () -> c.wallet().iterTransactions(101));
    }
}
