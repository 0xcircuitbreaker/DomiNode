package io.dominusnode.sdk;

import io.dominusnode.sdk.errors.DominusNodeException;
import io.dominusnode.sdk.errors.UncheckedDominusNodeException;
import io.dominusnode.sdk.internal.HttpClient;
import io.dominusnode.sdk.internal.TokenManager;
import io.dominusnode.sdk.resources.*;
import io.dominusnode.sdk.types.LoginResult;
import io.dominusnode.sdk.types.TokenPair;

/**
 * Main entry point for the Dominus Node Java SDK.
 *
 * <p>The client manages authentication, token refresh, and provides access to all
 * API resource modules via accessor methods. It implements {@link AutoCloseable}
 * for use with try-with-resources.</p>
 *
 * <h3>Quick Start with API Key</h3>
 * <pre>{@code
 * try (DominusNodeClient client = new DominusNodeClient(Config.builder()
 *         .baseUrl("http://localhost:3000")
 *         .build())) {
 *     client.connectWithKey("dn_live_abc123");
 *     Wallet balance = client.wallet().getBalance();
 *     System.out.println("Balance: " + balance.getBalanceCents() + " cents");
 * }
 * }</pre>
 *
 * <h3>Login with Credentials and MFA</h3>
 * <pre>{@code
 * try (DominusNodeClient client = new DominusNodeClient(Config.builder()
 *         .baseUrl("http://localhost:3000")
 *         .build())) {
 *     LoginResult result = client.connectWithCredentials("user@example.com", "password123");
 *     if (result.isMfaRequired()) {
 *         client.completeMfa("123456");
 *     }
 *     // Now authenticated
 * }
 * }</pre>
 */
public final class DominusNodeClient implements AutoCloseable {

    private final AuthResource auth;
    private final KeysResource keys;
    private final WalletResource wallet;
    private final UsageResource usage;
    private final PlansResource plans;
    private final SessionsResource sessions;
    private final ProxyResource proxy;
    private final AdminResource admin;
    private final SlotsResource slots;
    private final AgenticWalletResource agenticWallets;
    private final TeamsResource teams;

    private final TokenManager tokenManager;
    private volatile String apiKey;

    /**
     * Create a new Dominus Node client with the given configuration.
     *
     * <p>If the config includes an API key, email/password, or pre-existing tokens,
     * the client will auto-authenticate. When using API key or credentials auto-connect,
     * note that a {@link DominusNodeException} may be thrown if the server rejects them.</p>
     *
     * @param config the client configuration
     * @throws DominusNodeException if auto-authentication fails
     */
    public DominusNodeClient(Config config) throws DominusNodeException {
        this.tokenManager = new TokenManager();
        HttpClient http = new HttpClient(config.getBaseUrl(), tokenManager, config.getTimeout());

        // Initialize resource modules
        this.auth = new AuthResource(http, tokenManager);
        this.keys = new KeysResource(http);
        this.wallet = new WalletResource(http);
        this.usage = new UsageResource(http);
        this.plans = new PlansResource(http);
        this.sessions = new SessionsResource(http);
        this.proxy = new ProxyResource(http, config.getProxyHost(),
                config.getHttpProxyPort(), config.getSocks5ProxyPort(),
                () -> this.apiKey);
        this.admin = new AdminResource(http);
        this.slots = new SlotsResource(http);
        this.agenticWallets = new AgenticWalletResource(http);
        this.teams = new TeamsResource(http);

        // Wire up the token refresh function
        // R15 H-7: Use UncheckedDominusNodeException to preserve the original exception type
        // so callers can catch and inspect the cause without losing the typed error
        tokenManager.setRefreshFunction(rt -> {
            try {
                TokenPair pair = auth.refresh(rt);
                return new String[] { pair.getToken(), pair.getRefreshToken() };
            } catch (DominusNodeException e) {
                throw new UncheckedDominusNodeException(e);
            }
        });

        // Auto-authenticate if tokens were provided
        if (config.getAccessToken() != null) {
            tokenManager.setTokens(config.getAccessToken(), config.getRefreshToken());
        }

        // Auto-connect if credentials provided
        if (config.getApiKey() != null) {
            connectWithKey(config.getApiKey());
        } else if (config.getEmail() != null && config.getPassword() != null) {
            connectWithCredentials(config.getEmail(), config.getPassword());
        }
    }

    // ── Resource accessors ─────────────────────────────────────────────

    /** Authentication operations (register, login, MFA, etc.). */
    public AuthResource auth() { return auth; }

    /** API key management. */
    public KeysResource keys() { return keys; }

    /** Wallet operations (balance, transactions, top-ups). */
    public WalletResource wallet() { return wallet; }

    /** Usage statistics and data export. */
    public UsageResource usage() { return usage; }

    /** Plan management. */
    public PlansResource plans() { return plans; }

    /** Active proxy sessions. */
    public SessionsResource sessions() { return sessions; }

    /** Proxy operations (URL building, health, status, config). */
    public ProxyResource proxy() { return proxy; }

    /** Admin operations (requires admin privileges). */
    public AdminResource admin() { return admin; }

    /** Slot availability and waitlist operations (public, no auth required). */
    public SlotsResource slots() { return slots; }

    /** Agentic wallet operations (sub-wallets with spending limits). */
    public AgenticWalletResource agenticWallets() { return agenticWallets; }

    /** Team operations (shared wallets, members, invites, keys). */
    public TeamsResource teams() { return teams; }

    // ── Connection methods ─────────────────────────────────────────────

    /**
     * Authenticate with an API key.
     *
     * <p>Verifies the key against the server and stores the resulting JWT tokens
     * for subsequent authenticated requests.</p>
     *
     * @param apiKey the API key to authenticate with
     * @throws DominusNodeException if the key is invalid or the server is unreachable
     */
    public void connectWithKey(String apiKey) throws DominusNodeException {
        this.apiKey = apiKey;
        auth.verifyKey(apiKey);
    }

    /**
     * Authenticate with email and password.
     *
     * <p>If MFA is enabled on the account, the returned result will have
     * {@code mfaRequired=true}. Call {@link #completeMfa(String)} to finish.</p>
     *
     * @param email    the user's email address
     * @param password the user's password
     * @return login result (check {@code isMfaRequired()})
     * @throws DominusNodeException on authentication failure
     */
    public LoginResult connectWithCredentials(String email, String password) throws DominusNodeException {
        return auth.login(email, password);
    }

    /**
     * Complete MFA verification with a 6-digit TOTP code.
     *
     * @param code the TOTP code from the authenticator app
     * @throws DominusNodeException on MFA verification failure
     */
    public void completeMfa(String code) throws DominusNodeException {
        auth.verifyMfa(code);
    }

    /**
     * Complete MFA verification with full options.
     *
     * @param code           the TOTP or backup code
     * @param challengeToken the MFA challenge token (may be {@code null})
     * @param isBackupCode   whether the code is a backup code
     * @throws DominusNodeException on MFA verification failure
     */
    public void completeMfa(String code, String challengeToken, boolean isBackupCode) throws DominusNodeException {
        auth.verifyMfa(code, challengeToken, isBackupCode);
    }

    /**
     * Disconnect and clear all stored tokens.
     *
     * <p>Attempts server-side logout first to revoke refresh tokens,
     * then clears local state regardless of the server response.</p>
     */
    public void disconnect() {
        try {
            auth.logout();
        } catch (Exception ignored) {
            // Best-effort logout
        }
        tokenManager.clear();
        this.apiKey = null;
    }

    /**
     * Close the client, disconnecting and clearing tokens.
     *
     * <p>Implements {@link AutoCloseable} for try-with-resources usage.</p>
     */
    @Override
    public void close() {
        disconnect();
    }
}
