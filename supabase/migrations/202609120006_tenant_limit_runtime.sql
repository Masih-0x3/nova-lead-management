-- L-02: Postgres write/read path for the tenant-limit (quota) store.
--
-- The 202609120003 limit tables are RLS-enabled with zero policies — the
-- restricted runtime role can neither read nor write them. The designed path
-- is this SECURITY DEFINER family: every function validates the
-- transaction-local member GUC context installed by withTenantDbContext
-- (novatrade_rls_member_context, the same helper the foundation RLS policies
-- use) and binds the request tenant/actor to the accepted context, then
-- performs the atomic operation server-side.
--
-- Concurrency: a transaction-scoped advisory lock keyed on (tenant, action)
-- serializes consume and configuration changes for the same lane — the same
-- mutual exclusion the SQLite single-writer backend had locally.
--
-- Every authorization/context failure returns a 'denied' outcome row (or NULL
-- for the read function) instead of raising, so the family stays
-- non-enumerating for EXECUTE-only callers. Write-time failures (guard
-- triggers, constraints) deliberately propagate so the statement aborts and
-- partial writes roll back.

-- Member-context runtime-state read: tenant status, the per-action
-- configuration version, the platform kill-switch state, and the tenant's
-- action kills + policy caps. NULL for any context/scope failure.
CREATE OR REPLACE FUNCTION public.novatrade_tenant_limit_runtime_state(
  p_tenant_id pg_catalog.text,
  p_action pg_catalog.text
)
RETURNS pg_catalog.jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
DECLARE
  v_tenant_status pg_catalog.text;
  v_cfg record;
  v_platform record;
  v_tenant_kills pg_catalog.jsonb;
  v_tenant_caps pg_catalog.jsonb;
  v_platform_kills pg_catalog.jsonb;
BEGIN
  IF NOT public.novatrade_rls_member_context()
     OR coalesce(pg_catalog.current_setting('app.tenant_id', true), '') <> p_tenant_id
  THEN
    RETURN NULL;
  END IF;

  SELECT tenant.status::pg_catalog.text INTO v_tenant_status
  FROM public.tenants AS tenant
  WHERE tenant.id::pg_catalog.text = p_tenant_id;
  IF NOT FOUND THEN
    RETURN NULL;
  END IF;

  SELECT cfg.configuration_version, cfg.policy_cap, cfg.action_kill
  INTO v_cfg
  FROM public.tenant_limit_configuration AS cfg
  WHERE cfg.tenant_id::pg_catalog.text = p_tenant_id AND cfg.action = p_action;

  SELECT platform.configuration_version, platform.global_kill, platform.action_kills_json
  INTO v_platform
  FROM public.platform_limit_configuration AS platform
  WHERE platform.id = 'platform';

  SELECT coalesce(pg_catalog.jsonb_object_agg(action, pg_catalog.to_jsonb(true)), '{}'::pg_catalog.jsonb)
  INTO v_tenant_kills
  FROM public.tenant_limit_configuration AS cfg
  WHERE cfg.tenant_id::pg_catalog.text = p_tenant_id AND cfg.action_kill;

  SELECT coalesce(pg_catalog.jsonb_object_agg(action, pg_catalog.to_jsonb(policy_cap)), '{}'::pg_catalog.jsonb)
  INTO v_tenant_caps
  FROM public.tenant_limit_configuration AS cfg
  WHERE cfg.tenant_id::pg_catalog.text = p_tenant_id AND cfg.policy_cap IS NOT NULL;

  -- Mirror parseActionKills: keep only whitelisted actions whose value is
  -- exactly jsonb true; a non-object payload degrades to an empty map.
  SELECT coalesce(pg_catalog.jsonb_object_agg(entry.key, pg_catalog.to_jsonb(true)), '{}'::pg_catalog.jsonb)
  INTO v_platform_kills
  FROM pg_catalog.jsonb_each(
    CASE WHEN pg_catalog.jsonb_typeof(v_platform.action_kills_json) = 'object'
         THEN v_platform.action_kills_json ELSE '{}'::pg_catalog.jsonb END
  ) AS entry
  WHERE entry.value = 'true'::pg_catalog.jsonb
    AND entry.key IN (
      'membership_invite', 'support_grant_request', 'support_grant_approval',
      'knowledge_upload', 'export_request', 'deletion_request', 'worker_start',
      'agent_plan_expensive', 'recovery_bookkeeping'
    );

  RETURN pg_catalog.jsonb_build_object(
    'tenantId', p_tenant_id,
    'tenantStatus', v_tenant_status,
    'configurationVersion', coalesce(v_cfg.configuration_version, 1),
    'platformConfigurationVersion', coalesce(v_platform.configuration_version, 1),
    'platformGlobalKill', coalesce(v_platform.global_kill, false),
    'platformActionKills', v_platform_kills,
    'tenantActionKills', v_tenant_kills,
    'tenantPolicyCaps', v_tenant_caps
  );
END;
$$;

COMMENT ON FUNCTION public.novatrade_tenant_limit_runtime_state(pg_catalog.text, pg_catalog.text) IS
  'L-02 tenant-limit runtime-state read for member contexts: returns the per-action configuration version, platform kill-switch state, and tenant kills/caps; NULL for invalid context or scope mismatch.';

REVOKE ALL ON FUNCTION public.novatrade_tenant_limit_runtime_state(pg_catalog.text, pg_catalog.text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.novatrade_tenant_limit_runtime_state(pg_catalog.text, pg_catalog.text) FROM anon;
REVOKE ALL ON FUNCTION public.novatrade_tenant_limit_runtime_state(pg_catalog.text, pg_catalog.text) FROM authenticated;

-- The atomic consume: revalidates every expected fact (tenant status, both
-- configuration versions, kill switches, effective cap, feature-policy
-- version), honors idempotency replay/conflict, applies sliding-window bucket
-- accounting, and reserves buckets + the idempotency record atomically.
-- p_request is text, not jsonb: the postgres.js driver double-encodes a JS
-- string bound to a jsonb parameter (it arrives as a jsonb string scalar, not
-- an object), so the request travels as text and is parsed here — the same
-- convention p_audit_metadata follows in the policy functions.
CREATE OR REPLACE FUNCTION public.novatrade_tenant_limit_consume(
  p_request pg_catalog.text
)
RETURNS TABLE (
  outcome pg_catalog.text,
  remaining pg_catalog.int4,
  reset_at_ms pg_catalog.int8
)
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
DECLARE
  v_request pg_catalog.jsonb := p_request::pg_catalog.jsonb;
  v_tenant_id pg_catalog.text := v_request ->> 'tenantId';
  v_actor_id pg_catalog.text := v_request ->> 'actorId';
  v_action pg_catalog.text := v_request ->> 'action';
  v_idempotency_key pg_catalog.text := v_request ->> 'idempotencyKey';
  v_request_hash pg_catalog.text := v_request ->> 'requestHash';
  v_amount pg_catalog.int4 := (v_request ->> 'amount')::pg_catalog.int4;
  v_hard_bound pg_catalog.int4 := (v_request ->> 'hardBound')::pg_catalog.int4;
  v_now_ms pg_catalog.int8 := (v_request ->> 'nowMs')::pg_catalog.int8;
  v_expected_tenant_status pg_catalog.text := v_request ->> 'expectedTenantStatus';
  v_expected_cfg_version pg_catalog.int4 := (v_request ->> 'expectedConfigurationVersion')::pg_catalog.int4;
  v_expected_platform_version pg_catalog.int4 := (v_request ->> 'expectedPlatformConfigurationVersion')::pg_catalog.int4;
  v_expected_cap pg_catalog.int4 := (v_request ->> 'expectedTenantPolicyCap')::pg_catalog.int4;
  v_expected_policy_version pg_catalog.int4 := (v_request ->> 'expectedFeaturePolicyVersion')::pg_catalog.int4;
  -- Server-derived facts: the action's platform hard cap, sliding window, and
  -- the two bucket keys are recomputed here, never trusted from the caller. A
  -- direct caller cannot inflate the platform cap, forge another tenant's
  -- bucket keys, shrink the window, or supply a far-future clock to reset it.
  v_platform_hard_cap pg_catalog.int4;
  v_window_ms pg_catalog.int8;
  v_tenant_key pg_catalog.text;
  v_actor_key pg_catalog.text;
  v_db_now_ms pg_catalog.int8;
  v_tenant_status pg_catalog.text;
  v_cfg record;
  v_platform record;
  v_effective_cap pg_catalog.int4;
  v_prior_tenant pg_catalog.uuid;
  v_prior_hash pg_catalog.text;
  v_used pg_catalog.int4[] := ARRAY[0, 0];
  v_reset pg_catalog.int8[];
  v_i pg_catalog.int4;
  v_key pg_catalog.text;
  v_row_used pg_catalog.int4;
  v_row_reset pg_catalog.int8;
BEGIN
  -- The accepted member context is the only authority: the request tenant and
  -- actor must be exactly the context's — a member cannot consume against
  -- another tenant or another member's actor bucket.
  IF NOT public.novatrade_rls_member_context()
     OR coalesce(pg_catalog.current_setting('app.tenant_id', true), '') IS DISTINCT FROM v_tenant_id
     OR coalesce(pg_catalog.current_setting('app.actor_id', true), '') IS DISTINCT FROM v_actor_id
  THEN
    RETURN QUERY SELECT 'denied'::pg_catalog.text, NULL::pg_catalog.int4, NULL::pg_catalog.int8;
    RETURN;
  END IF;

  -- Derive the action's platform hard cap, window, and expected bucket
  -- digests from the context-bound tenant/actor/action — the caller's copies
  -- must match these.
  SELECT policy.hard_cap, policy.window_ms INTO v_platform_hard_cap, v_window_ms
  FROM (VALUES
    ('membership_invite',      100,   86400000::pg_catalog.int8),
    ('support_grant_request',  20,    86400000::pg_catalog.int8),
    ('support_grant_approval', 20,    86400000::pg_catalog.int8),
    ('knowledge_upload',       1000,  3600000::pg_catalog.int8),
    ('export_request',         50,    86400000::pg_catalog.int8),
    ('deletion_request',       10,    86400000::pg_catalog.int8),
    ('worker_start',           200,   3600000::pg_catalog.int8),
    ('agent_plan_expensive',   100,   3600000::pg_catalog.int8),
    ('recovery_bookkeeping',   100,   86400000::pg_catalog.int8)
  ) AS policy(action, hard_cap, window_ms)
  WHERE policy.action = v_action;

  -- Bucket digests join fields with NUL separators; the material is built as
  -- bytea because text cannot hold 0x00.
  v_tenant_key := 'tenant:' || pg_catalog.encode(pg_catalog.sha256(
    pg_catalog.convert_to(v_action, 'UTF8') || '\x00'::pg_catalog.bytea
      || pg_catalog.convert_to(v_tenant_id, 'UTF8')), 'hex');
  v_actor_key := 'actor:' || pg_catalog.encode(pg_catalog.sha256(
    pg_catalog.convert_to(v_action, 'UTF8') || '\x00'::pg_catalog.bytea
      || pg_catalog.convert_to(v_tenant_id, 'UTF8') || '\x00'::pg_catalog.bytea
      || pg_catalog.convert_to(v_actor_id, 'UTF8')), 'hex');
  v_db_now_ms := (pg_catalog.date_part('epoch', pg_catalog.statement_timestamp()) * 1000)::pg_catalog.int8;

  IF v_tenant_id IS NULL OR v_actor_id IS NULL OR v_action IS NULL
     OR v_platform_hard_cap IS NULL
     OR v_idempotency_key IS NULL OR v_idempotency_key !~ '^[0-9a-f]{64}$'
     OR v_request_hash IS NULL OR v_request_hash !~ '^[0-9a-f]{64}$'
     OR (v_request -> 'buckets' -> 0 ->> 'scope') IS DISTINCT FROM 'tenant'
     OR (v_request -> 'buckets' -> 0 ->> 'key') IS DISTINCT FROM v_tenant_key
     OR (v_request -> 'buckets' -> 1 ->> 'scope') IS DISTINCT FROM 'actor'
     OR (v_request -> 'buckets' -> 1 ->> 'key') IS DISTINCT FROM v_actor_key
     OR v_window_ms IS NULL OR (v_request -> 'windowMs') IS DISTINCT FROM pg_catalog.to_jsonb(v_window_ms)
     OR v_amount IS NULL OR v_amount <= 0
     OR v_hard_bound IS NULL OR v_hard_bound <= 0
     OR (v_request -> 'platformHardCap') IS DISTINCT FROM pg_catalog.to_jsonb(v_platform_hard_cap)
     OR v_now_ms IS NULL OR v_now_ms < 0
     OR pg_catalog.abs(v_now_ms - v_db_now_ms) > 60000
     OR v_expected_tenant_status IS NULL
     OR v_expected_cfg_version IS NULL OR v_expected_cfg_version < 1
     OR v_expected_platform_version IS NULL OR v_expected_platform_version < 1
     OR v_expected_cap IS NULL OR v_expected_cap < 1
     OR (v_request -> 'expectedPlatformGlobalKill') IS DISTINCT FROM 'false'::pg_catalog.jsonb
     OR (v_request -> 'expectedPlatformActionKill') IS DISTINCT FROM 'false'::pg_catalog.jsonb
     OR (v_request -> 'expectedTenantActionKill') IS DISTINCT FROM 'false'::pg_catalog.jsonb
  THEN
    RETURN QUERY SELECT 'invalid_request'::pg_catalog.text, NULL::pg_catalog.int4, NULL::pg_catalog.int8;
    RETURN;
  END IF;

  -- Serialize this (tenant, action) lane for the rest of the transaction.
  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(v_tenant_id || ':' || v_action, 0)
  );

  -- Revalidate the expected state inside the same transaction.
  SELECT tenant.status::pg_catalog.text INTO v_tenant_status
  FROM public.tenants AS tenant
  WHERE tenant.id::pg_catalog.text = v_tenant_id;

  SELECT cfg.configuration_version, cfg.policy_cap, cfg.action_kill
  INTO v_cfg
  FROM public.tenant_limit_configuration AS cfg
  WHERE cfg.tenant_id::pg_catalog.text = v_tenant_id AND cfg.action = v_action;

  SELECT platform.configuration_version, platform.global_kill, platform.action_kills_json
  INTO v_platform
  FROM public.platform_limit_configuration AS platform
  WHERE platform.id = 'platform';

  v_effective_cap := coalesce(v_cfg.policy_cap, v_platform_hard_cap);
  IF v_tenant_status IS NULL
     OR v_tenant_status <> v_expected_tenant_status
     OR coalesce(v_cfg.configuration_version, 1) <> v_expected_cfg_version
     OR coalesce(v_platform.configuration_version, 1) <> v_expected_platform_version
     OR coalesce(v_platform.global_kill, false)
     OR coalesce(v_platform.action_kills_json -> v_action, 'null'::pg_catalog.jsonb) = 'true'::pg_catalog.jsonb
     OR coalesce(v_cfg.action_kill, false)
     OR v_effective_cap <> v_expected_cap
     OR least(v_platform_hard_cap, v_effective_cap) <> v_hard_bound
  THEN
    RETURN QUERY SELECT 'state_changed'::pg_catalog.text, NULL::pg_catalog.int4, NULL::pg_catalog.int8;
    RETURN;
  END IF;

  IF v_expected_policy_version IS NOT NULL THEN
    IF NOT EXISTS (
      SELECT 1 FROM public.tenant_policies AS policy
      WHERE policy.tenant_id::pg_catalog.text = v_tenant_id
        AND policy.version = v_expected_policy_version
    ) THEN
      RETURN QUERY SELECT 'policy_blocked'::pg_catalog.text, NULL::pg_catalog.int4, NULL::pg_catalog.int8;
      RETURN;
    END IF;
  END IF;

  -- Idempotency: an existing reservation either replays or conflicts — and a
  -- reservation owned by another tenant is never revealed to this context.
  SELECT idem.tenant_id, idem.request_hash INTO v_prior_tenant, v_prior_hash
  FROM public.tenant_limit_idempotency AS idem
  WHERE idem.idempotency_key = v_idempotency_key;
  IF FOUND THEN
    IF v_prior_tenant::pg_catalog.text <> v_tenant_id THEN
      RETURN QUERY SELECT 'denied'::pg_catalog.text, NULL::pg_catalog.int4, NULL::pg_catalog.int8;
      RETURN;
    END IF;
    IF v_prior_hash <> v_request_hash THEN
      RETURN QUERY SELECT 'idempotency_conflict'::pg_catalog.text, NULL::pg_catalog.int4, NULL::pg_catalog.int8;
      RETURN;
    END IF;
    SELECT bucket.used, bucket.reset_at_ms INTO v_row_used, v_row_reset
    FROM public.tenant_limit_buckets AS bucket
    WHERE bucket.bucket_key = v_tenant_key;
    IF v_row_used IS NULL OR v_now_ms >= v_row_reset THEN
      v_row_used := 0;
      v_row_reset := v_now_ms + v_window_ms;
    END IF;
    RETURN QUERY SELECT 'replayed'::pg_catalog.text,
      greatest(0, v_hard_bound - v_row_used)::pg_catalog.int4,
      least(greatest(v_row_reset, v_now_ms), v_now_ms + v_window_ms)::pg_catalog.int8;
    RETURN;
  END IF;

  -- Lock and snapshot both bucket rows in deterministic key order. The
  -- advisory lock already serializes every writer of this lane; FOR UPDATE is
  -- belt-and-suspenders against any future writer outside the function family.
  v_reset := ARRAY[v_now_ms + v_window_ms, v_now_ms + v_window_ms];
  v_i := 0;
  FOREACH v_key IN ARRAY ARRAY[v_tenant_key, v_actor_key] LOOP
    v_i := v_i + 1;
    -- SELECT INTO leaves the targets untouched when no row is found; reset
    -- them so a missing bucket can never inherit the other bucket's counters.
    v_row_used := NULL;
    v_row_reset := NULL;
    SELECT bucket.used, bucket.reset_at_ms INTO v_row_used, v_row_reset
    FROM public.tenant_limit_buckets AS bucket
    WHERE bucket.bucket_key = v_key
    FOR UPDATE OF bucket;
    IF v_row_used IS NOT NULL AND v_now_ms < v_row_reset THEN
      v_used[v_i] := v_row_used;
      v_reset[v_i] := v_row_reset;
    END IF;
  END LOOP;

  -- Refuse when any bucket would exceed the hard bound.
  FOR v_i IN 1..2 LOOP
    IF v_used[v_i] + v_amount > v_hard_bound THEN
      RETURN QUERY SELECT 'rate_limited'::pg_catalog.text,
        greatest(0, v_hard_bound - v_used[v_i])::pg_catalog.int4,
        least(greatest(v_reset[v_i], v_now_ms), v_now_ms + v_window_ms)::pg_catalog.int8;
      RETURN;
    END IF;
  END LOOP;

  INSERT INTO public.tenant_limit_buckets (bucket_key, used, reset_at_ms, updated_at)
  VALUES (v_tenant_key, v_used[1] + v_amount, v_reset[1], pg_catalog.statement_timestamp()),
         (v_actor_key, v_used[2] + v_amount, v_reset[2], pg_catalog.statement_timestamp())
  ON CONFLICT (bucket_key) DO UPDATE SET
    used = excluded.used,
    reset_at_ms = excluded.reset_at_ms,
    updated_at = excluded.updated_at;

  INSERT INTO public.tenant_limit_idempotency (idempotency_key, request_hash, tenant_id, action)
  VALUES (v_idempotency_key, v_request_hash, v_tenant_id::pg_catalog.uuid, v_action);

  RETURN QUERY SELECT 'consumed'::pg_catalog.text,
    least(v_hard_bound - (v_used[1] + v_amount), v_hard_bound - (v_used[2] + v_amount))::pg_catalog.int4,
    least(v_reset[1], v_reset[2])::pg_catalog.int8;
END;
$$;

COMMENT ON FUNCTION public.novatrade_tenant_limit_consume(pg_catalog.text) IS
  'L-02 atomic tenant-limit consume for member contexts: advisory-locks the (tenant, action) lane, revalidates expected state, honors idempotency, applies sliding-window bucket accounting, and reserves buckets + idempotency atomically.';

REVOKE ALL ON FUNCTION public.novatrade_tenant_limit_consume(pg_catalog.text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.novatrade_tenant_limit_consume(pg_catalog.text) FROM anon;
REVOKE ALL ON FUNCTION public.novatrade_tenant_limit_consume(pg_catalog.text) FROM authenticated;

-- Tenant limit-configuration CAS: the member context must hold the action's
-- fixed configuration permission (feature:manage → owner/admin;
-- budget:manage → owner/admin/strategist_manager). Exactly one mutation field
-- per call (cap XOR kill), mirroring the canonical service.
CREATE OR REPLACE FUNCTION public.novatrade_change_tenant_limit_configuration(
  p_tenant_id pg_catalog.text,
  p_action pg_catalog.text,
  p_expected_version pg_catalog.int4,
  p_policy_cap pg_catalog.int4,
  p_action_kill pg_catalog.bool,
  p_audit_event pg_catalog.text
)
RETURNS TABLE (
  outcome pg_catalog.text,
  configuration_version pg_catalog.int4
)
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
DECLARE
  v_role pg_catalog.text := coalesce(pg_catalog.current_setting('app.role', true), '');
  v_permission pg_catalog.text;
  v_capable pg_catalog.bool;
  v_hard_cap pg_catalog.int4;
  v_cfg record;
  v_resulting pg_catalog.int4;
  v_new_cap pg_catalog.int4;
  v_new_kill pg_catalog.bool;
  v_updated pg_catalog.int4;
BEGIN
  -- The action's fixed configuration permission and platform hard cap are
  -- derived here, never taken from the caller.
  SELECT policy.permission, policy.hard_cap INTO v_permission, v_hard_cap
  FROM (VALUES
    ('membership_invite',      'budget:manage',  100),
    ('support_grant_request',  'feature:manage', 20),
    ('support_grant_approval', 'feature:manage', 20),
    ('knowledge_upload',       'budget:manage',  1000),
    ('export_request',         'budget:manage',  50),
    ('deletion_request',       'budget:manage',  100),
    ('worker_start',           'budget:manage',  200),
    ('agent_plan_expensive',   'budget:manage',  100),
    ('recovery_bookkeeping',   'budget:manage',  100)
  ) AS policy(action, permission, hard_cap)
  WHERE policy.action = p_action;

  v_capable := CASE v_permission
    WHEN 'feature:manage' THEN v_role IN ('owner', 'admin')
    WHEN 'budget:manage' THEN v_role IN ('owner', 'admin', 'strategist_manager')
    ELSE false
  END;

  IF NOT public.novatrade_rls_member_context()
     OR coalesce(pg_catalog.current_setting('app.tenant_id', true), '') <> p_tenant_id
     OR NOT v_capable
  THEN
    RETURN QUERY SELECT 'denied'::pg_catalog.text, NULL::pg_catalog.int4;
    RETURN;
  END IF;

  IF p_expected_version IS NULL OR p_expected_version < 1
     OR (p_policy_cap IS NULL) = (p_action_kill IS NULL)
     OR (p_policy_cap IS NOT NULL AND (p_policy_cap < 1 OR p_policy_cap > v_hard_cap))
  THEN
    RETURN QUERY SELECT 'invalid_request'::pg_catalog.text, NULL::pg_catalog.int4;
    RETURN;
  END IF;

  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(p_tenant_id || ':' || p_action, 0)
  );

  SELECT cfg.configuration_version, cfg.policy_cap, cfg.action_kill
  INTO v_cfg
  FROM public.tenant_limit_configuration AS cfg
  WHERE cfg.tenant_id::pg_catalog.text = p_tenant_id AND cfg.action = p_action;

  IF coalesce(v_cfg.configuration_version, 1) <> p_expected_version THEN
    RETURN QUERY SELECT 'conflict'::pg_catalog.text, coalesce(v_cfg.configuration_version, 1);
    RETURN;
  END IF;

  v_resulting := p_expected_version + 1;
  v_new_cap := coalesce(p_policy_cap, v_cfg.policy_cap);
  v_new_kill := coalesce(p_action_kill, coalesce(v_cfg.action_kill, false));

  INSERT INTO public.tenant_limit_configuration AS cfg
    (tenant_id, action, configuration_version, policy_cap, action_kill, updated_at)
  VALUES (p_tenant_id::pg_catalog.uuid, p_action, v_resulting, v_new_cap, v_new_kill,
          pg_catalog.statement_timestamp())
  ON CONFLICT (tenant_id, action) DO UPDATE SET
    configuration_version = excluded.configuration_version,
    policy_cap = excluded.policy_cap,
    action_kill = excluded.action_kill,
    updated_at = excluded.updated_at
  WHERE cfg.configuration_version = excluded.configuration_version - 1;
  GET DIAGNOSTICS v_updated = ROW_COUNT;
  IF v_updated <> 1 THEN
    RETURN QUERY SELECT 'conflict'::pg_catalog.text, coalesce(v_cfg.configuration_version, 1);
    RETURN;
  END IF;

  INSERT INTO public.tenant_limit_events (event_id, event_type, tenant_id, action, payload_json)
  VALUES (pg_catalog.gen_random_uuid(), 'tenant_limit_configuration_changed',
          p_tenant_id::pg_catalog.uuid, p_action, p_audit_event::pg_catalog.jsonb);

  RETURN QUERY SELECT 'applied'::pg_catalog.text, v_resulting;
END;
$$;

COMMENT ON FUNCTION public.novatrade_change_tenant_limit_configuration(pg_catalog.text, pg_catalog.text, pg_catalog.int4, pg_catalog.int4, pg_catalog.bool, pg_catalog.text) IS
  'L-02 tenant limit-configuration CAS for member contexts: derives the action-fixed permission + hard cap server-side, advisory-locks the lane, CAS-updates the configuration row, and appends the limit event atomically.';

REVOKE ALL ON FUNCTION public.novatrade_change_tenant_limit_configuration(pg_catalog.text, pg_catalog.text, pg_catalog.int4, pg_catalog.int4, pg_catalog.bool, pg_catalog.text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.novatrade_change_tenant_limit_configuration(pg_catalog.text, pg_catalog.text, pg_catalog.int4, pg_catalog.int4, pg_catalog.bool, pg_catalog.text) FROM anon;
REVOKE ALL ON FUNCTION public.novatrade_change_tenant_limit_configuration(pg_catalog.text, pg_catalog.text, pg_catalog.int4, pg_catalog.int4, pg_catalog.bool, pg_catalog.text) FROM authenticated;
