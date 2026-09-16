-- L-02 T-038: tenant export operations on Postgres.
--
-- The canonical TenantLifecycleOpsService export surface (requestExport,
-- runExport, cancelExport, requeueExport, sweepExportRetention) writes the
-- tenant_export_jobs ledger and tenant.export.* audit rows. The ledger is
-- member-select + deny-all-else under RLS and every mutation is further
-- guarded by trg_novatrade_tenant_export_jobs_guard_and_touch (requester
-- eligibility, legal status edges, retry/lease/artifact invariants), so
-- every write goes through these SECURITY DEFINER functions; reads ride the
-- existing member-select policy.
--
-- Context lane: every shipped caller runs under a member ambient context —
-- the action layer drives runExport/sweepExportRetention inline with a
-- system-layer executor inside the member's transaction context. All five
-- functions therefore require novatrade_rls_member_context() plus a
-- tenant-wide owner/admin GUC role, and bind tenant/actor/membership facts
-- to the installed GUCs. A dedicated worker lane for standalone scheduled
-- execution is a separate slice; support-grant requesters fail closed under
-- member RLS until the support-context ops lane lands.
--
-- Audit discipline mirrors the local backend exactly: member-layer events
-- write scope_kind 'tenant' rows (actor columns bound to the member GUCs);
-- system/worker-layer events write scope_kind 'platform' rows where the
-- tenant reference lives only inside the event metadata — matching
-- appendLifecycleAudit in local-lifecycle-operations.ts.
--
-- Payload convention: every function takes pg_catalog.text and parses
-- ::jsonb internally because postgres.js double-encodes JS strings bound to
-- jsonb parameters.

-- Canonical export-job renderer shared by the API functions' return
-- payloads. Shape = TenantExportJob as mapExportJob validates it.
CREATE OR REPLACE FUNCTION public.novatrade_export_job_json(
  p_job public.tenant_export_jobs
)
RETURNS pg_catalog.jsonb
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
  SELECT pg_catalog.jsonb_build_object(
    'id', p_job.id::pg_catalog.text,
    'tenantId', p_job.tenant_id::pg_catalog.text,
    'workspaceId', p_job.workspace_id::pg_catalog.text,
    'operation', p_job.operation,
    'requesterAuthIdentityId', p_job.requester_auth_identity_id::pg_catalog.text,
    'requesterMembershipId', p_job.requester_membership_id::pg_catalog.text,
    'supportAccessGrantId', p_job.support_access_grant_id::pg_catalog.text,
    'status', p_job.status,
    'scopeHash', p_job.scope_hash,
    'inputHash', p_job.input_hash,
    'idempotencyKeyHash', p_job.idempotency_key_hash,
    'policyVersion', p_job.policy_version,
    'manifestVersion', p_job.manifest_version,
    'schemaVersion', p_job.schema_version,
    'requestedFormat', p_job.requested_format,
    'snapshotAt', pg_catalog.to_char(p_job.snapshot_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
    'artifactStorageRef', p_job.artifact_storage_ref,
    'artifactChecksumSha256', p_job.artifact_checksum_sha256,
    'includedCount', p_job.included_count,
    'excludedCount', p_job.excluded_count,
    'redactedCount', p_job.redacted_count,
    'artifactCreatedAt', pg_catalog.to_char(p_job.artifact_created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
    'expiresAt', pg_catalog.to_char(p_job.expires_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
    'errorCode', p_job.error_code,
    'errorMessage', p_job.error_message,
    'retryCount', p_job.retry_count,
    'maxRetries', p_job.max_retries,
    'nextRetryAt', pg_catalog.to_char(p_job.next_retry_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
    'leaseOwnerHash', p_job.lease_owner_hash,
    'leaseGeneration', p_job.lease_generation,
    'leaseAcquiredAt', pg_catalog.to_char(p_job.lease_acquired_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
    'leaseHeartbeatAt', pg_catalog.to_char(p_job.lease_heartbeat_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
    'leaseExpiresAt', pg_catalog.to_char(p_job.lease_expires_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
    'correlationId', p_job.correlation_id,
    'auditEventId', p_job.audit_event_id::pg_catalog.text,
    'createdAt', pg_catalog.to_char(p_job.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
    'updatedAt', pg_catalog.to_char(p_job.updated_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
  );
$$;

COMMENT ON FUNCTION public.novatrade_export_job_json(public.tenant_export_jobs) IS
  'L-02 internal export-job renderer; emits the canonical TenantExportJob shape with canonical millisecond timestamps. INTERNAL ONLY.';
REVOKE ALL ON FUNCTION public.novatrade_export_job_json(public.tenant_export_jobs) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.novatrade_export_job_json(public.tenant_export_jobs) FROM anon;
REVOKE ALL ON FUNCTION public.novatrade_export_job_json(public.tenant_export_jobs) FROM authenticated;

-- Shared member-context gate for the export write lane. Distinct from
-- novatrade_rls_member_context() only in the role bound: every shipped
-- export caller is a tenant-wide owner/admin (the action layer refuses
-- workspace-scoped and non-privileged sessions before it installs the
-- context).
CREATE OR REPLACE FUNCTION public.novatrade_export_member_ctx()
RETURNS pg_catalog.bool
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
BEGIN
  RETURN public.novatrade_rls_member_context()
    AND pg_catalog.current_setting('app.role', true) IN ('owner', 'admin');
END;
$$;

COMMENT ON FUNCTION public.novatrade_export_member_ctx() IS
  'L-02 internal export write-lane gate: live member context with a tenant-wide owner/admin role.';
REVOKE ALL ON FUNCTION public.novatrade_export_member_ctx() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.novatrade_export_member_ctx() FROM anon;
REVOKE ALL ON FUNCTION public.novatrade_export_member_ctx() FROM authenticated;

-- Member-initiated export request. Binds tenant, requester identity,
-- requester membership, and workspace scope to the member GUCs; a grant
-- reference cannot be smuggled in under a member context (support-grant
-- requesters are refused before this point by member-RLS reads). The guard
-- trigger revalidates requester eligibility and the exact 'requested'
-- insert state; a same-key different-input insert hits the unique index
-- and propagates exactly like the local backend's constraint failure.
CREATE OR REPLACE FUNCTION public.novatrade_export_request(
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
  v_job_id pg_catalog.text := v_request ->> 'jobId';
  v_workspace pg_catalog.text := v_request ->> 'workspaceId';
BEGIN
  IF NOT public.novatrade_export_member_ctx() THEN
    RETURN QUERY SELECT false;
    RETURN;
  END IF;

  IF v_job_id IS NULL OR v_job_id !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
     OR (v_request ->> 'tenantId') IS DISTINCT FROM v_guc_tenant
     OR (v_request ->> 'requesterAuthIdentityId') IS DISTINCT FROM v_guc_actor
     OR (v_request ->> 'requesterMembershipId') IS DISTINCT FROM v_guc_membership
     OR (v_request ->> 'supportAccessGrantId') IS NOT NULL
     OR (v_workspace IS NOT NULL
         AND (v_workspace !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
              OR v_workspace IS DISTINCT FROM NULLIF(v_guc_workspace, '')))
     OR (v_workspace IS NULL AND v_guc_workspace <> '')
     OR (v_request ->> 'scopeHash') IS NULL OR (v_request ->> 'scopeHash') !~ '^[0-9a-f]{64}$'
     OR (v_request ->> 'inputHash') IS NULL OR (v_request ->> 'inputHash') !~ '^[0-9a-f]{64}$'
     OR (v_request ->> 'idempotencyKeyHash') IS NULL OR (v_request ->> 'idempotencyKeyHash') !~ '^[0-9a-f]{64}$'
     OR (v_request ->> 'policyVersion') IS NULL
        OR (v_request ->> 'policyVersion') !~ '^[A-Za-z0-9][A-Za-z0-9._-]{4,127}$'
     OR (v_request ->> 'manifestVersion') IS NULL
        OR (v_request ->> 'manifestVersion') !~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$'
     OR (v_request ->> 'schemaVersion') IS NULL
        OR (v_request ->> 'schemaVersion') !~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$'
     OR (v_request ->> 'requestedFormat') IS NULL
        OR (v_request ->> 'requestedFormat') NOT IN ('csv', 'json', 'package')
     OR (v_request ->> 'correlationId') IS NULL
        OR (v_request ->> 'correlationId') !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$'
     OR (v_request ->> 'auditEventId') IS NULL
        OR (v_request ->> 'auditEventId') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
  THEN
    RETURN QUERY SELECT false;
    RETURN;
  END IF;

  INSERT INTO public.tenant_export_jobs (
    id, tenant_id, workspace_id, operation,
    requester_auth_identity_id, requester_membership_id, support_access_grant_id,
    status, scope_hash, input_hash, idempotency_key_hash,
    policy_version, manifest_version, schema_version, requested_format,
    correlation_id, audit_event_id
  ) VALUES (
    v_job_id::pg_catalog.uuid, v_guc_tenant::pg_catalog.uuid,
    NULLIF(v_workspace, '')::pg_catalog.uuid, 'tenant_data_export',
    v_guc_actor::pg_catalog.uuid, v_guc_membership::pg_catalog.uuid, NULL,
    'requested', v_request ->> 'scopeHash', v_request ->> 'inputHash',
    v_request ->> 'idempotencyKeyHash', v_request ->> 'policyVersion',
    v_request ->> 'manifestVersion', v_request ->> 'schemaVersion',
    v_request ->> 'requestedFormat', v_request ->> 'correlationId',
    (v_request ->> 'auditEventId')::pg_catalog.uuid
  );

  RETURN QUERY SELECT true;
END;
$$;

COMMENT ON FUNCTION public.novatrade_export_request(pg_catalog.text) IS
  'L-02 member-context export request; binds tenant/requester/membership/workspace to the member GUCs and inserts the exact requested initial state. Same-key duplicate inserts propagate the unique-index violation.';
REVOKE ALL ON FUNCTION public.novatrade_export_request(pg_catalog.text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.novatrade_export_request(pg_catalog.text) FROM anon;
REVOKE ALL ON FUNCTION public.novatrade_export_request(pg_catalog.text) FROM authenticated;

-- Single CAS driver for every export-job edge the canonical service emits:
-- member decisions (cancel, requeue), the run pipeline (enter, fail,
-- redact, artifact, release), and the retention sweep (expire, delete).
-- The job must sit inside the accepted tenant+workspace scope; a CAS miss
-- is reported as not_found or state_conflict after a locked re-read, which
-- the adapter maps to the canonical zero-change result the service folds
-- into FAILED_INTERNAL — the same honesty boundary as direct table writes.
CREATE OR REPLACE FUNCTION public.novatrade_export_transition(
  p_request pg_catalog.text
)
RETURNS TABLE (outcome pg_catalog.text, job_json pg_catalog.jsonb)
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
DECLARE
  v_request pg_catalog.jsonb := p_request::pg_catalog.jsonb;
  v_guc_tenant pg_catalog.text := coalesce(pg_catalog.current_setting('app.tenant_id', true), '');
  v_guc_workspace pg_catalog.text := coalesce(pg_catalog.current_setting('app.workspace_id', true), '');
  v_job_id pg_catalog.text := v_request ->> 'jobId';
  v_edge pg_catalog.text := v_request ->> 'edge';
  v_expected pg_catalog.text := v_request ->> 'expectedStatus';
  v_job public.tenant_export_jobs%ROWTYPE;
  v_updated pg_catalog.int4;
BEGIN
  IF NOT public.novatrade_export_member_ctx() THEN
    RETURN QUERY SELECT 'denied'::pg_catalog.text, NULL::pg_catalog.jsonb;
    RETURN;
  END IF;

  IF v_job_id IS NULL OR v_job_id !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
     OR (v_request ->> 'tenantId') IS DISTINCT FROM v_guc_tenant
     OR v_edge IS NULL OR v_edge NOT IN (
       'enter', 'fail', 'redact', 'artifact', 'release',
       'cancel', 'requeue', 'expire', 'delete')
  THEN
    RETURN QUERY SELECT 'invalid_request'::pg_catalog.text, NULL::pg_catalog.jsonb;
    RETURN;
  END IF;

  SELECT * INTO v_job
  FROM public.tenant_export_jobs AS job
  WHERE job.tenant_id::pg_catalog.text = v_guc_tenant
    AND job.id::pg_catalog.text = v_job_id
    AND job.workspace_id::pg_catalog.text IS NOT DISTINCT FROM NULLIF(v_guc_workspace, '')
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN QUERY SELECT 'not_found'::pg_catalog.text, NULL::pg_catalog.jsonb;
    RETURN;
  END IF;

  v_updated := 0;
  IF v_edge = 'enter' THEN
    IF v_expected IS NULL OR v_expected NOT IN ('requested', 'retry_wait') THEN
      RETURN QUERY SELECT 'invalid_request'::pg_catalog.text, NULL::pg_catalog.jsonb;
      RETURN;
    END IF;
    UPDATE public.tenant_export_jobs AS job
    SET status = 'snapshotting', next_retry_at = NULL
    WHERE job.tenant_id = v_job.tenant_id AND job.id = v_job.id
      AND job.status = v_expected;
    GET DIAGNOSTICS v_updated = ROW_COUNT;
  ELSIF v_edge = 'fail' THEN
    IF (v_request ->> 'errorCode') IS NULL
       OR (v_request ->> 'errorCode') NOT IN (
         'EXPORT_SCOPE_INVALID', 'EXPORT_POLICY_BLOCKED', 'EXPORT_SNAPSHOT_FAILED',
         'EXPORT_REDACTION_FAILED', 'EXPORT_ARTIFACT_FAILED',
         'EXPORT_STORAGE_CHECKPOINT_FAILED', 'EXPORT_RETRYABLE',
         'EXPORT_RETRY_EXHAUSTED', 'EXPORT_CANCELED',
         'BLOCKED_EXPORT_REPLAY_CONFLICT', 'BLOCKED_EXPORT_EXPIRED',
         'EXPORT_UNKNOWN_FAILURE')
       OR (v_request ->> 'errorMessage') IS NULL
       OR (v_request ->> 'errorMessage') !~ '^[A-Za-z0-9][A-Za-z0-9 .,:;_()/-]{0,239}$'
       OR pg_catalog.lower(v_request ->> 'errorMessage') ~ '(secret|credential|password|bearer|api[_-]?key|token)'
    THEN
      RETURN QUERY SELECT 'invalid_request'::pg_catalog.text, NULL::pg_catalog.jsonb;
      RETURN;
    END IF;
    UPDATE public.tenant_export_jobs AS job
    SET status = 'failed', error_code = v_request ->> 'errorCode',
        error_message = v_request ->> 'errorMessage'
    WHERE job.tenant_id = v_job.tenant_id AND job.id = v_job.id
      AND job.status = 'snapshotting';
    GET DIAGNOSTICS v_updated = ROW_COUNT;
  ELSIF v_edge = 'redact' THEN
    IF (v_request ->> 'snapshotAt') IS NULL
       OR (v_request ->> 'snapshotAt') !~ '^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$' THEN
      RETURN QUERY SELECT 'invalid_request'::pg_catalog.text, NULL::pg_catalog.jsonb;
      RETURN;
    END IF;
    UPDATE public.tenant_export_jobs AS job
    SET status = 'redacting', snapshot_at = (v_request ->> 'snapshotAt')::pg_catalog.timestamptz
    WHERE job.tenant_id = v_job.tenant_id AND job.id = v_job.id
      AND job.status = 'snapshotting';
    GET DIAGNOSTICS v_updated = ROW_COUNT;
  ELSIF v_edge = 'artifact' THEN
    IF (v_request ->> 'artifactStorageRef') IS NULL
       OR (v_request ->> 'artifactChecksumSha256') IS NULL
       OR (v_request ->> 'artifactChecksumSha256') !~ '^[0-9a-f]{64}$'
       OR (v_request -> 'includedCount') IS NULL
       OR pg_catalog.jsonb_typeof(v_request -> 'includedCount') <> 'number'
       OR (v_request -> 'excludedCount') IS NULL
       OR pg_catalog.jsonb_typeof(v_request -> 'excludedCount') <> 'number'
       OR (v_request -> 'redactedCount') IS NULL
       OR pg_catalog.jsonb_typeof(v_request -> 'redactedCount') <> 'number'
       OR (v_request ->> 'includedCount')::pg_catalog.int4 < 0
       OR (v_request ->> 'excludedCount')::pg_catalog.int4 < 0
       OR (v_request ->> 'redactedCount')::pg_catalog.int4 < 0
       OR (v_request ->> 'artifactCreatedAt') IS NULL
       OR (v_request ->> 'artifactCreatedAt') !~ '^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$'
       OR (v_request ->> 'expiresAt') IS NULL
       OR (v_request ->> 'expiresAt') !~ '^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$' THEN
      RETURN QUERY SELECT 'invalid_request'::pg_catalog.text, NULL::pg_catalog.jsonb;
      RETURN;
    END IF;
    UPDATE public.tenant_export_jobs AS job
    SET status = 'artifact_created',
        artifact_storage_ref = v_request ->> 'artifactStorageRef',
        artifact_checksum_sha256 = v_request ->> 'artifactChecksumSha256',
        included_count = (v_request ->> 'includedCount')::pg_catalog.int4,
        excluded_count = (v_request ->> 'excludedCount')::pg_catalog.int4,
        redacted_count = (v_request ->> 'redactedCount')::pg_catalog.int4,
        artifact_created_at = (v_request ->> 'artifactCreatedAt')::pg_catalog.timestamptz,
        expires_at = (v_request ->> 'expiresAt')::pg_catalog.timestamptz
    WHERE job.tenant_id = v_job.tenant_id AND job.id = v_job.id
      AND job.status = 'redacting';
    GET DIAGNOSTICS v_updated = ROW_COUNT;
  ELSIF v_edge = 'release' THEN
    UPDATE public.tenant_export_jobs AS job
    SET status = 'released'
    WHERE job.tenant_id = v_job.tenant_id AND job.id = v_job.id
      AND job.status = 'artifact_created';
    GET DIAGNOSTICS v_updated = ROW_COUNT;
  ELSIF v_edge = 'cancel' THEN
    IF v_expected IS NULL OR v_expected NOT IN (
         'requested', 'snapshotting', 'redacting', 'artifact_created',
         'retry_wait', 'failed')
       OR (v_request ->> 'errorMessage') IS NULL
       OR (v_request ->> 'errorMessage') !~ '^[A-Za-z0-9][A-Za-z0-9 .,:;_()/-]{0,239}$'
       OR pg_catalog.lower(v_request ->> 'errorMessage') ~ '(secret|credential|password|bearer|api[_-]?key|token)'
    THEN
      RETURN QUERY SELECT 'invalid_request'::pg_catalog.text, NULL::pg_catalog.jsonb;
      RETURN;
    END IF;
    UPDATE public.tenant_export_jobs AS job
    SET status = 'canceled', error_code = 'EXPORT_CANCELED',
        error_message = v_request ->> 'errorMessage'
    WHERE job.tenant_id = v_job.tenant_id AND job.id = v_job.id
      AND job.status = v_expected;
    GET DIAGNOSTICS v_updated = ROW_COUNT;
  ELSIF v_edge = 'requeue' THEN
    IF (v_request ->> 'nextRetryAt') IS NULL
       OR (v_request ->> 'nextRetryAt') !~ '^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$'
       OR (v_request ->> 'errorMessage') IS NULL
       OR (v_request ->> 'errorMessage') !~ '^[A-Za-z0-9][A-Za-z0-9 .,:;_()/-]{0,239}$'
       OR pg_catalog.lower(v_request ->> 'errorMessage') ~ '(secret|credential|password|bearer|api[_-]?key|token)'
    THEN
      RETURN QUERY SELECT 'invalid_request'::pg_catalog.text, NULL::pg_catalog.jsonb;
      RETURN;
    END IF;
    UPDATE public.tenant_export_jobs AS job
    SET status = 'retry_wait', retry_count = retry_count + 1,
        next_retry_at = (v_request ->> 'nextRetryAt')::pg_catalog.timestamptz,
        error_code = 'EXPORT_RETRYABLE',
        error_message = v_request ->> 'errorMessage'
    WHERE job.tenant_id = v_job.tenant_id AND job.id = v_job.id
      AND job.status = 'failed';
    GET DIAGNOSTICS v_updated = ROW_COUNT;
  ELSIF v_edge = 'expire' THEN
    UPDATE public.tenant_export_jobs AS job
    SET status = 'expired'
    WHERE job.tenant_id = v_job.tenant_id AND job.id = v_job.id
      AND job.status = 'released';
    GET DIAGNOSTICS v_updated = ROW_COUNT;
  ELSE
    UPDATE public.tenant_export_jobs AS job
    SET status = 'deleted'
    WHERE job.tenant_id = v_job.tenant_id AND job.id = v_job.id
      AND job.status = 'expired';
    GET DIAGNOSTICS v_updated = ROW_COUNT;
  END IF;

  IF v_updated <> 1 THEN
    RETURN QUERY SELECT 'state_conflict'::pg_catalog.text, NULL::pg_catalog.jsonb;
    RETURN;
  END IF;

  SELECT * INTO v_job
  FROM public.tenant_export_jobs AS job
  WHERE job.tenant_id = v_job.tenant_id AND job.id = v_job.id;
  RETURN QUERY SELECT 'applied'::pg_catalog.text, public.novatrade_export_job_json(v_job);
END;
$$;

COMMENT ON FUNCTION public.novatrade_export_transition(pg_catalog.text) IS
  'L-02 member-context export-job CAS driver; binds the job to the accepted tenant+workspace scope, validates per-edge facts, applies exactly one legal transition, and returns the canonical job row.';
REVOKE ALL ON FUNCTION public.novatrade_export_transition(pg_catalog.text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.novatrade_export_transition(pg_catalog.text) FROM anon;
REVOKE ALL ON FUNCTION public.novatrade_export_transition(pg_catalog.text) FROM authenticated;

-- Export audit append mirroring appendLifecycleAudit verbatim: member-layer
-- events write tenant-scope rows with the actor columns bound to the member
-- GUCs; system/worker-layer events write platform-scope rows (tenant and
-- job references live only inside the event metadata). The event must name
-- an in-tenant job and agree with the context on tenant/actor/correlation
-- discipline: correlation_id records the command's own correlation, not the
-- ambient envelope.
CREATE OR REPLACE FUNCTION public.novatrade_export_audit_append(
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
  IF NOT public.novatrade_export_member_ctx() THEN
    RETURN QUERY SELECT false;
    RETURN;
  END IF;

  IF v_event IS NULL OR pg_catalog.jsonb_typeof(v_event) <> 'object'
     OR v_event_id IS NULL
        OR v_event_id !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
     OR v_event_type IS NULL OR v_event_type NOT IN (
       'tenant.export.requested', 'tenant.export.released', 'tenant.export.failed',
       'tenant.export.canceled', 'tenant.export.requeued', 'tenant.export.expired',
       'tenant.export.deleted')
     OR (v_event ->> 'tenantId') IS DISTINCT FROM v_guc_tenant
     OR (v_event ->> 'correlationId') IS NULL
        OR (v_event ->> 'correlationId') !~ '^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$'
     OR v_job_id IS NULL
        OR v_job_id !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
     OR NOT EXISTS (
       SELECT 1 FROM public.tenant_export_jobs AS job
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
    v_job_id, v_event, 'platform',
    NULL, NULL,
    v_event ->> 'correlationId',
    (v_event ->> 'actorIdentityId')::pg_catalog.uuid, NULL,
    NULL, NULL, v_actor_layer
  );
  RETURN QUERY SELECT true;
END;
$$;

COMMENT ON FUNCTION public.novatrade_export_audit_append(pg_catalog.text) IS
  'L-02 export audit append; member-layer events write tenant-scope rows bound to the member GUCs, system/worker/support-layer events write platform-scope rows, and every event names a live in-tenant job.';
REVOKE ALL ON FUNCTION public.novatrade_export_audit_append(pg_catalog.text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.novatrade_export_audit_append(pg_catalog.text) FROM anon;
REVOKE ALL ON FUNCTION public.novatrade_export_audit_append(pg_catalog.text) FROM authenticated;
