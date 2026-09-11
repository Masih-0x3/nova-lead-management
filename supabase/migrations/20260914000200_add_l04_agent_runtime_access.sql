-- L-04 member/worker access layer for the F-06 agent-runtime foundation.
-- Adds the agent_runtime worker kind to the F-01 dispatch vocabulary, a
-- per-run durable input record, member read policies, and narrowly exposed
-- SECURITY DEFINER capabilities for enqueue/cancel (member) and
-- claim/heartbeat/step/tool/finalize (lease-fenced worker).
--
-- Worker authority: a live tenant_worker_dispatch_leases row bound to
-- (job_id, run_id = agent run id, worker_name='agent_runtime',
-- action='agent_runtime:execute') must validate through
-- novatrade_validate_tenant_worker_lease() before any worker capability runs.
-- The run-level lease token hash and expiry fence every execution mutation.
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '120s';
SELECT pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtext('novatrade:l04:agent-runtime-access'));

DO $block$
DECLARE
  role_attributes pg_catalog.record;
BEGIN
  SELECT rolcanlogin,rolsuper,rolcreatedb,rolcreaterole,rolinherit,rolreplication,rolbypassrls
    INTO role_attributes
  FROM pg_catalog.pg_roles
  WHERE rolname='novatrade_agent_runtime_definer';

  IF NOT FOUND THEN
    CREATE ROLE novatrade_agent_runtime_definer
      NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION BYPASSRLS;
  ELSIF role_attributes.rolcanlogin OR role_attributes.rolsuper OR role_attributes.rolcreatedb
     OR role_attributes.rolcreaterole OR role_attributes.rolinherit OR role_attributes.rolreplication
     OR NOT role_attributes.rolbypassrls
  THEN
    RAISE EXCEPTION 'novatrade_agent_runtime_definer has unsafe attributes';
  END IF;

  IF EXISTS (
    SELECT 1 FROM pg_catalog.pg_auth_members AS membership
    JOIN pg_catalog.pg_roles AS protected_role
      ON protected_role.oid IN (membership.roleid,membership.member)
    WHERE protected_role.rolname='novatrade_agent_runtime_definer'
  ) THEN
    RAISE EXCEPTION 'novatrade_agent_runtime_definer must have no role memberships';
  END IF;
END;
$block$;

-- Extend the F-01 dispatch vocabulary with the bounded-runtime worker kind.
ALTER TABLE public.tenant_worker_dispatch_leases
  DROP CONSTRAINT tenant_worker_dispatch_leases_worker_name_chk;
ALTER TABLE public.tenant_worker_dispatch_leases
  ADD CONSTRAINT tenant_worker_dispatch_leases_worker_name_chk
  CHECK (worker_name IN (
    'ai_verification','crawl','enrichment','artifact','score_recompute','agent_runtime'));
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
    WHEN 'agent_runtime' THEN 'agent_runtime:execute'
  END);

-- The F-01 dispatcher pair predates agent_runtime; re-declare both with the
-- new worker kind so the dispatch lane can issue and cancel runtime leases.
-- Semantics are otherwise identical to 20260830030000.
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
     OR p_worker_name IS NULL OR p_worker_name NOT IN ('ai_verification','crawl','enrichment','artifact','score_recompute','agent_runtime')
     OR p_action IS NULL OR p_action IS DISTINCT FROM (CASE p_worker_name
       WHEN 'ai_verification' THEN 'ai_verification:process'
       WHEN 'crawl' THEN 'crawl:process'
       WHEN 'enrichment' THEN 'enrichment:process'
       WHEN 'artifact' THEN 'artifact:process'
       WHEN 'score_recompute' THEN 'score_recompute:recompute'
       WHEN 'agent_runtime' THEN 'agent_runtime:execute'
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
       WHEN 'agent_runtime' THEN 'agent_runtime:execute'
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

-- Durable enqueue-time input each claimed attempt rehydrates. Hash-bound to
-- the run's input_hash by the application boundary; never readable outside
-- the owning scope.
CREATE TABLE IF NOT EXISTS public.agent_run_inputs (
  run_id pg_catalog.text CONSTRAINT agent_run_inputs_pkey PRIMARY KEY
    CONSTRAINT agent_run_inputs_run_fkey REFERENCES public.agent_runs(id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  tenant_id pg_catalog.uuid NOT NULL,
  workspace_id pg_catalog.uuid,
  input pg_catalog.jsonb NOT NULL,
  created_at pg_catalog.timestamptz(3) NOT NULL,
  CONSTRAINT agent_run_inputs_scope_fkey
    FOREIGN KEY (tenant_id,workspace_id,run_id)
    REFERENCES public.agent_runs(tenant_id,workspace_id,id)
    ON UPDATE RESTRICT ON DELETE RESTRICT
);

CREATE OR REPLACE FUNCTION public.novatrade_l04_agent_run_inputs_guard()
RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $fn$
BEGIN
  RAISE EXCEPTION 'agent run input is immutable' USING ERRCODE='P0001';
END;
$fn$;
DROP TRIGGER IF EXISTS trg_agent_run_inputs_immutable ON public.agent_run_inputs;
CREATE TRIGGER trg_agent_run_inputs_immutable BEFORE UPDATE OR DELETE
  ON public.agent_run_inputs FOR EACH ROW EXECUTE FUNCTION public.novatrade_l04_agent_run_inputs_guard();

-- ---------------------------------------------------------------------------
-- Gates
-- ---------------------------------------------------------------------------

-- Member gate: complete member GUC context, capable D-002 role set.
CREATE OR REPLACE FUNCTION public.novatrade_l04_agent_member_gate(
  p_tenant_id pg_catalog.text,
  p_workspace_id pg_catalog.text,
  p_allowed_roles pg_catalog.text[]
)
RETURNS pg_catalog.bool
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog
AS $function$
DECLARE
  tenant_uuid pg_catalog.uuid;
  workspace_uuid pg_catalog.uuid;
  actor_uuid pg_catalog.uuid;
  membership_uuid pg_catalog.uuid;
  binding_uuid pg_catalog.uuid;
BEGIN
  IF p_tenant_id IS NULL
     OR p_tenant_id !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
     OR (p_workspace_id IS NOT NULL AND p_workspace_id <> ''
         AND p_workspace_id !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$')
  THEN
    RETURN false;
  END IF;
  tenant_uuid := p_tenant_id::pg_catalog.uuid;
  workspace_uuid := nullif(p_workspace_id,'')::pg_catalog.uuid;

  IF NULLIF(pg_catalog.current_setting('app.tenant_id',true),'') IS DISTINCT FROM tenant_uuid::pg_catalog.text
     OR NULLIF(pg_catalog.current_setting('app.workspace_id',true),'')
        IS DISTINCT FROM coalesce(workspace_uuid::pg_catalog.text,'')
     OR NULLIF(pg_catalog.current_setting('app.actor_id',true),'') IS NULL
     OR NULLIF(pg_catalog.current_setting('app.membership_id',true),'') IS NULL
     OR NULLIF(pg_catalog.current_setting('app.role_binding_id',true),'') IS NULL
     OR NULLIF(pg_catalog.current_setting('app.role',true),'') IS NULL
     OR NOT (pg_catalog.current_setting('app.role',true) = ANY (p_allowed_roles))
     OR NULLIF(pg_catalog.current_setting('app.correlation_id',true),'') !~ '^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$'
     OR coalesce(pg_catalog.current_setting('app.support_grant_id',true),'') <> ''
     OR coalesce(pg_catalog.current_setting('app.job_id',true),'') <> ''
     OR coalesce(pg_catalog.current_setting('app.run_id',true),'') <> ''
     OR coalesce(pg_catalog.current_setting('app.lease_id',true),'') <> ''
     OR coalesce(pg_catalog.current_setting('app.lease_generation',true),'') <> ''
     OR coalesce(pg_catalog.current_setting('app.worker_name',true),'') <> ''
     OR coalesce(pg_catalog.current_setting('app.worker_action',true),'') <> ''
     OR coalesce(pg_catalog.current_setting('app.worker_principal_kind',true),'') <> ''
  THEN
    RETURN false;
  END IF;

  BEGIN
    actor_uuid := pg_catalog.current_setting('app.actor_id',true)::pg_catalog.uuid;
    membership_uuid := pg_catalog.current_setting('app.membership_id',true)::pg_catalog.uuid;
    binding_uuid := pg_catalog.current_setting('app.role_binding_id',true)::pg_catalog.uuid;
  EXCEPTION WHEN invalid_text_representation THEN
    RETURN false;
  END;

  RETURN EXISTS (
    SELECT true
    FROM public.tenants AS tenant
    LEFT JOIN public.workspaces AS workspace
      ON workspace.tenant_id=tenant.id AND workspace.id=workspace_uuid AND workspace.status='active'
    JOIN public.tenant_memberships AS membership
      ON membership.tenant_id=tenant.id AND membership.id=membership_uuid
     AND membership.auth_identity_id=actor_uuid AND membership.pending_identity_ref_hash IS NULL
     AND membership.status='active'
     AND (membership.workspace_id IS NULL OR membership.workspace_id=workspace_uuid)
    JOIN public.tenant_role_bindings AS binding
      ON binding.tenant_id=tenant.id AND binding.id=binding_uuid AND binding.membership_id=membership.id
     AND binding.role=pg_catalog.current_setting('app.role',true)
     AND binding.role = ANY (p_allowed_roles)
     AND binding.valid_from<=pg_catalog.statement_timestamp() AND binding.revoked_at IS NULL
    WHERE tenant.id=tenant_uuid AND tenant.status='active'
      AND (workspace_uuid IS NULL OR workspace.id IS NOT NULL)
  );
EXCEPTION WHEN others THEN
  RETURN false;
END;
$function$;

-- Worker gate: a live dispatch lease for this exact agent run plus the
-- run-scoped lease token fence. p_run_id must equal app.run_id so a worker
-- dispatched for one run can never touch another.
CREATE OR REPLACE FUNCTION public.novatrade_l04_agent_worker_gate(
  p_tenant_id pg_catalog.text,
  p_workspace_id pg_catalog.text,
  p_run_id pg_catalog.text
)
RETURNS pg_catalog.bool
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog
AS $function$
BEGIN
  IF p_run_id IS NULL
     OR p_run_id !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
     OR pg_catalog.current_setting('app.worker_name',true) IS DISTINCT FROM 'agent_runtime'
     OR pg_catalog.current_setting('app.worker_action',true) IS DISTINCT FROM 'agent_runtime:execute'
     OR pg_catalog.current_setting('app.run_id',true) IS DISTINCT FROM p_run_id
  THEN
    RETURN false;
  END IF;
  RETURN public.novatrade_validate_tenant_worker_lease();
EXCEPTION WHEN others THEN
  RETURN false;
END;
$function$;

CREATE OR REPLACE FUNCTION public.novatrade_l04_agent_lease_token_hash(p_token pg_catalog.text)
RETURNS pg_catalog.text
LANGUAGE sql IMMUTABLE SET search_path = pg_catalog
AS $function$
  SELECT pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(p_token,'UTF8')),'hex');
$function$;

-- ---------------------------------------------------------------------------
-- Member capabilities
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.novatrade_l04_enqueue_agent_run(
  p_tenant_id pg_catalog.text,
  p_workspace_id pg_catalog.text,
  p_run_id pg_catalog.text,
  p_idempotency_key pg_catalog.text,
  p_input_hash pg_catalog.text,
  p_agent_role pg_catalog.text,
  p_agent_version pg_catalog.text,
  p_prompt_key pg_catalog.text,
  p_prompt_version pg_catalog.text,
  p_policy_key pg_catalog.text,
  p_policy_version pg_catalog.text,
  p_budget_usd pg_catalog.text,
  p_max_attempts pg_catalog.text,
  p_created_at pg_catalog.text,
  p_run_input pg_catalog.text
)
RETURNS TABLE (kind pg_catalog.text)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog
AS $function$
DECLARE
  tenant_uuid pg_catalog.uuid;
  workspace_uuid pg_catalog.uuid;
  v_run_input pg_catalog.jsonb;
  v_agent_version pg_catalog.int4;
  v_prompt_version pg_catalog.int4;
  v_policy_version pg_catalog.int4;
  v_max_attempts pg_catalog.int4;
  v_budget pg_catalog.numeric(14,6);
  v_created pg_catalog.timestamptz;
  v_existing public.agent_runs%ROWTYPE;
BEGIN
  IF p_run_id IS NULL
     OR p_run_id !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
     OR p_idempotency_key IS NULL OR pg_catalog.char_length(p_idempotency_key) NOT BETWEEN 1 AND 512
     OR p_input_hash IS NULL OR pg_catalog.char_length(p_input_hash) NOT BETWEEN 1 AND 160
     OR p_agent_role IS NULL OR pg_catalog.char_length(p_agent_role) NOT BETWEEN 1 AND 120
     OR p_prompt_key IS NULL OR p_policy_key IS NULL
  THEN RETURN; END IF;
  BEGIN
    v_run_input := p_run_input::pg_catalog.jsonb;
    v_agent_version := p_agent_version::pg_catalog.int4;
    v_prompt_version := p_prompt_version::pg_catalog.int4;
    v_policy_version := p_policy_version::pg_catalog.int4;
    v_max_attempts := p_max_attempts::pg_catalog.int4;
    v_budget := p_budget_usd::pg_catalog.numeric(14,6);
    v_created := p_created_at::pg_catalog.timestamptz;
  EXCEPTION WHEN others THEN RETURN; END;
  IF v_agent_version < 1 OR v_prompt_version < 1 OR v_policy_version < 1
     OR v_max_attempts < 1 OR v_max_attempts > 10
     OR v_budget <= 0 THEN RETURN; END IF;

  IF NOT public.novatrade_l04_agent_member_gate(p_tenant_id,p_workspace_id,
    ARRAY['owner','admin','strategist_manager','researcher','reviewer']) THEN
    RETURN;
  END IF;
  tenant_uuid := p_tenant_id::pg_catalog.uuid;
  workspace_uuid := nullif(p_workspace_id,'')::pg_catalog.uuid;

  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('l04:run:' || p_tenant_id || ':' || coalesce(p_workspace_id,'')
      || ':' || p_idempotency_key, 0));

  SELECT * INTO v_existing FROM public.agent_runs
    WHERE tenant_id=tenant_uuid
      AND workspace_id IS NOT DISTINCT FROM workspace_uuid
      AND idempotency_key=p_idempotency_key;
  IF FOUND THEN
    IF v_existing.input_hash=p_input_hash AND v_existing.agent_role=p_agent_role
       AND v_existing.agent_version=v_agent_version AND v_existing.prompt_key=p_prompt_key
       AND v_existing.prompt_version=v_prompt_version AND v_existing.policy_key=p_policy_key
       AND v_existing.policy_version=v_policy_version AND v_existing.budget_usd=v_budget
       AND v_existing.max_attempts=v_max_attempts THEN
      RETURN QUERY SELECT CASE
        WHEN v_existing.status='complete' AND v_existing.result_ref IS NOT NULL
          THEN 'replay'::pg_catalog.text
        ELSE 'deduplicated'::pg_catalog.text END;
    ELSE
      RETURN QUERY SELECT 'conflict'::pg_catalog.text;
    END IF;
    RETURN;
  END IF;

  IF EXISTS (SELECT 1 FROM public.agent_runs AS existing WHERE existing.id=p_run_id) THEN
    RETURN QUERY SELECT 'conflict'::pg_catalog.text;
    RETURN;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.agent_prompt_versions AS prompt
    WHERE prompt.prompt_key=p_prompt_key AND prompt.version=v_prompt_version)
     OR NOT EXISTS (SELECT 1 FROM public.agent_policy_versions AS policy
    WHERE policy.policy_key=p_policy_key AND policy.version=v_policy_version) THEN
    RETURN;
  END IF;

  INSERT INTO public.agent_runs(
    id,tenant_id,workspace_id,idempotency_key,input_hash,agent_role,agent_version,
    prompt_key,prompt_version,policy_key,policy_version,status,budget_usd,max_attempts,
    created_at,updated_at)
  VALUES (p_run_id,tenant_uuid,workspace_uuid,p_idempotency_key,p_input_hash,p_agent_role,
    v_agent_version,p_prompt_key,v_prompt_version,p_policy_key,v_policy_version,'queued',
    v_budget,v_max_attempts,v_created,v_created);
  INSERT INTO public.agent_run_inputs(run_id,tenant_id,workspace_id,input,created_at)
  VALUES (p_run_id,tenant_uuid,workspace_uuid,v_run_input,v_created);
  RETURN QUERY SELECT 'created'::pg_catalog.text;
END;
$function$;

CREATE OR REPLACE FUNCTION public.novatrade_l04_cancel_agent_run(
  p_tenant_id pg_catalog.text,
  p_workspace_id pg_catalog.text,
  p_run_id pg_catalog.text,
  p_canceled_at pg_catalog.text
)
RETURNS TABLE (kind pg_catalog.text)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog
AS $function$
DECLARE
  v_canceled pg_catalog.timestamptz;
  v_current public.agent_runs%ROWTYPE;
BEGIN
  IF p_run_id IS NULL OR pg_catalog.char_length(p_run_id) NOT BETWEEN 1 AND 160 THEN RETURN; END IF;
  BEGIN
    v_canceled := p_canceled_at::pg_catalog.timestamptz;
  EXCEPTION WHEN others THEN RETURN; END;

  IF NOT public.novatrade_l04_agent_member_gate(p_tenant_id,p_workspace_id,
    ARRAY['owner','admin','strategist_manager','researcher','reviewer'])
     AND NOT public.novatrade_l04_agent_worker_gate(p_tenant_id,p_workspace_id,p_run_id) THEN
    RETURN;
  END IF;

  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('l04:runcancel:' || p_run_id, 0));

  SELECT * INTO v_current FROM public.agent_runs
    WHERE id=p_run_id AND tenant_id=p_tenant_id::pg_catalog.uuid
      AND workspace_id IS NOT DISTINCT FROM nullif(p_workspace_id,'')::pg_catalog.uuid
    FOR UPDATE;
  IF NOT FOUND THEN
    RETURN QUERY SELECT 'not_found'::pg_catalog.text;
    RETURN;
  END IF;
  IF v_current.status IN ('complete','failed','dead_letter','canceled') THEN
    RETURN QUERY SELECT 'terminal'::pg_catalog.text;
    RETURN;
  END IF;

  UPDATE public.agent_runs
    SET status='canceled', lease_generation=v_current.lease_generation,
        lease_token_hash=NULL, lease_worker_hash=NULL, lease_acquired_at=NULL,
        lease_heartbeat_at=NULL, lease_expires_at=NULL, next_attempt_at=NULL,
        cancel_requested_at=v_canceled, ended_at=v_canceled, updated_at=v_canceled
    WHERE id=v_current.id;
  RETURN QUERY SELECT 'canceled'::pg_catalog.text;
END;
$function$;

CREATE OR REPLACE FUNCTION public.novatrade_l04_register_agent_prompt(
  p_prompt_key pg_catalog.text,
  p_version pg_catalog.text,
  p_instructions_ref pg_catalog.text,
  p_instructions_sha256 pg_catalog.text,
  p_allowed_tools pg_catalog.text,
  p_allowed_classifications pg_catalog.text
)
RETURNS TABLE (kind pg_catalog.text)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog
AS $function$
DECLARE
  v_version pg_catalog.int4;
  v_tools pg_catalog.jsonb;
  v_classes pg_catalog.jsonb;
BEGIN
  IF p_prompt_key IS NULL OR p_prompt_key !~ '^[a-z][a-z0-9._-]{0,127}$'
     OR p_instructions_ref IS NULL
     OR p_instructions_ref !~ '^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,255}$'
     OR p_instructions_sha256 IS NULL
     OR p_instructions_sha256 !~ '^[0-9a-f]{64}$' THEN RETURN; END IF;
  BEGIN
    v_version := p_version::pg_catalog.int4;
    v_tools := p_allowed_tools::pg_catalog.jsonb;
    v_classes := p_allowed_classifications::pg_catalog.jsonb;
  EXCEPTION WHEN others THEN RETURN; END;
  IF v_version < 1 OR v_version > 1000000
     OR pg_catalog.jsonb_typeof(v_tools) IS DISTINCT FROM 'array'
     OR pg_catalog.jsonb_typeof(v_classes) IS DISTINCT FROM 'array' THEN RETURN; END IF;

  -- Registry writes are member-context, tenant-agnostic metadata: the gate
  -- binds the caller's tenant/workspace GUCs and a manager-capable role.
  IF NOT public.novatrade_l04_agent_member_gate(
    pg_catalog.current_setting('app.tenant_id',true),
    pg_catalog.current_setting('app.workspace_id',true),
    ARRAY['owner','admin','strategist_manager']) THEN
    RETURN;
  END IF;

  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('l04:prompt:' || p_prompt_key || '@' || v_version::pg_catalog.text, 0));

  IF EXISTS (SELECT 1 FROM public.agent_prompt_versions AS existing
    WHERE existing.prompt_key=p_prompt_key AND existing.version=v_version) THEN
    IF EXISTS (SELECT 1 FROM public.agent_prompt_versions AS existing
      WHERE existing.prompt_key=p_prompt_key AND existing.version=v_version
        AND existing.instructions_ref=p_instructions_ref
        AND existing.instructions_sha256=p_instructions_sha256
        AND existing.allowed_tools=v_tools
        AND existing.allowed_classifications=v_classes) THEN
      RETURN QUERY SELECT 'replay'::pg_catalog.text;
    ELSE
      RETURN QUERY SELECT 'conflict'::pg_catalog.text;
    END IF;
    RETURN;
  END IF;

  INSERT INTO public.agent_prompt_versions(
    prompt_key,version,instructions_ref,instructions_sha256,allowed_tools,allowed_classifications)
  VALUES (p_prompt_key,v_version,p_instructions_ref,p_instructions_sha256,v_tools,v_classes);
  RETURN QUERY SELECT 'created'::pg_catalog.text;
END;
$function$;

CREATE OR REPLACE FUNCTION public.novatrade_l04_register_agent_policy(
  p_policy_key pg_catalog.text,
  p_version pg_catalog.text,
  p_provider pg_catalog.text,
  p_model pg_catalog.text,
  p_state pg_catalog.text,
  p_policy_sha256 pg_catalog.text,
  p_allowed_tools pg_catalog.text,
  p_allowed_classifications pg_catalog.text
)
RETURNS TABLE (kind pg_catalog.text)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog
AS $function$
DECLARE
  v_version pg_catalog.int4;
  v_tools pg_catalog.jsonb;
  v_classes pg_catalog.jsonb;
BEGIN
  IF p_policy_key IS NULL OR p_policy_key !~ '^[a-z][a-z0-9._-]{0,127}$'
     OR p_provider IS NULL OR p_model IS NULL
     OR p_state IS NULL OR p_state NOT IN ('disabled','fixture','implementation_only','active')
     OR p_policy_sha256 IS NULL OR p_policy_sha256 !~ '^[0-9a-f]{64}$'
  THEN RETURN; END IF;
  BEGIN
    v_version := p_version::pg_catalog.int4;
    v_tools := p_allowed_tools::pg_catalog.jsonb;
    v_classes := p_allowed_classifications::pg_catalog.jsonb;
  EXCEPTION WHEN others THEN RETURN; END;
  IF v_version < 1 OR v_version > 1000000
     OR pg_catalog.jsonb_typeof(v_tools) IS DISTINCT FROM 'array'
     OR pg_catalog.jsonb_typeof(v_classes) IS DISTINCT FROM 'array' THEN RETURN; END IF;

  IF NOT public.novatrade_l04_agent_member_gate(
    pg_catalog.current_setting('app.tenant_id',true),
    pg_catalog.current_setting('app.workspace_id',true),
    ARRAY['owner','admin','strategist_manager']) THEN
    RETURN;
  END IF;

  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('l04:policy:' || p_policy_key || '@' || v_version::pg_catalog.text, 0));

  IF EXISTS (SELECT 1 FROM public.agent_policy_versions AS existing
    WHERE existing.policy_key=p_policy_key AND existing.version=v_version) THEN
    IF EXISTS (SELECT 1 FROM public.agent_policy_versions AS existing
      WHERE existing.policy_key=p_policy_key AND existing.version=v_version
        AND existing.provider=p_provider AND existing.model=p_model AND existing.state=p_state
        AND existing.policy_sha256=p_policy_sha256
        AND existing.allowed_tools=v_tools
        AND existing.allowed_classifications=v_classes) THEN
      RETURN QUERY SELECT 'replay'::pg_catalog.text;
    ELSE
      RETURN QUERY SELECT 'conflict'::pg_catalog.text;
    END IF;
    RETURN;
  END IF;

  INSERT INTO public.agent_policy_versions(
    policy_key,version,provider,model,state,policy_sha256,allowed_tools,allowed_classifications)
  VALUES (p_policy_key,v_version,p_provider,p_model,p_state,p_policy_sha256,v_tools,v_classes);
  RETURN QUERY SELECT 'created'::pg_catalog.text;
END;
$function$;

-- ---------------------------------------------------------------------------
-- Worker capabilities (dispatch-lease gated, run-lease fenced)
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.novatrade_l04_claim_agent_run(
  p_tenant_id pg_catalog.text,
  p_workspace_id pg_catalog.text,
  p_run_id pg_catalog.text,
  p_lease_token pg_catalog.text,
  p_worker_id pg_catalog.text,
  p_now pg_catalog.text,
  p_lease_duration_ms pg_catalog.text
)
RETURNS TABLE (kind pg_catalog.text)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog
AS $function$
DECLARE
  v_now pg_catalog.timestamptz;
  v_duration pg_catalog.int8;
  v_token_hash pg_catalog.text;
  v_worker_hash pg_catalog.text;
  v_current public.agent_runs%ROWTYPE;
BEGIN
  IF p_lease_token IS NULL OR p_lease_token !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$'
     OR p_worker_id IS NULL OR pg_catalog.char_length(p_worker_id) NOT BETWEEN 1 AND 120 THEN
    RETURN;
  END IF;
  BEGIN
    v_now := p_now::pg_catalog.timestamptz;
    v_duration := p_lease_duration_ms::pg_catalog.int8;
  EXCEPTION WHEN others THEN RETURN; END;
  IF v_duration < 1000 OR v_duration > 300000 THEN RETURN; END IF;

  IF NOT public.novatrade_l04_agent_worker_gate(p_tenant_id,p_workspace_id,p_run_id) THEN
    RETURN;
  END IF;
  v_token_hash := public.novatrade_l04_agent_lease_token_hash(p_lease_token);
  v_worker_hash := public.novatrade_l04_agent_lease_token_hash(
    'worker:' || pg_catalog.current_setting('app.worker_name',true) || ':'
      || pg_catalog.current_setting('app.lease_id',true) || ':' || p_worker_id);

  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('l04:claim:' || p_run_id, 0));

  SELECT * INTO v_current FROM public.agent_runs
    WHERE id=p_run_id AND tenant_id=p_tenant_id::pg_catalog.uuid
      AND workspace_id IS NOT DISTINCT FROM nullif(p_workspace_id,'')::pg_catalog.uuid
    FOR UPDATE;
  IF NOT FOUND THEN
    RETURN QUERY SELECT 'not_found'::pg_catalog.text;
    RETURN;
  END IF;
  IF v_now < v_current.updated_at THEN
    RETURN QUERY SELECT 'conflict'::pg_catalog.text;
    RETURN;
  END IF;
  IF v_current.status='retry_wait'
     AND (v_current.next_attempt_at IS NULL OR v_now < v_current.next_attempt_at) THEN
    RETURN QUERY SELECT 'not_ready'::pg_catalog.text;
    RETURN;
  END IF;
  IF v_current.status='running' AND v_current.lease_expires_at IS NOT NULL
     AND v_now < v_current.lease_expires_at THEN
    RETURN QUERY SELECT 'conflict'::pg_catalog.text;
    RETURN;
  END IF;
  IF v_current.status NOT IN ('queued','retry_wait','running') THEN
    RETURN QUERY SELECT 'terminal'::pg_catalog.text;
    RETURN;
  END IF;
  IF v_current.attempt_count >= v_current.max_attempts THEN
    -- queued/retry_wait -> dead_letter is not a legal guard transition; the
    -- finalize path dead-letters when the last attempt fails. Report only.
    RETURN QUERY SELECT 'exhausted'::pg_catalog.text;
    RETURN;
  END IF;
  IF EXISTS (SELECT 1 FROM public.agent_run_lease_history AS history
    WHERE history.lease_token_hash=v_token_hash) THEN
    RETURN QUERY SELECT 'conflict'::pg_catalog.text;
    RETURN;
  END IF;

  UPDATE public.agent_runs
    SET status='running', attempt_count=v_current.attempt_count+1,
        lease_generation=v_current.lease_generation+1, lease_token_hash=v_token_hash,
        lease_worker_hash=v_worker_hash, lease_acquired_at=v_now, lease_heartbeat_at=v_now,
        lease_expires_at=v_now + (v_duration || ' milliseconds')::pg_catalog.interval,
        next_attempt_at=NULL, error_code=NULL,
        started_at=coalesce(v_current.started_at,v_now), updated_at=v_now
    WHERE id=v_current.id;
  RETURN QUERY SELECT 'claimed'::pg_catalog.text;
END;
$function$;

CREATE OR REPLACE FUNCTION public.novatrade_l04_heartbeat_agent_run(
  p_tenant_id pg_catalog.text,
  p_workspace_id pg_catalog.text,
  p_run_id pg_catalog.text,
  p_lease_token pg_catalog.text,
  p_now pg_catalog.text,
  p_lease_duration_ms pg_catalog.text
)
RETURNS TABLE (kind pg_catalog.text)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog
AS $function$
DECLARE
  v_now pg_catalog.timestamptz;
  v_duration pg_catalog.int8;
  v_token_hash pg_catalog.text;
  v_current public.agent_runs%ROWTYPE;
BEGIN
  IF p_lease_token IS NULL OR p_lease_token !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$' THEN RETURN; END IF;
  BEGIN
    v_now := p_now::pg_catalog.timestamptz;
    v_duration := p_lease_duration_ms::pg_catalog.int8;
  EXCEPTION WHEN others THEN RETURN; END;
  IF v_duration < 1000 OR v_duration > 300000 THEN RETURN; END IF;

  IF NOT public.novatrade_l04_agent_worker_gate(p_tenant_id,p_workspace_id,p_run_id) THEN
    RETURN;
  END IF;
  v_token_hash := public.novatrade_l04_agent_lease_token_hash(p_lease_token);

  SELECT * INTO v_current FROM public.agent_runs
    WHERE id=p_run_id AND tenant_id=p_tenant_id::pg_catalog.uuid
      AND workspace_id IS NOT DISTINCT FROM nullif(p_workspace_id,'')::pg_catalog.uuid
    FOR UPDATE;
  IF NOT FOUND THEN
    RETURN QUERY SELECT 'not_found'::pg_catalog.text;
    RETURN;
  END IF;
  IF v_current.status<>'running' OR v_current.lease_token_hash IS DISTINCT FROM v_token_hash THEN
    RETURN QUERY SELECT 'conflict'::pg_catalog.text;
    RETURN;
  END IF;
  IF v_now >= v_current.lease_expires_at OR v_now < v_current.updated_at THEN
    RETURN QUERY SELECT 'expired'::pg_catalog.text;
    RETURN;
  END IF;

  UPDATE public.agent_runs
    SET lease_heartbeat_at=v_now,
        lease_expires_at=v_now + (v_duration || ' milliseconds')::pg_catalog.interval,
        updated_at=v_now
    WHERE id=v_current.id;
  RETURN QUERY SELECT 'updated'::pg_catalog.text;
END;
$function$;

CREATE OR REPLACE FUNCTION public.novatrade_l04_append_agent_run_step(
  p_tenant_id pg_catalog.text,
  p_workspace_id pg_catalog.text,
  p_run_id pg_catalog.text,
  p_lease_token pg_catalog.text,
  p_step_id pg_catalog.text,
  p_status pg_catalog.text,
  p_policy_key pg_catalog.text,
  p_policy_version pg_catalog.text,
  p_result_ref pg_catalog.text,
  p_error_code pg_catalog.text,
  p_recorded_at pg_catalog.text
)
RETURNS TABLE (kind pg_catalog.text)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog
AS $function$
DECLARE
  v_token_hash pg_catalog.text;
  v_policy_version pg_catalog.int4;
  v_recorded pg_catalog.timestamptz;
  v_current public.agent_runs%ROWTYPE;
  v_sequence pg_catalog.int4;
BEGIN
  IF p_step_id IS NULL OR pg_catalog.char_length(p_step_id) NOT BETWEEN 1 AND 160
     OR p_status IS NULL OR p_status NOT IN ('complete','failed','blocked')
     OR p_policy_key IS NULL OR p_policy_version IS NULL
     OR p_lease_token IS NULL OR p_lease_token !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$'
     OR (p_status='complete' AND (p_result_ref IS NULL OR p_error_code IS NOT NULL))
     OR (p_status<>'complete' AND (p_result_ref IS NOT NULL OR p_error_code IS NULL)) THEN
    RETURN;
  END IF;
  BEGIN
    v_policy_version := p_policy_version::pg_catalog.int4;
    v_recorded := p_recorded_at::pg_catalog.timestamptz;
  EXCEPTION WHEN others THEN RETURN; END;

  IF NOT public.novatrade_l04_agent_worker_gate(p_tenant_id,p_workspace_id,p_run_id) THEN
    RETURN;
  END IF;
  v_token_hash := public.novatrade_l04_agent_lease_token_hash(p_lease_token);

  SELECT * INTO v_current FROM public.agent_runs
    WHERE id=p_run_id AND tenant_id=p_tenant_id::pg_catalog.uuid
      AND workspace_id IS NOT DISTINCT FROM nullif(p_workspace_id,'')::pg_catalog.uuid
    FOR UPDATE;
  IF NOT FOUND THEN RETURN; END IF;
  IF v_current.status<>'running' OR v_current.lease_token_hash IS DISTINCT FROM v_token_hash
     OR v_recorded >= v_current.lease_expires_at THEN
    RETURN QUERY SELECT 'conflict'::pg_catalog.text;
    RETURN;
  END IF;
  IF EXISTS (SELECT 1 FROM public.agent_run_steps AS step WHERE step.id=p_step_id) THEN
    RETURN QUERY SELECT 'conflict'::pg_catalog.text;
    RETURN;
  END IF;

  v_sequence := 1 + coalesce((
    SELECT pg_catalog.max(step.sequence) FROM public.agent_run_steps AS step
    WHERE step.run_id=p_run_id), 0);
  INSERT INTO public.agent_run_steps(
    id,tenant_id,workspace_id,run_id,sequence,status,policy_key,policy_version,
    result_ref,error_code,recorded_at)
  VALUES (p_step_id,v_current.tenant_id,v_current.workspace_id,p_run_id,v_sequence,
    p_status,p_policy_key,v_policy_version,p_result_ref,p_error_code,v_recorded);
  RETURN QUERY SELECT 'appended'::pg_catalog.text;
END;
$function$;

CREATE OR REPLACE FUNCTION public.novatrade_l04_append_agent_tool_call(
  p_tenant_id pg_catalog.text,
  p_workspace_id pg_catalog.text,
  p_run_id pg_catalog.text,
  p_lease_token pg_catalog.text,
  p_step_id pg_catalog.text,
  p_tool_call_id pg_catalog.text,
  p_tool_name pg_catalog.text,
  p_tool_version pg_catalog.text,
  p_permission_decision pg_catalog.text,
  p_status pg_catalog.text,
  p_input_hash pg_catalog.text,
  p_output_hash pg_catalog.text,
  p_source_ids pg_catalog.text,
  p_cost_usd pg_catalog.text,
  p_latency_ms pg_catalog.text,
  p_error_code pg_catalog.text,
  p_redacted_summary pg_catalog.text,
  p_recorded_at pg_catalog.text
)
RETURNS TABLE (kind pg_catalog.text)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog
AS $function$
DECLARE
  v_token_hash pg_catalog.text;
  v_source_ids pg_catalog.jsonb;
  v_cost pg_catalog.numeric(14,6);
  v_latency pg_catalog.int8;
  v_recorded pg_catalog.timestamptz;
  v_current public.agent_runs%ROWTYPE;
BEGIN
  IF p_tool_call_id IS NULL OR pg_catalog.char_length(p_tool_call_id) NOT BETWEEN 1 AND 160
     OR p_step_id IS NULL OR p_tool_name IS NULL
     OR pg_catalog.char_length(p_tool_name) NOT BETWEEN 1 AND 160
     OR p_tool_version IS NULL OR pg_catalog.char_length(p_tool_version) NOT BETWEEN 1 AND 80
     OR p_input_hash IS NULL OR pg_catalog.char_length(p_input_hash) NOT BETWEEN 1 AND 160
     OR p_redacted_summary IS NULL OR pg_catalog.char_length(p_redacted_summary) > 2000
     OR p_lease_token IS NULL OR p_lease_token !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$'
     OR p_permission_decision IS NULL OR p_permission_decision NOT IN ('allowed','denied')
     OR p_status IS NULL OR p_status NOT IN ('complete','failed','denied')
     OR (p_permission_decision='denied') <> (p_status='denied')
     OR (p_status='complete' AND (p_output_hash IS NULL OR p_error_code IS NOT NULL))
     OR (p_status<>'complete' AND (p_output_hash IS NOT NULL OR p_error_code IS NULL)) THEN
    RETURN;
  END IF;
  BEGIN
    v_source_ids := coalesce(p_source_ids,'[]')::pg_catalog.jsonb;
    v_cost := p_cost_usd::pg_catalog.numeric(14,6);
    v_latency := p_latency_ms::pg_catalog.int8;
    v_recorded := p_recorded_at::pg_catalog.timestamptz;
  EXCEPTION WHEN others THEN RETURN; END;
  IF v_cost < 0 OR v_latency < 0
     OR pg_catalog.jsonb_typeof(v_source_ids) IS DISTINCT FROM 'array' THEN RETURN; END IF;

  IF NOT public.novatrade_l04_agent_worker_gate(p_tenant_id,p_workspace_id,p_run_id) THEN
    RETURN;
  END IF;
  v_token_hash := public.novatrade_l04_agent_lease_token_hash(p_lease_token);

  SELECT * INTO v_current FROM public.agent_runs
    WHERE id=p_run_id AND tenant_id=p_tenant_id::pg_catalog.uuid
      AND workspace_id IS NOT DISTINCT FROM nullif(p_workspace_id,'')::pg_catalog.uuid
    FOR UPDATE;
  IF NOT FOUND THEN RETURN; END IF;
  IF v_current.status<>'running' OR v_current.lease_token_hash IS DISTINCT FROM v_token_hash
     OR v_recorded >= v_current.lease_expires_at THEN
    RETURN QUERY SELECT 'conflict'::pg_catalog.text;
    RETURN;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.agent_run_steps AS step
    WHERE step.id=p_step_id AND step.run_id=p_run_id) THEN
    RETURN QUERY SELECT 'conflict'::pg_catalog.text;
    RETURN;
  END IF;
  IF EXISTS (SELECT 1 FROM public.agent_tool_calls AS call WHERE call.id=p_tool_call_id) THEN
    RETURN QUERY SELECT 'conflict'::pg_catalog.text;
    RETURN;
  END IF;
  IF v_current.usage_cost_usd + v_cost > v_current.budget_usd THEN
    RETURN QUERY SELECT 'budget_exceeded'::pg_catalog.text;
    RETURN;
  END IF;

  INSERT INTO public.agent_tool_calls(
    id,tenant_id,workspace_id,run_id,step_id,tool_name,tool_version,permission_decision,
    status,input_hash,output_hash,source_ids,cost_usd,latency_ms,error_code,
    redacted_summary,recorded_at)
  VALUES (p_tool_call_id,v_current.tenant_id,v_current.workspace_id,p_run_id,p_step_id,
    p_tool_name,p_tool_version,p_permission_decision,p_status,p_input_hash,p_output_hash,
    v_source_ids,v_cost,v_latency,p_error_code,p_redacted_summary,v_recorded);
  UPDATE public.agent_runs
    SET usage_cost_usd=usage_cost_usd+v_cost, updated_at=v_recorded
    WHERE id=v_current.id;
  RETURN QUERY SELECT 'appended'::pg_catalog.text;
END;
$function$;

CREATE OR REPLACE FUNCTION public.novatrade_l04_finalize_agent_run(
  p_tenant_id pg_catalog.text,
  p_workspace_id pg_catalog.text,
  p_run_id pg_catalog.text,
  p_lease_token pg_catalog.text,
  p_outcome pg_catalog.text,
  p_result_ref pg_catalog.text,
  p_error_code pg_catalog.text,
  p_usage_cost_usd pg_catalog.text,
  p_retry_at pg_catalog.text,
  p_ended_at pg_catalog.text,
  p_settlement_id pg_catalog.text,
  p_actual_cost_usd pg_catalog.text,
  p_input_tokens pg_catalog.text,
  p_output_tokens pg_catalog.text,
  p_provider_request_ref_hash pg_catalog.text
)
RETURNS TABLE (kind pg_catalog.text)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog
AS $function$
DECLARE
  v_token_hash pg_catalog.text;
  v_usage pg_catalog.numeric(14,6);
  v_retry pg_catalog.timestamptz;
  v_ended pg_catalog.timestamptz;
  v_actual pg_catalog.numeric(14,6);
  v_in pg_catalog.int8;
  v_out pg_catalog.int8;
  v_current public.agent_runs%ROWTYPE;
  v_status pg_catalog.text;
  v_reservation_id pg_catalog.text;
BEGIN
  IF p_run_id IS NULL OR p_lease_token IS NULL
     OR p_lease_token !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$'
     OR p_outcome IS NULL OR p_outcome NOT IN ('complete','failed','retry_wait','dead_letter')
     OR (p_outcome='complete' AND (p_result_ref IS NULL OR p_error_code IS NOT NULL))
     OR (p_outcome<>'complete' AND (p_result_ref IS NOT NULL OR p_error_code IS NULL))
     OR (p_outcome='retry_wait' AND p_retry_at IS NULL)
     OR p_settlement_id IS NULL OR pg_catalog.char_length(p_settlement_id) NOT BETWEEN 1 AND 160
  THEN
    RETURN;
  END IF;
  BEGIN
    v_usage := p_usage_cost_usd::pg_catalog.numeric(14,6);
    v_retry := CASE WHEN p_retry_at IS NULL THEN NULL ELSE p_retry_at::pg_catalog.timestamptz END;
    v_ended := p_ended_at::pg_catalog.timestamptz;
    v_actual := p_actual_cost_usd::pg_catalog.numeric(14,6);
    v_in := p_input_tokens::pg_catalog.int8;
    v_out := p_output_tokens::pg_catalog.int8;
  EXCEPTION WHEN others THEN RETURN; END;
  IF v_usage < 0 OR v_actual < 0 OR v_in < 0 OR v_out < 0
     OR (v_retry IS NOT NULL AND v_retry <= v_ended) THEN RETURN; END IF;
  IF p_provider_request_ref_hash IS NOT NULL
     AND p_provider_request_ref_hash !~ '^[0-9a-f]{64}$' THEN RETURN; END IF;

  IF NOT public.novatrade_l04_agent_worker_gate(p_tenant_id,p_workspace_id,p_run_id) THEN
    RETURN;
  END IF;
  v_token_hash := public.novatrade_l04_agent_lease_token_hash(p_lease_token);

  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('l04:finalize:' || p_run_id, 0));

  SELECT * INTO v_current FROM public.agent_runs
    WHERE id=p_run_id AND tenant_id=p_tenant_id::pg_catalog.uuid
      AND workspace_id IS NOT DISTINCT FROM nullif(p_workspace_id,'')::pg_catalog.uuid
    FOR UPDATE;
  IF NOT FOUND THEN RETURN; END IF;
  IF v_current.status<>'running' OR v_current.lease_token_hash IS DISTINCT FROM v_token_hash THEN
    RETURN QUERY SELECT 'conflict'::pg_catalog.text;
    RETURN;
  END IF;
  IF v_ended >= v_current.lease_expires_at OR v_ended < v_current.updated_at THEN
    RETURN QUERY SELECT 'expired'::pg_catalog.text;
    RETURN;
  END IF;
  IF v_usage < v_current.usage_cost_usd OR v_usage > v_current.budget_usd THEN
    RETURN QUERY SELECT 'conflict'::pg_catalog.text;
    RETURN;
  END IF;

  v_status := CASE
    WHEN p_outcome='complete' THEN 'complete'
    WHEN p_outcome='retry_wait' AND v_current.attempt_count < v_current.max_attempts THEN 'retry_wait'
    WHEN p_outcome='retry_wait' THEN 'dead_letter'
    WHEN p_outcome='dead_letter' THEN 'dead_letter'
    ELSE 'failed' END;

  UPDATE public.agent_runs
    SET status=v_status, usage_cost_usd=v_usage, lease_token_hash=NULL,
        lease_worker_hash=NULL, lease_acquired_at=NULL, lease_heartbeat_at=NULL,
        lease_expires_at=NULL,
        next_attempt_at=CASE WHEN v_status='retry_wait' THEN v_retry ELSE NULL END,
        result_ref=CASE WHEN v_status='complete' THEN p_result_ref ELSE NULL END,
        error_code=CASE WHEN v_status='complete' THEN NULL ELSE p_error_code END,
        ended_at=CASE WHEN v_status='retry_wait' THEN NULL ELSE v_ended END,
        updated_at=v_ended
    WHERE id=v_current.id;

  -- Per-attempt reservation + settlement pair; reservation ids are unique per
  -- (run, attempt) so each finalize settles exactly once.
  v_reservation_id := p_run_id || ':reservation:' || v_current.attempt_count::pg_catalog.text;
  INSERT INTO public.agent_usage_reservations(
    id,tenant_id,workspace_id,run_id,idempotency_key,input_hash,reserved_cost_usd,
    reserved_input_tokens,reserved_output_tokens,created_at)
  VALUES (v_reservation_id,v_current.tenant_id,v_current.workspace_id,p_run_id,
    'attempt:' || v_current.attempt_count::pg_catalog.text, v_current.input_hash,
    v_actual,v_in,v_out,v_ended);
  INSERT INTO public.agent_usage_settlements(
    id,tenant_id,workspace_id,run_id,reservation_id,status,actual_cost_usd,
    input_tokens,output_tokens,provider_request_ref_hash,settled_at)
  VALUES (p_settlement_id,v_current.tenant_id,v_current.workspace_id,p_run_id,
    v_reservation_id,'settled',v_actual,v_in,v_out,p_provider_request_ref_hash,v_ended);
  RETURN QUERY SELECT 'finalized'::pg_catalog.text;
END;
$function$;

-- ---------------------------------------------------------------------------
-- RLS + grants
-- ---------------------------------------------------------------------------

DO $security$
DECLARE t text; f text;
BEGIN
  EXECUTE 'ALTER TABLE public.agent_run_inputs ENABLE ROW LEVEL SECURITY';
  EXECUTE 'ALTER TABLE public.agent_run_inputs FORCE ROW LEVEL SECURITY';
  EXECUTE 'REVOKE ALL ON TABLE public.agent_run_inputs FROM PUBLIC';
  IF pg_catalog.to_regrole('anon') IS NOT NULL THEN
    EXECUTE 'REVOKE ALL ON TABLE public.agent_run_inputs FROM anon';
  END IF;
  IF pg_catalog.to_regrole('authenticated') IS NOT NULL THEN
    EXECUTE 'REVOKE ALL ON TABLE public.agent_run_inputs FROM authenticated';
  END IF;

  FOREACH f IN ARRAY ARRAY[
    'novatrade_l04_agent_run_inputs_guard','novatrade_l04_agent_member_gate',
    'novatrade_l04_agent_worker_gate','novatrade_l04_agent_lease_token_hash',
    'novatrade_l04_enqueue_agent_run','novatrade_l04_cancel_agent_run',
    'novatrade_l04_register_agent_prompt','novatrade_l04_register_agent_policy',
    'novatrade_l04_claim_agent_run','novatrade_l04_heartbeat_agent_run',
    'novatrade_l04_append_agent_run_step','novatrade_l04_append_agent_tool_call',
    'novatrade_l04_finalize_agent_run'] LOOP
    EXECUTE pg_catalog.format('REVOKE ALL ON FUNCTION public.%I FROM PUBLIC', f);
    IF pg_catalog.to_regrole('anon') IS NOT NULL THEN
      EXECUTE pg_catalog.format('REVOKE ALL ON FUNCTION public.%I FROM anon', f);
    END IF;
    IF pg_catalog.to_regrole('authenticated') IS NOT NULL THEN
      EXECUTE pg_catalog.format('REVOKE ALL ON FUNCTION public.%I FROM authenticated', f);
    END IF;
  END LOOP;
END;
$security$;

-- Member reads on all run-scoped tables; mutations stay behind the definer.
DO $policies$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'agent_prompt_versions','agent_policy_versions','agent_runs',
    'agent_run_lease_history','agent_run_steps','agent_tool_calls',
    'agent_usage_reservations','agent_usage_settlements','agent_run_inputs'] LOOP
    EXECUTE pg_catalog.format('DROP POLICY IF EXISTS l04_%I_deny_mutations ON public.%I', t, t);
    EXECUTE pg_catalog.format(
      'CREATE POLICY l04_%I_deny_mutations ON public.%I FOR ALL TO PUBLIC USING (false) WITH CHECK (false)', t, t);
  END LOOP;
  FOREACH t IN ARRAY ARRAY[
    'agent_runs','agent_run_lease_history','agent_run_steps','agent_tool_calls',
    'agent_usage_reservations','agent_usage_settlements','agent_run_inputs'] LOOP
    EXECUTE pg_catalog.format('DROP POLICY IF EXISTS l04_%I_member_select ON public.%I', t, t);
    EXECUTE pg_catalog.format(
      'CREATE POLICY l04_%I_member_select ON public.%I FOR SELECT TO PUBLIC USING (
        tenant_id::text = pg_catalog.current_setting(''app.tenant_id'', true)
        AND (
          coalesce(pg_catalog.current_setting(''app.workspace_id'', true), '''') = ''''
          OR workspace_id IS NULL
          OR workspace_id::text = pg_catalog.current_setting(''app.workspace_id'', true)
        )
        AND public.novatrade_rls_member_context()
      )', t, t);
  END LOOP;
END;
$policies$;

-- Registry tables carry no tenant columns; gate reads on member context only.
DROP POLICY IF EXISTS l04_agent_prompt_versions_member_select ON public.agent_prompt_versions;
DROP POLICY IF EXISTS l04_agent_policy_versions_member_select ON public.agent_policy_versions;
CREATE POLICY l04_agent_prompt_versions_member_select ON public.agent_prompt_versions
  FOR SELECT TO PUBLIC USING (public.novatrade_rls_member_context());
CREATE POLICY l04_agent_policy_versions_member_select ON public.agent_policy_versions
  FOR SELECT TO PUBLIC USING (public.novatrade_rls_member_context());

-- Worker reads: a live agent_runtime dispatch lease may read its own run row
-- and its durable input; nothing else.
DROP POLICY IF EXISTS l04_agent_runs_worker_select ON public.agent_runs;
DROP POLICY IF EXISTS l04_agent_run_inputs_worker_select ON public.agent_run_inputs;
CREATE POLICY l04_agent_runs_worker_select ON public.agent_runs
  FOR SELECT TO PUBLIC USING (
    public.novatrade_validate_tenant_worker_lease()
    AND pg_catalog.current_setting('app.worker_name',true)='agent_runtime'
    AND pg_catalog.current_setting('app.worker_action',true)='agent_runtime:execute'
    AND tenant_id::text=pg_catalog.current_setting('app.tenant_id',true)
    AND workspace_id::text IS NOT DISTINCT FROM nullif(pg_catalog.current_setting('app.workspace_id',true),'')
    AND id=pg_catalog.current_setting('app.run_id',true)
  );
CREATE POLICY l04_agent_run_inputs_worker_select ON public.agent_run_inputs
  FOR SELECT TO PUBLIC USING (
    public.novatrade_validate_tenant_worker_lease()
    AND pg_catalog.current_setting('app.worker_name',true)='agent_runtime'
    AND pg_catalog.current_setting('app.worker_action',true)='agent_runtime:execute'
    AND tenant_id::text=pg_catalog.current_setting('app.tenant_id',true)
    AND workspace_id::text IS NOT DISTINCT FROM nullif(pg_catalog.current_setting('app.workspace_id',true),'')
    AND run_id=pg_catalog.current_setting('app.run_id',true)
  );

ALTER FUNCTION public.novatrade_l04_agent_member_gate(pg_catalog.text,pg_catalog.text,pg_catalog.text[])
  OWNER TO novatrade_agent_runtime_definer;
ALTER FUNCTION public.novatrade_l04_agent_worker_gate(pg_catalog.text,pg_catalog.text,pg_catalog.text)
  OWNER TO novatrade_agent_runtime_definer;
ALTER FUNCTION public.novatrade_l04_agent_lease_token_hash(pg_catalog.text)
  OWNER TO novatrade_agent_runtime_definer;
ALTER FUNCTION public.novatrade_l04_enqueue_agent_run(pg_catalog.text,pg_catalog.text,pg_catalog.text,pg_catalog.text,pg_catalog.text,pg_catalog.text,pg_catalog.text,pg_catalog.text,pg_catalog.text,pg_catalog.text,pg_catalog.text,pg_catalog.text,pg_catalog.text,pg_catalog.text,pg_catalog.text)
  OWNER TO novatrade_agent_runtime_definer;
ALTER FUNCTION public.novatrade_l04_cancel_agent_run(pg_catalog.text,pg_catalog.text,pg_catalog.text,pg_catalog.text)
  OWNER TO novatrade_agent_runtime_definer;
ALTER FUNCTION public.novatrade_l04_register_agent_prompt(pg_catalog.text,pg_catalog.text,pg_catalog.text,pg_catalog.text,pg_catalog.text,pg_catalog.text)
  OWNER TO novatrade_agent_runtime_definer;
ALTER FUNCTION public.novatrade_l04_register_agent_policy(pg_catalog.text,pg_catalog.text,pg_catalog.text,pg_catalog.text,pg_catalog.text,pg_catalog.text,pg_catalog.text,pg_catalog.text)
  OWNER TO novatrade_agent_runtime_definer;
ALTER FUNCTION public.novatrade_l04_claim_agent_run(pg_catalog.text,pg_catalog.text,pg_catalog.text,pg_catalog.text,pg_catalog.text,pg_catalog.text,pg_catalog.text)
  OWNER TO novatrade_agent_runtime_definer;
ALTER FUNCTION public.novatrade_l04_heartbeat_agent_run(pg_catalog.text,pg_catalog.text,pg_catalog.text,pg_catalog.text,pg_catalog.text,pg_catalog.text)
  OWNER TO novatrade_agent_runtime_definer;
ALTER FUNCTION public.novatrade_l04_append_agent_run_step(pg_catalog.text,pg_catalog.text,pg_catalog.text,pg_catalog.text,pg_catalog.text,pg_catalog.text,pg_catalog.text,pg_catalog.text,pg_catalog.text,pg_catalog.text,pg_catalog.text)
  OWNER TO novatrade_agent_runtime_definer;
ALTER FUNCTION public.novatrade_l04_append_agent_tool_call(pg_catalog.text,pg_catalog.text,pg_catalog.text,pg_catalog.text,pg_catalog.text,pg_catalog.text,pg_catalog.text,pg_catalog.text,pg_catalog.text,pg_catalog.text,pg_catalog.text,pg_catalog.text,pg_catalog.text,pg_catalog.text,pg_catalog.text,pg_catalog.text,pg_catalog.text,pg_catalog.text)
  OWNER TO novatrade_agent_runtime_definer;
ALTER FUNCTION public.novatrade_l04_finalize_agent_run(pg_catalog.text,pg_catalog.text,pg_catalog.text,pg_catalog.text,pg_catalog.text,pg_catalog.text,pg_catalog.text,pg_catalog.text,pg_catalog.text,pg_catalog.text,pg_catalog.text,pg_catalog.text,pg_catalog.text,pg_catalog.text,pg_catalog.text)
  OWNER TO novatrade_agent_runtime_definer;

GRANT USAGE ON SCHEMA public TO novatrade_agent_runtime_definer;
-- The worker gate evaluates the F-01 lease validator, which is EXECUTE-revoked
-- from PUBLIC; the runtime definer needs it explicitly.
GRANT EXECUTE ON FUNCTION public.novatrade_validate_tenant_worker_lease()
  TO novatrade_agent_runtime_definer;
GRANT SELECT ON TABLE public.tenants,public.workspaces,public.tenant_memberships,
  public.tenant_role_bindings,public.tenant_worker_dispatch_leases
  TO novatrade_agent_runtime_definer;
GRANT SELECT,INSERT ON TABLE public.agent_prompt_versions,public.agent_policy_versions
  TO novatrade_agent_runtime_definer;
GRANT SELECT,INSERT,UPDATE ON TABLE public.agent_runs TO novatrade_agent_runtime_definer;
GRANT SELECT,INSERT ON TABLE public.agent_run_lease_history,public.agent_run_steps,
  public.agent_tool_calls,public.agent_usage_reservations,public.agent_usage_settlements
  TO novatrade_agent_runtime_definer;
GRANT SELECT,INSERT ON TABLE public.agent_run_inputs TO novatrade_agent_runtime_definer;
GRANT USAGE ON SEQUENCE public.agent_run_lease_history_id_seq TO novatrade_agent_runtime_definer;
-- The lease-history sync trigger already runs SECURITY DEFINER; the definer
-- role needs no sequence beyond what the trigger consumes.

COMMENT ON FUNCTION public.novatrade_l04_agent_worker_gate(pg_catalog.text,pg_catalog.text,pg_catalog.text) IS
  'L-04 worker gate: a live agent_runtime dispatch lease bound to this run plus agent_runtime action; run lease token does the execution fencing.';
COMMENT ON FUNCTION public.novatrade_l04_enqueue_agent_run(pg_catalog.text,pg_catalog.text,pg_catalog.text,pg_catalog.text,pg_catalog.text,pg_catalog.text,pg_catalog.text,pg_catalog.text,pg_catalog.text,pg_catalog.text,pg_catalog.text,pg_catalog.text,pg_catalog.text,pg_catalog.text,pg_catalog.text) IS
  'L-04 member enqueue: atomically writes run + durable input; exact idempotent replay returns stored facts, conflicting reuse mutates nothing.';
COMMENT ON FUNCTION public.novatrade_l04_claim_agent_run(pg_catalog.text,pg_catalog.text,pg_catalog.text,pg_catalog.text,pg_catalog.text,pg_catalog.text,pg_catalog.text) IS
  'L-04 worker claim: dispatch-lease gated, strict lease-generation advance, one-way token hash fencing; exhausted runs transition to dead_letter.';
COMMENT ON FUNCTION public.novatrade_l04_finalize_agent_run(pg_catalog.text,pg_catalog.text,pg_catalog.text,pg_catalog.text,pg_catalog.text,pg_catalog.text,pg_catalog.text,pg_catalog.text,pg_catalog.text,pg_catalog.text,pg_catalog.text,pg_catalog.text,pg_catalog.text,pg_catalog.text,pg_catalog.text) IS
  'L-04 worker finalize: fenced terminal/retry transition plus per-attempt reservation and usage settlement.';

COMMIT;
