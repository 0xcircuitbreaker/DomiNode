/**
 * Dominus Node Wallet n8n community node.
 *
 * Operations (25 tools):
 * - Check Balance: Get current wallet balance
 * - Top Up (Stripe): Create a Stripe checkout session
 * - Top Up (Crypto): Create a crypto payment invoice
 * - Top Up (PayPal): Create a PayPal checkout session via Stripe
 * - Get Transactions: Get wallet transaction history
 * - Get Forecast: Get wallet spend forecast
 * - Check Payment: Check crypto payment invoice status
 * - Create Agentic Wallet: Create a sub-wallet with spending limits
 * - Fund Agentic Wallet: Transfer funds to an agentic wallet
 * - Get Agentic Wallet Balance: Check an agentic wallet's balance
 * - List Agentic Wallets: List all agentic wallets
 * - Get Agentic Transactions: Get transaction history for an agentic wallet
 * - Freeze Agentic Wallet: Freeze an agentic wallet
 * - Unfreeze Agentic Wallet: Unfreeze an agentic wallet
 * - Delete Agentic Wallet: Delete an agentic wallet
 * - Update Wallet Policy: Update agentic wallet spending policy
 * - Create Team: Create a new team
 * - List Teams: List all teams
 * - Team Details: Get team details
 * - Fund Team: Fund a team wallet
 * - Create Team Key: Create an API key for a team
 * - Team Usage: Get team wallet transaction history
 * - Update Team: Update team name/max members
 * - Update Team Member Role: Update a team member's role
 * - x402 Info: Get x402 micropayment protocol information
 *
 * @module
 */

import {
  IDataObject,
  IExecuteFunctions,
  INodeExecutionData,
  INodeType,
  INodeTypeDescription,
  NodeOperationError,
} from "n8n-workflow";

import { DominusNodeAuth, sanitizeError } from "../../shared/auth";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CONTROL_CHAR_RE = /[\x00-\x1f\x7f]/;
const DOMAIN_RE = /^(?:[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?\.)+[a-zA-Z]{2,}$/;
const VALID_CRYPTO_CURRENCIES = new Set([
  "btc", "eth", "ltc", "xmr", "zec", "usdc", "sol", "usdt", "dai", "bnb",
]);

export class DominusNodeWallet implements INodeType {
  description: INodeTypeDescription = {
    displayName: "Dominus Node Wallet",
    name: "dominusNodeWallet",
    icon: "file:dominusnode.svg",
    group: ["transform"],
    version: 1,
    subtitle: '={{$parameter["operation"]}}',
    description: "Manage Dominus Node wallet, agentic wallets, and teams",
    defaults: { name: "Dominus Node Wallet" },
    inputs: ["main"],
    outputs: ["main"],
    credentials: [{ name: "dominusNodeApi", required: true }],
    properties: [
      {
        displayName: "Operation",
        name: "operation",
        type: "options",
        noDataExpression: true,
        options: [
          // Wallet
          { name: "Check Balance", value: "checkBalance", description: "Get current wallet balance", action: "Check balance" },
          { name: "Top Up (Stripe)", value: "topUpStripe", description: "Create a Stripe checkout session", action: "Top up stripe" },
          { name: "Top Up (Crypto)", value: "topUpCrypto", description: "Create a crypto payment invoice", action: "Top up crypto" },
          { name: "Top Up (PayPal)", value: "topUpPaypal", description: "Create a PayPal checkout session", action: "Top up paypal" },
          { name: "Get Transactions", value: "getTransactions", description: "Get wallet transaction history", action: "Get transactions" },
          { name: "Get Forecast", value: "getForecast", description: "Get wallet spend forecast", action: "Get forecast" },
          { name: "Check Payment", value: "checkPayment", description: "Check crypto payment invoice status", action: "Check payment" },
          // Agentic Wallets
          { name: "Create Agentic Wallet", value: "createAgenticWallet", description: "Create a sub-wallet with spending limits", action: "Create agentic wallet" },
          { name: "Fund Agentic Wallet", value: "fundAgenticWallet", description: "Transfer funds to an agentic wallet", action: "Fund agentic wallet" },
          { name: "Get Agentic Wallet Balance", value: "getAgenticBalance", description: "Get agentic wallet balance", action: "Get agentic wallet balance" },
          { name: "List Agentic Wallets", value: "listAgenticWallets", description: "List all agentic wallets", action: "List agentic wallets" },
          { name: "Get Agentic Transactions", value: "getAgenticTransactions", description: "Get agentic wallet transactions", action: "Get agentic transactions" },
          { name: "Freeze Agentic Wallet", value: "freezeAgenticWallet", description: "Freeze an agentic wallet", action: "Freeze agentic wallet" },
          { name: "Unfreeze Agentic Wallet", value: "unfreezeAgenticWallet", description: "Unfreeze an agentic wallet", action: "Unfreeze agentic wallet" },
          { name: "Delete Agentic Wallet", value: "deleteAgenticWallet", description: "Delete an agentic wallet", action: "Delete agentic wallet" },
          { name: "Update Wallet Policy", value: "updateWalletPolicy", description: "Update agentic wallet spending policy", action: "Update wallet policy" },
          // Teams
          { name: "Create Team", value: "createTeam", description: "Create a new team", action: "Create team" },
          { name: "List Teams", value: "listTeams", description: "List all teams", action: "List teams" },
          { name: "Team Details", value: "teamDetails", description: "Get team details", action: "Team details" },
          { name: "Fund Team", value: "fundTeam", description: "Fund a team wallet", action: "Fund team" },
          { name: "Create Team Key", value: "createTeamKey", description: "Create an API key for a team", action: "Create team key" },
          { name: "Team Usage", value: "teamUsage", description: "Get team wallet transactions", action: "Team usage" },
          { name: "Update Team", value: "updateTeam", description: "Update team settings", action: "Update team" },
          { name: "Update Team Member Role", value: "updateTeamMemberRole", description: "Update a team member role", action: "Update team member role" },
          // x402
          { name: "x402 Info", value: "x402Info", description: "Get x402 micropayment protocol information", action: "Get x402 info" },
        ],
        default: "checkBalance",
      },

      // --- Stripe top-up ---
      {
        displayName: "Amount (Cents)",
        name: "amountCents",
        type: "number",
        default: 500,
        required: true,
        description: "Amount in cents (e.g., 500 = $5.00). Minimum 500 ($5).",
        displayOptions: { show: { operation: ["topUpStripe", "topUpPaypal"] } },
      },

      // --- Crypto top-up ---
      {
        displayName: "Amount (USD)",
        name: "amountUsd",
        type: "number",
        default: 10,
        required: true,
        description: "Amount in USD. Minimum $5.",
        displayOptions: { show: { operation: ["topUpCrypto"] } },
      },
      {
        displayName: "Currency",
        name: "currency",
        type: "options",
        options: [
          { name: "Bitcoin (BTC)", value: "btc" },
          { name: "Ethereum (ETH)", value: "eth" },
          { name: "Litecoin (LTC)", value: "ltc" },
          { name: "Monero (XMR)", value: "xmr" },
          { name: "Zcash (ZEC)", value: "zec" },
          { name: "USDC", value: "usdc" },
          { name: "Solana (SOL)", value: "sol" },
          { name: "Tether (USDT)", value: "usdt" },
          { name: "DAI", value: "dai" },
          { name: "BNB", value: "bnb" },
        ],
        default: "btc",
        description: "Cryptocurrency to pay with",
        displayOptions: { show: { operation: ["topUpCrypto"] } },
      },

      // --- Transaction / payment params ---
      {
        displayName: "Limit",
        name: "walletTransactionLimit",
        type: "number",
        default: 20,
        description: "Number of transactions to return (1-100)",
        displayOptions: { show: { operation: ["getTransactions"] } },
      },
      {
        displayName: "Invoice ID",
        name: "invoiceId",
        type: "string",
        default: "",
        required: true,
        description: "Crypto payment invoice UUID to check status",
        displayOptions: { show: { operation: ["checkPayment"] } },
      },

      // --- Agentic wallet params ---
      {
        displayName: "Label",
        name: "agenticLabel",
        type: "string",
        default: "",
        required: true,
        description: "Label for the agentic wallet (max 100 chars)",
        displayOptions: { show: { operation: ["createAgenticWallet"] } },
      },
      {
        displayName: "Spending Limit (Cents)",
        name: "spendingLimitCents",
        type: "number",
        default: 1000,
        required: true,
        description: "Per-transaction spending limit in cents",
        displayOptions: { show: { operation: ["createAgenticWallet"] } },
      },
      {
        displayName: "Daily Limit (Cents)",
        name: "dailyLimitCents",
        type: "number",
        default: 0,
        description: "Optional daily budget cap in cents (0 = no limit, max 1,000,000)",
        displayOptions: { show: { operation: ["createAgenticWallet"] } },
      },
      {
        displayName: "Allowed Domains",
        name: "allowedDomains",
        type: "string",
        default: "",
        description: "Comma-separated domain allowlist (e.g., \"example.com,api.example.org\"). Leave empty for no restriction.",
        displayOptions: { show: { operation: ["createAgenticWallet"] } },
      },
      {
        displayName: "Wallet ID",
        name: "policyWalletId",
        type: "string",
        default: "",
        required: true,
        description: "Agentic wallet UUID to update policy for",
        displayOptions: { show: { operation: ["updateWalletPolicy"] } },
      },
      {
        displayName: "Daily Limit (Cents)",
        name: "policyDailyLimitCents",
        type: "number",
        default: 0,
        description: "Daily budget cap in cents (0 = no limit, max 1,000,000). Set to -1 to remove.",
        displayOptions: { show: { operation: ["updateWalletPolicy"] } },
      },
      {
        displayName: "Allowed Domains",
        name: "policyAllowedDomains",
        type: "string",
        default: "",
        description: "Comma-separated domain allowlist. Leave empty to skip, set to \"*\" to remove restriction.",
        displayOptions: { show: { operation: ["updateWalletPolicy"] } },
      },
      {
        displayName: "Wallet ID",
        name: "walletId",
        type: "string",
        default: "",
        required: true,
        description: "Agentic wallet UUID",
        displayOptions: {
          show: {
            operation: [
              "fundAgenticWallet",
              "getAgenticBalance",
              "getAgenticTransactions",
              "freezeAgenticWallet",
              "unfreezeAgenticWallet",
              "deleteAgenticWallet",
            ],
          },
        },
      },
      {
        displayName: "Amount (Cents)",
        name: "fundAmountCents",
        type: "number",
        default: 100,
        required: true,
        description: "Amount in cents to transfer to the agentic wallet",
        displayOptions: { show: { operation: ["fundAgenticWallet"] } },
      },
      {
        displayName: "Limit",
        name: "transactionLimit",
        type: "number",
        default: 20,
        description: "Number of transactions to return (1-100)",
        displayOptions: { show: { operation: ["getAgenticTransactions", "teamUsage"] } },
      },

      // --- Team params ---
      {
        displayName: "Team Name",
        name: "teamName",
        type: "string",
        default: "",
        required: true,
        description: "Name for the team (max 100 chars)",
        displayOptions: { show: { operation: ["createTeam"] } },
      },
      {
        displayName: "Max Members",
        name: "maxMembers",
        type: "number",
        default: 10,
        description: "Maximum team members (1-100)",
        displayOptions: { show: { operation: ["createTeam"] } },
      },
      {
        displayName: "Team ID",
        name: "teamId",
        type: "string",
        default: "",
        required: true,
        description: "Team UUID",
        displayOptions: {
          show: {
            operation: [
              "teamDetails",
              "fundTeam",
              "createTeamKey",
              "teamUsage",
              "updateTeam",
              "updateTeamMemberRole",
            ],
          },
        },
      },
      {
        displayName: "Amount (Cents)",
        name: "teamFundAmountCents",
        type: "number",
        default: 500,
        required: true,
        description: "Amount in cents to fund the team wallet. Min 100 ($1), max 1,000,000 ($10,000).",
        displayOptions: { show: { operation: ["fundTeam"] } },
      },
      {
        displayName: "Key Label",
        name: "keyLabel",
        type: "string",
        default: "",
        required: true,
        description: "Label for the team API key (max 100 chars)",
        displayOptions: { show: { operation: ["createTeamKey"] } },
      },
      {
        displayName: "New Team Name",
        name: "updateTeamName",
        type: "string",
        default: "",
        description: "New name for the team",
        displayOptions: { show: { operation: ["updateTeam"] } },
      },
      {
        displayName: "New Max Members",
        name: "updateMaxMembers",
        type: "number",
        default: 0,
        description: "New max members (1-100). Set to 0 to skip.",
        displayOptions: { show: { operation: ["updateTeam"] } },
      },
      {
        displayName: "User ID",
        name: "userId",
        type: "string",
        default: "",
        required: true,
        description: "User UUID whose role to update",
        displayOptions: { show: { operation: ["updateTeamMemberRole"] } },
      },
      {
        displayName: "Role",
        name: "role",
        type: "options",
        options: [
          { name: "Admin", value: "admin" },
          { name: "Member", value: "member" },
        ],
        default: "member",
        description: "New role for the team member",
        displayOptions: { show: { operation: ["updateTeamMemberRole"] } },
      },
    ],
  };

  async execute(this: IExecuteFunctions): Promise<INodeExecutionData[][]> {
    const items = this.getInputData();
    const returnData: INodeExecutionData[] = [];
    const credentials = await this.getCredentials("dominusNodeApi");

    const apiKey = credentials.apiKey as string;
    const baseUrl = (credentials.baseUrl as string) || "https://api.dominusnode.com";

    if (!apiKey) {
      throw new NodeOperationError(this.getNode(), "API Key is required");
    }

    const agentSecret = (credentials.agentSecret as string) || undefined;
    const auth = new DominusNodeAuth(apiKey, baseUrl, 30000, agentSecret);
    const operation = this.getNodeParameter("operation", 0) as string;

    for (let i = 0; i < items.length; i++) {
      try {
        let result: unknown;

        switch (operation) {
          // ----- Wallet -----
          case "checkBalance": {
            result = await auth.apiRequest("GET", "/api/wallet");
            break;
          }

          case "topUpStripe": {
            const amountCents = this.getNodeParameter("amountCents", i) as number;
            if (!Number.isInteger(amountCents) || amountCents < 500 || amountCents > 1_000_000) {
              throw new NodeOperationError(
                this.getNode(),
                "amountCents must be an integer between 500 ($5) and 1,000,000 ($10,000)",
                { itemIndex: i },
              );
            }
            result = await auth.apiRequest("POST", "/api/wallet/topup/stripe", { amountCents });
            break;
          }

          case "topUpCrypto": {
            const amountUsd = this.getNodeParameter("amountUsd", i) as number;
            const currency = this.getNodeParameter("currency", i) as string;
            if (typeof amountUsd !== "number" || amountUsd < 5 || amountUsd > 10_000) {
              throw new NodeOperationError(
                this.getNode(),
                "amountUsd must be between $5 and $10,000",
                { itemIndex: i },
              );
            }
            if (!VALID_CRYPTO_CURRENCIES.has(currency)) {
              throw new NodeOperationError(
                this.getNode(),
                `Invalid currency. Valid options: ${[...VALID_CRYPTO_CURRENCIES].join(", ")}`,
                { itemIndex: i },
              );
            }
            result = await auth.apiRequest("POST", "/api/wallet/topup/crypto", {
              amountUsd,
              currency,
            });
            break;
          }

          case "topUpPaypal": {
            const amountCents = this.getNodeParameter("amountCents", i) as number;
            if (!Number.isInteger(amountCents) || amountCents < 500 || amountCents > 1_000_000) {
              throw new NodeOperationError(
                this.getNode(),
                "amountCents must be an integer between 500 ($5) and 1,000,000 ($10,000)",
                { itemIndex: i },
              );
            }
            result = await auth.apiRequest("POST", "/api/wallet/topup/stripe", {
              amountCents,
              paymentMethod: "paypal",
            });
            break;
          }

          case "getTransactions": {
            const limit = this.getNodeParameter("walletTransactionLimit", i, 20) as number;
            validateLimit(this, limit, i);

            const params = new URLSearchParams();
            params.set("limit", String(limit));
            result = await auth.apiRequest("GET", `/api/wallet/transactions?${params.toString()}`);
            break;
          }

          case "getForecast": {
            result = await auth.apiRequest("GET", "/api/wallet/forecast");
            break;
          }

          case "checkPayment": {
            const invoiceId = this.getNodeParameter("invoiceId", i) as string;
            validateUuid(this, invoiceId, "invoiceId", i);
            result = await auth.apiRequest(
              "GET",
              `/api/wallet/topup/crypto/${encodeURIComponent(invoiceId)}/status`,
            );
            break;
          }

          // ----- Agentic Wallets -----
          case "createAgenticWallet": {
            const label = this.getNodeParameter("agenticLabel", i) as string;
            const spendingLimitCents = this.getNodeParameter("spendingLimitCents", i) as number;
            const dailyLimitCents = this.getNodeParameter("dailyLimitCents", i, 0) as number;
            const allowedDomainsRaw = this.getNodeParameter("allowedDomains", i, "") as string;

            if (!label || typeof label !== "string") {
              throw new NodeOperationError(this.getNode(), "Label is required", { itemIndex: i });
            }
            if (label.length > 100) {
              throw new NodeOperationError(
                this.getNode(),
                "Label must be 100 characters or fewer",
                { itemIndex: i },
              );
            }
            if (CONTROL_CHAR_RE.test(label)) {
              throw new NodeOperationError(
                this.getNode(),
                "Label contains invalid control characters",
                { itemIndex: i },
              );
            }
            if (
              !Number.isInteger(spendingLimitCents) ||
              spendingLimitCents <= 0 ||
              spendingLimitCents > 2_147_483_647
            ) {
              throw new NodeOperationError(
                this.getNode(),
                "Spending limit must be a positive integer",
                { itemIndex: i },
              );
            }

            const body: Record<string, unknown> = { label, spendingLimitCents };

            if (dailyLimitCents > 0) {
              if (!Number.isInteger(dailyLimitCents) || dailyLimitCents > 1_000_000) {
                throw new NodeOperationError(
                  this.getNode(),
                  "dailyLimitCents must be an integer between 1 and 1,000,000",
                  { itemIndex: i },
                );
              }
              body.dailyLimitCents = dailyLimitCents;
            }

            if (allowedDomainsRaw && allowedDomainsRaw.trim().length > 0) {
              const domains = allowedDomainsRaw.split(",").map((d) => d.trim()).filter(Boolean);
              if (domains.length > 100) {
                throw new NodeOperationError(
                  this.getNode(),
                  "allowedDomains may contain at most 100 entries",
                  { itemIndex: i },
                );
              }
              for (const d of domains) {
                if (d.length > 253 || !DOMAIN_RE.test(d)) {
                  throw new NodeOperationError(
                    this.getNode(),
                    `Invalid domain: "${d}". Must be a valid domain name (max 253 chars).`,
                    { itemIndex: i },
                  );
                }
              }
              body.allowedDomains = domains;
            }

            result = await auth.apiRequest("POST", "/api/agent-wallet", body);
            break;
          }

          case "fundAgenticWallet": {
            const walletId = this.getNodeParameter("walletId", i) as string;
            const amountCents = this.getNodeParameter("fundAmountCents", i) as number;
            validateUuid(this, walletId, "walletId", i);

            if (
              !Number.isInteger(amountCents) ||
              amountCents <= 0 ||
              amountCents > 2_147_483_647
            ) {
              throw new NodeOperationError(
                this.getNode(),
                "Amount must be a positive integer",
                { itemIndex: i },
              );
            }

            result = await auth.apiRequest(
              "POST",
              `/api/agent-wallet/${encodeURIComponent(walletId)}/fund`,
              { amountCents },
            );
            break;
          }

          case "getAgenticBalance": {
            const walletId = this.getNodeParameter("walletId", i) as string;
            validateUuid(this, walletId, "walletId", i);
            result = await auth.apiRequest(
              "GET",
              `/api/agent-wallet/${encodeURIComponent(walletId)}`,
            );
            break;
          }

          case "listAgenticWallets": {
            result = await auth.apiRequest("GET", "/api/agent-wallet");
            break;
          }

          case "getAgenticTransactions": {
            const walletId = this.getNodeParameter("walletId", i) as string;
            const limit = this.getNodeParameter("transactionLimit", i, 20) as number;
            validateUuid(this, walletId, "walletId", i);
            validateLimit(this, limit, i);

            const params = new URLSearchParams();
            params.set("limit", String(limit));
            result = await auth.apiRequest(
              "GET",
              `/api/agent-wallet/${encodeURIComponent(walletId)}/transactions?${params.toString()}`,
            );
            break;
          }

          case "freezeAgenticWallet": {
            const walletId = this.getNodeParameter("walletId", i) as string;
            validateUuid(this, walletId, "walletId", i);
            result = await auth.apiRequest(
              "POST",
              `/api/agent-wallet/${encodeURIComponent(walletId)}/freeze`,
            );
            break;
          }

          case "unfreezeAgenticWallet": {
            const walletId = this.getNodeParameter("walletId", i) as string;
            validateUuid(this, walletId, "walletId", i);
            result = await auth.apiRequest(
              "POST",
              `/api/agent-wallet/${encodeURIComponent(walletId)}/unfreeze`,
            );
            break;
          }

          case "deleteAgenticWallet": {
            const walletId = this.getNodeParameter("walletId", i) as string;
            validateUuid(this, walletId, "walletId", i);
            result = await auth.apiRequest(
              "DELETE",
              `/api/agent-wallet/${encodeURIComponent(walletId)}`,
            );
            break;
          }

          case "updateWalletPolicy": {
            const walletId = this.getNodeParameter("policyWalletId", i) as string;
            const dailyLimitCents = this.getNodeParameter("policyDailyLimitCents", i, 0) as number;
            const allowedDomainsRaw = this.getNodeParameter("policyAllowedDomains", i, "") as string;

            validateUuid(this, walletId, "policyWalletId", i);

            const body: Record<string, unknown> = {};

            if (dailyLimitCents === -1) {
              body.dailyLimitCents = null;
            } else if (dailyLimitCents > 0) {
              if (!Number.isInteger(dailyLimitCents) || dailyLimitCents > 1_000_000) {
                throw new NodeOperationError(
                  this.getNode(),
                  "dailyLimitCents must be an integer between 1 and 1,000,000 (or -1 to remove)",
                  { itemIndex: i },
                );
              }
              body.dailyLimitCents = dailyLimitCents;
            }

            if (allowedDomainsRaw === "*") {
              body.allowedDomains = null;
            } else if (allowedDomainsRaw && allowedDomainsRaw.trim().length > 0) {
              const domains = allowedDomainsRaw.split(",").map((d) => d.trim()).filter(Boolean);
              if (domains.length > 100) {
                throw new NodeOperationError(
                  this.getNode(),
                  "allowedDomains may contain at most 100 entries",
                  { itemIndex: i },
                );
              }
              for (const d of domains) {
                if (d.length > 253 || !DOMAIN_RE.test(d)) {
                  throw new NodeOperationError(
                    this.getNode(),
                    `Invalid domain: "${d}". Must be a valid domain name (max 253 chars).`,
                    { itemIndex: i },
                  );
                }
              }
              body.allowedDomains = domains;
            }

            if (Object.keys(body).length === 0) {
              throw new NodeOperationError(
                this.getNode(),
                "At least one of dailyLimitCents or allowedDomains must be provided",
                { itemIndex: i },
              );
            }

            result = await auth.apiRequest(
              "PATCH",
              `/api/agent-wallet/${encodeURIComponent(walletId)}/policy`,
              body,
            );
            break;
          }

          // ----- Teams -----
          case "createTeam": {
            const name = this.getNodeParameter("teamName", i) as string;
            const maxMembers = this.getNodeParameter("maxMembers", i, 10) as number;

            if (!name || typeof name !== "string") {
              throw new NodeOperationError(this.getNode(), "Team name is required", { itemIndex: i });
            }
            if (name.length > 100) {
              throw new NodeOperationError(
                this.getNode(),
                "Team name must be 100 characters or fewer",
                { itemIndex: i },
              );
            }
            if (CONTROL_CHAR_RE.test(name)) {
              throw new NodeOperationError(
                this.getNode(),
                "Team name contains invalid control characters",
                { itemIndex: i },
              );
            }

            const body: Record<string, unknown> = { name };
            if (maxMembers) {
              if (!Number.isInteger(maxMembers) || maxMembers < 1 || maxMembers > 100) {
                throw new NodeOperationError(
                  this.getNode(),
                  "maxMembers must be an integer between 1 and 100",
                  { itemIndex: i },
                );
              }
              body.maxMembers = maxMembers;
            }

            result = await auth.apiRequest("POST", "/api/teams", body);
            break;
          }

          case "listTeams": {
            result = await auth.apiRequest("GET", "/api/teams");
            break;
          }

          case "teamDetails": {
            const teamId = this.getNodeParameter("teamId", i) as string;
            validateUuid(this, teamId, "teamId", i);
            result = await auth.apiRequest("GET", `/api/teams/${encodeURIComponent(teamId)}`);
            break;
          }

          case "fundTeam": {
            const teamId = this.getNodeParameter("teamId", i) as string;
            const amountCents = this.getNodeParameter("teamFundAmountCents", i) as number;
            validateUuid(this, teamId, "teamId", i);

            if (
              !Number.isInteger(amountCents) ||
              amountCents < 100 ||
              amountCents > 1_000_000
            ) {
              throw new NodeOperationError(
                this.getNode(),
                "amountCents must be between 100 ($1) and 1,000,000 ($10,000)",
                { itemIndex: i },
              );
            }

            result = await auth.apiRequest(
              "POST",
              `/api/teams/${encodeURIComponent(teamId)}/wallet/fund`,
              { amountCents },
            );
            break;
          }

          case "createTeamKey": {
            const teamId = this.getNodeParameter("teamId", i) as string;
            const label = this.getNodeParameter("keyLabel", i) as string;
            validateUuid(this, teamId, "teamId", i);

            if (!label || typeof label !== "string") {
              throw new NodeOperationError(this.getNode(), "Key label is required", { itemIndex: i });
            }
            if (label.length > 100) {
              throw new NodeOperationError(
                this.getNode(),
                "Key label must be 100 characters or fewer",
                { itemIndex: i },
              );
            }
            if (CONTROL_CHAR_RE.test(label)) {
              throw new NodeOperationError(
                this.getNode(),
                "Key label contains invalid control characters",
                { itemIndex: i },
              );
            }

            result = await auth.apiRequest(
              "POST",
              `/api/teams/${encodeURIComponent(teamId)}/keys`,
              { label },
            );
            break;
          }

          case "teamUsage": {
            const teamId = this.getNodeParameter("teamId", i) as string;
            const limit = this.getNodeParameter("transactionLimit", i, 20) as number;
            validateUuid(this, teamId, "teamId", i);
            validateLimit(this, limit, i);

            const params = new URLSearchParams();
            params.set("limit", String(limit));
            result = await auth.apiRequest(
              "GET",
              `/api/teams/${encodeURIComponent(teamId)}/wallet/transactions?${params.toString()}`,
            );
            break;
          }

          case "updateTeam": {
            const teamId = this.getNodeParameter("teamId", i) as string;
            validateUuid(this, teamId, "teamId", i);

            const body: Record<string, unknown> = {};
            const newName = this.getNodeParameter("updateTeamName", i, "") as string;
            const newMax = this.getNodeParameter("updateMaxMembers", i, 0) as number;

            if (newName) {
              if (newName.length > 100) {
                throw new NodeOperationError(
                  this.getNode(),
                  "Team name must be 100 characters or fewer",
                  { itemIndex: i },
                );
              }
              if (CONTROL_CHAR_RE.test(newName)) {
                throw new NodeOperationError(
                  this.getNode(),
                  "Team name contains invalid control characters",
                  { itemIndex: i },
                );
              }
              body.name = newName;
            }

            if (newMax > 0) {
              if (!Number.isInteger(newMax) || newMax < 1 || newMax > 100) {
                throw new NodeOperationError(
                  this.getNode(),
                  "maxMembers must be an integer between 1 and 100",
                  { itemIndex: i },
                );
              }
              body.maxMembers = newMax;
            }

            if (Object.keys(body).length === 0) {
              throw new NodeOperationError(
                this.getNode(),
                "At least one of name or maxMembers must be provided",
                { itemIndex: i },
              );
            }

            result = await auth.apiRequest(
              "PATCH",
              `/api/teams/${encodeURIComponent(teamId)}`,
              body,
            );
            break;
          }

          case "updateTeamMemberRole": {
            const teamId = this.getNodeParameter("teamId", i) as string;
            const userId = this.getNodeParameter("userId", i) as string;
            const role = this.getNodeParameter("role", i) as string;

            validateUuid(this, teamId, "teamId", i);
            validateUuid(this, userId, "userId", i);

            if (role !== "member" && role !== "admin") {
              throw new NodeOperationError(
                this.getNode(),
                "Role must be 'member' or 'admin'",
                { itemIndex: i },
              );
            }

            result = await auth.apiRequest(
              "PATCH",
              `/api/teams/${encodeURIComponent(teamId)}/members/${encodeURIComponent(userId)}`,
              { role },
            );
            break;
          }

          case "x402Info": {
            result = await auth.apiRequest("GET", "/api/x402/info");
            break;
          }

          default:
            throw new NodeOperationError(
              this.getNode(),
              `Unknown operation: ${operation}`,
              { itemIndex: i },
            );
        }

        returnData.push({ json: (result ?? {}) as IDataObject });
      } catch (err) {
        if (this.continueOnFail()) {
          returnData.push({
            json: {
              error: sanitizeError(err instanceof Error ? err.message : String(err)),
            },
          });
          continue;
        }
        if (err instanceof NodeOperationError) throw err;
        throw new NodeOperationError(
          this.getNode(),
          sanitizeError(err instanceof Error ? err.message : String(err)),
          { itemIndex: i },
        );
      }
    }

    return [returnData];
  }
}

// ---------------------------------------------------------------------------
// Validation helpers
// ---------------------------------------------------------------------------

function validateUuid(
  ctx: IExecuteFunctions,
  value: string,
  fieldName: string,
  itemIndex: number,
): void {
  if (!value || typeof value !== "string") {
    throw new NodeOperationError(ctx.getNode(), `${fieldName} is required`, { itemIndex });
  }
  if (!UUID_RE.test(value)) {
    throw new NodeOperationError(ctx.getNode(), `${fieldName} must be a valid UUID`, { itemIndex });
  }
}

function validateLimit(
  ctx: IExecuteFunctions,
  limit: number,
  itemIndex: number,
): void {
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
    throw new NodeOperationError(
      ctx.getNode(),
      "Limit must be an integer between 1 and 100",
      { itemIndex },
    );
  }
}
