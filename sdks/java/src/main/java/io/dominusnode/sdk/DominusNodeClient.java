package io.dominusnode.sdk;

import com.fasterxml.jackson.annotation.JsonValue;
import com.fasterxml.jackson.databind.JsonNode;
import io.dominusnode.sdk.errors.DominusNodeException;
import io.dominusnode.sdk.internal.ApiClient;
import io.dominusnode.sdk.internal.TokenManager;
import io.dominusnode.sdk.internal.Validation;
import io.dominusnode.sdk.resources.AgenticWalletResource;
import io.dominusnode.sdk.resources.AuthResource;
import io.dominusnode.sdk.resources.CreditsResource;
import io.dominusnode.sdk.resources.KeysResource;
import io.dominusnode.sdk.resources.NetworkResource;
import io.dominusnode.sdk.resources.NodesResource;
import io.dominusnode.sdk.resources.PayoutWalletResource;
import io.dominusnode.sdk.resources.PayoutsResource;
import io.dominusnode.sdk.resources.ProxyResource;
import io.dominusnode.sdk.resources.SessionsResource;
import io.dominusnode.sdk.resources.TeamsResource;
import io.dominusnode.sdk.resources.UsageResource;
import io.dominusnode.sdk.resources.WalletAuthResource;
import io.dominusnode.sdk.resources.WalletResource;
import io.dominusnode.sdk.resources.X402Resource;

import java.util.Arrays;

/**
 * DominusNode relay-network client for AI agents.
 *
 * <pre>{@code
 * try (DominusNodeClient dn = new DominusNodeClient()) {
 *     dn.connectWithKey(System.getenv("DOMINUSNODE_API_KEY"));
 *     FetchResponse r = dn.proxy().fetch("https://example.com", ProxyOptions.create().country("US"));
 * }
 * }</pre>
 */
public final class DominusNodeClient implements AutoCloseable {
    private final TokenManager tokens = new TokenManager();
    private final ApiClient http;
    private char[] apiKey;

    private final AuthResource auth;
    private final WalletAuthResource walletAuth;
    private final KeysResource keys;
    private final WalletResource wallet;
    private final AgenticWalletResource agenticWallets;
    private final TeamsResource teams;
    private final UsageResource usage;
    private final SessionsResource sessions;
    private final X402Resource x402;
    private final NetworkResource network;
    private final NodesResource nodes;
    private final CreditsResource credits;
    private final PayoutWalletResource payoutWallet;
    private final PayoutsResource payouts;
    private final ProxyResource proxy;

    /** Result of {@link #connectWithKey(String)}. */
    public static final class ConnectResult {
        /** True when the account has MFA on: no JWT was issued; /v1 agent routes and the proxy still work. */
        public final boolean mfaRequired;
        public final String userId;

        ConnectResult(boolean mfaRequired, String userId) {
            this.mfaRequired = mfaRequired;
            this.userId = userId;
        }

        @Override
        public String toString() { return "ConnectResult(mfaRequired=" + mfaRequired + ", userId=" + userId + ")"; }
    }

    public DominusNodeClient() { this(Config.defaults()); }

    public DominusNodeClient(Config config) {
        Config c = config == null ? Config.defaults() : config;
        Transport t = c.transport != null ? c.transport : new JdkTransport();
        this.http = new ApiClient(c.baseUrl == null ? Config.DEFAULT_BASE_URL : c.baseUrl, t, tokens, this::apiKeyValue);
        this.auth = new AuthResource(http);
        this.walletAuth = new WalletAuthResource(http, tokens);
        this.keys = new KeysResource(http);
        this.wallet = new WalletResource(http);
        this.agenticWallets = new AgenticWalletResource(http);
        this.teams = new TeamsResource(http);
        this.usage = new UsageResource(http);
        this.sessions = new SessionsResource(http);
        this.x402 = new X402Resource(http);
        this.network = new NetworkResource(http);
        this.nodes = new NodesResource(http);
        this.credits = new CreditsResource(http);
        this.payoutWallet = new PayoutWalletResource(http);
        this.payouts = new PayoutsResource(http);
        this.proxy = new ProxyResource(http, c.proxyHost == null ? Config.DEFAULT_PROXY_HOST : c.proxyHost,
                c.httpProxyPort, c.socks5ProxyPort, this::apiKeyValue, c.resolver, c.gatewayTls);
        // Never cleared: TokenManager.clear() keeps it so reconnecting works.
        tokens.setRefreshFunction(rt -> {
            JsonNode r = auth.refresh(rt);
            return new String[]{r.path("token").asText(null), r.path("refreshToken").asText(null)};
        });
        if (c.accessToken != null) tokens.setTokens(c.accessToken, c.refreshToken);
    }

    private synchronized String apiKeyValue() { return apiKey == null ? null : new String(apiKey); }

    private synchronized void setApiKey(String k) {
        wipeKey();
        apiKey = k == null ? null : k.toCharArray();
    }

    private synchronized void wipeKey() {
        if (apiKey != null) Arrays.fill(apiKey, '\0');
        apiKey = null;
    }

    /**
     * Authenticate with a dn_live_/dn_test_ key: POST /api/auth/verify-key. On MFA_REQUIRED only the key is
     * stored and {@code mfaRequired=true} is returned. Other errors propagate and nothing is stored.
     */
    public ConnectResult connectWithKey(String key) {
        Validation.apiKey(key);
        try {
            JsonNode r = auth.verifyKey(key);
            setApiKey(key);
            tokens.setTokens(r.path("token").asText(null), r.path("refreshToken").asText(null));
            return new ConnectResult(false, r.path("userId").asText(null));
        } catch (DominusNodeException e) {
            if ("MFA_REQUIRED".equals(e.getCode())) {
                setApiKey(key);
                return new ConnectResult(true, null);
            }
            throw e;
        }
    }

    /** True when an API key or any token is held. */
    public boolean isConnected() { return apiKeyValue() != null || tokens.hasTokens(); }

    /** Best-effort logout when a JWT is held, then wipe the API key, access token and refresh token. */
    public void disconnect() {
        if (tokens.hasTokens()) {
            try {
                auth.logout();
            } catch (RuntimeException ignored) {
                // best effort
            }
        }
        wipeKey();
        tokens.clear();
    }

    @Override
    public void close() { disconnect(); }

    public AuthResource auth() { return auth; }

    public WalletAuthResource walletAuth() { return walletAuth; }

    public KeysResource keys() { return keys; }

    public WalletResource wallet() { return wallet; }

    public AgenticWalletResource agenticWallets() { return agenticWallets; }

    public TeamsResource teams() { return teams; }

    public UsageResource usage() { return usage; }

    public SessionsResource sessions() { return sessions; }

    public X402Resource x402() { return x402; }

    public NetworkResource network() { return network; }

    public NodesResource nodes() { return nodes; }

    public CreditsResource credits() { return credits; }

    public PayoutWalletResource payoutWallet() { return payoutWallet; }

    public PayoutsResource payouts() { return payouts; }

    public ProxyResource proxy() { return proxy; }

    /** Test hook: replace the 429 back-off sleep. */
    void setSleeper(ApiClient.Sleeper s) { http.setSleeper(s); }

    TokenManager tokenManager() { return tokens; }

    @JsonValue
    @Override
    public String toString() { return "DominusNodeClient(connected=" + isConnected() + ")"; }
}
