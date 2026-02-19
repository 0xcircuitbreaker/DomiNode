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

-- R24 C-2: UNIQUE constraint prevents silent key collision on active keys
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

-- R30 H-2: CHECK constraint on proxy_type
DO $$ BEGIN
  ALTER TABLE usage_records ADD CONSTRAINT chk_usage_proxy_type
    CHECK (proxy_type IN ('dc', 'residential'));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- R31 C-1: CHECK constraints on usage_records bytes and cost columns
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
  provider      TEXT NOT NULL CHECK (provider IN ('stripe', 'nowpayments')),
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
  ('agent',  'AI Agent',      500, 5368709120,      false, 50)
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

-- Set per-plan session rate limits
UPDATE plans SET max_sessions_per_minute = 30 WHERE id IN ('free', 'payg');
UPDATE plans SET max_sessions_per_minute = 60 WHERE id IN ('vol100', 'vol1tb', 'agent');

-- ─── allowed_proxy_types column (Beta free-tier restructure) ─────────
DO $$ BEGIN
  ALTER TABLE plans ADD COLUMN allowed_proxy_types TEXT;
EXCEPTION WHEN duplicate_column THEN NULL;
END $$;

-- Beta free plans: free-dc (2 GB DC only) and free-res (50 MB residential only)
INSERT INTO plans (id, name, price_per_gb_cents, monthly_bandwidth_bytes, is_default, max_connections, max_sessions_per_minute, allowed_proxy_types) VALUES
  ('free-dc',  'Free DC',          0, 2147483648,   true,  5, 30, 'dc'),
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

-- ─── Record current schema version ──────────────────────────────────

INSERT INTO schema_migrations (version, description) VALUES
  ('1.0.0', 'Initial production schema: users, api_keys, wallets, sessions, usage_records, plans, MFA, wallet auth, audit events, data retention')
ON CONFLICT (version) DO NOTHING;
