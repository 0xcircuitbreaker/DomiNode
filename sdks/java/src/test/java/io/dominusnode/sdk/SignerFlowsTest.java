package io.dominusnode.sdk;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.node.ObjectNode;
import io.dominusnode.sdk.errors.ProtocolException;
import io.dominusnode.sdk.errors.ValidationException;
import io.dominusnode.sdk.internal.Pow;
import io.dominusnode.sdk.resources.NodesResource;
import org.junit.jupiter.api.Test;

import java.util.ArrayList;
import java.util.List;

import static io.dominusnode.sdk.TestSupport.*;
import static org.junit.jupiter.api.Assertions.*;

class SignerFlowsTest {
    static final String NONCE = "e".repeat(64);
    static final String OLD = "0x1111111111111111111111111111111111111111";
    static final String PAYOUT = "0x00000000000000000000000000000000DeAdBeEf";

    static final class Recorder {
        final List<String> signed = new ArrayList<>();
        String sig = SIG;

        Signer signer(String address) {
            return Signer.of(address, m -> { signed.add(m); return sig; });
        }
    }

    // ---- node register ----

    static ObjectNode nodeChallenge(String wallet, String pubkey, int difficulty) {
        ObjectNode ch = MockTransport.M.createObjectNode();
        ch.put("nonce", NONCE);
        ch.put("attestationText", "I agree.\nNo abuse.");
        ch.put("attestationVersion", 2);
        ch.put("policyVersion", 1);
        ch.put("message", Messages.attestation(wallet, NONCE, 2, "I agree.\nNo abuse.", pubkey));
        ch.put("expiresAt", "later");
        ObjectNode p = ch.putObject("powChallenge");
        p.put("challengeId", UUID);
        p.put("prefix", "dnpow:abc:");
        p.put("difficulty", difficulty);
        p.put("algorithm", "sha256");
        return ch;
    }

    @Test
    void nodeRegisterFullFlow() {
        MockTransport t = new MockTransport();
        DominusNodeClient c = connected(t);
        Recorder rec = new Recorder();
        String pub = "cd".repeat(32);
        t.reply(200, nodeChallenge(WALLET, pub, 8).toString());
        t.reply(200, "{\"nodeId\":\"" + UUID + "\",\"nodeKey\":\"dn_node_" + "f".repeat(64) + "\",\"status\":\"active\",\"attestationVersion\":2}");
        NodesResource.RegisteredNode n = c.nodes().register(new NodesResource.RegisterOptions(rec.signer(WALLET))
                .nodePubkey(pub.toUpperCase()).maxStreams(16).maxGbDay(100));
        assertEquals(UUID, n.nodeId);
        assertEquals("dn_node_" + "f".repeat(64), n.nodeKey.reveal());
        assertFalse(n.toString().contains("dn_node_"));
        assertEquals(List.of(Messages.attestation(WALLET, NONCE, 2, "I agree.\nNo abuse.", pub)), rec.signed);

        assertEquals("/v1/nodes/challenge", MockTransport.path(t.requests.get(0)));
        assertEquals(pub, MockTransport.json(t.requests.get(0)).get("nodePubkey").asText());
        JsonNode body = MockTransport.json(t.requests.get(1));
        assertEquals("/v1/nodes", MockTransport.path(t.requests.get(1)));
        assertEquals("Bearer " + API_KEY, MockTransport.auth(t.requests.get(1)));
        assertEquals(NONCE, body.get("nonce").asText());
        assertEquals(SIG, body.get("walletSignature").asText());
        assertEquals(2, body.get("attestationVersion").asInt());
        assertEquals(UUID, body.get("pow").get("challengeId").asText());
        assertEquals(pub, body.get("nodePubkey").asText());
        assertEquals(16, body.get("maxStreams").asInt());
        assertEquals(100, body.get("maxGbDay").asInt());
        String powNonce = body.get("pow").get("nonce").asText();
        assertTrue(Pow.leadingZeroBits(Pow.sha256("dnpow:abc:" + powNonce)) >= 8);
        // smallest solution
        for (long i = 0; i < Long.parseLong(powNonce); i++) {
            assertTrue(Pow.leadingZeroBits(Pow.sha256("dnpow:abc:" + i)) < 8);
        }
    }

    @Test
    void nodeRegisterWithSuppliedChallengeAndNoPubkey() {
        MockTransport t = new MockTransport();
        DominusNodeClient c = connected(t);
        Recorder rec = new Recorder();
        t.reply(200, "{\"nodeId\":\"" + UUID + "\",\"nodeKey\":\"dn_node_" + "0".repeat(64) + "\",\"status\":\"pending\",\"attestationVersion\":2}");
        c.nodes().register(new NodesResource.RegisterOptions(rec.signer(WALLET)).challenge(nodeChallenge(WALLET, null, 4)));
        assertEquals(1, t.requests.size());
        assertFalse(MockTransport.json(t.last()).has("nodePubkey"));
        assertTrue(rec.signed.get(0).contains("Node pubkey: none"));
    }

    @Test
    void nodeRegisterMessageMismatchRefused() {
        MockTransport t = new MockTransport();
        DominusNodeClient c = connected(t);
        Recorder rec = new Recorder();
        ObjectNode ch = nodeChallenge(OLD, null, 4); // built for another wallet
        t.reply(200, ch.toString());
        assertThrows(ProtocolException.class, () -> c.nodes().register(rec.signer(WALLET)));
        assertTrue(rec.signed.isEmpty());
        assertEquals(1, t.requests.size());
        ObjectNode ch2 = nodeChallenge(WALLET, null, 4);
        ch2.put("message", ch2.get("message").asText() + "\nextra");
        assertThrows(ProtocolException.class, () -> c.nodes().register(new NodesResource.RegisterOptions(rec.signer(WALLET)).challenge(ch2)));
        assertTrue(rec.signed.isEmpty());
    }

    @Test
    void nodeRegisterBadChallengeAndBadResponse() {
        MockTransport t = new MockTransport();
        DominusNodeClient c = connected(t);
        Recorder rec = new Recorder();
        ObjectNode bad = nodeChallenge(WALLET, null, 4);
        bad.put("nonce", "xyz");
        assertThrows(ProtocolException.class, () -> c.nodes().register(new NodesResource.RegisterOptions(rec.signer(WALLET)).challenge(bad)));
        ObjectNode badDiff = nodeChallenge(WALLET, null, 40);
        assertThrows(ProtocolException.class, () -> c.nodes().register(new NodesResource.RegisterOptions(rec.signer(WALLET)).challenge(badDiff)));
        assertThrows(ProtocolException.class, () -> c.nodes().register(new NodesResource.RegisterOptions(rec.signer(WALLET))
                .challenge(nodeChallenge(WALLET, null, 30)).maxPowIterations(10)));
        assertTrue(rec.signed.isEmpty());
        t.reply(200, "{\"nodeId\":\"" + UUID + "\",\"nodeKey\":\"dn_live_notanodekey\"}");
        assertThrows(ProtocolException.class, () -> c.nodes().register(new NodesResource.RegisterOptions(rec.signer(WALLET)).challenge(nodeChallenge(WALLET, null, 1))));
        assertThrows(ValidationException.class, () -> c.nodes().register(new NodesResource.RegisterOptions(rec.signer(WALLET)).maxStreams(1025)));
        assertThrows(ValidationException.class, () -> c.nodes().register(new NodesResource.RegisterOptions(rec.signer(WALLET)).nodePubkey("zz")));
    }

    @Test
    void badSignatureFromSigner() {
        MockTransport t = new MockTransport();
        DominusNodeClient c = connected(t);
        Recorder rec = new Recorder();
        rec.sig = "0x1234";
        assertThrows(ProtocolException.class, () -> c.nodes().register(new NodesResource.RegisterOptions(rec.signer(WALLET)).challenge(nodeChallenge(WALLET, null, 1))));
        Signer throwing = Signer.of(WALLET, m -> { throw new IllegalStateException("hsm offline " + API_KEY); });
        ProtocolException e = assertThrows(ProtocolException.class,
                () -> c.nodes().register(new NodesResource.RegisterOptions(throwing).challenge(nodeChallenge(WALLET, null, 1))));
        assertFalse(e.getMessage().contains(API_KEY));
        assertEquals(0, t.requests.size());
    }

    // ---- withdraw ----

    static String withdrawChallenge(String serverSigner, String message) {
        ObjectNode o = MockTransport.M.createObjectNode();
        o.put("nonce", NONCE);
        o.put("message", message);
        o.put("expiresAt", "x");
        o.put("signer", serverSigner);
        return o.toString();
    }

    @Test
    void withdrawFlow() {
        MockTransport t = new MockTransport();
        DominusNodeClient c = connected(t);
        Recorder rec = new Recorder();
        String msg = Messages.withdraw(UUID, WALLET, "2500000", "idem-key-77", NONCE);
        t.reply(200, withdrawChallenge(WALLET.toLowerCase(), msg));
        t.reply(200, "{\"payout\":{\"id\":\"p\",\"status\":\"pending\"},\"duplicate\":false}");
        JsonNode r = c.credits().withdraw(2_500_000L, rec.signer(WALLET), "idem-key-77");
        assertEquals("idem-key-77", r.get("idempotencyKey").asText());
        assertEquals(List.of(msg), rec.signed);
        assertEquals("{\"amountMusd\":\"2500000\",\"idempotencyKey\":\"idem-key-77\"}", t.requests.get(0).body);
        JsonNode b = MockTransport.json(t.requests.get(1));
        assertEquals("/v1/credits/withdraw", MockTransport.path(t.requests.get(1)));
        assertEquals("2500000", b.get("amountMusd").asText());
        assertEquals(NONCE, b.get("nonce").asText());
        assertEquals(SIG, b.get("signature").asText());
    }

    @Test
    void withdrawRefusals() {
        MockTransport t = new MockTransport();
        DominusNodeClient c = connected(t);
        Recorder rec = new Recorder();
        // message mismatch (amount differs)
        t.reply(200, withdrawChallenge(WALLET, Messages.withdraw(UUID, WALLET, "9999999", "idem-key-77", NONCE)));
        assertThrows(ProtocolException.class, () -> c.credits().withdraw("2500000", rec.signer(WALLET), "idem-key-77"));
        // server signer differs
        t.reply(200, withdrawChallenge(OLD, Messages.withdraw(UUID, WALLET, "2500000", "idem-key-77", NONCE)));
        assertThrows(ProtocolException.class, () -> c.credits().withdraw("2500000", rec.signer(WALLET), "idem-key-77"));
        // user line not a UUID
        t.reply(200, withdrawChallenge(WALLET, Messages.withdraw("not-a-uuid", WALLET, "2500000", "idem-key-77", NONCE)));
        assertThrows(ProtocolException.class, () -> c.credits().withdraw("2500000", rec.signer(WALLET), "idem-key-77"));
        assertTrue(rec.signed.isEmpty());
        assertEquals(3, t.requests.size());
    }

    // ---- payout wallet ----

    static String payoutChallenge(String message, boolean oldRequired, String oldAddress) {
        ObjectNode o = MockTransport.M.createObjectNode();
        o.put("nonce", NONCE);
        o.put("message", message);
        o.put("expiresAt", "x");
        o.put("signer", WALLET);
        o.put("oldWalletSignatureRequired", oldRequired);
        if (oldAddress == null) o.putNull("oldWalletAddress"); else o.put("oldWalletAddress", oldAddress);
        return o.toString();
    }

    @Test
    void payoutWalletFirstSet() {
        MockTransport t = new MockTransport();
        DominusNodeClient c = connected(t);
        Recorder rec = new Recorder();
        String msg = Messages.payoutWallet(UUID, WALLET, PAYOUT, "base", NONCE);
        t.reply(200, payoutChallenge(msg, false, null));
        t.reply(200, "{\"payoutWallet\":{\"address\":\"x\"},\"changed\":true,\"cooldownHours\":72}");
        c.payoutWallet().set(PAYOUT, rec.signer(WALLET));
        assertEquals(List.of(msg), rec.signed);
        assertEquals("{\"address\":\"" + PAYOUT.toLowerCase() + "\",\"chain\":\"base\"}", t.requests.get(0).body);
        assertEquals("PUT", t.requests.get(1).method);
        JsonNode b = MockTransport.json(t.requests.get(1));
        assertEquals(SIG, b.get("signature").asText());
        assertFalse(b.has("oldWalletSignature"));
    }

    @Test
    void payoutWalletChangeOldSignerSignsSameMessage() {
        MockTransport t = new MockTransport();
        DominusNodeClient c = connected(t);
        Recorder rec = new Recorder();
        Recorder old = new Recorder();
        old.sig = "0x" + "cd".repeat(65);
        String msg = Messages.payoutWallet(UUID, WALLET, PAYOUT, "base", NONCE);
        t.reply(200, payoutChallenge(msg, true, OLD));
        c.payoutWallet().set(PAYOUT, rec.signer(WALLET), "base", old.signer(OLD));
        assertEquals(List.of(msg), rec.signed);
        assertEquals(List.of(msg), old.signed);
        assertEquals(old.sig, MockTransport.json(t.last()).get("oldWalletSignature").asText());
    }

    @Test
    void payoutWalletRefusals() {
        MockTransport t = new MockTransport();
        DominusNodeClient c = connected(t);
        Recorder rec = new Recorder();
        Recorder old = new Recorder();
        String msg = Messages.payoutWallet(UUID, WALLET, PAYOUT, "base", NONCE);
        // old signer required but missing / wrong address -> ValidationException before signing
        t.reply(200, payoutChallenge(msg, true, OLD));
        assertThrows(ValidationException.class, () -> c.payoutWallet().set(PAYOUT, rec.signer(WALLET)));
        t.reply(200, payoutChallenge(msg, true, OLD));
        assertThrows(ValidationException.class, () -> c.payoutWallet().set(PAYOUT, rec.signer(WALLET), "base", old.signer(WALLET)));
        // message mismatch (different payout address in server text)
        t.reply(200, payoutChallenge(Messages.payoutWallet(UUID, WALLET, OLD, "base", NONCE), false, null));
        assertThrows(ProtocolException.class, () -> c.payoutWallet().set(PAYOUT, rec.signer(WALLET)));
        // server signer differs
        t.reply(200, payoutChallenge(msg, false, null).replace(WALLET, OLD));
        assertThrows(ProtocolException.class, () -> c.payoutWallet().set(PAYOUT, rec.signer(WALLET)));
        assertTrue(rec.signed.isEmpty());
        assertTrue(old.signed.isEmpty());
        assertThrows(ValidationException.class, () -> c.payoutWallet().set(PAYOUT, rec.signer(WALLET), "ethereum", null));
        assertThrows(ValidationException.class, () -> c.payoutWallet().set("0x123", rec.signer(WALLET)));
        assertEquals(4, t.requests.size());
    }

    // ---- wallet sign-in ----

    @Test
    void walletSignIn() {
        MockTransport t = new MockTransport();
        DominusNodeClient c = client(t);
        Recorder rec = new Recorder();
        String msg = "Sign in to DominusNode\nWallet: " + WALLET.toLowerCase() + "\nNonce: 1";
        t.reply(200, "{\"message\":" + MockTransport.M.valueToTree(msg) + ",\"nonce\":\"1\"}");
        t.reply(200, "{\"token\":\"" + JWT + "\",\"refreshToken\":\"" + REFRESH + "\"}");
        c.walletAuth().signIn(rec.signer(WALLET));
        assertEquals(List.of(msg), rec.signed);
        assertEquals("/api/auth/wallet/verify", MockTransport.path(t.last()));
        assertTrue(c.isConnected());

        Recorder rec2 = new Recorder();
        t.reply(200, "{\"message\":\"Sign in as " + OLD + "\"}");
        assertThrows(ProtocolException.class, () -> c.walletAuth().signIn(rec2.signer(WALLET)));
        assertTrue(rec2.signed.isEmpty());
    }
}
