-- L-02 member-side support-access write path (request / approve / revoke /
-- list journaling) — the Postgres twin of createSqliteSupportAccessTransaction.
--
-- The support-operation tables are deliberately hostile to the restricted
-- runtime role: support_access_journal and support_access_events are
-- RLS-enabled with zero read/write policies and append-only guards,
-- platform_support_principals is a zero-policy operator registry, and
-- support_access_grants carries member-select but deny-all-else write
-- policies. Every member-facing write therefore goes through these SECURITY
-- DEFINER functions, each of which re-validates the transaction-local member
-- GUCs installed by withTenantDbContext (novatrade_rls_member_context, the
-- same helper the RLS policies use) and binds tenant, actor, workspace, and
-- correlation facts to the accepted context — a direct EXECUTE caller cannot
-- borrow another tenant's journal lane, another member's actor identity, or
-- another workspace's scope.
--
-- Reads (getGrant / listGrants / verifyWorkspace / verifyMemberAuthority) are
-- intentionally absent here: the member-select policies on grants,
-- workspaces, memberships, and role bindings already expose exactly the
-- accepted-context slice, so the adapter reads them through member RLS like
-- the other canonical ports.
--
-- Request payloads are text, not jsonb: the postgres.js driver double-encodes
-- a JS string bound to a jsonb parameter, so every function takes text and
-- parses internally (the p_audit_metadata convention).
--
-- The journal key hash is derived server-side —
-- sha256('support-access'\0 tenant \0 actor \0 operation \0 idempotencyKey) —
-- so a caller cannot probe or replay another tenant's reservation lane.
-- Nested result payloads travel inside the request jsonb and are extracted
-- as jsonb, so they never pass through the driver's scalar encoder.

CREATE OR REPLACE FUNCTION public.novatrade_support_access_grant_json(
  p_grant_id pg_catalog.uuid
)
RETURNS pg_catalog.jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
BEGIN
  RETURN (
    SELECT pg_catalog.jsonb_build_object(
      'id', grant_row.id::pg_catalog.text,
      'tenantId', grant_row.tenant_id::pg_catalog.text,
      'workspaceId', grant_row.workspace_id::pg_catalog.text,
      'supportActorAuthIdentityId', grant_row.support_actor_auth_identity_id::pg_catalog.text,
      'platformRole', grant_row.platform_role,
      'requestedByAuthIdentityId', grant_row.requested_by_auth_identity_id::pg_catalog.text,
      'approvedByAuthIdentityId', grant_row.approved_by_auth_identity_id::pg_catalog.text,
      'approvedAt', CASE WHEN grant_row.approved_at IS NULL THEN NULL ELSE pg_catalog.to_char(grant_row.approved_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') END,
      'revokedByAuthIdentityId', grant_row.revoked_by_auth_identity_id::pg_catalog.text,
      'revokedAt', CASE WHEN grant_row.revoked_at IS NULL THEN NULL ELSE pg_catalog.to_char(grant_row.revoked_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') END,
      'state', grant_row.state,
      'reasonCode', grant_row.reason_code,
      'reason', grant_row.reason,
      'startsAt', pg_catalog.to_char(grant_row.starts_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
      'expiresAt', pg_catalog.to_char(grant_row.expires_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
      'correlationId', grant_row.correlation_id,
      'auditEventId', grant_row.audit_event_id::pg_catalog.text,
      'permissions', COALESCE((
        SELECT pg_catalog.jsonb_agg(permission_row.permission ORDER BY permission_row.permission)
        FROM public.support_access_grant_permissions AS permission_row
        WHERE permission_row.grant_id = grant_row.id
      ), '[]'::pg_catalog.jsonb),
      'dataClasses', COALESCE((
        SELECT pg_catalog.jsonb_agg(data_class_row.data_class ORDER BY data_class_row.data_class)
        FROM public.support_access_grant_data_classes AS data_class_row
        WHERE data_class_row.grant_id = grant_row.id
      ), '[]'::pg_catalog.jsonb),
      'createdAt', pg_catalog.to_char(grant_row.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
      'updatedAt', pg_catalog.to_char(grant_row.updated_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
    )
    FROM public.support_access_grants AS grant_row
    WHERE grant_row.id = p_grant_id
  );
END;
$$;

COMMENT ON FUNCTION public.novatrade_support_access_grant_json(pg_catalog.uuid) IS
  'Internal builder: renders one grant row plus its ordered permission/data-class child arrays as the canonical SupportAccessGrant jsonb shape.';
REVOKE ALL ON FUNCTION public.novatrade_support_access_grant_json(pg_catalog.uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.novatrade_support_access_grant_json(pg_catalog.uuid) FROM anon;
REVOKE ALL ON FUNCTION public.novatrade_support_access_grant_json(pg_catalog.uuid) FROM authenticated;

-- Idempotency reservation. The member context's tenant/actor are the journal
-- namespace; the caller supplies only operation, idempotencyKey, and the
-- service-computed input hash. Returns one outcome row:
--   new        → reservation row inserted; reservation_id is the derived key
--   replay     → a completed reservation exists for the same input hash
--   conflict   → an in-flight reservation or a different input hash holds the key
--   denied / invalid_request → context binding or shape failure
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
  IF NOT public.novatrade_rls_member_context() THEN
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
  'L-02 member-context idempotency reservation for support-access operations; derives the journal key hash from context-bound tenant/actor/operation/key and returns new/replay/conflict outcome rows.';
REVOKE ALL ON FUNCTION public.novatrade_support_access_reserve(pg_catalog.text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.novatrade_support_access_reserve(pg_catalog.text) FROM anon;
REVOKE ALL ON FUNCTION public.novatrade_support_access_reserve(pg_catalog.text) FROM authenticated;

-- Reservation completion. The row stays bound to the context tenant and
-- actor namespace; the journal update guard enforces the reserved→completed
-- one-way transition.
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
  IF NOT public.novatrade_rls_member_context() THEN
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
  'L-02 member-context idempotency commit; completes a reserved journal row bound to the context tenant and actor namespace.';
REVOKE ALL ON FUNCTION public.novatrade_support_access_commit(pg_catalog.text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.novatrade_support_access_commit(pg_catalog.text) FROM anon;
REVOKE ALL ON FUNCTION public.novatrade_support_access_commit(pg_catalog.text) FROM authenticated;

-- Append-only decision event. Tenant, actor, and correlation are bound to
-- the installed member GUCs; the workspace scope follows the member-select
-- visibility rule (tenant-wide sessions may record any in-tenant workspace,
-- workspace sessions only their own or tenant-wide rows).
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
  IF NOT public.novatrade_rls_member_context()
     OR v_tenant IS NULL OR v_tenant IS DISTINCT FROM v_tenant_id
     OR v_actor_layer IS DISTINCT FROM 'member'
     OR v_actor IS NULL OR v_actor IS DISTINCT FROM v_actor_id
     OR v_correlation IS NULL OR v_correlation IS DISTINCT FROM v_ctx_correlation
     OR (v_workspace_id <> '' AND v_workspace IS NOT NULL AND v_workspace IS DISTINCT FROM v_workspace_id)
  THEN
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
  'L-02 member-context append to the support-access decision ledger; tenant, actor layer, actor, and correlation are bound to the installed member GUCs. Referenced grant/workspace ids are recorded verbatim: denials legitimately name prospective or absent rows.';
REVOKE ALL ON FUNCTION public.novatrade_support_access_append_event(pg_catalog.text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.novatrade_support_access_append_event(pg_catalog.text) FROM anon;
REVOKE ALL ON FUNCTION public.novatrade_support_access_append_event(pg_catalog.text) FROM authenticated;

-- Grant creation. The member context supplies tenant and requester; the
-- workspace scope follows member-select visibility; the support actor must
-- be a live registry principal and can never be the requester. Grant,
-- permission rows, and data-class rows land in one statement; the deferred
-- anchor foreign keys validate at commit like the local path.
CREATE OR REPLACE FUNCTION public.novatrade_support_access_create_grant(
  p_creation pg_catalog.text
)
RETURNS TABLE (grant_json pg_catalog.jsonb)
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
DECLARE
  v_creation pg_catalog.jsonb := p_creation::pg_catalog.jsonb;
  v_id pg_catalog.text := v_creation ->> 'id';
  v_tenant pg_catalog.text := v_creation ->> 'tenantId';
  v_workspace pg_catalog.text := v_creation ->> 'workspaceId';
  v_support_actor pg_catalog.text := v_creation ->> 'supportActorAuthIdentityId';
  v_platform_role pg_catalog.text := v_creation ->> 'platformRole';
  v_requester pg_catalog.text := v_creation ->> 'requestedByAuthIdentityId';
  v_reason_code pg_catalog.text := v_creation ->> 'reasonCode';
  v_reason pg_catalog.text := v_creation ->> 'reason';
  v_starts_at pg_catalog.text := v_creation ->> 'startsAt';
  v_expires_at pg_catalog.text := v_creation ->> 'expiresAt';
  v_correlation pg_catalog.text := v_creation ->> 'correlationId';
  v_audit_event pg_catalog.text := v_creation ->> 'auditEventId';
  v_permissions pg_catalog.jsonb := v_creation -> 'permissions';
  v_data_classes pg_catalog.jsonb := v_creation -> 'dataClasses';
  v_created_at pg_catalog.text := v_creation ->> 'createdAt';
  v_updated_at pg_catalog.text := v_creation ->> 'updatedAt';
  v_tenant_id pg_catalog.text := coalesce(pg_catalog.current_setting('app.tenant_id', true), '');
  v_workspace_id pg_catalog.text := coalesce(pg_catalog.current_setting('app.workspace_id', true), '');
  v_actor_id pg_catalog.text := coalesce(pg_catalog.current_setting('app.actor_id', true), '');
  v_ctx_correlation pg_catalog.text := coalesce(pg_catalog.current_setting('app.correlation_id', true), '');
BEGIN
  IF NOT public.novatrade_rls_member_context()
     OR v_tenant IS NULL OR v_tenant IS DISTINCT FROM v_tenant_id
     OR v_requester IS NULL OR v_requester IS DISTINCT FROM v_actor_id
     OR v_correlation IS NULL OR v_correlation IS DISTINCT FROM v_ctx_correlation
     OR (v_workspace_id <> '' AND v_workspace IS DISTINCT FROM v_workspace_id)
     OR v_support_actor IS NULL OR v_support_actor = v_actor_id
  THEN
    RETURN;
  END IF;

  IF v_id IS NULL OR v_id !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
     OR v_support_actor !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
     OR (v_workspace IS NOT NULL AND v_workspace !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$')
     OR v_platform_role IS DISTINCT FROM 'platform_support'
     OR v_reason_code IS NULL OR v_reason_code !~ '^[a-z][a-z0-9._-]{2,79}$'
     OR v_reason IS NULL OR pg_catalog.char_length(v_reason) < 1
        OR pg_catalog.char_length(v_reason) > 500
        OR pg_catalog.char_length(pg_catalog.btrim(v_reason)) < 1
     OR v_starts_at IS NULL OR v_expires_at IS NULL OR v_created_at IS NULL OR v_updated_at IS NULL
     OR v_starts_at !~ '^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$'
     OR v_expires_at !~ '^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$'
     OR v_created_at !~ '^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$'
     OR v_updated_at !~ '^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$'
     OR v_audit_event IS NULL OR v_audit_event !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
     OR v_permissions IS NULL OR pg_catalog.jsonb_typeof(v_permissions) <> 'array'
        OR pg_catalog.jsonb_array_length(v_permissions) < 1
     OR v_data_classes IS NULL OR pg_catalog.jsonb_typeof(v_data_classes) <> 'array'
        OR pg_catalog.jsonb_array_length(v_data_classes) < 1
     -- The support actor must be a live registry principal — a direct caller
     -- cannot mint grants for unregistered identities.
     OR NOT EXISTS (
       SELECT 1 FROM public.platform_support_principals AS principal
       WHERE principal.auth_identity_id = v_support_actor::pg_catalog.uuid
         AND principal.status = 'active'
     )
  THEN
    RETURN;
  END IF;

  INSERT INTO public.support_access_grants (
    id, tenant_id, workspace_id, support_actor_auth_identity_id, platform_role,
    requested_by_auth_identity_id, state, reason_code, reason,
    starts_at, expires_at, correlation_id, audit_event_id,
    permission_anchor, data_class_anchor, created_at, updated_at
  )
  SELECT
    v_id::pg_catalog.uuid,
    v_tenant_id::pg_catalog.uuid,
    CASE WHEN v_workspace IS NULL THEN NULL ELSE v_workspace::pg_catalog.uuid END,
    v_support_actor::pg_catalog.uuid,
    v_platform_role,
    v_actor_id::pg_catalog.uuid,
    'pending',
    v_reason_code,
    v_reason,
    v_starts_at::pg_catalog.timestamptz,
    v_expires_at::pg_catalog.timestamptz,
    v_correlation,
    v_audit_event::pg_catalog.uuid,
    anchor.permission_anchor,
    anchor.data_class_anchor,
    v_created_at::pg_catalog.timestamptz,
    v_updated_at::pg_catalog.timestamptz
  FROM (
    SELECT (v_permissions ->> 0) AS permission_anchor, (v_data_classes ->> 0) AS data_class_anchor
  ) AS anchor;

  INSERT INTO public.support_access_grant_permissions (grant_id, permission)
  SELECT v_id::pg_catalog.uuid, permission_entry.value
  FROM pg_catalog.jsonb_array_elements_text(v_permissions) AS permission_entry(value);

  INSERT INTO public.support_access_grant_data_classes (grant_id, data_class)
  SELECT v_id::pg_catalog.uuid, data_class_entry.value
  FROM pg_catalog.jsonb_array_elements_text(v_data_classes) AS data_class_entry(value);

  RETURN QUERY SELECT public.novatrade_support_access_grant_json(v_id::pg_catalog.uuid);
END;
$$;

COMMENT ON FUNCTION public.novatrade_support_access_create_grant(pg_catalog.text) IS
  'L-02 member-context support-grant creation; binds tenant/requester/correlation to the member GUCs, requires a live registry principal and non-self target, and inserts grant + normalized scope rows in one statement.';
REVOKE ALL ON FUNCTION public.novatrade_support_access_create_grant(pg_catalog.text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.novatrade_support_access_create_grant(pg_catalog.text) FROM anon;
REVOKE ALL ON FUNCTION public.novatrade_support_access_create_grant(pg_catalog.text) FROM authenticated;

-- Grant decision edges (pending → approved, approved → revoked). Tenant and
-- workspace visibility are bound to the member GUCs; the approver/revoker is
-- the context actor, never caller-supplied. The grants validate trigger
-- re-proves the actor's owner/admin membership as defense in depth.
CREATE OR REPLACE FUNCTION public.novatrade_support_access_approve_grant(
  p_request pg_catalog.text
)
RETURNS TABLE (grant_json pg_catalog.jsonb)
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
DECLARE
  v_request pg_catalog.jsonb := p_request::pg_catalog.jsonb;
  v_grant_id pg_catalog.text := v_request ->> 'grantId';
  v_at pg_catalog.text := v_request ->> 'at';
  v_tenant_id pg_catalog.text := coalesce(pg_catalog.current_setting('app.tenant_id', true), '');
  v_workspace_id pg_catalog.text := coalesce(pg_catalog.current_setting('app.workspace_id', true), '');
  v_actor_id pg_catalog.text := coalesce(pg_catalog.current_setting('app.actor_id', true), '');
  v_updated pg_catalog.int4;
BEGIN
  IF NOT public.novatrade_rls_member_context()
     OR v_grant_id IS NULL OR v_grant_id !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
     OR v_at IS NULL OR v_at !~ '^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$'
  THEN
    RETURN;
  END IF;

  UPDATE public.support_access_grants AS grant_row
  SET state = 'approved',
      approved_by_auth_identity_id = v_actor_id::pg_catalog.uuid,
      approved_at = v_at::pg_catalog.timestamptz,
      updated_at = v_at::pg_catalog.timestamptz
  WHERE grant_row.id = v_grant_id::pg_catalog.uuid
    AND grant_row.state = 'pending'
    AND grant_row.tenant_id = v_tenant_id::pg_catalog.uuid
    AND grant_row.support_actor_auth_identity_id <> v_actor_id::pg_catalog.uuid
    AND (
      v_workspace_id = ''
      OR grant_row.workspace_id = v_workspace_id::pg_catalog.uuid
    );
  GET DIAGNOSTICS v_updated = ROW_COUNT;

  IF v_updated <> 1 THEN
    RETURN;
  END IF;

  RETURN QUERY SELECT public.novatrade_support_access_grant_json(v_grant_id::pg_catalog.uuid);
END;
$$;

COMMENT ON FUNCTION public.novatrade_support_access_approve_grant(pg_catalog.text) IS
  'L-02 member-context support-grant approval; pending→approved with the context actor as approver, bound to the context tenant and workspace visibility.';
REVOKE ALL ON FUNCTION public.novatrade_support_access_approve_grant(pg_catalog.text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.novatrade_support_access_approve_grant(pg_catalog.text) FROM anon;
REVOKE ALL ON FUNCTION public.novatrade_support_access_approve_grant(pg_catalog.text) FROM authenticated;

CREATE OR REPLACE FUNCTION public.novatrade_support_access_revoke_grant(
  p_request pg_catalog.text
)
RETURNS TABLE (grant_json pg_catalog.jsonb)
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
DECLARE
  v_request pg_catalog.jsonb := p_request::pg_catalog.jsonb;
  v_grant_id pg_catalog.text := v_request ->> 'grantId';
  v_at pg_catalog.text := v_request ->> 'at';
  v_tenant_id pg_catalog.text := coalesce(pg_catalog.current_setting('app.tenant_id', true), '');
  v_workspace_id pg_catalog.text := coalesce(pg_catalog.current_setting('app.workspace_id', true), '');
  v_actor_id pg_catalog.text := coalesce(pg_catalog.current_setting('app.actor_id', true), '');
  v_updated pg_catalog.int4;
BEGIN
  IF NOT public.novatrade_rls_member_context()
     OR v_grant_id IS NULL OR v_grant_id !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
     OR v_at IS NULL OR v_at !~ '^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$'
  THEN
    RETURN;
  END IF;

  UPDATE public.support_access_grants AS grant_row
  SET state = 'revoked',
      revoked_by_auth_identity_id = v_actor_id::pg_catalog.uuid,
      revoked_at = v_at::pg_catalog.timestamptz,
      updated_at = v_at::pg_catalog.timestamptz
  WHERE grant_row.id = v_grant_id::pg_catalog.uuid
    AND grant_row.state = 'approved'
    AND grant_row.tenant_id = v_tenant_id::pg_catalog.uuid
    AND (
      v_workspace_id = ''
      OR grant_row.workspace_id = v_workspace_id::pg_catalog.uuid
    );
  GET DIAGNOSTICS v_updated = ROW_COUNT;

  IF v_updated <> 1 THEN
    RETURN;
  END IF;

  RETURN QUERY SELECT public.novatrade_support_access_grant_json(v_grant_id::pg_catalog.uuid);
END;
$$;

COMMENT ON FUNCTION public.novatrade_support_access_revoke_grant(pg_catalog.text) IS
  'L-02 member-context support-grant revocation; approved→revoked with the context actor as revoker, bound to the context tenant and workspace visibility.';
REVOKE ALL ON FUNCTION public.novatrade_support_access_revoke_grant(pg_catalog.text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.novatrade_support_access_revoke_grant(pg_catalog.text) FROM anon;
REVOKE ALL ON FUNCTION public.novatrade_support_access_revoke_grant(pg_catalog.text) FROM authenticated;

-- Principal resolution. Member-side requests resolve an opaque reference to
-- a live platform-support auth identity; the directory itself stays
-- zero-policy so tenants cannot enumerate principals.
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
BEGIN
  IF NOT public.novatrade_rls_member_context()
     OR p_reference IS NULL
     OR pg_catalog.char_length(p_reference) < 1
     OR pg_catalog.char_length(p_reference) > 256
  THEN
    RETURN;
  END IF;

  RETURN QUERY
  SELECT principal.auth_identity_id, 'platform_support'::pg_catalog.text
  FROM public.platform_support_principals AS principal
  WHERE principal.reference = p_reference
    AND principal.status = 'active';
END;
$$;

COMMENT ON FUNCTION public.novatrade_support_principal_resolve(pg_catalog.text) IS
  'L-02 member-context principal resolution; maps an opaque reference to a live platform-support auth identity without exposing the directory.';
REVOKE ALL ON FUNCTION public.novatrade_support_principal_resolve(pg_catalog.text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.novatrade_support_principal_resolve(pg_catalog.text) FROM anon;
REVOKE ALL ON FUNCTION public.novatrade_support_principal_resolve(pg_catalog.text) FROM authenticated;

-- Current-principal resolution for the support-authorization lane: the
-- support GUC context must validate and the context actor must still be a
-- live registry principal (the grant validity window alone does not prove
-- the principal's registry status).
CREATE OR REPLACE FUNCTION public.novatrade_support_principal_current()
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
  IF NOT public.novatrade_rls_support_context() THEN
    RETURN;
  END IF;

  RETURN QUERY
  SELECT principal.auth_identity_id, 'platform_support'::pg_catalog.text
  FROM public.platform_support_principals AS principal
  WHERE principal.auth_identity_id = v_actor_id::pg_catalog.uuid
    AND principal.status = 'active';
END;
$$;

COMMENT ON FUNCTION public.novatrade_support_principal_current() IS
  'L-02 support-context current-principal resolution; the installed support GUC context must validate and the context actor must remain a live registry principal.';
REVOKE ALL ON FUNCTION public.novatrade_support_principal_current() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.novatrade_support_principal_current() FROM anon;
REVOKE ALL ON FUNCTION public.novatrade_support_principal_current() FROM authenticated;
