-- ============================================================================
-- L-02 T-042: support-authorization lane — check/authorizeAndRun on Postgres.
--
-- The member-side support surface (request/approve/revoke/list + journal +
-- event ledger) shipped in migration 202609120008 behind member-context
-- gates. The support-actor lane is separate: the edge authenticates a
-- platform-support principal and asserts the tenant/workspace/grant envelope
-- as transaction-local GUCs (installed by withTenantDbContext from the
-- support-session assertion), then check/authorizeAndRun re-validate the
-- grant server-side before any scoped data read runs under the support RLS
-- predicates.
--
-- Two authority levels are deliberately distinct:
--   * novatrade_support_lane_shape() — the *structural* lane: well-formed
--     support GUCs, no member/worker fields, the named tenant exists. Journal
--     reservations, decision events, the asserted-grant readback, and the
--     workspace existence probe ride this lane so denials (expired, revoked,
--     suspended-tenant, foreign-tenant) still ledger honestly.
--   * novatrade_rls_support_context() — the *authority* lane from T-027:
--     the grant must be approved, unrevoked, in-window, and tenant/workspace/
--     actor-bound on an active tenant. Scoped data reads and current-principal
--     resolution require it; an asserted but invalid envelope cannot mint
--     visibility.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- Internal structural lane predicate. Well-formed support GUCs naming an
-- existing tenant, with every member and worker field empty. This is NOT an
-- authorization check — it only proves the envelope's shape so the ledger
-- and the bound readback can run before (and after) the grant itself is
-- judged. Not executable by runtime roles.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.novatrade_support_lane_shape()
RETURNS pg_catalog.bool
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  tenant_setting text := pg_catalog.current_setting('app.tenant_id', true);
  workspace_setting text := pg_catalog.current_setting('app.workspace_id', true);
  actor_setting text := pg_catalog.current_setting('app.actor_id', true);
  grant_setting text := pg_catalog.current_setting('app.support_grant_id', true);
  correlation_setting text := pg_catalog.current_setting('app.correlation_id', true);
BEGIN
  IF tenant_setting IS NULL OR tenant_setting !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
     OR actor_setting IS NULL OR actor_setting !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
     OR grant_setting IS NULL OR grant_setting !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
     OR correlation_setting IS NULL
     OR correlation_setting !~ '^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$'
     OR coalesce(workspace_setting, '') <> '' AND workspace_setting !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
  THEN
    RETURN false;
  END IF;

  -- Support is a distinct authority: member and worker fields must be empty,
  -- including stale pooled values from a prior transaction.
  IF coalesce(pg_catalog.current_setting('app.membership_id', true), '') <> ''
     OR coalesce(pg_catalog.current_setting('app.role', true), '') <> ''
     OR coalesce(pg_catalog.current_setting('app.role_binding_id', true), '') <> ''
     OR coalesce(pg_catalog.current_setting('app.job_id', true), '') <> ''
     OR coalesce(pg_catalog.current_setting('app.run_id', true), '') <> ''
     OR coalesce(pg_catalog.current_setting('app.lease_id', true), '') <> ''
     OR coalesce(pg_catalog.current_setting('app.lease_generation', true), '') <> ''
     OR coalesce(pg_catalog.current_setting('app.worker_name', true), '') <> ''
     OR coalesce(pg_catalog.current_setting('app.worker_action', true), '') <> ''
     OR coalesce(pg_catalog.current_setting('app.worker_principal_kind', true), '') <> ''
  THEN
    RETURN false;
  END IF;

  -- The named tenant must exist (any status): suspended and archived tenants
  -- still need their support denials journaled, and the authority predicate
  -- remains the gate on actual data visibility.
  RETURN EXISTS (
    SELECT 1 FROM public.tenants AS tenant WHERE tenant.id = tenant_setting::uuid
  );
EXCEPTION
  WHEN others THEN
    RETURN false;
END;
$$;

COMMENT ON FUNCTION public.novatrade_support_lane_shape() IS
  'L-02 T-042 structural support-lane predicate: well-formed support GUCs naming an existing tenant with no member/worker fields. Lane admission for journal/event/readback functions — NOT a data-access authority.';
REVOKE ALL ON FUNCTION public.novatrade_support_lane_shape() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.novatrade_support_lane_shape() FROM anon;
REVOKE ALL ON FUNCTION public.novatrade_support_lane_shape() FROM authenticated;

-- ---------------------------------------------------------------------------
-- Journal reservation, widened to dual-lane. The derived key hash already
-- binds tenant, actor, operation, and caller key, so member and support
-- envelopes cannot collide; both lanes therefore share the reserve→complete
-- contract. Member ops require the full member context; support ops require
-- the structural lane so denials under invalid envelopes still ledger.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.novatrade_support_access_reserve(
  p_request pg_catalog.text
)
RETURNS TABLE (
  outcome pg_catalog.text,
  reservation_id pg_catalog.text,
  prior_input_hash pg_catalog.text,
  prior_result pg_catalog.jsonb
)
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
DECLARE
  v_request pg_catalog.jsonb := p_request::pg_catalog.jsonb;
  v_operation pg_catalog.text := v_request ->> 'operation';
  v_key pg_catalog.text := v_request ->> 'idempotencyKey';
  v_input_hash pg_catalog.text := v_request ->> 'inputHash';
  v_tenant_id pg_catalog.text := coalesce(pg_catalog.current_setting('app.tenant_id', true), '');
  v_actor_id pg_catalog.text := coalesce(pg_catalog.current_setting('app.actor_id', true), '');
  v_key_hash pg_catalog.text;
  v_existing public.support_access_journal%ROWTYPE;
BEGIN
  IF NOT public.novatrade_rls_member_context()
     AND NOT public.novatrade_support_lane_shape()
  THEN
    RETURN QUERY SELECT 'denied'::pg_catalog.text, NULL::pg_catalog.text, NULL::pg_catalog.text, NULL::pg_catalog.jsonb;
    RETURN;
  END IF;

  IF v_operation IS NULL OR v_operation NOT IN ('request', 'approve', 'revoke', 'check', 'authorize_and_run', 'list_current', 'list_history')
     OR v_key IS NULL OR v_key !~ '^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$'
     OR v_input_hash IS NULL OR v_input_hash !~ '^[0-9a-f]{64}$'
  THEN
    RETURN QUERY SELECT 'invalid_request'::pg_catalog.text, NULL::pg_catalog.text, NULL::pg_catalog.text, NULL::pg_catalog.jsonb;
    RETURN;
  END IF;

  -- The reservation lane is context-bound: tenant, actor, operation, and the
  -- caller key are all inside the digest, so lanes cannot collide or be probed
  -- across tenants. NUL separators ride a bytea concat — NUL is not valid in
  -- Postgres text.
  v_key_hash := pg_catalog.encode(pg_catalog.sha256(
    pg_catalog.convert_to('support-access', 'UTF8') || '\x00'::pg_catalog.bytea
      || pg_catalog.convert_to(v_tenant_id, 'UTF8') || '\x00'::pg_catalog.bytea
      || pg_catalog.convert_to(v_actor_id, 'UTF8') || '\x00'::pg_catalog.bytea
      || pg_catalog.convert_to(v_operation, 'UTF8') || '\x00'::pg_catalog.bytea
      || pg_catalog.convert_to(v_key, 'UTF8')
  ), 'hex');

  SELECT journal.* INTO v_existing
  FROM public.support_access_journal AS journal
  WHERE journal.idempotency_key_hash = v_key_hash;

  IF NOT FOUND THEN
    INSERT INTO public.support_access_journal (
      idempotency_key_hash, input_hash, operation, tenant_id, actor_namespace
    ) VALUES (
      v_key_hash, v_input_hash, v_operation, v_tenant_id::pg_catalog.uuid, v_actor_id
    );
    RETURN QUERY SELECT 'new'::pg_catalog.text, v_key_hash, NULL::pg_catalog.text, NULL::pg_catalog.jsonb;
    RETURN;
  END IF;

  IF v_existing.input_hash IS DISTINCT FROM v_input_hash
     OR v_existing.tenant_id IS DISTINCT FROM v_tenant_id::pg_catalog.uuid
     OR v_existing.actor_namespace IS DISTINCT FROM v_actor_id
  THEN
    RETURN QUERY SELECT 'conflict'::pg_catalog.text, NULL::pg_catalog.text, NULL::pg_catalog.text, NULL::pg_catalog.jsonb;
    RETURN;
  END IF;

  IF v_existing.status = 'completed' AND v_existing.result_json IS NOT NULL THEN
    RETURN QUERY SELECT 'replay'::pg_catalog.text, NULL::pg_catalog.text, v_existing.input_hash, v_existing.result_json;
    RETURN;
  END IF;

  RETURN QUERY SELECT 'conflict'::pg_catalog.text, NULL::pg_catalog.text, NULL::pg_catalog.text, NULL::pg_catalog.jsonb;
END;
$$;

COMMENT ON FUNCTION public.novatrade_support_access_reserve(pg_catalog.text) IS
  'L-02 dual-lane idempotency reservation for support-access operations; derives the journal key hash from context-bound tenant/actor/operation/key under member or support-session envelopes and returns new/replay/conflict outcome rows.';
REVOKE ALL ON FUNCTION public.novatrade_support_access_reserve(pg_catalog.text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.novatrade_support_access_reserve(pg_catalog.text) FROM anon;
REVOKE ALL ON FUNCTION public.novatrade_support_access_reserve(pg_catalog.text) FROM authenticated;

-- Reservation completion, widened to the same dual lane.
CREATE OR REPLACE FUNCTION public.novatrade_support_access_commit(
  p_request pg_catalog.text
)
RETURNS TABLE (committed pg_catalog.bool)
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
DECLARE
  v_request pg_catalog.jsonb := p_request::pg_catalog.jsonb;
  v_reservation pg_catalog.text := v_request ->> 'reservationId';
  v_result pg_catalog.jsonb := v_request -> 'result';
  v_tenant_id pg_catalog.text := coalesce(pg_catalog.current_setting('app.tenant_id', true), '');
  v_actor_id pg_catalog.text := coalesce(pg_catalog.current_setting('app.actor_id', true), '');
  v_updated pg_catalog.int4;
BEGIN
  IF NOT public.novatrade_rls_member_context()
     AND NOT public.novatrade_support_lane_shape()
  THEN
    RETURN QUERY SELECT false;
    RETURN;
  END IF;

  IF v_reservation IS NULL OR v_reservation !~ '^[0-9a-f]{64}$'
     OR v_result IS NULL OR pg_catalog.jsonb_typeof(v_result) <> 'object'
  THEN
    RETURN QUERY SELECT false;
    RETURN;
  END IF;

  UPDATE public.support_access_journal AS journal
  SET status = 'completed',
      result_json = v_result,
      completed_at = pg_catalog.statement_timestamp()
  WHERE journal.idempotency_key_hash = v_reservation
    AND journal.status = 'reserved'
    AND journal.tenant_id = v_tenant_id::pg_catalog.uuid
    AND journal.actor_namespace = v_actor_id;
  GET DIAGNOSTICS v_updated = ROW_COUNT;

  RETURN QUERY SELECT v_updated = 1;
END;
$$;

COMMENT ON FUNCTION public.novatrade_support_access_commit(pg_catalog.text) IS
  'L-02 dual-lane idempotency commit; completes a reserved journal row bound to the context tenant and actor namespace under member or support-session envelopes.';
REVOKE ALL ON FUNCTION public.novatrade_support_access_commit(pg_catalog.text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.novatrade_support_access_commit(pg_catalog.text) FROM anon;
REVOKE ALL ON FUNCTION public.novatrade_support_access_commit(pg_catalog.text) FROM authenticated;

-- ---------------------------------------------------------------------------
-- Decision event append, widened to dual-lane. Member envelopes keep the
-- existing member-layer binding; support envelopes record support-layer
-- events with tenant, actor, and correlation bound to the installed support
-- GUCs. Referenced grant/workspace ids stay verbatim in both lanes: denials
-- legitimately name prospective or absent rows.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.novatrade_support_access_append_event(
  p_event pg_catalog.text
)
RETURNS TABLE (recorded pg_catalog.bool)
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
DECLARE
  v_event pg_catalog.jsonb := p_event::pg_catalog.jsonb;
  v_event_id pg_catalog.text := v_event ->> 'eventId';
  v_operation pg_catalog.text := v_event ->> 'operation';
  v_tenant pg_catalog.text := v_event ->> 'tenantId';
  v_workspace pg_catalog.text := v_event ->> 'workspaceId';
  v_actor_layer pg_catalog.text := v_event ->> 'actorLayer';
  v_actor pg_catalog.text := v_event ->> 'actorId';
  v_grant pg_catalog.text := v_event ->> 'supportGrantId';
  v_permission pg_catalog.text := v_event ->> 'permission';
  v_data_classes pg_catalog.jsonb := v_event -> 'dataClasses';
  v_decision pg_catalog.text := v_event ->> 'decisionCode';
  v_reason pg_catalog.text := v_event ->> 'reasonCode';
  v_correlation pg_catalog.text := v_event ->> 'correlationId';
  v_attempt pg_catalog.text := v_event ->> 'attemptId';
  v_input_hash pg_catalog.text := v_event ->> 'inputHash';
  v_tenant_id pg_catalog.text := coalesce(pg_catalog.current_setting('app.tenant_id', true), '');
  v_workspace_id pg_catalog.text := coalesce(pg_catalog.current_setting('app.workspace_id', true), '');
  v_actor_id pg_catalog.text := coalesce(pg_catalog.current_setting('app.actor_id', true), '');
  v_ctx_correlation pg_catalog.text := coalesce(pg_catalog.current_setting('app.correlation_id', true), '');
BEGIN
  IF public.novatrade_rls_member_context() THEN
    IF v_tenant IS NULL OR v_tenant IS DISTINCT FROM v_tenant_id
       OR v_actor_layer IS DISTINCT FROM 'member'
       OR v_actor IS NULL OR v_actor IS DISTINCT FROM v_actor_id
       OR v_correlation IS NULL OR v_correlation IS DISTINCT FROM v_ctx_correlation
       OR (v_workspace_id <> '' AND v_workspace IS NOT NULL AND v_workspace IS DISTINCT FROM v_workspace_id)
    THEN
      RETURN QUERY SELECT false;
      RETURN;
    END IF;
  ELSIF public.novatrade_support_lane_shape() THEN
    -- Support denials for unresolved principals ledger with actor_id NULL —
    -- the asserted identity stays bound through journal.actor_namespace and
    -- the GUCs. A non-null event actor must equal the asserted actor.
    IF v_tenant IS NULL OR v_tenant IS DISTINCT FROM v_tenant_id
       OR v_actor_layer IS DISTINCT FROM 'support'
       OR (v_actor IS NOT NULL AND v_actor IS DISTINCT FROM v_actor_id)
       OR v_correlation IS NULL OR v_correlation IS DISTINCT FROM v_ctx_correlation
    THEN
      RETURN QUERY SELECT false;
      RETURN;
    END IF;
  ELSE
    RETURN QUERY SELECT false;
    RETURN;
  END IF;

  IF v_event_id IS NULL OR v_event_id !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
     OR v_operation IS NULL OR v_operation NOT IN ('request', 'approve', 'revoke', 'check', 'authorize_and_run', 'list_current', 'list_history')
     OR (v_workspace IS NOT NULL AND v_workspace !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$')
     OR (v_grant IS NOT NULL AND v_grant !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$')
     OR (v_permission IS NOT NULL AND v_permission !~ '^[a-z][a-z:_-]{2,39}$')
     OR v_data_classes IS NULL OR pg_catalog.jsonb_typeof(v_data_classes) <> 'array'
     OR v_decision IS NULL OR v_decision NOT IN (
       'OK_SUPPORT_GRANT_REQUESTED', 'OK_SUPPORT_GRANT_APPROVED', 'OK_SUPPORT_GRANT_REVOKED',
       'OK_SUPPORT_AUTHORIZED', 'OK_SUPPORT_REPLAY',
       'SUPPORT_GRANT_REQUIRED', 'SUPPORT_SCOPE_MISMATCH', 'SUPPORT_WORKSPACE_SCOPE_INVALID',
       'SUPPORT_POLICY_BLOCKED', 'SUPPORT_SELF_ACTION', 'SUPPORT_STATE_CONFLICT',
       'SUPPORT_NOT_FOUND_OR_FORBIDDEN', 'SUPPORT_MALFORMED', 'SUPPORT_INTERNAL')
     OR v_reason IS NULL OR v_reason !~ '^[a-z][a-z0-9._-]{2,79}$'
     OR v_attempt IS NULL OR v_attempt !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
     OR v_input_hash IS NULL OR v_input_hash !~ '^[0-9a-f]{64}$'
  THEN
    RETURN QUERY SELECT false;
    RETURN;
  END IF;

  INSERT INTO public.support_access_events (
    event_id, operation, tenant_id, workspace_id, actor_layer, actor_id,
    support_grant_id, permission, data_classes_json, decision_code,
    reason_code, correlation_id, attempt_id, input_hash
  ) VALUES (
    v_event_id::pg_catalog.uuid,
    v_operation,
    v_tenant_id::pg_catalog.uuid,
    CASE WHEN v_workspace IS NULL THEN NULL ELSE v_workspace::pg_catalog.uuid END,
    v_actor_layer,
    v_actor_id::pg_catalog.uuid,
    CASE WHEN v_grant IS NULL THEN NULL ELSE v_grant::pg_catalog.uuid END,
    v_permission,
    v_data_classes,
    v_decision,
    v_reason,
    v_correlation,
    v_attempt::pg_catalog.uuid,
    v_input_hash
  );

  RETURN QUERY SELECT true;
END;
$$;

COMMENT ON FUNCTION public.novatrade_support_access_append_event(pg_catalog.text) IS
  'L-02 dual-lane append to the support-access decision ledger; member envelopes record member-layer rows bound to member GUCs, support envelopes record support-layer rows bound to support GUCs. Referenced grant/workspace ids are recorded verbatim.';
REVOKE ALL ON FUNCTION public.novatrade_support_access_append_event(pg_catalog.text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.novatrade_support_access_append_event(pg_catalog.text) FROM anon;
REVOKE ALL ON FUNCTION public.novatrade_support_access_append_event(pg_catalog.text) FROM authenticated;

-- ---------------------------------------------------------------------------
-- Asserted-grant readback for the support lane. The envelope may read back
-- exactly the grant it asserts — bound to app.support_grant_id and the
-- envelope tenant — so the service can re-validate scope, permission, data
-- classes, and eligibility. Under the structural lane (not the full
-- authority predicate) so expired/revoked/suspended envelopes still return
-- the row the service needs to produce the correct non-enumerating denial.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.novatrade_support_access_grant_read()
RETURNS pg_catalog.jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_tenant_id pg_catalog.text := coalesce(pg_catalog.current_setting('app.tenant_id', true), '');
  v_grant_id pg_catalog.text := coalesce(pg_catalog.current_setting('app.support_grant_id', true), '');
  v_grant public.support_access_grants%ROWTYPE;
BEGIN
  IF NOT public.novatrade_support_lane_shape() THEN
    RETURN NULL;
  END IF;

  SELECT grant_row.* INTO v_grant
  FROM public.support_access_grants AS grant_row
  WHERE grant_row.id = v_grant_id::pg_catalog.uuid
    AND grant_row.tenant_id = v_tenant_id::pg_catalog.uuid;

  IF NOT FOUND THEN
    RETURN NULL;
  END IF;

  RETURN public.novatrade_support_access_grant_json(v_grant.id);
END;
$$;

COMMENT ON FUNCTION public.novatrade_support_access_grant_read() IS
  'L-02 T-042 support-lane asserted-grant readback: returns the canonical grant bundle for the envelope''s own support_grant_id under the structural lane, tenant-bound. NULL without a lane or for a foreign/absent grant.';
REVOKE ALL ON FUNCTION public.novatrade_support_access_grant_read() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.novatrade_support_access_grant_read() FROM anon;
REVOKE ALL ON FUNCTION public.novatrade_support_access_grant_read() FROM authenticated;

-- ---------------------------------------------------------------------------
-- Workspace existence probe for the support lane. check() verifies an
-- asserted workspace scope exists in the envelope tenant; under the
-- structural lane the probe returns a bare boolean and never row data.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.novatrade_support_access_workspace_exists(
  p_workspace_id pg_catalog.uuid
)
RETURNS pg_catalog.bool
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_tenant_id pg_catalog.text := coalesce(pg_catalog.current_setting('app.tenant_id', true), '');
BEGIN
  IF NOT public.novatrade_support_lane_shape() OR p_workspace_id IS NULL THEN
    RETURN false;
  END IF;

  RETURN EXISTS (
    SELECT 1
    FROM public.workspaces AS workspace
    WHERE workspace.id = p_workspace_id
      AND workspace.tenant_id = v_tenant_id::pg_catalog.uuid
  );
END;
$$;

COMMENT ON FUNCTION public.novatrade_support_access_workspace_exists(pg_catalog.uuid) IS
  'L-02 T-042 support-lane workspace existence probe bound to the envelope tenant; returns a bare boolean so scope checks stay non-enumerating.';
REVOKE ALL ON FUNCTION public.novatrade_support_access_workspace_exists(pg_catalog.uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.novatrade_support_access_workspace_exists(pg_catalog.uuid) FROM anon;
REVOKE ALL ON FUNCTION public.novatrade_support_access_workspace_exists(pg_catalog.uuid) FROM authenticated;

-- ---------------------------------------------------------------------------
-- Principal resolution, widened to dual-lane. Member envelopes resolve
-- member-selected targets as before; support envelopes may resolve only the
-- acting principal's own reference (self-bound to app.actor_id), which is
-- all check() needs to prove the asserted reference names the session actor.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.novatrade_support_principal_resolve(
  p_reference pg_catalog.text
)
RETURNS TABLE (
  auth_identity_id pg_catalog.uuid,
  platform_role pg_catalog.text
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
DECLARE
  v_actor_id pg_catalog.text := coalesce(pg_catalog.current_setting('app.actor_id', true), '');
BEGIN
  IF p_reference IS NULL
     OR pg_catalog.char_length(p_reference) < 1
     OR pg_catalog.char_length(p_reference) > 256
  THEN
    RETURN;
  END IF;

  IF public.novatrade_rls_member_context() THEN
    RETURN QUERY
    SELECT principal.auth_identity_id, 'platform_support'::pg_catalog.text
    FROM public.platform_support_principals AS principal
    WHERE principal.reference = p_reference
      AND principal.status = 'active';
    RETURN;
  END IF;

  IF public.novatrade_support_lane_shape() THEN
    RETURN QUERY
    SELECT principal.auth_identity_id, 'platform_support'::pg_catalog.text
    FROM public.platform_support_principals AS principal
    WHERE principal.reference = p_reference
      AND principal.status = 'active'
      AND principal.auth_identity_id = v_actor_id::pg_catalog.uuid;
    RETURN;
  END IF;
END;
$$;

COMMENT ON FUNCTION public.novatrade_support_principal_resolve(pg_catalog.text) IS
  'L-02 dual-lane principal resolution; member envelopes map member-selected references to live principals, support envelopes resolve only the session actor''s own reference.';
REVOKE ALL ON FUNCTION public.novatrade_support_principal_resolve(pg_catalog.text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.novatrade_support_principal_resolve(pg_catalog.text) FROM anon;
REVOKE ALL ON FUNCTION public.novatrade_support_principal_resolve(pg_catalog.text) FROM authenticated;

-- ---------------------------------------------------------------------------
-- principal_current predates this lane (202609120008) and may carry ambient
-- EXECUTE grants from provisioning drift. The support lane now treats it as
-- an internal, edge-bound resolver — assert the internal-only posture here.
-- ---------------------------------------------------------------------------
REVOKE ALL ON FUNCTION public.novatrade_support_principal_current() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.novatrade_support_principal_current() FROM anon;
REVOKE ALL ON FUNCTION public.novatrade_support_principal_current() FROM authenticated;
