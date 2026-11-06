package io.dominusnode.sdk;

import io.dominusnode.sdk.errors.ProtocolException;
import org.junit.jupiter.api.Test;

import java.nio.charset.StandardCharsets;
import java.util.Base64;

import static org.junit.jupiter.api.Assertions.*;

/**
 * Byte-for-byte fixtures generated from the Node SDK builders (sdks/node/src/messages.ts, which mirror
 * packages/shared/src/attestation.ts and routes/v1/credits.ts). Values are base64 of the UTF-8 bytes.
 */
class MessagesTest {
    static final String WALLET = "0xAbCdEf0123456789aBcDeF0123456789AbCdEf01";
    static final String USER = "11111111-2222-4333-8444-555555555555";

    static void same(String b64, String actual) {
        assertArrayEquals(Base64.getDecoder().decode(b64), actual.getBytes(StandardCharsets.UTF_8));
    }

    @Test
    void attestationWithPubkey() {
        same("RG9taU5vZGUgbm9kZSBhdHRlc3RhdGlvbgpWZXJzaW9uOiAzCldhbGxldDogMHhhYmNkZWYwMTIzNDU2Nzg5YWJjZGVmMDEyMzQ1Njc4OWFiY2RlZjAxCk5vbmNlOiBhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhCk5vZGUgcHVia2V5OiAwZjBmMGYwZjBmMGYwZjBmMGYwZjBmMGYwZjBmMGYwZjBmMGYwZjBmMGYwZjBmMGYwZjBmMGYwZjBmMGYwZjBmCgpJIHJ1biBhIHJlbGF5IG5vZGUuCkxpbmUgdHdvOiDDvG7Dr2PDtmTDqSDinJM=",
                Messages.attestation(WALLET, "a".repeat(64), 3, "I run a relay node.\nLine two: ünïcödé ✓", "0f".repeat(32)));
    }

    @Test
    void attestationWithoutPubkey() {
        same("RG9taU5vZGUgbm9kZSBhdHRlc3RhdGlvbgpWZXJzaW9uOiAxCldhbGxldDogMHhhYmNkZWYwMTIzNDU2Nzg5YWJjZGVmMDEyMzQ1Njc4OWFiY2RlZjAxCk5vbmNlOiBiYmJiYmJiYmJiYmJiYmJiYmJiYmJiYmJiYmJiYmJiYmJiYmJiYmJiYmJiYmJiYmJiYmJiYmJiYmJiYmJiYmJiCk5vZGUgcHVia2V5OiBub25lCgp0ZXh0",
                Messages.attestation(WALLET, "b".repeat(64), 1, "text", null));
    }

    @Test
    void payoutWallet() {
        same("RG9taW51c05vZGUgcGF5b3V0IHdhbGxldApBY3Rpb246IHBheW91dF93YWxsZXRfc2V0ClVzZXI6IDExMTExMTExLTIyMjItNDMzMy04NDQ0LTU1NTU1NTU1NTU1NQpBY2NvdW50IHdhbGxldDogMHhhYmNkZWYwMTIzNDU2Nzg5YWJjZGVmMDEyMzQ1Njc4OWFiY2RlZjAxClBheW91dCBhZGRyZXNzOiAweDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwZGVhZGJlZWYKQ2hhaW46IGJhc2UKTm9uY2U6IGNjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2M=",
                Messages.payoutWallet(USER, WALLET, "0x00000000000000000000000000000000DeAdBeEf", "base", "c".repeat(64)));
    }

    @Test
    void withdraw() {
        same("RG9taW51c05vZGUgd2l0aGRyYXdhbApBY3Rpb246IHdpdGhkcmF3ClVzZXI6IDExMTExMTExLTIyMjItNDMzMy04NDQ0LTU1NTU1NTU1NTU1NQpBY2NvdW50IHdhbGxldDogMHhhYmNkZWYwMTIzNDU2Nzg5YWJjZGVmMDEyMzQ1Njc4OWFiY2RlZjAxCkFtb3VudCAowrVVU0QpOiAxMjM0NTY3CklkZW1wb3RlbmN5IGtleTogZG4ta2V5XzEyMzQ1Ck5vbmNlOiBkZGRkZGRkZGRkZGRkZGRkZGRkZGRkZGRkZGRkZGRkZGRkZGRkZGRkZGRkZGRkZGRkZGRkZGRkZGRkZGRkZGRk",
                Messages.withdraw(USER, WALLET, "1234567", "dn-key_12345", "d".repeat(64)));
    }

    @Test
    void extractUserId() {
        assertEquals(USER, Messages.extractUserId(Messages.withdraw(USER, WALLET, "1", "k", "n")));
        assertThrows(ProtocolException.class, () -> Messages.extractUserId("a\nb\nUser: x"));
        assertThrows(ProtocolException.class, () -> Messages.extractUserId("one line"));
        assertThrows(ProtocolException.class, () -> Messages.extractUserId(null));
    }

    @Test
    void assertSame() {
        Messages.assertSame("x", "x", "t");
        assertThrows(ProtocolException.class, () -> Messages.assertSame("x\n", "x", "t"));
        assertThrows(ProtocolException.class, () -> Messages.assertSame(null, "x", "t"));
    }
}
