import { TokenManager } from "./token-manager.js";
import { HttpClient } from "./http.js";
import { AuthResource } from "./auth.js";
import { KeysResource } from "./keys.js";
import { WalletResource } from "./wallet.js";
import { UsageResource } from "./usage.js";
import { PlansResource } from "./plans.js";
import { SessionsResource } from "./sessions.js";
import { ProxyResource } from "./proxy.js";
import { AdminResource } from "./admin.js";
import { SlotsResource } from "./slots.js";
import { AgenticWalletResource } from "./resources/agent-wallet.js";
import { TeamsResource } from "./resources/teams.js";
import { X402Resource } from "./resources/x402.js";
import { WalletAuthResource } from "./resources/wallet-auth.js";
import { DEFAULT_BASE_URL } from "./constants.js";
import type { DominusNodeConfig, LoginResult } from "./types.js";

export class DominusNodeClient {
  public readonly auth: AuthResource;
  public readonly keys: KeysResource;
  public readonly wallet: WalletResource;
  public readonly usage: UsageResource;
  public readonly plans: PlansResource;
  public readonly sessions: SessionsResource;
  public readonly proxy: ProxyResource;
  public readonly admin: AdminResource;
  public readonly slots: SlotsResource;
  public readonly agenticWallets: AgenticWalletResource;
  public readonly teams: TeamsResource;
  public readonly x402: X402Resource;
  public readonly walletAuth: WalletAuthResource;

  private tokenManager: TokenManager;
  private http: HttpClient;
  private apiKey: string | null = null;

  constructor(config: DominusNodeConfig = {}) {
    const baseUrl = config.baseUrl ?? DEFAULT_BASE_URL;
    this.tokenManager = new TokenManager();
    this.http = new HttpClient(baseUrl, this.tokenManager, config.agentSecret);

    // Initialize all resource modules BEFORE setting refresh function
    // this.auth must exist before refresh function can be invoked
    this.auth = new AuthResource(this.http);
    this.keys = new KeysResource(this.http);
    this.wallet = new WalletResource(this.http);
    this.usage = new UsageResource(this.http);
    this.plans = new PlansResource(this.http);
    this.sessions = new SessionsResource(this.http);
    this.proxy = new ProxyResource(this.http, config);
    this.admin = new AdminResource(this.http);
    this.slots = new SlotsResource(this.http);
    this.agenticWallets = new AgenticWalletResource(this.http);
    this.teams = new TeamsResource(this.http);
    this.x402 = new X402Resource(this.http);
    this.walletAuth = new WalletAuthResource(this.http, this.tokenManager);

    // Set refresh function AFTER auth is initialized
    this.tokenManager.setRefreshFunction(async (rt) => {
      const res = await this.auth.refresh(rt);
      return { accessToken: res.token, refreshToken: res.refreshToken };
    });

    // Auto-authenticate if tokens were provided in config
    if (config.accessToken) {
      this.tokenManager.setTokens(config.accessToken, config.refreshToken);
    }
  }

  /**
   * Authenticate with an API key.
   * Verifies the key against the server and stores the resulting JWT tokens
   * for subsequent authenticated requests.
   */
  async connectWithKey(apiKey: string): Promise<void> {
    const res = await this.auth.verifyKey(apiKey);
    this.apiKey = apiKey;
    this.tokenManager.setTokens(res.token, res.refreshToken);
  }

  /**
   * Authenticate with email and password.
   * If MFA is required, the returned result will have `mfaRequired: true`.
   * Call `completeMfa()` to finish authentication in that case.
   */
  async connectWithCredentials(email: string, password: string): Promise<LoginResult> {
    const res = await this.auth.login(email, password);
    if (res.token) {
      this.tokenManager.setTokens(res.token, res.refreshToken);
    }
    return { user: res.user, mfaRequired: res.mfaRequired };
  }

  /**
   * Complete MFA verification after a login that returned `mfaRequired: true`.
   */
  async completeMfa(code: string, opts?: { mfaChallengeToken?: string; isBackupCode?: boolean }): Promise<void> {
    const res = await this.auth.verifyMfa(code, opts);
    this.tokenManager.setTokens(res.token, res.refreshToken);
  }

  /**
   * Disconnect: revoke refresh tokens server-side (best-effort) and clear all stored tokens.
   */
  async disconnect(): Promise<void> {
    try {
      await this.auth.logout();
    } catch {
      // Best-effort — server may be unreachable
    }
    this.apiKey = null;
    this.tokenManager.clear();
  }
}
