-- 0X3-237: durable tenant-limit store — sliding-window buckets, consume
-- idempotency records, per-tenant quota/kill configuration, the platform
-- kill-switch row, and the append-only limit decision event ledger.
--
-- Bucket keys are opaque service-computed digests; raw tenant or actor ids
-- never appear in the counter table. Configuration mutations are version-CASed
-- and every change appends a durable event row in the same transaction.

CREATE TABLE public.tenant_limit_buckets (
  bucket_key text PRIMARY KEY
    CONSTRAINT tenant_limit_buckets_key_chk
    CHECK (bucket_key ~ '^[A-Za-z0-9:_-]{9,200}$'),
  used integer NOT NULL DEFAULT 0
    CONSTRAINT tenant_limit_buckets_used_chk CHECK (used >= 0),
  reset_at_ms bigint NOT NULL
    CONSTRAINT tenant_limit_buckets_reset_chk CHECK (reset_at_ms >= 0),
  updated_at timestamptz(3) NOT NULL DEFAULT pg_catalog.now()
);

CREATE OR REPLACE FUNCTION public.novatrade_tenant_limit_buckets_update_guard()
RETURNS trigger
LANGUAGE plpgsql
AS $function$
BEGIN
  IF NEW.bucket_key IS DISTINCT FROM OLD.bucket_key THEN
    RAISE EXCEPTION 'bucket key is immutable';
  END IF;
  IF NEW.used < OLD.used AND NEW.reset_at_ms IS NOT DISTINCT FROM OLD.reset_at_ms THEN
    RAISE EXCEPTION 'bucket count can only decrease on window reset';
  END IF;
  RETURN NEW;
END;
$function$;

CREATE TRIGGER trg_novatrade_tenant_limit_buckets_update_guard
  BEFORE UPDATE ON public.tenant_limit_buckets
  FOR EACH ROW EXECUTE FUNCTION public.novatrade_tenant_limit_buckets_update_guard();

ALTER TABLE public.tenant_limit_buckets ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.tenant_limit_buckets FROM PUBLIC;
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    EXECUTE 'REVOKE ALL ON TABLE public.tenant_limit_buckets FROM anon';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    EXECUTE 'REVOKE ALL ON TABLE public.tenant_limit_buckets FROM authenticated';
  END IF;
END;
$$;

REVOKE ALL ON FUNCTION public.novatrade_tenant_limit_buckets_update_guard() FROM PUBLIC;

CREATE TABLE public.tenant_limit_idempotency (
  idempotency_key text PRIMARY KEY
    CONSTRAINT tenant_limit_idempotency_key_chk
    CHECK (idempotency_key ~ '^[0-9a-f]{64}$'),
  request_hash text NOT NULL
    CONSTRAINT tenant_limit_idempotency_request_chk
    CHECK (request_hash ~ '^[0-9a-f]{64}$'),
  tenant_id uuid NOT NULL,
  action text NOT NULL
    CONSTRAINT tenant_limit_idempotency_action_chk
    CHECK (action IN (
      'membership_invite', 'support_grant_request', 'support_grant_approval',
      'knowledge_upload', 'export_request', 'deletion_request', 'worker_start',
      'agent_plan_expensive', 'recovery_bookkeeping'
    )),
  created_at timestamptz(3) NOT NULL DEFAULT pg_catalog.now()
);

CREATE OR REPLACE FUNCTION public.novatrade_tenant_limit_idempotency_append_only()
RETURNS trigger
LANGUAGE plpgsql
AS $function$
BEGIN
  RAISE EXCEPTION 'tenant_limit_idempotency rows are append-only';
END;
$function$;

CREATE TRIGGER trg_novatrade_tenant_limit_idempotency_no_update
  BEFORE UPDATE ON public.tenant_limit_idempotency
  FOR EACH ROW EXECUTE FUNCTION public.novatrade_tenant_limit_idempotency_append_only();
CREATE TRIGGER trg_novatrade_tenant_limit_idempotency_no_delete
  BEFORE DELETE ON public.tenant_limit_idempotency
  FOR EACH ROW EXECUTE FUNCTION public.novatrade_tenant_limit_idempotency_append_only();

ALTER TABLE public.tenant_limit_idempotency ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.tenant_limit_idempotency FROM PUBLIC;
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    EXECUTE 'REVOKE ALL ON TABLE public.tenant_limit_idempotency FROM anon';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    EXECUTE 'REVOKE ALL ON TABLE public.tenant_limit_idempotency FROM authenticated';
  END IF;
END;
$$;

REVOKE ALL ON FUNCTION public.novatrade_tenant_limit_idempotency_append_only() FROM PUBLIC;

CREATE TABLE public.tenant_limit_configuration (
  tenant_id uuid NOT NULL
    CONSTRAINT tenant_limit_configuration_tenant_id_fkey
    REFERENCES public.tenants (id)
    ON UPDATE RESTRICT
    ON DELETE RESTRICT,
  action text NOT NULL
    CONSTRAINT tenant_limit_configuration_action_chk
    CHECK (action IN (
      'membership_invite', 'support_grant_request', 'support_grant_approval',
      'knowledge_upload', 'export_request', 'deletion_request', 'worker_start',
      'agent_plan_expensive', 'recovery_bookkeeping'
    )),
  configuration_version integer NOT NULL DEFAULT 1
    CONSTRAINT tenant_limit_configuration_version_chk CHECK (configuration_version >= 1),
  policy_cap integer
    CONSTRAINT tenant_limit_configuration_cap_chk
    CHECK (policy_cap IS NULL OR policy_cap BETWEEN 1 AND 1000000),
  action_kill boolean NOT NULL DEFAULT false,
  updated_at timestamptz(3) NOT NULL DEFAULT pg_catalog.now(),
  PRIMARY KEY (tenant_id, action)
);

CREATE OR REPLACE FUNCTION public.novatrade_tenant_limit_configuration_update_guard()
RETURNS trigger
LANGUAGE plpgsql
AS $function$
BEGIN
  IF NEW.tenant_id IS DISTINCT FROM OLD.tenant_id THEN
    RAISE EXCEPTION 'limit configuration tenant is immutable';
  END IF;
  IF NEW.action IS DISTINCT FROM OLD.action THEN
    RAISE EXCEPTION 'limit configuration action is immutable';
  END IF;
  IF NEW.configuration_version IS DISTINCT FROM OLD.configuration_version + 1 THEN
    RAISE EXCEPTION 'limit configuration version must advance exactly one';
  END IF;
  RETURN NEW;
END;
$function$;

CREATE TRIGGER trg_novatrade_tenant_limit_configuration_update_guard
  BEFORE UPDATE ON public.tenant_limit_configuration
  FOR EACH ROW EXECUTE FUNCTION public.novatrade_tenant_limit_configuration_update_guard();

ALTER TABLE public.tenant_limit_configuration ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.tenant_limit_configuration FROM PUBLIC;
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    EXECUTE 'REVOKE ALL ON TABLE public.tenant_limit_configuration FROM anon';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    EXECUTE 'REVOKE ALL ON TABLE public.tenant_limit_configuration FROM authenticated';
  END IF;
END;
$$;

REVOKE ALL ON FUNCTION public.novatrade_tenant_limit_configuration_update_guard() FROM PUBLIC;

CREATE TABLE public.platform_limit_configuration (
  id text PRIMARY KEY
    CONSTRAINT platform_limit_configuration_id_chk CHECK (id = 'platform'),
  configuration_version integer NOT NULL DEFAULT 1
    CONSTRAINT platform_limit_configuration_version_chk CHECK (configuration_version >= 1),
  global_kill boolean NOT NULL DEFAULT false,
  action_kills_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  updated_at timestamptz(3) NOT NULL DEFAULT pg_catalog.now()
);

CREATE OR REPLACE FUNCTION public.novatrade_platform_limit_configuration_update_guard()
RETURNS trigger
LANGUAGE plpgsql
AS $function$
BEGIN
  IF NEW.id IS DISTINCT FROM OLD.id THEN
    RAISE EXCEPTION 'platform configuration id is immutable';
  END IF;
  IF NEW.configuration_version IS DISTINCT FROM OLD.configuration_version + 1 THEN
    RAISE EXCEPTION 'platform configuration version must advance exactly one';
  END IF;
  RETURN NEW;
END;
$function$;

CREATE TRIGGER trg_novatrade_platform_limit_configuration_update_guard
  BEFORE UPDATE ON public.platform_limit_configuration
  FOR EACH ROW EXECUTE FUNCTION public.novatrade_platform_limit_configuration_update_guard();

CREATE OR REPLACE FUNCTION public.novatrade_platform_limit_configuration_no_delete()
RETURNS trigger
LANGUAGE plpgsql
AS $function$
BEGIN
  RAISE EXCEPTION 'platform_limit_configuration row cannot be deleted';
END;
$function$;

CREATE TRIGGER trg_novatrade_platform_limit_configuration_no_delete
  BEFORE DELETE ON public.platform_limit_configuration
  FOR EACH ROW EXECUTE FUNCTION public.novatrade_platform_limit_configuration_no_delete();

ALTER TABLE public.platform_limit_configuration ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.platform_limit_configuration FROM PUBLIC;
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    EXECUTE 'REVOKE ALL ON TABLE public.platform_limit_configuration FROM anon';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    EXECUTE 'REVOKE ALL ON TABLE public.platform_limit_configuration FROM authenticated';
  END IF;
END;
$$;

REVOKE ALL ON FUNCTION public.novatrade_platform_limit_configuration_update_guard() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.novatrade_platform_limit_configuration_no_delete() FROM PUBLIC;

CREATE TABLE public.tenant_limit_events (
  event_id uuid PRIMARY KEY,
  event_type text NOT NULL
    CONSTRAINT tenant_limit_events_type_chk
    CHECK (event_type IN ('tenant_limit_configuration_changed', 'platform_limit_kill_switch_changed')),
  tenant_id uuid,
  action text
    CONSTRAINT tenant_limit_events_action_chk
    CHECK (action IS NULL OR action IN (
      'membership_invite', 'support_grant_request', 'support_grant_approval',
      'knowledge_upload', 'export_request', 'deletion_request', 'worker_start',
      'agent_plan_expensive', 'recovery_bookkeeping'
    )),
  payload_json jsonb NOT NULL,
  created_at timestamptz(3) NOT NULL DEFAULT pg_catalog.now()
);

CREATE INDEX idx_tenant_limit_events_tenant_created
  ON public.tenant_limit_events (tenant_id, created_at DESC, event_id);

CREATE OR REPLACE FUNCTION public.novatrade_tenant_limit_events_append_only()
RETURNS trigger
LANGUAGE plpgsql
AS $function$
BEGIN
  RAISE EXCEPTION 'tenant_limit_events rows are append-only';
END;
$function$;

CREATE TRIGGER trg_novatrade_tenant_limit_events_no_update
  BEFORE UPDATE ON public.tenant_limit_events
  FOR EACH ROW EXECUTE FUNCTION public.novatrade_tenant_limit_events_append_only();
CREATE TRIGGER trg_novatrade_tenant_limit_events_no_delete
  BEFORE DELETE ON public.tenant_limit_events
  FOR EACH ROW EXECUTE FUNCTION public.novatrade_tenant_limit_events_append_only();

ALTER TABLE public.tenant_limit_events ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.tenant_limit_events FROM PUBLIC;
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    EXECUTE 'REVOKE ALL ON TABLE public.tenant_limit_events FROM anon';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    EXECUTE 'REVOKE ALL ON TABLE public.tenant_limit_events FROM authenticated';
  END IF;
END;
$$;

REVOKE ALL ON FUNCTION public.novatrade_tenant_limit_events_append_only() FROM PUBLIC;
