package io.dominusnode.sdk.resources;

import io.dominusnode.sdk.errors.DominusNodeException;
import io.dominusnode.sdk.internal.HttpClient;
import io.dominusnode.sdk.internal.TokenManager;
import io.dominusnode.sdk.types.LoginResult;
import io.dominusnode.sdk.types.MfaSetup;
import io.dominusnode.sdk.types.MfaStatus;
import io.dominusnode.sdk.types.TokenPair;
import io.dominusnode.sdk.types.User;

import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.util.HashMap;
import java.util.Map;

/**
 * Authentication operations: register, login, MFA, token refresh, and account management.
 */
public final class AuthResource {

    private static final long POW_MAX_NONCE = 100_000_000L;

    private final HttpClient http;
    private final TokenManager tokenManager;

    /**
     * @param http         the HTTP client
     * @param tokenManager the token manager for storing resulting tokens
     */
    public AuthResource(HttpClient http, TokenManager tokenManager) {
        this.http = http;
        this.tokenManager = tokenManager;
    }

    private static int countLeadingZeroBits(byte[] hash) {
        int count = 0;
        for (byte b : hash) {
            int unsigned = b & 0xFF;
            if (unsigned == 0) {
                count += 8;
            } else {
                int mask = 0x80;
                while (mask != 0 && (unsigned & mask) == 0) {
                    count++;
                    mask >>= 1;
                }
                break;
            }
        }
        return count;
    }

    @SuppressWarnings("unchecked")
    private Map<String, Object> solvePoW() {
        try {
            Map<String, Object> challenge = http.post(
                    "/api/auth/pow/challenge", new HashMap<>(), Map.class, false);
            String challengeId = (String) challenge.get("challengeId");
            String prefix = (String) challenge.get("prefix");
            int difficulty = ((Number) challenge.get("difficulty")).intValue();

            MessageDigest md = MessageDigest.getInstance("SHA-256");

            for (long nonce = 0; nonce < POW_MAX_NONCE; nonce++) {
                md.reset();
                byte[] hash = md.digest((prefix + nonce).getBytes(StandardCharsets.UTF_8));
                if (countLeadingZeroBits(hash) >= difficulty) {
                    Map<String, Object> solution = new HashMap<>();
                    solution.put("challengeId", challengeId);
                    solution.put("nonce", nonce);
                    return solution;
                }
            }
            return null;
        } catch (DominusNodeException | NoSuchAlgorithmException e) {
            return null;
        }
    }

    /**
     * Register a new user account.
     *
     * <p>Automatically solves a Proof-of-Work challenge so SDKs can register
     * without reCAPTCHA.</p>
     *
     * @param email    the user's email address
     * @param password the user's password
     * @return login result containing the new user and authentication tokens
     * @throws DominusNodeException on API errors
     */
    public LoginResult register(String email, String password) throws DominusNodeException {
        Map<String, Object> body = new HashMap<>();
        body.put("email", email);
        body.put("password", password);
        Map<String, Object> pow = solvePoW();
        if (pow != null) {
            body.put("pow", pow);
        }
        LoginResult result = http.post("/api/auth/register", body, LoginResult.class, false);
        if (result.getToken() != null) {
            tokenManager.setTokens(result.getToken(), result.getRefreshToken());
        }
        return result;
    }

    /**
     * Log in with email and password.
     *
     * <p>If MFA is enabled on the account, the result will have
     * {@code mfaRequired=true} and the caller must invoke {@link #verifyMfa}
     * to complete authentication.</p>
     *
     * @param email    the user's email address
     * @param password the user's password
     * @return login result (check {@code isMfaRequired()})
     * @throws DominusNodeException on API errors
     */
    public LoginResult login(String email, String password) throws DominusNodeException {
        Map<String, Object> body = new HashMap<>();
        body.put("email", email);
        body.put("password", password);
        LoginResult result = http.post("/api/auth/login", body, LoginResult.class, false);
        if (result.getToken() != null) {
            tokenManager.setTokens(result.getToken(), result.getRefreshToken());
        }
        return result;
    }

    /**
     * Complete MFA verification with a TOTP code.
     *
     * @param code the 6-digit TOTP code
     * @return login result with tokens
     * @throws DominusNodeException on API errors
     */
    public LoginResult verifyMfa(String code) throws DominusNodeException {
        return verifyMfa(code, null, false);
    }

    /**
     * Complete MFA verification with a TOTP code or backup code.
     *
     * @param code              the TOTP code or backup code
     * @param challengeToken    the MFA challenge token from the login response (may be {@code null})
     * @param isBackupCode      whether the code is a backup code
     * @return login result with tokens
     * @throws DominusNodeException on API errors
     */
    public LoginResult verifyMfa(String code, String challengeToken, boolean isBackupCode) throws DominusNodeException {
        Map<String, Object> body = new HashMap<>();
        body.put("code", code);
        if (challengeToken != null) {
            body.put("mfaChallengeToken", challengeToken);
        }
        if (isBackupCode) {
            body.put("isBackupCode", true);
        }
        LoginResult result = http.post("/api/auth/mfa/verify", body, LoginResult.class, false);
        if (result.getToken() != null) {
            tokenManager.setTokens(result.getToken(), result.getRefreshToken());
        }
        return result;
    }

    /**
     * Verify an API key and obtain JWT tokens.
     *
     * @param apiKey the API key to verify
     * @return login result with tokens
     * @throws DominusNodeException on API errors
     */
    public LoginResult verifyKey(String apiKey) throws DominusNodeException {
        Map<String, Object> body = new HashMap<>();
        body.put("apiKey", apiKey);
        LoginResult result = http.post("/api/auth/verify-key", body, LoginResult.class, false);
        if (result.getToken() != null) {
            tokenManager.setTokens(result.getToken(), result.getRefreshToken());
        }
        return result;
    }

    /**
     * Refresh the access token using a refresh token.
     *
     * @param refreshToken the refresh token
     * @return new token pair
     * @throws DominusNodeException on API errors
     */
    public TokenPair refresh(String refreshToken) throws DominusNodeException {
        Map<String, Object> body = new HashMap<>();
        body.put("refreshToken", refreshToken);
        TokenPair result = http.post("/api/auth/refresh", body, TokenPair.class, false);
        if (result.getToken() != null) {
            tokenManager.setTokens(result.getToken(), result.getRefreshToken());
        }
        return result;
    }

    /**
     * Log out and invalidate the current refresh token server-side.
     *
     * @throws DominusNodeException on API errors
     */
    public void logout() throws DominusNodeException {
        http.postVoid("/api/auth/logout", new HashMap<>(), true);
    }

    /**
     * Get the currently authenticated user's profile.
     *
     * @return the user object
     * @throws DominusNodeException on API errors
     */
    public User me() throws DominusNodeException {
        // Server returns { user: User }
        Map<?, ?> raw = http.get("/api/auth/me", Map.class);
        String json = io.dominusnode.sdk.internal.JsonUtil.toJson(raw.get("user"));
        return io.dominusnode.sdk.internal.JsonUtil.fromJson(json, User.class);
    }

    /**
     * Change the authenticated user's password.
     *
     * @param currentPassword the current password
     * @param newPassword     the new password
     * @throws DominusNodeException on API errors
     */
    public void changePassword(String currentPassword, String newPassword) throws DominusNodeException {
        Map<String, Object> body = new HashMap<>();
        body.put("currentPassword", currentPassword);
        body.put("newPassword", newPassword);
        http.postVoid("/api/auth/change-password", body, true);
    }

    /**
     * Initiate MFA setup. Returns the TOTP secret, otpauth URI, and backup codes.
     *
     * @return MFA setup information
     * @throws DominusNodeException on API errors
     */
    public MfaSetup mfaSetup() throws DominusNodeException {
        return http.post("/api/auth/mfa/setup", new HashMap<>(), MfaSetup.class);
    }

    /**
     * Enable MFA after verifying the initial TOTP code.
     *
     * @param code the 6-digit TOTP code from the authenticator app
     * @throws DominusNodeException on API errors
     */
    public void mfaEnable(String code) throws DominusNodeException {
        Map<String, Object> body = new HashMap<>();
        body.put("code", code);
        http.postVoid("/api/auth/mfa/enable", body, true);
    }

    /**
     * Disable MFA on the account.
     *
     * @param password the account password for verification
     * @param code     a valid TOTP code
     * @throws DominusNodeException on API errors
     */
    public void mfaDisable(String password, String code) throws DominusNodeException {
        Map<String, Object> body = new HashMap<>();
        body.put("password", password);
        body.put("code", code);
        http.postVoid("/api/auth/mfa/disable", body, true);
    }

    /**
     * Get the current MFA status for the authenticated user.
     *
     * @return MFA status with enabled flag and remaining backup codes
     * @throws DominusNodeException on API errors
     */
    public MfaStatus mfaStatus() throws DominusNodeException {
        return http.get("/api/auth/mfa/status", MfaStatus.class);
    }
}
