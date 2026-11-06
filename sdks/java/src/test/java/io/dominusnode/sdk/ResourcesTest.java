package io.dominusnode.sdk;

import com.fasterxml.jackson.databind.JsonNode;
import io.dominusnode.sdk.resources.KeysResource;
import io.dominusnode.sdk.resources.SessionsResource;
import io.dominusnode.sdk.resources.TeamsResource;
import org.junit.jupiter.api.DynamicTest;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.TestFactory;

import java.lang.reflect.Method;
import java.lang.reflect.Modifier;
import java.util.ArrayList;
import java.util.List;
import java.util.Set;
import java.util.TreeSet;
import java.util.function.Consumer;

import static io.dominusnode.sdk.TestSupport.*;
import static org.junit.jupiter.api.Assertions.*;

/** One case per HTTP method: verb, path (incl. encoding), query, body and auth mode. */
class ResourcesTest {

    private static final class Case {
        final String name, verb, path, body, auth;
        final Consumer<DominusNodeClient> call;

        Case(String name, Consumer<DominusNodeClient> call, String verb, String path, String body, String auth) {
            this.name = name; this.call = call; this.verb = verb; this.path = path; this.body = body; this.auth = auth;
        }
    }

    private static final String ENC = "a%2Fb%20c";  // "a/b c"
    private static final String RAW = "a/b c";

    static List<Case> cases() {
        List<Case> l = new ArrayList<>();
        // auth (4)
        l.add(new Case("auth.verifyKey", c -> c.auth().verifyKey(API_KEY), "POST", "/api/auth/verify-key", "{\"apiKey\":\"" + API_KEY + "\"}", "none"));
        l.add(new Case("auth.refresh", c -> c.auth().refresh("rt"), "POST", "/api/auth/refresh", "{\"refreshToken\":\"rt\"}", "none"));
        l.add(new Case("auth.logout", c -> c.auth().logout(), "POST", "/api/auth/logout", "{}", "jwt"));
        l.add(new Case("auth.me", c -> c.auth().me(), "GET", "/api/auth/me", null, "jwt"));
        // walletAuth (challenge, verify, link; signIn in SignerFlowsTest)
        l.add(new Case("walletAuth.challenge", c -> c.walletAuth().challenge(WALLET), "POST", "/api/auth/wallet/challenge", "{\"address\":\"" + WALLET + "\"}", "none"));
        l.add(new Case("walletAuth.verify", c -> c.walletAuth().verify(WALLET, SIG), "POST", "/api/auth/wallet/verify", "{\"address\":\"" + WALLET + "\",\"signature\":\"" + SIG + "\"}", "none"));
        l.add(new Case("walletAuth.link", c -> c.walletAuth().link(WALLET, SIG), "POST", "/api/auth/wallet/link", "{\"address\":\"" + WALLET + "\",\"signature\":\"" + SIG + "\"}", "jwt"));
        // keys (3)
        l.add(new Case("keys.create", c -> c.keys().create(), "POST", "/api/keys", "{\"label\":\"Default\"}", "jwt"));
        l.add(new Case("keys.list", c -> c.keys().list(), "GET", "/api/keys", null, "jwt"));
        l.add(new Case("keys.revoke", c -> c.keys().revoke(RAW), "DELETE", "/api/keys/" + ENC, null, "jwt"));
        // wallet (5)
        l.add(new Case("wallet.getBalance", c -> c.wallet().getBalance(), "GET", "/api/wallet", null, "jwt"));
        l.add(new Case("wallet.getTransactions", c -> c.wallet().getTransactions(10, 5), "GET", "/api/wallet/transactions?limit=10&offset=5", null, "jwt"));
        l.add(new Case("wallet.getForecast", c -> c.wallet().getForecast(), "GET", "/api/wallet/forecast", null, "jwt"));
        l.add(new Case("wallet.topUpCrypto", c -> c.wallet().topUpCrypto(2550, "USDC"), "POST", "/api/wallet/topup/crypto", "{\"amountUsd\":25.5,\"currency\":\"usdc\"}", "jwt"));
        l.add(new Case("wallet.getCryptoStatus", c -> c.wallet().getCryptoStatus(UUID), "GET", "/api/wallet/crypto/status/" + UUID, null, "jwt"));
        // agenticWallets (9)
        l.add(new Case("agenticWallets.create", c -> c.agenticWallets().create("bot", 500, 100L, List.of("example.com")), "POST", "/api/agent-wallet",
                "{\"label\":\"bot\",\"spendingLimitCents\":500,\"dailyLimitCents\":100,\"allowedDomains\":[\"example.com\"]}", "jwt"));
        l.add(new Case("agenticWallets.list", c -> c.agenticWallets().list(), "GET", "/api/agent-wallet", null, "jwt"));
        l.add(new Case("agenticWallets.get", c -> c.agenticWallets().get(RAW), "GET", "/api/agent-wallet/" + ENC, null, "jwt"));
        l.add(new Case("agenticWallets.fund", c -> c.agenticWallets().fund(RAW, 250), "POST", "/api/agent-wallet/" + ENC + "/fund", "{\"amountCents\":250}", "jwt"));
        l.add(new Case("agenticWallets.updateWalletPolicy", c -> c.agenticWallets().updateWalletPolicy(RAW, 0L, null), "PATCH", "/api/agent-wallet/" + ENC + "/policy", "{\"dailyLimitCents\":0}", "jwt"));
        l.add(new Case("agenticWallets.transactions", c -> c.agenticWallets().transactions(RAW, 3, null), "GET", "/api/agent-wallet/" + ENC + "/transactions?limit=3", null, "jwt"));
        l.add(new Case("agenticWallets.freeze", c -> c.agenticWallets().freeze(RAW), "POST", "/api/agent-wallet/" + ENC + "/freeze", "{}", "jwt"));
        l.add(new Case("agenticWallets.unfreeze", c -> c.agenticWallets().unfreeze(RAW), "POST", "/api/agent-wallet/" + ENC + "/unfreeze", "{}", "jwt"));
        l.add(new Case("agenticWallets.delete", c -> c.agenticWallets().delete(RAW), "DELETE", "/api/agent-wallet/" + ENC, null, "jwt"));
        // teams (18)
        String T = "/api/teams/" + ENC;
        l.add(new Case("teams.create", c -> c.teams().create("t", 5), "POST", "/api/teams", "{\"name\":\"t\",\"maxMembers\":5}", "jwt"));
        l.add(new Case("teams.list", c -> c.teams().list(), "GET", "/api/teams", null, "jwt"));
        l.add(new Case("teams.get", c -> c.teams().get(RAW), "GET", T, null, "jwt"));
        l.add(new Case("teams.update", c -> c.teams().update(RAW, "n", null), "PATCH", T, "{\"name\":\"n\"}", "jwt"));
        l.add(new Case("teams.delete", c -> c.teams().delete(RAW), "DELETE", T, null, "jwt"));
        l.add(new Case("teams.fundWallet", c -> c.teams().fundWallet(RAW, 100), "POST", T + "/wallet/fund", "{\"amountCents\":100}", "jwt"));
        l.add(new Case("teams.getTransactions", c -> c.teams().getTransactions(RAW, 1, 2), "GET", T + "/wallet/transactions?limit=1&offset=2", null, "jwt"));
        l.add(new Case("teams.listMembers", c -> c.teams().listMembers(RAW), "GET", T + "/members", null, "jwt"));
        l.add(new Case("teams.addMember", c -> c.teams().addMember(RAW, "a@b.c", "admin"), "POST", T + "/members", "{\"email\":\"a@b.c\",\"role\":\"admin\"}", "jwt"));
        l.add(new Case("teams.updateMemberRole", c -> c.teams().updateMemberRole(RAW, "u/1", "member"), "PATCH", T + "/members/u%2F1", "{\"role\":\"member\"}", "jwt"));
        l.add(new Case("teams.removeMember", c -> c.teams().removeMember(RAW, "u/1"), "DELETE", T + "/members/u%2F1", null, "jwt"));
        l.add(new Case("teams.createInvite", c -> c.teams().createInvite(RAW, "a@b.c"), "POST", T + "/invites", "{\"email\":\"a@b.c\"}", "jwt"));
        l.add(new Case("teams.listInvites", c -> c.teams().listInvites(RAW), "GET", T + "/invites", null, "jwt"));
        l.add(new Case("teams.cancelInvite", c -> c.teams().cancelInvite(RAW, "i?1"), "DELETE", T + "/invites/i%3F1", null, "jwt"));
        l.add(new Case("teams.acceptInvite", c -> c.teams().acceptInvite("tok/en"), "POST", "/api/teams/invites/tok%2Fen/accept", "{}", "jwt"));
        l.add(new Case("teams.createKey", c -> c.teams().createKey(RAW, "ci"), "POST", T + "/keys", "{\"label\":\"ci\"}", "jwt"));
        l.add(new Case("teams.listKeys", c -> c.teams().listKeys(RAW), "GET", T + "/keys", null, "jwt"));
        l.add(new Case("teams.revokeKey", c -> c.teams().revokeKey(RAW, "k#1"), "DELETE", T + "/keys/k%231", null, "jwt"));
        // usage (4)
        l.add(new Case("usage.get", c -> c.usage().get("2026-01-01T00:00:00Z", null, 10, 0), "GET", "/api/usage?since=2026-01-01T00%3A00%3A00Z&limit=10&offset=0", null, "jwt"));
        l.add(new Case("usage.getDaily", c -> c.usage().getDaily(null, "2026-02-01"), "GET", "/api/usage/daily?until=2026-02-01", null, "jwt"));
        l.add(new Case("usage.getTopHosts", c -> c.usage().getTopHosts(null, null, 5), "GET", "/api/usage/top-hosts?limit=5", null, "jwt"));
        l.add(new Case("usage.exportCsv", c -> c.usage().exportCsv(), "GET", "/api/usage/export", null, "jwt"));
        // sessions (2)
        l.add(new Case("sessions.getActive", c -> c.sessions().getActive(), "GET", "/api/sessions/active", null, "jwt"));
        l.add(new Case("sessions.report", c -> c.sessions().report(UUID, "captcha"), "POST", "/v1/sessions/" + UUID + "/report", "{\"reason\":\"captcha\"}", "agent"));
        // x402, network
        l.add(new Case("x402.getInfo", c -> c.x402().getInfo(), "GET", "/api/x402/info", null, "none"));
        l.add(new Case("network.policy", c -> c.network().policy(), "GET", "/v1/policy", null, "none"));
        l.add(new Case("network.pricing", c -> c.network().pricing(), "GET", "/v1/pricing", null, "none"));
        l.add(new Case("network.stats", c -> c.network().stats(), "GET", "/v1/network/stats", null, "none"));
        // nodes (register in SignerFlowsTest)
        l.add(new Case("nodes.registerChallenge", c -> c.nodes().registerChallenge("AB".repeat(32)), "POST", "/v1/nodes/challenge", "{\"nodePubkey\":\"" + "ab".repeat(32) + "\"}", "agent"));
        l.add(new Case("nodes.registerChallenge(empty)", c -> c.nodes().registerChallenge(), "POST", "/v1/nodes/challenge", "{}", "agent"));
        l.add(new Case("nodes.list", c -> c.nodes().list(500, 0), "GET", "/v1/nodes?limit=500&offset=0", null, "agent"));
        l.add(new Case("nodes.revoke", c -> c.nodes().revoke(UUID), "DELETE", "/v1/nodes/" + UUID, null, "agent"));
        l.add(new Case("nodes.updateCaps", c -> c.nodes().updateCaps(UUID, null, 20, null), "PATCH", "/v1/nodes/" + UUID, "{\"gbPerDay\":20}", "agent"));
        l.add(new Case("nodes.tier", c -> c.nodes().tier(), "GET", "/v1/node/tier", null, "agent"));
        // credits (withdraw in SignerFlowsTest)
        l.add(new Case("credits.balance", c -> c.credits().balance(), "GET", "/v1/credits", null, "agent"));
        l.add(new Case("credits.transactions", c -> c.credits().transactions(50, "123", "earn"), "GET", "/v1/credits/transactions?limit=50&cursor=123&type=earn", null, "agent"));
        l.add(new Case("credits.convert", c -> c.credits().convert(new java.math.BigInteger("10000"), "idem-key-1"), "POST", "/v1/credits/convert", "{\"amountMusd\":\"10000\"}", "agent"));
        // payoutWallet (set in SignerFlowsTest), payouts
        l.add(new Case("payoutWallet.get", c -> c.payoutWallet().get(), "GET", "/v1/payout-wallet", null, "agent"));
        l.add(new Case("payouts.list", c -> c.payouts().list(200, 1_000_000), "GET", "/v1/payouts?limit=200&offset=1000000", null, "agent"));
        // proxy (HTTP ones; builders + fetch in ProxyTest)
        l.add(new Case("proxy.getHealth", c -> c.proxy().getHealth(), "GET", "/api/proxy/health", null, "none"));
        l.add(new Case("proxy.getConfig", c -> c.proxy().getConfig(), "GET", "/api/proxy/config", null, "jwt"));
        return l;
    }

    @TestFactory
    List<DynamicTest> everyMethod() {
        List<DynamicTest> out = new ArrayList<>();
        for (Case k : cases()) {
            out.add(DynamicTest.dynamicTest(k.name, () -> {
                MockTransport t = new MockTransport();
                DominusNodeClient c = connected(t);
                if (k.name.startsWith("keys.create")) t.reply(200, "{\"id\":\"1\",\"key\":\"" + API_KEY + "\"}");
                if (k.name.startsWith("teams.createKey")) t.reply(200, "{\"id\":\"1\",\"key\":\"dn_live_teamkey123456\"}");
                k.call.accept(c);
                assertEquals(1, t.requests.size());
                Transport.Request r = t.last();
                assertEquals(k.verb, r.method);
                assertEquals(k.path, MockTransport.path(r));
                if (k.body == null) {
                    assertNull(r.body);
                    assertNull(r.headers.get("Content-Type"));
                } else {
                    assertEquals(MockTransport.M.readTree(k.body), MockTransport.json(r));
                    assertEquals("application/json", r.headers.get("Content-Type"));
                }
                String expected = k.auth.equals("none") ? null : "Bearer " + (k.auth.equals("agent") ? API_KEY : JWT);
                assertEquals(expected, MockTransport.auth(r));
                assertEquals("dominusnode-sdk-java/2.0.0", r.headers.get("User-Agent"));
                assertEquals("application/json", r.headers.get("Accept"));
            }));
        }
        return out;
    }

    @Test
    void convertSendsIdempotencyHeaderAndEchoesKey() {
        MockTransport t = new MockTransport();
        DominusNodeClient c = connected(t);
        t.reply(200, "{\"converted\":{\"musd\":\"10000\",\"usd\":\"0.010000\"},\"convertedCents\":1,\"duplicate\":false}");
        JsonNode r = c.credits().convert("10000");
        String key = t.last().headers.get("Idempotency-Key");
        assertTrue(key.matches("^dn-[0-9a-f-]{36}$"));
        assertEquals(key, r.get("idempotencyKey").asText());
        assertEquals(1, r.get("convertedCents").asInt());
    }

    @Test
    void secretsWrappedInCreateResults() {
        MockTransport t = new MockTransport();
        DominusNodeClient c = connected(t);
        t.reply(200, "{\"id\":\"1\",\"prefix\":\"dn_live_\",\"label\":\"x\",\"created_at\":\"now\",\"key\":\"" + API_KEY + "\"}");
        KeysResource.CreatedKey k = c.keys().create("x");
        assertEquals(API_KEY, k.key.reveal());
        assertFalse(k.toString().contains(API_KEY));
        t.reply(200, "{\"id\":\"1\",\"keyPrefix\":\"dn_live_\",\"label\":\"x\",\"key\":\"dn_live_teamkey123456\"}");
        TeamsResource.CreatedTeamKey tk = c.teams().createKey("t", "x");
        assertEquals("dn_live_teamkey123456", tk.key.reveal());
        assertEquals("[REDACTED]", String.valueOf(tk.key));
    }

    @Test
    void getActiveDropsUnknownFields() {
        MockTransport t = new MockTransport();
        DominusNodeClient c = connected(t);
        t.reply(200, "{\"sessions\":[{\"id\":\"s1\",\"startedAt\":\"t\",\"status\":\"active\",\"proxyIp\":\"1.2.3.4\",\"proxy_ip\":\"5.6.7.8\"}]}");
        List<SessionsResource.ActiveSession> s = c.sessions().getActive();
        assertEquals(1, s.size());
        assertEquals("s1", s.get(0).id);
        assertFalse(s.get(0).toString().contains("1.2.3.4"));
        Set<String> fields = new TreeSet<>();
        for (java.lang.reflect.Field f : SessionsResource.ActiveSession.class.getDeclaredFields()) fields.add(f.getName());
        assertEquals(Set.of("id", "startedAt", "status"), fields);
    }

    @Test
    void exportCsvReturnsRawText() {
        MockTransport t = new MockTransport();
        DominusNodeClient c = connected(t);
        t.reply(200, "date,bytes\n2026-01-01,5\n");
        assertEquals("date,bytes\n2026-01-01,5\n", c.usage().exportCsv());
    }

    /** 15 resources, 71 methods (counting distinct public method names per resource). */
    @Test
    void surfaceCounts() {
        DominusNodeClient c = client(new MockTransport());
        Object[] resources = {c.auth(), c.walletAuth(), c.keys(), c.wallet(), c.agenticWallets(), c.teams(), c.usage(),
                c.sessions(), c.x402(), c.network(), c.nodes(), c.credits(), c.payoutWallet(), c.payouts(), c.proxy()};
        int[] expected = {4, 4, 3, 5, 9, 18, 4, 2, 1, 3, 6, 4, 2, 1, 5};
        int total = 0;
        for (int i = 0; i < resources.length; i++) {
            Set<String> names = new TreeSet<>();
            for (Method m : resources[i].getClass().getDeclaredMethods()) {
                if (Modifier.isPublic(m.getModifiers()) && !Modifier.isStatic(m.getModifiers()) && !m.getName().equals("setResolver")) names.add(m.getName());
            }
            assertEquals(expected[i], names.size(), resources[i].getClass().getSimpleName() + " " + names);
            total += names.size();
        }
        assertEquals(15, resources.length);
        assertEquals(71, total);
    }
}
