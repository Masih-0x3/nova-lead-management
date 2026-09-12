-- L-05 connector execution worker registration.
--
-- Registers the "connector_execution" scheduler worker name and its
-- "connector_execution:process" action inside the durable tenant worker
-- dispatch foundation: the lease worker_name/action CHECK constraints, the
-- guarded acquire/cancel/resolve functions, and the app settings toggle that
-- gates cron-driven ticks. Worker routes still resolve scope exclusively from
-- sealed dispatch leases; this migration only widens the closed worker-name
-- domain so connector leases can be issued and resolved.
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '120s';
SELECT pg_catalog.pg_advisory_xact_lock(
  pg_catalog.hashtext('novatrade:l05:connector-execution-worker')
);

ALTER TABLE public.settings
  ADD COLUMN IF NOT EXISTS scheduler_connector_execution_enabled integer NOT NULL DEFAULT 1;

ALTER TABLE public.tenant_worker_dispatch_leases
  DROP CONSTRAINT tenant_worker_dispatch_leases_worker_name_chk;
ALTER TABLE public.tenant_worker_dispatch_leases
  ADD CONSTRAINT tenant_worker_dispatch_leases_worker_name_chk
  CHECK (worker_name IN ('ai_verification','crawl','enrichment','artifact','score_recompute','connector_execution'));

ALTER TABLE public.tenant_worker_dispatch_leases
  DROP CONSTRAINT tenant_worker_dispatch_leases_action_chk;
ALTER TABLE public.tenant_worker_dispatch_leases
  ADD CONSTRAINT tenant_worker_dispatch_leases_action_chk
  CHECK (action = CASE worker_name
    WHEN 'ai_verification' THEN 'ai_verification:process'
    WHEN 'crawl' THEN 'crawl:process'
    WHEN 'enrichment' THEN 'enrichment:process'
    WHEN 'artifact' THEN 'artifact:process'
    WHEN 'score_recompute' THEN 'score_recompute:recompute'
    WHEN 'connector_execution' THEN 'connector_execution:process'
  END);

CREATE OR REPLACE FUNCTION public.novatrade_acquire_tenant_worker_lease(
  p_selector_hash pg_catalog.text,
  p_tenant_id pg_catalog.text,
  p_workspace_id pg_catalog.text,
  p_job_id pg_catalog.text,
  p_run_id pg_catalog.text,
  p_lease_id pg_catalog.text,
  p_lease_generation pg_catalog.text,
  p_worker_name pg_catalog.text,
  p_action pg_catalog.text,
  p_not_before pg_catalog.text,
  p_expires_at pg_catalog.text,
  p_correlation_id pg_catalog.text
)
RETURNS TABLE (
  kind pg_catalog.text,
  tenant_id pg_catalog.uuid,
  workspace_id pg_catalog.uuid,
  job_id pg_catalog.uuid,
  run_id pg_catalog.uuid,
  lease_id pg_catalog.uuid,
  selector_hash pg_catalog.text,
  lease_generation pg_catalog.int8,
  worker_name pg_catalog.text,
  action pg_catalog.text,
  not_before pg_catalog.timestamptz,
  expires_at pg_catalog.timestamptz,
  correlation_id pg_catalog.text,
  record_version pg_catalog.int2,
  integrity_version pg_catalog.text
)
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog
AS $function$
DECLARE
  tenant_uuid pg_catalog.uuid;
  workspace_uuid pg_catalog.uuid;
  job_uuid pg_catalog.uuid;
  run_uuid pg_catalog.uuid;
  lease_uuid pg_catalog.uuid;
  generation_value pg_catalog.int8;
  not_before_value pg_catalog.timestamptz;
  expires_at_value pg_catalog.timestamptz;
  current_generation pg_catalog.int8;
  current_workspace pg_catalog.uuid;
  current_run pg_catalog.uuid;
BEGIN
  IF p_selector_hash IS NULL OR p_selector_hash !~ '^[0-9a-f]{64}$'
     OR p_tenant_id IS NULL OR p_tenant_id !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
     OR (p_workspace_id IS NOT NULL AND p_workspace_id !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$')
     OR p_job_id IS NULL OR p_job_id !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
     OR p_run_id IS NULL OR p_run_id !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
     OR p_lease_id IS NULL OR p_lease_id !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
     OR p_lease_generation IS NULL OR p_lease_generation !~ '^[1-9][0-9]{0,15}$'
     OR p_worker_name IS NULL OR p_worker_name NOT IN ('ai_verification','crawl','enrichment','artifact','score_recompute','connector_execution')
     OR p_action IS NULL OR p_action IS DISTINCT FROM (CASE p_worker_name
       WHEN 'ai_verification' THEN 'ai_verification:process'
       WHEN 'crawl' THEN 'crawl:process'
       WHEN 'enrichment' THEN 'enrichment:process'
       WHEN 'artifact' THEN 'artifact:process'
       WHEN 'score_recompute' THEN 'score_recompute:recompute'
       WHEN 'connector_execution' THEN 'connector_execution:process'
     END)
     OR p_not_before IS NULL
     OR p_expires_at IS NULL
     OR p_correlation_id IS NULL OR p_correlation_id !~ '^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$'
  THEN
    RETURN;
  END IF;

  BEGIN
    tenant_uuid := p_tenant_id::pg_catalog.uuid;
    workspace_uuid := p_workspace_id::pg_catalog.uuid;
    job_uuid := p_job_id::pg_catalog.uuid;
    run_uuid := p_run_id::pg_catalog.uuid;
    lease_uuid := p_lease_id::pg_catalog.uuid;
    generation_value := p_lease_generation::pg_catalog.int8;
    not_before_value := p_not_before::pg_catalog.timestamptz;
    expires_at_value := p_expires_at::pg_catalog.timestamptz;
  EXCEPTION WHEN others THEN
    RETURN;
  END;

  IF generation_value NOT BETWEEN 1 AND 9007199254740991
     OR expires_at_value <= not_before_value
     OR expires_at_value <= pg_catalog.statement_timestamp()
     OR not_before_value > pg_catalog.statement_timestamp() + pg_catalog.interval '1 minute'
     OR expires_at_value > pg_catalog.statement_timestamp() + pg_catalog.interval '1 hour'
     OR NOT EXISTS (
       SELECT 1 FROM public.tenants AS tenant
       WHERE tenant.id=tenant_uuid AND tenant.status='active'
     )
     OR (workspace_uuid IS NOT NULL AND NOT EXISTS (
       SELECT 1 FROM public.workspaces AS workspace
       WHERE workspace.tenant_id=tenant_uuid AND workspace.id=workspace_uuid AND workspace.status='active'
     ))
  THEN
    RETURN;
  END IF;

  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(
    tenant_uuid::pg_catalog.text || ':' || job_uuid::pg_catalog.text || ':' || p_worker_name || ':' || p_action,
    0
  ));

  SELECT lease.lease_generation, lease.workspace_id, lease.run_id
    INTO current_generation, current_workspace, current_run
  FROM public.tenant_worker_dispatch_leases AS lease
  WHERE lease.tenant_id=tenant_uuid AND lease.job_id=job_uuid
    AND lease.worker_name=p_worker_name AND lease.action=p_action
  ORDER BY lease.lease_generation DESC
  LIMIT 1;

  IF current_generation IS NOT NULL AND (
    current_workspace IS DISTINCT FROM workspace_uuid OR current_run IS DISTINCT FROM run_uuid
  ) THEN
    RETURN;
  END IF;

  IF current_generation IS NOT NULL AND generation_value < current_generation THEN
    RETURN;
  END IF;

  IF current_generation IS NOT NULL AND generation_value = current_generation THEN
    RETURN QUERY
    SELECT 'replay'::pg_catalog.text, lease.tenant_id, lease.workspace_id, lease.job_id,
      lease.run_id, lease.lease_id, lease.selector_hash, lease.lease_generation, lease.worker_name,
      lease.action, lease.not_before, lease.expires_at, lease.correlation_id,
      lease.record_version, lease.integrity_version
    FROM public.tenant_worker_dispatch_leases AS lease
    WHERE lease.tenant_id=tenant_uuid AND lease.job_id=job_uuid
      AND lease.worker_name=p_worker_name AND lease.action=p_action
      AND lease.lease_generation=generation_value
      AND lease.lease_id=lease_uuid AND lease.selector_hash=p_selector_hash
      AND lease.workspace_id IS NOT DISTINCT FROM workspace_uuid
      AND lease.run_id=run_uuid AND lease.not_before=not_before_value
      AND lease.expires_at=expires_at_value AND lease.correlation_id=p_correlation_id
      AND lease.revoked_at IS NULL
      AND pg_catalog.statement_timestamp() < lease.expires_at;
    RETURN;
  END IF;

  UPDATE public.tenant_worker_dispatch_leases AS lease
  SET revoked_at=pg_catalog.statement_timestamp(), revocation_reason='superseded'
  WHERE lease.tenant_id=tenant_uuid AND lease.job_id=job_uuid
    AND lease.worker_name=p_worker_name AND lease.action=p_action
    AND lease.revoked_at IS NULL;

  INSERT INTO public.tenant_worker_dispatch_leases (
    lease_id,tenant_id,workspace_id,job_id,run_id,selector_hash,lease_generation,
    worker_name,action,not_before,expires_at,correlation_id
  ) VALUES (
    lease_uuid,tenant_uuid,workspace_uuid,job_uuid,run_uuid,p_selector_hash,generation_value,
    p_worker_name,p_action,not_before_value,expires_at_value,p_correlation_id
  );

  RETURN QUERY
  SELECT 'created'::pg_catalog.text, lease.tenant_id, lease.workspace_id, lease.job_id,
    lease.run_id, lease.lease_id, lease.selector_hash, lease.lease_generation, lease.worker_name,
    lease.action, lease.not_before, lease.expires_at, lease.correlation_id,
    lease.record_version, lease.integrity_version
  FROM public.tenant_worker_dispatch_leases AS lease
  WHERE lease.lease_id=lease_uuid;
EXCEPTION
  WHEN unique_violation OR check_violation OR foreign_key_violation OR numeric_value_out_of_range THEN
    RETURN;
END;
$function$;

CREATE OR REPLACE FUNCTION public.novatrade_cancel_tenant_worker_lease(
  p_selector_hash pg_catalog.text,
  p_tenant_id pg_catalog.text,
  p_workspace_id pg_catalog.text,
  p_job_id pg_catalog.text,
  p_run_id pg_catalog.text,
  p_lease_id pg_catalog.text,
  p_lease_generation pg_catalog.text,
  p_worker_name pg_catalog.text,
  p_action pg_catalog.text,
  p_not_before pg_catalog.text,
  p_expires_at pg_catalog.text,
  p_correlation_id pg_catalog.text
)
RETURNS TABLE (
  kind pg_catalog.text,
  tenant_id pg_catalog.uuid,
  workspace_id pg_catalog.uuid,
  job_id pg_catalog.uuid,
  run_id pg_catalog.uuid,
  lease_id pg_catalog.uuid,
  selector_hash pg_catalog.text,
  lease_generation pg_catalog.int8,
  worker_name pg_catalog.text,
  action pg_catalog.text,
  not_before pg_catalog.timestamptz,
  expires_at pg_catalog.timestamptz,
  correlation_id pg_catalog.text,
  record_version pg_catalog.int2,
  integrity_version pg_catalog.text,
  revoked_at pg_catalog.timestamptz,
  revocation_reason pg_catalog.text
)
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog
AS $function$
DECLARE
  tenant_uuid pg_catalog.uuid;
  workspace_uuid pg_catalog.uuid;
  job_uuid pg_catalog.uuid;
  run_uuid pg_catalog.uuid;
  lease_uuid pg_catalog.uuid;
  generation_value pg_catalog.int8;
  not_before_value pg_catalog.timestamptz;
  expires_at_value pg_catalog.timestamptz;
BEGIN
  IF p_selector_hash IS NULL OR p_selector_hash !~ '^[0-9a-f]{64}$'
     OR p_tenant_id IS NULL OR p_tenant_id !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
     OR (p_workspace_id IS NOT NULL AND p_workspace_id !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$')
     OR p_job_id IS NULL OR p_job_id !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
     OR p_run_id IS NULL OR p_run_id !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
     OR p_lease_id IS NULL OR p_lease_id !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
     OR p_lease_generation IS NULL OR p_lease_generation !~ '^[1-9][0-9]{0,15}$'
     OR p_action IS NULL OR p_action IS DISTINCT FROM (CASE p_worker_name
       WHEN 'ai_verification' THEN 'ai_verification:process'
       WHEN 'crawl' THEN 'crawl:process'
       WHEN 'enrichment' THEN 'enrichment:process'
       WHEN 'artifact' THEN 'artifact:process'
       WHEN 'score_recompute' THEN 'score_recompute:recompute'
       WHEN 'connector_execution' THEN 'connector_execution:process'
     END)
     OR p_not_before IS NULL OR p_expires_at IS NULL
     OR p_correlation_id IS NULL OR p_correlation_id !~ '^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$'
  THEN
    RETURN;
  END IF;

  BEGIN
    tenant_uuid := p_tenant_id::pg_catalog.uuid;
    workspace_uuid := p_workspace_id::pg_catalog.uuid;
    job_uuid := p_job_id::pg_catalog.uuid;
    run_uuid := p_run_id::pg_catalog.uuid;
    lease_uuid := p_lease_id::pg_catalog.uuid;
    generation_value := p_lease_generation::pg_catalog.int8;
    not_before_value := p_not_before::pg_catalog.timestamptz;
    expires_at_value := p_expires_at::pg_catalog.timestamptz;
  EXCEPTION WHEN others THEN
    RETURN;
  END;

  IF generation_value NOT BETWEEN 1 AND 9007199254740991 THEN RETURN; END IF;

  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(
    tenant_uuid::pg_catalog.text || ':' || job_uuid::pg_catalog.text || ':' || p_worker_name || ':' || p_action,
    0
  ));

  RETURN QUERY
  WITH cancelled AS (
    UPDATE public.tenant_worker_dispatch_leases AS lease
    SET revoked_at=pg_catalog.statement_timestamp(), revocation_reason='cancelled'
    WHERE lease.selector_hash=p_selector_hash
      AND lease.tenant_id=tenant_uuid
      AND lease.workspace_id IS NOT DISTINCT FROM workspace_uuid
      AND lease.job_id=job_uuid AND lease.run_id=run_uuid AND lease.lease_id=lease_uuid
      AND lease.lease_generation=generation_value
      AND lease.worker_name=p_worker_name AND lease.action=p_action
      AND lease.not_before=not_before_value AND lease.expires_at=expires_at_value
      AND lease.correlation_id=p_correlation_id
      AND lease.revoked_at IS NULL
      AND pg_catalog.statement_timestamp() < lease.expires_at
    RETURNING lease.*
  )
  SELECT 'cancelled'::pg_catalog.text, lease.tenant_id,lease.workspace_id,lease.job_id,
    lease.run_id,lease.lease_id,lease.selector_hash,lease.lease_generation,lease.worker_name,lease.action,
    lease.not_before,lease.expires_at,lease.correlation_id,lease.record_version,
    lease.integrity_version,lease.revoked_at,lease.revocation_reason
  FROM cancelled AS lease;

  IF FOUND THEN RETURN; END IF;

  RETURN QUERY
  SELECT 'replay'::pg_catalog.text, lease.tenant_id,lease.workspace_id,lease.job_id,
    lease.run_id,lease.lease_id,lease.selector_hash,lease.lease_generation,lease.worker_name,lease.action,
    lease.not_before,lease.expires_at,lease.correlation_id,lease.record_version,
    lease.integrity_version,lease.revoked_at,lease.revocation_reason
  FROM public.tenant_worker_dispatch_leases AS lease
  WHERE lease.selector_hash=p_selector_hash
    AND lease.tenant_id=tenant_uuid
    AND lease.workspace_id IS NOT DISTINCT FROM workspace_uuid
    AND lease.job_id=job_uuid AND lease.run_id=run_uuid AND lease.lease_id=lease_uuid
    AND lease.lease_generation=generation_value
    AND lease.worker_name=p_worker_name AND lease.action=p_action
    AND lease.not_before=not_before_value AND lease.expires_at=expires_at_value
    AND lease.correlation_id=p_correlation_id
    AND lease.revocation_reason='cancelled';
EXCEPTION WHEN others THEN
  RETURN;
END;
$function$;

CREATE OR REPLACE FUNCTION public.novatrade_resolve_tenant_worker_lease(
  p_selector_hash pg_catalog.text,
  p_worker_name pg_catalog.text,
  p_action pg_catalog.text
)
RETURNS TABLE (
  tenant_id pg_catalog.uuid,
  workspace_id pg_catalog.uuid,
  job_id pg_catalog.uuid,
  run_id pg_catalog.uuid,
  lease_id pg_catalog.uuid,
  lease_generation pg_catalog.int8,
  worker_name pg_catalog.text,
  action pg_catalog.text,
  status pg_catalog.text,
  not_before pg_catalog.timestamptz,
  expires_at pg_catalog.timestamptz,
  correlation_id pg_catalog.text,
  record_version pg_catalog.int2,
  integrity_version pg_catalog.text
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog
AS $function$
BEGIN
  IF p_selector_hash IS NULL OR p_selector_hash !~ '^[0-9a-f]{64}$'
     OR p_worker_name IS NULL
     OR p_action IS NULL
     OR p_action IS DISTINCT FROM (CASE p_worker_name
       WHEN 'ai_verification' THEN 'ai_verification:process'
       WHEN 'crawl' THEN 'crawl:process'
       WHEN 'enrichment' THEN 'enrichment:process'
       WHEN 'artifact' THEN 'artifact:process'
       WHEN 'score_recompute' THEN 'score_recompute:recompute'
       WHEN 'connector_execution' THEN 'connector_execution:process'
     END)
  THEN
    RETURN;
  END IF;

  RETURN QUERY
  SELECT lease.tenant_id,lease.workspace_id,lease.job_id,lease.run_id,lease.lease_id,
    lease.lease_generation,lease.worker_name,lease.action,'active'::pg_catalog.text,
    lease.not_before,lease.expires_at,lease.correlation_id,lease.record_version,lease.integrity_version
  FROM public.tenant_worker_dispatch_leases AS lease
  JOIN public.tenants AS tenant ON tenant.id=lease.tenant_id AND tenant.status='active'
  LEFT JOIN public.workspaces AS workspace
    ON workspace.tenant_id=lease.tenant_id AND workspace.id=lease.workspace_id AND workspace.status='active'
  WHERE lease.selector_hash=p_selector_hash
    AND lease.worker_name=p_worker_name AND lease.action=p_action
    AND lease.revoked_at IS NULL
    AND lease.not_before <= pg_catalog.statement_timestamp()
    AND pg_catalog.statement_timestamp() < lease.expires_at
    AND (lease.workspace_id IS NULL OR workspace.id IS NOT NULL);
EXCEPTION WHEN others THEN
  RETURN;
END;
$function$;

COMMIT;
