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

-- CHECK constraint on proxy_type. Add-only (never drop): the relay migration
-- later widens it to include 'relay'; on rerun duplicate_object keeps that.
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

-- Add admin_role column for three-tier admin hierarchy (idempotent)
-- root_admin: only the account named in root_admin_identity — can grant/revoke all admin roles
-- cybersecurity_admin: manages bug bounties, credits, plus all admin duties
-- admin: user management, waitlist, revenue, stats, plans
DO $$ BEGIN
  ALTER TABLE users ADD COLUMN admin_role TEXT NOT NULL DEFAULT 'none'
    CHECK (admin_role IN ('none', 'admin', 'cybersecurity_admin', 'root_admin'));
EXCEPTION WHEN duplicate_column THEN NULL;
END $$;

-- Backfill: sync admin_role from is_admin for existing admins
UPDATE users SET admin_role = 'admin' WHERE is_admin = true AND admin_role = 'none';

-- Root admin identity: a single row set by the operator with
-- `npm run admin:set-root -- <email>` (needs direct DB access). Not an env var
-- and not in source, so neither the API nor a config change can create a root.
CREATE TABLE IF NOT EXISTS root_admin_identity (
  singleton BOOLEAN PRIMARY KEY DEFAULT true CHECK (singleton),
  email TEXT NOT NULL CHECK (length(email) BETWEEN 3 AND 254 AND email = LOWER(email)),
  set_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Existing deployments: adopt the current root admin, if any, as the identity.
INSERT INTO root_admin_identity (email)
  SELECT LOWER(email) FROM users WHERE admin_role = 'root_admin' AND status = 'active'
  ORDER BY created_at LIMIT 1
ON CONFLICT (singleton) DO NOTHING;

-- DB trigger: root_admin only for the configured identity + keep is_admin in sync
CREATE OR REPLACE FUNCTION enforce_admin_role_constraints() RETURNS TRIGGER AS $$
BEGIN
  IF NEW.admin_role = 'root_admin' AND NOT EXISTS (
    SELECT 1 FROM root_admin_identity WHERE email = LOWER(NEW.email)
  ) THEN
    RAISE EXCEPTION 'root_admin role restricted to the configured root admin identity';
  END IF;
  NEW.is_admin := (NEW.admin_role != 'none');
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_enforce_admin_role ON users;
CREATE TRIGGER trg_enforce_admin_role
  BEFORE INSERT OR UPDATE ON users
  FOR EACH ROW EXECUTE FUNCTION enforce_admin_role_constraints();

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
-- Set when /refresh rotates a token; a re-presented token rotated within the
-- grace window is a concurrent refresh, not theft (no family revoke).
ALTER TABLE refresh_tokens ADD COLUMN IF NOT EXISTS rotated_at TIMESTAMPTZ;
-- SHA-256 of the issuing client's User-Agent + IP prefix. The rotation grace
-- window only applies when the presenter matches the client that received the
-- successor token; otherwise the re-presented token is treated as theft.
ALTER TABLE refresh_tokens ADD COLUMN IF NOT EXISTS client_hash TEXT
  CHECK (client_hash IS NULL OR length(client_hash) = 64);

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
  -- Only widen when the constraint does not already allow x402. A rerun must
  -- not narrow it again (the relay migration below adds 'tempo').
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'payment_invoices_provider_check'
      AND pg_get_constraintdef(oid) LIKE '%x402%'
  ) THEN
    ALTER TABLE payment_invoices DROP CONSTRAINT IF EXISTS payment_invoices_provider_check;
    ALTER TABLE payment_invoices ADD CONSTRAINT payment_invoices_provider_check
      CHECK (provider IN ('stripe', 'nowpayments', 'paypal', 'x402'));
  END IF;
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

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chk_pow_prefix_length') THEN
    ALTER TABLE pow_challenges ADD CONSTRAINT chk_pow_prefix_length
      CHECK (length(prefix) >= 16 AND length(prefix) <= 128);
  END IF;
END $$;

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

-- ═══════════════════════════════════════════════════════════════════
-- Agent Relay Network (docs/agent-network/DESIGN.md §5, §6, §15 Rev 1)
-- All money in integer µUSD (1 cent = 10_000 µUSD). Idempotent.
-- ═══════════════════════════════════════════════════════════════════

-- ─── Nodes ──────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS nodes (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_user_id       UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  owner_wallet        TEXT NOT NULL CHECK (owner_wallet ~ '^0x[0-9a-f]{40}$'),
  node_key_hash       TEXT NOT NULL UNIQUE CHECK (length(node_key_hash) = 64),
  node_pubkey         TEXT UNIQUE CHECK (node_pubkey IS NULL OR node_pubkey ~ '^[0-9a-f]{64}$'),
  status              TEXT NOT NULL DEFAULT 'pending'
                      CHECK (status IN ('pending','active','cooldown','quarantined','suspended','revoked')),
  attestation_version INTEGER NOT NULL CHECK (attestation_version BETWEEN 1 AND 100000),
  attestation_sig     TEXT NOT NULL CHECK (length(attestation_sig) BETWEEN 132 AND 200),
  observed_ip         INET,
  ip_prefix24         CIDR,
  asn                 BIGINT CHECK (asn IS NULL OR asn BETWEEN 0 AND 4294967295),
  country             CHAR(2) CHECK (country IS NULL OR country ~ '^[A-Z]{2}$'),
  ip_class            TEXT CHECK (ip_class IS NULL OR ip_class IN ('residential','dc','mobile','unknown')),
  max_streams         INTEGER NOT NULL DEFAULT 32 CHECK (max_streams BETWEEN 1 AND 1024),
  max_gb_day          INTEGER NOT NULL DEFAULT 5  CHECK (max_gb_day BETWEEN 1 AND 10000),
  reputation          INTEGER NOT NULL DEFAULT 3000 CHECK (reputation BETWEEN 0 AND 10000),
  byte_disputes       INTEGER NOT NULL DEFAULT 0 CHECK (byte_disputes BETWEEN 0 AND 1000000),
  agent_version       TEXT CHECK (agent_version IS NULL OR length(agent_version) <= 32),
  floor_hash          TEXT CHECK (floor_hash IS NULL OR length(floor_hash) = 64),
  last_seen_at        TIMESTAMPTZ,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_nodes_owner ON nodes(owner_user_id);
CREATE INDEX IF NOT EXISTS idx_nodes_select ON nodes(status, country, ip_class);
CREATE INDEX IF NOT EXISTS idx_nodes_prefix ON nodes(ip_prefix24) WHERE status IN ('pending','active');

-- Consumed atomically via DELETE ... RETURNING (like wallet_challenges)
CREATE TABLE IF NOT EXISTS node_challenges (
  nonce_hash   TEXT PRIMARY KEY CHECK (length(nonce_hash) = 64),
  user_id      UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at   TIMESTAMPTZ NOT NULL,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_node_challenges_expires ON node_challenges(expires_at);

CREATE TABLE IF NOT EXISTS node_daily_stats (
  node_id   UUID NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
  day       DATE NOT NULL,
  bytes     BIGINT  NOT NULL DEFAULT 0 CHECK (bytes BETWEEN 0 AND 1000000000000000),
  streams   INTEGER NOT NULL DEFAULT 0 CHECK (streams BETWEEN 0 AND 2000000000),
  failures  INTEGER NOT NULL DEFAULT 0 CHECK (failures BETWEEN 0 AND 2000000000),
  burns     INTEGER NOT NULL DEFAULT 0 CHECK (burns BETWEEN 0 AND 2000000000),
  PRIMARY KEY (node_id, day)
);

CREATE TABLE IF NOT EXISTS node_reputation (
  node_id        UUID NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
  target_etld1   TEXT NOT NULL CHECK (length(target_etld1) BETWEEN 1 AND 253),
  ok_count       INTEGER NOT NULL DEFAULT 0 CHECK (ok_count BETWEEN 0 AND 2147483647),
  burn_count     INTEGER NOT NULL DEFAULT 0 CHECK (burn_count BETWEEN 0 AND 2147483647),
  cooldown_until TIMESTAMPTZ,
  PRIMARY KEY (node_id, target_etld1)
);

-- ─── Coordinator policy (published at /v1/policy) ───────────────────

CREATE TABLE IF NOT EXISTS network_policy (
  version      SERIAL PRIMARY KEY,
  body         JSONB NOT NULL CHECK (pg_column_size(body) <= 262144),
  body_sha256  TEXT NOT NULL CHECK (length(body_sha256) = 64),
  created_by   UUID REFERENCES users(id),
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ─── Pricing (per ip_class; 'any' = default) ────────────────────────

CREATE TABLE IF NOT EXISTS network_pricing (
  ip_class          TEXT PRIMARY KEY CHECK (ip_class IN ('any','residential','dc','mobile')),
  price_per_gb_musd BIGINT NOT NULL CHECK (price_per_gb_musd BETWEEN 1000 AND 5000000),
  updated_by        UUID REFERENCES users(id),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);
-- Rev 1 §15: residential $0.50/GB, dc $0.20/GB
INSERT INTO network_pricing (ip_class, price_per_gb_musd) VALUES
  ('any',         200000),
  ('residential', 500000),
  ('dc',          200000)
ON CONFLICT (ip_class) DO NOTHING;

-- ─── Revenue split config (append-only, versioned) ──────────────────
-- Rev 1: the per-charge share comes from node_tiers; this table keeps
-- maturation settings. node_share_bps capped at 5000 (§15 hard ceiling).

CREATE TABLE IF NOT EXISTS revenue_split_config (
  id                 SERIAL PRIMARY KEY,
  node_share_bps     INTEGER NOT NULL CHECK (node_share_bps BETWEEN 0 AND 5000),
  maturation_hours   INTEGER NOT NULL DEFAULT 168 CHECK (maturation_hours BETWEEN 0 AND 2160),
  effective_from     TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by         UUID REFERENCES users(id),
  note               TEXT CHECK (note IS NULL OR length(note) <= 500),
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);
INSERT INTO revenue_split_config (node_share_bps, note)
  SELECT 2500, 'seed (probation default; per-owner share from node_tiers)'
  WHERE NOT EXISTS (SELECT 1 FROM revenue_split_config);

-- ─── Node tiers (Rev 1 §15) ─────────────────────────────────────────

CREATE TABLE IF NOT EXISTS node_tiers (
  id                       SMALLINT PRIMARY KEY CHECK (id BETWEEN 1 AND 100),
  name                     TEXT NOT NULL UNIQUE CHECK (length(name) BETWEEN 1 AND 32),
  rank                     SMALLINT NOT NULL UNIQUE CHECK (rank BETWEEN 0 AND 100),
  node_share_bps           INTEGER NOT NULL CHECK (node_share_bps BETWEEN 0 AND 5000),
  min_tenure_days          INTEGER NOT NULL CHECK (min_tenure_days BETWEEN 0 AND 3650),
  min_uptime_bps           INTEGER NOT NULL CHECK (min_uptime_bps BETWEEN 0 AND 10000),
  min_active_ips           INTEGER NOT NULL CHECK (min_active_ips BETWEEN 0 AND 1000000),
  min_reputation           INTEGER NOT NULL CHECK (min_reputation BETWEEN 0 AND 10000),
  no_clawback_days         INTEGER NOT NULL DEFAULT 0 CHECK (no_clawback_days BETWEEN 0 AND 3650),
  hold_days                INTEGER NOT NULL CHECK (hold_days BETWEEN 0 AND 90),
  max_nodes                INTEGER NOT NULL CHECK (max_nodes BETWEEN 1 AND 100000),
  daily_withdraw_limit_musd BIGINT NOT NULL CHECK (daily_withdraw_limit_musd BETWEEN 0 AND 100000000000),
  updated_by               UUID REFERENCES users(id),
  updated_at               TIMESTAMPTZ NOT NULL DEFAULT now()
);
INSERT INTO node_tiers (id, name, rank, node_share_bps, min_tenure_days, min_uptime_bps,
                        min_active_ips, min_reputation, no_clawback_days, hold_days,
                        max_nodes, daily_withdraw_limit_musd) VALUES
  (1, 'probation', 0, 2500,   0,    0,  1, 3000,  0, 14,   10,   50000000),
  (2, 'bronze',    1, 3000,   7, 8000,  1, 5000,  0,  7,   25,  250000000),
  (3, 'silver',    2, 3500,  30, 9000,  3, 6000,  0,  7,  100,  500000000),
  (4, 'gold',      3, 4000,  60, 9300, 10, 7000,  0,  5,  500, 1000000000),
  (5, 'platinum',  4, 4500,  90, 9500, 25, 8000,  0,  3, 2000, 2500000000),
  (6, 'partner',   5, 5000, 180, 9700, 50, 8500, 90,  3, 2000, 5000000000)
ON CONFLICT (id) DO NOTHING;

-- Owner tier columns (per beneficial owner; recalculated daily)
ALTER TABLE users ADD COLUMN IF NOT EXISTS node_tier_id SMALLINT REFERENCES node_tiers(id);
ALTER TABLE users ADD COLUMN IF NOT EXISTS node_tier_changed_at TIMESTAMPTZ;
ALTER TABLE users ADD COLUMN IF NOT EXISTS node_tier_grace_until TIMESTAMPTZ;
ALTER TABLE users ADD COLUMN IF NOT EXISTS node_tier_demotion_reason TEXT;
DO $$ BEGIN
  ALTER TABLE users ADD CONSTRAINT chk_users_node_tier_demotion_reason
    CHECK (node_tier_demotion_reason IS NULL OR length(node_tier_demotion_reason) <= 200);
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- ─── Existing-table changes (must precede relay_charges FK use) ─────

ALTER TABLE sessions ADD COLUMN IF NOT EXISTS node_id UUID REFERENCES nodes(id) ON DELETE SET NULL;
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS dest_port INTEGER;
DO $$ BEGIN
  ALTER TABLE sessions ADD CONSTRAINT chk_sessions_dest_port
    CHECK (dest_port IS NULL OR dest_port BETWEEN 1 AND 65535);
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
CREATE INDEX IF NOT EXISTS idx_sessions_node ON sessions(node_id) WHERE node_id IS NOT NULL;

DO $$ BEGIN
  ALTER TABLE usage_records DROP CONSTRAINT IF EXISTS chk_usage_proxy_type;
  ALTER TABLE usage_records DROP CONSTRAINT IF EXISTS usage_records_proxy_type_check;
  ALTER TABLE usage_records ADD CONSTRAINT chk_usage_proxy_type
    CHECK (proxy_type IN ('dc', 'residential', 'relay'));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'payment_invoices_provider_check'
      AND pg_get_constraintdef(oid) LIKE '%tempo%'
  ) THEN
    ALTER TABLE payment_invoices DROP CONSTRAINT IF EXISTS payment_invoices_provider_check;
    ALTER TABLE payment_invoices ADD CONSTRAINT payment_invoices_provider_check
      CHECK (provider IN ('stripe', 'nowpayments', 'paypal', 'x402', 'tempo'));
  END IF;
END $$;

-- ─── Per-charge split ledger ────────────────────────────────────────

CREATE TABLE IF NOT EXISTS relay_charges (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  -- GDPR: financial ledger rows are retained but anonymised; references to
  -- deleted users/nodes/sessions become NULL. Writers must always set them.
  session_id         UUID UNIQUE REFERENCES sessions(id) ON DELETE SET NULL,
  requester_user_id  UUID REFERENCES users(id) ON DELETE SET NULL,
  node_id            UUID REFERENCES nodes(id) ON DELETE SET NULL,
  node_owner_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  payment_rail       TEXT NOT NULL CHECK (payment_rail IN ('wallet','team','agentic_wallet','x402','mpp','free')),
  bytes_gateway      BIGINT NOT NULL CHECK (bytes_gateway BETWEEN 0 AND 1099511627776),
  bytes_node         BIGINT CHECK (bytes_node IS NULL OR bytes_node BETWEEN 0 AND 1099511627776),
  price_per_gb_musd  BIGINT NOT NULL CHECK (price_per_gb_musd BETWEEN 1000 AND 5000000),
  gross_musd         BIGINT NOT NULL CHECK (gross_musd BETWEEN 0 AND 2147483647000000),
  node_musd          BIGINT NOT NULL CHECK (node_musd BETWEEN 0 AND 2147483647000000),
  platform_musd      BIGINT NOT NULL CHECK (platform_musd BETWEEN 0 AND 2147483647000000),
  split_config_id    INTEGER NOT NULL REFERENCES revenue_split_config(id),
  tier_id            SMALLINT NOT NULL REFERENCES node_tiers(id),
  node_share_bps     INTEGER NOT NULL CHECK (node_share_bps BETWEEN 0 AND 5000),
  zero_reason        TEXT CHECK (zero_reason IS NULL OR zero_reason IN ('self_dealing','quarantined','collusion_hold','free_tier')),
  disputed           BOOLEAN NOT NULL DEFAULT false,
  matures_at         TIMESTAMPTZ NOT NULL,
  matured            BOOLEAN NOT NULL DEFAULT false,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT chk_rc_split_sum CHECK (node_musd + platform_musd = gross_musd)
);
CREATE INDEX IF NOT EXISTS idx_rc_created ON relay_charges(created_at);
CREATE INDEX IF NOT EXISTS idx_rc_node ON relay_charges(node_id, created_at);
CREATE INDEX IF NOT EXISTS idx_rc_owner ON relay_charges(node_owner_user_id, created_at);
CREATE INDEX IF NOT EXISTS idx_rc_mature ON relay_charges(matures_at) WHERE NOT matured AND NOT disputed;

-- ─── Node credits (off-chain earnings ledger) ───────────────────────

CREATE TABLE IF NOT EXISTS node_credit_accounts (
  user_id          UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  pending_musd     BIGINT NOT NULL DEFAULT 0 CHECK (pending_musd   BETWEEN 0 AND 1000000000000000),
  available_musd   BIGINT NOT NULL DEFAULT 0 CHECK (available_musd BETWEEN 0 AND 1000000000000000),
  auto_convert_pct INTEGER NOT NULL DEFAULT 0 CHECK (auto_convert_pct BETWEEN 0 AND 100),
  frozen           BOOLEAN NOT NULL DEFAULT false,
  -- §15 tax: W-9/W-8 collected at $1,500 cumulative/year; payouts above
  -- $2,000 held ('held_tax') until received.
  tax_form_status       TEXT NOT NULL DEFAULT 'not_required'
                        CHECK (tax_form_status IN ('not_required','requested','received','rejected')),
  tax_form_type         TEXT CHECK (tax_form_type IS NULL OR tax_form_type IN ('W-9','W-8BEN','W-8BEN-E')),
  tax_form_received_at  TIMESTAMPTZ,
  tax_year              SMALLINT CHECK (tax_year IS NULL OR tax_year BETWEEN 2020 AND 2100),
  ytd_paid_musd         BIGINT NOT NULL DEFAULT 0 CHECK (ytd_paid_musd BETWEEN 0 AND 1000000000000000),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT chk_nca_tax_received CHECK ((tax_form_status = 'received') = (tax_form_received_at IS NOT NULL))
);
-- FOLLOW-UP (repository commits): the GDPR deletion transaction must, in the
-- same BEGIN/COMMIT, delete node_challenges/node_credit_transactions rows and
-- rely on the SET NULL FKs above for relay_charges, node_payouts and sessions.

CREATE TABLE IF NOT EXISTS node_credit_transactions (
  id              BIGSERIAL PRIMARY KEY,
  user_id         UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  type            TEXT NOT NULL CHECK (type IN ('earn','mature','clawback','convert_to_wallet','withdraw','withdraw_reversal')),
  amount_musd     BIGINT NOT NULL CHECK (amount_musd BETWEEN 1 AND 1000000000000000),
  relay_charge_id UUID REFERENCES relay_charges(id),
  external_ref    TEXT CHECK (external_ref IS NULL OR length(external_ref) <= 128),
  created_by      UUID REFERENCES users(id),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_nct_user ON node_credit_transactions(user_id, created_at);
CREATE INDEX IF NOT EXISTS idx_nct_charge ON node_credit_transactions(relay_charge_id)
  WHERE relay_charge_id IS NOT NULL;

-- ─── Metadata-only abuse log: NO payload/url/path/query columns ─────

CREATE TABLE IF NOT EXISTS relay_abuse_log (
  id                BIGSERIAL PRIMARY KEY,
  ts                TIMESTAMPTZ NOT NULL DEFAULT now(),
  session_id        UUID NOT NULL,
  requester_user_id UUID NOT NULL,
  node_id           UUID NOT NULL,
  dest_host         TEXT NOT NULL CHECK (length(dest_host) BETWEEN 1 AND 253),
  dest_port         INTEGER NOT NULL CHECK (dest_port BETWEEN 1 AND 65535),
  bytes             BIGINT NOT NULL CHECK (bytes BETWEEN 0 AND 1099511627776)
);
CREATE INDEX IF NOT EXISTS idx_ral_node_ts ON relay_abuse_log(node_id, ts);
CREATE INDEX IF NOT EXISTS idx_ral_ts ON relay_abuse_log(ts);

-- ─── MPP idempotency (x402 keeps x402_transactions) ─────────────────

ALTER TABLE x402_transactions ADD COLUMN IF NOT EXISTS facilitator TEXT;
DO $$ BEGIN
  ALTER TABLE x402_transactions ADD CONSTRAINT x402_facilitator_chk
    CHECK (facilitator IS NULL OR facilitator IN ('coinbase','payai','selfhosted'));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

CREATE TABLE IF NOT EXISTS mpp_transactions (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  payment_hash TEXT NOT NULL UNIQUE CHECK (length(payment_hash) = 64),
  user_id      UUID REFERENCES users(id),
  amount_musd  BIGINT NOT NULL CHECK (amount_musd BETWEEN 1 AND 10000000000),
  status       TEXT NOT NULL CHECK (status IN ('claimed','verified','settled','failed','released')),
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_mpp_user ON mpp_transactions(user_id) WHERE user_id IS NOT NULL;
-- Overpayment above the per-payment cap: served for the cap, the rest awaits reconciliation
-- (refund or credit to the payer). Any uint256 transfer value fits.
ALTER TABLE mpp_transactions ADD COLUMN IF NOT EXISTS excess_musd NUMERIC(78,0) NOT NULL DEFAULT 0
  CHECK (excess_musd >= 0 AND excess_musd < 1e78);
CREATE INDEX IF NOT EXISTS idx_mpp_excess ON mpp_transactions(created_at) WHERE excess_musd > 0;

-- ─── Payouts (Rev 1 §15: USDC push on Base) ─────────────────────────

CREATE TABLE IF NOT EXISTS payout_wallets (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id           UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  address           TEXT NOT NULL CHECK (address ~ '^0x[0-9a-f]{40}$'),
  chain             TEXT NOT NULL DEFAULT 'base' CHECK (chain IN ('base','base-sepolia')),
  status            TEXT NOT NULL DEFAULT 'pending'
                    CHECK (status IN ('pending','active','superseded','blocked')),
  ofac_checked_at   TIMESTAMPTZ,
  change_sig        TEXT CHECK (change_sig IS NULL OR length(change_sig) BETWEEN 132 AND 200),
  active_from       TIMESTAMPTZ NOT NULL DEFAULT now(),   -- +72h cooldown on change
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_payout_wallets_one_live
  ON payout_wallets(user_id) WHERE status IN ('pending','active');
CREATE INDEX IF NOT EXISTS idx_payout_wallets_address ON payout_wallets(address);

CREATE TABLE IF NOT EXISTS node_payouts (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  -- GDPR: payout history retained (tax/audit) but anonymised on user deletion.
  user_id           UUID REFERENCES users(id) ON DELETE SET NULL,
  payout_wallet_id  UUID REFERENCES payout_wallets(id) ON DELETE SET NULL,
  idempotency_key   TEXT NOT NULL CHECK (length(idempotency_key) BETWEEN 8 AND 128),
  amount_musd       BIGINT NOT NULL CHECK (amount_musd BETWEEN 1 AND 100000000000),
  trigger           TEXT NOT NULL CHECK (trigger IN ('auto','on_demand')),
  status            TEXT NOT NULL DEFAULT 'pending'
                    CHECK (status IN ('pending','held_tax','submitted','confirmed','failed','reversed')),
  batch_id          UUID,
  tx_hash           TEXT CHECK (tx_hash IS NULL OR tx_hash ~ '^0x[0-9a-f]{64}$'),
  failure_reason    TEXT CHECK (failure_reason IS NULL OR length(failure_reason) <= 200),
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (user_id, idempotency_key)
);
CREATE INDEX IF NOT EXISTS idx_node_payouts_user ON node_payouts(user_id, created_at);
CREATE INDEX IF NOT EXISTS idx_node_payouts_status ON node_payouts(status) WHERE status IN ('pending','submitted');

INSERT INTO data_retention_policies (table_name, retention_days, description) VALUES
  ('node_challenges', 1,  'Node registration challenges purged after 1 day'),
  ('relay_abuse_log', 90, 'Relay metadata-only abuse log (policy.logRetentionDays may shorten)')
ON CONFLICT (table_name) DO NOTHING;

INSERT INTO schema_migrations (version, description) VALUES
  ('1.7.0', 'Agent relay network: nodes, pricing, tiers, relay charges, node credits, payouts')
ON CONFLICT (version) DO NOTHING;

-- ─── Relay follow-ups: sub-cent carry, byte disputes, node signing key ───
-- Fractional µUSD owed by a payer below one cent (DESIGN.md §6, ECONOMICS.md).
ALTER TABLE wallets ADD COLUMN IF NOT EXISTS carry_musd BIGINT NOT NULL DEFAULT 0;
DO $$ BEGIN
  ALTER TABLE wallets ADD CONSTRAINT chk_wallets_carry_musd CHECK (carry_musd BETWEEN 0 AND 9999);
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
ALTER TABLE team_wallets ADD COLUMN IF NOT EXISTS carry_musd BIGINT NOT NULL DEFAULT 0;
DO $$ BEGIN
  ALTER TABLE team_wallets ADD CONSTRAINT chk_team_wallets_carry_musd CHECK (carry_musd BETWEEN 0 AND 9999);
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

CREATE TABLE IF NOT EXISTS byte_disputes (
  id               BIGSERIAL PRIMARY KEY,
  relay_charge_id  UUID REFERENCES relay_charges(id) ON DELETE SET NULL,
  node_id          UUID REFERENCES nodes(id) ON DELETE SET NULL,
  bytes_gateway    BIGINT NOT NULL CHECK (bytes_gateway BETWEEN 0 AND 1099511627776),
  bytes_node       BIGINT NOT NULL CHECK (bytes_node BETWEEN 0 AND 1099511627776),
  status           TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','resolved_gateway','resolved_node','dismissed')),
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  resolved_at      TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_byte_disputes_node ON byte_disputes(node_id, created_at);
CREATE INDEX IF NOT EXISTS idx_byte_disputes_open ON byte_disputes(created_at) WHERE status = 'open';


-- ─── Relay settle retries: durable retry for failed settleRelayCharge ───
-- settleRelayCharge is idempotent on session_id, so a retry can never double
-- charge. The payload is the full settle input (bigints as decimal strings).
CREATE TABLE IF NOT EXISTS relay_settle_retries (
  session_id       UUID PRIMARY KEY REFERENCES sessions(id) ON DELETE CASCADE,
  requester_user_id UUID NOT NULL,
  bytes_gateway    BIGINT NOT NULL CHECK (bytes_gateway BETWEEN 0 AND 1099511627776),
  bytes_in         BIGINT NOT NULL CHECK (bytes_in BETWEEN 0 AND 1099511627776),
  bytes_out        BIGINT NOT NULL CHECK (bytes_out BETWEEN 0 AND 1099511627776),
  payload          JSONB NOT NULL CHECK (octet_length(payload::text) <= 8192),
  attempts         INTEGER NOT NULL DEFAULT 0 CHECK (attempts BETWEEN 0 AND 1000),
  status           TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','done','dead')),
  last_error       TEXT CHECK (last_error IS NULL OR length(last_error) <= 500),
  next_attempt_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_relay_settle_retries_due ON relay_settle_retries(next_attempt_at) WHERE status = 'pending';

-- ─── Shared relay limits across gateway instances (DESIGN.md §4, §11) ───
-- node_ip_slots: one row per connected node, claimed at tunnel auth and
-- released on disconnect. Rows whose instance stopped heartbeating expire.
CREATE TABLE IF NOT EXISTS node_ip_slots (
  node_id      UUID PRIMARY KEY REFERENCES nodes(id) ON DELETE CASCADE,
  instance_id  TEXT NOT NULL CHECK (length(instance_id) BETWEEN 1 AND 64),
  ip           INET NOT NULL,
  prefix24     TEXT NOT NULL CHECK (length(prefix24) BETWEEN 1 AND 64),
  asn          BIGINT CHECK (asn IS NULL OR asn BETWEEN 0 AND 4294967295),
  heartbeat_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_node_ip_slots_ip ON node_ip_slots(ip);
CREATE INDEX IF NOT EXISTS idx_node_ip_slots_prefix ON node_ip_slots(prefix24);
CREATE INDEX IF NOT EXISTS idx_node_ip_slots_asn ON node_ip_slots(asn);
CREATE INDEX IF NOT EXISTS idx_node_ip_slots_instance ON node_ip_slots(instance_id);

-- requester_spend_daily: settled relay spend per requester per UTC day.
CREATE TABLE IF NOT EXISTS requester_spend_daily (
  user_id       UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  day           DATE NOT NULL,
  settled_musd  BIGINT NOT NULL DEFAULT 0 CHECK (settled_musd >= 0 AND settled_musd <= 1000000000000000),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, day)
);
CREATE INDEX IF NOT EXISTS idx_requester_spend_daily_day ON requester_spend_daily(day);

-- requester_spend_inflight: per-instance in-flight reservations (expire with heartbeat).
CREATE TABLE IF NOT EXISTS requester_spend_inflight (
  user_id       UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  instance_id   TEXT NOT NULL CHECK (length(instance_id) BETWEEN 1 AND 64),
  inflight_musd BIGINT NOT NULL DEFAULT 0 CHECK (inflight_musd >= 0 AND inflight_musd <= 1000000000000000),
  heartbeat_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, instance_id)
);
CREATE INDEX IF NOT EXISTS idx_requester_spend_inflight_instance ON requester_spend_inflight(instance_id);

-- requester_rate_window: per-second request counters (rows older than a minute are swept).
CREATE TABLE IF NOT EXISTS requester_rate_window (
  user_id  UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  sec      BIGINT NOT NULL CHECK (sec >= 0 AND sec <= 100000000000),
  count    INTEGER NOT NULL DEFAULT 0 CHECK (count >= 0 AND count <= 1000000),
  PRIMARY KEY (user_id, sec)
);
CREATE INDEX IF NOT EXISTS idx_requester_rate_window_sec ON requester_rate_window(sec);

-- ─── node_payouts: 'held_frozen' (payouts held while the credit account is frozen) ───
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'node_payouts'::regclass AND conname = 'node_payouts_status_check'
      AND pg_get_constraintdef(oid) LIKE '%held_frozen%'
  ) THEN
    ALTER TABLE node_payouts DROP CONSTRAINT IF EXISTS node_payouts_status_check;
    ALTER TABLE node_payouts ADD CONSTRAINT node_payouts_status_check
      CHECK (status IN ('pending','held_tax','held_frozen','submitted','confirmed','failed','reversed'));
  END IF;
END $$;

-- ─── payer_identities: non-EVM x402 payers (e.g. Solana) → wallet-identity user ───
-- users.wallet_address stays EVM-only (0x + 40 hex). A Solana payer maps to a
-- synthetic wallet-identity user through this table instead.
CREATE TABLE IF NOT EXISTS payer_identities (
  chain       TEXT NOT NULL CHECK (chain IN ('solana')),
  address     TEXT NOT NULL CHECK (length(address) BETWEEN 32 AND 44 AND address ~ '^[1-9A-HJ-NP-Za-km-z]+$'),
  user_id     UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (chain, address)
);
CREATE INDEX IF NOT EXISTS idx_payer_identities_user ON payer_identities(user_id);

-- ─── Admin control panel (ADMIN_API.md): job heartbeats + read indexes ───
-- One row per background job, upserted by the gateway job runner after each
-- run (skipped advisory-lock ticks are not recorded).
CREATE TABLE IF NOT EXISTS job_runs (
  job_name          TEXT PRIMARY KEY CHECK (length(job_name) BETWEEN 1 AND 64),
  instance_id       TEXT NOT NULL CHECK (length(instance_id) BETWEEN 1 AND 64),
  last_started_at   TIMESTAMPTZ NOT NULL,
  last_finished_at  TIMESTAMPTZ NOT NULL,
  last_ok           BOOLEAN NOT NULL,
  last_error        TEXT CHECK (last_error IS NULL OR length(last_error) <= 200),
  last_duration_ms  INTEGER NOT NULL CHECK (last_duration_ms BETWEEN 0 AND 2147483647),
  last_success_at   TIMESTAMPTZ,
  run_count         BIGINT NOT NULL DEFAULT 0 CHECK (run_count BETWEEN 0 AND 9000000000000000000),
  fail_count        BIGINT NOT NULL DEFAULT 0 CHECK (fail_count BETWEEN 0 AND 9000000000000000000)
);

CREATE INDEX IF NOT EXISTS idx_rc_requester ON relay_charges(requester_user_id, created_at);
CREATE INDEX IF NOT EXISTS idx_nodes_last_seen ON nodes(last_seen_at);
CREATE INDEX IF NOT EXISTS idx_nodes_created ON nodes(created_at);
CREATE INDEX IF NOT EXISTS idx_ral_requester_ts ON relay_abuse_log(requester_user_id, ts);
CREATE INDEX IF NOT EXISTS idx_ral_host_ts ON relay_abuse_log(dest_host, ts);
CREATE INDEX IF NOT EXISTS idx_node_payouts_status_created ON node_payouts(status, created_at);
CREATE INDEX IF NOT EXISTS idx_byte_disputes_status_created ON byte_disputes(status, created_at);
CREATE INDEX IF NOT EXISTS idx_audit_events_action_created ON audit_events(action, created_at);
CREATE INDEX IF NOT EXISTS idx_nca_frozen ON node_credit_accounts(user_id) WHERE frozen;

-- ─── Agent self-service API (AGENT_API.md) ──────────────────────────
-- Owner-lowered per-node request rate cap (NULL = policy default).
ALTER TABLE nodes ADD COLUMN IF NOT EXISTS max_req_per_sec INTEGER;
DO $$ BEGIN
  ALTER TABLE nodes ADD CONSTRAINT chk_nodes_max_req_per_sec
    CHECK (max_req_per_sec IS NULL OR max_req_per_sec BETWEEN 1 AND 100000);
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- Single-use EIP-191 challenges for payout-wallet set/change and withdraw.
-- Consumed atomically via DELETE ... RETURNING; the signed message binds
-- action, user, address/amount and nonce.
CREATE TABLE IF NOT EXISTS agent_sign_challenges (
  nonce_hash   TEXT PRIMARY KEY CHECK (length(nonce_hash) = 64),
  user_id      UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  action       TEXT NOT NULL CHECK (action IN ('payout_wallet_set','withdraw')),
  message      TEXT NOT NULL CHECK (length(message) BETWEEN 1 AND 2000),
  expires_at   TIMESTAMPTZ NOT NULL,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_agent_sign_challenges_user ON agent_sign_challenges(user_id, expires_at);

-- Requester burn reports (DESIGN.md §4): ≤5 per requester per node per UTC day.
-- weight is filled in later (30-day spend weighting); NULL = unweighted.
CREATE TABLE IF NOT EXISTS node_reports (
  id                BIGSERIAL PRIMARY KEY,
  session_id        UUID REFERENCES sessions(id) ON DELETE SET NULL,
  node_id           UUID NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
  reporter_user_id  UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  reason            TEXT NOT NULL CHECK (reason IN ('blocked','captcha','rate_limited','slow','bad_content','other')),
  day               DATE NOT NULL DEFAULT (now() AT TIME ZONE 'UTC')::date,
  weight            INTEGER CHECK (weight IS NULL OR weight BETWEEN 0 AND 10000),
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (session_id, reporter_user_id)
);
CREATE INDEX IF NOT EXISTS idx_node_reports_cap ON node_reports(reporter_user_id, node_id, day);
CREATE INDEX IF NOT EXISTS idx_node_reports_node ON node_reports(node_id, created_at);

INSERT INTO data_retention_policies (table_name, retention_days, description) VALUES
  ('agent_sign_challenges', 1, 'Agent payout/withdraw signing challenges purged after 1 day')
ON CONFLICT (table_name) DO NOTHING;

-- ─── Burn-report reputation penalty (DESIGN.md §4, §15) ─────────────
-- Recomputed hourly by the report-reputation job from node_reports weighted by
-- each reporter's 30-day paid spend, with decay. Effective reputation used for
-- selection, quarantine and tiers = GREATEST(0, reputation - report_penalty).
ALTER TABLE nodes ADD COLUMN IF NOT EXISTS report_penalty INTEGER NOT NULL DEFAULT 0;
DO $$ BEGIN
  ALTER TABLE nodes ADD CONSTRAINT chk_nodes_report_penalty CHECK (report_penalty BETWEEN 0 AND 10000);
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
CREATE INDEX IF NOT EXISTS idx_nodes_report_penalty ON nodes(id) WHERE report_penalty > 0;
CREATE INDEX IF NOT EXISTS idx_node_reports_created ON node_reports(created_at);

-- ─── Collusion detector (DESIGN.md §13 commit 33, §11) ──────────────
-- Admin-tunable thresholds (singleton row). auto_freeze is off by default.
CREATE TABLE IF NOT EXISTS collusion_settings (
  id                      SMALLINT PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  window_days             INTEGER NOT NULL DEFAULT 30 CHECK (window_days BETWEEN 1 AND 90),
  min_node_volume_musd    BIGINT  NOT NULL DEFAULT 5000000 CHECK (min_node_volume_musd BETWEEN 0 AND 1000000000000),
  concentration_bps       INTEGER NOT NULL DEFAULT 8000 CHECK (concentration_bps BETWEEN 1 AND 10000),
  cluster_size            INTEGER NOT NULL DEFAULT 3 CHECK (cluster_size BETWEEN 2 AND 20),
  cluster_bps             INTEGER NOT NULL DEFAULT 9500 CHECK (cluster_bps BETWEEN 1 AND 10000),
  circular_min_musd       BIGINT  NOT NULL DEFAULT 1000000 CHECK (circular_min_musd BETWEEN 0 AND 1000000000000),
  auto_freeze             BOOLEAN NOT NULL DEFAULT false,
  freeze_bps              INTEGER NOT NULL DEFAULT 9500 CHECK (freeze_bps BETWEEN 1 AND 10000),
  freeze_min_volume_musd  BIGINT  NOT NULL DEFAULT 50000000 CHECK (freeze_min_volume_musd BETWEEN 0 AND 1000000000000),
  updated_by              UUID REFERENCES users(id) ON DELETE SET NULL,
  updated_at              TIMESTAMPTZ NOT NULL DEFAULT now()
);
INSERT INTO collusion_settings (id) VALUES (1) ON CONFLICT (id) DO NOTHING;

-- One open flag per (kind, owner, node, requester); re-detections refresh it.
CREATE TABLE IF NOT EXISTS collusion_flags (
  id                 BIGSERIAL PRIMARY KEY,
  kind               TEXT NOT NULL CHECK (kind IN ('concentration','cluster','circular','report_penalty')),
  owner_user_id      UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  node_id            UUID REFERENCES nodes(id) ON DELETE CASCADE,
  requester_user_id  UUID REFERENCES users(id) ON DELETE CASCADE,
  share_bps          INTEGER NOT NULL CHECK (share_bps BETWEEN 0 AND 10000),
  volume_musd        BIGINT  NOT NULL CHECK (volume_musd BETWEEN 0 AND 2147483647000000),
  total_musd         BIGINT  NOT NULL CHECK (total_musd BETWEEN 0 AND 2147483647000000),
  window_days        INTEGER NOT NULL CHECK (window_days BETWEEN 1 AND 90),
  status             TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','dismissed','confirmed')),
  auto_frozen        BOOLEAN NOT NULL DEFAULT false,
  resolved_by        UUID REFERENCES users(id) ON DELETE SET NULL,
  resolution_note    TEXT CHECK (resolution_note IS NULL OR length(resolution_note) <= 500),
  first_seen_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_seen_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  resolved_at        TIMESTAMPTZ
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_collusion_flags_open ON collusion_flags (
  kind, owner_user_id,
  COALESCE(node_id, '00000000-0000-0000-0000-000000000000'::uuid),
  COALESCE(requester_user_id, '00000000-0000-0000-0000-000000000000'::uuid)
) WHERE status = 'open';
CREATE INDEX IF NOT EXISTS idx_collusion_flags_status ON collusion_flags(status, last_seen_at DESC);
CREATE INDEX IF NOT EXISTS idx_collusion_flags_owner ON collusion_flags(owner_user_id);
-- 'report_penalty': burn-report penalty alone would quarantine a node; admin review instead.
DO $$ BEGIN
  ALTER TABLE collusion_flags DROP CONSTRAINT IF EXISTS collusion_flags_kind_check;
  ALTER TABLE collusion_flags ADD CONSTRAINT collusion_flags_kind_check
    CHECK (kind IN ('concentration','cluster','circular','report_penalty'));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- ═══════════════════════════════════════════════════════════════════
-- Launch readiness (docs/agent-network LAUNCH_PLAN §4–§11). Idempotent.
-- ═══════════════════════════════════════════════════════════════════

-- ─── Operator-run seed nodes (admin flag; reported separately) ──────
ALTER TABLE nodes ADD COLUMN IF NOT EXISTS operator_run BOOLEAN NOT NULL DEFAULT false;
CREATE INDEX IF NOT EXISTS idx_nodes_operator_run ON nodes(id) WHERE operator_run;

-- ─── Starter credits (LAUNCH_PLAN §5.2) ─────────────────────────────
-- One grant per new agent principal, on its first verified wallet identity.
-- Credited to the requester wallet (non-withdrawable, like all requester
-- balance), tracked here, expired after expiry_days, never a tier input.
CREATE TABLE IF NOT EXISTS starter_credit_settings (
  id                      SMALLINT PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  enabled                 BOOLEAN NOT NULL DEFAULT false,
  amount_musd             BIGINT  NOT NULL DEFAULT 500000 CHECK (amount_musd BETWEEN 10000 AND 100000000 AND amount_musd % 10000 = 0),
  daily_budget_musd       BIGINT  NOT NULL DEFAULT 50000000 CHECK (daily_budget_musd BETWEEN 0 AND 100000000000),
  per_prefix_cap          INTEGER NOT NULL DEFAULT 1 CHECK (per_prefix_cap BETWEEN 0 AND 1000),
  per_funding_source_cap  INTEGER NOT NULL DEFAULT 1 CHECK (per_funding_source_cap BETWEEN 0 AND 1000),
  cap_window_days         INTEGER NOT NULL DEFAULT 30 CHECK (cap_window_days BETWEEN 1 AND 3650),
  expiry_days             INTEGER NOT NULL DEFAULT 30 CHECK (expiry_days BETWEEN 1 AND 365),
  seed_nodes_only         BOOLEAN NOT NULL DEFAULT true,
  seed_only_days          INTEGER NOT NULL DEFAULT 30 CHECK (seed_only_days BETWEEN 0 AND 365),
  updated_by              UUID REFERENCES users(id) ON DELETE SET NULL,
  updated_at              TIMESTAMPTZ NOT NULL DEFAULT now()
);
INSERT INTO starter_credit_settings (id) VALUES (1) ON CONFLICT (id) DO NOTHING;

CREATE TABLE IF NOT EXISTS starter_credit_grants (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         UUID NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE,
  amount_musd     BIGINT NOT NULL CHECK (amount_musd BETWEEN 10000 AND 100000000),
  remaining_musd  BIGINT NOT NULL CHECK (remaining_musd BETWEEN 0 AND 100000000),
  ip_prefix       CIDR,
  funding_source  TEXT NOT NULL CHECK (length(funding_source) BETWEEN 1 AND 128),
  status          TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','exhausted','expired','revoked')),
  expires_at      TIMESTAMPTZ NOT NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  closed_at       TIMESTAMPTZ,
  CONSTRAINT chk_scg_remaining CHECK (remaining_musd <= amount_musd)
);
CREATE INDEX IF NOT EXISTS idx_scg_created ON starter_credit_grants(created_at);
CREATE INDEX IF NOT EXISTS idx_scg_prefix ON starter_credit_grants(ip_prefix, created_at);
CREATE INDEX IF NOT EXISTS idx_scg_funding ON starter_credit_grants(funding_source, created_at);
CREATE INDEX IF NOT EXISTS idx_scg_due ON starter_credit_grants(expires_at) WHERE status = 'active';

CREATE TABLE IF NOT EXISTS starter_credit_ledger (
  id               BIGSERIAL PRIMARY KEY,
  grant_id         UUID NOT NULL REFERENCES starter_credit_grants(id) ON DELETE CASCADE,
  type             TEXT NOT NULL CHECK (type IN ('grant','spend','expire','revoke')),
  amount_musd      BIGINT NOT NULL CHECK (amount_musd BETWEEN 0 AND 100000000),
  relay_charge_id  UUID REFERENCES relay_charges(id) ON DELETE SET NULL,
  created_by       UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_scl_grant ON starter_credit_ledger(grant_id, created_at);

-- Portion of a relay charge paid from starter credit; such charges are not tier inputs.
ALTER TABLE relay_charges ADD COLUMN IF NOT EXISTS starter_musd BIGINT NOT NULL DEFAULT 0;
DO $$ BEGIN
  ALTER TABLE relay_charges ADD CONSTRAINT chk_rc_starter_musd CHECK (starter_musd BETWEEN 0 AND 100000000);
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- ─── Contribution requirement allowlist (policy.requireContribution) ───
CREATE TABLE IF NOT EXISTS contribution_allowlist (
  user_id     UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  note        TEXT CHECK (note IS NULL OR length(note) <= 500),
  created_by  UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ─── Genesis boost (LAUNCH_PLAN §4.2) ───────────────────────────────
-- First max_owners community node owners (ordered by their first paid,
-- non-self-dealing charge; operator-run and admin principals excluded) get
-- +bonus_bps on top of their tier share for boost_days (never above the 5000
-- ceiling), plus a one-time credit after credit_threshold_bytes of matured
-- paid traffic from other principals, held for the owner tier's hold days.
CREATE TABLE IF NOT EXISTS genesis_settings (
  id                      SMALLINT PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  enabled                 BOOLEAN NOT NULL DEFAULT true,
  max_owners              INTEGER NOT NULL DEFAULT 200 CHECK (max_owners BETWEEN 0 AND 100000),
  bonus_bps               INTEGER NOT NULL DEFAULT 500 CHECK (bonus_bps BETWEEN 0 AND 5000),
  boost_days              INTEGER NOT NULL DEFAULT 90 CHECK (boost_days BETWEEN 1 AND 3650),
  credit_musd             BIGINT  NOT NULL DEFAULT 5000000 CHECK (credit_musd BETWEEN 0 AND 1000000000),
  credit_threshold_bytes  BIGINT  NOT NULL DEFAULT 5000000000 CHECK (credit_threshold_bytes BETWEEN 0 AND 1000000000000000),
  updated_by              UUID REFERENCES users(id) ON DELETE SET NULL,
  updated_at              TIMESTAMPTZ NOT NULL DEFAULT now()
);
INSERT INTO genesis_settings (id) VALUES (1) ON CONFLICT (id) DO NOTHING;

CREATE TABLE IF NOT EXISTS genesis_members (
  owner_user_id      UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  seq                INTEGER NOT NULL UNIQUE CHECK (seq BETWEEN 1 AND 100000),
  enrolled_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  boost_until        TIMESTAMPTZ NOT NULL,
  credit_status      TEXT NOT NULL DEFAULT 'pending' CHECK (credit_status IN ('pending','held','matured','clawed_back')),
  credit_musd        BIGINT CHECK (credit_musd IS NULL OR credit_musd BETWEEN 1 AND 1000000000),
  credit_granted_at  TIMESTAMPTZ,
  credit_matures_at  TIMESTAMPTZ,
  CONSTRAINT chk_gm_credit CHECK ((credit_status = 'pending') = (credit_granted_at IS NULL))
);
CREATE INDEX IF NOT EXISTS idx_gm_credit_status ON genesis_members(credit_status, credit_matures_at);

-- Snapshot of the genesis bonus included in node_share_bps (audit).
ALTER TABLE relay_charges ADD COLUMN IF NOT EXISTS genesis_bonus_bps INTEGER NOT NULL DEFAULT 0;
DO $$ BEGIN
  ALTER TABLE relay_charges ADD CONSTRAINT chk_rc_genesis_bonus_bps CHECK (genesis_bonus_bps BETWEEN 0 AND 5000 AND genesis_bonus_bps <= node_share_bps);
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- ─── Buyer discounts for node contributors (owner tier) ─────────────
-- Funded from the platform share only: node_musd is computed on the list
-- gross; the requester pays list - discount (= gross_musd); the discount is
-- clamped so platform_musd >= list * min_platform_margin_bps.
ALTER TABLE node_tiers ADD COLUMN IF NOT EXISTS buyer_discount_bps INTEGER NOT NULL DEFAULT 0;
DO $$ BEGIN
  ALTER TABLE node_tiers ADD CONSTRAINT chk_node_tiers_buyer_discount_bps CHECK (buyer_discount_bps BETWEEN 0 AND 5000);
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
UPDATE node_tiers t SET buyer_discount_bps = d.bps
FROM (VALUES (1, 0), (2, 500), (3, 1000), (4, 1500), (5, 2000), (6, 2500)) AS d(id, bps)
WHERE t.id = d.id AND NOT EXISTS (SELECT 1 FROM schema_migrations WHERE version = '1.9.0');

CREATE TABLE IF NOT EXISTS buyer_discount_settings (
  id                      SMALLINT PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  enabled                 BOOLEAN NOT NULL DEFAULT true,
  min_platform_margin_bps INTEGER NOT NULL DEFAULT 2500 CHECK (min_platform_margin_bps BETWEEN 0 AND 10000),
  updated_by              UUID REFERENCES users(id) ON DELETE SET NULL,
  updated_at              TIMESTAMPTZ NOT NULL DEFAULT now()
);
INSERT INTO buyer_discount_settings (id) VALUES (1) ON CONFLICT (id) DO NOTHING;

ALTER TABLE relay_charges ADD COLUMN IF NOT EXISTS list_gross_musd BIGINT;
ALTER TABLE relay_charges ADD COLUMN IF NOT EXISTS buyer_discount_bps INTEGER NOT NULL DEFAULT 0;
ALTER TABLE relay_charges ADD COLUMN IF NOT EXISTS discount_musd BIGINT NOT NULL DEFAULT 0;
ALTER TABLE relay_charges ADD COLUMN IF NOT EXISTS buyer_tier_id SMALLINT REFERENCES node_tiers(id);
DO $$ BEGIN
  ALTER TABLE relay_charges ADD CONSTRAINT chk_rc_buyer_discount CHECK (
    buyer_discount_bps BETWEEN 0 AND 5000
    AND discount_musd BETWEEN 0 AND 2147483647000000
    AND (list_gross_musd IS NULL OR (list_gross_musd BETWEEN 0 AND 2147483647000000
         AND list_gross_musd = gross_musd + discount_musd))
  );
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

INSERT INTO schema_migrations (version, description) VALUES
  ('1.9.0', 'Launch readiness: seed nodes, starter credits, genesis boost, buyer discounts, status, unmet demand, abuse reports')
ON CONFLICT (version) DO NOTHING;

-- ─── Public network status (hourly snapshots + incident log) ────────
-- Aggregates only: no node ids, IPs or requester ids.
CREATE TABLE IF NOT EXISTS network_stats_snapshots (
  hour                      TIMESTAMPTZ PRIMARY KEY,
  online_nodes              INTEGER NOT NULL CHECK (online_nodes BETWEEN 0 AND 10000000),
  seed_online               INTEGER NOT NULL CHECK (seed_online BETWEEN 0 AND 10000000),
  community_online          INTEGER NOT NULL CHECK (community_online BETWEEN 0 AND 10000000),
  countries                 INTEGER NOT NULL CHECK (countries BETWEEN 0 AND 300),
  asns                      INTEGER NOT NULL CHECK (asns BETWEEN 0 AND 10000000),
  success_rate_bps          INTEGER CHECK (success_rate_bps IS NULL OR success_rate_bps BETWEEN 0 AND 10000),
  p50_ms                    INTEGER CHECK (p50_ms IS NULL OR p50_ms BETWEEN 0 AND 3600000),
  p95_ms                    INTEGER CHECK (p95_ms IS NULL OR p95_ms BETWEEN 0 AND 3600000),
  paid_bytes_24h            BIGINT NOT NULL CHECK (paid_bytes_24h BETWEEN 0 AND 1000000000000000000),
  seed_paid_bytes_24h       BIGINT NOT NULL CHECK (seed_paid_bytes_24h BETWEEN 0 AND 1000000000000000000),
  community_paid_bytes_24h  BIGINT NOT NULL CHECK (community_paid_bytes_24h BETWEEN 0 AND 1000000000000000000),
  by_class                  JSONB NOT NULL DEFAULT '{}'::jsonb CHECK (pg_column_size(by_class) <= 4096),
  created_at                TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS network_incidents (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  title        TEXT NOT NULL CHECK (length(title) BETWEEN 1 AND 200),
  body         TEXT NOT NULL DEFAULT '' CHECK (length(body) <= 5000),
  severity     TEXT NOT NULL CHECK (severity IN ('minor','major','critical','maintenance')),
  status       TEXT NOT NULL DEFAULT 'investigating' CHECK (status IN ('investigating','identified','monitoring','resolved')),
  started_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  resolved_at  TIMESTAMPTZ,
  created_by   UUID REFERENCES users(id) ON DELETE SET NULL,
  updated_by   UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT chk_incident_resolved CHECK ((status = 'resolved') = (resolved_at IS NOT NULL))
);
CREATE INDEX IF NOT EXISTS idx_network_incidents_started ON network_incidents(started_at DESC);

-- ─── Unmet demand: selections that found no eligible node ───────────
-- Aggregated (hour, country, ip_class) counts only: no requester ids, no hosts.
CREATE TABLE IF NOT EXISTS unmet_demand_hourly (
  hour      TIMESTAMPTZ NOT NULL,
  country   TEXT NOT NULL CHECK (country = '' OR country ~ '^[A-Z]{2}$'),
  ip_class  TEXT NOT NULL CHECK (ip_class IN ('', 'residential', 'dc', 'mobile')),
  requests  INTEGER NOT NULL DEFAULT 0 CHECK (requests BETWEEN 0 AND 2000000000),
  PRIMARY KEY (hour, country, ip_class)
);
CREATE INDEX IF NOT EXISTS idx_unmet_demand_hour ON unmet_demand_hourly(hour);

-- ─── Public abuse-report intake (PoW gated, no account) ─────────────
-- Stores the destination host, the time window and a description only; no
-- reporter IP. Triage cross-references relay_abuse_log (metadata-only).
CREATE TABLE IF NOT EXISTS abuse_reports (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  dest_host       TEXT NOT NULL CHECK (length(dest_host) BETWEEN 1 AND 253),
  window_start    TIMESTAMPTZ NOT NULL,
  window_end      TIMESTAMPTZ NOT NULL,
  category        TEXT NOT NULL DEFAULT 'other' CHECK (category IN ('spam','credential_stuffing','scraping','fraud','ddos','illegal_content','other')),
  description     TEXT NOT NULL CHECK (length(description) BETWEEN 10 AND 4000),
  contact         TEXT CHECK (contact IS NULL OR length(contact) <= 254),
  status          TEXT NOT NULL DEFAULT 'new' CHECK (status IN ('new','triaged','actioned','dismissed')),
  admin_note      TEXT CHECK (admin_note IS NULL OR length(admin_note) <= 2000),
  triaged_by      UUID REFERENCES users(id) ON DELETE SET NULL,
  triaged_at      TIMESTAMPTZ,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT chk_abuse_window CHECK (window_end >= window_start AND window_end - window_start <= interval '31 days')
);
CREATE INDEX IF NOT EXISTS idx_abuse_reports_status ON abuse_reports(status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_abuse_reports_host ON abuse_reports(dest_host, created_at);
INSERT INTO data_retention_policies (table_name, retention_days, description) VALUES
  ('abuse_reports', 365, 'Closed (actioned/dismissed) public abuse reports purged after 1 year')
ON CONFLICT (table_name) DO NOTHING;

-- ─── Launch gaps: genesis payer diversity, starter-credit funding check, announcements ───
-- Genesis entry needs matured paid traffic from this many distinct, unlinked paying principals.
ALTER TABLE genesis_settings ADD COLUMN IF NOT EXISTS min_distinct_payers INTEGER NOT NULL DEFAULT 3;
DO $$ BEGIN
  ALTER TABLE genesis_settings ADD CONSTRAINT chk_genesis_min_payers CHECK (min_distinct_payers BETWEEN 1 AND 1000);
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- Starter credit only for funded principals: prior on-chain tx on Base (nonce >= 1)
-- or a top-up of at least min_topup_cents. Fails closed when the RPC is unavailable.
ALTER TABLE starter_credit_settings ADD COLUMN IF NOT EXISTS require_funding BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE starter_credit_settings ADD COLUMN IF NOT EXISTS min_topup_cents INTEGER NOT NULL DEFAULT 100;
DO $$ BEGIN
  ALTER TABLE starter_credit_settings ADD CONSTRAINT chk_scs_min_topup CHECK (min_topup_cents BETWEEN 1 AND 100000);
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- Agent-facing changelog / news feed (GET /v1/announcements). Public, admin-managed.
CREATE TABLE IF NOT EXISTS network_announcements (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  title         TEXT NOT NULL CHECK (length(title) BETWEEN 1 AND 200),
  body          TEXT NOT NULL DEFAULT '' CHECK (length(body) <= 10000),
  category      TEXT NOT NULL DEFAULT 'news' CHECK (category IN ('policy','pricing','payments','api','network','news')),
  url           TEXT CHECK (url IS NULL OR (length(url) <= 500 AND url ~ '^https://')),
  published     BOOLEAN NOT NULL DEFAULT true,
  published_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by    UUID REFERENCES users(id) ON DELETE SET NULL,
  updated_by    UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_network_announcements_pub ON network_announcements(published_at DESC) WHERE published;

-- Mobile exits are priced like residential ($0.50/GB). Without this row mobile
-- traffic used to fall back to the cheap 'any' price. Idempotent.
INSERT INTO network_pricing (ip_class, price_per_gb_musd) VALUES ('mobile', 500000)
ON CONFLICT (ip_class) DO NOTHING;

-- x402 quotes are per exit class (incl. mobile) or 'any' (highest price). Idempotent.
DO $$ BEGIN
  ALTER TABLE x402_transactions DROP CONSTRAINT IF EXISTS x402_transactions_pool_type_check;
  ALTER TABLE x402_transactions ADD CONSTRAINT x402_transactions_pool_type_check
    CHECK (pool_type IN ('dc', 'residential', 'mobile', 'any'));
END $$;

-- Retention: sessions are kept 90 days but usage_records (365d) and
-- agentic_wallet_transactions (730d) reference them. With the default NO ACTION
-- the sessions purge failed on every batch. Ledger/usage rows outlive their
-- session; the reference becomes NULL when the session is purged. Idempotent.
ALTER TABLE usage_records ALTER COLUMN session_id DROP NOT NULL;
DO $$ BEGIN
  ALTER TABLE usage_records DROP CONSTRAINT IF EXISTS usage_records_session_id_fkey;
  ALTER TABLE usage_records ADD CONSTRAINT usage_records_session_id_fkey
    FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE SET NULL;
  ALTER TABLE agentic_wallet_transactions DROP CONSTRAINT IF EXISTS agentic_wallet_transactions_session_id_fkey;
  ALTER TABLE agentic_wallet_transactions ADD CONSTRAINT agentic_wallet_transactions_session_id_fkey
    FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE SET NULL;
END $$;

-- ─── Verified exit classes: 'masked' + tier weights (ECONOMICS.md) ──
-- Class list mirrors packages/shared/src/exit-classes.ts. Idempotent.
DO $$ BEGIN
  ALTER TABLE nodes DROP CONSTRAINT IF EXISTS nodes_ip_class_check;
  ALTER TABLE nodes ADD CONSTRAINT nodes_ip_class_check
    CHECK (ip_class IS NULL OR ip_class IN ('residential','mobile','dc','masked','unknown'));
  ALTER TABLE network_pricing DROP CONSTRAINT IF EXISTS network_pricing_ip_class_check;
  ALTER TABLE network_pricing ADD CONSTRAINT network_pricing_ip_class_check
    CHECK (ip_class IN ('any','residential','mobile','dc','masked'));
  ALTER TABLE unmet_demand_hourly DROP CONSTRAINT IF EXISTS unmet_demand_hourly_ip_class_check;
  ALTER TABLE unmet_demand_hourly ADD CONSTRAINT unmet_demand_hourly_ip_class_check
    CHECK (ip_class IN ('', 'residential', 'mobile', 'dc', 'masked'));
  ALTER TABLE x402_transactions DROP CONSTRAINT IF EXISTS x402_transactions_pool_type_check;
  ALTER TABLE x402_transactions ADD CONSTRAINT x402_transactions_pool_type_check
    CHECK (pool_type IN ('dc', 'residential', 'mobile', 'masked', 'any'));
  ALTER TABLE collusion_flags DROP CONSTRAINT IF EXISTS collusion_flags_kind_check;
  ALTER TABLE collusion_flags ADD CONSTRAINT collusion_flags_kind_check
    CHECK (kind IN ('concentration','cluster','circular','report_penalty','egress_mismatch'));
END $$;

-- Owner-declared class (informational; the effective class is the verified ip_class).
ALTER TABLE nodes ADD COLUMN IF NOT EXISTS declared_class TEXT;
ALTER TABLE nodes ADD COLUMN IF NOT EXISTS class_verified_at TIMESTAMPTZ;
DO $$ BEGIN
  ALTER TABLE nodes ADD CONSTRAINT chk_nodes_declared_class
    CHECK (declared_class IS NULL OR declared_class IN ('residential','mobile','dc','masked'));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- Masked exits: $0.10/GB default (admin-tunable).
INSERT INTO network_pricing (ip_class, price_per_gb_musd) VALUES ('masked', 100000)
ON CONFLICT (ip_class) DO NOTHING;

-- Tier-credit weight per class (bps, 10000 = 1.0). Defaults are seeded only
-- when the column is first added, so later admin changes survive re-runs.
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                 WHERE table_schema = current_schema() AND table_name = 'network_pricing'
                   AND column_name = 'tier_weight_bps') THEN
    ALTER TABLE network_pricing ADD COLUMN tier_weight_bps INTEGER NOT NULL DEFAULT 10000
      CHECK (tier_weight_bps BETWEEN 0 AND 10000);
    UPDATE network_pricing SET tier_weight_bps = 4000 WHERE ip_class = 'dc';
    UPDATE network_pricing SET tier_weight_bps = 2500 WHERE ip_class = 'masked';
  END IF;
END $$;

-- Tier weight snapshotted at session start (like node_share_bps); NULL = pre-feature row.
ALTER TABLE relay_charges ADD COLUMN IF NOT EXISTS tier_weight_bps INTEGER;
DO $$ BEGIN
  ALTER TABLE relay_charges ADD CONSTRAINT chk_rc_tier_weight_bps
    CHECK (tier_weight_bps IS NULL OR tier_weight_bps BETWEEN 0 AND 10000);
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
