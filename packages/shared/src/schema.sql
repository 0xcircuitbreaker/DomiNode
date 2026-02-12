-- DomiNode database schema

CREATE EXTENSION IF NOT EXISTS "pgcrypto";

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

CREATE INDEX IF NOT EXISTS idx_api_keys_hash
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

-- ─── Plans ─────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS plans (
  id                    TEXT PRIMARY KEY,
  name                  TEXT NOT NULL,
  price_per_gb_cents    INTEGER NOT NULL,
  monthly_bandwidth_bytes BIGINT NOT NULL DEFAULT 0,
  is_default            BOOLEAN NOT NULL DEFAULT false
);

-- Seed plans
INSERT INTO plans (id, name, price_per_gb_cents, monthly_bandwidth_bytes, is_default) VALUES
  ('free',   'Free Trial',    500, 107374182,      false),
  ('payg',   'Pay As You Go', 500, 0,              true),
  ('vol100', 'Volume 100GB',  400, 107374182400,   false),
  ('vol1tb', 'Volume 1TB',    300, 1099511627776,  false)
ON CONFLICT (id) DO NOTHING;

-- Add plan to users (idempotent)
DO $$ BEGIN
  ALTER TABLE users ADD COLUMN plan_id TEXT NOT NULL DEFAULT 'payg' REFERENCES plans(id);
EXCEPTION WHEN duplicate_column THEN NULL;
END $$;

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

CREATE INDEX IF NOT EXISTS idx_refresh_tokens_hash
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
  ('wallet_transactions', 730, 'Wallet transactions retained for 2 years')
ON CONFLICT (table_name) DO NOTHING;
