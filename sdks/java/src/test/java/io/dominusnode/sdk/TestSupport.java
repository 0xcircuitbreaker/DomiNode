package io.dominusnode.sdk;

import java.nio.charset.StandardCharsets;
import java.util.Base64;

final class TestSupport {
    private TestSupport() {}

    static final String API_KEY = "dn_live_abcdefgh12345678";
    static final String WALLET = "0xAbCdEf0123456789aBcDeF0123456789AbCdEf01";
    static final String UUID = "11111111-2222-4333-8444-555555555555";
    static final String SIG = "0x" + "ab".repeat(65);

    static String jwt(long expSeconds, String tag) {
        Base64.Encoder e = Base64.getUrlEncoder().withoutPadding();
        return "eyJhbGciOiJIUzI1NiJ9." + e.encodeToString(("{\"exp\":" + expSeconds + ",\"t\":\"" + tag + "\"}").getBytes(StandardCharsets.UTF_8)) + ".sig";
    }

    static final String JWT = jwt(System.currentTimeMillis() / 1000 + 3600, "a");
    static final String REFRESH = jwt(System.currentTimeMillis() / 1000 + 86400, "r");

    static DominusNodeClient client(MockTransport t) {
        DominusNodeClient c = new DominusNodeClient(Config.builder().baseUrl("https://api.test").transport(t).build());
        c.setSleeper(ms -> { });
        return c;
    }

    /** Client connected with API_KEY plus a JWT pair; request log cleared. */
    static DominusNodeClient connected(MockTransport t) {
        DominusNodeClient c = client(t);
        t.reply(200, "{\"valid\":true,\"token\":\"" + JWT + "\",\"refreshToken\":\"" + REFRESH + "\",\"userId\":\"" + UUID + "\"}");
        c.connectWithKey(API_KEY);
        t.requests.clear();
        return c;
    }
}
