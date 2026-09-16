-- L-03 document pipeline worker and retention authority. Extends the L-03
-- runtime boundary with fenced scan/extraction lease acquisition, result
-- persistence, lease-loss recovery, member extraction request/cancel,
-- retention evaluation recording, and safe deletion application.
--
-- Worker authority remains the fenced document job lease itself:
-- app.worker_name='document_pipeline', an action-scoped app.worker_action, and
-- the job-bound app.job_id/app.lease_id/app.lease_generation GUCs are checked
-- against live lease facts (only token digests are persisted). Claim-style
-- acquisition additionally permits a discovery scope where tenant/workspace/
-- job GUCs may be absent and the issued lease binds the returned job row.
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '120s';
SELECT pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtext('novatrade:l03:document-pipeline-workers'));

-- Lease token digests are computed inside SECURITY DEFINER functions whose
-- search_path is pinned to pg_catalog, so the pgcrypto digest is always
-- addressed through the dedicated extensions schema (the deployed convention).
CREATE SCHEMA IF NOT EXISTS extensions;
CREATE EXTENSION IF NOT EXISTS pgcrypto WITH SCHEMA extensions;
GRANT USAGE ON SCHEMA extensions TO novatrade_document_pipeline_definer;
GRANT EXECUTE ON FUNCTION extensions.digest(pg_catalog.text,pg_catalog.text)
  TO novatrade_document_pipeline_definer;

-- ---------------------------------------------------------------------------
-- Discovery-scoped worker predicate: authenticates the document pipeline
-- worker without requiring tenant/workspace/job binding. Used only by the
-- claim-style lease acquisition that itself binds and returns live job facts.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.novatrade_l03_worker_discovery(p_action pg_catalog.text)
RETURNS boolean
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $fn$
BEGIN
  IF p_action IS NULL OR p_action !~ '^document_(scan|extraction|pipeline|retention):[a-z_]+$' THEN
    RETURN false;
  END IF;
  IF pg_catalog.current_setting('app.job_id',true) IS NULL
     OR pg_catalog.current_setting('app.job_id',true) !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
     OR pg_catalog.current_setting('app.run_id',true) IS NULL
     OR pg_catalog.current_setting('app.run_id',true) !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
     OR pg_catalog.current_setting('app.lease_id',true) IS NULL
     OR pg_catalog.current_setting('app.lease_id',true) !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
     OR pg_catalog.current_setting('app.lease_generation',true) IS NULL
     OR pg_catalog.current_setting('app.lease_generation',true) !~ '^[1-9][0-9]{0,5}$'
     OR pg_catalog.current_setting('app.worker_name',true) IS DISTINCT FROM 'document_pipeline'
     OR pg_catalog.current_setting('app.worker_action',true) IS DISTINCT FROM p_action
     OR pg_catalog.current_setting('app.worker_principal_kind',true) NOT IN ('cron','session')
     OR pg_catalog.current_setting('app.correlation_id',true) IS NULL
     OR pg_catalog.current_setting('app.correlation_id',true) !~ '^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$'
  THEN
    RETURN false;
  END IF;

  -- A discovery context cannot carry member or support authority.
  IF coalesce(pg_catalog.current_setting('app.actor_id',true),'')<>''
     OR coalesce(pg_catalog.current_setting('app.membership_id',true),'')<>''
     OR coalesce(pg_catalog.current_setting('app.role',true),'')<>''
     OR coalesce(pg_catalog.current_setting('app.role_binding_id',true),'')<>''
     OR coalesce(pg_catalog.current_setting('app.support_grant_id',true),'')<>'' THEN
    RETURN false;
  END IF;

  -- Discovery may carry an optional tenant/workspace selector; when present it
  -- must be well-formed and refer to active tenant/workspace rows. The casts
  -- live in a nested IF because AND does not short-circuit: a session-local
  -- '' placeholder (left by any prior tx-local set on a pooled connection)
  -- must not reach ::uuid.
  IF coalesce(pg_catalog.current_setting('app.tenant_id',true),'')<>'' THEN
    IF pg_catalog.current_setting('app.tenant_id',true) !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
       OR coalesce(pg_catalog.current_setting('app.workspace_id',true),'')=''
       OR pg_catalog.current_setting('app.workspace_id',true) !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
    THEN
      RETURN false;
    END IF;
    IF NOT EXISTS (
      SELECT 1
      FROM public.tenants AS tenant
      JOIN public.workspaces AS workspace
        ON workspace.tenant_id=tenant.id
       AND workspace.id=pg_catalog.current_setting('app.workspace_id',true)::pg_catalog.uuid
       AND workspace.status='active'
      WHERE tenant.id=pg_catalog.current_setting('app.tenant_id',true)::pg_catalog.uuid
        AND tenant.status='active'
    ) THEN
      RETURN false;
    END IF;
  END IF;

  RETURN true;
EXCEPTION WHEN others THEN
  RETURN false;
END;
$fn$;

COMMENT ON FUNCTION public.novatrade_l03_worker_discovery(pg_catalog.text) IS
  'L-03 document-pipeline worker predicate for claim-style acquisition; tenant/workspace selector is optional and validated when present.';

-- ---------------------------------------------------------------------------
-- Scan worker claim. With p_job_id the caller asserts a specific queued job
-- (tenant/workspace GUCs must match the row); with NULL the discovery context
-- picks the oldest due job, optionally scoped by the tenant/workspace GUCs.
-- On success the job transitions to running with the issued lease facts and
-- the version enters 'scanning'.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.novatrade_claim_document_scan_job(
  p_job_id pg_catalog.text,
  p_lease_token pg_catalog.text
)
RETURNS TABLE (
  kind pg_catalog.text,
  job_id pg_catalog.uuid,
  tenant_id pg_catalog.uuid,
  workspace_id pg_catalog.uuid,
  document_id pg_catalog.uuid,
  version_id pg_catalog.uuid,
  object_key pg_catalog.text,
  checksum pg_catalog.text,
  policy_version pg_catalog.text,
  attempt pg_catalog.int4,
  max_attempts pg_catalog.int4,
  lease_generation pg_catalog.int4,
  lease_expires_at pg_catalog.timestamptz,
  version_state pg_catalog.text,
  result_state pg_catalog.text,
  result_retry_scheduled pg_catalog.bool,
  persisted_verdict pg_catalog.text,
  persisted_scanner_adapter_id pg_catalog.text,
  persisted_scanner_version pg_catalog.text,
  persisted_scanned_checksum pg_catalog.text,
  persisted_scanned_at pg_catalog.timestamptz,
  persisted_policy_version pg_catalog.text,
  persisted_reason_code pg_catalog.text,
  persisted_retryable pg_catalog.bool
)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog AS $fn$
DECLARE
  tenant_scope pg_catalog.text := NULLIF(pg_catalog.current_setting('app.tenant_id',true),'');
  workspace_scope pg_catalog.text := NULLIF(pg_catalog.current_setting('app.workspace_id',true),'');
  job_scope pg_catalog.text := NULLIF(pg_catalog.current_setting('app.job_id',true),'');
  token_hash pg_catalog.text;
  worker_hash pg_catalog.text;
  job_row record;
  now_ts pg_catalog.timestamptz := pg_catalog.statement_timestamp();
BEGIN
  IF p_lease_token IS NULL OR p_lease_token !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{31,127}$'
     OR (p_job_id IS NOT NULL AND p_job_id !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$')
  THEN
    RETURN;
  END IF;
  IF tenant_scope IS NOT NULL THEN
    -- Scoped claim: the full fenced worker context must be present and bound.
    IF NOT public.novatrade_l03_worker_authorized('document_scan:process') THEN
      RETURN;
    END IF;
    IF p_job_id IS NOT NULL AND job_scope IS DISTINCT FROM p_job_id THEN
      RETURN;
    END IF;
  ELSIF NOT public.novatrade_l03_worker_discovery('document_scan:process') THEN
    RETURN;
  END IF;

  token_hash := pg_catalog.encode(extensions.digest(p_lease_token,'sha256'),'hex');
  worker_hash := pg_catalog.encode(extensions.digest(
    'document_pipeline|document_scan:process|' || coalesce(pg_catalog.current_setting('app.run_id',true),'')
      || '|' || coalesce(pg_catalog.current_setting('app.correlation_id',true),''),
    'sha256'),'hex');

  -- Due work and dead-lease recovery sort first: a not-yet-due retry or a
  -- live lease can never starve claimable jobs behind its created_at order.
  SELECT * INTO job_row
  FROM public.document_scan_jobs AS job
  WHERE (p_job_id IS NULL OR job.id=p_job_id::pg_catalog.uuid)
    AND (tenant_scope IS NULL OR job.tenant_id=tenant_scope::pg_catalog.uuid)
    AND (workspace_scope IS NULL OR job.workspace_id=workspace_scope::pg_catalog.uuid)
    AND job.status IN ('queued','retry_wait','running','clean','infected','scanner_error')
  ORDER BY CASE
    WHEN job.status='queued'
      OR (job.status='retry_wait' AND (job.next_attempt_at IS NULL OR job.next_attempt_at<=now_ts))
      OR (job.status='running' AND job.lease_expires_at<=now_ts) THEN 0
    ELSE 1 END,
    job.created_at ASC, job.id ASC
  LIMIT 1
  FOR UPDATE OF job SKIP LOCKED;

  IF NOT FOUND THEN RETURN; END IF;

  -- Scoped claims must target the row bound to the worker context.
  IF tenant_scope IS NOT NULL
     AND (job_row.tenant_id::pg_catalog.text IS DISTINCT FROM tenant_scope
       OR job_row.workspace_id::pg_catalog.text IS DISTINCT FROM workspace_scope) THEN
    RETURN;
  END IF;

  -- Terminal jobs replay their persisted verdict; nothing is mutated.
  IF job_row.status IN ('clean','infected','scanner_error') THEN
    RETURN QUERY SELECT
      'already_persisted'::pg_catalog.text,job_row.id,job_row.tenant_id,job_row.workspace_id,
      job_row.document_id,job_row.version_id,job_row.object_key,job_row.checksum,job_row.policy_version,
      job_row.attempt_count,job_row.max_attempts,job_row.lease_generation,NULL::pg_catalog.timestamptz,
      version.status,job_row.status,
      (job_row.status='scanner_error' AND coalesce(job_row.result_retryable,false))::pg_catalog.bool,
      job_row.verdict,job_row.scanner_adapter_id,job_row.scanner_version,job_row.scanned_checksum,
      job_row.scanned_at,job_row.result_policy_version,job_row.reason_code,job_row.result_retryable
    FROM public.document_versions AS version
    WHERE version.tenant_id=job_row.tenant_id AND version.workspace_id=job_row.workspace_id
      AND version.document_id=job_row.document_id AND version.id=job_row.version_id;
    RETURN;
  END IF;

  -- A live running lease blocks a different claimant; an identical claim replays.
  IF job_row.status='running' THEN
    IF job_row.lease_expires_at>now_ts THEN
      IF job_row.lease_token_hash=token_hash THEN
        RETURN QUERY SELECT
          'leased'::pg_catalog.text,job_row.id,job_row.tenant_id,job_row.workspace_id,
          job_row.document_id,job_row.version_id,job_row.object_key,job_row.checksum,job_row.policy_version,
          job_row.attempt_count,job_row.max_attempts,job_row.lease_generation,job_row.lease_expires_at,
          'scanning'::pg_catalog.text,NULL::pg_catalog.text,NULL::pg_catalog.bool,
          NULL::pg_catalog.text,NULL::pg_catalog.text,NULL::pg_catalog.text,NULL::pg_catalog.text,
          NULL::pg_catalog.timestamptz,NULL::pg_catalog.text,NULL::pg_catalog.text,NULL::pg_catalog.bool;
      END IF;
      RETURN;
    END IF;
    -- Dead lease: recover inline so claimable jobs cannot strand behind an
    -- unenumerated expired worker. An exhausted attempt budget lands on the
    -- honest scanner_error terminal with a recovery adapter identity; nothing
    -- is fabricated as scanned-clean.
    IF job_row.attempt_count>=job_row.max_attempts THEN
      UPDATE public.document_scan_jobs AS job
      SET status='scanner_error',next_attempt_at=NULL,
        lease_token_hash=NULL,lease_worker_hash=NULL,lease_acquired_at=NULL,
        lease_heartbeat_at=NULL,lease_expires_at=NULL,
        verdict='error',scanner_adapter_id='system:lease_recovery',scanner_version='v1',
        scanned_checksum=job.checksum,scanned_at=now_ts,result_policy_version=job.policy_version,
        reason_code='scan_lease_attempts_exhausted',result_retryable=false
      WHERE job.id=job_row.id AND job.status='running';
      IF NOT FOUND THEN RETURN; END IF;
      UPDATE public.document_versions AS version
      SET status='scanner_error'
      WHERE version.tenant_id=job_row.tenant_id AND version.workspace_id=job_row.workspace_id
        AND version.document_id=job_row.document_id AND version.id=job_row.version_id
        AND version.status='scanning';
      INSERT INTO public.document_lifecycle_events(
        tenant_id,workspace_id,document_id,version_id,actor_kind,actor_membership_id,
        from_state,to_state,reason_code,correlation_id)
      VALUES (job_row.tenant_id,job_row.workspace_id,job_row.document_id,job_row.version_id,'worker',NULL,
        'scanning','scanner_error','scan_lease_attempts_exhausted',
        pg_catalog.current_setting('app.correlation_id',true));
      RETURN QUERY SELECT
        'already_persisted'::pg_catalog.text,job_row.id,job_row.tenant_id,job_row.workspace_id,
        job_row.document_id,job_row.version_id,job_row.object_key,job_row.checksum,job_row.policy_version,
        job_row.attempt_count,job_row.max_attempts,job_row.lease_generation,NULL::pg_catalog.timestamptz,
        'scanner_error'::pg_catalog.text,'scanner_error'::pg_catalog.text,
        false::pg_catalog.bool,'error'::pg_catalog.text,'system:lease_recovery'::pg_catalog.text,
        'v1'::pg_catalog.text,job_row.checksum,now_ts,job_row.policy_version,
        'scan_lease_attempts_exhausted'::pg_catalog.text,false::pg_catalog.bool;
      RETURN;
    END IF;
    -- Requeue under the fenced lease-loss shape, then fall through to the
    -- normal due acquisition below so the claim itself is self-healing.
    UPDATE public.document_scan_jobs AS job
    SET status='queued',next_attempt_at=now_ts,
      lease_token_hash=NULL,lease_worker_hash=NULL,lease_acquired_at=NULL,
      lease_heartbeat_at=NULL,lease_expires_at=NULL
    WHERE job.id=job_row.id AND job.status='running';
    IF NOT FOUND THEN RETURN; END IF;
    UPDATE public.document_versions AS version
    SET status='quarantined'
    WHERE version.tenant_id=job_row.tenant_id AND version.workspace_id=job_row.workspace_id
      AND version.document_id=job_row.document_id AND version.id=job_row.version_id
      AND version.status='scanning';
    INSERT INTO public.document_lifecycle_events(
      tenant_id,workspace_id,document_id,version_id,actor_kind,actor_membership_id,
      from_state,to_state,reason_code,correlation_id)
    VALUES (job_row.tenant_id,job_row.workspace_id,job_row.document_id,job_row.version_id,'worker',NULL,
      'scanning','quarantined','scan_lease_expired',
      pg_catalog.current_setting('app.correlation_id',true));
    job_row.status := 'queued';
    job_row.next_attempt_at := now_ts;
  END IF;

  -- queued/retry_wait: due check, then issue the next fenced generation.
  IF job_row.next_attempt_at IS NOT NULL AND job_row.next_attempt_at>now_ts THEN
    RETURN;
  END IF;
  IF job_row.attempt_count>=job_row.max_attempts THEN
    RETURN;
  END IF;

  UPDATE public.document_versions AS version
  SET status='scanning'
  WHERE version.tenant_id=job_row.tenant_id AND version.workspace_id=job_row.workspace_id
    AND version.document_id=job_row.document_id AND version.id=job_row.version_id
    AND version.status='quarantined' AND version.checksum=job_row.checksum;
  IF NOT FOUND THEN
    -- A version that is not quarantined cannot be scanned; leave the job queued
    -- for an operator-visible reconciliation rather than fabricating a lease.
    RETURN;
  END IF;

  UPDATE public.document_scan_jobs AS job
  SET status='running',attempt_count=job.attempt_count+1,lease_generation=job.lease_generation+1,
    lease_token_hash=token_hash,lease_worker_hash=worker_hash,
    lease_acquired_at=now_ts,lease_heartbeat_at=now_ts,
    lease_expires_at=now_ts+interval '10 minutes',next_attempt_at=NULL
  WHERE job.id=job_row.id AND job.status IN ('queued','retry_wait');

  RETURN QUERY SELECT
    'leased'::pg_catalog.text,job_row.id,job_row.tenant_id,job_row.workspace_id,
    job_row.document_id,job_row.version_id,job_row.object_key,job_row.checksum,job_row.policy_version,
    job_row.attempt_count+1,job_row.max_attempts,job_row.lease_generation+1,
    now_ts+interval '10 minutes','scanning'::pg_catalog.text,NULL::pg_catalog.text,NULL::pg_catalog.bool,
    NULL::pg_catalog.text,NULL::pg_catalog.text,NULL::pg_catalog.text,NULL::pg_catalog.text,
    NULL::pg_catalog.timestamptz,NULL::pg_catalog.text,NULL::pg_catalog.text,NULL::pg_catalog.bool;

  INSERT INTO public.document_lifecycle_events(
    tenant_id,workspace_id,document_id,version_id,actor_kind,actor_membership_id,
    from_state,to_state,reason_code,correlation_id)
  VALUES (job_row.tenant_id,job_row.workspace_id,job_row.document_id,job_row.version_id,'worker',NULL,
    'quarantined','scanning','scan_lease_acquired',
    pg_catalog.current_setting('app.correlation_id',true));
EXCEPTION
  WHEN unique_violation OR check_violation OR foreign_key_violation OR raise_exception THEN
    RETURN;
END;
$fn$;

COMMENT ON FUNCTION public.novatrade_claim_document_scan_job(pg_catalog.text,pg_catalog.text) IS
  'L-03 fenced scan lease acquisition; only token digests are persisted and a terminal job replays its verdict.';

-- ---------------------------------------------------------------------------
-- Scan result persistence. The live lease facts fence the write: the job must
-- be running under this exact generation and token digest, and the version
-- must still be 'scanning'. Retryable errors requeue through retry_wait with
-- a bounded backoff; terminal verdicts move the version.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.novatrade_persist_document_scan_result(
  p_job_id pg_catalog.text,
  p_lease_token pg_catalog.text,
  p_state pg_catalog.text,
  p_scanner_adapter_id pg_catalog.text,
  p_scanner_version pg_catalog.text,
  p_scanned_checksum pg_catalog.text,
  p_scanned_at pg_catalog.text,
  p_result_policy_version pg_catalog.text,
  p_reason_code pg_catalog.text,
  p_retryable pg_catalog.bool
)
RETURNS TABLE (
  kind pg_catalog.text,
  job_id pg_catalog.uuid,
  state pg_catalog.text,
  retry_scheduled pg_catalog.bool
)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog AS $fn$
DECLARE
  tenant_scope pg_catalog.text := NULLIF(pg_catalog.current_setting('app.tenant_id',true),'');
  workspace_scope pg_catalog.text := NULLIF(pg_catalog.current_setting('app.workspace_id',true),'');
  job_scope pg_catalog.text := NULLIF(pg_catalog.current_setting('app.job_id',true),'');
  generation_scope pg_catalog.text := NULLIF(pg_catalog.current_setting('app.lease_generation',true),'');
  token_hash pg_catalog.text;
  result_verdict pg_catalog.text;
  job_row record;
  now_ts pg_catalog.timestamptz := pg_catalog.statement_timestamp();
  scanned_ts pg_catalog.timestamptz;
  retry_next pg_catalog.timestamptz;
BEGIN
  IF p_job_id IS NULL OR p_job_id !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
     OR p_lease_token IS NULL OR p_lease_token !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{31,127}$'
     OR p_state IS NULL OR p_state NOT IN ('clean','infected','scanner_error')
     OR p_scanner_adapter_id IS NULL OR pg_catalog.char_length(p_scanner_adapter_id) NOT BETWEEN 1 AND 128
     OR p_scanner_version IS NULL OR pg_catalog.char_length(p_scanner_version) NOT BETWEEN 1 AND 64
     OR p_scanned_checksum IS NULL OR p_scanned_checksum !~ '^[0-9a-f]{64}$'
     OR p_scanned_at IS NULL OR p_scanned_at !~ '^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,6})?(Z|[+-]\d{2}:\d{2})$'
     OR p_result_policy_version IS NULL OR p_result_policy_version !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'
     OR (p_reason_code IS NOT NULL AND (pg_catalog.char_length(p_reason_code) NOT BETWEEN 1 AND 128
        OR p_reason_code<>pg_catalog.btrim(p_reason_code) OR p_reason_code ~ '[[:cntrl:]]'))
     OR p_retryable IS NULL
  THEN
    RETURN;
  END IF;
  IF NOT public.novatrade_l03_worker_authorized('document_scan:process') THEN
    RETURN;
  END IF;
  IF job_scope IS DISTINCT FROM p_job_id THEN
    RETURN;
  END IF;

  BEGIN
    scanned_ts := p_scanned_at::pg_catalog.timestamptz;
  EXCEPTION WHEN others THEN
    RETURN;
  END;
  IF scanned_ts>now_ts+interval '5 minutes' THEN RETURN; END IF;

  token_hash := pg_catalog.encode(extensions.digest(p_lease_token,'sha256'),'hex');
  result_verdict := CASE p_state WHEN 'clean' THEN 'clean' WHEN 'infected' THEN 'infected' ELSE 'error' END;

  SELECT * INTO job_row
  FROM public.document_scan_jobs AS job
  WHERE job.id=p_job_id::pg_catalog.uuid
  FOR UPDATE;

  IF NOT FOUND
     OR job_row.tenant_id::pg_catalog.text IS DISTINCT FROM tenant_scope
     OR job_row.workspace_id::pg_catalog.text IS DISTINCT FROM workspace_scope
     OR job_row.checksum IS DISTINCT FROM p_scanned_checksum
     OR job_row.policy_version IS DISTINCT FROM p_result_policy_version THEN
    RETURN;
  END IF;

  -- Terminal replay: return the recorded disposition without mutation.
  IF job_row.status IN ('clean','infected','scanner_error') THEN
    RETURN QUERY SELECT 'already_persisted'::pg_catalog.text,job_row.id,job_row.status,
      false::pg_catalog.bool;
    RETURN;
  END IF;

  -- Lease fence: live generation and token digest must match exactly.
  IF job_row.status<>'running' OR job_row.lease_expires_at<=now_ts
     OR job_row.lease_token_hash IS DISTINCT FROM token_hash
     OR job_row.lease_generation::pg_catalog.text IS DISTINCT FROM generation_scope THEN
    RETURN;
  END IF;

  -- The version must still hold the scanning lease state.
  IF NOT EXISTS (
    SELECT 1 FROM public.document_versions AS version
    WHERE version.tenant_id=job_row.tenant_id AND version.workspace_id=job_row.workspace_id
      AND version.document_id=job_row.document_id AND version.id=job_row.version_id
      AND version.status='scanning' AND version.checksum=job_row.checksum
  ) THEN
    RETURN;
  END IF;

  IF result_verdict='error' AND p_retryable AND job_row.attempt_count<job_row.max_attempts THEN
    retry_next := now_ts + (interval '30 seconds' * job_row.attempt_count);
    UPDATE public.document_scan_jobs AS job
    SET status='retry_wait',next_attempt_at=retry_next,
      lease_token_hash=NULL,lease_worker_hash=NULL,lease_acquired_at=NULL,
      lease_heartbeat_at=NULL,lease_expires_at=NULL,
      verdict='error',scanner_adapter_id=p_scanner_adapter_id,scanner_version=p_scanner_version,
      scanned_checksum=p_scanned_checksum,scanned_at=scanned_ts,result_policy_version=p_result_policy_version,
      reason_code=p_reason_code,result_retryable=true
    WHERE job.id=job_row.id AND job.status='running';

    UPDATE public.document_versions AS version
    SET status='quarantined'
    WHERE version.tenant_id=job_row.tenant_id AND version.workspace_id=job_row.workspace_id
      AND version.document_id=job_row.document_id AND version.id=job_row.version_id
      AND version.status='scanning';

    INSERT INTO public.document_lifecycle_events(
      tenant_id,workspace_id,document_id,version_id,actor_kind,actor_membership_id,
      from_state,to_state,reason_code,correlation_id)
    VALUES (job_row.tenant_id,job_row.workspace_id,job_row.document_id,job_row.version_id,'worker',NULL,
      'scanning','quarantined',coalesce(p_reason_code,'scanner_retry_scheduled'),
      pg_catalog.current_setting('app.correlation_id',true));

    RETURN QUERY SELECT 'persisted'::pg_catalog.text,job_row.id,'scanner_error'::pg_catalog.text,true::pg_catalog.bool;
    RETURN;
  END IF;

  UPDATE public.document_scan_jobs AS job
  SET status=p_state,next_attempt_at=NULL,
    lease_token_hash=NULL,lease_worker_hash=NULL,lease_acquired_at=NULL,
    lease_heartbeat_at=NULL,lease_expires_at=NULL,
    verdict=result_verdict,scanner_adapter_id=p_scanner_adapter_id,scanner_version=p_scanner_version,
    scanned_checksum=p_scanned_checksum,scanned_at=scanned_ts,result_policy_version=p_result_policy_version,
    reason_code=p_reason_code,result_retryable=coalesce(p_retryable,false)
  WHERE job.id=job_row.id AND job.status='running';

  UPDATE public.document_versions AS version
  SET status=p_state
  WHERE version.tenant_id=job_row.tenant_id AND version.workspace_id=job_row.workspace_id
    AND version.document_id=job_row.document_id AND version.id=job_row.version_id
    AND version.status='scanning';

  INSERT INTO public.document_lifecycle_events(
    tenant_id,workspace_id,document_id,version_id,actor_kind,actor_membership_id,
    from_state,to_state,reason_code,correlation_id)
  VALUES (job_row.tenant_id,job_row.workspace_id,job_row.document_id,job_row.version_id,'worker',NULL,
    'scanning',p_state,CASE p_state
      WHEN 'clean' THEN 'scan_clean'
      WHEN 'infected' THEN 'scan_infected'
      ELSE coalesce(p_reason_code,'scanner_error') END,
    pg_catalog.current_setting('app.correlation_id',true));

  RETURN QUERY SELECT 'persisted'::pg_catalog.text,job_row.id,p_state,false::pg_catalog.bool;
EXCEPTION
  WHEN unique_violation OR check_violation OR foreign_key_violation OR raise_exception THEN
    RETURN;
END;
$fn$;

COMMENT ON FUNCTION public.novatrade_persist_document_scan_result(
  pg_catalog.text,pg_catalog.text,pg_catalog.text,pg_catalog.text,pg_catalog.text,
  pg_catalog.text,pg_catalog.text,pg_catalog.text,pg_catalog.text,pg_catalog.bool) IS
  'L-03 fenced scan verdict persistence bound to the live lease token digest and generation.';

-- ---------------------------------------------------------------------------
-- Scan lease-loss recovery. Only an expired running lease may be requeued; the
-- attempt identity is preserved and every lease fact is cleared.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.novatrade_recover_document_scan_lease(
  p_job_id pg_catalog.text
)
RETURNS TABLE (kind pg_catalog.text, job_id pg_catalog.uuid, state pg_catalog.text)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog AS $fn$
DECLARE
  tenant_scope pg_catalog.text := NULLIF(pg_catalog.current_setting('app.tenant_id',true),'');
  workspace_scope pg_catalog.text := NULLIF(pg_catalog.current_setting('app.workspace_id',true),'');
  job_scope pg_catalog.text := NULLIF(pg_catalog.current_setting('app.job_id',true),'');
  job_row record;
  now_ts pg_catalog.timestamptz := pg_catalog.statement_timestamp();
BEGIN
  IF p_job_id IS NULL OR p_job_id !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$' THEN
    RETURN;
  END IF;
  IF NOT public.novatrade_l03_worker_authorized('document_scan:recover') THEN
    RETURN;
  END IF;
  IF job_scope IS DISTINCT FROM p_job_id THEN
    RETURN;
  END IF;

  SELECT * INTO job_row FROM public.document_scan_jobs AS job
  WHERE job.id=p_job_id::pg_catalog.uuid
  FOR UPDATE;
  IF NOT FOUND
     OR job_row.tenant_id::pg_catalog.text IS DISTINCT FROM tenant_scope
     OR job_row.workspace_id::pg_catalog.text IS DISTINCT FROM workspace_scope
     OR job_row.status<>'running' OR job_row.lease_expires_at>now_ts THEN
    RETURN;
  END IF;

  -- An exhausted attempt budget cannot requeue; the honest terminal is
  -- scanner_error under the recovery adapter identity, never a clean verdict.
  IF job_row.attempt_count>=job_row.max_attempts THEN
    UPDATE public.document_scan_jobs AS job
    SET status='scanner_error',next_attempt_at=NULL,
      lease_token_hash=NULL,lease_worker_hash=NULL,lease_acquired_at=NULL,
      lease_heartbeat_at=NULL,lease_expires_at=NULL,
      verdict='error',scanner_adapter_id='system:lease_recovery',scanner_version='v1',
      scanned_checksum=job.checksum,scanned_at=now_ts,result_policy_version=job.policy_version,
      reason_code='scan_lease_attempts_exhausted',result_retryable=false
    WHERE job.id=job_row.id AND job.status='running';
    IF NOT FOUND THEN RETURN; END IF;
    UPDATE public.document_versions AS version
    SET status='scanner_error'
    WHERE version.tenant_id=job_row.tenant_id AND version.workspace_id=job_row.workspace_id
      AND version.document_id=job_row.document_id AND version.id=job_row.version_id
      AND version.status='scanning';
    INSERT INTO public.document_lifecycle_events(
      tenant_id,workspace_id,document_id,version_id,actor_kind,actor_membership_id,
      from_state,to_state,reason_code,correlation_id)
    VALUES (job_row.tenant_id,job_row.workspace_id,job_row.document_id,job_row.version_id,'worker',NULL,
      'scanning','scanner_error','scan_lease_attempts_exhausted',
      pg_catalog.current_setting('app.correlation_id',true));
    RETURN QUERY SELECT 'terminated'::pg_catalog.text,job_row.id,'scanner_error'::pg_catalog.text;
    RETURN;
  END IF;

  UPDATE public.document_scan_jobs AS job
  SET status='queued',next_attempt_at=now_ts+interval '30 seconds',
    lease_token_hash=NULL,lease_worker_hash=NULL,lease_acquired_at=NULL,
    lease_heartbeat_at=NULL,lease_expires_at=NULL
  WHERE job.id=job_row.id AND job.status='running';
  IF NOT FOUND THEN RETURN; END IF;

  -- The version lease state returns to quarantined for the next attempt.
  UPDATE public.document_versions AS version
  SET status='quarantined'
  WHERE version.tenant_id=job_row.tenant_id AND version.workspace_id=job_row.workspace_id
    AND version.document_id=job_row.document_id AND version.id=job_row.version_id
    AND version.status='scanning';

  INSERT INTO public.document_lifecycle_events(
    tenant_id,workspace_id,document_id,version_id,actor_kind,actor_membership_id,
    from_state,to_state,reason_code,correlation_id)
  VALUES (job_row.tenant_id,job_row.workspace_id,job_row.document_id,job_row.version_id,'worker',NULL,
    'scanning','quarantined','scan_lease_expired',
    pg_catalog.current_setting('app.correlation_id',true));

  RETURN QUERY SELECT 'requeued'::pg_catalog.text,job_row.id,'queued'::pg_catalog.text;
EXCEPTION
  WHEN unique_violation OR check_violation OR foreign_key_violation OR raise_exception THEN
    RETURN;
END;
$fn$;

COMMENT ON FUNCTION public.novatrade_recover_document_scan_lease(pg_catalog.text) IS
  'L-03 fenced scan lease-loss requeue; only an expired running lease recovers and no verdict is fabricated.';

-- ---------------------------------------------------------------------------
-- Member extraction request. A clean (or previously extraction_failed)
-- version gains a queued job bound to the canonical finalization and clean
-- scan facts; the guard trigger enforces the binding.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.novatrade_request_document_extraction(
  p_tenant_id pg_catalog.text,
  p_workspace_id pg_catalog.text,
  p_document_id pg_catalog.text,
  p_version_id pg_catalog.text,
  p_job_id pg_catalog.text,
  p_idempotency_key pg_catalog.text,
  p_parser_id pg_catalog.text,
  p_parser_version pg_catalog.text,
  p_input_hash pg_catalog.text
)
RETURNS TABLE (
  kind pg_catalog.text,
  job_id pg_catalog.uuid,
  version_id pg_catalog.uuid,
  state pg_catalog.text
)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog AS $fn$
DECLARE
  tenant_uuid pg_catalog.uuid;
  workspace_uuid pg_catalog.uuid;
  document_uuid pg_catalog.uuid;
  version_uuid pg_catalog.uuid;
  job_uuid pg_catalog.uuid;
  finalization_id pg_catalog.int8;
  scan_uuid pg_catalog.uuid;
  version_row record;
  replay_row record;
BEGIN
  IF p_tenant_id IS NULL OR p_tenant_id !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
     OR p_workspace_id IS NULL OR p_workspace_id !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
     OR p_document_id IS NULL OR p_document_id !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
     OR p_version_id IS NULL OR p_version_id !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
     OR p_job_id IS NULL OR p_job_id !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
     OR p_idempotency_key IS NULL OR p_idempotency_key !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{7,159}$'
     OR p_parser_id IS NULL OR p_parser_id !~ '^[a-z0-9][a-z0-9._-]{0,127}$'
     OR p_parser_version IS NULL OR p_parser_version !~ '^[a-z0-9][a-z0-9._+-]{0,63}$'
     OR p_input_hash IS NULL OR p_input_hash !~ '^[0-9a-f]{64}$'
  THEN
    RETURN;
  END IF;
  IF NULLIF(pg_catalog.current_setting('app.tenant_id',true),'') IS DISTINCT FROM p_tenant_id
     OR NULLIF(pg_catalog.current_setting('app.workspace_id',true),'') IS DISTINCT FROM p_workspace_id THEN
    RETURN;
  END IF;
  -- knowledge:manage is object-state conditional in D-002; the clean canonical
  -- scan/finalization binding below is the durable condition this boundary
  -- enforces. Reviewer is denied outright by the matrix.
  IF NOT public.novatrade_l03_member_lock(ARRAY['owner','admin','strategist_manager','researcher']) THEN
    RETURN;
  END IF;

  tenant_uuid := p_tenant_id::pg_catalog.uuid;
  workspace_uuid := p_workspace_id::pg_catalog.uuid;
  document_uuid := p_document_id::pg_catalog.uuid;
  version_uuid := p_version_id::pg_catalog.uuid;
  job_uuid := p_job_id::pg_catalog.uuid;

  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(
    'l03-extraction:' || tenant_uuid::pg_catalog.text || ':' || p_idempotency_key, 0
  ));

  -- Exact replay returns the recorded job; a binding mismatch is a conflict.
  SELECT job.id,job.version_id,job.status INTO replay_row
  FROM public.document_extraction_jobs AS job
  WHERE job.tenant_id=tenant_uuid AND job.workspace_id=workspace_uuid
    AND job.idempotency_key=p_idempotency_key;
  IF FOUND THEN
    IF replay_row.id=job_uuid
       AND EXISTS (
         SELECT 1 FROM public.document_extraction_jobs AS bound
         WHERE bound.tenant_id=tenant_uuid AND bound.workspace_id=workspace_uuid
           AND bound.id=replay_row.id AND bound.document_id=document_uuid
           AND bound.version_id=version_uuid AND bound.parser_id=p_parser_id
           AND bound.parser_version=p_parser_version AND bound.input_hash=p_input_hash
       ) THEN
      RETURN QUERY SELECT 'replay'::pg_catalog.text,replay_row.id,replay_row.version_id,replay_row.status;
    ELSE
      RETURN QUERY SELECT 'conflict'::pg_catalog.text,NULL::pg_catalog.uuid,NULL::pg_catalog.uuid,NULL::pg_catalog.text;
    END IF;
    RETURN;
  END IF;

  SELECT * INTO version_row
  FROM public.document_versions AS version
  WHERE version.tenant_id=tenant_uuid AND version.workspace_id=workspace_uuid
    AND version.document_id=document_uuid AND version.id=version_uuid;
  IF NOT FOUND OR version_row.status NOT IN ('clean','extraction_failed')
     OR version_row.checksum IS NULL THEN
    RETURN;
  END IF;

  SELECT f.id,s.id INTO finalization_id,scan_uuid
  FROM public.document_version_finalizations AS f
  JOIN public.document_scan_jobs AS s
    ON s.tenant_id=f.tenant_id AND s.workspace_id=f.workspace_id
   AND s.document_id=f.document_id AND s.version_id=f.processing_version_id
   AND s.checksum=f.checksum AND s.policy_version=f.scanner_policy_version
   AND s.status='clean' AND s.verdict='clean' AND s.scanned_checksum=f.checksum
  WHERE f.tenant_id=tenant_uuid AND f.workspace_id=workspace_uuid
    AND f.document_id=document_uuid AND f.version_id=version_uuid
    AND f.dedupe_decision='canonical' AND f.checksum=version_row.checksum
    AND f.scanner_policy_version=version_row.scanner_policy_version;
  IF finalization_id IS NULL OR scan_uuid IS NULL THEN
    RETURN;
  END IF;

  INSERT INTO public.document_extraction_jobs(
    id,tenant_id,workspace_id,document_id,version_id,canonical_finalization_id,scan_job_id,
    checksum,scanner_policy_version,parser_id,parser_version,idempotency_key,input_hash,max_attempts)
  VALUES (job_uuid,tenant_uuid,workspace_uuid,document_uuid,version_uuid,finalization_id,scan_uuid,
    version_row.checksum,version_row.scanner_policy_version,p_parser_id,p_parser_version,
    p_idempotency_key,p_input_hash,3);

  INSERT INTO public.document_lifecycle_events(
    tenant_id,workspace_id,document_id,version_id,actor_kind,actor_membership_id,
    from_state,to_state,reason_code,correlation_id)
  VALUES (tenant_uuid,workspace_uuid,document_uuid,version_uuid,'member',
    pg_catalog.current_setting('app.membership_id',true)::pg_catalog.uuid,
    version_row.status,version_row.status,'extraction_requested',
    pg_catalog.current_setting('app.correlation_id',true));

  RETURN QUERY SELECT 'queued'::pg_catalog.text,job_uuid,version_uuid,'queued'::pg_catalog.text;
EXCEPTION
  WHEN unique_violation OR check_violation OR foreign_key_violation OR raise_exception THEN
    RETURN;
END;
$fn$;

COMMENT ON FUNCTION public.novatrade_request_document_extraction(
  pg_catalog.text,pg_catalog.text,pg_catalog.text,pg_catalog.text,pg_catalog.text,pg_catalog.text,
  pg_catalog.text,pg_catalog.text,pg_catalog.text) IS
  'L-03 member extraction request; the job is bound to canonical finalization and clean scan facts.';

-- ---------------------------------------------------------------------------
-- Member extraction cancel. A queued job cancels immediately; a running job
-- records the immutable cancel request and the worker finalizes it through
-- the fenced cancel path.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.novatrade_cancel_document_extraction(
  p_tenant_id pg_catalog.text,
  p_workspace_id pg_catalog.text,
  p_job_id pg_catalog.text
)
RETURNS TABLE (kind pg_catalog.text, job_id pg_catalog.uuid, state pg_catalog.text)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog AS $fn$
DECLARE
  job_row record;
  version_state pg_catalog.text;
  now_ts pg_catalog.timestamptz := pg_catalog.statement_timestamp();
BEGIN
  IF p_tenant_id IS NULL OR p_tenant_id !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
     OR p_workspace_id IS NULL OR p_workspace_id !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
     OR p_job_id IS NULL OR p_job_id !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
  THEN
    RETURN;
  END IF;
  IF NULLIF(pg_catalog.current_setting('app.tenant_id',true),'') IS DISTINCT FROM p_tenant_id
     OR NULLIF(pg_catalog.current_setting('app.workspace_id',true),'') IS DISTINCT FROM p_workspace_id THEN
    RETURN;
  END IF;
  -- knowledge:manage is object-state conditional in D-002; the version scan
  -- state binding below is the durable condition this boundary enforces.
  IF NOT public.novatrade_l03_member_lock(ARRAY['owner','admin','strategist_manager','researcher']) THEN
    RETURN;
  END IF;

  SELECT * INTO job_row FROM public.document_extraction_jobs AS job
  WHERE job.tenant_id=p_tenant_id::pg_catalog.uuid AND job.workspace_id=p_workspace_id::pg_catalog.uuid
    AND job.id=p_job_id::pg_catalog.uuid
  FOR UPDATE;
  IF NOT FOUND THEN RETURN; END IF;

  IF job_row.status IN ('complete','review_required','error','canceled') THEN
    RETURN QUERY SELECT 'terminal'::pg_catalog.text,job_row.id,job_row.status;
    RETURN;
  END IF;

  IF job_row.status='queued' THEN
    UPDATE public.document_extraction_jobs AS job
    SET status='canceled',cancel_requested_at=now_ts,canceled_at=now_ts,event_at=now_ts
    WHERE job.id=job_row.id AND job.status='queued';
  ELSIF job_row.status='retry_wait' THEN
    -- Cancel a parked retry: reuse the recorded result lease identity.
    UPDATE public.document_extraction_jobs AS job
    SET status='canceled',cancel_requested_at=now_ts,canceled_at=now_ts,event_at=now_ts,
      next_attempt_at=NULL
    WHERE job.id=job_row.id AND job.status='retry_wait';
  ELSE
    UPDATE public.document_extraction_jobs AS job
    SET cancel_requested_at=now_ts
    WHERE job.id=job_row.id AND job.status='running' AND job.cancel_requested_at IS NULL;
    IF NOT FOUND THEN RETURN; END IF;
    RETURN QUERY SELECT 'cancel_requested'::pg_catalog.text,job_row.id,job_row.status;
    RETURN;
  END IF;
  IF NOT FOUND THEN RETURN; END IF;

  SELECT version.status INTO version_state
  FROM public.document_versions AS version
  WHERE version.tenant_id=job_row.tenant_id AND version.workspace_id=job_row.workspace_id
    AND version.document_id=job_row.document_id AND version.id=job_row.version_id;
  IF version_state IS NULL THEN RETURN; END IF;

  -- A queued job never moved the version; a parked retry holds 'extracting'
  -- and must restore the trusted-clean source state on cancel.
  UPDATE public.document_versions AS version
  SET status='clean'
  WHERE version.tenant_id=job_row.tenant_id AND version.workspace_id=job_row.workspace_id
    AND version.document_id=job_row.document_id AND version.id=job_row.version_id
    AND version.status='extracting';

  INSERT INTO public.document_lifecycle_events(
    tenant_id,workspace_id,document_id,version_id,actor_kind,actor_membership_id,
    from_state,to_state,reason_code,correlation_id)
  VALUES (job_row.tenant_id,job_row.workspace_id,job_row.document_id,job_row.version_id,'member',
    pg_catalog.current_setting('app.membership_id',true)::pg_catalog.uuid,
    version_state,CASE WHEN version_state='extracting' THEN 'clean' ELSE version_state END,
    'extraction_canceled',
    pg_catalog.current_setting('app.correlation_id',true));

  RETURN QUERY SELECT 'canceled'::pg_catalog.text,job_row.id,'canceled'::pg_catalog.text;
EXCEPTION
  WHEN unique_violation OR check_violation OR foreign_key_violation OR raise_exception THEN
    RETURN;
END;
$fn$;

COMMENT ON FUNCTION public.novatrade_cancel_document_extraction(pg_catalog.text,pg_catalog.text,pg_catalog.text) IS
  'L-03 member extraction cancel; running jobs cancel through the fenced worker path.';

-- ---------------------------------------------------------------------------
-- Extraction worker claim. Mirrors the scan claim: scoped by p_job_id under
-- the full worker predicate, or discovery picks the oldest due job. A queued
-- acquisition moves the version clean->extracting; a retry_wait re-acquisition
-- keeps the already-extracting version state.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.novatrade_claim_document_extraction_job(
  p_job_id pg_catalog.text,
  p_lease_token pg_catalog.text
)
RETURNS TABLE (
  kind pg_catalog.text,
  job_id pg_catalog.uuid,
  tenant_id pg_catalog.uuid,
  workspace_id pg_catalog.uuid,
  document_id pg_catalog.uuid,
  version_id pg_catalog.uuid,
  object_key pg_catalog.text,
  checksum pg_catalog.text,
  scanner_policy_version pg_catalog.text,
  parser_id pg_catalog.text,
  parser_version pg_catalog.text,
  input_hash pg_catalog.text,
  attempt pg_catalog.int4,
  max_attempts pg_catalog.int4,
  lease_generation pg_catalog.int4,
  lease_expires_at pg_catalog.timestamptz,
  cancel_requested pg_catalog.bool,
  version_state pg_catalog.text,
  result_state pg_catalog.text
)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog AS $fn$
DECLARE
  tenant_scope pg_catalog.text := NULLIF(pg_catalog.current_setting('app.tenant_id',true),'');
  workspace_scope pg_catalog.text := NULLIF(pg_catalog.current_setting('app.workspace_id',true),'');
  job_scope pg_catalog.text := NULLIF(pg_catalog.current_setting('app.job_id',true),'');
  token_hash pg_catalog.text;
  worker_hash pg_catalog.text;
  job_row record;
  version_row record;
  now_ts pg_catalog.timestamptz := pg_catalog.statement_timestamp();
BEGIN
  IF p_lease_token IS NULL OR p_lease_token !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{31,127}$'
     OR (p_job_id IS NOT NULL AND p_job_id !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$')
  THEN
    RETURN;
  END IF;
  IF tenant_scope IS NOT NULL THEN
    IF NOT public.novatrade_l03_worker_authorized('document_extraction:process') THEN
      RETURN;
    END IF;
    IF p_job_id IS NOT NULL AND job_scope IS DISTINCT FROM p_job_id THEN
      RETURN;
    END IF;
  ELSIF NOT public.novatrade_l03_worker_discovery('document_extraction:process') THEN
    RETURN;
  END IF;

  token_hash := pg_catalog.encode(extensions.digest(p_lease_token,'sha256'),'hex');
  worker_hash := pg_catalog.encode(extensions.digest(
    'document_pipeline|document_extraction:process|' || coalesce(pg_catalog.current_setting('app.run_id',true),'')
      || '|' || coalesce(pg_catalog.current_setting('app.correlation_id',true),''),
    'sha256'),'hex');

  -- Due work and dead-lease recovery sort first: a not-yet-due retry or a
  -- live lease can never starve claimable jobs behind its created_at order.
  SELECT * INTO job_row
  FROM public.document_extraction_jobs AS job
  WHERE (p_job_id IS NULL OR job.id=p_job_id::pg_catalog.uuid)
    AND (tenant_scope IS NULL OR job.tenant_id=tenant_scope::pg_catalog.uuid)
    AND (workspace_scope IS NULL OR job.workspace_id=workspace_scope::pg_catalog.uuid)
  ORDER BY CASE
    WHEN job.status='queued'
      OR (job.status='retry_wait' AND (job.next_attempt_at IS NULL OR job.next_attempt_at<=now_ts))
      OR (job.status='running' AND job.lease_expires_at<=now_ts) THEN 0
    ELSE 1 END,
    job.created_at ASC, job.id ASC
  LIMIT 1
  FOR UPDATE OF job SKIP LOCKED;

  IF NOT FOUND THEN RETURN; END IF;

  IF tenant_scope IS NOT NULL
     AND (job_row.tenant_id::pg_catalog.text IS DISTINCT FROM tenant_scope
       OR job_row.workspace_id::pg_catalog.text IS DISTINCT FROM workspace_scope) THEN
    RETURN;
  END IF;

  SELECT * INTO version_row FROM public.document_versions AS version
  WHERE version.tenant_id=job_row.tenant_id AND version.workspace_id=job_row.workspace_id
    AND version.document_id=job_row.document_id AND version.id=job_row.version_id
  FOR UPDATE;
  IF NOT FOUND THEN RETURN; END IF;

  IF job_row.status IN ('complete','review_required','error','canceled') THEN
    RETURN QUERY SELECT
      'already_persisted'::pg_catalog.text,job_row.id,job_row.tenant_id,job_row.workspace_id,
      job_row.document_id,job_row.version_id,version_row.object_key,job_row.checksum,
      job_row.scanner_policy_version,job_row.parser_id,job_row.parser_version,job_row.input_hash,
      job_row.attempt_count,job_row.max_attempts,job_row.lease_generation,NULL::pg_catalog.timestamptz,
      false::pg_catalog.bool,version_row.status,job_row.status;
    RETURN;
  END IF;

  IF job_row.status='running' THEN
    IF job_row.lease_expires_at>now_ts THEN
      IF job_row.lease_token_hash=token_hash THEN
        RETURN QUERY SELECT
          'leased'::pg_catalog.text,job_row.id,job_row.tenant_id,job_row.workspace_id,
          job_row.document_id,job_row.version_id,version_row.object_key,job_row.checksum,
          job_row.scanner_policy_version,job_row.parser_id,job_row.parser_version,job_row.input_hash,
          job_row.attempt_count,job_row.max_attempts,job_row.lease_generation,job_row.lease_expires_at,
          job_row.cancel_requested_at IS NOT NULL,version_row.status,NULL::pg_catalog.text;
      END IF;
      RETURN;
    END IF;
    -- Dead lease: recover inline so claimable jobs cannot strand behind an
    -- unenumerated expired worker. Every dead-lease outcome carries the expired
    -- lease identity as its result fence.
    IF job_row.cancel_requested_at IS NOT NULL THEN
      UPDATE public.document_extraction_jobs AS job
      SET status='canceled',canceled_at=now_ts,event_at=now_ts,next_attempt_at=NULL,
        result_lease_generation=job.lease_generation,result_lease_token_hash=job.lease_token_hash,
        lease_token_hash=NULL,lease_worker_hash=NULL,lease_acquired_at=NULL,
        lease_heartbeat_at=NULL,lease_expires_at=NULL
      WHERE job.id=job_row.id AND job.status='running';
      IF NOT FOUND THEN RETURN; END IF;
      UPDATE public.document_versions AS version
      SET status='clean'
      WHERE version.tenant_id=job_row.tenant_id AND version.workspace_id=job_row.workspace_id
        AND version.document_id=job_row.document_id AND version.id=job_row.version_id
        AND version.status='extracting';
      INSERT INTO public.document_lifecycle_events(
        tenant_id,workspace_id,document_id,version_id,actor_kind,actor_membership_id,
        from_state,to_state,reason_code,correlation_id)
      VALUES (job_row.tenant_id,job_row.workspace_id,job_row.document_id,job_row.version_id,'worker',NULL,
        version_row.status,'clean','extraction_canceled',
        pg_catalog.current_setting('app.correlation_id',true));
      RETURN QUERY SELECT
        'already_persisted'::pg_catalog.text,job_row.id,job_row.tenant_id,job_row.workspace_id,
        job_row.document_id,job_row.version_id,version_row.object_key,job_row.checksum,
        job_row.scanner_policy_version,job_row.parser_id,job_row.parser_version,job_row.input_hash,
        job_row.attempt_count,job_row.max_attempts,job_row.lease_generation,NULL::pg_catalog.timestamptz,
        true::pg_catalog.bool,'clean'::pg_catalog.text,'canceled'::pg_catalog.text;
      RETURN;
    END IF;
    IF job_row.attempt_count>=job_row.max_attempts THEN
      UPDATE public.document_extraction_jobs AS job
      SET status='error',next_attempt_at=NULL,
        result_lease_generation=job.lease_generation,result_lease_token_hash=job.lease_token_hash,
        lease_token_hash=NULL,lease_worker_hash=NULL,lease_acquired_at=NULL,
        lease_heartbeat_at=NULL,lease_expires_at=NULL,
        event_at=now_ts,error_code='lease_expired',result_retryable=false,
        error_fingerprint=pg_catalog.encode(extensions.digest(
          'lease_expired|' || job.id::pg_catalog.text || '|' || job.lease_generation::pg_catalog.text,
          'sha256'),'hex')
      WHERE job.id=job_row.id AND job.status='running';
      IF NOT FOUND THEN RETURN; END IF;
      UPDATE public.document_versions AS version
      SET status='extraction_failed'
      WHERE version.tenant_id=job_row.tenant_id AND version.workspace_id=job_row.workspace_id
        AND version.document_id=job_row.document_id AND version.id=job_row.version_id
        AND version.status='extracting';
      INSERT INTO public.document_lifecycle_events(
        tenant_id,workspace_id,document_id,version_id,actor_kind,actor_membership_id,
        from_state,to_state,reason_code,correlation_id)
      VALUES (job_row.tenant_id,job_row.workspace_id,job_row.document_id,job_row.version_id,'worker',NULL,
        version_row.status,'extraction_failed','lease_expired',
        pg_catalog.current_setting('app.correlation_id',true));
      RETURN QUERY SELECT
        'already_persisted'::pg_catalog.text,job_row.id,job_row.tenant_id,job_row.workspace_id,
        job_row.document_id,job_row.version_id,version_row.object_key,job_row.checksum,
        job_row.scanner_policy_version,job_row.parser_id,job_row.parser_version,job_row.input_hash,
        job_row.attempt_count,job_row.max_attempts,job_row.lease_generation,NULL::pg_catalog.timestamptz,
        false::pg_catalog.bool,'extraction_failed'::pg_catalog.text,'error'::pg_catalog.text;
      RETURN;
    END IF;
    -- Requeue to retry_wait with the expired lease identity, then fall through
    -- to the normal due acquisition below.
    UPDATE public.document_extraction_jobs AS job
    SET status='retry_wait',next_attempt_at=now_ts,
      result_lease_generation=job.lease_generation,result_lease_token_hash=job.lease_token_hash,
      lease_token_hash=NULL,lease_worker_hash=NULL,lease_acquired_at=NULL,
      lease_heartbeat_at=NULL,lease_expires_at=NULL,
      event_at=now_ts,error_code='lease_expired',result_retryable=true,
      error_fingerprint=pg_catalog.encode(extensions.digest(
        'lease_expired|' || job.id::pg_catalog.text || '|' || job.lease_generation::pg_catalog.text,
        'sha256'),'hex')
    WHERE job.id=job_row.id AND job.status='running';
    IF NOT FOUND THEN RETURN; END IF;
    job_row.status := 'retry_wait';
    job_row.next_attempt_at := now_ts;
    job_row.error_code := 'lease_expired';
    job_row.error_fingerprint := pg_catalog.encode(extensions.digest(
      'lease_expired|' || job_row.id::pg_catalog.text || '|' || job_row.lease_generation::pg_catalog.text,
      'sha256'),'hex');
    job_row.result_retryable := true;
    job_row.event_at := now_ts;
    job_row.result_lease_generation := job_row.lease_generation;
    job_row.result_lease_token_hash := job_row.lease_token_hash;
  END IF;

  IF job_row.next_attempt_at IS NOT NULL AND job_row.next_attempt_at>now_ts THEN
    RETURN;
  END IF;
  IF job_row.attempt_count>=job_row.max_attempts THEN
    RETURN;
  END IF;
  IF job_row.cancel_requested_at IS NOT NULL THEN
    RETURN; -- A queued cancel request is applied by the member cancel path.
  END IF;

  -- The version must be clean for a first attempt, or extraction_failed for a
  -- retry after a terminal error path restored eligibility. During retry_wait
  -- the version stays in 'extracting' so no second extraction can start.
  IF job_row.status='queued' THEN
    IF version_row.status NOT IN ('clean','extraction_failed')
       OR version_row.checksum IS DISTINCT FROM job_row.checksum THEN
      RETURN;
    END IF;
    UPDATE public.document_versions AS version
    SET status='extracting'
    WHERE version.tenant_id=job_row.tenant_id AND version.workspace_id=job_row.workspace_id
      AND version.document_id=job_row.document_id AND version.id=job_row.version_id
      AND version.status IN ('clean','extraction_failed');
    IF NOT FOUND THEN RETURN; END IF;
  ELSE
    IF version_row.status<>'extracting' OR version_row.checksum IS DISTINCT FROM job_row.checksum THEN
      RETURN;
    END IF;
  END IF;

  UPDATE public.document_extraction_jobs AS job
  SET status='running',attempt_count=job.attempt_count+1,lease_generation=job.lease_generation+1,
    lease_token_hash=token_hash,lease_worker_hash=worker_hash,
    lease_acquired_at=now_ts,lease_heartbeat_at=now_ts,
    lease_expires_at=now_ts+interval '10 minutes',next_attempt_at=NULL
  WHERE job.id=job_row.id AND job.status IN ('queued','retry_wait');
  IF NOT FOUND THEN RETURN; END IF;

  IF job_row.status='queued' THEN
    INSERT INTO public.document_lifecycle_events(
      tenant_id,workspace_id,document_id,version_id,actor_kind,actor_membership_id,
      from_state,to_state,reason_code,correlation_id)
    VALUES (job_row.tenant_id,job_row.workspace_id,job_row.document_id,job_row.version_id,'worker',NULL,
      version_row.status,'extracting','extraction_lease_acquired',
      pg_catalog.current_setting('app.correlation_id',true));
  END IF;

  RETURN QUERY SELECT
    'leased'::pg_catalog.text,job_row.id,job_row.tenant_id,job_row.workspace_id,
    job_row.document_id,job_row.version_id,version_row.object_key,job_row.checksum,
    job_row.scanner_policy_version,job_row.parser_id,job_row.parser_version,job_row.input_hash,
    job_row.attempt_count+1,job_row.max_attempts,job_row.lease_generation+1,
    now_ts+interval '10 minutes',false::pg_catalog.bool,'extracting'::pg_catalog.text,NULL::pg_catalog.text;
EXCEPTION
  WHEN unique_violation OR check_violation OR foreign_key_violation OR raise_exception THEN
    RETURN;
END;
$fn$;

COMMENT ON FUNCTION public.novatrade_claim_document_extraction_job(pg_catalog.text,pg_catalog.text) IS
  'L-03 fenced extraction lease acquisition; terminal jobs replay their disposition.';

-- ---------------------------------------------------------------------------
-- Durable extraction output + knowledge persistence tables. All rows are
-- tenant-scoped, append-only, and written only inside a fenced finalize.
-- ---------------------------------------------------------------------------
CREATE TABLE public.document_extraction_outputs (
  job_id pg_catalog.uuid CONSTRAINT document_extraction_outputs_pkey PRIMARY KEY,
  tenant_id pg_catalog.uuid NOT NULL,
  workspace_id pg_catalog.uuid NOT NULL,
  document_id pg_catalog.uuid NOT NULL,
  version_id pg_catalog.uuid NOT NULL,
  checksum pg_catalog.text NOT NULL,
  scanner_policy_version pg_catalog.text NOT NULL,
  parser_id pg_catalog.text NOT NULL,
  parser_version pg_catalog.text NOT NULL,
  input_hash pg_catalog.text NOT NULL,
  output_sha256 pg_catalog.text NOT NULL,
  artifact pg_catalog.jsonb NOT NULL,
  block_count pg_catalog.int4 NOT NULL,
  chunk_count pg_catalog.int4 NOT NULL,
  created_at pg_catalog.timestamptz(3) NOT NULL DEFAULT pg_catalog.statement_timestamp(),
  CONSTRAINT document_extraction_outputs_job_fkey
    FOREIGN KEY (tenant_id,workspace_id,job_id)
    REFERENCES public.document_extraction_jobs(tenant_id,workspace_id,id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT document_extraction_outputs_hashes_chk CHECK (
    checksum ~ '^[0-9a-f]{64}$' AND input_hash ~ '^[0-9a-f]{64}$' AND output_sha256 ~ '^[0-9a-f]{64}$'
  ),
  CONSTRAINT document_extraction_outputs_counts_chk CHECK (
    block_count>0 AND chunk_count>0 AND chunk_count<=block_count
  ),
  CONSTRAINT document_extraction_outputs_artifact_chk CHECK (
    pg_catalog.jsonb_typeof(artifact)='object'
    AND pg_catalog.octet_length(artifact::text) BETWEEN 2 AND 16777216
  ),
  CONSTRAINT document_extraction_outputs_version_scope UNIQUE (tenant_id,workspace_id,document_id,version_id,output_sha256)
);

COMMENT ON TABLE public.document_extraction_outputs IS
  'L-03 render-safe extraction artifact snapshot per fenced job result; bytes never leave the private store boundary.';

CREATE TABLE public.knowledge_evidence_items (
  tenant_id pg_catalog.uuid NOT NULL,
  workspace_id pg_catalog.uuid NOT NULL,
  document_id pg_catalog.uuid NOT NULL,
  version_id pg_catalog.uuid NOT NULL,
  evidence_id pg_catalog.text NOT NULL,
  checksum pg_catalog.text NOT NULL,
  scanner_policy_version pg_catalog.text NOT NULL,
  extraction_input_hash pg_catalog.text NOT NULL,
  parser_id pg_catalog.text NOT NULL,
  parser_version pg_catalog.text NOT NULL,
  evidence_grade pg_catalog.text NOT NULL,
  origin pg_catalog.text NOT NULL,
  block_ordinal pg_catalog.int4 NOT NULL,
  block_content_hash pg_catalog.text NOT NULL,
  source_locator pg_catalog.jsonb NOT NULL,
  quote_start pg_catalog.int4 NOT NULL,
  quote_end pg_catalog.int4 NOT NULL,
  quote pg_catalog.text NOT NULL,
  quote_hash pg_catalog.text NOT NULL,
  extraction_job_id pg_catalog.uuid NOT NULL,
  created_at pg_catalog.timestamptz(3) NOT NULL DEFAULT pg_catalog.statement_timestamp(),
  CONSTRAINT knowledge_evidence_items_pkey PRIMARY KEY (tenant_id,workspace_id,evidence_id),
  CONSTRAINT knowledge_evidence_items_job_fkey
    FOREIGN KEY (tenant_id,workspace_id,extraction_job_id)
    REFERENCES public.document_extraction_jobs(tenant_id,workspace_id,id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT knowledge_evidence_items_id_chk CHECK (evidence_id ~ '^evidence:[0-9a-f]{64}$'),
  CONSTRAINT knowledge_evidence_items_hashes_chk CHECK (
    checksum ~ '^[0-9a-f]{64}$' AND extraction_input_hash ~ '^sha256:[0-9a-f]{64}$'
    AND block_content_hash ~ '^sha256:[0-9a-f]{64}$' AND quote_hash ~ '^sha256:[0-9a-f]{64}$'
  ),
  CONSTRAINT knowledge_evidence_items_shape_chk CHECK (
    evidence_grade='extracted' AND origin='parser_output'
    AND block_ordinal BETWEEN 0 AND 499999
    AND quote_start BETWEEN 0 AND 32767 AND quote_end BETWEEN 1 AND 32768
    AND quote_end>quote_start AND pg_catalog.char_length(quote)=quote_end-quote_start
    AND pg_catalog.octet_length(quote::pg_catalog.bytea)<=4096
    AND pg_catalog.jsonb_typeof(source_locator)='object'
  )
);

COMMENT ON TABLE public.knowledge_evidence_items IS
  'L-03 immutable extracted evidence items bound to a fenced extraction job and exact version facts.';

CREATE TABLE public.knowledge_citations (
  tenant_id pg_catalog.uuid NOT NULL,
  workspace_id pg_catalog.uuid NOT NULL,
  citation_id pg_catalog.text NOT NULL,
  evidence_id pg_catalog.text NOT NULL,
  document_id pg_catalog.uuid NOT NULL,
  version_id pg_catalog.uuid NOT NULL,
  quote pg_catalog.text NOT NULL,
  quote_hash pg_catalog.text NOT NULL,
  source_locator pg_catalog.jsonb NOT NULL,
  extraction_job_id pg_catalog.uuid NOT NULL,
  created_at pg_catalog.timestamptz(3) NOT NULL DEFAULT pg_catalog.statement_timestamp(),
  CONSTRAINT knowledge_citations_pkey PRIMARY KEY (tenant_id,workspace_id,citation_id),
  CONSTRAINT knowledge_citations_evidence_fkey
    FOREIGN KEY (tenant_id,workspace_id,evidence_id)
    REFERENCES public.knowledge_evidence_items(tenant_id,workspace_id,evidence_id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT knowledge_citations_job_fkey
    FOREIGN KEY (tenant_id,workspace_id,extraction_job_id)
    REFERENCES public.document_extraction_jobs(tenant_id,workspace_id,id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT knowledge_citations_id_chk CHECK (
    citation_id ~ '^citation:[0-9a-f]{64}$' AND evidence_id ~ '^evidence:[0-9a-f]{64}$'
  ),
  CONSTRAINT knowledge_citations_shape_chk CHECK (
    quote_hash ~ '^sha256:[0-9a-f]{64}$'
    AND pg_catalog.char_length(quote) BETWEEN 1 AND 4096
    AND pg_catalog.jsonb_typeof(source_locator)='object'
  )
);

COMMENT ON TABLE public.knowledge_citations IS
  'L-03 immutable render-safe citation anchors; display labels are derived at read time.';

CREATE TABLE public.knowledge_claims (
  tenant_id pg_catalog.uuid NOT NULL,
  workspace_id pg_catalog.uuid NOT NULL,
  claim_id pg_catalog.text NOT NULL,
  document_id pg_catalog.uuid NOT NULL,
  version_id pg_catalog.uuid NOT NULL,
  claim_class pg_catalog.text NOT NULL,
  subject pg_catalog.text NOT NULL,
  predicate pg_catalog.text NOT NULL,
  current_version_id pg_catalog.text NOT NULL,
  extraction_job_id pg_catalog.uuid NOT NULL,
  created_at pg_catalog.timestamptz(3) NOT NULL DEFAULT pg_catalog.statement_timestamp(),
  updated_at pg_catalog.timestamptz(3) NOT NULL DEFAULT pg_catalog.statement_timestamp(),
  CONSTRAINT knowledge_claims_pkey PRIMARY KEY (tenant_id,workspace_id,claim_id),
  CONSTRAINT knowledge_claims_job_fkey
    FOREIGN KEY (tenant_id,workspace_id,extraction_job_id)
    REFERENCES public.document_extraction_jobs(tenant_id,workspace_id,id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT knowledge_claims_id_chk CHECK (
    claim_id ~ '^claim:[0-9a-f]{64}$' AND current_version_id ~ '^claim-version:[0-9a-f]{64}$'
  ),
  CONSTRAINT knowledge_claims_shape_chk CHECK (
    -- The claim taxonomy mirrors src/lib/knowledge/claims.ts CLAIM_CLASSES.
    claim_class IN (
      'identity','product_technical_specification','compatibility_application',
      'regulatory_compliance','safety','performance','pricing_commercial',
      'capacity_supply','geography','contact_role','personalization',
      'negative_absence','customer_provided_strategic_fact')
    AND predicate ~ '^[a-z][a-z0-9._-]{0,127}$'
    AND pg_catalog.char_length(subject) BETWEEN 1 AND 512
  )
);

COMMENT ON TABLE public.knowledge_claims IS
  'L-03 claim roots; the current version pointer moves only through a reviewed supersession.';

CREATE TABLE public.knowledge_claim_versions (
  tenant_id pg_catalog.uuid NOT NULL,
  workspace_id pg_catalog.uuid NOT NULL,
  claim_version_id pg_catalog.text NOT NULL,
  claim_id pg_catalog.text NOT NULL,
  document_id pg_catalog.uuid NOT NULL,
  version_id pg_catalog.uuid NOT NULL,
  claim_version pg_catalog.int4 NOT NULL,
  claim_class pg_catalog.text NOT NULL,
  subject pg_catalog.text NOT NULL,
  predicate pg_catalog.text NOT NULL,
  value pg_catalog.text NOT NULL,
  unit pg_catalog.text,
  polarity pg_catalog.text NOT NULL,
  material pg_catalog.bool NOT NULL,
  confidence_basis_points pg_catalog.int4 NOT NULL,
  uncertainty pg_catalog.text,
  claim_status pg_catalog.text NOT NULL,
  review_state pg_catalog.text NOT NULL,
  reviewer_id pg_catalog.uuid,
  review_reason pg_catalog.text,
  supersedes_claim_version_id pg_catalog.text,
  citation_ids pg_catalog.jsonb NOT NULL,
  evidence_ids pg_catalog.jsonb NOT NULL,
  extraction_job_id pg_catalog.uuid,
  created_at pg_catalog.timestamptz(3) NOT NULL DEFAULT pg_catalog.statement_timestamp(),
  CONSTRAINT knowledge_claim_versions_pkey PRIMARY KEY (tenant_id,workspace_id,claim_version_id),
  CONSTRAINT knowledge_claim_versions_claim_fkey
    FOREIGN KEY (tenant_id,workspace_id,claim_id)
    REFERENCES public.knowledge_claims(tenant_id,workspace_id,claim_id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT knowledge_claim_versions_supersedes_fkey
    FOREIGN KEY (tenant_id,workspace_id,supersedes_claim_version_id)
    REFERENCES public.knowledge_claim_versions(tenant_id,workspace_id,claim_version_id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT knowledge_claim_versions_shape_chk CHECK (
    claim_version_id ~ '^claim-version:[0-9a-f]{64}$' AND claim_id ~ '^claim:[0-9a-f]{64}$'
    AND claim_version BETWEEN 1 AND 1000000
    AND claim_class IN (
      'identity','product_technical_specification','compatibility_application',
      'regulatory_compliance','safety','performance','pricing_commercial',
      'capacity_supply','geography','contact_role','personalization',
      'negative_absence','customer_provided_strategic_fact')
    AND predicate ~ '^[a-z][a-z0-9._-]{0,127}$'
    AND pg_catalog.char_length(subject) BETWEEN 1 AND 512
    AND pg_catalog.char_length(value) BETWEEN 1 AND 2048
    AND (unit IS NULL OR pg_catalog.char_length(unit) BETWEEN 1 AND 64)
    AND polarity IN ('positive','negative','conditional','unknown')
    AND confidence_basis_points BETWEEN 0 AND 10000
    AND (uncertainty IS NULL OR pg_catalog.char_length(uncertainty) BETWEEN 1 AND 1000)
    AND claim_status='proposed'
    AND review_state IN ('proposed','accepted','rejected')
    AND (supersedes_claim_version_id IS NULL OR supersedes_claim_version_id ~ '^claim-version:[0-9a-f]{64}$')
    AND (review_state='proposed')=(reviewer_id IS NULL AND review_reason IS NULL)
    AND (review_reason IS NULL OR pg_catalog.char_length(review_reason) BETWEEN 1 AND 1000)
    AND pg_catalog.jsonb_typeof(citation_ids)='array' AND pg_catalog.jsonb_typeof(evidence_ids)='array'
    AND pg_catalog.jsonb_array_length(citation_ids)=pg_catalog.jsonb_array_length(evidence_ids)
    AND (NOT material OR pg_catalog.jsonb_array_length(citation_ids)>0)
    AND pg_catalog.jsonb_array_length(citation_ids)<=256
  ),
  CONSTRAINT knowledge_claim_versions_claim_seq UNIQUE (tenant_id,workspace_id,claim_id,claim_version)
);

COMMENT ON TABLE public.knowledge_claim_versions IS
  'L-03 immutable claim versions with review state; history is never rewritten.';

CREATE TABLE public.knowledge_claim_evidence_edges (
  tenant_id pg_catalog.uuid NOT NULL,
  workspace_id pg_catalog.uuid NOT NULL,
  claim_version_id pg_catalog.text NOT NULL,
  citation_id pg_catalog.text NOT NULL,
  evidence_id pg_catalog.text NOT NULL,
  edge_ordinal pg_catalog.int4 NOT NULL,
  created_at pg_catalog.timestamptz(3) NOT NULL DEFAULT pg_catalog.statement_timestamp(),
  CONSTRAINT knowledge_claim_evidence_edges_pkey PRIMARY KEY (tenant_id,workspace_id,claim_version_id,citation_id),
  CONSTRAINT knowledge_claim_evidence_edges_version_fkey
    FOREIGN KEY (tenant_id,workspace_id,claim_version_id)
    REFERENCES public.knowledge_claim_versions(tenant_id,workspace_id,claim_version_id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT knowledge_claim_evidence_edges_citation_fkey
    FOREIGN KEY (tenant_id,workspace_id,citation_id)
    REFERENCES public.knowledge_citations(tenant_id,workspace_id,citation_id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT knowledge_claim_evidence_edges_evidence_fkey
    FOREIGN KEY (tenant_id,workspace_id,evidence_id)
    REFERENCES public.knowledge_evidence_items(tenant_id,workspace_id,evidence_id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT knowledge_claim_evidence_edges_shape_chk CHECK (
    citation_id ~ '^citation:[0-9a-f]{64}$' AND evidence_id ~ '^evidence:[0-9a-f]{64}$'
    AND edge_ordinal BETWEEN 0 AND 255
  )
);

COMMENT ON TABLE public.knowledge_claim_evidence_edges IS
  'L-03 append-only claim-version support edges pairing a citation with its evidence item.';

CREATE TABLE public.knowledge_claim_review_decisions (
  tenant_id pg_catalog.uuid NOT NULL,
  workspace_id pg_catalog.uuid NOT NULL,
  decision_id pg_catalog.text NOT NULL,
  claim_id pg_catalog.text NOT NULL,
  claim_version_id pg_catalog.text NOT NULL,
  outcome_claim_version_id pg_catalog.text NOT NULL,
  action pg_catalog.text NOT NULL,
  reason_code pg_catalog.text NOT NULL,
  reviewer_membership_id pg_catalog.uuid NOT NULL,
  created_at pg_catalog.timestamptz(3) NOT NULL DEFAULT pg_catalog.statement_timestamp(),
  CONSTRAINT knowledge_claim_review_decisions_pkey PRIMARY KEY (tenant_id,workspace_id,decision_id),
  CONSTRAINT knowledge_claim_review_decisions_claim_fkey
    FOREIGN KEY (tenant_id,workspace_id,claim_id)
    REFERENCES public.knowledge_claims(tenant_id,workspace_id,claim_id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT knowledge_claim_review_decisions_version_fkey
    FOREIGN KEY (tenant_id,workspace_id,claim_version_id)
    REFERENCES public.knowledge_claim_versions(tenant_id,workspace_id,claim_version_id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT knowledge_claim_review_decisions_outcome_fkey
    FOREIGN KEY (tenant_id,workspace_id,outcome_claim_version_id)
    REFERENCES public.knowledge_claim_versions(tenant_id,workspace_id,claim_version_id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT knowledge_claim_review_decisions_shape_chk CHECK (
    decision_id ~ '^decision:[0-9a-f]{64}$'
    AND action IN ('approve','edit','reject')
    AND pg_catalog.char_length(reason_code) BETWEEN 1 AND 128
    AND reason_code=pg_catalog.btrim(reason_code) AND reason_code !~ '[[:cntrl:]]'
  )
);

COMMENT ON TABLE public.knowledge_claim_review_decisions IS
  'L-03 append-only human review decisions; each decision produces a new immutable claim version.';

-- ---------------------------------------------------------------------------
-- Extraction finalize. Fenced by the live lease; persists the render-safe
-- artifact plus evidence, citations, claims, and edges atomically. A cancel
-- request wins over any result payload. Retryable errors requeue through
-- retry_wait with the recorded lease identity.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.novatrade_finalize_document_extraction(
  p_job_id pg_catalog.text,
  p_lease_token pg_catalog.text,
  p_outcome pg_catalog.text,
  p_output pg_catalog.jsonb,
  p_error_code pg_catalog.text,
  p_error_fingerprint pg_catalog.text,
  p_retryable pg_catalog.bool
)
RETURNS TABLE (
  kind pg_catalog.text,
  job_id pg_catalog.uuid,
  state pg_catalog.text,
  version_state pg_catalog.text
)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog AS $fn$
DECLARE
  tenant_scope pg_catalog.text := NULLIF(pg_catalog.current_setting('app.tenant_id',true),'');
  workspace_scope pg_catalog.text := NULLIF(pg_catalog.current_setting('app.workspace_id',true),'');
  job_scope pg_catalog.text := NULLIF(pg_catalog.current_setting('app.job_id',true),'');
  generation_scope pg_catalog.text := NULLIF(pg_catalog.current_setting('app.lease_generation',true),'');
  token_hash pg_catalog.text;
  job_row record;
  version_row record;
  now_ts pg_catalog.timestamptz := pg_catalog.statement_timestamp();
  result_state pg_catalog.text;
  next_version_state pg_catalog.text;
  retry_next pg_catalog.timestamptz;
  output_sha pg_catalog.text;
  output_artifact pg_catalog.jsonb;
  output_blocks pg_catalog.int4;
  output_chunks pg_catalog.int4;
  output_quality pg_catalog.numeric(5,4);
  output_review pg_catalog.bool;
  output_warnings pg_catalog.jsonb;
  evidence_item pg_catalog.jsonb;
  citation_item pg_catalog.jsonb;
  claim_item pg_catalog.jsonb;
  edge_item pg_catalog.jsonb;
  claim_row_count pg_catalog.int4;
BEGIN
  IF p_job_id IS NULL OR p_job_id !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
     OR p_lease_token IS NULL OR p_lease_token !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{31,127}$'
     OR p_outcome IS NULL OR p_outcome NOT IN ('complete','review_required','error','canceled')
  THEN
    RETURN;
  END IF;
  IF NOT public.novatrade_l03_worker_authorized('document_extraction:process') THEN
    RETURN;
  END IF;
  IF job_scope IS DISTINCT FROM p_job_id THEN
    RETURN;
  END IF;

  token_hash := pg_catalog.encode(extensions.digest(p_lease_token,'sha256'),'hex');

  SELECT * INTO job_row FROM public.document_extraction_jobs AS job
  WHERE job.id=p_job_id::pg_catalog.uuid
  FOR UPDATE;
  IF NOT FOUND
     OR job_row.tenant_id::pg_catalog.text IS DISTINCT FROM tenant_scope
     OR job_row.workspace_id::pg_catalog.text IS DISTINCT FROM workspace_scope THEN
    RETURN;
  END IF;

  SELECT * INTO version_row FROM public.document_versions AS version
  WHERE version.tenant_id=job_row.tenant_id AND version.workspace_id=job_row.workspace_id
    AND version.document_id=job_row.document_id AND version.id=job_row.version_id
  FOR UPDATE;
  IF NOT FOUND THEN RETURN; END IF;

  IF job_row.status IN ('complete','review_required','error','canceled') THEN
    RETURN QUERY SELECT 'already_persisted'::pg_catalog.text,job_row.id,job_row.status,version_row.status;
    RETURN;
  END IF;

  -- Lease fence: the job must be running under this exact generation/token.
  IF job_row.status<>'running' OR job_row.lease_expires_at<=now_ts
     OR job_row.lease_token_hash IS DISTINCT FROM token_hash
     OR job_row.lease_generation::pg_catalog.text IS DISTINCT FROM generation_scope THEN
    RETURN;
  END IF;

  -- A recorded cancel request dominates any worker-reported outcome.
  IF job_row.cancel_requested_at IS NOT NULL THEN
    result_state := 'canceled';
  ELSIF p_outcome='canceled' THEN
    result_state := 'canceled';
  ELSIF p_outcome='error' THEN
    IF p_error_code IS NULL OR pg_catalog.char_length(p_error_code) NOT BETWEEN 1 AND 128
       OR p_error_code<>pg_catalog.btrim(p_error_code) OR p_error_code ~ '[[:cntrl:]]'
       OR p_error_fingerprint IS NULL OR p_error_fingerprint !~ '^[0-9a-f]{64}$'
       OR p_retryable IS NULL THEN
      RETURN;
    END IF;
    result_state := 'error';
  ELSE
    -- complete | review_required: the output payload must be well formed.
    IF p_output IS NULL OR pg_catalog.jsonb_typeof(p_output)<>'object' THEN
      RETURN;
    END IF;
    output_sha := p_output #>> '{sha256}';
    output_artifact := p_output -> 'artifact';
    output_blocks := CASE WHEN pg_catalog.jsonb_typeof(p_output->'blockCount')='number'
      THEN (p_output->>'blockCount')::pg_catalog.int4 ELSE NULL END;
    output_chunks := CASE WHEN pg_catalog.jsonb_typeof(p_output->'chunkCount')='number'
      THEN (p_output->>'chunkCount')::pg_catalog.int4 ELSE NULL END;
    output_quality := CASE WHEN pg_catalog.jsonb_typeof(p_output->'qualityScore')='number'
      THEN (p_output->>'qualityScore')::pg_catalog.numeric ELSE NULL END;
    output_review := CASE WHEN pg_catalog.jsonb_typeof(p_output->'reviewRequired')='boolean'
      THEN (p_output->>'reviewRequired')::pg_catalog.bool ELSE NULL END;
    output_warnings := p_output -> 'warnings';
    IF output_sha IS NULL OR output_sha !~ '^[0-9a-f]{64}$'
       OR output_artifact IS NULL OR pg_catalog.jsonb_typeof(output_artifact)<>'object'
       OR output_blocks IS NULL OR output_blocks<1 OR output_blocks>500000
       OR output_chunks IS NULL OR output_chunks<1 OR output_chunks>output_blocks
       OR output_quality IS NULL OR output_quality<0 OR output_quality>1
       OR output_review IS NULL
       OR output_review IS DISTINCT FROM (p_outcome='review_required')
       OR output_warnings IS NULL OR pg_catalog.jsonb_typeof(output_warnings)<>'array'
       OR pg_catalog.jsonb_array_length(output_warnings)>100 THEN
      RETURN;
    END IF;
    result_state := p_outcome;
  END IF;

  -- Persist the artifact payload first when present so a constraint failure
  -- aborts the whole finalize inside this transaction.
  IF result_state IN ('complete','review_required') THEN
    INSERT INTO public.document_extraction_outputs(
      job_id,tenant_id,workspace_id,document_id,version_id,checksum,scanner_policy_version,
      parser_id,parser_version,input_hash,output_sha256,artifact,block_count,chunk_count)
    VALUES (job_row.id,job_row.tenant_id,job_row.workspace_id,job_row.document_id,job_row.version_id,
      job_row.checksum,job_row.scanner_policy_version,job_row.parser_id,job_row.parser_version,
      job_row.input_hash,output_sha,output_artifact,output_blocks,output_chunks);

    -- Evidence items: every row must carry the job-bound scope and hash facts.
    FOR evidence_item IN SELECT value FROM pg_catalog.jsonb_array_elements(p_output -> 'evidence') LOOP
      IF pg_catalog.jsonb_typeof(evidence_item)<>'object'
         OR (evidence_item ->> 'tenantId')::pg_catalog.text IS DISTINCT FROM tenant_scope
         OR (evidence_item ->> 'workspaceId')::pg_catalog.text IS DISTINCT FROM workspace_scope
         OR (evidence_item ->> 'documentId')::pg_catalog.text IS DISTINCT FROM job_row.document_id::pg_catalog.text
         OR (evidence_item ->> 'documentVersionId')::pg_catalog.text IS DISTINCT FROM job_row.version_id::pg_catalog.text
         OR (evidence_item ->> 'checksum')::pg_catalog.text IS DISTINCT FROM job_row.checksum
         OR (evidence_item ->> 'scannerPolicyVersion')::pg_catalog.text IS DISTINCT FROM job_row.scanner_policy_version
         OR (evidence_item ->> 'parserId')::pg_catalog.text IS DISTINCT FROM job_row.parser_id
         OR (evidence_item ->> 'parserVersion')::pg_catalog.text IS DISTINCT FROM job_row.parser_version
         OR (evidence_item ->> 'extractionInputHash')::pg_catalog.text IS DISTINCT FROM 'sha256:'||job_row.input_hash THEN
        RAISE EXCEPTION 'knowledge evidence scope binding mismatch' USING ERRCODE='23514';
      END IF;
      INSERT INTO public.knowledge_evidence_items(
        tenant_id,workspace_id,document_id,version_id,evidence_id,checksum,scanner_policy_version,
        extraction_input_hash,parser_id,parser_version,evidence_grade,origin,block_ordinal,
        block_content_hash,source_locator,quote_start,quote_end,quote,quote_hash,extraction_job_id)
      VALUES (
        job_row.tenant_id,job_row.workspace_id,job_row.document_id,job_row.version_id,
        evidence_item->>'evidenceId',job_row.checksum,job_row.scanner_policy_version,
        evidence_item->>'extractionInputHash',job_row.parser_id,job_row.parser_version,
        evidence_item->>'evidenceGrade',evidence_item->>'origin',
        (evidence_item->>'blockOrdinal')::pg_catalog.int4,evidence_item->>'blockContentHash',
        evidence_item->'sourceLocator',
        (evidence_item->>'quoteStart')::pg_catalog.int4,(evidence_item->>'quoteEnd')::pg_catalog.int4,
        evidence_item->>'quote',evidence_item->>'quoteHash',job_row.id)
      ON CONFLICT (tenant_id,workspace_id,evidence_id) DO NOTHING;
    END LOOP;

    FOR citation_item IN SELECT value FROM pg_catalog.jsonb_array_elements(p_output -> 'citations') LOOP
      IF pg_catalog.jsonb_typeof(citation_item)<>'object'
         OR (citation_item ->> 'tenantId')::pg_catalog.text IS DISTINCT FROM tenant_scope
         OR (citation_item ->> 'workspaceId')::pg_catalog.text IS DISTINCT FROM workspace_scope
         OR (citation_item ->> 'documentId')::pg_catalog.text IS DISTINCT FROM job_row.document_id::pg_catalog.text
         OR (citation_item ->> 'documentVersionId')::pg_catalog.text IS DISTINCT FROM job_row.version_id::pg_catalog.text
         OR NOT EXISTS (
           SELECT 1 FROM public.knowledge_evidence_items AS evidence
           WHERE evidence.tenant_id=job_row.tenant_id AND evidence.workspace_id=job_row.workspace_id
             AND evidence.evidence_id=(citation_item->>'evidenceId')
             AND evidence.version_id=job_row.version_id
         ) THEN
        RAISE EXCEPTION 'knowledge citation scope binding mismatch' USING ERRCODE='23514';
      END IF;
      INSERT INTO public.knowledge_citations(
        tenant_id,workspace_id,citation_id,evidence_id,document_id,version_id,
        quote,quote_hash,source_locator,extraction_job_id)
      VALUES (
        job_row.tenant_id,job_row.workspace_id,citation_item->>'citationId',citation_item->>'evidenceId',
        job_row.document_id,job_row.version_id,citation_item->>'quote',citation_item->>'quoteHash',
        citation_item->'sourceLocator',job_row.id)
      ON CONFLICT (tenant_id,workspace_id,citation_id) DO NOTHING;
    END LOOP;

    FOR claim_item IN SELECT value FROM pg_catalog.jsonb_array_elements(p_output -> 'claims') LOOP
      IF pg_catalog.jsonb_typeof(claim_item)<>'object'
         OR (claim_item ->> 'tenantId')::pg_catalog.text IS DISTINCT FROM tenant_scope
         OR (claim_item ->> 'workspaceId')::pg_catalog.text IS DISTINCT FROM workspace_scope
         OR (claim_item ->> 'documentId')::pg_catalog.text IS DISTINCT FROM job_row.document_id::pg_catalog.text
         OR (claim_item ->> 'documentVersionId')::pg_catalog.text IS DISTINCT FROM job_row.version_id::pg_catalog.text
         OR (claim_item ->> 'checksum')::pg_catalog.text IS DISTINCT FROM job_row.checksum
         OR (claim_item ->> 'scannerPolicyVersion')::pg_catalog.text IS DISTINCT FROM job_row.scanner_policy_version
         OR (claim_item ->> 'reviewState')::pg_catalog.text<>'proposed'
         OR (claim_item ->> 'claimStatus')::pg_catalog.text<>'proposed' THEN
        RAISE EXCEPTION 'knowledge claim scope binding mismatch' USING ERRCODE='23514';
      END IF;

      INSERT INTO public.knowledge_claims(
        tenant_id,workspace_id,claim_id,document_id,version_id,claim_class,subject,predicate,
        current_version_id,extraction_job_id)
      VALUES (
        job_row.tenant_id,job_row.workspace_id,claim_item->>'claimId',job_row.document_id,job_row.version_id,
        claim_item->>'claimClass',claim_item->>'subject',claim_item->>'predicate',
        claim_item->>'claimVersionId',job_row.id)
      ON CONFLICT (tenant_id,workspace_id,claim_id) DO NOTHING;

      INSERT INTO public.knowledge_claim_versions(
        tenant_id,workspace_id,claim_version_id,claim_id,document_id,version_id,claim_version,
        claim_class,subject,predicate,value,unit,polarity,material,confidence_basis_points,uncertainty,
        claim_status,review_state,reviewer_id,review_reason,supersedes_claim_version_id,
        citation_ids,evidence_ids,extraction_job_id)
      VALUES (
        job_row.tenant_id,job_row.workspace_id,claim_item->>'claimVersionId',claim_item->>'claimId',
        job_row.document_id,job_row.version_id,(claim_item->>'claimVersion')::pg_catalog.int4,
        claim_item->>'claimClass',claim_item->>'subject',claim_item->>'predicate',claim_item->>'value',
        claim_item->>'unit',claim_item->>'polarity',(claim_item->>'material')::pg_catalog.bool,
        (claim_item->>'confidenceBasisPoints')::pg_catalog.int4,claim_item->>'uncertainty',
        claim_item->>'claimStatus',claim_item->>'reviewState',NULL,NULL,NULL,
        claim_item->'citationIds',claim_item->'evidenceIds',job_row.id)
      ON CONFLICT (tenant_id,workspace_id,claim_version_id) DO NOTHING;
    END LOOP;

    FOR edge_item IN SELECT value FROM pg_catalog.jsonb_array_elements(p_output -> 'claimEdges') LOOP
      IF pg_catalog.jsonb_typeof(edge_item)<>'object' THEN
        RAISE EXCEPTION 'knowledge claim edge is malformed' USING ERRCODE='23514';
      END IF;
      INSERT INTO public.knowledge_claim_evidence_edges(
        tenant_id,workspace_id,claim_version_id,citation_id,evidence_id,edge_ordinal)
      SELECT job_row.tenant_id,job_row.workspace_id,edge_item->>'claimVersionId',
        edge_item->>'citationId',edge_item->>'evidenceId',
        (edge_item->>'edgeOrdinal')::pg_catalog.int4
      WHERE EXISTS (
        SELECT 1 FROM public.knowledge_claim_versions AS claim_version
        WHERE claim_version.tenant_id=job_row.tenant_id AND claim_version.workspace_id=job_row.workspace_id
          AND claim_version.claim_version_id=(edge_item->>'claimVersionId')
      ) AND EXISTS (
        SELECT 1 FROM public.knowledge_citations AS citation
        WHERE citation.tenant_id=job_row.tenant_id AND citation.workspace_id=job_row.workspace_id
          AND citation.citation_id=(edge_item->>'citationId')
          AND citation.evidence_id=(edge_item->>'evidenceId')
      )
      ON CONFLICT (tenant_id,workspace_id,claim_version_id,citation_id) DO NOTHING;
    END LOOP;
  END IF;

  -- Result classification against the job/version state machine.
  IF result_state='canceled' THEN
    IF job_row.cancel_requested_at IS NULL AND p_outcome<>'canceled' THEN
      RETURN;
    END IF;
    UPDATE public.document_extraction_jobs AS job
    SET status='canceled',canceled_at=now_ts,event_at=now_ts,next_attempt_at=NULL,
      cancel_requested_at=coalesce(job.cancel_requested_at,now_ts),
      result_lease_generation=job.lease_generation,result_lease_token_hash=job.lease_token_hash,
      lease_token_hash=NULL,lease_worker_hash=NULL,lease_acquired_at=NULL,
      lease_heartbeat_at=NULL,lease_expires_at=NULL
    WHERE job.id=job_row.id AND job.status='running';
    IF NOT FOUND THEN RETURN; END IF;
    next_version_state := 'clean';
  ELSIF result_state='error' AND p_retryable AND job_row.attempt_count<job_row.max_attempts THEN
    retry_next := now_ts + (interval '60 seconds' * job_row.attempt_count);
    UPDATE public.document_extraction_jobs AS job
    SET status='retry_wait',next_attempt_at=retry_next,
      result_lease_generation=job.lease_generation,result_lease_token_hash=job.lease_token_hash,
      lease_token_hash=NULL,lease_worker_hash=NULL,lease_acquired_at=NULL,
      lease_heartbeat_at=NULL,lease_expires_at=NULL,
      event_at=now_ts,error_code=p_error_code,error_fingerprint=p_error_fingerprint,result_retryable=true
    WHERE job.id=job_row.id AND job.status='running';
    IF NOT FOUND THEN RETURN; END IF;
    next_version_state := version_row.status; -- stays 'extracting' across retry
  ELSIF result_state='error' THEN
    UPDATE public.document_extraction_jobs AS job
    SET status='error',next_attempt_at=NULL,
      result_lease_generation=job.lease_generation,result_lease_token_hash=job.lease_token_hash,
      lease_token_hash=NULL,lease_worker_hash=NULL,lease_acquired_at=NULL,
      lease_heartbeat_at=NULL,lease_expires_at=NULL,
      event_at=now_ts,error_code=p_error_code,error_fingerprint=p_error_fingerprint,
      result_retryable=false
    WHERE job.id=job_row.id AND job.status='running';
    IF NOT FOUND THEN RETURN; END IF;
    next_version_state := 'extraction_failed';
  ELSE
    UPDATE public.document_extraction_jobs AS job
    SET status=result_state,next_attempt_at=NULL,
      result_lease_generation=job.lease_generation,result_lease_token_hash=job.lease_token_hash,
      lease_token_hash=NULL,lease_worker_hash=NULL,lease_acquired_at=NULL,
      lease_heartbeat_at=NULL,lease_expires_at=NULL,
      event_at=now_ts,output_sha256=output_sha,output_block_count=output_blocks,
      output_chunk_count=output_chunks,quality_score=output_quality,review_required=output_review,
      warnings=output_warnings
    WHERE job.id=job_row.id AND job.status='running';
    IF NOT FOUND THEN RETURN; END IF;
    next_version_state := 'ready';
  END IF;

  IF next_version_state IS DISTINCT FROM version_row.status THEN
    UPDATE public.document_versions AS version
    SET status=next_version_state
    WHERE version.tenant_id=job_row.tenant_id AND version.workspace_id=job_row.workspace_id
      AND version.document_id=job_row.document_id AND version.id=job_row.version_id
      AND version.status='extracting';
    IF NOT FOUND THEN RETURN; END IF;
  END IF;

  INSERT INTO public.document_lifecycle_events(
    tenant_id,workspace_id,document_id,version_id,actor_kind,actor_membership_id,
    from_state,to_state,reason_code,correlation_id)
  VALUES (job_row.tenant_id,job_row.workspace_id,job_row.document_id,job_row.version_id,'worker',NULL,
    version_row.status,next_version_state,
    CASE result_state
      WHEN 'complete' THEN 'extraction_complete'
      WHEN 'review_required' THEN 'extraction_review_required'
      WHEN 'canceled' THEN 'extraction_canceled'
      ELSE coalesce(p_error_code,'extraction_error') END,
    pg_catalog.current_setting('app.correlation_id',true));

  RETURN QUERY SELECT 'persisted'::pg_catalog.text,job_row.id,result_state,next_version_state;
EXCEPTION
  WHEN unique_violation OR check_violation OR foreign_key_violation OR raise_exception THEN
    RETURN;
END;
$fn$;

COMMENT ON FUNCTION public.novatrade_finalize_document_extraction(
  pg_catalog.text,pg_catalog.text,pg_catalog.text,pg_catalog.jsonb,
  pg_catalog.text,pg_catalog.text,pg_catalog.bool) IS
  'L-03 fenced extraction finalize; persists artifact, evidence, citations, claims, and edges atomically.';

-- ---------------------------------------------------------------------------
-- Extraction lease-loss recovery. An expired running lease may only finalize
-- as a fenced retryable requeue carrying the expired lease identity.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.novatrade_recover_document_extraction_lease(
  p_job_id pg_catalog.text
)
RETURNS TABLE (kind pg_catalog.text, job_id pg_catalog.uuid, state pg_catalog.text)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog AS $fn$
DECLARE
  tenant_scope pg_catalog.text := NULLIF(pg_catalog.current_setting('app.tenant_id',true),'');
  workspace_scope pg_catalog.text := NULLIF(pg_catalog.current_setting('app.workspace_id',true),'');
  job_scope pg_catalog.text := NULLIF(pg_catalog.current_setting('app.job_id',true),'');
  job_row record;
  now_ts pg_catalog.timestamptz := pg_catalog.statement_timestamp();
  fingerprint pg_catalog.text;
BEGIN
  IF p_job_id IS NULL OR p_job_id !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$' THEN
    RETURN;
  END IF;
  IF NOT public.novatrade_l03_worker_authorized('document_extraction:recover') THEN
    RETURN;
  END IF;
  IF job_scope IS DISTINCT FROM p_job_id THEN
    RETURN;
  END IF;

  SELECT * INTO job_row FROM public.document_extraction_jobs AS job
  WHERE job.id=p_job_id::pg_catalog.uuid
  FOR UPDATE;
  IF NOT FOUND
     OR job_row.tenant_id::pg_catalog.text IS DISTINCT FROM tenant_scope
     OR job_row.workspace_id::pg_catalog.text IS DISTINCT FROM workspace_scope
     OR job_row.status<>'running' OR job_row.lease_expires_at>now_ts THEN
    RETURN;
  END IF;

  fingerprint := pg_catalog.encode(extensions.digest(
    'lease_expired|' || job_row.id::pg_catalog.text || '|' || job_row.lease_generation::pg_catalog.text,
    'sha256'),'hex');

  -- A recorded cancel request wins over every retryable outcome.
  IF job_row.cancel_requested_at IS NOT NULL THEN
    UPDATE public.document_extraction_jobs AS job
    SET status='canceled',canceled_at=now_ts,event_at=now_ts,next_attempt_at=NULL,
      result_lease_generation=job.lease_generation,result_lease_token_hash=job.lease_token_hash,
      lease_token_hash=NULL,lease_worker_hash=NULL,lease_acquired_at=NULL,
      lease_heartbeat_at=NULL,lease_expires_at=NULL
    WHERE job.id=job_row.id AND job.status='running';
    IF NOT FOUND THEN RETURN; END IF;
    UPDATE public.document_versions AS version
    SET status='clean'
    WHERE version.tenant_id=job_row.tenant_id AND version.workspace_id=job_row.workspace_id
      AND version.document_id=job_row.document_id AND version.id=job_row.version_id
      AND version.status='extracting';
    INSERT INTO public.document_lifecycle_events(
      tenant_id,workspace_id,document_id,version_id,actor_kind,actor_membership_id,
      from_state,to_state,reason_code,correlation_id)
    VALUES (job_row.tenant_id,job_row.workspace_id,job_row.document_id,job_row.version_id,'worker',NULL,
      'extracting','clean','extraction_canceled',
      pg_catalog.current_setting('app.correlation_id',true));
    RETURN QUERY SELECT 'canceled'::pg_catalog.text,job_row.id,'canceled'::pg_catalog.text;
    RETURN;
  END IF;

  -- An exhausted attempt budget terminates as a fenced error; the version
  -- regains re-extraction eligibility through 'extraction_failed'.
  IF job_row.attempt_count>=job_row.max_attempts THEN
    UPDATE public.document_extraction_jobs AS job
    SET status='error',next_attempt_at=NULL,
      result_lease_generation=job.lease_generation,result_lease_token_hash=job.lease_token_hash,
      lease_token_hash=NULL,lease_worker_hash=NULL,lease_acquired_at=NULL,
      lease_heartbeat_at=NULL,lease_expires_at=NULL,
      event_at=now_ts,error_code='lease_expired',error_fingerprint=fingerprint,result_retryable=false
    WHERE job.id=job_row.id AND job.status='running';
    IF NOT FOUND THEN RETURN; END IF;
    UPDATE public.document_versions AS version
    SET status='extraction_failed'
    WHERE version.tenant_id=job_row.tenant_id AND version.workspace_id=job_row.workspace_id
      AND version.document_id=job_row.document_id AND version.id=job_row.version_id
      AND version.status='extracting';
    INSERT INTO public.document_lifecycle_events(
      tenant_id,workspace_id,document_id,version_id,actor_kind,actor_membership_id,
      from_state,to_state,reason_code,correlation_id)
    VALUES (job_row.tenant_id,job_row.workspace_id,job_row.document_id,job_row.version_id,'worker',NULL,
      'extracting','extraction_failed','lease_expired',
      pg_catalog.current_setting('app.correlation_id',true));
    RETURN QUERY SELECT 'terminated'::pg_catalog.text,job_row.id,'error'::pg_catalog.text;
    RETURN;
  END IF;

  UPDATE public.document_extraction_jobs AS job
  SET status='retry_wait',next_attempt_at=now_ts+interval '60 seconds',
    result_lease_generation=job.lease_generation,result_lease_token_hash=job.lease_token_hash,
    lease_token_hash=NULL,lease_worker_hash=NULL,lease_acquired_at=NULL,
    lease_heartbeat_at=NULL,lease_expires_at=NULL,
    event_at=now_ts,error_code='lease_expired',error_fingerprint=fingerprint,result_retryable=true
  WHERE job.id=job_row.id AND job.status='running';
  IF NOT FOUND THEN RETURN; END IF;

  RETURN QUERY SELECT 'requeued'::pg_catalog.text,job_row.id,'retry_wait'::pg_catalog.text;
EXCEPTION
  WHEN unique_violation OR check_violation OR foreign_key_violation OR raise_exception THEN
    RETURN;
END;
$fn$;

COMMENT ON FUNCTION public.novatrade_recover_document_extraction_lease(pg_catalog.text) IS
  'L-03 fenced extraction lease-loss recovery to retry_wait; a dead worker can never fabricate output.';

-- ---------------------------------------------------------------------------
-- Worker retention evaluation recording. The TS evaluator computes the
-- disposition; this RPC persists it idempotently on (version_id,input_sha256)
-- and, when purge_eligible, stages the durable deletion request.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.novatrade_record_document_retention_evaluation(
  p_document_id pg_catalog.text,
  p_version_id pg_catalog.text,
  p_input_sha256 pg_catalog.text,
  p_disposition pg_catalog.text,
  p_reason pg_catalog.text,
  p_policy_version pg_catalog.text,
  p_retention_expires_at pg_catalog.text,
  p_evaluated_at pg_catalog.text
)
RETURNS TABLE (
  kind pg_catalog.text,
  document_id pg_catalog.uuid,
  version_id pg_catalog.uuid,
  disposition pg_catalog.text,
  reason pg_catalog.text,
  deletion_request_id pg_catalog.uuid
)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog AS $fn$
DECLARE
  tenant_scope pg_catalog.text := NULLIF(pg_catalog.current_setting('app.tenant_id',true),'');
  workspace_scope pg_catalog.text := NULLIF(pg_catalog.current_setting('app.workspace_id',true),'');
  job_scope pg_catalog.text := NULLIF(pg_catalog.current_setting('app.job_id',true),'');
  version_row record;
  existing record;
  request_uuid pg_catalog.uuid;
  expires_ts pg_catalog.timestamptz;
  evaluated_ts pg_catalog.timestamptz;
BEGIN
  IF p_document_id IS NULL OR p_document_id !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
     OR p_version_id IS NULL OR p_version_id !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
     OR p_input_sha256 IS NULL OR p_input_sha256 !~ '^sha256:[0-9a-f]{64}$'
     OR p_disposition IS NULL OR p_disposition NOT IN ('purge_eligible','retain')
     OR p_reason IS NULL OR p_reason NOT IN (
       'retention_elapsed','replay_conflict','legal_hold_active','support_hold_active','incident_hold_active',
       'current_version','clean_version','workflow_in_flight','deletion_in_progress','already_deleted','retention_active')
     OR (p_disposition='purge_eligible')<>(p_reason='retention_elapsed')
     OR p_policy_version IS NULL OR p_policy_version !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'
     OR p_retention_expires_at IS NULL OR p_evaluated_at IS NULL
  THEN
    RETURN;
  END IF;
  BEGIN
    expires_ts := p_retention_expires_at::pg_catalog.timestamptz;
    evaluated_ts := p_evaluated_at::pg_catalog.timestamptz;
  EXCEPTION WHEN others THEN
    RETURN;
  END;
  IF NOT public.novatrade_l03_worker_authorized('document_retention:evaluate') THEN
    RETURN;
  END IF;

  SELECT * INTO version_row FROM public.document_versions AS version
  WHERE version.tenant_id=tenant_scope::pg_catalog.uuid AND version.workspace_id=workspace_scope::pg_catalog.uuid
    AND version.document_id=p_document_id::pg_catalog.uuid AND version.id=p_version_id::pg_catalog.uuid
  FOR UPDATE;
  IF NOT FOUND OR job_scope IS NULL THEN RETURN; END IF;

  SELECT * INTO existing FROM public.document_retention_evaluations AS evaluation
  WHERE evaluation.version_id=p_version_id::pg_catalog.uuid
    AND evaluation.tenant_id=version_row.tenant_id;
  IF FOUND THEN
    IF existing.input_sha256 IS DISTINCT FROM p_input_sha256 THEN
      RETURN QUERY SELECT 'conflict'::pg_catalog.text,version_row.document_id,version_row.id,
        existing.disposition,existing.reason,NULL::pg_catalog.uuid;
      RETURN;
    END IF;
    RETURN QUERY SELECT 'replay'::pg_catalog.text,version_row.document_id,version_row.id,
      existing.disposition,existing.reason,NULL::pg_catalog.uuid;
    RETURN;
  END IF;

  INSERT INTO public.document_retention_evaluations(
    tenant_id,workspace_id,document_id,version_id,input_sha256,disposition,reason,
    policy_version,retention_expires_at,evaluated_at,correlation_id)
  VALUES (version_row.tenant_id,version_row.workspace_id,version_row.document_id,version_row.id,
    p_input_sha256,p_disposition,p_reason,p_policy_version,expires_ts,evaluated_ts,
    pg_catalog.current_setting('app.correlation_id',true));

  -- A purge-eligible verdict stages a durable deletion request and moves the
  -- version into deletion_pending in one transaction; apply_document_deletion
  -- is fenced on that state. Every purge-eligible state has a legal direct
  -- transition to deletion_pending in the version state machine.
  IF p_disposition='purge_eligible'
     AND version_row.status IN ('ready','extraction_failed','infected','scanner_error','rejected','expired') THEN
    request_uuid := job_scope::pg_catalog.uuid;
    INSERT INTO public.document_deletion_requests(
      id,tenant_id,workspace_id,document_id,version_id,requested_by,reason_code)
    VALUES (request_uuid,version_row.tenant_id,version_row.workspace_id,version_row.document_id,
      version_row.id,job_scope::pg_catalog.uuid,'retention_expired')
    ON CONFLICT DO NOTHING;

    UPDATE public.document_versions AS version
    SET status='deletion_pending'
    WHERE version.tenant_id=version_row.tenant_id AND version.workspace_id=version_row.workspace_id
      AND version.document_id=version_row.document_id AND version.id=version_row.id
      AND version.status=version_row.status;
    IF NOT FOUND THEN RETURN; END IF;

    INSERT INTO public.document_lifecycle_events(
      tenant_id,workspace_id,document_id,version_id,actor_kind,actor_membership_id,
      from_state,to_state,reason_code,correlation_id)
    VALUES (version_row.tenant_id,version_row.workspace_id,version_row.document_id,version_row.id,
      'worker',NULL,version_row.status,'deletion_pending','retention_expired',
      pg_catalog.current_setting('app.correlation_id',true));

    RETURN QUERY SELECT 'recorded_purge'::pg_catalog.text,version_row.document_id,version_row.id,
      p_disposition,p_reason,request_uuid;
    RETURN;
  END IF;

  RETURN QUERY SELECT 'recorded'::pg_catalog.text,version_row.document_id,version_row.id,
    p_disposition,p_reason,NULL::pg_catalog.uuid;
EXCEPTION
  WHEN unique_violation OR check_violation OR foreign_key_violation OR raise_exception THEN
    RETURN;
END;
$fn$;

COMMENT ON FUNCTION public.novatrade_record_document_retention_evaluation(
  pg_catalog.text,pg_catalog.text,pg_catalog.text,pg_catalog.text,pg_catalog.text,
  pg_catalog.text,pg_catalog.text,pg_catalog.text) IS
  'L-03 worker retention evaluation persistence; idempotent on the hashed evaluator input.';

-- ---------------------------------------------------------------------------
-- Member deletion request. Any deletable version state moves to
-- deletion_pending with a durable request; incident-held and already-deleted
-- versions are refused by the state guard.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.novatrade_request_document_deletion(
  p_tenant_id pg_catalog.text,
  p_workspace_id pg_catalog.text,
  p_document_id pg_catalog.text,
  p_version_id pg_catalog.text,
  p_request_id pg_catalog.text,
  p_reason_code pg_catalog.text
)
RETURNS TABLE (kind pg_catalog.text, request_id pg_catalog.uuid, state pg_catalog.text)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog AS $fn$
DECLARE
  tenant_uuid pg_catalog.uuid;
  workspace_uuid pg_catalog.uuid;
  document_uuid pg_catalog.uuid;
  version_uuid pg_catalog.uuid;
  request_uuid pg_catalog.uuid;
  version_row record;
BEGIN
  IF p_tenant_id IS NULL OR p_tenant_id !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
     OR p_workspace_id IS NULL OR p_workspace_id !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
     OR p_document_id IS NULL OR p_document_id !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
     OR p_version_id IS NULL OR p_version_id !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
     OR p_request_id IS NULL OR p_request_id !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
     OR p_reason_code IS NULL OR p_reason_code NOT IN ('member_requested','retention_expired','policy_purge','source_stale','incident_complete')
  THEN
    RETURN;
  END IF;
  IF NULLIF(pg_catalog.current_setting('app.tenant_id',true),'') IS DISTINCT FROM p_tenant_id
     OR NULLIF(pg_catalog.current_setting('app.workspace_id',true),'') IS DISTINCT FROM p_workspace_id THEN
    RETURN;
  END IF;
  -- knowledge:delete is owner/admin conditional in D-002; every other role is
  -- denied outright. The version-state binding below is the durable condition.
  IF NOT public.novatrade_l03_member_lock(ARRAY['owner','admin']) THEN
    RETURN;
  END IF;

  tenant_uuid := p_tenant_id::pg_catalog.uuid;
  workspace_uuid := p_workspace_id::pg_catalog.uuid;
  document_uuid := p_document_id::pg_catalog.uuid;
  version_uuid := p_version_id::pg_catalog.uuid;
  request_uuid := p_request_id::pg_catalog.uuid;

  SELECT * INTO version_row FROM public.document_versions AS version
  WHERE version.tenant_id=tenant_uuid AND version.workspace_id=workspace_uuid
    AND version.document_id=document_uuid AND version.id=version_uuid
  FOR UPDATE;
  IF NOT FOUND THEN RETURN; END IF;

  IF version_row.status='retained_for_incident' THEN
    RETURN QUERY SELECT 'denied'::pg_catalog.text,NULL::pg_catalog.uuid,version_row.status;
    RETURN;
  END IF;
  IF version_row.status IN ('deletion_pending','deletion_failed','deleted') THEN
    RETURN QUERY SELECT 'replay'::pg_catalog.text,NULL::pg_catalog.uuid,version_row.status;
    RETURN;
  END IF;

  INSERT INTO public.document_deletion_requests(
    id,tenant_id,workspace_id,document_id,version_id,requested_by,reason_code)
  VALUES (request_uuid,tenant_uuid,workspace_uuid,document_uuid,version_uuid,
    pg_catalog.current_setting('app.membership_id',true)::pg_catalog.uuid,p_reason_code);

  UPDATE public.document_versions AS version
  SET status='deletion_pending'
  WHERE version.tenant_id=tenant_uuid AND version.workspace_id=workspace_uuid
    AND version.document_id=document_uuid AND version.id=version_uuid
    AND version.status=version_row.status;
  IF NOT FOUND THEN RETURN; END IF;

  INSERT INTO public.document_lifecycle_events(
    tenant_id,workspace_id,document_id,version_id,actor_kind,actor_membership_id,
    from_state,to_state,reason_code,correlation_id)
  VALUES (tenant_uuid,workspace_uuid,document_uuid,version_uuid,'member',
    pg_catalog.current_setting('app.membership_id',true)::pg_catalog.uuid,
    version_row.status,'deletion_pending',p_reason_code,
    pg_catalog.current_setting('app.correlation_id',true));

  RETURN QUERY SELECT 'requested'::pg_catalog.text,request_uuid,'deletion_pending'::pg_catalog.text;
EXCEPTION
  WHEN unique_violation OR check_violation OR foreign_key_violation OR raise_exception THEN
    RETURN;
END;
$fn$;

COMMENT ON FUNCTION public.novatrade_request_document_deletion(
  pg_catalog.text,pg_catalog.text,pg_catalog.text,pg_catalog.text,pg_catalog.text,pg_catalog.text) IS
  'L-03 member deletion request; the version enters deletion_pending and the worker applies it.';

-- ---------------------------------------------------------------------------
-- Worker deletion application. Marks the request applied, removes derived
-- knowledge rows (render-safe text has no reconstructive value after delete),
-- and moves the version to deleted. Physical object removal is the storage
-- adapter's job and happens in the service layer before this call.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.novatrade_apply_document_deletion(
  p_request_id pg_catalog.text
)
RETURNS TABLE (kind pg_catalog.text, request_id pg_catalog.uuid, version_state pg_catalog.text)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog AS $fn$
DECLARE
  tenant_scope pg_catalog.text := NULLIF(pg_catalog.current_setting('app.tenant_id',true),'');
  workspace_scope pg_catalog.text := NULLIF(pg_catalog.current_setting('app.workspace_id',true),'');
  job_scope pg_catalog.text := NULLIF(pg_catalog.current_setting('app.job_id',true),'');
  request_row record;
  version_row record;
  now_ts pg_catalog.timestamptz := pg_catalog.statement_timestamp();
BEGIN
  IF p_request_id IS NULL OR p_request_id !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$' THEN
    RETURN;
  END IF;
  IF NOT public.novatrade_l03_worker_authorized('document_retention:delete') THEN
    RETURN;
  END IF;
  IF job_scope IS DISTINCT FROM p_request_id THEN
    RETURN;
  END IF;

  SELECT * INTO request_row FROM public.document_deletion_requests AS request
  WHERE request.tenant_id=tenant_scope::pg_catalog.uuid AND request.workspace_id=workspace_scope::pg_catalog.uuid
    AND request.id=p_request_id::pg_catalog.uuid
  FOR UPDATE;
  IF NOT FOUND THEN RETURN; END IF;

  SELECT * INTO version_row FROM public.document_versions AS version
  WHERE version.tenant_id=request_row.tenant_id AND version.workspace_id=request_row.workspace_id
    AND version.document_id=request_row.document_id AND version.id=request_row.version_id
  FOR UPDATE;
  IF NOT FOUND THEN RETURN; END IF;

  IF request_row.state='applied' THEN
    RETURN QUERY SELECT 'replay'::pg_catalog.text,request_row.id,version_row.status;
    RETURN;
  END IF;
  IF request_row.state<>'pending' OR version_row.status<>'deletion_pending' THEN
    RETURN;
  END IF;

  -- Arm the transaction-local deletion flag: the only sanctioned DELETE path
  -- through the append-only knowledge guards, bound to this fenced request.
  PERFORM pg_catalog.set_config('app.l03_knowledge_delete','granted',true);

  -- Derived render-safe content is removed before the tombstone is recorded.
  -- Foreign-key order: support edges, then review decisions, then claim
  -- versions, then claim roots, then citations, evidence, and artifacts.
  DELETE FROM public.knowledge_claim_evidence_edges AS edge
  WHERE edge.tenant_id=request_row.tenant_id AND edge.workspace_id=request_row.workspace_id
    AND EXISTS (
      SELECT 1 FROM public.knowledge_claim_versions AS claim_version
      WHERE claim_version.tenant_id=edge.tenant_id AND claim_version.workspace_id=edge.workspace_id
        AND claim_version.claim_version_id=edge.claim_version_id
        AND claim_version.document_id=request_row.document_id
        AND claim_version.version_id=request_row.version_id
    );
  DELETE FROM public.knowledge_claim_review_decisions AS decision
  WHERE decision.tenant_id=request_row.tenant_id AND decision.workspace_id=request_row.workspace_id
    AND EXISTS (
      SELECT 1 FROM public.knowledge_claims AS claim
      WHERE claim.tenant_id=decision.tenant_id AND claim.workspace_id=decision.workspace_id
        AND claim.claim_id=decision.claim_id
        AND claim.document_id=request_row.document_id
        AND claim.version_id=request_row.version_id
    );
  DELETE FROM public.knowledge_claim_versions AS claim_version
  WHERE claim_version.tenant_id=request_row.tenant_id AND claim_version.workspace_id=request_row.workspace_id
    AND claim_version.document_id=request_row.document_id AND claim_version.version_id=request_row.version_id;
  DELETE FROM public.knowledge_claims AS claim
  WHERE claim.tenant_id=request_row.tenant_id AND claim.workspace_id=request_row.workspace_id
    AND claim.document_id=request_row.document_id AND claim.version_id=request_row.version_id;
  DELETE FROM public.knowledge_citations AS citation
  WHERE citation.tenant_id=request_row.tenant_id AND citation.workspace_id=request_row.workspace_id
    AND citation.document_id=request_row.document_id AND citation.version_id=request_row.version_id;
  DELETE FROM public.knowledge_evidence_items AS evidence
  WHERE evidence.tenant_id=request_row.tenant_id AND evidence.workspace_id=request_row.workspace_id
    AND evidence.document_id=request_row.document_id AND evidence.version_id=request_row.version_id;
  DELETE FROM public.document_extraction_outputs AS output
  WHERE output.tenant_id=request_row.tenant_id AND output.workspace_id=request_row.workspace_id
    AND output.document_id=request_row.document_id AND output.version_id=request_row.version_id;

  UPDATE public.document_versions AS version
  SET status='deleted'
  WHERE version.tenant_id=request_row.tenant_id AND version.workspace_id=request_row.workspace_id
    AND version.document_id=request_row.document_id AND version.id=request_row.version_id
    AND version.status='deletion_pending';
  IF NOT FOUND THEN RETURN; END IF;

  UPDATE public.document_deletion_requests AS request
  SET state='applied',resolved_at=now_ts
  WHERE request.id=request_row.id AND request.state='pending';

  INSERT INTO public.document_lifecycle_events(
    tenant_id,workspace_id,document_id,version_id,actor_kind,actor_membership_id,
    from_state,to_state,reason_code,correlation_id)
  VALUES (request_row.tenant_id,request_row.workspace_id,request_row.document_id,request_row.version_id,
    'worker',NULL,'deletion_pending','deleted',request_row.reason_code,
    pg_catalog.current_setting('app.correlation_id',true));

  RETURN QUERY SELECT 'applied'::pg_catalog.text,request_row.id,'deleted'::pg_catalog.text;
EXCEPTION
  WHEN unique_violation OR check_violation OR foreign_key_violation OR raise_exception THEN
    RETURN;
END;
$fn$;

COMMENT ON FUNCTION public.novatrade_apply_document_deletion(pg_catalog.text) IS
  'L-03 worker deletion application; removes derived knowledge rows and tombstones the version.';

-- ---------------------------------------------------------------------------
-- Knowledge claim review. A reviewer decision appends a review decision row
-- and a superseding claim version carrying the outcome; the claim root
-- pointer moves only here.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.novatrade_review_knowledge_claim(
  p_tenant_id pg_catalog.text,
  p_workspace_id pg_catalog.text,
  p_claim_id pg_catalog.text,
  p_claim_version_id pg_catalog.text,
  p_decision_id pg_catalog.text,
  p_action pg_catalog.text,
  p_reason_code pg_catalog.text,
  p_outcome pg_catalog.jsonb
)
RETURNS TABLE (
  kind pg_catalog.text,
  claim_id pg_catalog.text,
  claim_version_id pg_catalog.text,
  outcome_claim_version_id pg_catalog.text,
  review_state pg_catalog.text
)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog AS $fn$
DECLARE
  tenant_uuid pg_catalog.uuid;
  workspace_uuid pg_catalog.uuid;
  reviewer_uuid pg_catalog.uuid;
  claim_row record;
  version_row record;
  outcome_version pg_catalog.text;
  outcome_state pg_catalog.text;
  outcome_value pg_catalog.text;
  outcome_unit pg_catalog.text;
  outcome_uncertainty pg_catalog.text;
  outcome_confidence pg_catalog.int4;
  next_version pg_catalog.int4;
BEGIN
  IF p_tenant_id IS NULL OR p_tenant_id !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
     OR p_workspace_id IS NULL OR p_workspace_id !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
     OR p_claim_id IS NULL OR p_claim_id !~ '^claim:[0-9a-f]{64}$'
     OR p_claim_version_id IS NULL OR p_claim_version_id !~ '^claim-version:[0-9a-f]{64}$'
     OR p_decision_id IS NULL OR p_decision_id !~ '^decision:[0-9a-f]{64}$'
     OR p_action IS NULL OR p_action NOT IN ('approve','edit','reject')
     OR p_reason_code IS NULL OR pg_catalog.char_length(p_reason_code) NOT BETWEEN 1 AND 128
     OR p_reason_code<>pg_catalog.btrim(p_reason_code) OR p_reason_code ~ '[[:cntrl:]]'
  THEN
    RETURN;
  END IF;
  IF NULLIF(pg_catalog.current_setting('app.tenant_id',true),'') IS DISTINCT FROM p_tenant_id
     OR NULLIF(pg_catalog.current_setting('app.workspace_id',true),'') IS DISTINCT FROM p_workspace_id THEN
    RETURN;
  END IF;
  -- knowledge:review is conditional for manager roles and allowed for
  -- reviewer; researcher is denied. The claim-state binding below is the
  -- durable condition this boundary enforces.
  IF NOT public.novatrade_l03_member_lock(ARRAY['owner','admin','strategist_manager','reviewer']) THEN
    RETURN;
  END IF;

  tenant_uuid := p_tenant_id::pg_catalog.uuid;
  workspace_uuid := p_workspace_id::pg_catalog.uuid;
  reviewer_uuid := pg_catalog.current_setting('app.membership_id',true)::pg_catalog.uuid;

  SELECT * INTO claim_row FROM public.knowledge_claims AS claim
  WHERE claim.tenant_id=tenant_uuid AND claim.workspace_id=workspace_uuid AND claim.claim_id=p_claim_id
  FOR UPDATE;
  IF NOT FOUND OR claim_row.current_version_id IS DISTINCT FROM p_claim_version_id THEN
    RETURN;
  END IF;

  SELECT * INTO version_row FROM public.knowledge_claim_versions AS claim_version
  WHERE claim_version.tenant_id=tenant_uuid AND claim_version.workspace_id=workspace_uuid
    AND claim_version.claim_version_id=p_claim_version_id AND claim_version.claim_id=p_claim_id;
  IF NOT FOUND OR version_row.review_state<>'proposed' THEN
    RETURN;
  END IF;

  outcome_state := CASE p_action WHEN 'reject' THEN 'rejected' ELSE 'accepted' END;
  outcome_value := version_row.value;
  outcome_unit := version_row.unit;
  outcome_uncertainty := version_row.uncertainty;
  outcome_confidence := version_row.confidence_basis_points;

  IF p_action='edit' THEN
    IF p_outcome IS NULL OR pg_catalog.jsonb_typeof(p_outcome)<>'object' THEN
      RETURN;
    END IF;
    outcome_value := coalesce(p_outcome->>'value',version_row.value);
    outcome_unit := CASE WHEN p_outcome ? 'unit' THEN p_outcome->>'unit' ELSE version_row.unit END;
    outcome_uncertainty := CASE WHEN p_outcome ? 'uncertainty' THEN p_outcome->>'uncertainty' ELSE version_row.uncertainty END;
    outcome_confidence := CASE WHEN pg_catalog.jsonb_typeof(p_outcome->'confidenceBasisPoints')='number'
      THEN (p_outcome->>'confidenceBasisPoints')::pg_catalog.int4 ELSE version_row.confidence_basis_points END;
    IF outcome_value IS NULL OR pg_catalog.char_length(outcome_value) NOT BETWEEN 1 AND 2048
       OR (outcome_unit IS NOT NULL AND pg_catalog.char_length(outcome_unit) NOT BETWEEN 1 AND 64)
       OR (outcome_uncertainty IS NOT NULL AND pg_catalog.char_length(outcome_uncertainty) NOT BETWEEN 1 AND 1000)
       OR outcome_confidence IS NULL OR outcome_confidence NOT BETWEEN 0 AND 10000 THEN
      RETURN;
    END IF;
  END IF;

  next_version := version_row.claim_version+1;
  outcome_version := 'claim-version:' || pg_catalog.encode(extensions.digest(
    'knowledge-claim-version-v1|' || p_claim_id || '|' || next_version::pg_catalog.text || '|'
      || version_row.document_id::pg_catalog.text || '|' || outcome_state || '|'
      || outcome_value || '|' || coalesce(outcome_unit,'') || '|' || p_reason_code || '|'
      || reviewer_uuid::pg_catalog.text || '|' || p_decision_id,
    'sha256'),'hex');

  INSERT INTO public.knowledge_claim_versions(
    tenant_id,workspace_id,claim_version_id,claim_id,document_id,version_id,claim_version,
    claim_class,subject,predicate,value,unit,polarity,material,confidence_basis_points,uncertainty,
    claim_status,review_state,reviewer_id,review_reason,supersedes_claim_version_id,
    citation_ids,evidence_ids,extraction_job_id)
  VALUES (
    tenant_uuid,workspace_uuid,outcome_version,p_claim_id,version_row.document_id,version_row.version_id,
    next_version,version_row.claim_class,version_row.subject,version_row.predicate,
    outcome_value,outcome_unit,version_row.polarity,version_row.material,outcome_confidence,
    outcome_uncertainty,version_row.claim_status,outcome_state,reviewer_uuid,p_reason_code,
    p_claim_version_id,version_row.citation_ids,version_row.evidence_ids,version_row.extraction_job_id);

  UPDATE public.knowledge_claims AS claim
  SET current_version_id=outcome_version,updated_at=pg_catalog.statement_timestamp()
  WHERE claim.tenant_id=tenant_uuid AND claim.workspace_id=workspace_uuid AND claim.claim_id=p_claim_id
    AND claim.current_version_id=p_claim_version_id;
  IF NOT FOUND THEN RETURN; END IF;

  INSERT INTO public.knowledge_claim_review_decisions(
    tenant_id,workspace_id,decision_id,claim_id,claim_version_id,outcome_claim_version_id,
    action,reason_code,reviewer_membership_id)
  VALUES (tenant_uuid,workspace_uuid,p_decision_id,p_claim_id,p_claim_version_id,
    outcome_version,p_action,p_reason_code,reviewer_uuid);

  RETURN QUERY SELECT 'applied'::pg_catalog.text,p_claim_id,p_claim_version_id,
    outcome_version,outcome_state;
EXCEPTION
  WHEN unique_violation OR check_violation OR foreign_key_violation OR raise_exception THEN
    RETURN;
END;
$fn$;

COMMENT ON FUNCTION public.novatrade_review_knowledge_claim(
  pg_catalog.text,pg_catalog.text,pg_catalog.text,pg_catalog.text,pg_catalog.text,
  pg_catalog.text,pg_catalog.text,pg_catalog.jsonb) IS
  'L-03 member claim review; approve/edit/reject appends a superseding claim version and decision row.';

-- ---------------------------------------------------------------------------
-- Member knowledge reads. Every result is render-safe and scoped to the
-- session tenant/workspace; raw bytes and storage internals never leave.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.novatrade_list_knowledge_documents(
  p_tenant_id pg_catalog.text,
  p_workspace_id pg_catalog.text
)
RETURNS TABLE (
  document_id pg_catalog.uuid,
  version_id pg_catalog.uuid,
  source_kind pg_catalog.text,
  original_name pg_catalog.text,
  format pg_catalog.text,
  media_type pg_catalog.text,
  declared_byte_size pg_catalog.int8,
  checksum pg_catalog.text,
  scanner_policy_version pg_catalog.text,
  state pg_catalog.text,
  scan_state pg_catalog.text,
  extraction_state pg_catalog.text,
  extraction_job_id pg_catalog.uuid,
  evidence_count pg_catalog.int8,
  claim_count pg_catalog.int8,
  created_at pg_catalog.timestamptz,
  updated_at pg_catalog.timestamptz
)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $fn$
BEGIN
  IF p_tenant_id IS NULL OR p_tenant_id !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
     OR p_workspace_id IS NULL OR p_workspace_id !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
  THEN
    RETURN;
  END IF;
  IF NULLIF(pg_catalog.current_setting('app.tenant_id',true),'') IS DISTINCT FROM p_tenant_id
     OR NULLIF(pg_catalog.current_setting('app.workspace_id',true),'') IS DISTINCT FROM p_workspace_id THEN
    RETURN;
  END IF;
  IF NOT public.novatrade_l03_member_authorized(ARRAY['owner','admin','strategist_manager','researcher','reviewer','outreach_operator','analyst_read_only']) THEN
    RETURN;
  END IF;

  RETURN QUERY
  SELECT version.document_id,version.id,document.source_kind,version.original_name,version.format,
    version.media_type,version.declared_byte_size,version.checksum,version.scanner_policy_version,
    version.status,
    scan.status,extraction.status,extraction.id,
    (SELECT pg_catalog.count(*) FROM public.knowledge_evidence_items AS evidence
     WHERE evidence.tenant_id=version.tenant_id AND evidence.workspace_id=version.workspace_id
       AND evidence.document_id=version.document_id AND evidence.version_id=version.id),
    (SELECT pg_catalog.count(DISTINCT claim.claim_id) FROM public.knowledge_claims AS claim
     WHERE claim.tenant_id=version.tenant_id AND claim.workspace_id=version.workspace_id
       AND claim.document_id=version.document_id AND claim.version_id=version.id),
    version.created_at,version.updated_at
  FROM public.document_versions AS version
  JOIN public.documents AS document
    ON document.tenant_id=version.tenant_id AND document.workspace_id=version.workspace_id
   AND document.id=version.document_id
  LEFT JOIN public.document_scan_jobs AS scan
    ON scan.tenant_id=version.tenant_id AND scan.workspace_id=version.workspace_id
   AND scan.document_id=version.document_id AND scan.version_id=version.id
  LEFT JOIN public.document_extraction_jobs AS extraction
    ON extraction.tenant_id=version.tenant_id AND extraction.workspace_id=version.workspace_id
   AND extraction.document_id=version.document_id AND extraction.version_id=version.id
  WHERE version.tenant_id=p_tenant_id::pg_catalog.uuid
    AND version.workspace_id=p_workspace_id::pg_catalog.uuid
  ORDER BY version.created_at ASC, version.id ASC
  LIMIT 500;
EXCEPTION WHEN others THEN
  RETURN;
END;
$fn$;

COMMENT ON FUNCTION public.novatrade_list_knowledge_documents(pg_catalog.text,pg_catalog.text) IS
  'L-03 member document list for the knowledge surface; render-safe facts only.';

CREATE OR REPLACE FUNCTION public.novatrade_get_document_knowledge(
  p_tenant_id pg_catalog.text,
  p_workspace_id pg_catalog.text,
  p_document_id pg_catalog.text,
  p_version_id pg_catalog.text
)
RETURNS TABLE (
  evidence_id pg_catalog.text,
  document_id pg_catalog.uuid,
  version_id pg_catalog.uuid,
  block_ordinal pg_catalog.int4,
  source_locator pg_catalog.jsonb,
  quote pg_catalog.text,
  quote_hash pg_catalog.text,
  citation_id pg_catalog.text,
  claim_id pg_catalog.text,
  claim_version_id pg_catalog.text,
  claim_class pg_catalog.text,
  subject pg_catalog.text,
  predicate pg_catalog.text,
  value pg_catalog.text,
  unit pg_catalog.text,
  polarity pg_catalog.text,
  material pg_catalog.bool,
  review_state pg_catalog.text,
  review_reason pg_catalog.text
)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $fn$
BEGIN
  IF p_tenant_id IS NULL OR p_tenant_id !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
     OR p_workspace_id IS NULL OR p_workspace_id !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
     OR p_document_id IS NULL OR p_document_id !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
     OR p_version_id IS NULL OR p_version_id !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
  THEN
    RETURN;
  END IF;
  IF NULLIF(pg_catalog.current_setting('app.tenant_id',true),'') IS DISTINCT FROM p_tenant_id
     OR NULLIF(pg_catalog.current_setting('app.workspace_id',true),'') IS DISTINCT FROM p_workspace_id THEN
    RETURN;
  END IF;
  IF NOT public.novatrade_l03_member_authorized(ARRAY['owner','admin','strategist_manager','researcher','reviewer','outreach_operator','analyst_read_only']) THEN
    RETURN;
  END IF;

  RETURN QUERY
  SELECT evidence.evidence_id,evidence.document_id,evidence.version_id,evidence.block_ordinal,
    evidence.source_locator,evidence.quote,evidence.quote_hash,citation.citation_id,
    claim_version.claim_id,claim_version.claim_version_id,claim_version.claim_class,
    claim_version.subject,claim_version.predicate,claim_version.value,claim_version.unit,
    claim_version.polarity,claim_version.material,claim_version.review_state,claim_version.review_reason
  FROM public.knowledge_evidence_items AS evidence
  LEFT JOIN public.knowledge_citations AS citation
    ON citation.tenant_id=evidence.tenant_id AND citation.workspace_id=evidence.workspace_id
   AND citation.evidence_id=evidence.evidence_id
  LEFT JOIN public.knowledge_claim_evidence_edges AS edge
    ON edge.tenant_id=evidence.tenant_id AND edge.workspace_id=evidence.workspace_id
   AND edge.evidence_id=evidence.evidence_id
  LEFT JOIN public.knowledge_claim_versions AS claim_version
    ON claim_version.tenant_id=edge.tenant_id AND claim_version.workspace_id=edge.workspace_id
   AND claim_version.claim_version_id=edge.claim_version_id
  WHERE evidence.tenant_id=p_tenant_id::pg_catalog.uuid
    AND evidence.workspace_id=p_workspace_id::pg_catalog.uuid
    AND evidence.document_id=p_document_id::pg_catalog.uuid
    AND evidence.version_id=p_version_id::pg_catalog.uuid
  ORDER BY evidence.block_ordinal ASC, evidence.evidence_id ASC
  LIMIT 2000;
EXCEPTION WHEN others THEN
  RETURN;
END;
$fn$;

COMMENT ON FUNCTION public.novatrade_get_document_knowledge(pg_catalog.text,pg_catalog.text,pg_catalog.text,pg_catalog.text) IS
  'L-03 member evidence/citation/claim projection for one document version; render-safe only.';

CREATE OR REPLACE FUNCTION public.novatrade_resolve_knowledge_citation(
  p_tenant_id pg_catalog.text,
  p_workspace_id pg_catalog.text,
  p_citation_id pg_catalog.text
)
RETURNS TABLE (
  citation_id pg_catalog.text,
  evidence_id pg_catalog.text,
  document_id pg_catalog.uuid,
  version_id pg_catalog.uuid,
  quote pg_catalog.text,
  quote_hash pg_catalog.text,
  source_locator pg_catalog.jsonb,
  version_state pg_catalog.text
)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $fn$
BEGIN
  IF p_tenant_id IS NULL OR p_tenant_id !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
     OR p_workspace_id IS NULL OR p_workspace_id !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
     OR p_citation_id IS NULL OR p_citation_id !~ '^citation:[0-9a-f]{64}$'
  THEN
    RETURN;
  END IF;
  IF NULLIF(pg_catalog.current_setting('app.tenant_id',true),'') IS DISTINCT FROM p_tenant_id
     OR NULLIF(pg_catalog.current_setting('app.workspace_id',true),'') IS DISTINCT FROM p_workspace_id THEN
    RETURN;
  END IF;
  IF NOT public.novatrade_l03_member_authorized(ARRAY['owner','admin','strategist_manager','researcher','reviewer','outreach_operator','analyst_read_only']) THEN
    RETURN;
  END IF;

  RETURN QUERY
  SELECT citation.citation_id,citation.evidence_id,citation.document_id,citation.version_id,
    citation.quote,citation.quote_hash,citation.source_locator,version.status
  FROM public.knowledge_citations AS citation
  JOIN public.document_versions AS version
    ON version.tenant_id=citation.tenant_id AND version.workspace_id=citation.workspace_id
   AND version.document_id=citation.document_id AND version.id=citation.version_id
  WHERE citation.tenant_id=p_tenant_id::pg_catalog.uuid
    AND citation.workspace_id=p_workspace_id::pg_catalog.uuid
    AND citation.citation_id=p_citation_id
    AND version.status IN ('clean','extracting','ready','extraction_failed');
EXCEPTION WHEN others THEN
  RETURN;
END;
$fn$;

COMMENT ON FUNCTION public.novatrade_resolve_knowledge_citation(pg_catalog.text,pg_catalog.text,pg_catalog.text) IS
  'L-03 tenant-scoped citation resolution; deleted or pre-clean versions do not resolve.';

-- ---------------------------------------------------------------------------
-- Worker retention subject read. The evaluator needs the version's durable
-- facts; the worker supplies only identities and the definer derives the rest.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.novatrade_get_document_retention_subject(
  p_document_id pg_catalog.text,
  p_version_id pg_catalog.text
)
RETURNS TABLE (
  document_id pg_catalog.uuid,
  version_id pg_catalog.uuid,
  version_state pg_catalog.text,
  object_key pg_catalog.text,
  checksum pg_catalog.text,
  is_current_version pg_catalog.bool,
  retention_expires_at pg_catalog.timestamptz,
  prior_input_sha256 pg_catalog.text,
  policy_version pg_catalog.text,
  legal_hold_active pg_catalog.bool,
  support_hold_active pg_catalog.bool
)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $fn$
DECLARE
  tenant_scope pg_catalog.text := NULLIF(pg_catalog.current_setting('app.tenant_id',true),'');
  workspace_scope pg_catalog.text := NULLIF(pg_catalog.current_setting('app.workspace_id',true),'');
  version_row record;
  policy_row record;
BEGIN
  IF p_document_id IS NULL OR p_document_id !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
     OR p_version_id IS NULL OR p_version_id !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
  THEN
    RETURN;
  END IF;
  IF NOT public.novatrade_l03_worker_authorized('document_retention:evaluate') THEN
    RETURN;
  END IF;

  SELECT * INTO version_row FROM public.document_versions AS version
  WHERE version.tenant_id=tenant_scope::pg_catalog.uuid
    AND version.workspace_id=workspace_scope::pg_catalog.uuid
    AND version.document_id=p_document_id::pg_catalog.uuid
    AND version.id=p_version_id::pg_catalog.uuid;
  IF NOT FOUND THEN RETURN; END IF;

  SELECT * INTO policy_row FROM public.tenant_policies AS policy
  WHERE policy.tenant_id=version_row.tenant_id;

  RETURN QUERY
  SELECT version_row.document_id,version_row.id,version_row.status,version_row.object_key,
    version_row.checksum,
    version_row.id=(
      SELECT latest.id FROM public.document_versions AS latest
      WHERE latest.tenant_id=version_row.tenant_id AND latest.workspace_id=version_row.workspace_id
        AND latest.document_id=version_row.document_id
      ORDER BY latest.created_at DESC, latest.id DESC LIMIT 1
    ),
    coalesce(version_row.finalized_at,version_row.created_at)
      + make_interval(days => coalesce(policy_row.raw_source_retention_days,180)),
    (SELECT evaluation.input_sha256 FROM public.document_retention_evaluations AS evaluation
     WHERE evaluation.tenant_id=version_row.tenant_id AND evaluation.workspace_id=version_row.workspace_id
       AND evaluation.document_id=version_row.document_id AND evaluation.version_id=version_row.id
     LIMIT 1),
    'tenant-policies-v'||coalesce(policy_row.version,0)::pg_catalog.text,
    false,false;
EXCEPTION WHEN others THEN
  RETURN;
END;
$fn$;

COMMENT ON FUNCTION public.novatrade_get_document_retention_subject(pg_catalog.text,pg_catalog.text) IS
  'L-03 fenced retention subject read; derives version facts and the tenant retention deadline.';

-- ---------------------------------------------------------------------------
-- Worker deletion request read. The apply worker resolves the fenced request
-- to its bound version facts before removing the private object.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.novatrade_get_document_deletion_request(
  p_request_id pg_catalog.text
)
RETURNS TABLE (
  request_id pg_catalog.uuid,
  document_id pg_catalog.uuid,
  version_id pg_catalog.uuid,
  state pg_catalog.text,
  version_state pg_catalog.text,
  object_key pg_catalog.text
)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $fn$
DECLARE
  tenant_scope pg_catalog.text := NULLIF(pg_catalog.current_setting('app.tenant_id',true),'');
  workspace_scope pg_catalog.text := NULLIF(pg_catalog.current_setting('app.workspace_id',true),'');
  job_scope pg_catalog.text := NULLIF(pg_catalog.current_setting('app.job_id',true),'');
  request_row record;
BEGIN
  IF p_request_id IS NULL OR p_request_id !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$' THEN
    RETURN;
  END IF;
  IF NOT public.novatrade_l03_worker_authorized('document_retention:delete') THEN
    RETURN;
  END IF;
  IF job_scope IS DISTINCT FROM p_request_id THEN
    RETURN;
  END IF;

  SELECT request.id,request.document_id,request.version_id,request.state,
    version.status,version.object_key INTO request_row
  FROM public.document_deletion_requests AS request
  JOIN public.document_versions AS version
    ON version.tenant_id=request.tenant_id AND version.workspace_id=request.workspace_id
   AND version.document_id=request.document_id AND version.id=request.version_id
  WHERE request.tenant_id=tenant_scope::pg_catalog.uuid
    AND request.workspace_id=workspace_scope::pg_catalog.uuid
    AND request.id=p_request_id::pg_catalog.uuid;
  IF NOT FOUND THEN RETURN; END IF;

  RETURN QUERY SELECT request_row.id,request_row.document_id,request_row.version_id,
    request_row.state,request_row.status,request_row.object_key;
EXCEPTION WHEN others THEN
  RETURN;
END;
$fn$;

COMMENT ON FUNCTION public.novatrade_get_document_deletion_request(pg_catalog.text) IS
  'L-03 fenced deletion request read bound to the worker job scope.';

-- ---------------------------------------------------------------------------
-- Discovery surfaces. Each sweep runs under the discovery predicate (no job
-- binding, optional tenant/workspace selector) and returns only identifiers;
-- the follow-up processing scope then binds to the returned row before any
-- mutation. p_limit is a bounded text integer so the worker cannot widen the
-- sweep beyond 100 rows per pass.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.novatrade_discover_document_scan_lease_losses(
  p_limit pg_catalog.text
)
RETURNS TABLE (
  job_id pg_catalog.uuid,
  tenant_id pg_catalog.uuid,
  workspace_id pg_catalog.uuid
)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $fn$
DECLARE
  tenant_scope pg_catalog.text := NULLIF(pg_catalog.current_setting('app.tenant_id',true),'');
  workspace_scope pg_catalog.text := NULLIF(pg_catalog.current_setting('app.workspace_id',true),'');
  row_limit pg_catalog.int4;
BEGIN
  IF p_limit IS NULL OR p_limit !~ '^[1-9][0-9]{0,2}$' THEN RETURN; END IF;
  row_limit := least(p_limit::pg_catalog.int4,100);
  IF NOT public.novatrade_l03_worker_discovery('document_scan:recover') THEN RETURN; END IF;

  RETURN QUERY
  SELECT job.id,job.tenant_id,job.workspace_id
  FROM public.document_scan_jobs AS job
  WHERE job.status='running' AND job.lease_expires_at<=pg_catalog.statement_timestamp()
    AND (tenant_scope IS NULL OR job.tenant_id=tenant_scope::pg_catalog.uuid)
    AND (workspace_scope IS NULL OR job.workspace_id=workspace_scope::pg_catalog.uuid)
  ORDER BY job.lease_expires_at ASC,job.id ASC
  LIMIT row_limit;
EXCEPTION WHEN others THEN
  RETURN;
END;
$fn$;

COMMENT ON FUNCTION public.novatrade_discover_document_scan_lease_losses(pg_catalog.text) IS
  'L-03 discovery of expired running scan leases for the recovery sweep.';

CREATE OR REPLACE FUNCTION public.novatrade_discover_document_extraction_lease_losses(
  p_limit pg_catalog.text
)
RETURNS TABLE (
  job_id pg_catalog.uuid,
  tenant_id pg_catalog.uuid,
  workspace_id pg_catalog.uuid
)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $fn$
DECLARE
  tenant_scope pg_catalog.text := NULLIF(pg_catalog.current_setting('app.tenant_id',true),'');
  workspace_scope pg_catalog.text := NULLIF(pg_catalog.current_setting('app.workspace_id',true),'');
  row_limit pg_catalog.int4;
BEGIN
  IF p_limit IS NULL OR p_limit !~ '^[1-9][0-9]{0,2}$' THEN RETURN; END IF;
  row_limit := least(p_limit::pg_catalog.int4,100);
  IF NOT public.novatrade_l03_worker_discovery('document_extraction:recover') THEN RETURN; END IF;

  RETURN QUERY
  SELECT job.id,job.tenant_id,job.workspace_id
  FROM public.document_extraction_jobs AS job
  WHERE job.status='running' AND job.lease_expires_at<=pg_catalog.statement_timestamp()
    AND (tenant_scope IS NULL OR job.tenant_id=tenant_scope::pg_catalog.uuid)
    AND (workspace_scope IS NULL OR job.workspace_id=workspace_scope::pg_catalog.uuid)
  ORDER BY job.lease_expires_at ASC,job.id ASC
  LIMIT row_limit;
EXCEPTION WHEN others THEN
  RETURN;
END;
$fn$;

COMMENT ON FUNCTION public.novatrade_discover_document_extraction_lease_losses(pg_catalog.text) IS
  'L-03 discovery of expired running extraction leases for the recovery sweep.';

CREATE OR REPLACE FUNCTION public.novatrade_discover_document_retention_subjects(
  p_limit pg_catalog.text
)
RETURNS TABLE (
  tenant_id pg_catalog.uuid,
  workspace_id pg_catalog.uuid,
  document_id pg_catalog.uuid,
  version_id pg_catalog.uuid
)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $fn$
DECLARE
  tenant_scope pg_catalog.text := NULLIF(pg_catalog.current_setting('app.tenant_id',true),'');
  workspace_scope pg_catalog.text := NULLIF(pg_catalog.current_setting('app.workspace_id',true),'');
  row_limit pg_catalog.int4;
BEGIN
  IF p_limit IS NULL OR p_limit !~ '^[1-9][0-9]{0,2}$' THEN RETURN; END IF;
  row_limit := least(p_limit::pg_catalog.int4,100);
  IF NOT public.novatrade_l03_worker_discovery('document_retention:evaluate') THEN RETURN; END IF;

  -- Only settled, non-current, unevaluated versions past their deadline are
  -- returned: a recorded 'retain' is append-only, so transient states
  -- (in-flight, clean, current, deletion in progress) must never be evaluated
  -- early or they would be permanently exempted from later purges.
  RETURN QUERY
  SELECT version.tenant_id,version.workspace_id,version.document_id,version.id
  FROM public.document_versions AS version
  LEFT JOIN public.tenant_policies AS policy ON policy.tenant_id=version.tenant_id
  WHERE version.status IN ('ready','extraction_failed','infected','scanner_error','rejected','expired')
    AND coalesce(version.finalized_at,version.created_at)
      + make_interval(days => coalesce(policy.raw_source_retention_days,180))
      <= pg_catalog.statement_timestamp()
    AND version.id<>(
      SELECT latest.id FROM public.document_versions AS latest
      WHERE latest.tenant_id=version.tenant_id AND latest.workspace_id=version.workspace_id
        AND latest.document_id=version.document_id
      ORDER BY latest.created_at DESC,latest.id DESC
      LIMIT 1)
    AND NOT EXISTS (
      SELECT 1 FROM public.document_retention_evaluations AS evaluation
      WHERE evaluation.tenant_id=version.tenant_id AND evaluation.version_id=version.id)
    AND (tenant_scope IS NULL OR version.tenant_id=tenant_scope::pg_catalog.uuid)
    AND (workspace_scope IS NULL OR version.workspace_id=workspace_scope::pg_catalog.uuid)
  ORDER BY coalesce(version.finalized_at,version.created_at) ASC,version.id ASC
  LIMIT row_limit;
EXCEPTION WHEN others THEN
  RETURN;
END;
$fn$;

COMMENT ON FUNCTION public.novatrade_discover_document_retention_subjects(pg_catalog.text) IS
  'L-03 discovery of due, settled, unevaluated document versions for the retention sweep.';

CREATE OR REPLACE FUNCTION public.novatrade_discover_document_deletion_requests(
  p_limit pg_catalog.text
)
RETURNS TABLE (
  request_id pg_catalog.uuid,
  tenant_id pg_catalog.uuid,
  workspace_id pg_catalog.uuid
)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $fn$
DECLARE
  tenant_scope pg_catalog.text := NULLIF(pg_catalog.current_setting('app.tenant_id',true),'');
  workspace_scope pg_catalog.text := NULLIF(pg_catalog.current_setting('app.workspace_id',true),'');
  row_limit pg_catalog.int4;
BEGIN
  IF p_limit IS NULL OR p_limit !~ '^[1-9][0-9]{0,2}$' THEN RETURN; END IF;
  row_limit := least(p_limit::pg_catalog.int4,100);
  IF NOT public.novatrade_l03_worker_discovery('document_retention:delete') THEN RETURN; END IF;

  RETURN QUERY
  SELECT request.id,request.tenant_id,request.workspace_id
  FROM public.document_deletion_requests AS request
  JOIN public.document_versions AS version
    ON version.tenant_id=request.tenant_id AND version.workspace_id=request.workspace_id
   AND version.document_id=request.document_id AND version.id=request.version_id
  WHERE request.state='pending' AND version.status='deletion_pending'
    AND (tenant_scope IS NULL OR request.tenant_id=tenant_scope::pg_catalog.uuid)
    AND (workspace_scope IS NULL OR request.workspace_id=workspace_scope::pg_catalog.uuid)
  ORDER BY request.created_at ASC,request.id ASC
  LIMIT row_limit;
EXCEPTION WHEN others THEN
  RETURN;
END;
$fn$;

COMMENT ON FUNCTION public.novatrade_discover_document_deletion_requests(pg_catalog.text) IS
  'L-03 discovery of pending deletion requests whose versions await the apply sweep.';

-- ---------------------------------------------------------------------------
-- Security lockdown for the new tables.
-- ---------------------------------------------------------------------------
DO $security$
DECLARE t text; f text;
BEGIN
  FOREACH t IN ARRAY ARRAY['document_extraction_outputs','knowledge_evidence_items',
    'knowledge_citations','knowledge_claims','knowledge_claim_versions',
    'knowledge_claim_evidence_edges','knowledge_claim_review_decisions'] LOOP
    EXECUTE pg_catalog.format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY',t);
    EXECUTE pg_catalog.format('ALTER TABLE public.%I FORCE ROW LEVEL SECURITY',t);
    EXECUTE pg_catalog.format('REVOKE ALL ON TABLE public.%I FROM PUBLIC',t);
    IF pg_catalog.to_regrole('anon') IS NOT NULL THEN EXECUTE pg_catalog.format('REVOKE ALL ON TABLE public.%I FROM anon',t); END IF;
    IF pg_catalog.to_regrole('authenticated') IS NOT NULL THEN EXECUTE pg_catalog.format('REVOKE ALL ON TABLE public.%I FROM authenticated',t); END IF;
  END LOOP;
  FOREACH f IN ARRAY ARRAY[
    'novatrade_l03_worker_discovery','novatrade_claim_document_scan_job',
    'novatrade_persist_document_scan_result','novatrade_recover_document_scan_lease',
    'novatrade_request_document_extraction','novatrade_cancel_document_extraction',
    'novatrade_claim_document_extraction_job','novatrade_finalize_document_extraction',
    'novatrade_recover_document_extraction_lease','novatrade_record_document_retention_evaluation',
    'novatrade_request_document_deletion','novatrade_apply_document_deletion',
    'novatrade_review_knowledge_claim','novatrade_list_knowledge_documents',
    'novatrade_get_document_knowledge','novatrade_resolve_knowledge_citation',
    'novatrade_get_document_retention_subject','novatrade_get_document_deletion_request',
    'novatrade_discover_document_scan_lease_losses','novatrade_discover_document_extraction_lease_losses',
    'novatrade_discover_document_retention_subjects','novatrade_discover_document_deletion_requests'] LOOP
    EXECUTE pg_catalog.format('REVOKE ALL ON FUNCTION public.%I FROM PUBLIC',f);
    IF pg_catalog.to_regrole('anon') IS NOT NULL THEN EXECUTE pg_catalog.format('REVOKE ALL ON FUNCTION public.%I FROM anon',f); END IF;
    IF pg_catalog.to_regrole('authenticated') IS NOT NULL THEN EXECUTE pg_catalog.format('REVOKE ALL ON FUNCTION public.%I FROM authenticated',f); END IF;
  END LOOP;
END;
$security$;

-- Append-only guards on the knowledge surfaces; the claim root pointer is
-- mutable only through the review RPC's supersession. The single sanctioned
-- DELETE path is the fenced deletion worker, which arms a transaction-local
-- flag inside novatrade_apply_document_deletion — the definer role's table
-- grants mean no other caller can reach this branch.
CREATE OR REPLACE FUNCTION public.novatrade_l03_knowledge_append_only()
RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $fn$
BEGIN
  IF TG_OP='DELETE'
     AND pg_catalog.current_setting('app.l03_knowledge_delete',true)='granted' THEN
    RETURN OLD;
  END IF;
  RAISE EXCEPTION '% append-only', TG_TABLE_NAME USING ERRCODE='P0001';
END;
$fn$;

DROP TRIGGER IF EXISTS trg_document_extraction_outputs_append_only ON public.document_extraction_outputs;
CREATE TRIGGER trg_document_extraction_outputs_append_only BEFORE UPDATE OR DELETE ON public.document_extraction_outputs
  FOR EACH ROW EXECUTE FUNCTION public.novatrade_l03_knowledge_append_only();
DROP TRIGGER IF EXISTS trg_knowledge_evidence_items_append_only ON public.knowledge_evidence_items;
CREATE TRIGGER trg_knowledge_evidence_items_append_only BEFORE UPDATE OR DELETE ON public.knowledge_evidence_items
  FOR EACH ROW EXECUTE FUNCTION public.novatrade_l03_knowledge_append_only();
DROP TRIGGER IF EXISTS trg_knowledge_citations_append_only ON public.knowledge_citations;
CREATE TRIGGER trg_knowledge_citations_append_only BEFORE UPDATE OR DELETE ON public.knowledge_citations
  FOR EACH ROW EXECUTE FUNCTION public.novatrade_l03_knowledge_append_only();
DROP TRIGGER IF EXISTS trg_knowledge_claim_versions_append_only ON public.knowledge_claim_versions;
CREATE TRIGGER trg_knowledge_claim_versions_append_only BEFORE UPDATE OR DELETE ON public.knowledge_claim_versions
  FOR EACH ROW EXECUTE FUNCTION public.novatrade_l03_knowledge_append_only();
DROP TRIGGER IF EXISTS trg_knowledge_claim_edges_append_only ON public.knowledge_claim_evidence_edges;
CREATE TRIGGER trg_knowledge_claim_edges_append_only BEFORE UPDATE OR DELETE ON public.knowledge_claim_evidence_edges
  FOR EACH ROW EXECUTE FUNCTION public.novatrade_l03_knowledge_append_only();
DROP TRIGGER IF EXISTS trg_knowledge_review_decisions_append_only ON public.knowledge_claim_review_decisions;
CREATE TRIGGER trg_knowledge_review_decisions_append_only BEFORE UPDATE OR DELETE ON public.knowledge_claim_review_decisions
  FOR EACH ROW EXECUTE FUNCTION public.novatrade_l03_knowledge_append_only();

-- knowledge_claims: only the current-version pointer and updated_at may move.
CREATE OR REPLACE FUNCTION public.novatrade_l03_knowledge_claim_guard()
RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $fn$
BEGIN
  IF TG_OP='DELETE' THEN
    -- The fenced deletion worker is the single sanctioned purge path.
    IF pg_catalog.current_setting('app.l03_knowledge_delete',true)='granted' THEN
      RETURN OLD;
    END IF;
    RAISE EXCEPTION 'knowledge_claims append-only' USING ERRCODE='P0001';
  END IF;
  IF ROW(NEW.tenant_id,NEW.workspace_id,NEW.claim_id,NEW.document_id,NEW.version_id,
    NEW.claim_class,NEW.subject,NEW.predicate,NEW.extraction_job_id,NEW.created_at)
    IS DISTINCT FROM ROW(OLD.tenant_id,OLD.workspace_id,OLD.claim_id,OLD.document_id,OLD.version_id,
    OLD.claim_class,OLD.subject,OLD.predicate,OLD.extraction_job_id,OLD.created_at)
    OR NEW.current_version_id=OLD.current_version_id
    OR NEW.updated_at<OLD.updated_at THEN
    RAISE EXCEPTION 'knowledge claim root transition is invalid' USING ERRCODE='P0001';
  END IF;
  RETURN NEW;
END;
$fn$;

DROP TRIGGER IF EXISTS trg_knowledge_claims_guard ON public.knowledge_claims;
CREATE TRIGGER trg_knowledge_claims_guard BEFORE UPDATE OR DELETE ON public.knowledge_claims
  FOR EACH ROW EXECUTE FUNCTION public.novatrade_l03_knowledge_claim_guard();

REVOKE ALL ON FUNCTION public.novatrade_l03_knowledge_append_only() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.novatrade_l03_knowledge_claim_guard() FROM PUBLIC;
DO $security$
DECLARE role_name text;
BEGIN
  FOREACH role_name IN ARRAY ARRAY['anon','authenticated'] LOOP
    IF pg_catalog.to_regrole(role_name) IS NOT NULL THEN
      EXECUTE pg_catalog.format('REVOKE ALL ON FUNCTION
        public.novatrade_l03_knowledge_append_only(),
        public.novatrade_l03_knowledge_claim_guard()
        FROM %I',role_name);
    END IF;
  END LOOP;
END;
$security$;

-- ---------------------------------------------------------------------------
-- Definer ownership and least-privilege grants. Every RPC executes under the
-- fenced definer role; the raw tenant tables stay unreachable to callers.
-- ---------------------------------------------------------------------------
ALTER FUNCTION public.novatrade_l03_worker_discovery(pg_catalog.text)
  OWNER TO novatrade_document_pipeline_definer;
ALTER FUNCTION public.novatrade_claim_document_scan_job(pg_catalog.text,pg_catalog.text)
  OWNER TO novatrade_document_pipeline_definer;
ALTER FUNCTION public.novatrade_persist_document_scan_result(
  pg_catalog.text,pg_catalog.text,pg_catalog.text,pg_catalog.text,pg_catalog.text,
  pg_catalog.text,pg_catalog.text,pg_catalog.text,pg_catalog.text,pg_catalog.bool)
  OWNER TO novatrade_document_pipeline_definer;
ALTER FUNCTION public.novatrade_recover_document_scan_lease(pg_catalog.text)
  OWNER TO novatrade_document_pipeline_definer;
ALTER FUNCTION public.novatrade_request_document_extraction(
  pg_catalog.text,pg_catalog.text,pg_catalog.text,pg_catalog.text,pg_catalog.text,
  pg_catalog.text,pg_catalog.text,pg_catalog.text,pg_catalog.text)
  OWNER TO novatrade_document_pipeline_definer;
ALTER FUNCTION public.novatrade_cancel_document_extraction(
  pg_catalog.text,pg_catalog.text,pg_catalog.text)
  OWNER TO novatrade_document_pipeline_definer;
ALTER FUNCTION public.novatrade_claim_document_extraction_job(pg_catalog.text,pg_catalog.text)
  OWNER TO novatrade_document_pipeline_definer;
ALTER FUNCTION public.novatrade_finalize_document_extraction(
  pg_catalog.text,pg_catalog.text,pg_catalog.text,pg_catalog.jsonb,
  pg_catalog.text,pg_catalog.text,pg_catalog.bool)
  OWNER TO novatrade_document_pipeline_definer;
ALTER FUNCTION public.novatrade_recover_document_extraction_lease(pg_catalog.text)
  OWNER TO novatrade_document_pipeline_definer;
ALTER FUNCTION public.novatrade_record_document_retention_evaluation(
  pg_catalog.text,pg_catalog.text,pg_catalog.text,pg_catalog.text,pg_catalog.text,
  pg_catalog.text,pg_catalog.text,pg_catalog.text)
  OWNER TO novatrade_document_pipeline_definer;
ALTER FUNCTION public.novatrade_request_document_deletion(
  pg_catalog.text,pg_catalog.text,pg_catalog.text,pg_catalog.text,pg_catalog.text,
  pg_catalog.text)
  OWNER TO novatrade_document_pipeline_definer;
ALTER FUNCTION public.novatrade_apply_document_deletion(pg_catalog.text)
  OWNER TO novatrade_document_pipeline_definer;
ALTER FUNCTION public.novatrade_review_knowledge_claim(
  pg_catalog.text,pg_catalog.text,pg_catalog.text,pg_catalog.text,pg_catalog.text,
  pg_catalog.text,pg_catalog.text,pg_catalog.jsonb)
  OWNER TO novatrade_document_pipeline_definer;
ALTER FUNCTION public.novatrade_list_knowledge_documents(
  pg_catalog.text,pg_catalog.text)
  OWNER TO novatrade_document_pipeline_definer;
ALTER FUNCTION public.novatrade_get_document_knowledge(
  pg_catalog.text,pg_catalog.text,pg_catalog.text,pg_catalog.text)
  OWNER TO novatrade_document_pipeline_definer;
ALTER FUNCTION public.novatrade_resolve_knowledge_citation(
  pg_catalog.text,pg_catalog.text,pg_catalog.text)
  OWNER TO novatrade_document_pipeline_definer;
ALTER FUNCTION public.novatrade_get_document_retention_subject(
  pg_catalog.text,pg_catalog.text)
  OWNER TO novatrade_document_pipeline_definer;
ALTER FUNCTION public.novatrade_get_document_deletion_request(pg_catalog.text)
  OWNER TO novatrade_document_pipeline_definer;
ALTER FUNCTION public.novatrade_discover_document_scan_lease_losses(pg_catalog.text)
  OWNER TO novatrade_document_pipeline_definer;
ALTER FUNCTION public.novatrade_discover_document_extraction_lease_losses(pg_catalog.text)
  OWNER TO novatrade_document_pipeline_definer;
ALTER FUNCTION public.novatrade_discover_document_retention_subjects(pg_catalog.text)
  OWNER TO novatrade_document_pipeline_definer;
ALTER FUNCTION public.novatrade_discover_document_deletion_requests(pg_catalog.text)
  OWNER TO novatrade_document_pipeline_definer;
ALTER FUNCTION public.novatrade_l03_knowledge_append_only()
  OWNER TO novatrade_document_pipeline_definer;
ALTER FUNCTION public.novatrade_l03_knowledge_claim_guard()
  OWNER TO novatrade_document_pipeline_definer;

GRANT SELECT ON TABLE public.documents,public.document_version_finalizations,
  public.tenant_policies
  TO novatrade_document_pipeline_definer;
GRANT SELECT,INSERT,DELETE ON TABLE public.document_extraction_outputs,
  public.knowledge_evidence_items,public.knowledge_citations,public.knowledge_claims,
  public.knowledge_claim_versions,public.knowledge_claim_evidence_edges,
  public.knowledge_claim_review_decisions
  TO novatrade_document_pipeline_definer;
GRANT UPDATE ON TABLE public.knowledge_claims
  TO novatrade_document_pipeline_definer;

-- ---------------------------------------------------------------------------
-- Migration receipt: the catalog asserts below are the durable proof that the
-- worker surface applied with its security posture intact.
-- ---------------------------------------------------------------------------
DO $receipt$
DECLARE
  rls_count pg_catalog.int4;
  policy_count pg_catalog.int4;
  function_count pg_catalog.int4;
  owned_count pg_catalog.int4;
  trigger_count pg_catalog.int4;
BEGIN
  SELECT count(*) INTO rls_count
  FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace
  WHERE n.nspname='public' AND c.relname IN (
    'document_extraction_outputs','knowledge_evidence_items','knowledge_citations',
    'knowledge_claims','knowledge_claim_versions','knowledge_claim_evidence_edges',
    'knowledge_claim_review_decisions'
  ) AND c.relrowsecurity AND c.relforcerowsecurity;
  SELECT count(*) INTO policy_count
  FROM pg_catalog.pg_policy p
  JOIN pg_catalog.pg_class c ON c.oid=p.polrelid
  JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace
  WHERE n.nspname='public' AND c.relname IN (
    'document_extraction_outputs','knowledge_evidence_items','knowledge_citations',
    'knowledge_claims','knowledge_claim_versions','knowledge_claim_evidence_edges',
    'knowledge_claim_review_decisions');
  SELECT count(*) INTO function_count
  FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_namespace n ON n.oid=p.pronamespace
  WHERE n.nspname='public' AND p.proname IN (
    'novatrade_l03_worker_discovery','novatrade_claim_document_scan_job',
    'novatrade_persist_document_scan_result','novatrade_recover_document_scan_lease',
    'novatrade_request_document_extraction','novatrade_cancel_document_extraction',
    'novatrade_claim_document_extraction_job','novatrade_finalize_document_extraction',
    'novatrade_recover_document_extraction_lease','novatrade_record_document_retention_evaluation',
    'novatrade_request_document_deletion','novatrade_apply_document_deletion',
    'novatrade_review_knowledge_claim','novatrade_list_knowledge_documents',
    'novatrade_get_document_knowledge','novatrade_resolve_knowledge_citation',
    'novatrade_get_document_retention_subject','novatrade_get_document_deletion_request',
    'novatrade_discover_document_scan_lease_losses','novatrade_discover_document_extraction_lease_losses',
    'novatrade_discover_document_retention_subjects','novatrade_discover_document_deletion_requests',
    'novatrade_l03_knowledge_append_only','novatrade_l03_knowledge_claim_guard');
  SELECT count(*) INTO owned_count
  FROM pg_catalog.pg_proc p
  JOIN pg_catalog.pg_namespace n ON n.oid=p.pronamespace
  JOIN pg_catalog.pg_roles r ON r.oid=p.proowner
  WHERE n.nspname='public' AND r.rolname='novatrade_document_pipeline_definer'
    AND p.proname IN (
      'novatrade_l03_worker_discovery','novatrade_claim_document_scan_job',
      'novatrade_persist_document_scan_result','novatrade_recover_document_scan_lease',
      'novatrade_request_document_extraction','novatrade_cancel_document_extraction',
      'novatrade_claim_document_extraction_job','novatrade_finalize_document_extraction',
      'novatrade_recover_document_extraction_lease','novatrade_record_document_retention_evaluation',
      'novatrade_request_document_deletion','novatrade_apply_document_deletion',
      'novatrade_review_knowledge_claim','novatrade_list_knowledge_documents',
      'novatrade_get_document_knowledge','novatrade_resolve_knowledge_citation',
      'novatrade_get_document_retention_subject','novatrade_get_document_deletion_request',
      'novatrade_discover_document_scan_lease_losses','novatrade_discover_document_extraction_lease_losses',
      'novatrade_discover_document_retention_subjects','novatrade_discover_document_deletion_requests',
      'novatrade_l03_knowledge_append_only','novatrade_l03_knowledge_claim_guard');
  SELECT count(*) INTO trigger_count
  FROM pg_catalog.pg_trigger tg
  JOIN pg_catalog.pg_class c ON c.oid=tg.tgrelid
  JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace
  WHERE n.nspname='public' AND NOT tg.tgisinternal AND tg.tgname IN (
    'trg_document_extraction_outputs_append_only','trg_knowledge_evidence_items_append_only',
    'trg_knowledge_citations_append_only','trg_knowledge_claim_versions_append_only',
    'trg_knowledge_claim_edges_append_only','trg_knowledge_review_decisions_append_only',
    'trg_knowledge_claims_guard');
  IF rls_count<>7 OR policy_count<>0 OR function_count<>24 OR owned_count<>24
     OR trigger_count<>7 THEN
    RAISE EXCEPTION 'L-03 document pipeline worker catalog incomplete' USING ERRCODE='P0001';
  END IF;
END;
$receipt$;

COMMIT;
