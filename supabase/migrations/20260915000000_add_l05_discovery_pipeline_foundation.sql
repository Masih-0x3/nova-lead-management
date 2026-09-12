-- L-05 discovery pipeline durability foundation.
--
-- Persists hash-verified discovery plans, discovery runs, canonical accounts,
-- account-resolution receipts, observation bindings, and the reversible merge
-- ledger produced by src/lib/discovery. Canonical projections stay mutable only
-- through the guarded transitions below; observations, resolutions, and merge
-- events are append-only evidence. Runtime access remains denied to
-- PostgREST-facing roles; the service layer holds sole write authority.
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '120s';
SELECT pg_catalog.pg_advisory_xact_lock(
  pg_catalog.hashtext('novatrade:l05:discovery-pipeline-foundation')
);

CREATE TABLE IF NOT EXISTS public.discovery_plans (
  plan_id text CONSTRAINT discovery_plans_pkey PRIMARY KEY,
  tenant_id uuid NOT NULL CONSTRAINT discovery_plans_tenant_id_fkey
    REFERENCES public.tenants (id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  workspace_id uuid,
  plan_sha256 text NOT NULL,
  status text NOT NULL DEFAULT 'plan_only',
  play_stable_key text NOT NULL,
  play_version_id text NOT NULL,
  play_revision integer NOT NULL,
  source_keys jsonb NOT NULL,
  limits jsonb NOT NULL,
  payload jsonb NOT NULL,
  created_at timestamptz NOT NULL,
  CONSTRAINT discovery_plans_tenant_workspace_fkey
    FOREIGN KEY (tenant_id, workspace_id) REFERENCES public.workspaces (tenant_id, id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT discovery_plans_id_format_chk
    CHECK (plan_id ~ '^discovery-plan:[0-9a-f]{64}$'),
  CONSTRAINT discovery_plans_hash_chk CHECK (plan_sha256 ~ '^[0-9a-f]{64}$'),
  CONSTRAINT discovery_plans_status_chk CHECK (status = 'plan_only'),
  CONSTRAINT discovery_plans_play_chk CHECK (
    pg_catalog.char_length(play_stable_key) BETWEEN 1 AND 300
    AND play_version_id ~ '^lead-play-version:[0-9a-f]{64}$'
    AND play_revision > 0
  ),
  CONSTRAINT discovery_plans_source_keys_chk CHECK (
    pg_catalog.jsonb_typeof(source_keys) = 'array'
    AND pg_catalog.jsonb_array_length(source_keys) BETWEEN 1 AND 8
  ),
  CONSTRAINT discovery_plans_limits_chk CHECK (
    pg_catalog.jsonb_typeof(limits) = 'object'
    AND (limits->>'maxAccounts')::numeric >= 1
    AND (limits->>'maxProviderRequests')::numeric >= 1
    AND (limits->>'maxSpendCents')::numeric >= 0
  ),
  CONSTRAINT discovery_plans_payload_chk CHECK (
    pg_catalog.jsonb_typeof(payload) = 'object'
    AND payload->>'planId' = plan_id
    AND payload->>'tenantId' = tenant_id::text
    AND pg_catalog.coalesce(payload->>'workspaceId', '')
      = pg_catalog.coalesce(workspace_id::text, '')
    AND payload->>'planHash' = 'sha256:' || plan_sha256
    AND payload->>'status' = status
    AND payload->'play'->>'stableKey' = play_stable_key
    AND payload->'play'->>'versionId' = play_version_id
    AND (payload->'play'->>'revision')::numeric = play_revision
    AND pg_catalog.jsonb_typeof(payload->'tasks') = 'array'
    AND payload->'limits' = limits
    AND payload->>'createdAt'
      = pg_catalog.to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
  )
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_discovery_plans_scope_id
  ON public.discovery_plans (tenant_id, workspace_id, plan_id);

CREATE TABLE IF NOT EXISTS public.discovery_runs (
  run_id text CONSTRAINT discovery_runs_pkey PRIMARY KEY,
  tenant_id uuid NOT NULL CONSTRAINT discovery_runs_tenant_id_fkey
    REFERENCES public.tenants (id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  workspace_id uuid,
  plan_id text NOT NULL CONSTRAINT discovery_runs_plan_id_fkey
    REFERENCES public.discovery_plans (plan_id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  status text NOT NULL DEFAULT 'planned',
  run_sha256 text NOT NULL,
  payload jsonb NOT NULL,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  CONSTRAINT discovery_runs_tenant_workspace_fkey
    FOREIGN KEY (tenant_id, workspace_id) REFERENCES public.workspaces (tenant_id, id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT discovery_runs_scope_plan_unique UNIQUE (tenant_id, workspace_id, run_id),
  CONSTRAINT discovery_runs_id_format_chk
    CHECK (run_id ~ '^discovery-run:[0-9a-f]{64}$'),
  CONSTRAINT discovery_runs_hash_chk CHECK (run_sha256 ~ '^[0-9a-f]{64}$'),
  CONSTRAINT discovery_runs_status_chk
    CHECK (status IN ('planned', 'running', 'completed', 'failed', 'cancelled')),
  CONSTRAINT discovery_runs_payload_chk CHECK (
    pg_catalog.jsonb_typeof(payload) = 'object'
    AND payload->>'runId' = run_id
    AND payload->>'tenantId' = tenant_id::text
    AND pg_catalog.coalesce(payload->>'workspaceId', '')
      = pg_catalog.coalesce(workspace_id::text, '')
    AND payload->'plan'->>'planId' = plan_id
    AND payload->>'runHash' = 'sha256:' || run_sha256
    AND payload->>'status' = status
    AND payload->>'createdAt'
      = pg_catalog.to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
    AND payload->>'updatedAt'
      = pg_catalog.to_char(updated_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
  ),
  CONSTRAINT discovery_runs_time_chk CHECK (updated_at >= created_at)
);
CREATE INDEX IF NOT EXISTS idx_discovery_runs_scope_status
  ON public.discovery_runs (tenant_id, workspace_id, status, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_discovery_runs_scope_plan
  ON public.discovery_runs (tenant_id, workspace_id, plan_id, created_at);

CREATE TABLE IF NOT EXISTS public.canonical_accounts (
  account_id uuid CONSTRAINT canonical_accounts_pkey PRIMARY KEY,
  tenant_id uuid NOT NULL CONSTRAINT canonical_accounts_tenant_id_fkey
    REFERENCES public.tenants (id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  workspace_id uuid NOT NULL,
  version integer NOT NULL DEFAULT 1,
  status text NOT NULL DEFAULT 'active',
  redirect_to_account_id uuid CONSTRAINT canonical_accounts_redirect_fkey
    REFERENCES public.canonical_accounts (account_id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  display_name text,
  profile jsonb NOT NULL DEFAULT '{}'::jsonb,
  profile_sha256 text NOT NULL,
  exact_keys jsonb NOT NULL DEFAULT '[]'::jsonb,
  observation_refs jsonb NOT NULL DEFAULT '[]'::jsonb,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  CONSTRAINT canonical_accounts_tenant_workspace_fkey
    FOREIGN KEY (tenant_id, workspace_id) REFERENCES public.workspaces (tenant_id, id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT canonical_accounts_scope_id_unique UNIQUE (tenant_id, workspace_id, account_id),
  CONSTRAINT canonical_accounts_version_chk CHECK (version > 0),
  CONSTRAINT canonical_accounts_status_chk CHECK (status IN ('active', 'merged')),
  CONSTRAINT canonical_accounts_redirect_chk CHECK (
    (status = 'active' AND redirect_to_account_id IS NULL)
    OR (status = 'merged' AND redirect_to_account_id IS NOT NULL
      AND redirect_to_account_id <> account_id)
  ),
  CONSTRAINT canonical_accounts_name_chk CHECK (
    display_name IS NULL OR (
      pg_catalog.char_length(display_name) BETWEEN 1 AND 300
      AND display_name = pg_catalog.btrim(display_name)
      AND display_name !~ '[[:cntrl:]]'
    )
  ),
  CONSTRAINT canonical_accounts_hash_chk CHECK (profile_sha256 ~ '^[0-9a-f]{64}$'),
  CONSTRAINT canonical_accounts_profile_chk CHECK (pg_catalog.jsonb_typeof(profile) = 'object'),
  CONSTRAINT canonical_accounts_keys_chk CHECK (pg_catalog.jsonb_typeof(exact_keys) = 'array'),
  CONSTRAINT canonical_accounts_refs_chk CHECK (pg_catalog.jsonb_typeof(observation_refs) = 'array'),
  CONSTRAINT canonical_accounts_time_chk CHECK (updated_at >= created_at)
);
CREATE INDEX IF NOT EXISTS idx_canonical_accounts_scope_status
  ON public.canonical_accounts (tenant_id, workspace_id, status, updated_at DESC);

CREATE TABLE IF NOT EXISTS public.account_source_observations (
  observation_id text CONSTRAINT account_source_observations_pkey PRIMARY KEY,
  tenant_id uuid NOT NULL,
  workspace_id uuid NOT NULL,
  account_id uuid NOT NULL CONSTRAINT account_source_observations_account_fkey
    REFERENCES public.canonical_accounts (account_id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  source_key text NOT NULL,
  namespace text NOT NULL,
  external_id text NOT NULL,
  observed_at timestamptz NOT NULL,
  payload_sha256 text NOT NULL,
  provenance_sha256 text NOT NULL,
  resolution_id text,
  discovery_run_id text,
  source_observation_id text,
  created_at timestamptz NOT NULL DEFAULT pg_catalog.statement_timestamp(),
  CONSTRAINT account_source_observations_tenant_workspace_fkey
    FOREIGN KEY (tenant_id, workspace_id) REFERENCES public.workspaces (tenant_id, id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT account_source_observations_account_scope_fkey
    FOREIGN KEY (tenant_id, workspace_id, account_id)
    REFERENCES public.canonical_accounts (tenant_id, workspace_id, account_id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT account_source_observations_run_scope_fkey
    FOREIGN KEY (tenant_id, workspace_id, discovery_run_id)
    REFERENCES public.discovery_runs (tenant_id, workspace_id, run_id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT account_source_observations_id_length_chk
    CHECK (pg_catalog.char_length(observation_id) BETWEEN 1 AND 300),
  CONSTRAINT account_source_observations_key_chk CHECK (
    pg_catalog.char_length(source_key) BETWEEN 1 AND 300
    AND pg_catalog.char_length(namespace) BETWEEN 1 AND 300
    AND pg_catalog.char_length(external_id) BETWEEN 1 AND 300
  ),
  CONSTRAINT account_source_observations_hashes_chk CHECK (
    payload_sha256 ~ '^[0-9a-f]{64}$' AND provenance_sha256 ~ '^[0-9a-f]{64}$'
  ),
  CONSTRAINT account_source_observations_refs_chk CHECK (
    (resolution_id IS NULL OR resolution_id ~ '^account-resolution:[0-9a-f]{64}$')
    AND (discovery_run_id IS NULL OR discovery_run_id ~ '^discovery-run:[0-9a-f]{64}$')
    AND (source_observation_id IS NULL
      OR pg_catalog.char_length(source_observation_id) BETWEEN 1 AND 160)
  )
);
CREATE INDEX IF NOT EXISTS idx_account_source_observations_scope_identity
  ON public.account_source_observations (tenant_id, workspace_id, source_key, namespace, external_id);
CREATE INDEX IF NOT EXISTS idx_account_source_observations_scope_account
  ON public.account_source_observations (tenant_id, workspace_id, account_id, observed_at DESC);
CREATE INDEX IF NOT EXISTS idx_account_source_observations_scope_run
  ON public.account_source_observations (tenant_id, workspace_id, discovery_run_id)
  WHERE discovery_run_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS public.account_resolutions (
  resolution_id text CONSTRAINT account_resolutions_pkey PRIMARY KEY,
  tenant_id uuid NOT NULL,
  workspace_id uuid NOT NULL,
  state text NOT NULL,
  rule_id text NOT NULL,
  target_account_id uuid CONSTRAINT account_resolutions_target_fkey
    REFERENCES public.canonical_accounts (account_id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  canonical_candidate_id text,
  candidate_account_ids jsonb NOT NULL,
  observations jsonb NOT NULL,
  resolution_sha256 text NOT NULL,
  created_at timestamptz NOT NULL,
  CONSTRAINT account_resolutions_tenant_workspace_fkey
    FOREIGN KEY (tenant_id, workspace_id) REFERENCES public.workspaces (tenant_id, id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT account_resolutions_id_format_chk
    CHECK (resolution_id ~ '^account-resolution:[0-9a-f]{64}$'),
  CONSTRAINT account_resolutions_state_chk
    CHECK (state IN ('auto_resolved', 'human_review', 'canonical_candidate')),
  CONSTRAINT account_resolutions_rule_chk CHECK (rule_id IN (
    'EXACT_SOURCE_ID_SAME_TENANT_NAMESPACE',
    'CONFLICTING_EXACT_IDENTITY',
    'NO_MATCH_OR_INSUFFICIENT_EVIDENCE'
  )),
  CONSTRAINT account_resolutions_outcome_chk CHECK (
    (state = 'auto_resolved' AND target_account_id IS NOT NULL AND canonical_candidate_id IS NULL)
    OR (state = 'canonical_candidate' AND target_account_id IS NULL
      AND canonical_candidate_id IS NOT NULL
      AND canonical_candidate_id ~ '^account-candidate:[0-9a-f]{64}$')
    OR (state = 'human_review' AND target_account_id IS NULL AND canonical_candidate_id IS NULL)
  ),
  CONSTRAINT account_resolutions_candidates_chk
    CHECK (pg_catalog.jsonb_typeof(candidate_account_ids) = 'array'),
  CONSTRAINT account_resolutions_observations_chk CHECK (
    pg_catalog.jsonb_typeof(observations) = 'array'
    AND pg_catalog.jsonb_array_length(observations) >= 1
  ),
  CONSTRAINT account_resolutions_hash_chk CHECK (resolution_sha256 ~ '^[0-9a-f]{64}$')
);
CREATE INDEX IF NOT EXISTS idx_account_resolutions_scope_state
  ON public.account_resolutions (tenant_id, workspace_id, state, created_at DESC);

CREATE TABLE IF NOT EXISTS public.account_merge_events (
  event_id text CONSTRAINT account_merge_events_pkey PRIMARY KEY,
  tenant_id uuid NOT NULL,
  workspace_id uuid NOT NULL,
  action text NOT NULL,
  survivor_account_id uuid NOT NULL CONSTRAINT account_merge_events_survivor_fkey
    REFERENCES public.canonical_accounts (account_id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  retired_account_id uuid NOT NULL CONSTRAINT account_merge_events_retired_fkey
    REFERENCES public.canonical_accounts (account_id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  evidence_observation_ids jsonb NOT NULL,
  actor jsonb NOT NULL,
  at timestamptz NOT NULL,
  reason text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT pg_catalog.statement_timestamp(),
  CONSTRAINT account_merge_events_tenant_workspace_fkey
    FOREIGN KEY (tenant_id, workspace_id) REFERENCES public.workspaces (tenant_id, id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT account_merge_events_survivor_scope_fkey
    FOREIGN KEY (tenant_id, workspace_id, survivor_account_id)
    REFERENCES public.canonical_accounts (tenant_id, workspace_id, account_id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT account_merge_events_retired_scope_fkey
    FOREIGN KEY (tenant_id, workspace_id, retired_account_id)
    REFERENCES public.canonical_accounts (tenant_id, workspace_id, account_id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT account_merge_events_id_format_chk
    CHECK (event_id ~ '^account-merge-event:[0-9a-f]{64}$'),
  CONSTRAINT account_merge_events_action_chk CHECK (action IN ('merge', 'unmerge')),
  CONSTRAINT account_merge_events_pair_chk CHECK (survivor_account_id <> retired_account_id),
  CONSTRAINT account_merge_events_evidence_chk CHECK (
    pg_catalog.jsonb_typeof(evidence_observation_ids) = 'array'
    AND pg_catalog.jsonb_array_length(evidence_observation_ids) >= 1
  ),
  CONSTRAINT account_merge_events_actor_chk CHECK (
    pg_catalog.jsonb_typeof(actor) = 'object'
    AND actor->>'kind' = 'human'
    AND (actor->>'actorId') ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
  ),
  CONSTRAINT account_merge_events_reason_chk CHECK (
    pg_catalog.char_length(reason) BETWEEN 1 AND 2000
    AND reason = pg_catalog.btrim(reason)
    AND reason !~ '[[:cntrl:]]'
  )
);
CREATE INDEX IF NOT EXISTS idx_account_merge_events_scope_at
  ON public.account_merge_events (tenant_id, workspace_id, at, event_id);
CREATE INDEX IF NOT EXISTS idx_account_merge_events_scope_pair
  ON public.account_merge_events
  (tenant_id, workspace_id, survivor_account_id, retired_account_id, at);

CREATE TABLE IF NOT EXISTS public.account_merge_snapshots (
  tenant_id uuid NOT NULL CONSTRAINT account_merge_snapshots_tenant_id_fkey
    REFERENCES public.tenants (id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  workspace_id uuid NOT NULL,
  members jsonb NOT NULL,
  state_sha256 text NOT NULL,
  updated_at timestamptz NOT NULL,
  CONSTRAINT account_merge_snapshots_pkey PRIMARY KEY (tenant_id, workspace_id),
  CONSTRAINT account_merge_snapshots_tenant_workspace_fkey
    FOREIGN KEY (tenant_id, workspace_id) REFERENCES public.workspaces (tenant_id, id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT account_merge_snapshots_members_chk
    CHECK (pg_catalog.jsonb_typeof(members) = 'array'),
  CONSTRAINT account_merge_snapshots_hash_chk CHECK (state_sha256 ~ '^[0-9a-f]{64}$')
);

CREATE OR REPLACE FUNCTION public.novatrade_l05_immutable()
RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog AS $function$
BEGIN
  RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='L05_RECORD_IMMUTABLE';
END;
$function$;

CREATE OR REPLACE FUNCTION public.novatrade_l05_run_scope_guard()
RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog AS $function$
DECLARE plan_row public.discovery_plans%ROWTYPE;
BEGIN
  SELECT * INTO plan_row FROM public.discovery_plans p WHERE p.plan_id = NEW.plan_id;
  IF NOT FOUND OR NEW.tenant_id IS DISTINCT FROM plan_row.tenant_id
    OR NEW.workspace_id IS DISTINCT FROM plan_row.workspace_id THEN
    RAISE EXCEPTION USING ERRCODE='23514', MESSAGE='L05_RUN_PLAN_SCOPE_MISMATCH';
  END IF;
  RETURN NEW;
END;
$function$;

CREATE OR REPLACE FUNCTION public.novatrade_l05_run_guard()
RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog AS $function$
BEGIN
  IF NEW.run_id IS DISTINCT FROM OLD.run_id OR NEW.tenant_id IS DISTINCT FROM OLD.tenant_id
    OR NEW.workspace_id IS DISTINCT FROM OLD.workspace_id OR NEW.plan_id IS DISTINCT FROM OLD.plan_id
    OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='L05_RUN_IDENTITY_IMMUTABLE';
  END IF;
  IF NEW.updated_at <= OLD.updated_at OR NEW.run_sha256 = OLD.run_sha256 THEN
    RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='L05_RUN_STALE_UPDATE';
  END IF;
  IF OLD.status IN ('completed', 'failed', 'cancelled') THEN
    RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='L05_RUN_TERMINAL';
  END IF;
  IF NOT ((OLD.status = 'planned' AND NEW.status IN ('running', 'cancelled'))
    OR (OLD.status = 'running' AND NEW.status IN ('completed', 'failed', 'cancelled'))) THEN
    RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='L05_RUN_INVALID_TRANSITION';
  END IF;
  RETURN NEW;
END;
$function$;

CREATE OR REPLACE FUNCTION public.novatrade_l05_account_guard()
RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog AS $function$
BEGIN
  IF NEW.account_id IS DISTINCT FROM OLD.account_id OR NEW.tenant_id IS DISTINCT FROM OLD.tenant_id
    OR NEW.workspace_id IS DISTINCT FROM OLD.workspace_id
    OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='L05_ACCOUNT_IDENTITY_IMMUTABLE';
  END IF;
  IF NEW.updated_at < OLD.updated_at OR NEW.version < OLD.version THEN
    RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='L05_ACCOUNT_STALE_UPDATE';
  END IF;
  RETURN NEW;
END;
$function$;

CREATE OR REPLACE FUNCTION public.novatrade_l05_account_redirect_guard()
RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog AS $function$
DECLARE redirect_row public.canonical_accounts%ROWTYPE;
BEGIN
  IF NEW.redirect_to_account_id IS NOT NULL THEN
    SELECT * INTO redirect_row FROM public.canonical_accounts a
    WHERE a.account_id = NEW.redirect_to_account_id;
    IF NOT FOUND OR redirect_row.tenant_id IS DISTINCT FROM NEW.tenant_id
      OR redirect_row.workspace_id IS DISTINCT FROM NEW.workspace_id
      OR redirect_row.status <> 'active' THEN
      RAISE EXCEPTION USING ERRCODE='23514', MESSAGE='L05_ACCOUNT_REDIRECT_SCOPE_MISMATCH';
    END IF;
  END IF;
  RETURN NEW;
END;
$function$;

CREATE OR REPLACE FUNCTION public.novatrade_l05_merge_snapshot_guard()
RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog AS $function$
BEGIN
  IF NEW.tenant_id IS DISTINCT FROM OLD.tenant_id OR NEW.workspace_id IS DISTINCT FROM OLD.workspace_id THEN
    RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='L05_MERGE_SNAPSHOT_IDENTITY_IMMUTABLE';
  END IF;
  IF NEW.updated_at <= OLD.updated_at OR NEW.state_sha256 = OLD.state_sha256 THEN
    RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='L05_MERGE_SNAPSHOT_STALE_UPDATE';
  END IF;
  RETURN NEW;
END;
$function$;

DROP TRIGGER IF EXISTS trg_discovery_plans_immutable ON public.discovery_plans;
CREATE TRIGGER trg_discovery_plans_immutable BEFORE UPDATE OR DELETE ON public.discovery_plans
FOR EACH ROW EXECUTE FUNCTION public.novatrade_l05_immutable();
DROP TRIGGER IF EXISTS trg_discovery_runs_scope ON public.discovery_runs;
CREATE TRIGGER trg_discovery_runs_scope BEFORE INSERT ON public.discovery_runs
FOR EACH ROW EXECUTE FUNCTION public.novatrade_l05_run_scope_guard();
DROP TRIGGER IF EXISTS trg_discovery_runs_guard ON public.discovery_runs;
CREATE TRIGGER trg_discovery_runs_guard BEFORE UPDATE ON public.discovery_runs
FOR EACH ROW EXECUTE FUNCTION public.novatrade_l05_run_guard();
DROP TRIGGER IF EXISTS trg_canonical_accounts_redirect ON public.canonical_accounts;
CREATE TRIGGER trg_canonical_accounts_redirect BEFORE INSERT OR UPDATE ON public.canonical_accounts
FOR EACH ROW EXECUTE FUNCTION public.novatrade_l05_account_redirect_guard();
DROP TRIGGER IF EXISTS trg_canonical_accounts_guard ON public.canonical_accounts;
CREATE TRIGGER trg_canonical_accounts_guard BEFORE UPDATE ON public.canonical_accounts
FOR EACH ROW EXECUTE FUNCTION public.novatrade_l05_account_guard();
DROP TRIGGER IF EXISTS trg_account_source_observations_immutable ON public.account_source_observations;
CREATE TRIGGER trg_account_source_observations_immutable BEFORE UPDATE OR DELETE
ON public.account_source_observations FOR EACH ROW EXECUTE FUNCTION public.novatrade_l05_immutable();
DROP TRIGGER IF EXISTS trg_account_resolutions_immutable ON public.account_resolutions;
CREATE TRIGGER trg_account_resolutions_immutable BEFORE UPDATE OR DELETE ON public.account_resolutions
FOR EACH ROW EXECUTE FUNCTION public.novatrade_l05_immutable();
DROP TRIGGER IF EXISTS trg_account_merge_events_immutable ON public.account_merge_events;
CREATE TRIGGER trg_account_merge_events_immutable BEFORE UPDATE OR DELETE ON public.account_merge_events
FOR EACH ROW EXECUTE FUNCTION public.novatrade_l05_immutable();
DROP TRIGGER IF EXISTS trg_account_merge_snapshots_guard ON public.account_merge_snapshots;
CREATE TRIGGER trg_account_merge_snapshots_guard BEFORE UPDATE ON public.account_merge_snapshots
FOR EACH ROW EXECUTE FUNCTION public.novatrade_l05_merge_snapshot_guard();
DROP TRIGGER IF EXISTS trg_account_merge_snapshots_immutable ON public.account_merge_snapshots;
CREATE TRIGGER trg_account_merge_snapshots_immutable BEFORE DELETE ON public.account_merge_snapshots
FOR EACH ROW EXECUTE FUNCTION public.novatrade_l05_immutable();

DO $security$
DECLARE target_table text; target_role text; target_function text;
BEGIN
  FOREACH target_table IN ARRAY ARRAY[
    'discovery_plans', 'discovery_runs', 'canonical_accounts',
    'account_source_observations', 'account_resolutions',
    'account_merge_events', 'account_merge_snapshots'
  ] LOOP
    EXECUTE pg_catalog.format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', target_table);
    EXECUTE pg_catalog.format('ALTER TABLE public.%I FORCE ROW LEVEL SECURITY', target_table);
    EXECUTE pg_catalog.format('REVOKE ALL ON TABLE public.%I FROM PUBLIC', target_table);
    FOREACH target_role IN ARRAY ARRAY['anon', 'authenticated'] LOOP
      IF EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = target_role) THEN
        EXECUTE pg_catalog.format('REVOKE ALL ON TABLE public.%I FROM %I', target_table, target_role);
      END IF;
    END LOOP;
  END LOOP;
  FOREACH target_function IN ARRAY ARRAY[
    'public.novatrade_l05_immutable()', 'public.novatrade_l05_run_scope_guard()',
    'public.novatrade_l05_run_guard()', 'public.novatrade_l05_account_guard()',
    'public.novatrade_l05_account_redirect_guard()', 'public.novatrade_l05_merge_snapshot_guard()'
  ] LOOP
    EXECUTE pg_catalog.format('REVOKE ALL ON FUNCTION %s FROM PUBLIC', target_function);
    FOREACH target_role IN ARRAY ARRAY['anon', 'authenticated'] LOOP
      IF EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = target_role) THEN
        EXECUTE pg_catalog.format('REVOKE ALL ON FUNCTION %s FROM %I', target_function, target_role);
      END IF;
    END LOOP;
  END LOOP;
END;
$security$;

COMMENT ON TABLE public.discovery_plans IS
  'Immutable hash-verified discovery plans bound to an approved play activation; never mutated after insert.';
COMMENT ON TABLE public.discovery_runs IS
  'Discovery run aggregates with a guarded planned/running/terminal state machine; payloads carry the full hash-chained document.';
COMMENT ON TABLE public.canonical_accounts IS
  'Canonical account projections. Merges never erase rows: a merged account keeps its identity and redirect target for reversible unmerge.';
COMMENT ON TABLE public.account_source_observations IS
  'Append-only bindings from source identities to canonical accounts; provenance hashes are preserved verbatim.';
COMMENT ON TABLE public.account_resolutions IS
  'Append-only account-resolution receipts explaining auto-resolve, candidate, and human-review outcomes.';
COMMENT ON TABLE public.account_merge_events IS
  'Append-only human merge/unmerge evidence; unmerge restores the retired account projection.';
COMMENT ON TABLE public.account_merge_snapshots IS
  'One optimistic-concurrency merge ledger per tenant/workspace scope.';

DO $receipt$
DECLARE table_count integer; rls_count integer; policy_count integer; trigger_count integer;
BEGIN
  SELECT count(*) INTO table_count FROM pg_catalog.pg_class c
  JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
  WHERE n.nspname = 'public' AND c.relkind = 'r' AND c.relname = ANY (ARRAY[
    'discovery_plans', 'discovery_runs', 'canonical_accounts',
    'account_source_observations', 'account_resolutions',
    'account_merge_events', 'account_merge_snapshots']);
  SELECT count(*) INTO rls_count FROM pg_catalog.pg_class c
  JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
  WHERE n.nspname = 'public' AND c.relrowsecurity AND c.relforcerowsecurity
    AND c.relname = ANY (ARRAY[
      'discovery_plans', 'discovery_runs', 'canonical_accounts',
      'account_source_observations', 'account_resolutions',
      'account_merge_events', 'account_merge_snapshots']);
  SELECT count(*) INTO policy_count FROM pg_catalog.pg_policy p
  WHERE p.polrelid = ANY (ARRAY[
    'public.discovery_plans'::regclass, 'public.discovery_runs'::regclass,
    'public.canonical_accounts'::regclass, 'public.account_source_observations'::regclass,
    'public.account_resolutions'::regclass, 'public.account_merge_events'::regclass,
    'public.account_merge_snapshots'::regclass]);
  SELECT count(*) INTO trigger_count FROM pg_catalog.pg_trigger t
  WHERE NOT t.tgisinternal AND t.tgrelid = ANY (ARRAY[
    'public.discovery_plans'::regclass, 'public.discovery_runs'::regclass,
    'public.canonical_accounts'::regclass, 'public.account_source_observations'::regclass,
    'public.account_resolutions'::regclass, 'public.account_merge_events'::regclass,
    'public.account_merge_snapshots'::regclass]);
  IF table_count <> 7 OR rls_count <> 7 OR policy_count <> 0 OR trigger_count <> 10 THEN
    RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='L05_DISCOVERY_PIPELINE_CATALOG_INCOMPLETE';
  END IF;
END;
$receipt$;
COMMIT;
