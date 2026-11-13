package io.dominusnode.sdk;

import com.fasterxml.jackson.databind.ObjectMapper;
import io.dominusnode.sdk.errors.ValidationException;
import io.dominusnode.sdk.internal.TokenManager;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.function.Executable;

import java.math.BigInteger;
import java.nio.charset.StandardCharsets;
import java.util.Base64;

import static io.dominusnode.sdk.TestSupport.*;
import static org.junit.jupiter.api.Assertions.*;

class ValidationRedactionTest {

    private static void invalid(MockTransport t, Executable e) {
        int before = t.requests.size();
        ValidationException ex = assertThrows(ValidationException.class, e);
        assertEquals("INVALID_ARGUMENT", ex.getCode());
        assertNull(ex.getStatusCode());
        assertEquals(before, t.requests.size(), "no request may be sent");
    }

    @Test
    void validationSendsNoRequest() {
        MockTransport t = new MockTransport();
        DominusNodeClient c = connected(t);
        // cents bounds
        invalid(t, () -> c.agenticWallets().fund(UUID, 0));
        invalid(t, () -> c.agenticWallets().fund(UUID, 2_147_483_648L));
        invalid(t, () -> c.teams().fundWallet(UUID, 0));
        invalid(t, () -> c.teams().fundWallet(UUID, 2_147_483_648L));
        invalid(t, () -> c.agenticWallets().create("x", -1, null, null));
        invalid(t, () -> c.agenticWallets().create("x", 2_147_483_648L, null, null));
        invalid(t, () -> c.agenticWallets().updateWalletPolicy(UUID, 2_147_483_648L, null));
        invalid(t, () -> c.wallet().topUpCrypto(999, "btc"));
        invalid(t, () -> c.wallet().topUpCrypto(100_001, "btc"));
        invalid(t, () -> c.wallet().topUpCrypto(5000, "doge"));
        // µUSD bounds and types
        invalid(t, () -> c.credits().convert(9_999L, Signer.of(WALLET, m -> SIG)));
        invalid(t, () -> c.credits().convert(10_000_000_001L, Signer.of(WALLET, m -> SIG)));
        invalid(t, () -> c.credits().convert("010000", Signer.of(WALLET, m -> SIG)));
        invalid(t, () -> c.credits().convert("1e5", Signer.of(WALLET, m -> SIG)));
        invalid(t, () -> c.credits().convert(1.5, Signer.of(WALLET, m -> SIG)));
        invalid(t, () -> c.credits().convert(9_007_199_254_740_992L, Signer.of(WALLET, m -> SIG)));
        invalid(t, () -> c.credits().withdraw(999_999L, Signer.of(WALLET, m -> SIG)));
        invalid(t, () -> c.credits().withdraw(new BigInteger("100000000001"), Signer.of(WALLET, m -> SIG)));
        // idempotency key
        invalid(t, () -> c.credits().convert(10_000L, Signer.of(WALLET, m -> SIG), "short"));
        invalid(t, () -> c.credits().convert(10_000L, Signer.of(WALLET, m -> SIG), "bad key!!"));
        invalid(t, () -> c.credits().withdraw(1_000_000L, Signer.of(WALLET, m -> SIG), "x".repeat(121)));
        // uuid
        invalid(t, () -> c.nodes().revoke("not-a-uuid"));
        invalid(t, () -> c.nodes().updateCaps("nope", 1, null, null));
        invalid(t, () -> c.nodes().updateCaps(UUID, null, null, null));
        invalid(t, () -> c.nodes().updateCaps(UUID, 0, null, null));
        invalid(t, () -> c.sessions().report("x", "captcha"));
        invalid(t, () -> c.sessions().report(UUID, "boring"));
        invalid(t, () -> c.wallet().getCryptoStatus("../x"));
        // address and signature
        invalid(t, () -> c.walletAuth().challenge("0x123"));
        invalid(t, () -> c.walletAuth().verify(WALLET, "0x" + "a".repeat(129)));
        invalid(t, () -> c.walletAuth().verify(WALLET, "0x" + "a".repeat(199)));
        invalid(t, () -> c.walletAuth().link(WALLET, "0x" + "g".repeat(130)));
        invalid(t, () -> Signer.of("0xnothex", m -> SIG));
        // pagination & misc
        invalid(t, () -> c.nodes().list(0, null));
        invalid(t, () -> c.nodes().list(501, null));
        invalid(t, () -> c.payouts().list(null, -1));
        invalid(t, () -> c.credits().transactions(201, null, null));
        invalid(t, () -> c.credits().transactions(null, "abc", null));
        invalid(t, () -> c.credits().transactions(null, null, "steal"));
        invalid(t, () -> c.keys().create(""));
        invalid(t, () -> c.keys().create("x".repeat(101)));
        invalid(t, () -> c.teams().createKey(UUID, ""));
        invalid(t, () -> c.auth().verifyKey("dn_live_short"));
    }

    @Test
    void musdAcceptsBigIntegerStringAndLong() {
        MockTransport t = new MockTransport();
        DominusNodeClient c = connected(t);
        assertThrows(io.dominusnode.sdk.errors.ProtocolException.class, () -> c.credits().convert(new BigInteger("10000000000"), Signer.of(WALLET, m -> SIG)));
        assertEquals("{\"amountMusd\":\"10000000000\"}", t.last().body);
        assertThrows(io.dominusnode.sdk.errors.ProtocolException.class, () -> c.credits().convert("10000", Signer.of(WALLET, m -> SIG)));
        assertEquals("{\"amountMusd\":\"10000\"}", t.last().body);
        assertThrows(io.dominusnode.sdk.errors.ProtocolException.class, () -> c.credits().convert(123456L, Signer.of(WALLET, m -> SIG)));
        assertEquals("{\"amountMusd\":\"123456\"}", t.last().body);
    }

    @Test
    void secretRedaction() throws Exception {
        Secret s = new Secret(API_KEY);
        assertEquals("[REDACTED]", s.toString());
        assertEquals("\"[REDACTED]\"", new ObjectMapper().writeValueAsString(s));
        assertEquals(API_KEY, s.reveal());
        assertEquals("dn_live_", s.prefix());
        for (java.lang.reflect.Field f : Secret.class.getDeclaredFields()) {
            if (!java.lang.reflect.Modifier.isStatic(f.getModifiers())) assertTrue(java.lang.reflect.Modifier.isPrivate(f.getModifiers()));
        }
        s.clear();
        assertEquals("\0".repeat(API_KEY.length()), s.reveal());
    }

    @Test
    void clientAndTokenManagerRedaction() throws Exception {
        MockTransport t = new MockTransport();
        DominusNodeClient c = connected(t);
        assertEquals("DominusNodeClient(connected=true)", c.toString());
        String json = new ObjectMapper().writeValueAsString(c);
        assertFalse(json.contains(API_KEY));
        assertFalse(json.contains("eyJ"));
        assertEquals("TokenManager([REDACTED])", c.tokenManager().toString());
        assertFalse(c.proxy().toString().contains(API_KEY));
    }

    @Test
    void disconnectClearsAllCredentials() throws Exception {
        MockTransport t = new MockTransport();
        DominusNodeClient c = connected(t);
        java.lang.reflect.Field kf = DominusNodeClient.class.getDeclaredField("apiKey");
        kf.setAccessible(true);
        java.lang.reflect.Field af = TokenManager.class.getDeclaredField("access");
        af.setAccessible(true);
        char[] keyChars = (char[]) kf.get(c);
        char[] accessChars = (char[]) af.get(c.tokenManager());
        t.reply(500, "{\"error\":\"logout broken\"}");
        c.disconnect();
        assertEquals("/api/auth/logout", MockTransport.path(t.last()));
        assertFalse(c.isConnected());
        assertNull(kf.get(c));
        assertNull(c.tokenManager().getAccessToken());
        assertNull(c.tokenManager().getRefreshToken());
        for (char ch : keyChars) assertEquals('\0', ch);
        for (char ch : accessChars) assertEquals('\0', ch);
        assertThrows(io.dominusnode.sdk.errors.AuthenticationException.class, () -> c.credits().balance());
        // reconnect works (refresh callback kept)
        assertTrue(c.tokenManager().hasRefreshFunction());
        t.reply(200, "{\"token\":\"" + JWT + "\",\"refreshToken\":\"" + REFRESH + "\"}");
        c.connectWithKey(API_KEY);
        assertTrue(c.isConnected());
    }

    @Test
    void disconnectWithoutTokensSkipsLogout() {
        MockTransport t = new MockTransport();
        DominusNodeClient c = client(t);
        t.reply(403, "{\"mfaRequired\":true}");
        c.connectWithKey(API_KEY);
        t.requests.clear();
        c.close();
        assertTrue(t.requests.isEmpty());
        assertFalse(c.isConnected());
    }

    @Test
    void tokenManagerClearKeepsRefreshFn() {
        TokenManager tm = new TokenManager();
        tm.setRefreshFunction(rt -> new String[]{"a", "b"});
        tm.setTokens("x", "y");
        tm.clear();
        assertFalse(tm.hasTokens());
        assertTrue(tm.hasRefreshFunction());
    }

    @Test
    void jwtExpiryCheck() {
        assertTrue(TokenManager.isExpired("garbage"));
        assertFalse(TokenManager.isExpired(JWT));
        String noExp = "eyJ." + Base64.getUrlEncoder().withoutPadding().encodeToString("{}".getBytes(StandardCharsets.UTF_8)) + ".s";
        assertTrue(TokenManager.isExpired(noExp));
    }

    @Test
    void pathParamsUseEncodeUriComponentSemantics() {
        assertEquals("a%20b%2Fc!'()*~%3F%26%3D%C3%BC", io.dominusnode.sdk.internal.Validation.seg("a b/c!'()*~?&=ü"));
    }
}
