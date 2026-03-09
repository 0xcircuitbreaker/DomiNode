-- Dominus Node database schema
-- Version: 1.0.0

CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- ─── Schema Versioning ──────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS schema_migrations (
  version     TEXT PRIMARY KEY,
  applied_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  description TEXT NOT NULL DEFAULT ''
);

-- ─── Users ───────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS users (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email               TEXT UNIQUE NOT NULL,
  password_hash       TEXT NOT NULL,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  status              TEXT NOT NULL DEFAULT 'active'
                      CHECK (status IN ('active', 'suspended', 'deleted')),
  password_changed_at TIMESTAMPTZ
);

-- ─── API Keys ────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS api_keys (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     UUID NOT NULL REFERENCES users(id),
  key_hash    TEXT NOT NULL,
  key_prefix  TEXT NOT NULL,
  label       TEXT NOT NULL DEFAULT '',
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  revoked_at  TIMESTAMPTZ
);

-- UNIQUE constraint prevents silent key collision on active keys
CREATE UNIQUE INDEX IF NOT EXISTS idx_api_keys_hash
  ON api_keys(key_hash) WHERE revoked_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_api_keys_user
  ON api_keys(user_id);

-- ─── Wallets ─────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS wallets (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id        UUID UNIQUE NOT NULL REFERENCES users(id),
  balance_cents  INTEGER NOT NULL DEFAULT 0
                 CHECK (balance_cents >= 0),
  currency       TEXT NOT NULL DEFAULT 'USD',
  last_topped_up TIMESTAMPTZ
);

-- ─── Wallet Transactions ─────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS wallet_transactions (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  wallet_id        UUID NOT NULL REFERENCES wallets(id),
  type             TEXT NOT NULL CHECK (type IN ('topup', 'debit', 'refund')),
  amount_cents     INTEGER NOT NULL CHECK (amount_cents > 0),
  description      TEXT NOT NULL DEFAULT '',
  payment_provider TEXT,
  payment_id       TEXT,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_wallet_tx_wallet
  ON wallet_transactions(wallet_id);
CREATE INDEX IF NOT EXISTS idx_wallet_tx_created
  ON wallet_transactions(created_at);

-- Prevent duplicate webhook credits
CREATE UNIQUE INDEX IF NOT EXISTS idx_wallet_tx_payment_unique
  ON wallet_transactions(payment_provider, payment_id)
  WHERE payment_provider IS NOT NULL AND payment_id IS NOT NULL;

-- ─── Sessions ────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS sessions (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     UUID NOT NULL REFERENCES users(id),
  proxy_ip    TEXT NOT NULL DEFAULT '',
  started_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  ended_at    TIMESTAMPTZ,
  bytes_total BIGINT NOT NULL DEFAULT 0,
  status      TEXT NOT NULL DEFAULT 'active'
              CHECK (status IN ('active', 'completed', 'error'))
);

CREATE INDEX IF NOT EXISTS idx_sessions_user
  ON sessions(user_id);
CREATE INDEX IF NOT EXISTS idx_sessions_active
  ON sessions(status) WHERE status = 'active';

-- ─── Usage Records ───────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS usage_records (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     UUID NOT NULL REFERENCES users(id),
  session_id  UUID NOT NULL REFERENCES sessions(id),
  bytes_in    BIGINT NOT NULL DEFAULT 0,
  bytes_out   BIGINT NOT NULL DEFAULT 0,
  cost_cents  INTEGER NOT NULL DEFAULT 0,
  proxy_type  TEXT NOT NULL DEFAULT 'residential',
  target_host TEXT NOT NULL DEFAULT '',
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_usage_user
  ON usage_records(user_id);
CREATE INDEX IF NOT EXISTS idx_usage_created
  ON usage_records(created_at);
CREATE INDEX IF NOT EXISTS idx_usage_user_created
  ON usage_records(user_id, created_at);
CREATE INDEX IF NOT EXISTS idx_usage_session
  ON usage_records(session_id);

-- CHECK constraint on proxy_type
DO $$ BEGIN
  ALTER TABLE usage_records ADD CONSTRAINT chk_usage_proxy_type
    CHECK (proxy_type IN ('dc', 'residential'));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- CHECK constraints on usage_records bytes and cost columns
DO $$ BEGIN
  ALTER TABLE usage_records ADD CONSTRAINT chk_usage_bytes_in CHECK (bytes_in >= 0);
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE usage_records ADD CONSTRAINT chk_usage_bytes_out CHECK (bytes_out >= 0);
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE usage_records ADD CONSTRAINT chk_usage_cost_cents CHECK (cost_cents >= 0);
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- ─── Payment Invoices ──────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS payment_invoices (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       UUID NOT NULL REFERENCES users(id),
  provider      TEXT NOT NULL CHECK (provider IN ('stripe', 'nowpayments', 'paypal')),
  external_id   TEXT NOT NULL,
  amount_cents  INTEGER NOT NULL CHECK (amount_cents > 0),
  status        TEXT NOT NULL DEFAULT 'pending'
                CHECK (status IN ('pending', 'completed', 'failed')),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_payment_invoices_external
  ON payment_invoices(provider, external_id);
CREATE INDEX IF NOT EXISTS idx_payment_invoices_user
  ON payment_invoices(user_id);

-- ─── Plans ─────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS plans (
  id                    TEXT PRIMARY KEY,
  name                  TEXT NOT NULL,
  price_per_gb_cents    INTEGER NOT NULL,
  monthly_bandwidth_bytes BIGINT NOT NULL DEFAULT 0,
  is_default            BOOLEAN NOT NULL DEFAULT false,
  max_connections       INTEGER NOT NULL DEFAULT 100
);

-- Seed plans
INSERT INTO plans (id, name, price_per_gb_cents, monthly_bandwidth_bytes, is_default, max_connections) VALUES
  ('free',   'Free',          0,   1073741824,      true,  10),
  ('payg',   'Pay As You Go', 500, 0,               false, 100),
  ('vol100', 'Volume 100GB',  400, 107374182400,    false, 100),
  ('vol1tb', 'Volume 1TB',    300, 1099511627776,   false, 100),
  ('agent',  'AI Agent',      500, 0,               false, 50)
ON CONFLICT (id) DO NOTHING;

-- Add plan to users (idempotent)
DO $$ BEGIN
  ALTER TABLE users ADD COLUMN plan_id TEXT NOT NULL DEFAULT 'free' REFERENCES plans(id);
EXCEPTION WHEN duplicate_column THEN NULL;
END $$;

-- Add max_connections to plans (idempotent migration for existing DBs)
DO $$ BEGIN
  ALTER TABLE plans ADD COLUMN max_connections INTEGER NOT NULL DEFAULT 100;
EXCEPTION WHEN duplicate_column THEN NULL;
END $$;

-- Add max_sessions_per_minute to plans (idempotent migration for existing DBs)
DO $$ BEGIN
  ALTER TABLE plans ADD COLUMN max_sessions_per_minute INTEGER NOT NULL DEFAULT 30;
EXCEPTION WHEN duplicate_column THEN NULL;
END $$;

-- Update free plan for existing databases (bandwidth, price, default, max_connections)
UPDATE plans SET price_per_gb_cents = 0, monthly_bandwidth_bytes = 1073741824, is_default = true, max_connections = 10, name = 'Free' WHERE id = 'free';
UPDATE plans SET is_default = false WHERE id = 'payg';
-- AI Agent plan: unlimited bandwidth (matching Pay As You Go)
UPDATE plans SET monthly_bandwidth_bytes = 0 WHERE id = 'agent';

-- Set per-plan session rate limits
UPDATE plans SET max_sessions_per_minute = 30 WHERE id IN ('free', 'payg');
UPDATE plans SET max_sessions_per_minute = 60 WHERE id IN ('vol100', 'vol1tb', 'agent');

-- ─── allowed_proxy_types column (Beta free-tier restructure) ─────────
DO $$ BEGIN
  ALTER TABLE plans ADD COLUMN allowed_proxy_types TEXT;
EXCEPTION WHEN duplicate_column THEN NULL;
END $$;

-- Enforce valid values for allowed_proxy_types
DO $$ BEGIN
  ALTER TABLE plans ADD CONSTRAINT chk_plans_allowed_proxy_types
    CHECK (allowed_proxy_types IS NULL OR allowed_proxy_types IN ('dc', 'residential', 'all'));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- Beta free plans: free-dc (500 MB DC only) and free-res (50 MB residential only)
-- free-dc is the default for new signups — AI agents are efficient, 500 MB is plenty
INSERT INTO plans (id, name, price_per_gb_cents, monthly_bandwidth_bytes, is_default, max_connections, max_sessions_per_minute, allowed_proxy_types) VALUES
  ('free-dc',  'Free DC',          0, 524288000,    true,  5, 30, 'dc'),
  ('free-res', 'Free Residential', 0, 52428800,     false, 5, 30, 'residential')
ON CONFLICT (id) DO UPDATE SET
  name = EXCLUDED.name,
  price_per_gb_cents = EXCLUDED.price_per_gb_cents,
  monthly_bandwidth_bytes = EXCLUDED.monthly_bandwidth_bytes,
  is_default = EXCLUDED.is_default,
  max_connections = EXCLUDED.max_connections,
  max_sessions_per_minute = EXCLUDED.max_sessions_per_minute,
  allowed_proxy_types = EXCLUDED.allowed_proxy_types;

-- Old free plan: keep for backward compat but no longer default
UPDATE plans SET is_default = false WHERE id = 'free';

-- Wire up free-dc as the actual DB column default for new signups
-- (Previously pointed to legacy 'free' which allowed residential access)
ALTER TABLE users ALTER COLUMN plan_id SET DEFAULT 'free-dc';

-- Swarm plans: ultra-tight limits for operator-controlled agent swarms
-- swarm-dc: 200 MB/month, DC only, 2 connections, 10 sessions/min (poster/API bots)
-- swarm-mixed: 200 MB/month, all pools, 2 connections, 10 sessions/min (scraper bots needing residential)
INSERT INTO plans (id, name, price_per_gb_cents, monthly_bandwidth_bytes, is_default, max_connections, max_sessions_per_minute, allowed_proxy_types) VALUES
  ('swarm-dc', 'Swarm DC', 0, 209715200, false, 2, 10, 'dc'),
  ('swarm-mixed', 'Swarm Mixed', 0, 209715200, false, 2, 10, 'all')
ON CONFLICT (id) DO UPDATE SET
  name = EXCLUDED.name,
  price_per_gb_cents = EXCLUDED.price_per_gb_cents,
  monthly_bandwidth_bytes = EXCLUDED.monthly_bandwidth_bytes,
  is_default = EXCLUDED.is_default,
  max_connections = EXCLUDED.max_connections,
  max_sessions_per_minute = EXCLUDED.max_sessions_per_minute,
  allowed_proxy_types = EXCLUDED.allowed_proxy_types;

-- Add admin role (idempotent)
DO $$ BEGIN
  ALTER TABLE users ADD COLUMN is_admin BOOLEAN NOT NULL DEFAULT false;
EXCEPTION WHEN duplicate_column THEN NULL;
END $$;

-- Add connect latency to usage records (idempotent)
DO $$ BEGIN
  ALTER TABLE usage_records ADD COLUMN connect_latency_ms INTEGER;
EXCEPTION WHEN duplicate_column THEN NULL;
END $$;

-- ─── Refresh Tokens ─────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS refresh_tokens (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     UUID NOT NULL REFERENCES users(id),
  token_hash  TEXT NOT NULL,
  family_id   UUID NOT NULL,
  revoked     BOOLEAN NOT NULL DEFAULT false,
  expires_at  TIMESTAMPTZ NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_refresh_tokens_hash
  ON refresh_tokens(token_hash) WHERE NOT revoked;
CREATE INDEX IF NOT EXISTS idx_refresh_tokens_family
  ON refresh_tokens(family_id);
CREATE INDEX IF NOT EXISTS idx_refresh_tokens_user
  ON refresh_tokens(user_id);

-- ─── MFA Configs ──────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS mfa_configs (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         UUID UNIQUE NOT NULL REFERENCES users(id),
  totp_secret_enc TEXT NOT NULL,
  totp_secret_iv  TEXT NOT NULL,
  enabled         BOOLEAN NOT NULL DEFAULT false,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  enabled_at      TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_mfa_configs_user ON mfa_configs(user_id);

-- ─── MFA Backup Codes ────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS mfa_backup_codes (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id    UUID NOT NULL REFERENCES users(id),
  code_hash  TEXT NOT NULL,
  used_at    TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_mfa_backup_user
  ON mfa_backup_codes(user_id) WHERE used_at IS NULL;

-- ─── Explicit email index (for documentation/query planner clarity) ────
CREATE INDEX IF NOT EXISTS idx_users_email ON users(email);

-- ─── Sessions: enforce non-negative bytes_total ────────────────────────
DO $$ BEGIN
  ALTER TABLE sessions ADD CONSTRAINT chk_sessions_bytes_total CHECK (bytes_total >= 0);
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- ─── Audit Events ──────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS audit_events (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     UUID REFERENCES users(id),
  action      TEXT NOT NULL,
  resource    TEXT NOT NULL,
  resource_id TEXT,
  ip_address  TEXT,
  details     JSONB,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_audit_events_user ON audit_events(user_id);
CREATE INDEX IF NOT EXISTS idx_audit_events_action ON audit_events(action);
CREATE INDEX IF NOT EXISTS idx_audit_events_created ON audit_events(created_at);

-- ─── Wallet Address on Users (for crypto wallet auth) ─────────────────

DO $$ BEGIN
  ALTER TABLE users ADD COLUMN wallet_address TEXT;
EXCEPTION WHEN duplicate_column THEN NULL;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS idx_users_wallet_address
  ON users(wallet_address) WHERE wallet_address IS NOT NULL;

-- wallet_address must be exactly 42 chars (0x + 40 hex) and lowercase hex
DO $$ BEGIN
  ALTER TABLE users ADD CONSTRAINT chk_wallet_address_format
    CHECK (wallet_address IS NULL OR (length(wallet_address) = 42 AND wallet_address ~ '^0x[0-9a-f]{40}$'));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- ─── Wallet Challenges (nonce-based EIP-191 signature auth) ───────────

CREATE TABLE IF NOT EXISTS wallet_challenges (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  address     TEXT NOT NULL,
  nonce       TEXT NOT NULL,
  ip_address  TEXT NOT NULL DEFAULT '',
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  consumed    BOOLEAN NOT NULL DEFAULT false
);

CREATE INDEX IF NOT EXISTS idx_wallet_challenges_address
  ON wallet_challenges(address) WHERE NOT consumed;
CREATE INDEX IF NOT EXISTS idx_wallet_challenges_created
  ON wallet_challenges(created_at);

-- Length constraints on wallet_challenges text fields
DO $$ BEGIN
  ALTER TABLE wallet_challenges ADD CONSTRAINT chk_wc_address_length CHECK (length(address) <= 42);
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
DO $$ BEGIN
  ALTER TABLE wallet_challenges ADD CONSTRAINT chk_wc_nonce_length CHECK (length(nonce) <= 128);
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
DO $$ BEGIN
  ALTER TABLE wallet_challenges ADD CONSTRAINT chk_wc_ip_length CHECK (length(ip_address) <= 45);
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- ─── Data Retention Policies ───────────────────────────────────────────

CREATE TABLE IF NOT EXISTS data_retention_policies (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  table_name      TEXT UNIQUE NOT NULL,
  retention_days  INTEGER NOT NULL CHECK (retention_days > 0),
  description     TEXT NOT NULL DEFAULT '',
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

INSERT INTO data_retention_policies (table_name, retention_days, description) VALUES
  ('usage_records',       365, 'Usage records retained for 1 year'),
  ('sessions',             90, 'Session records retained for 90 days'),
  ('audit_events',        365, 'Audit events retained for 1 year'),
  ('wallet_transactions', 730, 'Wallet transactions retained for 2 years'),
  ('wallet_challenges',     1, 'Wallet challenges retained for 1 day')
ON CONFLICT (table_name) DO NOTHING;

-- ─── Opt-in target host logging (privacy-first default) ──────────────
DO $$ BEGIN
  ALTER TABLE users ADD COLUMN log_target_hosts BOOLEAN NOT NULL DEFAULT false;
EXCEPTION WHEN duplicate_column THEN NULL;
END $$;

-- ─── Email verified column on users ──────────────────────────────────
DO $$ BEGIN
  ALTER TABLE users ADD COLUMN email_verified BOOLEAN NOT NULL DEFAULT false;
EXCEPTION WHEN duplicate_column THEN NULL;
END $$;

-- ─── Email Verification Tokens ──────────────────────────────────────
CREATE TABLE IF NOT EXISTS email_verification_tokens (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     UUID NOT NULL REFERENCES users(id),
  token_hash  TEXT NOT NULL,
  expires_at  TIMESTAMPTZ NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_email_verification_user
  ON email_verification_tokens(user_id);
CREATE INDEX IF NOT EXISTS idx_email_verification_expires
  ON email_verification_tokens(expires_at);

-- ─── Password Reset Tokens ──────────────────────────────────────────
CREATE TABLE IF NOT EXISTS password_reset_tokens (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     UUID NOT NULL REFERENCES users(id),
  token_hash  TEXT NOT NULL,
  expires_at  TIMESTAMPTZ NOT NULL,
  used_at     TIMESTAMPTZ,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_password_reset_user
  ON password_reset_tokens(user_id);
CREATE INDEX IF NOT EXISTS idx_password_reset_expires
  ON password_reset_tokens(expires_at);

-- Add retention policy for email/password tokens
INSERT INTO data_retention_policies (table_name, retention_days, description) VALUES
  ('email_verification_tokens', 1, 'Email verification tokens retained for 1 day'),
  ('password_reset_tokens',     1, 'Password reset tokens retained for 1 day')
ON CONFLICT (table_name) DO NOTHING;

-- ─── Waitlist ────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS waitlist (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email       TEXT UNIQUE NOT NULL,
  ip_address  TEXT NOT NULL DEFAULT '',
  status      TEXT NOT NULL DEFAULT 'pending'
              CHECK (status IN ('pending', 'notified', 'registered', 'cancelled')),
  notified_at TIMESTAMPTZ,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_waitlist_status ON waitlist(status);
CREATE INDEX IF NOT EXISTS idx_waitlist_email ON waitlist(email);
CREATE INDEX IF NOT EXISTS idx_waitlist_created ON waitlist(created_at);

-- Add retention policy for waitlist
INSERT INTO data_retention_policies (table_name, retention_days, description) VALUES
  ('waitlist', 365, 'Waitlist entries retained for 1 year')
ON CONFLICT (table_name) DO NOTHING;

-- ─── Agentic Wallets ─────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS agentic_wallets (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id             UUID NOT NULL REFERENCES users(id),
  label               TEXT NOT NULL DEFAULT '',
  balance_cents       INTEGER NOT NULL DEFAULT 0
                      CHECK (balance_cents >= 0),
  spending_limit_cents INTEGER NOT NULL DEFAULT 0
                      CHECK (spending_limit_cents >= 0),
  status              TEXT NOT NULL DEFAULT 'active'
                      CHECK (status IN ('active', 'frozen', 'deleted')),
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_agentic_wallets_user
  ON agentic_wallets(user_id);
CREATE INDEX IF NOT EXISTS idx_agentic_wallets_user_active
  ON agentic_wallets(user_id) WHERE status = 'active';

-- ─── Agentic Wallet Transactions ─────────────────────────────────────

CREATE TABLE IF NOT EXISTS agentic_wallet_transactions (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  wallet_id     UUID NOT NULL REFERENCES agentic_wallets(id),
  type          TEXT NOT NULL
                CHECK (type IN ('fund', 'spend', 'refund', 'withdraw')),
  amount_cents  INTEGER NOT NULL CHECK (amount_cents > 0),
  description   TEXT NOT NULL DEFAULT '',
  session_id    UUID REFERENCES sessions(id),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_agentic_wallet_tx_wallet
  ON agentic_wallet_transactions(wallet_id);
CREATE INDEX IF NOT EXISTS idx_agentic_wallet_tx_created
  ON agentic_wallet_transactions(created_at);

-- Add retention policy for agentic wallet transactions
INSERT INTO data_retention_policies (table_name, retention_days, description) VALUES
  ('agentic_wallets',              730, 'Agentic wallets retained for 2 years'),
  ('agentic_wallet_transactions',  730, 'Agentic wallet transactions retained for 2 years')
ON CONFLICT (table_name) DO NOTHING;

-- ─── Teams ──────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS teams (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name        TEXT NOT NULL,
  owner_id    UUID NOT NULL REFERENCES users(id),
  plan_id     TEXT NOT NULL DEFAULT 'payg' REFERENCES plans(id),
  max_members INTEGER NOT NULL DEFAULT 10
              CHECK (max_members >= 1 AND max_members <= 100),
  status      TEXT NOT NULL DEFAULT 'active'
              CHECK (status IN ('active', 'suspended', 'deleted')),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_teams_owner ON teams(owner_id);

-- ─── Team Wallets (1:1 with teams) ─────────────────────────────────

CREATE TABLE IF NOT EXISTS team_wallets (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  team_id        UUID NOT NULL UNIQUE REFERENCES teams(id),
  balance_cents  INTEGER NOT NULL DEFAULT 0
                 CHECK (balance_cents >= 0),
  currency       TEXT NOT NULL DEFAULT 'USD',
  last_topped_up TIMESTAMPTZ
);

-- ─── Team Members ──────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS team_members (
  id        UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  team_id   UUID NOT NULL REFERENCES teams(id),
  user_id   UUID NOT NULL REFERENCES users(id),
  role      TEXT NOT NULL DEFAULT 'member'
            CHECK (role IN ('owner', 'admin', 'member')),
  joined_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(team_id, user_id)
);

CREATE INDEX IF NOT EXISTS idx_team_members_user ON team_members(user_id);
CREATE INDEX IF NOT EXISTS idx_team_members_team ON team_members(team_id);

-- ─── Team Invites ──────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS team_invites (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  team_id     UUID NOT NULL REFERENCES teams(id),
  email       TEXT NOT NULL,
  role        TEXT NOT NULL DEFAULT 'member'
              CHECK (role IN ('admin', 'member')),
  token_hash  TEXT NOT NULL,
  invited_by  UUID NOT NULL REFERENCES users(id),
  expires_at  TIMESTAMPTZ NOT NULL,
  accepted_at TIMESTAMPTZ,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_team_invites_token
  ON team_invites(token_hash) WHERE accepted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_team_invites_team
  ON team_invites(team_id);

-- ─── Team API Keys: add team_id to api_keys ────────────────────────

DO $$ BEGIN
  ALTER TABLE api_keys ADD COLUMN team_id UUID REFERENCES teams(id);
EXCEPTION WHEN duplicate_column THEN NULL;
END $$;

CREATE INDEX IF NOT EXISTS idx_api_keys_team
  ON api_keys(team_id) WHERE team_id IS NOT NULL;

-- ─── Team Wallet Transactions ──────────────────────────────────────

CREATE TABLE IF NOT EXISTS team_wallet_transactions (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  wallet_id        UUID NOT NULL REFERENCES team_wallets(id),
  type             TEXT NOT NULL CHECK (type IN ('fund', 'debit', 'refund')),
  amount_cents     INTEGER NOT NULL CHECK (amount_cents > 0),
  description      TEXT NOT NULL DEFAULT '',
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_team_wallet_tx_wallet
  ON team_wallet_transactions(wallet_id);
CREATE INDEX IF NOT EXISTS idx_team_wallet_tx_created
  ON team_wallet_transactions(created_at);

-- Add retention policies for team tables
INSERT INTO data_retention_policies (table_name, retention_days, description) VALUES
  ('teams',                    730, 'Teams retained for 2 years'),
  ('team_wallets',             730, 'Team wallets retained for 2 years'),
  ('team_wallet_transactions', 730, 'Team wallet transactions retained for 2 years'),
  ('team_members',             730, 'Team members retained for 2 years'),
  ('team_invites',             365, 'Team invites retained for 1 year')
ON CONFLICT (table_name) DO NOTHING;

-- ─── Upper bound CHECK constraints on balance_cents ────────

DO $$ BEGIN
  ALTER TABLE wallets ADD CONSTRAINT chk_wallets_balance_upper CHECK (balance_cents <= 1000000);
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE team_wallets ADD CONSTRAINT chk_team_wallets_balance_upper CHECK (balance_cents <= 1000000);
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE agentic_wallets ADD CONSTRAINT chk_agentic_wallets_balance_upper CHECK (balance_cents <= 1000000);
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- ─── Upper bound CHECK constraints on amount_cents (prevent integer overflow) ──

DO $$ BEGIN
  ALTER TABLE wallet_transactions ADD CONSTRAINT chk_wallet_tx_amount_upper CHECK (amount_cents <= 214748364);
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE agentic_wallet_transactions ADD CONSTRAINT chk_agentic_tx_amount_upper CHECK (amount_cents <= 214748364);
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE team_wallet_transactions ADD CONSTRAINT chk_team_tx_amount_upper CHECK (amount_cents <= 214748364);
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE payment_invoices ADD CONSTRAINT chk_invoice_amount_upper CHECK (amount_cents <= 214748364);
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- ─── TEXT column length constraints on user-input fields ────

DO $$ BEGIN
  ALTER TABLE users ADD CONSTRAINT chk_users_email_length CHECK (length(email) <= 320);
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE api_keys ADD CONSTRAINT chk_api_keys_label_length CHECK (length(label) <= 255);
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE agentic_wallets ADD CONSTRAINT chk_agentic_wallets_label_length CHECK (length(label) <= 255);
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE teams ADD CONSTRAINT chk_teams_name_length CHECK (length(name) <= 255);
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE wallet_transactions ADD CONSTRAINT chk_wallet_tx_desc_length CHECK (length(description) <= 1000);
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE agentic_wallet_transactions ADD CONSTRAINT chk_agentic_tx_desc_length CHECK (length(description) <= 1000);
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE team_wallet_transactions ADD CONSTRAINT chk_team_tx_desc_length CHECK (length(description) <= 1000);
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE data_retention_policies ADD CONSTRAINT chk_retention_desc_length CHECK (length(description) <= 1000);
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE team_invites ADD CONSTRAINT chk_team_invites_email_length CHECK (length(email) <= 320);
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE waitlist ADD CONSTRAINT chk_waitlist_email_length CHECK (length(email) <= 320);
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- ─── x402 Micropayment Transactions ──────────────────────────────────

CREATE TABLE IF NOT EXISTS x402_transactions (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  facilitator     TEXT NOT NULL CHECK (facilitator IN ('coinbase', 'payai')),
  payer_address   TEXT NOT NULL,
  amount_usd      TEXT NOT NULL,
  tx_hash         TEXT,
  pool_type       TEXT NOT NULL CHECK (pool_type IN ('dc', 'residential')),
  target_host     TEXT NOT NULL DEFAULT 'unknown',
  status          TEXT NOT NULL DEFAULT 'settled'
                  CHECK (status IN ('pending', 'settled', 'failed')),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- C-5: payment_hash for replay detection (SHA-256 of X-PAYMENT header)
DO $$ BEGIN
  ALTER TABLE x402_transactions ADD COLUMN payment_hash TEXT;
EXCEPTION WHEN duplicate_column THEN NULL;
END $$;

-- Backfill NULL payment_hash values before adding NOT NULL constraint
UPDATE x402_transactions SET payment_hash = id::TEXT WHERE payment_hash IS NULL;

DO $$ BEGIN
  ALTER TABLE x402_transactions ALTER COLUMN payment_hash SET NOT NULL;
EXCEPTION WHEN OTHERS THEN NULL;
END $$;

CREATE INDEX IF NOT EXISTS idx_x402_transactions_payer ON x402_transactions(payer_address);
CREATE INDEX IF NOT EXISTS idx_x402_transactions_created ON x402_transactions(created_at);
-- Unconditional unique index (payment_hash has NOT NULL constraint)
CREATE UNIQUE INDEX IF NOT EXISTS idx_x402_payment_hash ON x402_transactions(payment_hash);

-- Retention policy for x402 transactions
INSERT INTO data_retention_policies (table_name, retention_days, description) VALUES
  ('x402_transactions', 730, 'x402 micropayment transactions retained for 2 years')
ON CONFLICT (table_name) DO NOTHING;

-- Length constraints on x402 text fields
DO $$ BEGIN
  ALTER TABLE x402_transactions ADD CONSTRAINT chk_x402_payer_length CHECK (length(payer_address) <= 255);
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE x402_transactions ADD CONSTRAINT chk_x402_amount_length CHECK (length(amount_usd) <= 50);
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE x402_transactions ADD CONSTRAINT chk_x402_tx_hash_length CHECK (length(tx_hash) <= 255);
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE x402_transactions ADD CONSTRAINT chk_x402_target_length CHECK (length(target_host) <= 255);
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- ─── x402 + PayPal provider migration ──────────────────────────────────

DO $$ BEGIN
  ALTER TABLE payment_invoices DROP CONSTRAINT IF EXISTS payment_invoices_provider_check;
  ALTER TABLE payment_invoices ADD CONSTRAINT payment_invoices_provider_check
    CHECK (provider IN ('stripe', 'nowpayments', 'paypal', 'x402'));
EXCEPTION WHEN OTHERS THEN NULL;
END $$;

-- ─── Agentic wallet policy fields: daily budget + domain allowlist ────

DO $$ BEGIN
  ALTER TABLE agentic_wallets ADD COLUMN daily_limit_cents INTEGER DEFAULT NULL
    CHECK (daily_limit_cents IS NULL OR (daily_limit_cents > 0 AND daily_limit_cents <= 1000000));
EXCEPTION WHEN duplicate_column THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE agentic_wallets ADD COLUMN allowed_domains TEXT DEFAULT NULL
    CHECK (allowed_domains IS NULL OR length(allowed_domains) <= 4096);
EXCEPTION WHEN duplicate_column THEN NULL;
END $$;

-- ─── Upper bound on agentic_wallets spending_limit_cents ────
DO $$ BEGIN
  ALTER TABLE agentic_wallets ADD CONSTRAINT chk_agentic_wallets_spending_upper
    CHECK (spending_limit_cents <= 1000000);
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- ─── Currency CHECK constraints ───────────────────────────
DO $$ BEGIN
  ALTER TABLE wallets ADD CONSTRAINT chk_wallets_currency CHECK (currency = 'USD');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
DO $$ BEGIN
  ALTER TABLE team_wallets ADD CONSTRAINT chk_team_wallets_currency CHECK (currency = 'USD');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- ─── Record current schema version ──────────────────────────────────

INSERT INTO schema_migrations (version, description) VALUES
  ('1.0.0', 'Initial production schema: users, api_keys, wallets, sessions, usage_records, plans, MFA, wallet auth, audit events, data retention')
ON CONFLICT (version) DO NOTHING;

INSERT INTO schema_migrations (version, description) VALUES
  ('1.1.0', 'Add PayPal as payment provider')
ON CONFLICT (version) DO NOTHING;

INSERT INTO schema_migrations (version, description) VALUES
  ('1.2.0', 'Add x402 micropayment transactions table and x402 payment provider')
ON CONFLICT (version) DO NOTHING;

INSERT INTO schema_migrations (version, description) VALUES
  ('1.3.0', 'Add agentic wallet policy fields: daily_limit_cents, allowed_domains')
ON CONFLICT (version) DO NOTHING;

-- ─── Bug Reports (bug bounty system) ──────────────────────────────────

CREATE TABLE IF NOT EXISTS bug_reports (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id             UUID NOT NULL REFERENCES users(id),
  category            TEXT NOT NULL CHECK (category IN ('quality', 'security')),
  priority            TEXT NOT NULL DEFAULT 'p3' CHECK (priority IN ('p1', 'p2', 'p3')),
  title               TEXT NOT NULL CHECK (length(title) BETWEEN 5 AND 200),
  description         TEXT NOT NULL CHECK (length(description) BETWEEN 10 AND 5000),
  integration         TEXT CHECK (length(integration) <= 100),
  sdk_version         TEXT CHECK (length(sdk_version) <= 50),
  trace_ids           TEXT[] DEFAULT '{}',
  steps_to_reproduce  TEXT CHECK (length(steps_to_reproduce) <= 5000),
  impact              TEXT CHECK (length(impact) <= 1000),
  status              TEXT NOT NULL DEFAULT 'pending'
                      CHECK (status IN ('pending', 'approved', 'rejected', 'credited')),
  credit_amount_cents INTEGER NOT NULL DEFAULT 0
                      CHECK (credit_amount_cents >= 0 AND credit_amount_cents <= 100000),
  reviewed_by         UUID REFERENCES users(id),
  reviewed_at         TIMESTAMPTZ,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_bug_reports_user ON bug_reports(user_id);
CREATE INDEX IF NOT EXISTS idx_bug_reports_status ON bug_reports(status);
CREATE INDEX IF NOT EXISTS idx_bug_reports_created ON bug_reports(created_at);

INSERT INTO schema_migrations (version, description) VALUES
  ('1.4.0', 'Add swarm-dc plan and bug_reports table for bug bounty system'),
  ('1.4.1', 'Add swarm-mixed plan for residential scraper bots')
ON CONFLICT (version) DO NOTHING;

-- ─── Referral Codes ──────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS referral_codes (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       UUID NOT NULL REFERENCES users(id),
  -- SHA-256 hex is always exactly 64 characters
  code_hash     TEXT NOT NULL CHECK (length(code_hash) = 64),
  code_prefix   TEXT NOT NULL CHECK (length(code_prefix) <= 10),
  max_uses      INTEGER NOT NULL DEFAULT 0
                CHECK (max_uses >= 0 AND max_uses <= 100000),
  uses          INTEGER NOT NULL DEFAULT 0
                CHECK (uses >= 0),
  credit_cents  INTEGER NOT NULL DEFAULT 100
                CHECK (credit_cents >= 0 AND credit_cents <= 100000),
  active        BOOLEAN NOT NULL DEFAULT true,
  expires_at    TIMESTAMPTZ,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_referral_codes_hash
  ON referral_codes(code_hash) WHERE active = true;
CREATE INDEX IF NOT EXISTS idx_referral_codes_user
  ON referral_codes(user_id);
CREATE INDEX IF NOT EXISTS idx_referral_codes_created
  ON referral_codes(created_at);

-- ─── Referral Redemptions ────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS referral_redemptions (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  referral_code_id UUID NOT NULL REFERENCES referral_codes(id),
  referrer_id      UUID NOT NULL REFERENCES users(id),
  referee_id       UUID NOT NULL REFERENCES users(id),
  credit_cents     INTEGER NOT NULL CHECK (credit_cents >= 0 AND credit_cents <= 100000),
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(referee_id)
);

CREATE INDEX IF NOT EXISTS idx_referral_redemptions_referrer
  ON referral_redemptions(referrer_id);
CREATE INDEX IF NOT EXISTS idx_referral_redemptions_created
  ON referral_redemptions(created_at);

-- ─── Affiliate Links ─────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS affiliate_links (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  referrer_id  UUID NOT NULL REFERENCES users(id),
  referee_id   UUID NOT NULL REFERENCES users(id),
  active       BOOLEAN NOT NULL DEFAULT true,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(referee_id)
);

CREATE INDEX IF NOT EXISTS idx_affiliate_links_referrer
  ON affiliate_links(referrer_id);

-- ─── Affiliate Commissions ───────────────────────────────────────────

CREATE TABLE IF NOT EXISTS affiliate_commissions (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  referrer_id     UUID NOT NULL REFERENCES users(id),
  referee_id      UUID NOT NULL REFERENCES users(id),
  payment_id      TEXT NOT NULL,
  topup_cents     INTEGER NOT NULL CHECK (topup_cents > 0 AND topup_cents <= 214748364),
  commission_cents INTEGER NOT NULL CHECK (commission_cents >= 0 AND commission_cents <= 214748364),
  commission_rate  INTEGER NOT NULL CHECK (commission_rate >= 0 AND commission_rate <= 10000),
  status          TEXT NOT NULL DEFAULT 'pending'
                  CHECK (status IN ('pending', 'credited', 'cancelled')),
  credited_at     TIMESTAMPTZ,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(payment_id)
);

CREATE INDEX IF NOT EXISTS idx_affiliate_commissions_referrer
  ON affiliate_commissions(referrer_id);
CREATE INDEX IF NOT EXISTS idx_affiliate_commissions_status
  ON affiliate_commissions(status);
CREATE INDEX IF NOT EXISTS idx_affiliate_commissions_created
  ON affiliate_commissions(created_at);

-- ─── Promo Codes ─────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS promo_codes (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  admin_user_id UUID NOT NULL REFERENCES users(id),
  -- SHA-256 hex is always exactly 64 characters
  code_hash     TEXT NOT NULL CHECK (length(code_hash) = 64),
  code_prefix   TEXT NOT NULL CHECK (length(code_prefix) <= 10),
  credit_cents  INTEGER NOT NULL CHECK (credit_cents > 0 AND credit_cents <= 100000),
  max_uses      INTEGER NOT NULL DEFAULT 0
                CHECK (max_uses >= 0 AND max_uses <= 1000000),
  uses          INTEGER NOT NULL DEFAULT 0
                CHECK (uses >= 0),
  active        BOOLEAN NOT NULL DEFAULT true,
  expires_at    TIMESTAMPTZ,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_promo_codes_hash
  ON promo_codes(code_hash) WHERE active = true;
CREATE INDEX IF NOT EXISTS idx_promo_codes_created
  ON promo_codes(created_at);

-- ─── Promo Redemptions ───────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS promo_redemptions (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  promo_code_id UUID NOT NULL REFERENCES promo_codes(id),
  user_id       UUID NOT NULL REFERENCES users(id),
  credit_cents  INTEGER NOT NULL CHECK (credit_cents > 0 AND credit_cents <= 100000),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(promo_code_id, user_id)
);

CREATE INDEX IF NOT EXISTS idx_promo_redemptions_user
  ON promo_redemptions(user_id);
CREATE INDEX IF NOT EXISTS idx_promo_redemptions_created
  ON promo_redemptions(created_at);

-- ─── Loyalty Tiers ───────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS loyalty_tiers (
  id                  TEXT PRIMARY KEY,
  name                TEXT NOT NULL CHECK (length(name) <= 50),
  min_spend_bytes     BIGINT NOT NULL DEFAULT 0
                      CHECK (min_spend_bytes >= 0),
  cashback_basis_pts  INTEGER NOT NULL DEFAULT 0
                      CHECK (cashback_basis_pts >= 0 AND cashback_basis_pts <= 5000),
  sort_order          INTEGER NOT NULL DEFAULT 0
);

-- Seed loyalty tiers
INSERT INTO loyalty_tiers (id, name, min_spend_bytes, cashback_basis_pts, sort_order) VALUES
  ('none',   'None',   0,               0,    0),
  ('bronze', 'Bronze', 1073741824,      200,  1),
  ('silver', 'Silver', 10737418240,     500,  2),
  ('gold',   'Gold',   53687091200,     1000, 3)
ON CONFLICT (id) DO UPDATE SET
  name = EXCLUDED.name,
  min_spend_bytes = EXCLUDED.min_spend_bytes,
  cashback_basis_pts = EXCLUDED.cashback_basis_pts,
  sort_order = EXCLUDED.sort_order;

-- ─── Loyalty Rewards ─────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS loyalty_rewards (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       UUID NOT NULL REFERENCES users(id),
  tier_id       TEXT NOT NULL REFERENCES loyalty_tiers(id),
  period_start  DATE NOT NULL,
  period_end    DATE NOT NULL,
  spend_cents   INTEGER NOT NULL DEFAULT 0
                CHECK (spend_cents >= 0 AND spend_cents <= 214748364),
  reward_cents  INTEGER NOT NULL DEFAULT 0
                CHECK (reward_cents >= 0 AND reward_cents <= 214748364),
  status        TEXT NOT NULL DEFAULT 'pending'
                CHECK (status IN ('pending', 'credited')),
  credited_at   TIMESTAMPTZ,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(user_id, period_start)
);

CREATE INDEX IF NOT EXISTS idx_loyalty_rewards_user
  ON loyalty_rewards(user_id);
CREATE INDEX IF NOT EXISTS idx_loyalty_rewards_status
  ON loyalty_rewards(status);
CREATE INDEX IF NOT EXISTS idx_loyalty_rewards_created
  ON loyalty_rewards(created_at);

-- Retention policies for referral/affiliate/promo/loyalty tables
INSERT INTO data_retention_policies (table_name, retention_days, description) VALUES
  ('referral_codes',         730, 'Referral codes retained for 2 years'),
  ('referral_redemptions',   730, 'Referral redemptions retained for 2 years'),
  ('affiliate_links',        730, 'Affiliate links retained for 2 years'),
  ('affiliate_commissions',  730, 'Affiliate commissions retained for 2 years'),
  ('promo_codes',            730, 'Promo codes retained for 2 years'),
  ('promo_redemptions',      730, 'Promo redemptions retained for 2 years'),
  ('loyalty_rewards',        730, 'Loyalty rewards retained for 2 years')
ON CONFLICT (table_name) DO NOTHING;

INSERT INTO schema_migrations (version, description) VALUES
  ('1.5.0', 'Add referral codes, affiliate commissions, promo codes, loyalty tiers/rewards tables')
ON CONFLICT (version) DO NOTHING;

-- ─── Proof-of-Work Challenges ──────────────────────────────────────

CREATE TABLE IF NOT EXISTS pow_challenges (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  prefix      TEXT NOT NULL,
  difficulty  INTEGER NOT NULL DEFAULT 20
              CHECK (difficulty >= 10 AND difficulty <= 32),
  ip_address  TEXT NOT NULL
              CHECK (length(ip_address) <= 45),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  consumed    BOOLEAN NOT NULL DEFAULT false
);

-- Partial index for fast lookup of unconsumed challenges
CREATE INDEX IF NOT EXISTS idx_pow_challenges_created
  ON pow_challenges(created_at);
CREATE INDEX IF NOT EXISTS idx_pow_challenges_ip_active
  ON pow_challenges(ip_address) WHERE NOT consumed;

ALTER TABLE pow_challenges ADD CONSTRAINT chk_pow_prefix_length
  CHECK (length(prefix) >= 16 AND length(prefix) <= 128);

-- ─── Per-Agent Secrets ─────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS agent_secrets (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  secret_hash TEXT NOT NULL
              CHECK (length(secret_hash) = 64),
  label       TEXT NOT NULL DEFAULT ''
              CHECK (length(label) <= 100),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  revoked_at  TIMESTAMPTZ,
  last_used   TIMESTAMPTZ
);

-- Fast lookup by hash for per-request auth (only active secrets)
CREATE UNIQUE INDEX IF NOT EXISTS idx_agent_secrets_hash
  ON agent_secrets(secret_hash) WHERE revoked_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_agent_secrets_user
  ON agent_secrets(user_id);

-- Retention policies for new tables
INSERT INTO data_retention_policies (table_name, retention_days, description) VALUES
  ('pow_challenges',  1, 'PoW challenges purged after 1 day'),
  ('agent_secrets', 730, 'Agent secrets retained for 2 years')
ON CONFLICT (table_name) DO NOTHING;

INSERT INTO schema_migrations (version, description) VALUES
  ('1.6.0', 'Add PoW challenges and per-agent secrets tables for autonomous AI agent registration')
ON CONFLICT (version) DO NOTHING;
