-- Restricted worker-lease roles (0X3-228). Applied by scripts/local-supabase.mjs roles.
-- Contract enforced by src/lib/tenancy/worker-lease-runtime.ts verifyRestrictedRole:
--   * LOGIN, NOINHERIT, not superuser, no CREATEDB/CREATEROLE/REPLICATION/BYPASSRLS
--   * no role memberships, does not own the database, no CREATE on database/schema
--   * USAGE on schema public only
--   * issuer: EXECUTE on acquire + cancel only
--   * resolver: EXECUTE on resolve only (validate stays ungranted for both)
--   * zero privileges on public.tenant_worker_dispatch_leases
-- {{placeholders}} are substituted by the orchestrator — no secrets committed.

DO $roles$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = '{{issuer_role}}') THEN
    EXECUTE format('CREATE ROLE %I NOINHERIT LOGIN PASSWORD %L', '{{issuer_role}}', '{{issuer_pw}}');
  ELSE
    EXECUTE format('ALTER ROLE %I NOINHERIT LOGIN PASSWORD %L', '{{issuer_role}}', '{{issuer_pw}}');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = '{{resolver_role}}') THEN
    EXECUTE format('CREATE ROLE %I NOINHERIT LOGIN PASSWORD %L', '{{resolver_role}}', '{{resolver_pw}}');
  ELSE
    EXECUTE format('ALTER ROLE %I NOINHERIT LOGIN PASSWORD %L', '{{resolver_role}}', '{{resolver_pw}}');
  END IF;
END
$roles$;

REVOKE ALL ON SCHEMA public FROM "{{issuer_role}}", "{{resolver_role}}";
REVOKE ALL ON ALL TABLES IN SCHEMA public FROM "{{issuer_role}}", "{{resolver_role}}";
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA public FROM "{{issuer_role}}", "{{resolver_role}}";
REVOKE ALL ON DATABASE postgres FROM "{{issuer_role}}", "{{resolver_role}}";
GRANT CONNECT ON DATABASE postgres TO "{{issuer_role}}", "{{resolver_role}}";
GRANT USAGE ON SCHEMA public TO "{{issuer_role}}", "{{resolver_role}}";

GRANT EXECUTE ON FUNCTION public.novatrade_acquire_tenant_worker_lease(text,text,text,text,text,text,text,text,text,text,text,text) TO "{{issuer_role}}";
GRANT EXECUTE ON FUNCTION public.novatrade_cancel_tenant_worker_lease(text,text,text,text,text,text,text,text,text,text,text,text) TO "{{issuer_role}}";
GRANT EXECUTE ON FUNCTION public.novatrade_resolve_tenant_worker_lease(text,text,text) TO "{{resolver_role}}";
