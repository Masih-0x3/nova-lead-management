-- 0X3-236: durable support-access operation journal, append-only decision
-- event ledger, and the platform-support principal registry used by the
-- principal-resolver port.
--
-- The grant tables themselves (support_access_grants plus the permission and
-- data-class scope tables) were created in 202607270005. These tables carry
-- the idempotency reservations, the recorded allow/deny decisions for every
-- support operation, and the operator-managed directory of platform-support
-- principals that member-side grant requests reference.

CREATE TABLE public.support_access_journal (
  idempotency_key_hash text PRIMARY KEY
    CONSTRAINT support_access_journal_key_chk
    CHECK (idempotency_key_hash ~ '^[0-9a-f]{64}$'),
  input_hash text NOT NULL
    CONSTRAINT support_access_journal_input_chk
    CHECK (input_hash ~ '^[0-9a-f]{64}$'),
  operation text NOT NULL
    CONSTRAINT support_access_journal_operation_chk
    CHECK (operation IN (
      'request', 'approve', 'revoke', 'check',
      'authorize_and_run', 'list_current', 'list_history'
    )),
  tenant_id uuid,
  actor_namespace text NOT NULL
    CONSTRAINT support_access_journal_actor_chk
    CHECK (pg_catalog.char_length(actor_namespace) BETWEEN 1 AND 128),
  status text NOT NULL DEFAULT 'reserved'
    CONSTRAINT support_access_journal_status_chk
    CHECK (status IN ('reserved', 'completed')),
  result_json jsonb,
  created_at timestamptz(3) NOT NULL DEFAULT pg_catalog.now(),
  completed_at timestamptz(3),
  CONSTRAINT support_access_journal_state_chk CHECK (
    CASE WHEN status = 'reserved'
      THEN result_json IS NULL AND completed_at IS NULL
      ELSE result_json IS NOT NULL AND completed_at IS NOT NULL
    END
  )
);

CREATE OR REPLACE FUNCTION public.novatrade_support_access_journal_update_guard()
RETURNS trigger
LANGUAGE plpgsql
AS $function$
BEGIN
  IF NEW.idempotency_key_hash IS DISTINCT FROM OLD.idempotency_key_hash
    OR NEW.input_hash IS DISTINCT FROM OLD.input_hash
    OR NEW.operation IS DISTINCT FROM OLD.operation
    OR NEW.tenant_id IS DISTINCT FROM OLD.tenant_id
    OR NEW.actor_namespace IS DISTINCT FROM OLD.actor_namespace
    OR NEW.created_at IS DISTINCT FROM OLD.created_at
  THEN
    RAISE EXCEPTION 'journal reservation facts are immutable';
  END IF;
  IF OLD.status = 'completed' AND (
    NEW.status IS DISTINCT FROM 'completed'
    OR NEW.result_json IS DISTINCT FROM OLD.result_json
    OR NEW.completed_at IS DISTINCT FROM OLD.completed_at
  ) THEN
    RAISE EXCEPTION 'journal completion is terminal';
  END IF;
  IF NEW.status = 'reserved' AND (NEW.result_json IS NOT NULL OR NEW.completed_at IS NOT NULL) THEN
    RAISE EXCEPTION 'journal reservation rows cannot carry completion facts';
  END IF;
  RETURN NEW;
END;
$function$;

CREATE TRIGGER trg_novatrade_support_access_journal_update_guard
  BEFORE UPDATE ON public.support_access_journal
  FOR EACH ROW EXECUTE FUNCTION public.novatrade_support_access_journal_update_guard();

CREATE OR REPLACE FUNCTION public.novatrade_support_access_journal_no_delete()
RETURNS trigger
LANGUAGE plpgsql
AS $function$
BEGIN
  RAISE EXCEPTION 'support_access_journal rows are append-only';
END;
$function$;

CREATE TRIGGER trg_novatrade_support_access_journal_no_delete
  BEFORE DELETE ON public.support_access_journal
  FOR EACH ROW EXECUTE FUNCTION public.novatrade_support_access_journal_no_delete();

ALTER TABLE public.support_access_journal ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.support_access_journal FROM PUBLIC;
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    EXECUTE 'REVOKE ALL ON TABLE public.support_access_journal FROM anon';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    EXECUTE 'REVOKE ALL ON TABLE public.support_access_journal FROM authenticated';
  END IF;
END;
$$;

REVOKE ALL ON FUNCTION public.novatrade_support_access_journal_update_guard() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.novatrade_support_access_journal_no_delete() FROM PUBLIC;

-- Append-only decision ledger: every request/approve/revoke/check/authorize
-- and every member-side list operation records one event, including denials.
CREATE TABLE public.support_access_events (
  event_id uuid PRIMARY KEY,
  operation text NOT NULL
    CONSTRAINT support_access_events_operation_chk
    CHECK (operation IN (
      'request', 'approve', 'revoke', 'check',
      'authorize_and_run', 'list_current', 'list_history'
    )),
  tenant_id uuid,
  workspace_id uuid,
  actor_layer text NOT NULL
    CONSTRAINT support_access_events_actor_layer_chk
    CHECK (actor_layer IN ('member', 'support', 'worker')),
  actor_id uuid,
  support_grant_id uuid,
  permission text
    CONSTRAINT support_access_events_permission_chk
    CHECK (permission IS NULL OR permission ~ '^[a-z][a-z:_-]{2,39}$'),
  data_classes_json jsonb NOT NULL,
  decision_code text NOT NULL
    CONSTRAINT support_access_events_decision_chk
    CHECK (decision_code IN (
      'OK_SUPPORT_GRANT_REQUESTED', 'OK_SUPPORT_GRANT_APPROVED',
      'OK_SUPPORT_GRANT_REVOKED', 'OK_SUPPORT_AUTHORIZED', 'OK_SUPPORT_REPLAY',
      'SUPPORT_GRANT_REQUIRED', 'SUPPORT_SCOPE_MISMATCH',
      'SUPPORT_WORKSPACE_SCOPE_INVALID', 'SUPPORT_POLICY_BLOCKED',
      'SUPPORT_SELF_ACTION', 'SUPPORT_STATE_CONFLICT',
      'SUPPORT_NOT_FOUND_OR_FORBIDDEN', 'SUPPORT_MALFORMED', 'SUPPORT_INTERNAL'
    )),
  reason_code text NOT NULL
    CONSTRAINT support_access_events_reason_chk
    CHECK (reason_code ~ '^[a-z][a-z0-9._-]{2,79}$'),
  correlation_id text NOT NULL
    CONSTRAINT support_access_events_correlation_chk
    CHECK (correlation_id ~ '^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$'),
  attempt_id uuid NOT NULL,
  input_hash text NOT NULL
    CONSTRAINT support_access_events_input_chk
    CHECK (input_hash ~ '^[0-9a-f]{64}$'),
  created_at timestamptz(3) NOT NULL DEFAULT pg_catalog.now()
);

CREATE INDEX idx_support_access_events_tenant_created
  ON public.support_access_events (tenant_id, created_at DESC, event_id);
CREATE INDEX idx_support_access_events_grant
  ON public.support_access_events (support_grant_id, created_at DESC)
  WHERE support_grant_id IS NOT NULL;

CREATE OR REPLACE FUNCTION public.novatrade_support_access_events_append_only()
RETURNS trigger
LANGUAGE plpgsql
AS $function$
BEGIN
  RAISE EXCEPTION 'support_access_events rows are append-only';
END;
$function$;

CREATE TRIGGER trg_novatrade_support_access_events_no_update
  BEFORE UPDATE ON public.support_access_events
  FOR EACH ROW EXECUTE FUNCTION public.novatrade_support_access_events_append_only();
CREATE TRIGGER trg_novatrade_support_access_events_no_delete
  BEFORE DELETE ON public.support_access_events
  FOR EACH ROW EXECUTE FUNCTION public.novatrade_support_access_events_append_only();

ALTER TABLE public.support_access_events ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.support_access_events FROM PUBLIC;
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    EXECUTE 'REVOKE ALL ON TABLE public.support_access_events FROM anon';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    EXECUTE 'REVOKE ALL ON TABLE public.support_access_events FROM authenticated';
  END IF;
END;
$$;

REVOKE ALL ON FUNCTION public.novatrade_support_access_events_append_only() FROM PUBLIC;

-- Operator-managed directory of platform-support principals. Members select a
-- support target by opaque reference; the service resolves the reference to
-- the durable auth identity without exposing directory contents to tenants.
CREATE TABLE public.platform_support_principals (
  reference text PRIMARY KEY
    CONSTRAINT platform_support_principals_ref_chk
    CHECK (pg_catalog.char_length(reference) BETWEEN 1 AND 256),
  auth_identity_id uuid NOT NULL,
  status text NOT NULL DEFAULT 'active'
    CONSTRAINT platform_support_principals_status_chk
    CHECK (status IN ('active', 'disabled')),
  created_at timestamptz(3) NOT NULL DEFAULT pg_catalog.now(),
  CONSTRAINT platform_support_principals_identity_unique UNIQUE (auth_identity_id)
);

CREATE OR REPLACE FUNCTION public.novatrade_platform_support_principals_update_guard()
RETURNS trigger
LANGUAGE plpgsql
AS $function$
BEGIN
  IF NEW.reference IS DISTINCT FROM OLD.reference
    OR NEW.auth_identity_id IS DISTINCT FROM OLD.auth_identity_id
    OR NEW.created_at IS DISTINCT FROM OLD.created_at
  THEN
    RAISE EXCEPTION 'support principal facts are immutable';
  END IF;
  IF OLD.status = 'disabled' AND NEW.status IS DISTINCT FROM 'disabled' THEN
    RAISE EXCEPTION 'support principal cannot be re-enabled';
  END IF;
  RETURN NEW;
END;
$function$;

CREATE TRIGGER trg_novatrade_platform_support_principals_update_guard
  BEFORE UPDATE ON public.platform_support_principals
  FOR EACH ROW EXECUTE FUNCTION public.novatrade_platform_support_principals_update_guard();

ALTER TABLE public.platform_support_principals ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.platform_support_principals FROM PUBLIC;
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    EXECUTE 'REVOKE ALL ON TABLE public.platform_support_principals FROM anon';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    EXECUTE 'REVOKE ALL ON TABLE public.platform_support_principals FROM authenticated';
  END IF;
END;
$$;

REVOKE ALL ON FUNCTION public.novatrade_platform_support_principals_update_guard() FROM PUBLIC;
