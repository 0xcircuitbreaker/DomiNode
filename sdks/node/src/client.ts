import { TokenManager } from "./token-manager.js";
import { HttpClient } from "./http.js";
import { AuthResource, validateApiKey } from "./resources/auth.js";
import { WalletAuthResource } from "./resources/wallet-auth.js";
import { KeysResource } from "./resources/keys.js";
import { WalletResource } from "./resources/wallet.js";
import { AgenticWalletResource } from "./resources/agent-wallet.js";
import { TeamsResource } from "./resources/teams.js";
import { UsageResource } from "./resources/usage.js";
import { SessionsResource } from "./resources/sessions.js";
import { X402Resource } from "./resources/x402.js";
import { NetworkResource } from "./resources/network.js";
import { NodesResource } from "./resources/nodes.js";
import { CreditsResource, PayoutsResource } from "./resources/credits.js";
import { PayoutWalletResource } from "./resources/payout-wallet.js";
import { ProxyResource } from "./resources/proxy.js";
import { DEFAULT_BASE_URL } from "./constants.js";
import { DominusNodeError } from "./errors.js";
import { inspectSymbol } from "./secret.js";
import type { DominusNodeConfig, ConnectResult } from "./types.js";

/**
 * DominusNode relay-network client for AI agents.
 *
 *   const dn = new DominusNodeClient();
 *   await dn.connectWithKey(process.env.DOMINUSNODE_API_KEY!);
 *   const res = await dn.proxy.fetch("https://example.com", { country: "US" });
 */
export class DominusNodeClient {
  public readonly auth: AuthResource;
  public readonly walletAuth: WalletAuthResource;
  public readonly keys: KeysResource;
  public readonly wallet: WalletResource;
  public readonly agenticWallets: AgenticWalletResource;
  public readonly teams: TeamsResource;
  public readonly usage: UsageResource;
  public readonly sessions: SessionsResource;
  public readonly x402: X402Resource;
  public readonly network: NetworkResource;
  public readonly nodes: NodesResource;
  public readonly credits: CreditsResource;
  public readonly payoutWallet: PayoutWalletResource;
  public readonly payouts: PayoutsResource;
  public readonly proxy: ProxyResource;

  readonly #tokens: TokenManager;
  #apiKey: string | null = null;

  constructor(config: DominusNodeConfig = {}) {
    this.#tokens = new TokenManager();
    const http = new HttpClient(config.baseUrl ?? DEFAULT_BASE_URL, { tokens: this.#tokens, apiKey: () => this.#apiKey }, config.fetch);

    this.auth = new AuthResource(http);
    this.walletAuth = new WalletAuthResource(http, this.#tokens);
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
    this.proxy = new ProxyResource(http, config, () => this.#apiKey);

    // Set after auth exists. Never cleared (TokenManager.clear() keeps it).
    this.#tokens.setRefreshFunction(async (rt) => {
      const r = await this.auth.refresh(rt);
      return { accessToken: r.token, refreshToken: r.refreshToken };
    });
    if (config.accessToken) this.#tokens.setTokens(config.accessToken, config.refreshToken);
  }

  /**
   * Authenticate with a dn_live_/dn_test_ API key. The key is kept for /v1 agent routes and the
   * proxy; a JWT pair from /api/auth/verify-key is stored for /api routes. If the account has MFA
   * on, verify-key refuses: returns { mfaRequired: true } and only key-auth routes work.
   */
  async connectWithKey(apiKey: string): Promise<ConnectResult> {
    validateApiKey(apiKey);
    try {
      const r = await this.auth.verifyKey(apiKey);
      this.#apiKey = apiKey;
      this.#tokens.setTokens(r.token, r.refreshToken);
      return { mfaRequired: false, userId: r.userId };
    } catch (err) {
      if (err instanceof DominusNodeError && err.code === "MFA_REQUIRED") {
        this.#apiKey = apiKey;
        return { mfaRequired: true };
      }
      throw err;
    }
  }

  /** True when an API key or JWT is held. */
  get isConnected(): boolean {
    return this.#apiKey !== null || this.#tokens.hasTokens();
  }

  /** Revoke refresh tokens (best effort) and clear EVERY credential: API key, access and refresh token. */
  async disconnect(): Promise<void> {
    if (this.#tokens.hasTokens()) {
      try { await this.auth.logout(); } catch { /* best effort */ }
    }
    this.#apiKey = null;
    this.#tokens.clear();
  }

  toString(): string { return `DominusNodeClient(connected=${this.isConnected})`; }
  toJSON(): Record<string, unknown> { return { connected: this.isConnected }; }
  [inspectSymbol](): string { return this.toString(); }
}
