package io.dominusnode.sdk.internal;

import io.dominusnode.sdk.errors.ProtocolException;

import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;

/** Node-registration proof of work. Internal. */
public final class Pow {
    private Pow() {}

    public static int leadingZeroBits(byte[] h) {
        int bits = 0;
        for (byte b : h) {
            int v = b & 0xff;
            if (v == 0) { bits += 8; continue; }
            return bits + Integer.numberOfLeadingZeros(v) - 24;
        }
        return bits;
    }

    public static byte[] sha256(String s) {
        try {
            return MessageDigest.getInstance("SHA-256").digest(s.getBytes(StandardCharsets.UTF_8));
        } catch (NoSuchAlgorithmException e) {
            throw new IllegalStateException(e);
        }
    }

    /** Smallest n >= 0 with sha256(prefix + n) having >= difficulty leading zero bits. */
    public static String solve(String prefix, int difficulty, long maxIterations) {
        if (prefix == null || prefix.isEmpty() || prefix.length() > 256) throw new ProtocolException("invalid PoW prefix");
        if (difficulty < 1 || difficulty > 32) throw new ProtocolException("invalid PoW difficulty");
        MessageDigest md;
        try { md = MessageDigest.getInstance("SHA-256"); } catch (NoSuchAlgorithmException e) { throw new IllegalStateException(e); }
        for (long n = 0; n < maxIterations; n++) {
            String s = Long.toString(n);
            if (leadingZeroBits(md.digest((prefix + s).getBytes(StandardCharsets.UTF_8))) >= difficulty) return s;
        }
        throw new ProtocolException("PoW not solved within iteration cap");
    }
}
