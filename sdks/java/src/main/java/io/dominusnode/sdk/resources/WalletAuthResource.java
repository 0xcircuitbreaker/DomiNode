package io.dominusnode.sdk.resources;

import io.dominusnode.sdk.errors.DominusNodeException;
import io.dominusnode.sdk.errors.ValidationException;
import io.dominusnode.sdk.internal.HttpClient;
import io.dominusnode.sdk.internal.TokenManager;
import io.dominusnode.sdk.types.WalletChallenge;
import io.dominusnode.sdk.types.WalletLinkResult;
import io.dominusnode.sdk.types.WalletVerifyResult;

import java.util.HashMap;
import java.util.Map;
import java.util.regex.Pattern;

/**
 * Wallet-based authentication using EIP-191 signed messages.
 *
 * <p>Allows Ethereum wallet holders to authenticate by signing a server-issued
 * challenge message. Supports account creation, login, and linking a wallet
 * to an existing account.</p>
 */
public final class WalletAuthResource {

    private static final Pattern ETH_ADDRESS_RE = Pattern.compile("^0x[0-9a-fA-F]{40}$");
    // EIP-191 signature format: 0x prefix + 130 hex chars (65 bytes)
    private static final Pattern EIP191_SIGNATURE_RE = Pattern.compile("^0x[0-9a-fA-F]{130}$");
    private static final int MAX_SIGNATURE_LENGTH = 200;

    private final HttpClient http;
    private final TokenManager tokenManager;

    public WalletAuthResource(HttpClient http, TokenManager tokenManager) {
        this.http = http;
        this.tokenManager = tokenManager;
    }

    /**
     * Request a signature challenge for the given Ethereum address.
     *
     * <p>The returned challenge must be signed with the wallet's private key
     * and submitted via {@link #verify} to complete authentication.</p>
     *
     * <p>This endpoint does not require authentication.</p>
     *
     * @param address Ethereum address (0x-prefixed, 40 hex chars)
     * @return challenge to sign
     * @throws DominusNodeException on API errors
     */
    public WalletChallenge challenge(String address) throws DominusNodeException {
        validateAddress(address);
        return http.post("/api/auth/wallet/challenge",
                Map.of("address", address),
                WalletChallenge.class, false);
    }

    /**
     * Submit a signed challenge to create an account or log in.
     *
     * <p>If the address is not yet associated with an account, a new one is created.
     * Returns JWT tokens and user information on success. Tokens are automatically
     * stored for subsequent authenticated requests.</p>
     *
     * <p>This endpoint does not require authentication.</p>
     *
     * @param address   Ethereum address
     * @param signature EIP-191 signature of the challenge
     * @return verify result with tokens and user
     * @throws DominusNodeException on API errors
     */
    public WalletVerifyResult verify(String address, String signature) throws DominusNodeException {
        return verify(address, signature, null);
    }

    /**
     * Submit a signed challenge to create an account or log in.
     *
     * <p>If the address is not yet associated with an account, a new one is created.
     * Returns JWT tokens and user information on success. Tokens are automatically
     * stored for subsequent authenticated requests.</p>
     *
     * <p>This endpoint does not require authentication.</p>
     *
     * @param address   Ethereum address
     * @param signature EIP-191 signature of the challenge
     * @param challenge optional challenge string (server looks up internally)
     * @return verify result with tokens and user
     * @throws DominusNodeException on API errors
     */
    public WalletVerifyResult verify(String address, String signature, String challenge) throws DominusNodeException {
        validateAddress(address);
        validateSignature(signature);
        Map<String, String> body = new HashMap<>();
        body.put("address", address);
        body.put("signature", signature);
        if (challenge != null && !challenge.isEmpty()) {
            body.put("challenge", challenge);
        }
        WalletVerifyResult result = http.post("/api/auth/wallet/verify",
                body, WalletVerifyResult.class, false);
        // Detect MFA-required response — don't store tokens, surface to caller
        if (result.isMfaRequired()) {
            return result;
        }
        if (result.getToken() != null && result.getRefreshToken() != null) {
            tokenManager.setTokens(result.getToken(), result.getRefreshToken());
        }
        return result;
    }

    /**
     * Link an Ethereum wallet to the currently authenticated account.
     *
     * <p>Requires JWT authentication.</p>
     *
     * @param address   Ethereum address
     * @param signature EIP-191 signature of the challenge
     * @return link result
     * @throws DominusNodeException on API errors
     */
    public WalletLinkResult link(String address, String signature) throws DominusNodeException {
        return link(address, signature, null);
    }

    /**
     * Link an Ethereum wallet to the currently authenticated account.
     *
     * <p>Requires JWT authentication.</p>
     *
     * @param address   Ethereum address
     * @param signature EIP-191 signature of the challenge
     * @param challenge optional challenge string (server looks up internally)
     * @return link result
     * @throws DominusNodeException on API errors
     */
    public WalletLinkResult link(String address, String signature, String challenge) throws DominusNodeException {
        validateAddress(address);
        validateSignature(signature);
        Map<String, String> body = new HashMap<>();
        body.put("address", address);
        body.put("signature", signature);
        if (challenge != null && !challenge.isEmpty()) {
            body.put("challenge", challenge);
        }
        return http.post("/api/auth/wallet/link",
                body, WalletLinkResult.class);
    }

    private static void validateAddress(String address) throws ValidationException {
        if (address == null || address.isEmpty()) {
            throw new ValidationException("address is required");
        }
        if (!ETH_ADDRESS_RE.matcher(address).matches()) {
            throw new ValidationException(
                    "address must be a valid Ethereum address (0x followed by 40 hex characters)");
        }
    }

    // Validate EIP-191 signature format
    private static void validateSignature(String signature) throws ValidationException {
        if (signature == null || signature.isEmpty()) {
            throw new ValidationException("signature is required and must be a non-empty string");
        }
        // Max length check
        if (signature.length() > MAX_SIGNATURE_LENGTH) {
            throw new ValidationException("signature must not exceed " + MAX_SIGNATURE_LENGTH + " characters");
        }
        // EIP-191 format validation
        if (!EIP191_SIGNATURE_RE.matcher(signature).matches()) {
            throw new ValidationException(
                    "signature must be a valid EIP-191 signature (0x followed by 130 hex characters)");
        }
    }
}
