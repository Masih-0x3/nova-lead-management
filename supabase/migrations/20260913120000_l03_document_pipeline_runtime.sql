-- L-03 document pipeline runtime authority. The F-04/F-05 tables stay
-- deny-by-default; every mutation and read below crosses one reviewed
-- SECURITY DEFINER boundary that re-validates the transaction-local
-- member or worker context before touching a row.
--
-- Worker authority is the fenced document job lease itself:
-- app.worker_name='document_pipeline', an action-scoped app.worker_action,
-- and the job-bound app.job_id/app.lease_id/app.lease_generation GUCs are
-- checked against live lease facts (only token digests are persisted).
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '120s';
SELECT pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtext('novatrade:l03:document-pipeline-runtime'));

DO $block$
DECLARE
  role_attributes pg_catalog.record;
BEGIN
  SELECT rolcanlogin,rolsuper,rolcreatedb,rolcreaterole,rolinherit,rolreplication,rolbypassrls
    INTO role_attributes
  FROM pg_catalog.pg_roles
  WHERE rolname='novatrade_document_pipeline_definer';

  IF NOT FOUND THEN
    CREATE ROLE novatrade_document_pipeline_definer
      NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION BYPASSRLS;
  ELSIF role_attributes.rolcanlogin OR role_attributes.rolsuper OR role_attributes.rolcreatedb
     OR role_attributes.rolcreaterole OR role_attributes.rolinherit OR role_attributes.rolreplication
     OR NOT role_attributes.rolbypassrls
  THEN
    RAISE EXCEPTION 'novatrade_document_pipeline_definer has unsafe attributes';
  END IF;

  IF EXISTS (
    SELECT 1 FROM pg_catalog.pg_auth_members AS membership
    JOIN pg_catalog.pg_roles AS protected_role
      ON protected_role.oid IN (membership.roleid,membership.member)
    WHERE protected_role.rolname='novatrade_document_pipeline_definer'
  ) THEN
    RAISE EXCEPTION 'novatrade_document_pipeline_definer must have no role memberships';
  END IF;
END;
$block$;

-- D-006 lifecycle: the version row carries the full document state machine.
ALTER TABLE public.document_versions DROP CONSTRAINT IF EXISTS document_versions_status_chk;
ALTER TABLE public.document_versions ADD CONSTRAINT document_versions_status_chk
  CHECK (status IN (
    'upload_reserved','quarantined','scanning','clean','extracting','ready',
    'infected','scanner_error','extraction_failed','rejected','expired',
    'deletion_pending','deletion_failed','deleted','retained_for_incident'
  )) NOT VALID;
ALTER TABLE public.document_versions VALIDATE CONSTRAINT document_versions_status_chk;

-- Authorized URL intake is a distinct durable source kind bound to the
-- document id the same way tenant uploads are.
ALTER TABLE public.documents DROP CONSTRAINT IF EXISTS documents_source_chk;
ALTER TABLE public.documents ADD CONSTRAINT documents_source_chk
  CHECK (
    (source_kind='tenant_upload' AND source_identity='tenant_upload:'||id::text)
    OR (source_kind='authorized_url' AND source_identity='authorized_url:'||id::text)
  ) NOT VALID;
ALTER TABLE public.documents VALIDATE CONSTRAINT documents_source_chk;

CREATE OR REPLACE FUNCTION public.novatrade_document_version_guard()
RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $fn$
BEGIN
  IF ROW(NEW.id,NEW.tenant_id,NEW.workspace_id,NEW.document_id,NEW.original_name,NEW.format,NEW.media_type,
    NEW.declared_byte_size,NEW.max_bytes,NEW.scanner_policy_version,NEW.object_key,NEW.created_at)
    IS DISTINCT FROM ROW(OLD.id,OLD.tenant_id,OLD.workspace_id,OLD.document_id,OLD.original_name,OLD.format,OLD.media_type,
    OLD.declared_byte_size,OLD.max_bytes,OLD.scanner_policy_version,OLD.object_key,OLD.created_at) THEN
    RAISE EXCEPTION 'document version identity or object key is immutable' USING ERRCODE='P0001';
  END IF;
  IF OLD.status<>'upload_reserved' AND ROW(NEW.checksum,NEW.verified_byte_size,NEW.verified_media_type,
    NEW.duplicate_of_version_id,NEW.finalized_at)
    IS DISTINCT FROM ROW(OLD.checksum,OLD.verified_byte_size,OLD.verified_media_type,
    OLD.duplicate_of_version_id,OLD.finalized_at) THEN
    RAISE EXCEPTION 'finalized document version facts are immutable' USING ERRCODE='P0001';
  END IF;
  -- D-006 transition table. 'extracting -> clean' is the fenced cancel path:
  -- cancelling extraction restores the exact trusted-clean source bytes.
  -- 'retained_for_incident -> deletion_pending' is reachable only through the
  -- incident-hold release RPC, which demands a reason-coded evidence reference
  -- before issuing the UPDATE.
  IF NOT (
    NEW.status=OLD.status
    OR (OLD.status='upload_reserved' AND NEW.status IN ('quarantined','rejected','expired','deletion_pending'))
    OR (OLD.status='quarantined' AND NEW.status IN ('scanning','rejected','deletion_pending'))
    OR (OLD.status='scanning' AND NEW.status IN ('clean','infected','scanner_error','quarantined','deletion_pending'))
    OR (OLD.status='clean' AND NEW.status IN ('extracting','expired','deletion_pending'))
    OR (OLD.status='extracting' AND NEW.status IN ('ready','extraction_failed','clean','deletion_pending'))
    OR (OLD.status='ready' AND NEW.status IN ('expired','deletion_pending'))
    OR (OLD.status='infected' AND NEW.status IN ('retained_for_incident','deletion_pending'))
    OR (OLD.status='scanner_error' AND NEW.status IN ('quarantined','rejected','deletion_pending'))
    OR (OLD.status='extraction_failed' AND NEW.status IN ('extracting','ready','deletion_pending'))
    OR (OLD.status='rejected' AND NEW.status='deletion_pending')
    OR (OLD.status='expired' AND NEW.status IN ('retained_for_incident','deletion_pending'))
    OR (OLD.status='deletion_pending' AND NEW.status IN ('deleted','deletion_failed','retained_for_incident'))
    OR (OLD.status='deletion_failed' AND NEW.status IN ('deletion_pending','retained_for_incident'))
    OR (OLD.status='retained_for_incident' AND NEW.status='deletion_pending')
  ) THEN
    RAISE EXCEPTION 'document version state transition is invalid' USING ERRCODE='P0001';
  END IF;
  NEW.updated_at := pg_catalog.statement_timestamp();
  RETURN NEW;
END;
$fn$;

-- A dead worker leaves a running scan job with an expired lease. The only
-- recovery is a fenced requeue back to queued with all lease facts cleared;
-- fabricated scan verdicts are never written for a lease that produced none.
CREATE OR REPLACE FUNCTION public.novatrade_document_scan_job_guard()
RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $fn$
BEGIN
  IF TG_OP='INSERT' THEN
    IF NOT EXISTS (
      SELECT 1 FROM public.document_version_finalizations f
      WHERE f.tenant_id=NEW.tenant_id AND f.workspace_id=NEW.workspace_id AND f.document_id=NEW.document_id
        AND f.version_id=NEW.version_id AND f.processing_version_id=NEW.version_id
        AND f.checksum=NEW.checksum AND f.scanner_policy_version=NEW.policy_version AND f.dedupe_decision='canonical'
    ) THEN RAISE EXCEPTION 'scan job requires canonical finalization' USING ERRCODE='23514'; END IF;
    IF NEW.status<>'queued' OR NEW.attempt_count<>0 OR NEW.next_attempt_at IS NOT NULL
      OR NEW.lease_generation<>0 OR NEW.lease_token_hash IS NOT NULL OR NEW.lease_worker_hash IS NOT NULL
      OR NEW.lease_acquired_at IS NOT NULL OR NEW.lease_heartbeat_at IS NOT NULL OR NEW.lease_expires_at IS NOT NULL
      OR NEW.verdict IS NOT NULL OR NEW.scanner_adapter_id IS NOT NULL OR NEW.scanner_version IS NOT NULL
      OR NEW.scanned_checksum IS NOT NULL OR NEW.scanned_at IS NOT NULL
      OR NEW.result_policy_version IS NOT NULL OR NEW.reason_code IS NOT NULL OR NEW.result_retryable IS NOT NULL THEN
      RAISE EXCEPTION 'scan job must begin in the pristine queued state' USING ERRCODE='P0001';
    END IF;
  ELSE
    IF ROW(NEW.id,NEW.tenant_id,NEW.workspace_id,NEW.document_id,NEW.version_id,NEW.object_key,NEW.checksum,
      NEW.policy_version,NEW.max_attempts,NEW.created_at)
      IS DISTINCT FROM ROW(OLD.id,OLD.tenant_id,OLD.workspace_id,OLD.document_id,OLD.version_id,OLD.object_key,OLD.checksum,
      OLD.policy_version,OLD.max_attempts,OLD.created_at)
      OR NEW.attempt_count<OLD.attempt_count OR NEW.lease_generation<OLD.lease_generation
      OR NEW.lease_generation>OLD.lease_generation+1 THEN
      RAISE EXCEPTION 'scan job immutable identity or lease generation violation' USING ERRCODE='P0001';
    END IF;
    IF OLD.status IN ('clean','infected','scanner_error') AND NEW IS DISTINCT FROM OLD THEN
      RAISE EXCEPTION 'terminal scan job is immutable' USING ERRCODE='P0001';
    END IF;
    IF NOT ((OLD.status='queued' AND NEW.status IN ('queued','running'))
      OR (OLD.status='running' AND NEW.status IN ('running','queued','retry_wait','clean','infected','scanner_error'))
      OR (OLD.status='retry_wait' AND NEW.status IN ('retry_wait','running'))
      OR (OLD.status IN ('clean','infected','scanner_error') AND NEW.status=OLD.status)) THEN
      RAISE EXCEPTION 'scan job state transition is invalid' USING ERRCODE='P0001';
    END IF;
    IF OLD.status='running' AND NEW.status='queued' THEN
      -- Lease-loss requeue only: expired lease, identical attempt/generation,
      -- every lease fact cleared, a bounded retry instant, no result facts.
      IF OLD.lease_expires_at>pg_catalog.statement_timestamp()
        OR NEW.attempt_count<>OLD.attempt_count OR NEW.attempt_count>=NEW.max_attempts
        OR NEW.lease_generation<>OLD.lease_generation
        OR NEW.lease_token_hash IS NOT NULL OR NEW.lease_worker_hash IS NOT NULL
        OR NEW.lease_acquired_at IS NOT NULL OR NEW.lease_heartbeat_at IS NOT NULL
        OR NEW.lease_expires_at IS NOT NULL OR NEW.next_attempt_at IS NULL
        OR NEW.next_attempt_at<pg_catalog.statement_timestamp() THEN
        RAISE EXCEPTION 'scan lease-loss requeue is invalid' USING ERRCODE='P0001';
      END IF;
    ELSIF NEW.status='running' AND OLD.status<>'running' THEN
      IF NEW.attempt_count<>OLD.attempt_count+1 OR NEW.lease_generation<>OLD.lease_generation+1 THEN
        RAISE EXCEPTION 'scan lease attempt and generation must advance together' USING ERRCODE='P0001';
      END IF;
    ELSIF NEW.status='running' AND OLD.status='running' THEN
      IF ROW(NEW.attempt_count,NEW.lease_generation,NEW.lease_token_hash,NEW.lease_worker_hash,NEW.lease_acquired_at)
        IS DISTINCT FROM ROW(OLD.attempt_count,OLD.lease_generation,OLD.lease_token_hash,OLD.lease_worker_hash,OLD.lease_acquired_at)
        OR NEW.lease_heartbeat_at<OLD.lease_heartbeat_at OR NEW.lease_expires_at<OLD.lease_expires_at THEN
        RAISE EXCEPTION 'scan heartbeat cannot change or regress lease identity' USING ERRCODE='P0001';
      END IF;
    ELSIF NEW.attempt_count<>OLD.attempt_count OR NEW.lease_generation<>OLD.lease_generation THEN
      RAISE EXCEPTION 'scan attempt and generation change only on lease acquisition' USING ERRCODE='P0001';
    END IF;
    -- The lease-history release stamps released_at from updated_at; keep it
    -- monotonic with the mutation so released_at>=acquired_at always holds.
    -- A statement that already set updated_at is honored as written.
    IF NEW IS DISTINCT FROM OLD AND NEW.updated_at IS NOT DISTINCT FROM OLD.updated_at THEN
      NEW.updated_at := pg_catalog.statement_timestamp();
    END IF;
  END IF;
  RETURN NEW;
END;
$fn$;

-- Extraction INSERT may also root in an extraction_failed version: the clean
-- canonical finalization and clean scan facts still bind the job, and a new
-- parser/input identity keeps re-extraction auditable. A dead worker's
-- expired running lease may only be finalized as a fenced retryable requeue.
CREATE OR REPLACE FUNCTION public.novatrade_document_extraction_job_guard()
RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $function$
DECLARE
  parent_ok boolean;
  warning_item jsonb;
  warning_text text;
  database_now timestamptz := pg_catalog.statement_timestamp();
BEGIN
  IF TG_OP='DELETE' THEN
    RAISE EXCEPTION 'document extraction jobs are append-only' USING ERRCODE='P0001';
  END IF;

  IF NEW.warnings IS NOT NULL THEN
    IF pg_catalog.jsonb_typeof(NEW.warnings)<>'array'
      OR pg_catalog.octet_length(NEW.warnings::text)>65536 THEN
      RAISE EXCEPTION 'document extraction warnings must be a bounded array' USING ERRCODE='23514';
    END IF;
    FOR warning_item IN SELECT value FROM pg_catalog.jsonb_array_elements(NEW.warnings) LOOP
      IF pg_catalog.jsonb_typeof(warning_item)<>'string' THEN
        RAISE EXCEPTION 'document extraction warning must be a string' USING ERRCODE='23514';
      END IF;
      warning_text := warning_item #>> '{}';
      IF pg_catalog.char_length(warning_text) NOT BETWEEN 1 AND 500
        OR warning_text<>pg_catalog.btrim(warning_text)
        OR warning_text ~ '[[:cntrl:]]'
        OR warning_text ~ U&'[\0080-\009F]' THEN
        RAISE EXCEPTION 'document extraction warning text is invalid' USING ERRCODE='23514';
      END IF;
    END LOOP;
  END IF;

  IF TG_OP='INSERT' THEN
    SELECT true INTO parent_ok
    FROM public.document_versions v
    JOIN public.document_version_finalizations f
      ON f.id=NEW.canonical_finalization_id
      AND f.tenant_id=NEW.tenant_id AND f.workspace_id=NEW.workspace_id
      AND f.document_id=NEW.document_id AND f.version_id=NEW.version_id
      AND f.processing_version_id=NEW.version_id AND f.dedupe_decision='canonical'
      AND f.checksum=NEW.checksum AND f.scanner_policy_version=NEW.scanner_policy_version
    JOIN public.document_scan_jobs s
      ON s.id=NEW.scan_job_id AND s.tenant_id=NEW.tenant_id AND s.workspace_id=NEW.workspace_id
      AND s.document_id=NEW.document_id AND s.version_id=NEW.version_id
      AND s.checksum=NEW.checksum AND s.policy_version=NEW.scanner_policy_version
    WHERE v.tenant_id=NEW.tenant_id AND v.workspace_id=NEW.workspace_id
      AND v.document_id=NEW.document_id AND v.id=NEW.version_id
      AND v.status IN ('clean','extraction_failed') AND v.checksum=NEW.checksum
      AND v.scanner_policy_version=NEW.scanner_policy_version
      AND s.status='clean' AND s.verdict='clean' AND s.scanned_checksum=NEW.checksum
      AND s.result_policy_version=NEW.scanner_policy_version;
    IF parent_ok IS DISTINCT FROM true THEN
      RAISE EXCEPTION 'extraction job requires exact clean canonical scan facts' USING ERRCODE='23514';
    END IF;
    IF NEW.status<>'queued' OR NEW.attempt_count<>0 OR NEW.lease_generation<>0
      OR NEW.next_attempt_at IS NOT NULL OR NEW.lease_token_hash IS NOT NULL
      OR NEW.lease_worker_hash IS NOT NULL OR NEW.lease_acquired_at IS NOT NULL
      OR NEW.lease_heartbeat_at IS NOT NULL OR NEW.lease_expires_at IS NOT NULL
      OR NEW.cancel_requested_at IS NOT NULL OR NEW.canceled_at IS NOT NULL
      OR NEW.result_lease_generation IS NOT NULL OR NEW.result_lease_token_hash IS NOT NULL
      OR NEW.event_at IS NOT NULL OR NEW.output_sha256 IS NOT NULL
      OR NEW.output_block_count IS NOT NULL OR NEW.output_chunk_count IS NOT NULL
      OR NEW.quality_score IS NOT NULL OR NEW.review_required IS NOT NULL OR NEW.warnings IS NOT NULL
      OR NEW.error_code IS NOT NULL OR NEW.error_fingerprint IS NOT NULL
      OR NEW.result_retryable IS NOT NULL THEN
      RAISE EXCEPTION 'extraction job must begin in the pristine queued state' USING ERRCODE='P0001';
    END IF;
    RETURN NEW;
  END IF;

  IF ROW(NEW.id,NEW.tenant_id,NEW.workspace_id,NEW.document_id,NEW.version_id,
      NEW.canonical_finalization_id,NEW.scan_job_id,NEW.checksum,NEW.scanner_policy_version,
      NEW.parser_id,NEW.parser_version,NEW.idempotency_key,NEW.input_hash,NEW.max_attempts,NEW.created_at)
    IS DISTINCT FROM ROW(OLD.id,OLD.tenant_id,OLD.workspace_id,OLD.document_id,OLD.version_id,
      OLD.canonical_finalization_id,OLD.scan_job_id,OLD.checksum,OLD.scanner_policy_version,
      OLD.parser_id,OLD.parser_version,OLD.idempotency_key,OLD.input_hash,OLD.max_attempts,OLD.created_at) THEN
    RAISE EXCEPTION 'document extraction execution identity is immutable' USING ERRCODE='P0001';
  END IF;
  IF NEW.updated_at<OLD.updated_at THEN
    RAISE EXCEPTION 'document extraction time regression' USING ERRCODE='P0001';
  END IF;
  IF OLD.status IN ('complete','review_required','error','canceled') THEN
    RAISE EXCEPTION 'document extraction terminal state is immutable' USING ERRCODE='P0001';
  END IF;
  IF NOT (
    (OLD.status='queued' AND NEW.status IN ('running','canceled'))
    OR (OLD.status='running' AND NEW.status IN (
      'running','retry_wait','complete','review_required','error','canceled'
    ))
    OR (OLD.status='retry_wait' AND NEW.status IN ('running','error','canceled'))
  ) THEN
    RAISE EXCEPTION 'document extraction state transition is invalid' USING ERRCODE='P0001';
  END IF;
  IF OLD.cancel_requested_at IS NOT NULL
    AND NEW.cancel_requested_at IS DISTINCT FROM OLD.cancel_requested_at THEN
    RAISE EXCEPTION 'document extraction cancel request is immutable' USING ERRCODE='P0001';
  END IF;
  IF NEW.cancel_requested_at IS NOT NULL AND NEW.status NOT IN ('running','canceled') THEN
    RAISE EXCEPTION 'document extraction cancel request blocks later result' USING ERRCODE='P0001';
  END IF;

  IF NEW.status='running' AND OLD.status IN ('queued','retry_wait') THEN
    IF NEW.attempt_count<>OLD.attempt_count+1 OR NEW.lease_generation<>OLD.lease_generation+1
      OR NEW.lease_generation<>NEW.attempt_count OR NEW.lease_token_hash IS NULL
      OR NEW.lease_worker_hash IS NULL OR NEW.lease_acquired_at IS NULL
      OR NEW.lease_heartbeat_at IS DISTINCT FROM NEW.lease_acquired_at
      OR NEW.lease_acquired_at>database_now OR NEW.lease_heartbeat_at>database_now
      OR NEW.lease_expires_at<=database_now
      OR NEW.lease_expires_at>NEW.lease_heartbeat_at+interval '15 minutes'
      OR NEW.next_attempt_at IS NOT NULL
      OR NEW.cancel_requested_at IS NOT NULL
      OR (OLD.next_attempt_at IS NOT NULL AND NEW.lease_acquired_at<OLD.next_attempt_at)
      OR NEW.result_lease_generation IS NOT NULL OR NEW.result_lease_token_hash IS NOT NULL
      OR NEW.event_at IS NOT NULL OR NEW.error_code IS NOT NULL
      OR NEW.error_fingerprint IS NOT NULL OR NEW.result_retryable IS NOT NULL THEN
      RAISE EXCEPTION 'document extraction lease acquisition is invalid' USING ERRCODE='P0001';
    END IF;
  ELSE
    IF NEW.attempt_count<>OLD.attempt_count OR NEW.lease_generation<>OLD.lease_generation THEN
      RAISE EXCEPTION 'document extraction attempt or generation changed outside acquisition' USING ERRCODE='P0001';
    END IF;
  END IF;

  IF OLD.status='running' AND NEW.status='running' THEN
    IF OLD.lease_expires_at<=database_now THEN
      RAISE EXCEPTION 'document extraction lease expired before heartbeat or extension'
        USING ERRCODE='P0001';
    END IF;
    IF NEW.lease_token_hash IS DISTINCT FROM OLD.lease_token_hash
      OR NEW.lease_worker_hash IS DISTINCT FROM OLD.lease_worker_hash
      OR NEW.lease_acquired_at IS DISTINCT FROM OLD.lease_acquired_at
      OR NEW.lease_heartbeat_at<OLD.lease_heartbeat_at OR NEW.lease_expires_at<OLD.lease_expires_at
      OR NEW.lease_heartbeat_at>database_now OR NEW.lease_expires_at<=database_now
      OR NEW.lease_expires_at>NEW.lease_heartbeat_at+interval '15 minutes' THEN
      RAISE EXCEPTION 'document extraction running lease identity or heartbeat regression' USING ERRCODE='P0001';
    END IF;
  END IF;

  IF OLD.status='running' AND NEW.status<>'running' THEN
    IF OLD.lease_expires_at<=database_now THEN
      -- Lease-loss recovery: a dead worker's expired lease may only be
      -- finalized by a new worker into one fenced recovery shape carrying the
      -- expired lease identity. Output, success, and live-lease facts can
      -- never be fabricated for a lease that produced none.
      IF NOT (
        NEW.result_lease_generation IS NOT DISTINCT FROM OLD.lease_generation
        AND NEW.result_lease_token_hash IS NOT DISTINCT FROM OLD.lease_token_hash
        AND NEW.event_at IS NOT NULL AND NEW.event_at<=database_now
        AND NEW.lease_token_hash IS NULL AND NEW.lease_worker_hash IS NULL
        AND NEW.lease_acquired_at IS NULL AND NEW.lease_heartbeat_at IS NULL
        AND NEW.lease_expires_at IS NULL
        AND (
          (OLD.cancel_requested_at IS NOT NULL AND NEW.status='canceled')
          OR (OLD.cancel_requested_at IS NULL AND NEW.status='retry_wait'
            AND NEW.error_code='lease_expired' AND NEW.result_retryable=true
            AND NEW.error_fingerprint IS NOT NULL
            AND NEW.attempt_count<NEW.max_attempts)
          OR (OLD.cancel_requested_at IS NULL AND NEW.status='error'
            AND NEW.error_code='lease_expired' AND NEW.result_retryable=false
            AND NEW.error_fingerprint IS NOT NULL
            AND NEW.attempt_count>=NEW.max_attempts)
        )
      ) THEN
        RAISE EXCEPTION 'document extraction lease expired before finalization' USING ERRCODE='P0001';
      END IF;
    ELSIF NEW.result_lease_generation IS DISTINCT FROM OLD.lease_generation
      OR NEW.result_lease_token_hash IS DISTINCT FROM OLD.lease_token_hash
      OR NEW.event_at IS NULL OR NEW.event_at<OLD.lease_heartbeat_at OR NEW.event_at>=OLD.lease_expires_at
      OR NEW.event_at>database_now
      OR NEW.lease_token_hash IS NOT NULL OR NEW.lease_worker_hash IS NOT NULL
      OR NEW.lease_acquired_at IS NOT NULL OR NEW.lease_heartbeat_at IS NOT NULL
      OR NEW.lease_expires_at IS NOT NULL THEN
      RAISE EXCEPTION 'document extraction result is not fenced to the live lease' USING ERRCODE='P0001';
    END IF;
  END IF;

  IF OLD.status='retry_wait' AND NEW.status IN ('error','canceled') THEN
    IF NEW.result_lease_generation IS DISTINCT FROM OLD.result_lease_generation
      OR NEW.result_lease_token_hash IS DISTINCT FROM OLD.result_lease_token_hash
      OR NEW.event_at IS DISTINCT FROM (CASE
        WHEN NEW.status='canceled' THEN NEW.canceled_at ELSE OLD.event_at
      END) THEN
      RAISE EXCEPTION 'document extraction retry terminal facts are invalid' USING ERRCODE='P0001';
    END IF;
  END IF;
  -- Keep updated_at monotonic with every accepted mutation; the lease-history
  -- release and next_attempt checks both read it. A statement that already
  -- set updated_at is honored as written.
  IF NEW IS DISTINCT FROM OLD AND NEW.updated_at IS NOT DISTINCT FROM OLD.updated_at THEN
    NEW.updated_at := database_now;
  END IF;
  RETURN NEW;
END;
$function$;

-- ---------------------------------------------------------------------------
-- Durable intake records for authorized URL sources and lifecycle authority.
-- ---------------------------------------------------------------------------
CREATE TABLE public.document_url_sources (
  tenant_id pg_catalog.uuid NOT NULL,
  workspace_id pg_catalog.uuid NOT NULL,
  document_id pg_catalog.uuid NOT NULL,
  url_sha256 pg_catalog.text NOT NULL,
  normalized_url pg_catalog.text NOT NULL,
  created_at pg_catalog.timestamptz(3) NOT NULL DEFAULT pg_catalog.statement_timestamp(),
  CONSTRAINT document_url_sources_pkey PRIMARY KEY (tenant_id,workspace_id,document_id),
  CONSTRAINT document_url_sources_document_fkey
    FOREIGN KEY (tenant_id,workspace_id,document_id)
    REFERENCES public.documents(tenant_id,workspace_id,id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT document_url_sources_hash_chk CHECK (url_sha256 ~ '^[0-9a-f]{64}$'),
  CONSTRAINT document_url_sources_url_chk CHECK (
    pg_catalog.char_length(normalized_url) BETWEEN 12 AND 2048
    AND normalized_url ~ '^https?://'
    AND normalized_url !~ '[[:cntrl:]]'
    AND normalized_url=pg_catalog.btrim(normalized_url)
  ),
  CONSTRAINT document_url_sources_url_unique UNIQUE (tenant_id,workspace_id,url_sha256)
);

COMMENT ON TABLE public.document_url_sources IS
  'L-03 tenant-local binding of one SSRF-authorized normalized URL to one document identity.';

CREATE TABLE public.document_url_intake_requests (
  id pg_catalog.uuid CONSTRAINT document_url_intake_requests_pkey PRIMARY KEY,
  tenant_id pg_catalog.uuid NOT NULL,
  workspace_id pg_catalog.uuid NOT NULL,
  document_id pg_catalog.uuid NOT NULL,
  idempotency_key pg_catalog.text NOT NULL,
  url_sha256 pg_catalog.text NOT NULL,
  normalized_url pg_catalog.text NOT NULL,
  requested_name pg_catalog.text NOT NULL,
  state pg_catalog.text NOT NULL DEFAULT 'fetching',
  reason_code pg_catalog.text,
  version_id pg_catalog.uuid,
  checksum pg_catalog.text,
  final_url_sha256 pg_catalog.text,
  redirect_count pg_catalog.int4,
  byte_size pg_catalog.int8,
  fetched_at pg_catalog.timestamptz(3),
  created_at pg_catalog.timestamptz(3) NOT NULL DEFAULT pg_catalog.statement_timestamp(),
  updated_at pg_catalog.timestamptz(3) NOT NULL DEFAULT pg_catalog.statement_timestamp(),
  CONSTRAINT document_url_intake_requests_document_fkey
    FOREIGN KEY (tenant_id,workspace_id,document_id)
    REFERENCES public.documents(tenant_id,workspace_id,id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT document_url_intake_requests_idempotency_chk
    CHECK (idempotency_key ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$'),
  CONSTRAINT document_url_intake_requests_hash_chk CHECK (
    url_sha256 ~ '^[0-9a-f]{64}$'
    AND (checksum IS NULL OR checksum ~ '^[0-9a-f]{64}$')
    AND (final_url_sha256 IS NULL OR final_url_sha256 ~ '^[0-9a-f]{64}$')
  ),
  CONSTRAINT document_url_intake_requests_url_chk CHECK (
    pg_catalog.char_length(normalized_url) BETWEEN 12 AND 2048
    AND normalized_url ~ '^https?://' AND normalized_url !~ '[[:cntrl:]]'
    AND normalized_url=pg_catalog.btrim(normalized_url)
  ),
  CONSTRAINT document_url_intake_requests_name_chk CHECK (
    pg_catalog.char_length(requested_name) BETWEEN 1 AND 1024 AND requested_name !~ '[[:cntrl:]]'
  ),
  CONSTRAINT document_url_intake_requests_state_chk CHECK (
    state IN ('fetching','quarantined','blocked_security','rejected','failed')
  ),
  CONSTRAINT document_url_intake_requests_result_chk CHECK (
    (state='fetching' AND reason_code IS NULL AND version_id IS NULL AND checksum IS NULL
      AND final_url_sha256 IS NULL AND redirect_count IS NULL AND byte_size IS NULL AND fetched_at IS NULL)
    OR (state IN ('blocked_security','rejected','failed') AND reason_code IS NOT NULL
      AND version_id IS NULL AND checksum IS NULL AND fetched_at IS NULL)
    OR (state='quarantined' AND version_id IS NOT NULL AND checksum IS NOT NULL
      AND final_url_sha256 IS NOT NULL AND redirect_count BETWEEN 0 AND 5
      AND byte_size>0 AND fetched_at IS NOT NULL)
  ),
  CONSTRAINT document_url_intake_requests_scope_id_unique UNIQUE (tenant_id,workspace_id,id),
  CONSTRAINT document_url_intake_requests_idempotency_unique UNIQUE (tenant_id,idempotency_key)
);

COMMENT ON TABLE public.document_url_intake_requests IS
  'L-03 append-tracked SSRF-guarded URL intake requests; fetched bytes never cross this boundary, only verified facts.';

CREATE TABLE public.document_lifecycle_events (
  id pg_catalog.int8 GENERATED ALWAYS AS IDENTITY CONSTRAINT document_lifecycle_events_pkey PRIMARY KEY,
  tenant_id pg_catalog.uuid NOT NULL,
  workspace_id pg_catalog.uuid NOT NULL,
  document_id pg_catalog.uuid NOT NULL,
  version_id pg_catalog.uuid,
  actor_kind pg_catalog.text NOT NULL,
  actor_membership_id pg_catalog.uuid,
  from_state pg_catalog.text,
  to_state pg_catalog.text NOT NULL,
  reason_code pg_catalog.text NOT NULL,
  correlation_id pg_catalog.text NOT NULL,
  created_at pg_catalog.timestamptz(3) NOT NULL DEFAULT pg_catalog.statement_timestamp(),
  CONSTRAINT document_lifecycle_events_actor_chk CHECK (
    actor_kind IN ('member','worker','system')
    AND (actor_kind<>'member' OR actor_membership_id IS NOT NULL)
  ),
  CONSTRAINT document_lifecycle_events_state_chk CHECK (
    (from_state IS NULL OR from_state IN (
      'upload_reserved','quarantined','scanning','clean','extracting','ready','infected','scanner_error',
      'extraction_failed','rejected','expired','deletion_pending','deletion_failed','deleted','retained_for_incident'))
    AND to_state IN (
      'upload_reserved','quarantined','scanning','clean','extracting','ready','infected','scanner_error',
      'extraction_failed','rejected','expired','deletion_pending','deletion_failed','deleted','retained_for_incident')
  ),
  CONSTRAINT document_lifecycle_events_reason_chk CHECK (
    pg_catalog.char_length(reason_code) BETWEEN 1 AND 128
    AND reason_code=pg_catalog.btrim(reason_code) AND reason_code !~ '[[:cntrl:]]'
  ),
  CONSTRAINT document_lifecycle_events_correlation_chk CHECK (
    correlation_id ~ '^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$'
  )
);

COMMENT ON TABLE public.document_lifecycle_events IS
  'L-03 append-only audit of every document version lifecycle transition; raw content is never stored.';

CREATE TABLE public.document_deletion_requests (
  id pg_catalog.uuid CONSTRAINT document_deletion_requests_pkey PRIMARY KEY,
  tenant_id pg_catalog.uuid NOT NULL,
  workspace_id pg_catalog.uuid NOT NULL,
  document_id pg_catalog.uuid NOT NULL,
  version_id pg_catalog.uuid NOT NULL,
  requested_by pg_catalog.uuid NOT NULL,
  reason_code pg_catalog.text NOT NULL,
  state pg_catalog.text NOT NULL DEFAULT 'pending',
  resolved_at pg_catalog.timestamptz(3),
  created_at pg_catalog.timestamptz(3) NOT NULL DEFAULT pg_catalog.statement_timestamp(),
  CONSTRAINT document_deletion_requests_version_fkey
    FOREIGN KEY (tenant_id,workspace_id,document_id,version_id)
    REFERENCES public.document_versions(tenant_id,workspace_id,document_id,id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT document_deletion_requests_reason_chk CHECK (
    reason_code IN ('member_requested','retention_expired','policy_purge','source_stale','incident_complete')
  ),
  CONSTRAINT document_deletion_requests_state_chk CHECK (
    state IN ('pending','applied','denied')
    AND ((state='pending' AND resolved_at IS NULL) OR (state<>'pending' AND resolved_at IS NOT NULL))
  )
);

CREATE UNIQUE INDEX idx_document_deletion_requests_pending
  ON public.document_deletion_requests(tenant_id,workspace_id,version_id) WHERE state='pending';

COMMENT ON TABLE public.document_deletion_requests IS
  'L-03 durable member/policy deletion requests; the worker applies them only after retention and hold checks pass.';

CREATE TABLE public.document_retention_evaluations (
  id pg_catalog.int8 GENERATED ALWAYS AS IDENTITY CONSTRAINT document_retention_evaluations_pkey PRIMARY KEY,
  tenant_id pg_catalog.uuid NOT NULL,
  workspace_id pg_catalog.uuid NOT NULL,
  document_id pg_catalog.uuid NOT NULL,
  version_id pg_catalog.uuid NOT NULL,
  input_sha256 pg_catalog.text NOT NULL,
  disposition pg_catalog.text NOT NULL,
  reason pg_catalog.text NOT NULL,
  policy_version pg_catalog.text NOT NULL,
  retention_expires_at pg_catalog.timestamptz(3) NOT NULL,
  evaluated_at pg_catalog.timestamptz(3) NOT NULL,
  correlation_id pg_catalog.text NOT NULL,
  created_at pg_catalog.timestamptz(3) NOT NULL DEFAULT pg_catalog.statement_timestamp(),
  CONSTRAINT document_retention_evaluations_hash_chk CHECK (input_sha256 ~ '^sha256:[0-9a-f]{64}$'),
  CONSTRAINT document_retention_evaluations_disposition_chk CHECK (
    disposition IN ('purge_eligible','retain')
    AND reason IN (
      'retention_elapsed','replay_conflict','legal_hold_active','support_hold_active','incident_hold_active',
      'current_version','clean_version','workflow_in_flight','deletion_in_progress','already_deleted','retention_active'
    )
    AND (disposition='purge_eligible')=(reason='retention_elapsed')
  ),
  CONSTRAINT document_retention_evaluations_policy_chk CHECK (
    policy_version ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'
  ),
  CONSTRAINT document_retention_evaluations_correlation_chk CHECK (
    correlation_id ~ '^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$'
  ),
  CONSTRAINT document_retention_evaluations_idempotency_unique UNIQUE (version_id,input_sha256)
);

COMMENT ON TABLE public.document_retention_evaluations IS
  'L-03 append-only retention dispositions; the hashed input makes replay auditable and conflicts retain.';

-- ---------------------------------------------------------------------------
-- Context validators. Member authority mirrors the F-04 reservation boundary:
-- transaction-local GUC identity plus a live membership/role-binding join.
-- The lock variant serializes revocation and mutation with FOR SHARE; the
-- stable variant serves read-only queries. Worker authority is the fenced
-- document job lease plus an exact action binding.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.novatrade_l03_member_authorized(p_allowed_roles pg_catalog.text[])
RETURNS boolean
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $fn$
DECLARE
  actor_uuid pg_catalog.uuid;
  membership_uuid pg_catalog.uuid;
  binding_uuid pg_catalog.uuid;
BEGIN
  IF p_allowed_roles IS NULL OR pg_catalog.array_length(p_allowed_roles,1) IS NULL THEN
    RETURN false;
  END IF;
  IF NULLIF(pg_catalog.current_setting('app.tenant_id',true),'') IS NULL
     OR pg_catalog.current_setting('app.tenant_id',true) !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
     OR NULLIF(pg_catalog.current_setting('app.workspace_id',true),'') IS NULL
     OR pg_catalog.current_setting('app.workspace_id',true) !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
     OR NULLIF(pg_catalog.current_setting('app.role',true),'') IS NULL
     OR NOT (pg_catalog.current_setting('app.role',true)=ANY(p_allowed_roles))
     OR NULLIF(pg_catalog.current_setting('app.correlation_id',true),'') IS NULL
     OR pg_catalog.current_setting('app.correlation_id',true) !~ '^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$'
  THEN
    RETURN false;
  END IF;

  -- A member context cannot carry support or worker authority, including
  -- stale pooled values from a prior transaction.
  IF coalesce(pg_catalog.current_setting('app.support_grant_id',true),'')<>''
     OR coalesce(pg_catalog.current_setting('app.job_id',true),'')<>''
     OR coalesce(pg_catalog.current_setting('app.run_id',true),'')<>''
     OR coalesce(pg_catalog.current_setting('app.lease_id',true),'')<>''
     OR coalesce(pg_catalog.current_setting('app.lease_generation',true),'')<>''
     OR coalesce(pg_catalog.current_setting('app.worker_name',true),'')<>''
     OR coalesce(pg_catalog.current_setting('app.worker_action',true),'')<>''
     OR coalesce(pg_catalog.current_setting('app.worker_principal_kind',true),'')<>'' THEN
    RETURN false;
  END IF;

  BEGIN
    actor_uuid := pg_catalog.current_setting('app.actor_id',true)::pg_catalog.uuid;
    membership_uuid := pg_catalog.current_setting('app.membership_id',true)::pg_catalog.uuid;
    binding_uuid := pg_catalog.current_setting('app.role_binding_id',true)::pg_catalog.uuid;
  EXCEPTION WHEN invalid_text_representation THEN
    RETURN false;
  END;
  IF actor_uuid IS NULL OR membership_uuid IS NULL OR binding_uuid IS NULL THEN
    RETURN false;
  END IF;

  RETURN EXISTS (
    SELECT 1
    FROM public.tenants AS tenant
    JOIN public.workspaces AS workspace
      ON workspace.tenant_id=tenant.id
      AND workspace.id=pg_catalog.current_setting('app.workspace_id',true)::pg_catalog.uuid
      AND workspace.status='active'
    JOIN public.tenant_memberships AS membership
      ON membership.tenant_id=tenant.id AND membership.id=membership_uuid
      AND membership.auth_identity_id=actor_uuid
      AND membership.pending_identity_ref_hash IS NULL AND membership.status='active'
      AND (membership.workspace_id IS NULL
        OR membership.workspace_id=pg_catalog.current_setting('app.workspace_id',true)::pg_catalog.uuid)
    JOIN public.tenant_role_bindings AS binding
      ON binding.tenant_id=tenant.id AND binding.id=binding_uuid
      AND binding.membership_id=membership.id
      AND binding.role=pg_catalog.current_setting('app.role',true)
      AND binding.role=ANY(p_allowed_roles)
      AND binding.valid_from<=pg_catalog.statement_timestamp() AND binding.revoked_at IS NULL
    WHERE tenant.id=pg_catalog.current_setting('app.tenant_id',true)::pg_catalog.uuid
      AND tenant.status='active'
  );
EXCEPTION WHEN others THEN
  RETURN false;
END;
$fn$;

CREATE OR REPLACE FUNCTION public.novatrade_l03_member_lock(p_allowed_roles pg_catalog.text[])
RETURNS boolean
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog AS $fn$
DECLARE
  actor_uuid pg_catalog.uuid;
  membership_uuid pg_catalog.uuid;
  binding_uuid pg_catalog.uuid;
  authorized pg_catalog.bool := false;
BEGIN
  IF NOT public.novatrade_l03_member_authorized(p_allowed_roles) THEN
    RETURN false;
  END IF;
  actor_uuid := pg_catalog.current_setting('app.actor_id',true)::pg_catalog.uuid;
  membership_uuid := pg_catalog.current_setting('app.membership_id',true)::pg_catalog.uuid;
  binding_uuid := pg_catalog.current_setting('app.role_binding_id',true)::pg_catalog.uuid;

  -- Hold shared row locks through the mutation so suspension/revocation and
  -- the write have one database serialization order.
  SELECT true INTO authorized
  FROM public.tenants AS tenant
  JOIN public.workspaces AS workspace
    ON workspace.tenant_id=tenant.id
    AND workspace.id=pg_catalog.current_setting('app.workspace_id',true)::pg_catalog.uuid
    AND workspace.status='active'
  JOIN public.tenant_memberships AS membership
    ON membership.tenant_id=tenant.id AND membership.id=membership_uuid
    AND membership.auth_identity_id=actor_uuid
    AND membership.pending_identity_ref_hash IS NULL AND membership.status='active'
    AND (membership.workspace_id IS NULL
      OR membership.workspace_id=pg_catalog.current_setting('app.workspace_id',true)::pg_catalog.uuid)
  JOIN public.tenant_role_bindings AS binding
    ON binding.tenant_id=tenant.id AND binding.id=binding_uuid
    AND binding.membership_id=membership.id
    AND binding.role=pg_catalog.current_setting('app.role',true)
    AND binding.role=ANY(p_allowed_roles)
    AND binding.valid_from<=pg_catalog.statement_timestamp() AND binding.revoked_at IS NULL
  WHERE tenant.id=pg_catalog.current_setting('app.tenant_id',true)::pg_catalog.uuid
    AND tenant.status='active'
  FOR SHARE OF tenant,workspace,membership,binding;
  RETURN authorized IS NOT DISTINCT FROM true;
EXCEPTION WHEN others THEN
  RETURN false;
END;
$fn$;

COMMENT ON FUNCTION public.novatrade_l03_member_authorized(pg_catalog.text[]) IS
  'L-03 read-path member predicate: exact GUC identity plus a live active membership and role binding.';
COMMENT ON FUNCTION public.novatrade_l03_member_lock(pg_catalog.text[]) IS
  'L-03 mutation-path member predicate: identical checks plus FOR SHARE revocation serialization.';

CREATE OR REPLACE FUNCTION public.novatrade_l03_worker_authorized(p_action pg_catalog.text)
RETURNS boolean
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $fn$
DECLARE
  tenant_setting pg_catalog.text := pg_catalog.current_setting('app.tenant_id',true);
  workspace_setting pg_catalog.text := pg_catalog.current_setting('app.workspace_id',true);
BEGIN
  IF p_action IS NULL OR p_action !~ '^document_(scan|extraction|pipeline|retention):[a-z_]+$' THEN
    RETURN false;
  END IF;
  IF tenant_setting IS NULL
     OR tenant_setting !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
     OR workspace_setting IS NULL
     OR workspace_setting !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
     OR pg_catalog.current_setting('app.job_id',true) IS NULL
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

  -- A worker context cannot carry member or support authority.
  IF coalesce(pg_catalog.current_setting('app.actor_id',true),'')<>''
     OR coalesce(pg_catalog.current_setting('app.membership_id',true),'')<>''
     OR coalesce(pg_catalog.current_setting('app.role',true),'')<>''
     OR coalesce(pg_catalog.current_setting('app.role_binding_id',true),'')<>''
     OR coalesce(pg_catalog.current_setting('app.support_grant_id',true),'')<>'' THEN
    RETURN false;
  END IF;

  RETURN EXISTS (
    SELECT 1
    FROM public.tenants AS tenant
    JOIN public.workspaces AS workspace
      ON workspace.tenant_id=tenant.id AND workspace.id=workspace_setting::pg_catalog.uuid
     AND workspace.status='active'
    WHERE tenant.id=tenant_setting::pg_catalog.uuid AND tenant.status='active'
  );
EXCEPTION WHEN others THEN
  RETURN false;
END;
$fn$;

COMMENT ON FUNCTION public.novatrade_l03_worker_authorized(pg_catalog.text) IS
  'L-03 boolean document-pipeline worker predicate; authority is the fenced job lease plus exact action GUC binding.';

-- ---------------------------------------------------------------------------
-- Member read of the exact upload reservation (upload completion needs it).
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.novatrade_get_document_reservation(
  p_tenant_id pg_catalog.text,
  p_workspace_id pg_catalog.text,
  p_document_id pg_catalog.text,
  p_version_id pg_catalog.text,
  p_idempotency_key pg_catalog.text
)
RETURNS TABLE (
  tenant_id pg_catalog.uuid,
  workspace_id pg_catalog.uuid,
  document_id pg_catalog.uuid,
  version_id pg_catalog.uuid,
  idempotency_key pg_catalog.text,
  source_identity pg_catalog.text,
  request_fingerprint pg_catalog.text,
  file_name pg_catalog.text,
  format pg_catalog.text,
  media_type pg_catalog.text,
  declared_byte_size pg_catalog.int8,
  max_bytes pg_catalog.int8,
  scanner_policy_version pg_catalog.text,
  object_key pg_catalog.text,
  state pg_catalog.text
)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $fn$
BEGIN
  IF p_tenant_id IS NULL OR p_tenant_id !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
     OR p_workspace_id IS NULL OR p_workspace_id !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
     OR p_document_id IS NULL OR p_document_id !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
     OR p_version_id IS NULL OR p_version_id !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
     OR p_idempotency_key IS NULL OR p_idempotency_key !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$'
  THEN
    RETURN;
  END IF;
  IF NULLIF(pg_catalog.current_setting('app.tenant_id',true),'') IS DISTINCT FROM p_tenant_id
     OR NULLIF(pg_catalog.current_setting('app.workspace_id',true),'') IS DISTINCT FROM p_workspace_id THEN
    RETURN;
  END IF;
  IF NOT public.novatrade_l03_member_authorized(ARRAY['owner','admin','strategist_manager','researcher','reviewer']) THEN
    RETURN;
  END IF;

  RETURN QUERY
  SELECT version.tenant_id,version.workspace_id,version.document_id,version.id,
    reservation.idempotency_key,document.source_identity,reservation.request_fingerprint,
    version.original_name,version.format,version.media_type,version.declared_byte_size,
    version.max_bytes,version.scanner_policy_version,version.object_key,version.status
  FROM public.document_upload_reservations AS reservation
  JOIN public.document_versions AS version
    ON version.tenant_id=reservation.tenant_id AND version.workspace_id=reservation.workspace_id
   AND version.document_id=reservation.document_id AND version.id=reservation.version_id
  JOIN public.documents AS document
    ON document.tenant_id=version.tenant_id AND document.workspace_id=version.workspace_id
   AND document.id=version.document_id
  WHERE reservation.tenant_id=p_tenant_id::pg_catalog.uuid
    AND reservation.workspace_id=p_workspace_id::pg_catalog.uuid
    AND reservation.document_id=p_document_id::pg_catalog.uuid
    AND reservation.version_id=p_version_id::pg_catalog.uuid
    AND reservation.idempotency_key=p_idempotency_key;
EXCEPTION WHEN others THEN
  RETURN;
END;
$fn$;

-- ---------------------------------------------------------------------------
-- Member finalize: verify the quarantined facts, dedupe tenant-locally, and
-- stage the canonical scan job plus its durable outbox atomically.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.novatrade_finalize_document_upload(
  p_tenant_id pg_catalog.text,
  p_workspace_id pg_catalog.text,
  p_document_id pg_catalog.text,
  p_version_id pg_catalog.text,
  p_idempotency_key pg_catalog.text,
  p_checksum pg_catalog.text,
  p_verified_byte_size pg_catalog.text,
  p_verified_media_type pg_catalog.text
)
RETURNS TABLE (
  kind pg_catalog.text,
  tenant_id pg_catalog.uuid,
  workspace_id pg_catalog.uuid,
  document_id pg_catalog.uuid,
  version_id pg_catalog.uuid,
  idempotency_key pg_catalog.text,
  source_identity pg_catalog.text,
  request_fingerprint pg_catalog.text,
  file_name pg_catalog.text,
  format pg_catalog.text,
  media_type pg_catalog.text,
  declared_byte_size pg_catalog.int8,
  max_bytes pg_catalog.int8,
  scanner_policy_version pg_catalog.text,
  object_key pg_catalog.text,
  state pg_catalog.text,
  checksum pg_catalog.text,
  processing_document_id pg_catalog.uuid,
  processing_version_id pg_catalog.uuid,
  processing_checksum pg_catalog.text,
  processing_policy_version pg_catalog.text,
  outbox_dispatch_key pg_catalog.text,
  outbox_job_id pg_catalog.uuid
)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog AS $fn$
DECLARE
  tenant_uuid pg_catalog.uuid;
  workspace_uuid pg_catalog.uuid;
  document_uuid pg_catalog.uuid;
  version_uuid pg_catalog.uuid;
  verified_size pg_catalog.int8;
  canonical_version pg_catalog.uuid;
  scan_job_uuid pg_catalog.uuid;
  dispatch_key pg_catalog.text;
  existing record;
BEGIN
  IF p_tenant_id IS NULL OR p_tenant_id !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
     OR p_workspace_id IS NULL OR p_workspace_id !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
     OR p_document_id IS NULL OR p_document_id !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
     OR p_version_id IS NULL OR p_version_id !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
     OR p_idempotency_key IS NULL OR p_idempotency_key !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$'
     OR p_checksum IS NULL OR p_checksum !~ '^[0-9a-f]{64}$'
     OR p_verified_byte_size IS NULL OR p_verified_byte_size !~ '^[1-9][0-9]{0,15}$'
     OR p_verified_media_type IS NULL OR pg_catalog.char_length(p_verified_media_type) NOT BETWEEN 3 AND 255
  THEN
    RETURN;
  END IF;
  IF NULLIF(pg_catalog.current_setting('app.tenant_id',true),'') IS DISTINCT FROM p_tenant_id
     OR NULLIF(pg_catalog.current_setting('app.workspace_id',true),'') IS DISTINCT FROM p_workspace_id THEN
    RETURN;
  END IF;
  IF NOT public.novatrade_l03_member_lock(ARRAY['owner','admin','strategist_manager']) THEN
    RETURN;
  END IF;

  tenant_uuid := p_tenant_id::pg_catalog.uuid;
  workspace_uuid := p_workspace_id::pg_catalog.uuid;
  document_uuid := p_document_id::pg_catalog.uuid;
  version_uuid := p_version_id::pg_catalog.uuid;
  verified_size := p_verified_byte_size::pg_catalog.int8;

  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(
    'l03-finalize:' || tenant_uuid::pg_catalog.text || ':' || p_idempotency_key, 0
  ));

  -- Exact replay: the finalized version returns its stored disposition.
  SELECT f.dedupe_decision, f.processing_version_id, f.checksum AS stored_checksum
    INTO existing
  FROM public.document_version_finalizations AS f
  WHERE f.tenant_id=tenant_uuid AND f.workspace_id=workspace_uuid
    AND f.document_id=document_uuid AND f.version_id=version_uuid;
  IF FOUND THEN
    IF existing.stored_checksum IS DISTINCT FROM p_checksum THEN
      RETURN;
    END IF;
    -- Replay returns the stored command result: the state column is the
    -- finalization outcome 'quarantined', not the version's live state, and a
    -- canonical replay re-arms its staged outbox message for dispatch retry.
    RETURN QUERY
    SELECT (CASE WHEN existing.dedupe_decision='duplicate' THEN 'duplicate' ELSE 'replay' END)::pg_catalog.text,
      v.tenant_id,v.workspace_id,v.document_id,v.id,r.idempotency_key,d.source_identity,
      r.request_fingerprint,v.original_name,v.format,v.media_type,v.declared_byte_size,v.max_bytes,
      v.scanner_policy_version,v.object_key,'quarantined'::pg_catalog.text,v.checksum,
      v.document_id,existing.processing_version_id,existing.stored_checksum,v.scanner_policy_version,
      o.dispatch_key,o.scan_job_id
    FROM public.document_versions AS v
    JOIN public.document_upload_reservations AS r
      ON r.tenant_id=v.tenant_id AND r.workspace_id=v.workspace_id
     AND r.document_id=v.document_id AND r.version_id=v.id AND r.idempotency_key=p_idempotency_key
    JOIN public.documents AS d
      ON d.tenant_id=v.tenant_id AND d.workspace_id=v.workspace_id AND d.id=v.document_id
    LEFT JOIN public.document_scan_outbox AS o
      ON o.tenant_id=v.tenant_id AND o.workspace_id=v.workspace_id
     AND o.document_id=v.document_id AND o.version_id=v.id
    WHERE v.tenant_id=tenant_uuid AND v.workspace_id=workspace_uuid
      AND v.document_id=document_uuid AND v.id=version_uuid;
    RETURN;
  END IF;

  -- The reservation row must exist and the version must still be reserved.
  IF NOT EXISTS (
    SELECT 1
    FROM public.document_upload_reservations AS r
    JOIN public.document_versions AS v
      ON v.tenant_id=r.tenant_id AND v.workspace_id=r.workspace_id
     AND v.document_id=r.document_id AND v.id=r.version_id
    WHERE r.tenant_id=tenant_uuid AND r.workspace_id=workspace_uuid
      AND r.document_id=document_uuid AND r.version_id=version_uuid
      AND r.idempotency_key=p_idempotency_key
      AND v.status='upload_reserved'
      AND v.declared_byte_size=verified_size
      AND v.media_type=p_verified_media_type
  ) THEN
    RETURN;
  END IF;

  -- Tenant-local dedupe over the canonical processing chain for this source.
  SELECT f.processing_version_id INTO canonical_version
  FROM public.document_version_finalizations AS f
  JOIN public.documents AS d
    ON d.tenant_id=f.tenant_id AND d.workspace_id=f.workspace_id
   AND d.id=f.document_id AND d.source_identity=f.source_identity
  WHERE f.tenant_id=tenant_uuid AND f.workspace_id=workspace_uuid
    AND f.document_id=document_uuid AND f.dedupe_decision='canonical'
    AND f.checksum=p_checksum AND f.version_id<>version_uuid
  ORDER BY f.id ASC
  LIMIT 1;

  UPDATE public.document_versions AS v
  SET status='quarantined',checksum=p_checksum,verified_byte_size=verified_size,
    verified_media_type=p_verified_media_type,
    duplicate_of_version_id=canonical_version,finalized_at=pg_catalog.statement_timestamp()
  WHERE v.tenant_id=tenant_uuid AND v.workspace_id=workspace_uuid
    AND v.document_id=document_uuid AND v.id=version_uuid AND v.status='upload_reserved';
  IF NOT FOUND THEN RETURN; END IF;

  IF canonical_version IS NOT NULL THEN
    INSERT INTO public.document_version_finalizations(
      tenant_id,workspace_id,document_id,source_identity,version_id,processing_version_id,
      checksum,checksum_algorithm,verified_byte_size,verified_media_type,scanner_policy_version,dedupe_decision)
    SELECT tenant_uuid,workspace_uuid,document_uuid,d.source_identity,version_uuid,canonical_version,
      p_checksum,'sha256',verified_size,p_verified_media_type,v.scanner_policy_version,'duplicate'
    FROM public.document_versions AS v
    JOIN public.documents AS d
      ON d.tenant_id=v.tenant_id AND d.workspace_id=v.workspace_id AND d.id=v.document_id
    WHERE v.tenant_id=tenant_uuid AND v.workspace_id=workspace_uuid
      AND v.document_id=document_uuid AND v.id=version_uuid;

    INSERT INTO public.document_lifecycle_events(
      tenant_id,workspace_id,document_id,version_id,actor_kind,actor_membership_id,
      from_state,to_state,reason_code,correlation_id)
    VALUES (tenant_uuid,workspace_uuid,document_uuid,version_uuid,'member',
      pg_catalog.current_setting('app.membership_id',true)::pg_catalog.uuid,
      'upload_reserved','quarantined','deduplicated',
      pg_catalog.current_setting('app.correlation_id',true));

    RETURN QUERY
    SELECT 'duplicate'::pg_catalog.text,v.tenant_id,v.workspace_id,v.document_id,v.id,
      r.idempotency_key,d.source_identity,r.request_fingerprint,v.original_name,v.format,v.media_type,
      v.declared_byte_size,v.max_bytes,v.scanner_policy_version,v.object_key,v.status,v.checksum,
      v.document_id,canonical_version,p_checksum,v.scanner_policy_version,
      NULL::pg_catalog.text,NULL::pg_catalog.uuid
    FROM public.document_versions AS v
    JOIN public.document_upload_reservations AS r
      ON r.tenant_id=v.tenant_id AND r.workspace_id=v.workspace_id
     AND r.document_id=v.document_id AND r.version_id=v.id
    JOIN public.documents AS d
      ON d.tenant_id=v.tenant_id AND d.workspace_id=v.workspace_id AND d.id=v.document_id
    WHERE v.tenant_id=tenant_uuid AND v.workspace_id=workspace_uuid
      AND v.document_id=document_uuid AND v.id=version_uuid;
    RETURN;
  END IF;

  INSERT INTO public.document_version_finalizations(
    tenant_id,workspace_id,document_id,source_identity,version_id,processing_version_id,
    checksum,checksum_algorithm,verified_byte_size,verified_media_type,scanner_policy_version,dedupe_decision)
  SELECT tenant_uuid,workspace_uuid,document_uuid,d.source_identity,version_uuid,version_uuid,
    p_checksum,'sha256',verified_size,p_verified_media_type,v.scanner_policy_version,'canonical'
  FROM public.document_versions AS v
  JOIN public.documents AS d
    ON d.tenant_id=v.tenant_id AND d.workspace_id=v.workspace_id AND d.id=v.document_id
  WHERE v.tenant_id=tenant_uuid AND v.workspace_id=workspace_uuid
    AND v.document_id=document_uuid AND v.id=version_uuid;

  scan_job_uuid := pg_catalog.gen_random_uuid();
  INSERT INTO public.document_scan_jobs(
    id,tenant_id,workspace_id,document_id,version_id,object_key,checksum,policy_version,max_attempts)
  SELECT scan_job_uuid,tenant_uuid,workspace_uuid,document_uuid,version_uuid,v.object_key,
    p_checksum,v.scanner_policy_version,5
  FROM public.document_versions AS v
  WHERE v.tenant_id=tenant_uuid AND v.workspace_id=workspace_uuid
    AND v.document_id=document_uuid AND v.id=version_uuid;

  dispatch_key := 'scan:' || tenant_uuid::pg_catalog.text || ':' || version_uuid::pg_catalog.text
    || ':' || p_checksum || ':';
  INSERT INTO public.document_scan_outbox(
    dispatch_key,tenant_id,workspace_id,document_id,version_id,scan_job_id,object_key,checksum,policy_version)
  SELECT dispatch_key || v.scanner_policy_version,tenant_uuid,workspace_uuid,document_uuid,version_uuid,
    scan_job_uuid,v.object_key,p_checksum,v.scanner_policy_version
  FROM public.document_versions AS v
  WHERE v.tenant_id=tenant_uuid AND v.workspace_id=workspace_uuid
    AND v.document_id=document_uuid AND v.id=version_uuid;

  INSERT INTO public.document_lifecycle_events(
    tenant_id,workspace_id,document_id,version_id,actor_kind,actor_membership_id,
    from_state,to_state,reason_code,correlation_id)
  VALUES (tenant_uuid,workspace_uuid,document_uuid,version_uuid,'member',
    pg_catalog.current_setting('app.membership_id',true)::pg_catalog.uuid,
    'upload_reserved','quarantined','upload_finalized',
    pg_catalog.current_setting('app.correlation_id',true));

  RETURN QUERY
  SELECT 'quarantined'::pg_catalog.text,v.tenant_id,v.workspace_id,v.document_id,v.id,
    r.idempotency_key,d.source_identity,r.request_fingerprint,v.original_name,v.format,v.media_type,
    v.declared_byte_size,v.max_bytes,v.scanner_policy_version,v.object_key,v.status,v.checksum,
    v.document_id,v.id,p_checksum,v.scanner_policy_version,
    o.dispatch_key,o.scan_job_id
  FROM public.document_versions AS v
  JOIN public.document_upload_reservations AS r
    ON r.tenant_id=v.tenant_id AND r.workspace_id=v.workspace_id
   AND r.document_id=v.document_id AND r.version_id=v.id
  JOIN public.documents AS d
    ON d.tenant_id=v.tenant_id AND d.workspace_id=v.workspace_id AND d.id=v.document_id
  JOIN public.document_scan_outbox AS o
    ON o.tenant_id=v.tenant_id AND o.workspace_id=v.workspace_id
   AND o.document_id=v.document_id AND o.version_id=v.id AND o.scan_job_id=scan_job_uuid
  WHERE v.tenant_id=tenant_uuid AND v.workspace_id=workspace_uuid
    AND v.document_id=document_uuid AND v.id=version_uuid;
EXCEPTION
  WHEN unique_violation OR check_violation OR foreign_key_violation OR raise_exception THEN
    RETURN;
END;
$fn$;

-- ---------------------------------------------------------------------------
-- Authorized URL intake: begin records the request and binds the URL hash to
-- one document; finalize stores the verified fetched facts atomically.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.novatrade_begin_document_url_intake(
  p_tenant_id pg_catalog.text,
  p_workspace_id pg_catalog.text,
  p_document_id pg_catalog.text,
  p_request_id pg_catalog.text,
  p_idempotency_key pg_catalog.text,
  p_url_sha256 pg_catalog.text,
  p_normalized_url pg_catalog.text,
  p_requested_name pg_catalog.text
)
RETURNS TABLE (
  kind pg_catalog.text,
  request_id pg_catalog.uuid,
  document_id pg_catalog.uuid,
  state pg_catalog.text
)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog AS $fn$
DECLARE
  tenant_uuid pg_catalog.uuid;
  workspace_uuid pg_catalog.uuid;
  document_uuid pg_catalog.uuid;
  request_uuid pg_catalog.uuid;
  existing_document pg_catalog.uuid;
BEGIN
  IF p_tenant_id IS NULL OR p_tenant_id !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
     OR p_workspace_id IS NULL OR p_workspace_id !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
     OR p_document_id IS NULL OR p_document_id !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
     OR p_request_id IS NULL OR p_request_id !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
     OR p_idempotency_key IS NULL OR p_idempotency_key !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$'
     OR p_url_sha256 IS NULL OR p_url_sha256 !~ '^[0-9a-f]{64}$'
     OR p_normalized_url IS NULL OR pg_catalog.char_length(p_normalized_url) NOT BETWEEN 12 AND 2048
     OR p_normalized_url !~ '^https?://' OR p_normalized_url ~ '[[:cntrl:]]'
     OR p_normalized_url<>pg_catalog.btrim(p_normalized_url)
     OR p_requested_name IS NULL OR pg_catalog.char_length(p_requested_name) NOT BETWEEN 1 AND 1024
     OR p_requested_name ~ '[[:cntrl:]]'
  THEN
    RETURN;
  END IF;
  IF NULLIF(pg_catalog.current_setting('app.tenant_id',true),'') IS DISTINCT FROM p_tenant_id
     OR NULLIF(pg_catalog.current_setting('app.workspace_id',true),'') IS DISTINCT FROM p_workspace_id THEN
    RETURN;
  END IF;
  IF NOT public.novatrade_l03_member_lock(ARRAY['owner','admin','strategist_manager']) THEN
    RETURN;
  END IF;

  tenant_uuid := p_tenant_id::pg_catalog.uuid;
  workspace_uuid := p_workspace_id::pg_catalog.uuid;
  document_uuid := p_document_id::pg_catalog.uuid;
  request_uuid := p_request_id::pg_catalog.uuid;

  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(
    'l03-url-intake:' || tenant_uuid::pg_catalog.text || ':' || p_idempotency_key, 0
  ));

  IF EXISTS (SELECT 1 FROM public.document_url_intake_requests AS r
    WHERE r.tenant_id=tenant_uuid AND r.idempotency_key=p_idempotency_key) THEN
    RETURN QUERY
      SELECT 'replay'::pg_catalog.text,r.id,r.document_id,r.state
      FROM public.document_url_intake_requests AS r
      WHERE r.tenant_id=tenant_uuid AND r.idempotency_key=p_idempotency_key
        AND r.id=request_uuid AND r.document_id=document_uuid
        AND r.workspace_id=workspace_uuid AND r.url_sha256=p_url_sha256
        AND r.normalized_url=p_normalized_url AND r.requested_name=p_requested_name;
    IF FOUND THEN RETURN; END IF;
    RETURN QUERY SELECT 'conflict'::pg_catalog.text,NULL::pg_catalog.uuid,NULL::pg_catalog.uuid,NULL::pg_catalog.text;
    RETURN;
  END IF;

  SELECT source.document_id INTO existing_document
  FROM public.document_url_sources AS source
  WHERE source.tenant_id=tenant_uuid AND source.workspace_id=workspace_uuid
    AND source.url_sha256=p_url_sha256;
  IF FOUND AND existing_document IS DISTINCT FROM document_uuid THEN
    RETURN QUERY SELECT 'conflict'::pg_catalog.text,NULL::pg_catalog.uuid,existing_document,NULL::pg_catalog.text;
    RETURN;
  END IF;

  IF existing_document IS NULL THEN
    INSERT INTO public.documents(id,tenant_id,workspace_id,source_kind,source_identity)
    VALUES (document_uuid,tenant_uuid,workspace_uuid,'authorized_url','authorized_url:'||document_uuid::pg_catalog.text);
    INSERT INTO public.document_url_sources(tenant_id,workspace_id,document_id,url_sha256,normalized_url)
    VALUES (tenant_uuid,workspace_uuid,document_uuid,p_url_sha256,p_normalized_url);
  END IF;

  INSERT INTO public.document_url_intake_requests(
    id,tenant_id,workspace_id,document_id,idempotency_key,url_sha256,normalized_url,requested_name)
  VALUES (request_uuid,tenant_uuid,workspace_uuid,document_uuid,p_idempotency_key,
    p_url_sha256,p_normalized_url,p_requested_name);

  RETURN QUERY SELECT 'created'::pg_catalog.text,request_uuid,document_uuid,'fetching'::pg_catalog.text;
EXCEPTION
  WHEN unique_violation OR check_violation OR foreign_key_violation THEN
    RETURN QUERY SELECT 'conflict'::pg_catalog.text,NULL::pg_catalog.uuid,NULL::pg_catalog.uuid,NULL::pg_catalog.text;
END;
$fn$;

CREATE OR REPLACE FUNCTION public.novatrade_lookup_document_url_source(
  p_tenant_id pg_catalog.text,
  p_workspace_id pg_catalog.text,
  p_url_sha256 pg_catalog.text
)
RETURNS TABLE (document_id pg_catalog.uuid, normalized_url pg_catalog.text)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $fn$
BEGIN
  IF p_tenant_id IS NULL OR p_tenant_id !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
     OR p_workspace_id IS NULL OR p_workspace_id !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
     OR p_url_sha256 IS NULL OR p_url_sha256 !~ '^[0-9a-f]{64}$'
  THEN
    RETURN;
  END IF;
  IF NULLIF(pg_catalog.current_setting('app.tenant_id',true),'') IS DISTINCT FROM p_tenant_id
     OR NULLIF(pg_catalog.current_setting('app.workspace_id',true),'') IS DISTINCT FROM p_workspace_id THEN
    RETURN;
  END IF;
  IF NOT public.novatrade_l03_member_authorized(ARRAY['owner','admin','strategist_manager','researcher','reviewer']) THEN
    RETURN;
  END IF;
  RETURN QUERY
  SELECT source.document_id,source.normalized_url
  FROM public.document_url_sources AS source
  WHERE source.tenant_id=p_tenant_id::pg_catalog.uuid
    AND source.workspace_id=p_workspace_id::pg_catalog.uuid
    AND source.url_sha256=p_url_sha256;
EXCEPTION WHEN others THEN
  RETURN;
END;
$fn$;

CREATE OR REPLACE FUNCTION public.novatrade_finalize_document_url_intake(
  p_tenant_id pg_catalog.text,
  p_workspace_id pg_catalog.text,
  p_request_id pg_catalog.text,
  p_document_id pg_catalog.text,
  p_version_id pg_catalog.text,
  p_format pg_catalog.text,
  p_media_type pg_catalog.text,
  p_declared_byte_size pg_catalog.text,
  p_scanner_policy_version pg_catalog.text,
  p_checksum pg_catalog.text,
  p_final_url_sha256 pg_catalog.text,
  p_redirect_count pg_catalog.text
)
RETURNS TABLE (
  kind pg_catalog.text,
  version_id pg_catalog.uuid,
  state pg_catalog.text,
  checksum pg_catalog.text,
  processing_version_id pg_catalog.uuid,
  scan_job_id pg_catalog.uuid,
  dispatch_key pg_catalog.text
)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog AS $fn$
DECLARE
  tenant_uuid pg_catalog.uuid;
  workspace_uuid pg_catalog.uuid;
  document_uuid pg_catalog.uuid;
  request_uuid pg_catalog.uuid;
  version_uuid pg_catalog.uuid;
  declared_size pg_catalog.int8;
  redirect_value pg_catalog.int4;
  canonical_version pg_catalog.uuid;
  scan_job_uuid pg_catalog.uuid;
  expected_media pg_catalog.text;
  expected_maximum pg_catalog.int8 := 52428800;
  object_key pg_catalog.text;
  request_row record;
BEGIN
  IF p_tenant_id IS NULL OR p_tenant_id !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
     OR p_workspace_id IS NULL OR p_workspace_id !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
     OR p_request_id IS NULL OR p_request_id !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
     OR p_document_id IS NULL OR p_document_id !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
     OR p_version_id IS NULL OR p_version_id !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
     OR p_format IS NULL OR p_format NOT IN ('pdf','docx','xlsx','csv','txt','markdown','jpeg','png')
     OR p_media_type IS NULL OR pg_catalog.char_length(p_media_type) NOT BETWEEN 3 AND 255
     OR p_declared_byte_size IS NULL OR p_declared_byte_size !~ '^[1-9][0-9]{0,15}$'
     OR p_scanner_policy_version IS NULL OR p_scanner_policy_version !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$'
     OR p_checksum IS NULL OR p_checksum !~ '^[0-9a-f]{64}$'
     OR p_final_url_sha256 IS NULL OR p_final_url_sha256 !~ '^[0-9a-f]{64}$'
     OR p_redirect_count IS NULL OR p_redirect_count !~ '^[0-5]$'
  THEN
    RETURN;
  END IF;
  IF NULLIF(pg_catalog.current_setting('app.tenant_id',true),'') IS DISTINCT FROM p_tenant_id
     OR NULLIF(pg_catalog.current_setting('app.workspace_id',true),'') IS DISTINCT FROM p_workspace_id THEN
    RETURN;
  END IF;
  IF NOT public.novatrade_l03_member_lock(ARRAY['owner','admin','strategist_manager']) THEN
    RETURN;
  END IF;

  expected_media := CASE p_format
    WHEN 'pdf' THEN 'application/pdf'
    WHEN 'docx' THEN 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
    WHEN 'xlsx' THEN 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
    WHEN 'csv' THEN 'text/csv'
    WHEN 'txt' THEN 'text/plain'
    WHEN 'markdown' THEN 'text/markdown'
    WHEN 'jpeg' THEN 'image/jpeg'
    WHEN 'png' THEN 'image/png'
  END;
  expected_maximum := CASE WHEN p_format IN ('jpeg','png') THEN 20971520 ELSE 52428800 END;
  IF p_media_type<>expected_media THEN RETURN; END IF;

  tenant_uuid := p_tenant_id::pg_catalog.uuid;
  workspace_uuid := p_workspace_id::pg_catalog.uuid;
  document_uuid := p_document_id::pg_catalog.uuid;
  request_uuid := p_request_id::pg_catalog.uuid;
  version_uuid := p_version_id::pg_catalog.uuid;
  declared_size := p_declared_byte_size::pg_catalog.int8;
  redirect_value := p_redirect_count::pg_catalog.int4;
  object_key := 'tenants/' || p_tenant_id || '/documents/' || p_document_id
    || '/versions/' || p_version_id || '/original';
  IF declared_size>expected_maximum THEN RETURN; END IF;

  SELECT * INTO request_row
  FROM public.document_url_intake_requests AS r
  WHERE r.tenant_id=tenant_uuid AND r.workspace_id=workspace_uuid
    AND r.id=request_uuid AND r.document_id=document_uuid
  FOR UPDATE;
  IF NOT FOUND OR request_row.state<>'fetching' THEN RETURN; END IF;

  -- Dedupe against prior canonical versions of this exact URL source.
  SELECT f.processing_version_id INTO canonical_version
  FROM public.document_version_finalizations AS f
  WHERE f.tenant_id=tenant_uuid AND f.workspace_id=workspace_uuid
    AND f.document_id=document_uuid AND f.dedupe_decision='canonical'
    AND f.checksum=p_checksum
  ORDER BY f.id ASC
  LIMIT 1;

  INSERT INTO public.document_versions(
    id,tenant_id,workspace_id,document_id,original_name,format,media_type,declared_byte_size,
    max_bytes,scanner_policy_version,object_key,status,checksum,verified_byte_size,
    verified_media_type,duplicate_of_version_id,finalized_at)
  VALUES (
    version_uuid,tenant_uuid,workspace_uuid,document_uuid,request_row.requested_name,p_format,
    p_media_type,declared_size,expected_maximum,p_scanner_policy_version,object_key,
    'quarantined',p_checksum,declared_size,p_media_type,canonical_version,
    pg_catalog.statement_timestamp());

  INSERT INTO public.document_version_finalizations(
    tenant_id,workspace_id,document_id,source_identity,version_id,processing_version_id,
    checksum,checksum_algorithm,verified_byte_size,verified_media_type,scanner_policy_version,dedupe_decision)
  VALUES (
    tenant_uuid,workspace_uuid,document_uuid,'authorized_url:'||document_uuid::pg_catalog.text,
    version_uuid,coalesce(canonical_version,version_uuid),p_checksum,'sha256',declared_size,
    p_media_type,p_scanner_policy_version,
    CASE WHEN canonical_version IS NULL THEN 'canonical' ELSE 'duplicate' END);

  IF canonical_version IS NULL THEN
    scan_job_uuid := pg_catalog.gen_random_uuid();
    INSERT INTO public.document_scan_jobs(
      id,tenant_id,workspace_id,document_id,version_id,object_key,checksum,policy_version,max_attempts)
    VALUES (scan_job_uuid,tenant_uuid,workspace_uuid,document_uuid,version_uuid,object_key,
      p_checksum,p_scanner_policy_version,5);
    INSERT INTO public.document_scan_outbox(
      dispatch_key,tenant_id,workspace_id,document_id,version_id,scan_job_id,object_key,checksum,policy_version)
    VALUES ('scan:'||p_tenant_id||':'||p_version_id||':'||p_checksum||':'||p_scanner_policy_version,
      tenant_uuid,workspace_uuid,document_uuid,version_uuid,scan_job_uuid,object_key,
      p_checksum,p_scanner_policy_version);
  END IF;

  UPDATE public.document_url_intake_requests AS r
  SET state='quarantined',version_id=version_uuid,checksum=p_checksum,
    final_url_sha256=p_final_url_sha256,redirect_count=redirect_value,byte_size=declared_size,
    fetched_at=pg_catalog.statement_timestamp(),updated_at=pg_catalog.statement_timestamp()
  WHERE r.tenant_id=tenant_uuid AND r.workspace_id=workspace_uuid AND r.id=request_uuid
    AND r.state='fetching';

  INSERT INTO public.document_lifecycle_events(
    tenant_id,workspace_id,document_id,version_id,actor_kind,actor_membership_id,
    from_state,to_state,reason_code,correlation_id)
  VALUES (tenant_uuid,workspace_uuid,document_uuid,version_uuid,'member',
    pg_catalog.current_setting('app.membership_id',true)::pg_catalog.uuid,
    NULL,'quarantined','url_intake_finalized',
    pg_catalog.current_setting('app.correlation_id',true));

  RETURN QUERY SELECT
    (CASE WHEN canonical_version IS NULL THEN 'quarantined' ELSE 'duplicate' END)::pg_catalog.text,
    version_uuid,'quarantined'::pg_catalog.text,p_checksum,
    coalesce(canonical_version,version_uuid),scan_job_uuid,
    (CASE WHEN canonical_version IS NULL
      THEN 'scan:'||p_tenant_id||':'||p_version_id||':'||p_checksum||':'||p_scanner_policy_version
      ELSE NULL END)::pg_catalog.text;
EXCEPTION
  WHEN unique_violation OR check_violation OR foreign_key_violation OR raise_exception THEN
    RETURN;
END;
$fn$;

CREATE OR REPLACE FUNCTION public.novatrade_fail_document_url_intake(
  p_tenant_id pg_catalog.text,
  p_workspace_id pg_catalog.text,
  p_request_id pg_catalog.text,
  p_document_id pg_catalog.text,
  p_state pg_catalog.text,
  p_reason_code pg_catalog.text
)
RETURNS TABLE (kind pg_catalog.text, state pg_catalog.text)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog AS $fn$
BEGIN
  IF p_tenant_id IS NULL OR p_tenant_id !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
     OR p_workspace_id IS NULL OR p_workspace_id !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
     OR p_request_id IS NULL OR p_request_id !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
     OR p_document_id IS NULL OR p_document_id !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
     OR p_state IS NULL OR p_state NOT IN ('blocked_security','rejected','failed')
     OR p_reason_code IS NULL OR pg_catalog.char_length(p_reason_code) NOT BETWEEN 1 AND 128
     OR p_reason_code<>pg_catalog.btrim(p_reason_code) OR p_reason_code ~ '[[:cntrl:]]'
  THEN
    RETURN;
  END IF;
  IF NULLIF(pg_catalog.current_setting('app.tenant_id',true),'') IS DISTINCT FROM p_tenant_id
     OR NULLIF(pg_catalog.current_setting('app.workspace_id',true),'') IS DISTINCT FROM p_workspace_id THEN
    RETURN;
  END IF;
  IF NOT public.novatrade_l03_member_lock(ARRAY['owner','admin','strategist_manager']) THEN
    RETURN;
  END IF;

  RETURN QUERY
  WITH updated AS (
    UPDATE public.document_url_intake_requests AS r
    SET state=p_state,reason_code=p_reason_code,updated_at=pg_catalog.statement_timestamp()
    WHERE r.tenant_id=p_tenant_id::pg_catalog.uuid AND r.workspace_id=p_workspace_id::pg_catalog.uuid
      AND r.id=p_request_id::pg_catalog.uuid AND r.document_id=p_document_id::pg_catalog.uuid
      AND r.state='fetching'
    RETURNING r.state
  )
  SELECT 'updated'::pg_catalog.text,updated.state FROM updated;
EXCEPTION WHEN others THEN
  RETURN;
END;
$fn$;

-- ---------------------------------------------------------------------------
-- Deny-by-default hardening: new tables keep FORCE RLS with no member
-- policies, all L-03 functions are revoked from PUBLIC/anon/authenticated,
-- and the RPC surface is owned by the least-privilege definer role.
-- ---------------------------------------------------------------------------
ALTER TABLE public.document_url_sources ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.document_url_sources FORCE ROW LEVEL SECURITY;
ALTER TABLE public.document_url_intake_requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.document_url_intake_requests FORCE ROW LEVEL SECURITY;
ALTER TABLE public.document_lifecycle_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.document_lifecycle_events FORCE ROW LEVEL SECURITY;
ALTER TABLE public.document_deletion_requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.document_deletion_requests FORCE ROW LEVEL SECURITY;
ALTER TABLE public.document_retention_evaluations ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.document_retention_evaluations FORCE ROW LEVEL SECURITY;

DO $security$
DECLARE
  table_name pg_catalog.text;
  role_name pg_catalog.text;
BEGIN
  FOREACH table_name IN ARRAY ARRAY[
    'document_url_sources','document_url_intake_requests','document_lifecycle_events',
    'document_deletion_requests','document_retention_evaluations'] LOOP
    EXECUTE pg_catalog.format('REVOKE ALL ON TABLE public.%I FROM PUBLIC',table_name);
    FOREACH role_name IN ARRAY ARRAY['anon','authenticated'] LOOP
      IF pg_catalog.to_regrole(role_name) IS NOT NULL THEN
        EXECUTE pg_catalog.format('REVOKE ALL ON TABLE public.%I FROM %I',table_name,role_name);
      END IF;
    END LOOP;
  END LOOP;
  EXECUTE 'REVOKE ALL ON SEQUENCE public.document_lifecycle_events_id_seq,
    public.document_retention_evaluations_id_seq FROM PUBLIC';
  FOREACH role_name IN ARRAY ARRAY['anon','authenticated'] LOOP
    IF pg_catalog.to_regrole(role_name) IS NOT NULL THEN
      EXECUTE pg_catalog.format('REVOKE ALL ON SEQUENCE
        public.document_lifecycle_events_id_seq,public.document_retention_evaluations_id_seq FROM %I',role_name);
    END IF;
  END LOOP;
  EXECUTE 'REVOKE ALL ON FUNCTION
    public.novatrade_l03_member_authorized(pg_catalog.text[]),
    public.novatrade_l03_member_lock(pg_catalog.text[]),
    public.novatrade_l03_worker_authorized(pg_catalog.text),
    public.novatrade_get_document_reservation(pg_catalog.text,pg_catalog.text,pg_catalog.text,pg_catalog.text,pg_catalog.text),
    public.novatrade_finalize_document_upload(pg_catalog.text,pg_catalog.text,pg_catalog.text,pg_catalog.text,pg_catalog.text,pg_catalog.text,pg_catalog.text,pg_catalog.text),
    public.novatrade_begin_document_url_intake(pg_catalog.text,pg_catalog.text,pg_catalog.text,pg_catalog.text,pg_catalog.text,pg_catalog.text,pg_catalog.text,pg_catalog.text),
    public.novatrade_lookup_document_url_source(pg_catalog.text,pg_catalog.text,pg_catalog.text),
    public.novatrade_finalize_document_url_intake(pg_catalog.text,pg_catalog.text,pg_catalog.text,pg_catalog.text,pg_catalog.text,pg_catalog.text,pg_catalog.text,pg_catalog.text,pg_catalog.text,pg_catalog.text,pg_catalog.text,pg_catalog.text),
    public.novatrade_fail_document_url_intake(pg_catalog.text,pg_catalog.text,pg_catalog.text,pg_catalog.text,pg_catalog.text,pg_catalog.text)
    FROM PUBLIC';
  FOREACH role_name IN ARRAY ARRAY['anon','authenticated'] LOOP
    IF pg_catalog.to_regrole(role_name) IS NOT NULL THEN
      EXECUTE pg_catalog.format('REVOKE ALL ON FUNCTION
        public.novatrade_l03_member_authorized(pg_catalog.text[]),
        public.novatrade_l03_member_lock(pg_catalog.text[]),
        public.novatrade_l03_worker_authorized(pg_catalog.text),
        public.novatrade_get_document_reservation(pg_catalog.text,pg_catalog.text,pg_catalog.text,pg_catalog.text,pg_catalog.text),
        public.novatrade_finalize_document_upload(pg_catalog.text,pg_catalog.text,pg_catalog.text,pg_catalog.text,pg_catalog.text,pg_catalog.text,pg_catalog.text,pg_catalog.text),
        public.novatrade_begin_document_url_intake(pg_catalog.text,pg_catalog.text,pg_catalog.text,pg_catalog.text,pg_catalog.text,pg_catalog.text,pg_catalog.text,pg_catalog.text),
        public.novatrade_lookup_document_url_source(pg_catalog.text,pg_catalog.text,pg_catalog.text),
        public.novatrade_finalize_document_url_intake(pg_catalog.text,pg_catalog.text,pg_catalog.text,pg_catalog.text,pg_catalog.text,pg_catalog.text,pg_catalog.text,pg_catalog.text,pg_catalog.text,pg_catalog.text,pg_catalog.text,pg_catalog.text),
        public.novatrade_fail_document_url_intake(pg_catalog.text,pg_catalog.text,pg_catalog.text,pg_catalog.text,pg_catalog.text,pg_catalog.text)
        FROM %I',role_name);
    END IF;
  END LOOP;
END;
$security$;

ALTER FUNCTION public.novatrade_l03_member_authorized(pg_catalog.text[])
  OWNER TO novatrade_document_pipeline_definer;
ALTER FUNCTION public.novatrade_l03_member_lock(pg_catalog.text[])
  OWNER TO novatrade_document_pipeline_definer;
ALTER FUNCTION public.novatrade_l03_worker_authorized(pg_catalog.text)
  OWNER TO novatrade_document_pipeline_definer;
ALTER FUNCTION public.novatrade_get_document_reservation(
  pg_catalog.text,pg_catalog.text,pg_catalog.text,pg_catalog.text,pg_catalog.text)
  OWNER TO novatrade_document_pipeline_definer;
ALTER FUNCTION public.novatrade_finalize_document_upload(
  pg_catalog.text,pg_catalog.text,pg_catalog.text,pg_catalog.text,pg_catalog.text,
  pg_catalog.text,pg_catalog.text,pg_catalog.text)
  OWNER TO novatrade_document_pipeline_definer;
ALTER FUNCTION public.novatrade_begin_document_url_intake(
  pg_catalog.text,pg_catalog.text,pg_catalog.text,pg_catalog.text,pg_catalog.text,
  pg_catalog.text,pg_catalog.text,pg_catalog.text)
  OWNER TO novatrade_document_pipeline_definer;
ALTER FUNCTION public.novatrade_lookup_document_url_source(
  pg_catalog.text,pg_catalog.text,pg_catalog.text)
  OWNER TO novatrade_document_pipeline_definer;
ALTER FUNCTION public.novatrade_finalize_document_url_intake(
  pg_catalog.text,pg_catalog.text,pg_catalog.text,pg_catalog.text,pg_catalog.text,pg_catalog.text,
  pg_catalog.text,pg_catalog.text,pg_catalog.text,pg_catalog.text,pg_catalog.text,pg_catalog.text)
  OWNER TO novatrade_document_pipeline_definer;
ALTER FUNCTION public.novatrade_fail_document_url_intake(
  pg_catalog.text,pg_catalog.text,pg_catalog.text,pg_catalog.text,pg_catalog.text,pg_catalog.text)
  OWNER TO novatrade_document_pipeline_definer;

GRANT USAGE ON SCHEMA public TO novatrade_document_pipeline_definer;
GRANT SELECT ON TABLE public.documents,public.document_upload_reservations
  TO novatrade_document_pipeline_definer;
-- FOR SHARE inside novatrade_l03_member_lock requires UPDATE on every locked
-- relation; the lock is what serializes member mutations against concurrent
-- membership/binding revocation writes.
GRANT SELECT,UPDATE ON TABLE public.tenants,public.workspaces,public.tenant_memberships,
  public.tenant_role_bindings
  TO novatrade_document_pipeline_definer;
GRANT SELECT,INSERT,UPDATE ON TABLE public.document_versions
  TO novatrade_document_pipeline_definer;
GRANT SELECT,INSERT ON TABLE public.document_version_finalizations
  TO novatrade_document_pipeline_definer;
GRANT SELECT,INSERT,UPDATE ON TABLE public.document_scan_jobs,public.document_scan_outbox,
  public.document_extraction_jobs TO novatrade_document_pipeline_definer;
GRANT INSERT ON TABLE public.documents TO novatrade_document_pipeline_definer;
GRANT SELECT,INSERT ON TABLE public.document_url_sources TO novatrade_document_pipeline_definer;
GRANT SELECT,INSERT,UPDATE ON TABLE public.document_url_intake_requests
  TO novatrade_document_pipeline_definer;
GRANT SELECT,INSERT ON TABLE public.document_lifecycle_events TO novatrade_document_pipeline_definer;
GRANT SELECT,INSERT,UPDATE ON TABLE public.document_deletion_requests
  TO novatrade_document_pipeline_definer;
GRANT SELECT,INSERT ON TABLE public.document_retention_evaluations
  TO novatrade_document_pipeline_definer;
GRANT USAGE ON SEQUENCE public.document_lifecycle_events_id_seq,
  public.document_retention_evaluations_id_seq,
  public.document_version_finalizations_id_seq,
  public.document_scan_outbox_id_seq TO novatrade_document_pipeline_definer;

DO $receipt$
DECLARE
  rls_count pg_catalog.int4;
  policy_count pg_catalog.int4;
  function_count pg_catalog.int4;
  owned_count pg_catalog.int4;
BEGIN
  SELECT count(*) INTO rls_count
  FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace
  WHERE n.nspname='public' AND c.relname IN (
    'document_url_sources','document_url_intake_requests','document_lifecycle_events',
    'document_deletion_requests','document_retention_evaluations'
  ) AND c.relrowsecurity AND c.relforcerowsecurity;
  SELECT count(*) INTO policy_count
  FROM pg_catalog.pg_policy p
  JOIN pg_catalog.pg_class c ON c.oid=p.polrelid
  JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace
  WHERE n.nspname='public' AND c.relname IN (
    'document_url_sources','document_url_intake_requests','document_lifecycle_events',
    'document_deletion_requests','document_retention_evaluations');
  SELECT count(*) INTO function_count
  FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_namespace n ON n.oid=p.pronamespace
  WHERE n.nspname='public' AND p.proname IN (
    'novatrade_l03_member_authorized','novatrade_l03_member_lock','novatrade_l03_worker_authorized',
    'novatrade_get_document_reservation','novatrade_finalize_document_upload',
    'novatrade_begin_document_url_intake','novatrade_lookup_document_url_source',
    'novatrade_finalize_document_url_intake','novatrade_fail_document_url_intake');
  SELECT count(*) INTO owned_count
  FROM pg_catalog.pg_proc p
  JOIN pg_catalog.pg_namespace n ON n.oid=p.pronamespace
  JOIN pg_catalog.pg_roles r ON r.oid=p.proowner
  WHERE n.nspname='public' AND r.rolname='novatrade_document_pipeline_definer'
    AND p.proname LIKE 'novatrade_l03_%' OR (r.rolname='novatrade_document_pipeline_definer'
    AND p.proname IN ('novatrade_get_document_reservation','novatrade_finalize_document_upload',
      'novatrade_begin_document_url_intake','novatrade_lookup_document_url_source',
      'novatrade_finalize_document_url_intake','novatrade_fail_document_url_intake'));
  IF rls_count<>5 OR policy_count<>0 OR function_count<>9 OR owned_count<>9 THEN
    RAISE EXCEPTION 'L-03 document pipeline runtime catalog incomplete' USING ERRCODE='P0001';
  END IF;
END;
$receipt$;

COMMIT;
