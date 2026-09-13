-- L-02 T-039: tenant-deletion operations behind SECURITY DEFINER functions.
--
-- The deletion ledger (tenant_deletion_jobs, tenant_deletion_checkpoints,
-- tenant_deletion_checkpoint_events, tenant_deletion_tombstones) is
-- zero-policy deny-all, and member-RLS on tenants/memberships/bindings/
-- policies evaluates novatrade_rls_member_context() — which requires
-- tenants.status = 'active' and is therefore unreachable for a ledger whose
-- entry state is 'archived'. Every read and write for the deletion surface
-- runs through the functions below under a structural member context: the
-- installed member GUCs must resolve to a live membership + live role
-- binding with tenant/actor/role/workspace agreement, but no tenant-status
-- gate applies. Cross-tenant and forged claims refuse non-enumeratingly.

-- Structural member-context proof for the deletion lane: the installed
-- member GUCs resolve to live rows (active membership, unrevoked binding
-- already in force) with role/auth-identity/workspace agreement. Unlike
-- novatrade_rls_member_context() this does not require tenants.status =
-- 'active' — deletion jobs exist precisely because the tenant left it —
-- and unlike novatrade_membership_actor_ctx_valid() it requires the
-- binding to still be live, matching requireMemberActor semantics.
CREATE OR REPLACE FUNCTION public.novatrade_deletion_actor_ctx()
RETURNS pg_catalog.bool
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
DECLARE
  v_guc_tenant pg_catalog.text := coalesce(pg_catalog.current_setting('app.tenant_id', true), '');
  v_guc_workspace pg_catalog.text := coalesce(pg_catalog.current_setting('app.workspace_id', true), '');
  v_guc_actor pg_catalog.text := coalesce(pg_catalog.current_setting('app.actor_id', true), '');
  v_guc_membership pg_catalog.text := coalesce(pg_catalog.current_setting('app.membership_id', true), '');
  v_guc_role pg_catalog.text := coalesce(pg_catalog.current_setting('app.role', true), '');
  v_guc_binding pg_catalog.text := coalesce(pg_catalog.current_setting('app.role_binding_id', true), '');
  v_guc_correlation pg_catalog.text := coalesce(pg_catalog.current_setting('app.correlation_id', true), '');
BEGIN
  IF v_guc_tenant !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
     OR v_guc_actor !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
     OR v_guc_membership !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
     OR v_guc_binding !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
     OR (v_guc_workspace <> ''
         AND v_guc_workspace !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$')
     OR v_guc_role NOT IN (
       'owner', 'admin', 'strategist_manager', 'researcher',
       'reviewer', 'outreach_operator', 'analyst_read_only')
     OR v_guc_correlation = ''
  THEN
    RETURN false;
  END IF;

  -- A member context cannot carry support or worker authority, including
  -- stale pooled values from a prior transaction.
  IF coalesce(pg_catalog.current_setting('app.support_grant_id', true), '') <> ''
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

  RETURN EXISTS (
    SELECT 1
    FROM public.tenant_role_bindings AS binding
    JOIN public.tenant_memberships AS membership
      ON membership.tenant_id = binding.tenant_id
     AND membership.id = binding.membership_id
    WHERE binding.tenant_id::pg_catalog.text = v_guc_tenant
      AND binding.id::pg_catalog.text = v_guc_binding
      AND binding.membership_id::pg_catalog.text = v_guc_membership
      AND binding.role = v_guc_role
      AND binding.revoked_at IS NULL
      AND binding.valid_from <= pg_catalog.now()
      AND membership.auth_identity_id::pg_catalog.text = v_guc_actor
      AND membership.status = 'active'
      AND membership.workspace_id::pg_catalog.text IS NOT DISTINCT FROM
        NULLIF(v_guc_workspace, ''));
END;
$$;

COMMENT ON FUNCTION public.novatrade_deletion_actor_ctx() IS
  'L-02 T-039 structural member-context proof for the deletion lane: installed member GUCs resolve to a live membership + live binding with agreement; no tenant-status gate. INTERNAL ONLY.';
REVOKE ALL ON FUNCTION public.novatrade_deletion_actor_ctx() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.novatrade_deletion_actor_ctx() FROM anon;
REVOKE ALL ON FUNCTION public.novatrade_deletion_actor_ctx() FROM authenticated;

-- Definer-backed reads for the deletion lane. Member-RLS cannot see these
-- rows (zero-policy tables; status-dead member context), so the canonical
-- service's repository reads translate into kind-dispatched lookups that
-- bind tenant_id to the installed context and emit the snake_case row
-- shape the canonical mappers consume.
CREATE OR REPLACE FUNCTION public.novatrade_deletion_read(
  p_request pg_catalog.text
)
RETURNS pg_catalog.jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
DECLARE
  v_request pg_catalog.jsonb := p_request::pg_catalog.jsonb;
  v_guc_tenant pg_catalog.text := coalesce(pg_catalog.current_setting('app.tenant_id', true), '');
  v_kind pg_catalog.text := v_request ->> 'kind';
  v_tenant pg_catalog.text := v_request ->> 'tenantId';
  v_ts_fmt pg_catalog.text := 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"';
  v_job public.tenant_deletion_jobs;
  v_checkpoint public.tenant_deletion_checkpoints;
  v_tenant_row public.tenants;
  v_policy public.tenant_policies;
  v_membership public.tenant_memberships;
  v_binding public.tenant_role_bindings;
  v_items pg_catalog.jsonb;
BEGIN
  IF NOT public.novatrade_deletion_actor_ctx() THEN
    RETURN NULL;
  END IF;

  IF v_request IS NULL OR pg_catalog.jsonb_typeof(v_request) <> 'object'
     OR v_kind IS NULL
     OR v_tenant IS NULL
     OR v_tenant IS DISTINCT FROM v_guc_tenant THEN
    RETURN NULL;
  END IF;

  IF v_kind = 'tenant' THEN
    SELECT * INTO v_tenant_row FROM public.tenants AS tenant
      WHERE tenant.id::pg_catalog.text = v_guc_tenant;
    IF NOT FOUND THEN RETURN NULL; END IF;
    RETURN pg_catalog.jsonb_build_object(
      'id', v_tenant_row.id::pg_catalog.text,
      'slug', v_tenant_row.slug,
      'name', v_tenant_row.name,
      'status', v_tenant_row.status,
      'locale', v_tenant_row.locale,
      'timezone', v_tenant_row.timezone,
      'created_at', pg_catalog.to_char(v_tenant_row.created_at AT TIME ZONE 'UTC', v_ts_fmt),
      'updated_at', pg_catalog.to_char(v_tenant_row.updated_at AT TIME ZONE 'UTC', v_ts_fmt));
  END IF;

  IF v_kind = 'policy' THEN
    SELECT * INTO v_policy FROM public.tenant_policies AS policy
      WHERE policy.tenant_id::pg_catalog.text = v_guc_tenant
      ORDER BY policy.version DESC, policy.updated_at DESC, policy.id DESC
      LIMIT 1;
    IF NOT FOUND THEN RETURN NULL; END IF;
    RETURN pg_catalog.jsonb_build_object(
      'id', v_policy.id::pg_catalog.text,
      'tenant_id', v_policy.tenant_id::pg_catalog.text,
      'version', v_policy.version,
      'locale', v_policy.locale,
      'timezone', v_policy.timezone,
      'export_retention_days', v_policy.export_retention_days,
      'operational_log_retention_days', v_policy.operational_log_retention_days,
      'raw_source_retention_days', v_policy.raw_source_retention_days,
      'contact_freshness_days', v_policy.contact_freshness_days,
      'primary_delete_within_days', v_policy.primary_delete_within_days,
      'backup_expire_within_days', v_policy.backup_expire_within_days,
      'tombstone_retention_years', v_policy.tombstone_retention_years,
      'active_materials_mode', v_policy.active_materials_mode,
      'ai_processing_enabled', v_policy.ai_processing_enabled,
      'source_research_enabled', v_policy.source_research_enabled,
      'contact_research_enabled', v_policy.contact_research_enabled,
      'outreach_drafting_enabled', v_policy.outreach_drafting_enabled,
      'copy_export_enabled', v_policy.copy_export_enabled,
      'autonomous_send_enabled', v_policy.autonomous_send_enabled,
      'require_source_plan_approval', v_policy.require_source_plan_approval,
      'require_knowledge_review', v_policy.require_knowledge_review,
      'require_icp_review', v_policy.require_icp_review,
      'require_lead_play_review', v_policy.require_lead_play_review,
      'require_contact_review', v_policy.require_contact_review,
      'require_outreach_review', v_policy.require_outreach_review,
      'created_at', pg_catalog.to_char(v_policy.created_at AT TIME ZONE 'UTC', v_ts_fmt),
      'updated_at', pg_catalog.to_char(v_policy.updated_at AT TIME ZONE 'UTC', v_ts_fmt));
  END IF;

  IF v_kind = 'membership' THEN
    SELECT * INTO v_membership FROM public.tenant_memberships AS membership
      WHERE membership.tenant_id::pg_catalog.text = v_guc_tenant
        AND membership.id::pg_catalog.text = v_request ->> 'membershipId';
    IF NOT FOUND THEN RETURN NULL; END IF;
    RETURN pg_catalog.jsonb_build_object(
      'id', v_membership.id::pg_catalog.text,
      'tenant_id', v_membership.tenant_id::pg_catalog.text,
      'auth_identity_id', v_membership.auth_identity_id::pg_catalog.text,
      'pending_identity_ref_hash', v_membership.pending_identity_ref_hash,
      'workspace_id', v_membership.workspace_id::pg_catalog.text,
      'status', v_membership.status,
      'invited_by_membership_id', v_membership.invited_by_membership_id::pg_catalog.text,
      'created_at', pg_catalog.to_char(v_membership.created_at AT TIME ZONE 'UTC', v_ts_fmt),
      'updated_at', pg_catalog.to_char(v_membership.updated_at AT TIME ZONE 'UTC', v_ts_fmt));
  END IF;

  IF v_kind = 'binding' THEN
    SELECT * INTO v_binding FROM public.tenant_role_bindings AS binding
      WHERE binding.tenant_id::pg_catalog.text = v_guc_tenant
        AND binding.membership_id::pg_catalog.text = v_request ->> 'membershipId'
        AND binding.revoked_at IS NULL
      ORDER BY binding.valid_from DESC, binding.id DESC
      LIMIT 1;
    IF NOT FOUND THEN RETURN NULL; END IF;
    RETURN pg_catalog.jsonb_build_object(
      'id', v_binding.id::pg_catalog.text,
      'tenant_id', v_binding.tenant_id::pg_catalog.text,
      'membership_id', v_binding.membership_id::pg_catalog.text,
      'role', v_binding.role,
      'created_at', pg_catalog.to_char(v_binding.created_at AT TIME ZONE 'UTC', v_ts_fmt),
      'valid_from', pg_catalog.to_char(v_binding.valid_from AT TIME ZONE 'UTC', v_ts_fmt),
      'revoked_at', NULL,
      'assigned_by_membership_id', v_binding.assigned_by_membership_id::pg_catalog.text,
      'reason_code', v_binding.reason_code);
  END IF;

  IF v_kind = 'job' OR v_kind = 'job_by_idem' THEN
    IF v_kind = 'job' THEN
      SELECT * INTO v_job FROM public.tenant_deletion_jobs AS job
        WHERE job.tenant_id::pg_catalog.text = v_guc_tenant
          AND job.id::pg_catalog.text = v_request ->> 'jobId';
    ELSE
      SELECT * INTO v_job FROM public.tenant_deletion_jobs AS job
        WHERE job.tenant_id::pg_catalog.text = v_guc_tenant
          AND job.operation = 'tenant_data_deletion'
          AND job.scope_selector_hash = v_request ->> 'scopeSelectorHash'
          AND job.idempotency_key_hash = v_request ->> 'idempotencyKeyHash';
    END IF;
    IF NOT FOUND THEN RETURN NULL; END IF;
    RETURN pg_catalog.jsonb_build_object(
      'id', v_job.id::pg_catalog.text,
      'tenant_id', v_job.tenant_id::pg_catalog.text,
      'workspace_id', v_job.workspace_id::pg_catalog.text,
      'operation', v_job.operation,
      'scope_kind', v_job.scope_kind,
      'scope_selector_hash', v_job.scope_selector_hash,
      'requested_by_auth_identity_id', v_job.requested_by_auth_identity_id::pg_catalog.text,
      'requested_by_membership_id', v_job.requested_by_membership_id::pg_catalog.text,
      'verified_by_auth_identity_id', v_job.verified_by_auth_identity_id::pg_catalog.text,
      'verified_by_membership_id', v_job.verified_by_membership_id::pg_catalog.text,
      'verified_at', pg_catalog.to_char(v_job.verified_at AT TIME ZONE 'UTC', v_ts_fmt),
      'approved_by_auth_identity_id', v_job.approved_by_auth_identity_id::pg_catalog.text,
      'approved_by_membership_id', v_job.approved_by_membership_id::pg_catalog.text,
      'approved_at', pg_catalog.to_char(v_job.approved_at AT TIME ZONE 'UTC', v_ts_fmt),
      'status', v_job.status,
      'policy_version', v_job.policy_version,
      'policy_snapshot_hash', v_job.policy_snapshot_hash,
      'input_hash', v_job.input_hash,
      'idempotency_key_hash', v_job.idempotency_key_hash,
      'legal_hold_status', v_job.legal_hold_status,
      'freeze_handoff_status', v_job.freeze_handoff_status,
      'access_revocation_handoff_status', v_job.access_revocation_handoff_status,
      'retry_count', v_job.retry_count,
      'max_retries', v_job.max_retries,
      'next_retry_at', pg_catalog.to_char(v_job.next_retry_at AT TIME ZONE 'UTC', v_ts_fmt),
      'correlation_id', v_job.correlation_id,
      'audit_event_id', v_job.audit_event_id::pg_catalog.text,
      'error_code', v_job.error_code,
      'error_fingerprint', v_job.error_fingerprint,
      'created_at', pg_catalog.to_char(v_job.created_at AT TIME ZONE 'UTC', v_ts_fmt),
      'updated_at', pg_catalog.to_char(v_job.updated_at AT TIME ZONE 'UTC', v_ts_fmt),
      'scheduled_at', pg_catalog.to_char(v_job.scheduled_at AT TIME ZONE 'UTC', v_ts_fmt),
      'started_at', pg_catalog.to_char(v_job.started_at AT TIME ZONE 'UTC', v_ts_fmt),
      'primary_deleted_at', pg_catalog.to_char(v_job.primary_deleted_at AT TIME ZONE 'UTC', v_ts_fmt),
      'backup_aging_at', pg_catalog.to_char(v_job.backup_aging_at AT TIME ZONE 'UTC', v_ts_fmt),
      'completed_at', pg_catalog.to_char(v_job.completed_at AT TIME ZONE 'UTC', v_ts_fmt),
      'canceled_at', pg_catalog.to_char(v_job.canceled_at AT TIME ZONE 'UTC', v_ts_fmt),
      'backup_expiry_target_at', pg_catalog.to_char(v_job.backup_expiry_target_at AT TIME ZONE 'UTC', v_ts_fmt));
  END IF;

  IF v_kind = 'checkpoint' THEN
    SELECT * INTO v_checkpoint FROM public.tenant_deletion_checkpoints AS checkpoint
      WHERE checkpoint.tenant_id::pg_catalog.text = v_guc_tenant
        AND checkpoint.job_id::pg_catalog.text = v_request ->> 'jobId'
        AND checkpoint.store_class = v_request ->> 'storeClass';
    IF NOT FOUND THEN RETURN NULL; END IF;
    RETURN public.novatrade_deletion_checkpoint_json(v_checkpoint);
  END IF;

  IF v_kind = 'checkpoint_list' THEN
    SELECT coalesce(pg_catalog.jsonb_agg(
      public.novatrade_deletion_checkpoint_json(checkpoint)
      ORDER BY checkpoint.store_class), '[]'::pg_catalog.jsonb)
      INTO v_items
      FROM public.tenant_deletion_checkpoints AS checkpoint
      WHERE checkpoint.tenant_id::pg_catalog.text = v_guc_tenant
        AND checkpoint.job_id::pg_catalog.text = v_request ->> 'jobId';
    RETURN v_items;
  END IF;

  RETURN NULL;
END;
$$;

COMMENT ON FUNCTION public.novatrade_deletion_read(pg_catalog.text) IS
  'L-02 T-039 definer-backed read lane for deletion ops; binds tenant to the installed structural member context and emits canonical snake_case rows. INTERNAL ONLY.';
REVOKE ALL ON FUNCTION public.novatrade_deletion_read(pg_catalog.text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.novatrade_deletion_read(pg_catalog.text) FROM anon;
REVOKE ALL ON FUNCTION public.novatrade_deletion_read(pg_catalog.text) FROM authenticated;

CREATE OR REPLACE FUNCTION public.novatrade_deletion_checkpoint_json(
  p_checkpoint public.tenant_deletion_checkpoints
)
RETURNS pg_catalog.jsonb
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
  SELECT pg_catalog.jsonb_build_object(
    'id', p_checkpoint.id::pg_catalog.text,
    'job_id', p_checkpoint.job_id::pg_catalog.text,
    'tenant_id', p_checkpoint.tenant_id::pg_catalog.text,
    'workspace_id', p_checkpoint.workspace_id::pg_catalog.text,
    'store_class', p_checkpoint.store_class,
    'required', p_checkpoint.required,
    'status', p_checkpoint.status,
    'attempt', p_checkpoint.attempt,
    'lease_owner_hash', p_checkpoint.lease_owner_hash,
    'lease_generation', p_checkpoint.lease_generation,
    'opaque_target_hash', p_checkpoint.opaque_target_hash,
    'receipt_hash', p_checkpoint.receipt_hash,
    'provider_operation_hash', p_checkpoint.provider_operation_hash,
    'exemption_reason', p_checkpoint.exemption_reason,
    'exemption_approved', p_checkpoint.exemption_approved,
    'observed_count', p_checkpoint.observed_count,
    'expected_count', p_checkpoint.expected_count,
    'reason_code', p_checkpoint.reason_code,
    'error_code', p_checkpoint.error_code,
    'error_fingerprint', p_checkpoint.error_fingerprint,
    'started_at', pg_catalog.to_char(p_checkpoint.started_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
    'completed_at', pg_catalog.to_char(p_checkpoint.completed_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
    'updated_at', pg_catalog.to_char(p_checkpoint.updated_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
  );
$$;

COMMENT ON FUNCTION public.novatrade_deletion_checkpoint_json(public.tenant_deletion_checkpoints) IS
  'L-02 T-039 checkpoint renderer; emits the canonical snake_case row the deletion checkpoint mapper consumes. INTERNAL ONLY.';
REVOKE ALL ON FUNCTION public.novatrade_deletion_checkpoint_json(public.tenant_deletion_checkpoints) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.novatrade_deletion_checkpoint_json(public.tenant_deletion_checkpoints) FROM anon;
REVOKE ALL ON FUNCTION public.novatrade_deletion_checkpoint_json(public.tenant_deletion_checkpoints) FROM authenticated;

-- Job insert (requested state): binds the requester identity to the
-- installed actor GUCs and requires the owner role the canonical
-- requireMemberActor gate applies. The insert guard enforces the
-- requested-state shape and requester/membership agreement.
CREATE OR REPLACE FUNCTION public.novatrade_deletion_request(
  p_request pg_catalog.text
)
RETURNS TABLE (applied pg_catalog.bool)
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
DECLARE
  v_request pg_catalog.jsonb := p_request::pg_catalog.jsonb;
  v_guc_tenant pg_catalog.text := coalesce(pg_catalog.current_setting('app.tenant_id', true), '');
  v_guc_workspace pg_catalog.text := coalesce(pg_catalog.current_setting('app.workspace_id', true), '');
  v_guc_actor pg_catalog.text := coalesce(pg_catalog.current_setting('app.actor_id', true), '');
  v_guc_membership pg_catalog.text := coalesce(pg_catalog.current_setting('app.membership_id', true), '');
  v_guc_role pg_catalog.text := coalesce(pg_catalog.current_setting('app.role', true), '');
  v_job_id pg_catalog.text := v_request ->> 'jobId';
  v_workspace pg_catalog.text := v_request ->> 'workspaceId';
  v_audit pg_catalog.text := v_request ->> 'auditEventId';
BEGIN
  IF NOT public.novatrade_deletion_actor_ctx() OR v_guc_role <> 'owner' THEN
    RETURN QUERY SELECT false;
    RETURN;
  END IF;

  IF v_request IS NULL OR pg_catalog.jsonb_typeof(v_request) <> 'object'
     OR v_job_id IS NULL
        OR v_job_id !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
     OR (v_request ->> 'tenantId') IS DISTINCT FROM v_guc_tenant
     OR (v_workspace IS NOT NULL
         AND (v_workspace !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
              OR v_workspace IS DISTINCT FROM NULLIF(v_guc_workspace, '')))
     OR (v_request ->> 'scopeKind') NOT IN ('tenant', 'workspace')
     OR ((v_request ->> 'scopeKind') = 'tenant') <> (v_workspace IS NULL)
     OR (v_request ->> 'scopeSelectorHash') !~ '^[0-9a-f]{64}$'
     OR (v_request ->> 'inputHash') !~ '^[0-9a-f]{64}$'
     OR (v_request ->> 'idempotencyKeyHash') !~ '^[0-9a-f]{64}$'
     OR (v_request ->> 'policySnapshotHash') !~ '^[0-9a-f]{64}$'
     OR (v_request ->> 'policyVersion') IS NULL
        OR (v_request ->> 'policyVersion') !~ '^[A-Za-z0-9][A-Za-z0-9._-]{4,127}$'
     OR (v_request ->> 'requesterAuthIdentityId') IS DISTINCT FROM v_guc_actor
     OR (v_request ->> 'requesterMembershipId') IS DISTINCT FROM v_guc_membership
     OR (v_request ->> 'correlationId') IS NULL
        OR (v_request ->> 'correlationId') !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$'
     OR v_audit IS NULL
        OR v_audit !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
  THEN
    RETURN QUERY SELECT false;
    RETURN;
  END IF;

  INSERT INTO public.tenant_deletion_jobs (
    id, tenant_id, workspace_id, operation, scope_kind, scope_selector_hash,
    requested_by_auth_identity_id, requested_by_membership_id,
    policy_version, policy_snapshot_hash, input_hash, idempotency_key_hash,
    correlation_id, audit_event_id
  ) VALUES (
    v_job_id::pg_catalog.uuid, v_guc_tenant::pg_catalog.uuid,
    CASE WHEN v_workspace IS NULL THEN NULL ELSE v_workspace::pg_catalog.uuid END,
    'tenant_data_deletion', v_request ->> 'scopeKind', v_request ->> 'scopeSelectorHash',
    v_guc_actor::pg_catalog.uuid, v_guc_membership::pg_catalog.uuid,
    v_request ->> 'policyVersion', v_request ->> 'policySnapshotHash',
    v_request ->> 'inputHash', v_request ->> 'idempotencyKeyHash',
    v_request ->> 'correlationId', v_audit::pg_catalog.uuid
  );
  RETURN QUERY SELECT true;
END;
$$;

COMMENT ON FUNCTION public.novatrade_deletion_request(pg_catalog.text) IS
  'L-02 T-039 deletion-job insert; binds requester identity to the installed owner member context. INTERNAL ONLY.';
REVOKE ALL ON FUNCTION public.novatrade_deletion_request(pg_catalog.text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.novatrade_deletion_request(pg_catalog.text) FROM anon;
REVOKE ALL ON FUNCTION public.novatrade_deletion_request(pg_catalog.text) FROM authenticated;

-- Job status transitions: one edge per canonical UPDATE, each carrying the
-- field set the guard trigger attributes to that edge. The job row is
-- locked FOR UPDATE inside the accepted tenant so concurrent callers
-- serialize on the ledger row itself.
CREATE OR REPLACE FUNCTION public.novatrade_deletion_transition(
  p_request pg_catalog.text
)
RETURNS TABLE (outcome pg_catalog.text)
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
DECLARE
  v_request pg_catalog.jsonb := p_request::pg_catalog.jsonb;
  v_guc_tenant pg_catalog.text := coalesce(pg_catalog.current_setting('app.tenant_id', true), '');
  v_guc_actor pg_catalog.text := coalesce(pg_catalog.current_setting('app.actor_id', true), '');
  v_guc_membership pg_catalog.text := coalesce(pg_catalog.current_setting('app.membership_id', true), '');
  v_guc_role pg_catalog.text := coalesce(pg_catalog.current_setting('app.role', true), '');
  v_edge pg_catalog.text := v_request ->> 'edge';
  v_job_id pg_catalog.text := v_request ->> 'jobId';
  v_job public.tenant_deletion_jobs;
  v_changed pg_catalog.int8;
  v_uuid_rx pg_catalog.text := '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$';
  v_ts_rx pg_catalog.text := '^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$';
  v_hash_rx pg_catalog.text := '^[0-9a-f]{64}$';
BEGIN
  IF NOT public.novatrade_deletion_actor_ctx() THEN
    RETURN QUERY SELECT 'denied'::pg_catalog.text;
    RETURN;
  END IF;

  IF v_request IS NULL OR pg_catalog.jsonb_typeof(v_request) <> 'object'
     OR v_edge IS NULL
     OR v_job_id IS NULL OR v_job_id !~* v_uuid_rx
     OR (v_request ->> 'tenantId') IS DISTINCT FROM v_guc_tenant THEN
    RETURN QUERY SELECT 'invalid_request'::pg_catalog.text;
    RETURN;
  END IF;

  SELECT * INTO v_job FROM public.tenant_deletion_jobs AS job
    WHERE job.tenant_id::pg_catalog.text = v_guc_tenant
      AND job.id::pg_catalog.text = v_job_id
    FOR UPDATE;
  IF NOT FOUND THEN
    RETURN QUERY SELECT 'not_found'::pg_catalog.text;
    RETURN;
  END IF;

  IF v_edge = 'verify' THEN
    IF v_guc_role NOT IN ('owner', 'admin')
       OR (v_request ->> 'verifierAuthIdentityId') IS DISTINCT FROM v_guc_actor
       OR (v_request ->> 'verifierMembershipId') IS DISTINCT FROM v_guc_membership
       OR (v_request ->> 'verifierMembershipId') = v_job.requested_by_membership_id::pg_catalog.text
       OR (v_request ->> 'verifierAuthIdentityId') = v_job.requested_by_auth_identity_id::pg_catalog.text
       OR (v_request ->> 'at') IS NULL OR (v_request ->> 'at') !~ v_ts_rx THEN
      RETURN QUERY SELECT 'invalid_request'::pg_catalog.text;
      RETURN;
    END IF;
    UPDATE public.tenant_deletion_jobs AS job
    SET status = 'verified',
        verified_by_auth_identity_id = v_guc_actor::pg_catalog.uuid,
        verified_by_membership_id = v_guc_membership::pg_catalog.uuid,
        verified_at = (v_request ->> 'at')::pg_catalog.timestamptz
    WHERE job.tenant_id = v_job.tenant_id AND job.id = v_job.id
      AND job.status = 'requested';
    GET DIAGNOSTICS v_changed = ROW_COUNT;

  ELSIF v_edge = 'approve' THEN
    IF v_guc_role <> 'owner'
       OR (v_request ->> 'approverAuthIdentityId') IS DISTINCT FROM v_guc_actor
       OR (v_request ->> 'approverMembershipId') IS DISTINCT FROM v_guc_membership
       OR (v_request ->> 'approverMembershipId') IN (
            v_job.requested_by_membership_id::pg_catalog.text,
            coalesce(v_job.verified_by_membership_id::pg_catalog.text, ''))
       OR (v_request ->> 'approverAuthIdentityId') IN (
            v_job.requested_by_auth_identity_id::pg_catalog.text,
            coalesce(v_job.verified_by_auth_identity_id::pg_catalog.text, ''))
       OR (v_request ->> 'at') IS NULL OR (v_request ->> 'at') !~ v_ts_rx
       OR (v_request ->> 'scheduledAt') IS NULL OR (v_request ->> 'scheduledAt') !~ v_ts_rx THEN
      RETURN QUERY SELECT 'invalid_request'::pg_catalog.text;
      RETURN;
    END IF;
    UPDATE public.tenant_deletion_jobs AS job
    SET status = 'scheduled',
        approved_by_auth_identity_id = v_guc_actor::pg_catalog.uuid,
        approved_by_membership_id = v_guc_membership::pg_catalog.uuid,
        approved_at = (v_request ->> 'at')::pg_catalog.timestamptz,
        scheduled_at = (v_request ->> 'scheduledAt')::pg_catalog.timestamptz
    WHERE job.tenant_id = v_job.tenant_id AND job.id = v_job.id
      AND job.status = 'verified';
    GET DIAGNOSTICS v_changed = ROW_COUNT;

  ELSIF v_edge = 'cancel' THEN
    IF (v_request ->> 'at') IS NULL OR (v_request ->> 'at') !~ v_ts_rx
       OR (v_request ->> 'expectedStatus') IS NULL
       OR (v_request ->> 'expectedStatus') IS DISTINCT FROM v_job.status THEN
      RETURN QUERY SELECT 'invalid_request'::pg_catalog.text;
      RETURN;
    END IF;
    -- canceled→canceled is a legal self-loop edge (the canonical transition
    -- map includes it) and the local backend answers OK_DELETION_CANCELED.
    -- The canceled_at immutability guard makes the literal rewrite impossible,
    -- so the applied edge is a timestamp-preserving no-op.
    IF v_job.status = 'canceled' THEN
      RETURN QUERY SELECT 'applied'::pg_catalog.text;
      RETURN;
    END IF;
    UPDATE public.tenant_deletion_jobs AS job
    SET status = 'canceled',
        canceled_at = (v_request ->> 'at')::pg_catalog.timestamptz
    WHERE job.tenant_id = v_job.tenant_id AND job.id = v_job.id
      AND job.status = (v_request ->> 'expectedStatus');
    GET DIAGNOSTICS v_changed = ROW_COUNT;

  ELSIF v_edge = 'start' THEN
    IF (v_request ->> 'at') IS NULL OR (v_request ->> 'at') !~ v_ts_rx THEN
      RETURN QUERY SELECT 'invalid_request'::pg_catalog.text;
      RETURN;
    END IF;
    UPDATE public.tenant_deletion_jobs AS job
    SET status = 'running',
        started_at = (v_request ->> 'at')::pg_catalog.timestamptz
    WHERE job.tenant_id = v_job.tenant_id AND job.id = v_job.id
      AND job.status = 'scheduled';
    GET DIAGNOSTICS v_changed = ROW_COUNT;

  ELSIF v_edge = 'restart' THEN
    UPDATE public.tenant_deletion_jobs AS job
    SET status = 'running',
        next_retry_at = NULL,
        error_code = NULL,
        error_fingerprint = NULL
    WHERE job.tenant_id = v_job.tenant_id AND job.id = v_job.id
      AND job.status = 'retry_wait';
    GET DIAGNOSTICS v_changed = ROW_COUNT;

  ELSIF v_edge = 'primary' THEN
    IF (v_request ->> 'at') IS NULL OR (v_request ->> 'at') !~ v_ts_rx
       OR (v_request ->> 'backupExpiryTargetAt') IS NULL
       OR (v_request ->> 'backupExpiryTargetAt') !~ v_ts_rx THEN
      RETURN QUERY SELECT 'invalid_request'::pg_catalog.text;
      RETURN;
    END IF;
    UPDATE public.tenant_deletion_jobs AS job
    SET status = 'primary_deleted',
        primary_deleted_at = (v_request ->> 'at')::pg_catalog.timestamptz,
        backup_expiry_target_at = (v_request ->> 'backupExpiryTargetAt')::pg_catalog.timestamptz
    WHERE job.tenant_id = v_job.tenant_id AND job.id = v_job.id
      AND job.status = 'running';
    GET DIAGNOSTICS v_changed = ROW_COUNT;

  ELSIF v_edge = 'aging' THEN
    IF (v_request ->> 'at') IS NULL OR (v_request ->> 'at') !~ v_ts_rx THEN
      RETURN QUERY SELECT 'invalid_request'::pg_catalog.text;
      RETURN;
    END IF;
    UPDATE public.tenant_deletion_jobs AS job
    SET status = 'backup_aging',
        backup_aging_at = (v_request ->> 'at')::pg_catalog.timestamptz
    WHERE job.tenant_id = v_job.tenant_id AND job.id = v_job.id
      AND job.status = 'primary_deleted';
    GET DIAGNOSTICS v_changed = ROW_COUNT;

  ELSIF v_edge = 'complete' THEN
    IF (v_request ->> 'at') IS NULL OR (v_request ->> 'at') !~ v_ts_rx THEN
      RETURN QUERY SELECT 'invalid_request'::pg_catalog.text;
      RETURN;
    END IF;
    UPDATE public.tenant_deletion_jobs AS job
    SET status = 'completed',
        completed_at = (v_request ->> 'at')::pg_catalog.timestamptz
    WHERE job.tenant_id = v_job.tenant_id AND job.id = v_job.id
      AND job.status = 'backup_aging';
    GET DIAGNOSTICS v_changed = ROW_COUNT;

  ELSIF v_edge = 'failed' THEN
    IF (v_request ->> 'errorFingerprint') IS NULL
       OR (v_request ->> 'errorFingerprint') !~ v_hash_rx THEN
      RETURN QUERY SELECT 'invalid_request'::pg_catalog.text;
      RETURN;
    END IF;
    UPDATE public.tenant_deletion_jobs AS job
    SET status = 'failed',
        error_code = 'DELETE_INTERNAL',
        error_fingerprint = v_request ->> 'errorFingerprint'
    WHERE job.tenant_id = v_job.tenant_id AND job.id = v_job.id
      AND job.status = 'running';
    GET DIAGNOSTICS v_changed = ROW_COUNT;

  ELSIF v_edge = 'requeue' THEN
    IF (v_request ->> 'nextRetryAt') IS NULL OR (v_request ->> 'nextRetryAt') !~ v_ts_rx
       OR (v_request ->> 'errorFingerprint') IS NULL
       OR (v_request ->> 'errorFingerprint') !~ v_hash_rx THEN
      RETURN QUERY SELECT 'invalid_request'::pg_catalog.text;
      RETURN;
    END IF;
    UPDATE public.tenant_deletion_jobs AS job
    SET status = 'retry_wait',
        retry_count = retry_count + 1,
        next_retry_at = (v_request ->> 'nextRetryAt')::pg_catalog.timestamptz,
        error_code = 'DELETE_CHECKPOINT_RETRYABLE',
        error_fingerprint = v_request ->> 'errorFingerprint'
    WHERE job.tenant_id = v_job.tenant_id AND job.id = v_job.id
      AND job.status = 'failed';
    GET DIAGNOSTICS v_changed = ROW_COUNT;

  ELSE
    RETURN QUERY SELECT 'invalid_request'::pg_catalog.text;
    RETURN;
  END IF;

  IF v_changed <> 1 THEN
    RETURN QUERY SELECT 'state_conflict'::pg_catalog.text;
    RETURN;
  END IF;
  RETURN QUERY SELECT 'applied'::pg_catalog.text;
END;
$$;

COMMENT ON FUNCTION public.novatrade_deletion_transition(pg_catalog.text) IS
  'L-02 T-039 deletion-job transition executor; one edge per canonical UPDATE with member-actor binding on decision edges and FOR UPDATE serialization. INTERNAL ONLY.';
REVOKE ALL ON FUNCTION public.novatrade_deletion_transition(pg_catalog.text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.novatrade_deletion_transition(pg_catalog.text) FROM anon;
REVOKE ALL ON FUNCTION public.novatrade_deletion_transition(pg_catalog.text) FROM authenticated;

-- Tenant status CAS restricted to the deletion lane's three legal pairs:
-- archived→deletion_pending (request), deletion_pending→deleted (run),
-- deletion_pending→archived (cancel rollback). Serialized per-tenant.
CREATE OR REPLACE FUNCTION public.novatrade_deletion_tenant_cas(
  p_request pg_catalog.text
)
RETURNS TABLE (applied pg_catalog.bool)
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
DECLARE
  v_request pg_catalog.jsonb := p_request::pg_catalog.jsonb;
  v_guc_tenant pg_catalog.text := coalesce(pg_catalog.current_setting('app.tenant_id', true), '');
  v_from pg_catalog.text := v_request ->> 'fromStatus';
  v_to pg_catalog.text := v_request ->> 'toStatus';
BEGIN
  IF NOT public.novatrade_deletion_actor_ctx()
     OR v_request IS NULL OR pg_catalog.jsonb_typeof(v_request) <> 'object'
     OR (v_request ->> 'tenantId') IS DISTINCT FROM v_guc_tenant
     OR NOT ((v_from = 'archived' AND v_to = 'deletion_pending')
             OR (v_from = 'deletion_pending' AND v_to IN ('deleted', 'archived'))) THEN
    RETURN QUERY SELECT false;
    RETURN;
  END IF;

  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(v_guc_tenant || ':tenant-deletion-cas', 0));

  UPDATE public.tenants AS tenant
    SET status = v_to
    WHERE tenant.id::pg_catalog.text = v_guc_tenant
      AND tenant.status = v_from;
  RETURN QUERY SELECT FOUND;
END;
$$;

COMMENT ON FUNCTION public.novatrade_deletion_tenant_cas(pg_catalog.text) IS
  'L-02 T-039 tenant status CAS restricted to the deletion ledger edges; advisory-locked per tenant. INTERNAL ONLY.';
REVOKE ALL ON FUNCTION public.novatrade_deletion_tenant_cas(pg_catalog.text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.novatrade_deletion_tenant_cas(pg_catalog.text) FROM anon;
REVOKE ALL ON FUNCTION public.novatrade_deletion_tenant_cas(pg_catalog.text) FROM authenticated;

-- Checkpoint insert (pending state) — the insert guard enforces the
-- pending-shape and the job's workspace agreement.
CREATE OR REPLACE FUNCTION public.novatrade_deletion_checkpoint_insert(
  p_request pg_catalog.text
)
RETURNS TABLE (applied pg_catalog.bool)
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
DECLARE
  v_request pg_catalog.jsonb := p_request::pg_catalog.jsonb;
  v_guc_tenant pg_catalog.text := coalesce(pg_catalog.current_setting('app.tenant_id', true), '');
  v_id pg_catalog.text := v_request ->> 'checkpointId';
  v_job_id pg_catalog.text := v_request ->> 'jobId';
  v_workspace pg_catalog.text := v_request ->> 'workspaceId';
BEGIN
  IF NOT public.novatrade_deletion_actor_ctx()
     OR v_request IS NULL OR pg_catalog.jsonb_typeof(v_request) <> 'object'
     OR v_id IS NULL OR v_id !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
     OR v_job_id IS NULL OR v_job_id !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
     OR (v_request ->> 'tenantId') IS DISTINCT FROM v_guc_tenant
     OR (v_workspace IS NOT NULL
         AND v_workspace !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$')
     OR (v_request ->> 'storeClass') NOT IN (
       'cache_idempotency', 'search_embeddings', 'queues_leases', 'agent_context',
       'extracted_derivatives_previews_scanner', 'object_quarantine_storage',
       'primary_database_negative_verification', 'provider_external_copy_requests',
       'logs_telemetry_aggregates', 'backup_aging')
     OR (v_request ->> 'opaqueTargetHash') !~ '^[0-9a-f]{64}$'
     OR NOT EXISTS (
       SELECT 1 FROM public.tenant_deletion_jobs AS job
       WHERE job.tenant_id::pg_catalog.text = v_guc_tenant
         AND job.id::pg_catalog.text = v_job_id
         AND job.workspace_id::pg_catalog.text IS NOT DISTINCT FROM v_workspace) THEN
    RETURN QUERY SELECT false;
    RETURN;
  END IF;

  INSERT INTO public.tenant_deletion_checkpoints (
    id, job_id, tenant_id, workspace_id, store_class, opaque_target_hash
  ) VALUES (
    v_id::pg_catalog.uuid, v_job_id::pg_catalog.uuid, v_guc_tenant::pg_catalog.uuid,
    CASE WHEN v_workspace IS NULL THEN NULL ELSE v_workspace::pg_catalog.uuid END,
    v_request ->> 'storeClass', v_request ->> 'opaqueTargetHash'
  );
  RETURN QUERY SELECT true;
END;
$$;

COMMENT ON FUNCTION public.novatrade_deletion_checkpoint_insert(pg_catalog.text) IS
  'L-02 T-039 checkpoint insert; pending state, bound to an in-tenant deletion job. INTERNAL ONLY.';
REVOKE ALL ON FUNCTION public.novatrade_deletion_checkpoint_insert(pg_catalog.text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.novatrade_deletion_checkpoint_insert(pg_catalog.text) FROM anon;
REVOKE ALL ON FUNCTION public.novatrade_deletion_checkpoint_insert(pg_catalog.text) FROM authenticated;

-- Checkpoint transitions: retryable/running/complete/failed edges mirroring
-- the canonical UPDATEs; the row is locked FOR UPDATE inside the tenant.
CREATE OR REPLACE FUNCTION public.novatrade_deletion_checkpoint_transition(
  p_request pg_catalog.text
)
RETURNS TABLE (outcome pg_catalog.text)
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
DECLARE
  v_request pg_catalog.jsonb := p_request::pg_catalog.jsonb;
  v_guc_tenant pg_catalog.text := coalesce(pg_catalog.current_setting('app.tenant_id', true), '');
  v_edge pg_catalog.text := v_request ->> 'edge';
  v_job_id pg_catalog.text := v_request ->> 'jobId';
  v_store pg_catalog.text := v_request ->> 'storeClass';
  v_checkpoint public.tenant_deletion_checkpoints;
  v_changed pg_catalog.int8;
  v_ts_rx pg_catalog.text := '^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$';
  v_hash_rx pg_catalog.text := '^[0-9a-f]{64}$';
BEGIN
  IF NOT public.novatrade_deletion_actor_ctx() THEN
    RETURN QUERY SELECT 'denied'::pg_catalog.text;
    RETURN;
  END IF;

  IF v_request IS NULL OR pg_catalog.jsonb_typeof(v_request) <> 'object'
     OR v_edge IS NULL
     OR v_job_id IS NULL
        OR v_job_id !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
     OR v_store IS NULL
     OR (v_request ->> 'tenantId') IS DISTINCT FROM v_guc_tenant THEN
    RETURN QUERY SELECT 'invalid_request'::pg_catalog.text;
    RETURN;
  END IF;

  SELECT * INTO v_checkpoint FROM public.tenant_deletion_checkpoints AS checkpoint
    WHERE checkpoint.tenant_id::pg_catalog.text = v_guc_tenant
      AND checkpoint.job_id::pg_catalog.text = v_job_id
      AND checkpoint.store_class = v_store
    FOR UPDATE;
  IF NOT FOUND THEN
    RETURN QUERY SELECT 'not_found'::pg_catalog.text;
    RETURN;
  END IF;

  IF v_edge = 'retryable' THEN
    IF (v_request ->> 'attempt') IS NULL
       OR pg_catalog.jsonb_typeof(v_request -> 'attempt') <> 'number'
       OR (v_request ->> 'attempt')::pg_catalog.int4 <> v_checkpoint.attempt + 1
       OR (v_request ->> 'errorFingerprint') IS NULL
       OR (v_request ->> 'errorFingerprint') !~ v_hash_rx THEN
      RETURN QUERY SELECT 'invalid_request'::pg_catalog.text;
      RETURN;
    END IF;
    UPDATE public.tenant_deletion_checkpoints AS checkpoint
    SET status = 'retryable',
        attempt = (v_request ->> 'attempt')::pg_catalog.int4,
        error_code = 'DELETE_CHECKPOINT_RETRYABLE',
        error_fingerprint = v_request ->> 'errorFingerprint'
    WHERE checkpoint.tenant_id = v_checkpoint.tenant_id
      AND checkpoint.job_id = v_checkpoint.job_id
      AND checkpoint.store_class = v_checkpoint.store_class
      AND checkpoint.status = 'failed';
    GET DIAGNOSTICS v_changed = ROW_COUNT;

  ELSIF v_edge = 'running' THEN
    IF (v_request ->> 'at') IS NULL OR (v_request ->> 'at') !~ v_ts_rx
       OR (v_request ->> 'fromStatus') IS NULL
       OR (v_request ->> 'fromStatus') IS DISTINCT FROM v_checkpoint.status
       OR v_checkpoint.status NOT IN ('pending', 'retryable', 'running') THEN
      RETURN QUERY SELECT 'invalid_request'::pg_catalog.text;
      RETURN;
    END IF;
    UPDATE public.tenant_deletion_checkpoints AS checkpoint
    SET status = 'running',
        started_at = (v_request ->> 'at')::pg_catalog.timestamptz,
        error_code = NULL,
        error_fingerprint = NULL
    WHERE checkpoint.tenant_id = v_checkpoint.tenant_id
      AND checkpoint.job_id = v_checkpoint.job_id
      AND checkpoint.store_class = v_checkpoint.store_class
      AND checkpoint.status = v_checkpoint.status;
    GET DIAGNOSTICS v_changed = ROW_COUNT;

  ELSIF v_edge = 'complete' THEN
    IF (v_request ->> 'at') IS NULL OR (v_request ->> 'at') !~ v_ts_rx
       OR (v_request ->> 'receiptHash') IS NULL OR (v_request ->> 'receiptHash') !~ v_hash_rx
       OR (v_request ->> 'observedCount') IS NULL
       OR pg_catalog.jsonb_typeof(v_request -> 'observedCount') <> 'number'
       OR (v_request ->> 'observedCount')::pg_catalog.int4 < 0
       OR (v_request ->> 'expectedCount') IS NULL
       OR pg_catalog.jsonb_typeof(v_request -> 'expectedCount') <> 'number'
       OR (v_request ->> 'expectedCount')::pg_catalog.int4 < 0 THEN
      RETURN QUERY SELECT 'invalid_request'::pg_catalog.text;
      RETURN;
    END IF;
    UPDATE public.tenant_deletion_checkpoints AS checkpoint
    SET status = 'complete',
        completed_at = (v_request ->> 'at')::pg_catalog.timestamptz,
        receipt_hash = v_request ->> 'receiptHash',
        observed_count = (v_request ->> 'observedCount')::pg_catalog.int4,
        expected_count = (v_request ->> 'expectedCount')::pg_catalog.int4
    WHERE checkpoint.tenant_id = v_checkpoint.tenant_id
      AND checkpoint.job_id = v_checkpoint.job_id
      AND checkpoint.store_class = v_checkpoint.store_class
      AND checkpoint.status = 'running';
    GET DIAGNOSTICS v_changed = ROW_COUNT;

  ELSIF v_edge = 'failed' THEN
    IF (v_request ->> 'errorFingerprint') IS NULL
       OR (v_request ->> 'errorFingerprint') !~ v_hash_rx THEN
      RETURN QUERY SELECT 'invalid_request'::pg_catalog.text;
      RETURN;
    END IF;
    UPDATE public.tenant_deletion_checkpoints AS checkpoint
    SET status = 'failed',
        error_code = 'DELETE_CHECKPOINT_FAILED',
        error_fingerprint = v_request ->> 'errorFingerprint'
    WHERE checkpoint.tenant_id = v_checkpoint.tenant_id
      AND checkpoint.job_id = v_checkpoint.job_id
      AND checkpoint.store_class = v_checkpoint.store_class
      AND checkpoint.status = 'running';
    GET DIAGNOSTICS v_changed = ROW_COUNT;

  ELSE
    RETURN QUERY SELECT 'invalid_request'::pg_catalog.text;
    RETURN;
  END IF;

  IF v_changed <> 1 THEN
    RETURN QUERY SELECT 'state_conflict'::pg_catalog.text;
    RETURN;
  END IF;
  RETURN QUERY SELECT 'applied'::pg_catalog.text;
END;
$$;

COMMENT ON FUNCTION public.novatrade_deletion_checkpoint_transition(pg_catalog.text) IS
  'L-02 T-039 checkpoint transition executor; retryable/running/complete/failed edges with FOR UPDATE serialization. INTERNAL ONLY.';
REVOKE ALL ON FUNCTION public.novatrade_deletion_checkpoint_transition(pg_catalog.text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.novatrade_deletion_checkpoint_transition(pg_catalog.text) FROM anon;
REVOKE ALL ON FUNCTION public.novatrade_deletion_checkpoint_transition(pg_catalog.text) FROM authenticated;

-- Checkpoint event insert — the insert guard requires the event facts to
-- equal the checkpoint row's current state, so a refusal means the service
-- emitted an event for a state the row no longer holds.
CREATE OR REPLACE FUNCTION public.novatrade_deletion_checkpoint_event(
  p_request pg_catalog.text
)
RETURNS TABLE (applied pg_catalog.bool)
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
DECLARE
  v_request pg_catalog.jsonb := p_request::pg_catalog.jsonb;
  v_guc_tenant pg_catalog.text := coalesce(pg_catalog.current_setting('app.tenant_id', true), '');
  v_checkpoint pg_catalog.text := v_request ->> 'checkpointId';
  v_job_id pg_catalog.text := v_request ->> 'jobId';
  v_receipt pg_catalog.text := v_request ->> 'receiptHash';
  v_reason pg_catalog.text := v_request ->> 'reasonCode';
BEGIN
  IF NOT public.novatrade_deletion_actor_ctx()
     OR v_request IS NULL OR pg_catalog.jsonb_typeof(v_request) <> 'object'
     OR v_checkpoint IS NULL
        OR v_checkpoint !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
     OR v_job_id IS NULL
        OR v_job_id !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
     OR (v_request ->> 'tenantId') IS DISTINCT FROM v_guc_tenant
     OR (v_request ->> 'status') NOT IN (
       'pending', 'running', 'complete', 'retryable', 'failed', 'held', 'exempted')
     OR (v_request ->> 'attempt') IS NULL
       OR pg_catalog.jsonb_typeof(v_request -> 'attempt') <> 'number'
       OR (v_request ->> 'attempt')::pg_catalog.int4 < 0
     OR (v_request ->> 'leaseGeneration') IS NULL
       OR pg_catalog.jsonb_typeof(v_request -> 'leaseGeneration') <> 'number'
       OR (v_request ->> 'leaseGeneration')::pg_catalog.int4 < 0
     OR (v_receipt IS NOT NULL AND v_receipt !~ '^[0-9a-f]{64}$')
     OR (v_reason IS NOT NULL AND v_reason <> 'LEGAL_HOLD') THEN
    RETURN QUERY SELECT false;
    RETURN;
  END IF;

  INSERT INTO public.tenant_deletion_checkpoint_events (
    checkpoint_id, tenant_id, job_id, status, attempt, lease_generation,
    receipt_hash, reason_code
  ) VALUES (
    v_checkpoint::pg_catalog.uuid, v_guc_tenant::pg_catalog.uuid, v_job_id::pg_catalog.uuid,
    v_request ->> 'status',
    (v_request ->> 'attempt')::pg_catalog.int4,
    (v_request ->> 'leaseGeneration')::pg_catalog.int4,
    v_receipt, v_reason
  );
  RETURN QUERY SELECT true;
END;
$$;

COMMENT ON FUNCTION public.novatrade_deletion_checkpoint_event(pg_catalog.text) IS
  'L-02 T-039 checkpoint event insert; guard-bound to the checkpoint row current state. INTERNAL ONLY.';
REVOKE ALL ON FUNCTION public.novatrade_deletion_checkpoint_event(pg_catalog.text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.novatrade_deletion_checkpoint_event(pg_catalog.text) FROM anon;
REVOKE ALL ON FUNCTION public.novatrade_deletion_checkpoint_event(pg_catalog.text) FROM authenticated;

-- Tombstone insert — the guard requires the job in primary_deleted /
-- backup_aging with the exact checkpoint set and complete primaries.
CREATE OR REPLACE FUNCTION public.novatrade_deletion_tombstone_insert(
  p_request pg_catalog.text
)
RETURNS TABLE (applied pg_catalog.bool)
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
DECLARE
  v_request pg_catalog.jsonb := p_request::pg_catalog.jsonb;
  v_guc_tenant pg_catalog.text := coalesce(pg_catalog.current_setting('app.tenant_id', true), '');
  v_id pg_catalog.text := v_request ->> 'tombstoneId';
  v_job_id pg_catalog.text := v_request ->> 'jobId';
  v_workspace pg_catalog.text := v_request ->> 'workspaceId';
BEGIN
  IF NOT public.novatrade_deletion_actor_ctx()
     OR v_request IS NULL OR pg_catalog.jsonb_typeof(v_request) <> 'object'
     OR v_id IS NULL OR v_id !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
     OR v_job_id IS NULL OR v_job_id !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
     OR (v_request ->> 'tenantId') IS DISTINCT FROM v_guc_tenant
     OR (v_workspace IS NOT NULL
         AND v_workspace !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$')
     OR (v_request ->> 'scopeSelectorHash') !~ '^[0-9a-f]{64}$'
     OR (v_request ->> 'tenantIdentityHash') !~ '^[0-9a-f]{64}$'
     OR (v_request ->> 'policyVersion') IS NULL
        OR (v_request ->> 'policyVersion') !~ '^[A-Za-z0-9][A-Za-z0-9._-]{4,127}$'
     OR (v_request ->> 'retentionUntil') IS NULL
        OR (v_request ->> 'retentionUntil') !~ '^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$' THEN
    RETURN QUERY SELECT false;
    RETURN;
  END IF;

  INSERT INTO public.tenant_deletion_tombstones (
    id, job_id, tenant_id, workspace_id, scope_selector_hash,
    tenant_identity_hash, policy_version, retention_until
  ) VALUES (
    v_id::pg_catalog.uuid, v_job_id::pg_catalog.uuid, v_guc_tenant::pg_catalog.uuid,
    CASE WHEN v_workspace IS NULL THEN NULL ELSE v_workspace::pg_catalog.uuid END,
    v_request ->> 'scopeSelectorHash', v_request ->> 'tenantIdentityHash',
    v_request ->> 'policyVersion', (v_request ->> 'retentionUntil')::pg_catalog.timestamptz
  );
  RETURN QUERY SELECT true;
END;
$$;

COMMENT ON FUNCTION public.novatrade_deletion_tombstone_insert(pg_catalog.text) IS
  'L-02 T-039 tombstone insert; write-last after primary checkpoints complete. INTERNAL ONLY.';
REVOKE ALL ON FUNCTION public.novatrade_deletion_tombstone_insert(pg_catalog.text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.novatrade_deletion_tombstone_insert(pg_catalog.text) FROM anon;
REVOKE ALL ON FUNCTION public.novatrade_deletion_tombstone_insert(pg_catalog.text) FROM authenticated;

-- Deletion audit append — member actors bind every actor field to the
-- installed GUCs and write tenant-scope rows; system/worker/support
-- executors write platform-scope rows with the tenant ref in metadata only.
CREATE OR REPLACE FUNCTION public.novatrade_deletion_audit_append(
  p_request pg_catalog.text
)
RETURNS TABLE (applied pg_catalog.bool)
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
DECLARE
  v_event pg_catalog.jsonb := p_request::pg_catalog.jsonb;
  v_guc_tenant pg_catalog.text := coalesce(pg_catalog.current_setting('app.tenant_id', true), '');
  v_guc_workspace pg_catalog.text := coalesce(pg_catalog.current_setting('app.workspace_id', true), '');
  v_guc_actor pg_catalog.text := coalesce(pg_catalog.current_setting('app.actor_id', true), '');
  v_guc_membership pg_catalog.text := coalesce(pg_catalog.current_setting('app.membership_id', true), '');
  v_guc_role pg_catalog.text := coalesce(pg_catalog.current_setting('app.role', true), '');
  v_guc_binding pg_catalog.text := coalesce(pg_catalog.current_setting('app.role_binding_id', true), '');
  v_event_id pg_catalog.text := v_event ->> 'eventId';
  v_event_type pg_catalog.text := v_event ->> 'eventType';
  v_actor_layer pg_catalog.text := v_event ->> 'actorLayer';
  v_job_id pg_catalog.text := v_event ->> 'jobId';
  v_workspace pg_catalog.text := v_event ->> 'workspaceId';
BEGIN
  IF NOT public.novatrade_deletion_actor_ctx() THEN
    RETURN QUERY SELECT false;
    RETURN;
  END IF;

  IF v_event IS NULL OR pg_catalog.jsonb_typeof(v_event) <> 'object'
     OR v_event_id IS NULL
        OR v_event_id !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
     OR v_event_type IS NULL OR v_event_type NOT IN (
       'tenant.deletion.requested', 'tenant.deletion.verified',
       'tenant.deletion.scheduled', 'tenant.deletion.running',
       'tenant.deletion.primary_deleted', 'tenant.deletion.completed',
       'tenant.deletion.canceled', 'tenant.deletion.failed',
       'tenant.deletion.requeued')
     OR (v_event ->> 'tenantId') IS DISTINCT FROM v_guc_tenant
     OR (v_event ->> 'correlationId') IS NULL
        OR (v_event ->> 'correlationId') !~ '^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$'
     OR v_job_id IS NULL
        OR v_job_id !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
     OR NOT EXISTS (
       SELECT 1 FROM public.tenant_deletion_jobs AS job
       WHERE job.tenant_id::pg_catalog.text = v_guc_tenant
         AND job.id::pg_catalog.text = v_job_id)
     OR (v_workspace IS NOT NULL
         AND (v_workspace !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
              OR NOT EXISTS (
                SELECT 1 FROM public.workspaces AS workspace
                WHERE workspace.tenant_id::pg_catalog.text = v_guc_tenant
                  AND workspace.id::pg_catalog.text = v_workspace)))
  THEN
    RETURN QUERY SELECT false;
    RETURN;
  END IF;

  IF v_actor_layer = 'member' THEN
    IF (v_event ->> 'actorIdentityId') IS DISTINCT FROM v_guc_actor
       OR (v_event ->> 'actorMembershipId') IS DISTINCT FROM v_guc_membership
       OR (v_event ->> 'actorRole') IS DISTINCT FROM v_guc_role
       OR (v_event ->> 'actorRoleBindingId') IS DISTINCT FROM v_guc_binding THEN
      RETURN QUERY SELECT false;
      RETURN;
    END IF;

    INSERT INTO public.audit_logs (
      id, action, entity_type, entity_id, metadata, scope_kind,
      tenant_id, workspace_id, correlation_id,
      actor_auth_identity_id, actor_membership_id,
      actor_launch_role, actor_role_binding_id, actor_layer
    ) VALUES (
      v_event_id::pg_catalog.uuid, v_event_type, 'tenant_lifecycle_job',
      v_job_id, v_event, 'tenant',
      v_guc_tenant::pg_catalog.uuid,
      CASE WHEN v_workspace IS NULL THEN NULL ELSE v_workspace::pg_catalog.uuid END,
      v_event ->> 'correlationId',
      v_guc_actor::pg_catalog.uuid, v_guc_membership::pg_catalog.uuid,
      v_guc_role, v_guc_binding::pg_catalog.uuid, 'member'
    );
    RETURN QUERY SELECT true;
    RETURN;
  END IF;

  IF v_actor_layer NOT IN ('system', 'worker', 'support')
     OR (v_event ->> 'actorIdentityId') IS NULL
     OR (v_event ->> 'actorIdentityId') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
     OR (v_event ->> 'actorMembershipId') IS NOT NULL
     OR (v_event ->> 'actorRole') IS NOT NULL
     OR (v_event ->> 'actorRoleBindingId') IS NOT NULL THEN
    RETURN QUERY SELECT false;
    RETURN;
  END IF;

  INSERT INTO public.audit_logs (
    id, action, entity_type, entity_id, metadata, scope_kind,
    tenant_id, workspace_id, correlation_id,
    actor_auth_identity_id, actor_membership_id,
    actor_launch_role, actor_role_binding_id, actor_layer
  ) VALUES (
    v_event_id::pg_catalog.uuid, v_event_type, 'tenant_lifecycle_job',
    v_job_id, v_event, 'platform', NULL, NULL,
    v_event ->> 'correlationId',
    (v_event ->> 'actorIdentityId')::pg_catalog.uuid, NULL, NULL, NULL,
    v_actor_layer
  );
  RETURN QUERY SELECT true;
END;
$$;

COMMENT ON FUNCTION public.novatrade_deletion_audit_append(pg_catalog.text) IS
  'L-02 T-039 deletion audit append; member events bind to the installed context, executor events write platform scope. INTERNAL ONLY.';
REVOKE ALL ON FUNCTION public.novatrade_deletion_audit_append(pg_catalog.text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.novatrade_deletion_audit_append(pg_catalog.text) FROM anon;
REVOKE ALL ON FUNCTION public.novatrade_deletion_audit_append(pg_catalog.text) FROM authenticated;
