-- L-02 tenant status-transition write path (suspend / resume / archive).
--
-- The tenants foundation table is RLS-enabled with member-select +
-- support-select read policies and a deny-all-else write posture, so the
-- restricted runtime role cannot UPDATE status directly — the member-facing
-- transition goes through this SECURITY DEFINER function, which re-validates
-- the transaction-local member GUC context installed by withTenantDbContext
-- (novatrade_rls_member_context, the same helper the RLS policies use),
-- binds the request tenant/actor to the accepted context, enforces the
-- owner/admin capability the tenant:lifecycle permission reserves, applies
-- the canonical transition matrix, CAS-updates the status, and appends the
-- member-layer audit row — all in one statement.
--
-- Member-facing edges only: expectedCurrentState is restricted to
-- {active, suspended} and toStatus to {suspended, active, archived} — the
-- same whitelist the application schema applies. The deletion edges
-- (archived → deletion_pending, deletion_pending → archived/deleted) are
-- deliberately absent: deletion entry and the cancel-rollback edge mutate
-- the deletion-job ledger in the same transaction and are owned by the
-- deletion port, never by a bare status transition.
--
-- p_request is text, not jsonb — the postgres.js driver double-encodes a
-- JS string bound to a jsonb parameter, so the request travels as text and
-- is parsed here (the p_audit_metadata convention).
--
-- The returned tenant row is the post-transition read: a suspended or
-- archived tenant no longer satisfies novatrade_rls_member_context (the
-- helper requires status = 'active'), so the member context is dead for
-- the rest of the transaction and a member-RLS re-read cannot see the row.
-- The function returns the committed row instead. Symmetrically, a
-- suspended tenant has no member context at all — session bootstrap and
-- this function both require an active tenant — so resume/archive from
-- suspended are not member-callable under Postgres; they belong to a
-- support/platform context lane.
--
-- Outcome vocabulary maps onto the canonical TenantLifecycleOpsError codes:
--   applied          → the caller maps to OK_SUSPENDED / OK_RESUMED / OK_ARCHIVED
--   not_found        → NOT_FOUND_NON_ENUMERATING (absent, foreign, stale, or
--                      CAS-loser rows are deliberately indistinguishable)
--   state_conflict   → BLOCKED_STATE_CONFLICT
--   actor_scope      → BLOCKED_ACTOR_SCOPE (in-context role below owner/admin)
--   invalid_request  → BLOCKED_MALFORMED
--   denied           → context/scope failure, also mapped non-enumerating

CREATE OR REPLACE FUNCTION public.novatrade_transition_tenant_status(
  p_request pg_catalog.text
)
RETURNS TABLE (
  outcome pg_catalog.text,
  tenant_status pg_catalog.text,
  tenant pg_catalog.jsonb
)
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
DECLARE
  v_request pg_catalog.jsonb := p_request::pg_catalog.jsonb;
  v_req_tenant pg_catalog.text := v_request ->> 'tenantId';
  v_req_actor pg_catalog.text := v_request ->> 'actorId';
  v_expected pg_catalog.text := v_request ->> 'expectedCurrentState';
  v_to pg_catalog.text := v_request ->> 'toStatus';
  v_reason_code pg_catalog.text := v_request ->> 'reasonCode';
  v_reason pg_catalog.text := v_request ->> 'reason';
  v_correlation pg_catalog.text := v_request ->> 'correlationId';
  v_audit_event_id pg_catalog.text := v_request ->> 'auditEventId';
  v_tenant_id pg_catalog.text := coalesce(pg_catalog.current_setting('app.tenant_id', true), '');
  v_workspace_id pg_catalog.text := coalesce(pg_catalog.current_setting('app.workspace_id', true), '');
  v_actor_id pg_catalog.text := coalesce(pg_catalog.current_setting('app.actor_id', true), '');
  v_membership_id pg_catalog.text := coalesce(pg_catalog.current_setting('app.membership_id', true), '');
  v_role pg_catalog.text := coalesce(pg_catalog.current_setting('app.role', true), '');
  v_binding_id pg_catalog.text := coalesce(pg_catalog.current_setting('app.role_binding_id', true), '');
  v_ctx_correlation pg_catalog.text := coalesce(pg_catalog.current_setting('app.correlation_id', true), '');
  v_current_status pg_catalog.text;
  v_event_type pg_catalog.text;
  v_updated pg_catalog.int4;
  v_tenant pg_catalog.jsonb;
BEGIN
  -- The accepted member context is the only authority: the request tenant
  -- and actor must be exactly the context's. A tenant-wide session is
  -- required — the member-facing audit row is tenant-scoped (workspace_id
  -- NULL) and the append-only guard re-validates it against the GUC, so a
  -- workspace-scoped context cannot produce a conforming audit row.
  IF NOT public.novatrade_rls_member_context()
     OR v_workspace_id <> ''
     OR v_req_tenant IS NULL OR v_req_tenant IS DISTINCT FROM v_tenant_id
     OR v_req_actor IS NULL OR v_req_actor IS DISTINCT FROM v_actor_id
  THEN
    RETURN QUERY SELECT 'denied'::pg_catalog.text, NULL::pg_catalog.text, NULL::pg_catalog.jsonb;
    RETURN;
  END IF;

  -- Request validity mirrors the canonical prepareTransitionRequest checks:
  -- member-facing status whitelists plus the same field shapes the local
  -- service enforces on reasonCode / reason / correlationId / actorId.
  IF v_expected IS NULL OR v_expected NOT IN ('active', 'suspended')
     OR v_to IS NULL OR v_to NOT IN ('active', 'suspended', 'archived')
     OR v_reason_code IS NULL
     OR v_reason_code !~ '^[a-z0-9][a-z0-9._-]{2,79}$'
     OR v_reason IS NULL OR pg_catalog.length(v_reason) < 1 OR pg_catalog.length(v_reason) > 500
     OR v_reason ~ '[\x00-\x1F\x7F-\x9F]'
     OR v_correlation IS NULL
     OR v_correlation !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$'
     OR v_audit_event_id IS NULL
     OR v_audit_event_id !~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'
  THEN
    RETURN QUERY SELECT 'invalid_request'::pg_catalog.text, NULL::pg_catalog.text, NULL::pg_catalog.jsonb;
    RETURN;
  END IF;

  -- Tenant must exist in the expected state — absent, foreign, and stale are
  -- deliberately indistinguishable (the canonical service's getTenant +
  -- status comparison maps all three to NOT_FOUND_NON_ENUMERATING).
  SELECT tenant.status::pg_catalog.text INTO v_current_status
  FROM public.tenants AS tenant
  WHERE tenant.id::pg_catalog.text = v_tenant_id;
  IF v_current_status IS NULL OR v_current_status <> v_expected THEN
    RETURN QUERY SELECT 'not_found'::pg_catalog.text, NULL::pg_catalog.text, NULL::pg_catalog.jsonb;
    RETURN;
  END IF;

  -- The canonical transition matrix, applied server-side so a direct caller
  -- cannot reach an illegal edge. The member-facing whitelists above already
  -- exclude the deletion edges; the matrix still guards the remaining pairs
  -- (e.g. active → active is not a transition).
  IF NOT EXISTS (
    SELECT 1 FROM (VALUES
      ('active', 'suspended'), ('active', 'archived'),
      ('suspended', 'active'), ('suspended', 'archived'),
      ('archived', 'deletion_pending'),
      ('deletion_pending', 'archived'), ('deletion_pending', 'deleted')
    ) AS edge(from_status, to_status)
    WHERE edge.from_status = v_expected AND edge.to_status = v_to
  ) THEN
    RETURN QUERY SELECT 'state_conflict'::pg_catalog.text, v_current_status, NULL::pg_catalog.jsonb;
    RETURN;
  END IF;

  -- tenant:lifecycle is owner/admin only in the permission matrix; the
  -- member-context helper already proved the binding live.
  IF v_role NOT IN ('owner', 'admin') THEN
    RETURN QUERY SELECT 'actor_scope'::pg_catalog.text, v_current_status, NULL::pg_catalog.jsonb;
    RETURN;
  END IF;

  -- Serialize transitions on this tenant for the rest of the transaction.
  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(v_tenant_id || ':tenant-status', 0)
  );

  UPDATE public.tenants AS tenant
  SET status = v_to, updated_at = pg_catalog.statement_timestamp()
  WHERE tenant.id::pg_catalog.text = v_tenant_id
    AND tenant.status::pg_catalog.text = v_expected;
  GET DIAGNOSTICS v_updated = ROW_COUNT;
  IF v_updated <> 1 THEN
    RETURN QUERY SELECT 'not_found'::pg_catalog.text, NULL::pg_catalog.text, NULL::pg_catalog.jsonb;
    RETURN;
  END IF;

  v_event_type := CASE v_to
    WHEN 'suspended' THEN 'tenant.suspended'
    WHEN 'active' THEN 'tenant.resumed'
    ELSE 'tenant.archived'
  END;

  -- The append-only guard re-validates every actor/scope field against the
  -- installed GUCs; a mismatch aborts the whole statement, so a transition
  -- can never land without its member-layer audit row. The metadata mirrors
  -- the local appendLifecycleAudit event shape.
  INSERT INTO public.audit_logs (
    id, action, entity_type, entity_id, metadata, scope_kind,
    tenant_id, workspace_id, correlation_id,
    actor_auth_identity_id, actor_membership_id,
    actor_launch_role, actor_role_binding_id, actor_layer
  ) VALUES (
    v_audit_event_id,
    v_event_type,
    'tenant',
    v_tenant_id,
    pg_catalog.jsonb_build_object(
      'eventId', v_audit_event_id,
      'eventType', v_event_type,
      'tenantId', v_tenant_id,
      'workspaceId', NULL,
      'jobId', NULL,
      'actorIdentityId', v_actor_id,
      'actorLayer', 'member',
      'actorMembershipId', v_membership_id,
      'actorRole', v_role,
      'actorRoleBindingId', v_binding_id,
      'correlationId', v_correlation,
      'tenantFromStatus', v_expected,
      'tenantToStatus', v_to,
      'reasonCode', v_reason_code,
      'reason', v_reason,
      'occurredAt', pg_catalog.to_char(
        pg_catalog.statement_timestamp() AT TIME ZONE 'UTC',
        'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
    ),
    'tenant',
    v_tenant_id::pg_catalog.uuid,
    NULL,
    v_correlation,
    v_actor_id::pg_catalog.uuid,
    v_membership_id::pg_catalog.uuid,
    v_role,
    v_binding_id::pg_catalog.uuid,
    'member'
  );

  SELECT pg_catalog.jsonb_build_object(
      'id', row_.id::pg_catalog.text,
      'slug', row_.slug,
      'name', row_.name,
      'status', row_.status::pg_catalog.text,
      'locale', row_.locale,
      'timezone', row_.timezone,
      'created_at', pg_catalog.to_char(row_.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
      'updated_at', pg_catalog.to_char(row_.updated_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
    ) INTO v_tenant
  FROM public.tenants AS row_
  WHERE row_.id::pg_catalog.text = v_tenant_id;

  RETURN QUERY SELECT 'applied'::pg_catalog.text, v_to, v_tenant;
END;
$$;

COMMENT ON FUNCTION public.novatrade_transition_tenant_status(pg_catalog.text) IS
  'L-02 tenant status transition for member contexts: re-validates the member GUC context (tenant-wide, owner/admin), applies the canonical transition matrix member edges only (active/suspended → suspended/active/archived), CAS-updates tenants.status, and appends the member-layer audit row atomically. Denials return outcome rows.';
REVOKE ALL ON FUNCTION public.novatrade_transition_tenant_status(pg_catalog.text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.novatrade_transition_tenant_status(pg_catalog.text) FROM anon;
REVOKE ALL ON FUNCTION public.novatrade_transition_tenant_status(pg_catalog.text) FROM authenticated;
