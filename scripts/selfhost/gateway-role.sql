-- Least-privilege Postgres role for a gateway on another host (split self-host).
-- Applied by scripts/selfhost/install.sh on the coordinator after every migrate,
-- with the password set by psql: \set pw <GATEWAY_DB_PASSWORD>. Idempotent.
--
-- The gateway is the internet-facing box. It gets row access (SELECT, INSERT,
-- UPDATE, DELETE) on the tables its code and jobs use, narrowed further below
-- for accounts, credentials, audit and admin-set configuration, USAGE on
-- sequences, and nothing else: no superuser, no CREATE/DDL, no TRUNCATE/TRIGGER/REFERENCES,
-- no COPY ... TO PROGRAM or server file access (pg_execute_server_program,
-- pg_read_server_files, pg_write_server_files), no replication, no new roles.
-- Migrations keep running as the coordinator's owner role.

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'dominusnode_gateway') THEN
    CREATE ROLE dominusnode_gateway LOGIN;
  END IF;
END $$;

ALTER ROLE dominusnode_gateway WITH LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE
  NOREPLICATION NOBYPASSRLS NOINHERIT CONNECTION LIMIT 100 PASSWORD :'pw';

DO $$
DECLARE r text;
BEGIN
  FOREACH r IN ARRAY ARRAY['pg_execute_server_program', 'pg_read_server_files', 'pg_write_server_files',
                           'pg_read_all_data', 'pg_write_all_data', 'pg_signal_backend']
  LOOP
    IF pg_has_role('dominusnode_gateway', r, 'MEMBER') THEN
      EXECUTE format('REVOKE %I FROM dominusnode_gateway', r);
    END IF;
  END LOOP;
END $$;

REVOKE ALL ON SCHEMA public FROM dominusnode_gateway;
GRANT USAGE ON SCHEMA public TO dominusnode_gateway;
REVOKE ALL ON ALL TABLES IN SCHEMA public FROM dominusnode_gateway;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO dominusnode_gateway;
REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM dominusnode_gateway;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO dominusnode_gateway;

-- Tables no gateway code path (proxy-gateway, its jobs, and the shared,
-- billing and metering code it loads) reads or writes: human MFA, agent
-- secrets, root-admin identity, bug reports, waitlist, migration bookkeeping.
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['agent_secrets', 'agent_sign_challenges', 'mfa_backup_codes', 'mfa_configs',
                           'root_admin_identity', 'bug_reports', 'waitlist', 'schema_migrations',
                           -- session and account-recovery credentials (api only)
                           'refresh_tokens', 'password_reset_tokens', 'email_verification_tokens',
                           'wallet_challenges']
  LOOP
    IF to_regclass('public.' || t) IS NOT NULL THEN
      EXECUTE format('REVOKE ALL ON public.%I FROM dominusnode_gateway', t);
    END IF;
  END LOOP;
END $$;

-- users: read every column but password_hash; insert only gateway-created
-- x402/MPP payer identities; update only the node-tier columns the tier job
-- writes. No admin_role/is_admin/status/email/password changes.
DO $$
DECLARE cols text;
BEGIN
  REVOKE ALL ON public.users FROM dominusnode_gateway;
  SELECT string_agg(quote_ident(column_name), ', ' ORDER BY ordinal_position) INTO cols
    FROM information_schema.columns
   WHERE table_schema = 'public' AND table_name = 'users' AND column_name <> 'password_hash';
  EXECUTE format('GRANT SELECT (%s) ON public.users TO dominusnode_gateway', cols);
  GRANT INSERT (email, password_hash, wallet_address, email_verified, payer_origin) ON public.users TO dominusnode_gateway;
  GRANT UPDATE (node_tier_id, node_tier_grace_until, node_tier_demotion_reason, node_tier_changed_at)
    ON public.users TO dominusnode_gateway;
END $$;

-- api_keys: authenticate only (and the v1 -> v2 key_hash rewrite); keys are
-- created and revoked by the api.
REVOKE ALL ON public.api_keys FROM dominusnode_gateway;
GRANT SELECT ON public.api_keys TO dominusnode_gateway;
GRANT UPDATE (key_hash) ON public.api_keys TO dominusnode_gateway;

-- audit_events: append, and the retention job's scrub; never delete.
REVOKE ALL ON public.audit_events FROM dominusnode_gateway;
GRANT SELECT, INSERT ON public.audit_events TO dominusnode_gateway;
GRANT UPDATE (resource_id, details) ON public.audit_events TO dominusnode_gateway;

-- Admin-set configuration: read only.
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['network_pricing', 'network_policy', 'kill_switches', 'revenue_split_config', 'node_drains']
  LOOP
    IF to_regclass('public.' || t) IS NOT NULL THEN
      EXECUTE format('REVOKE ALL ON public.%I FROM dominusnode_gateway', t);
      EXECUTE format('GRANT SELECT ON public.%I TO dominusnode_gateway', t);
    END IF;
  END LOOP;
END $$;
