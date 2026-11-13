-- Least-privilege Postgres role for a gateway on another host (split self-host).
-- Applied by scripts/selfhost/install.sh on the coordinator after every migrate,
-- with the password set by psql: \set pw <GATEWAY_DB_PASSWORD>. Idempotent.
--
-- The gateway is the internet-facing box. It gets row access (SELECT, INSERT,
-- UPDATE, DELETE) on the tables its code and jobs use, USAGE on sequences, and
-- nothing else: no superuser, no CREATE/DDL, no TRUNCATE/TRIGGER/REFERENCES,
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
                           'root_admin_identity', 'bug_reports', 'waitlist', 'schema_migrations']
  LOOP
    IF to_regclass('public.' || t) IS NOT NULL THEN
      EXECUTE format('REVOKE ALL ON public.%I FROM dominusnode_gateway', t);
    END IF;
  END LOOP;
END $$;
