-- 0X3-233: Postgres provisioning port — system-lane SECURITY DEFINER
-- functions behind the tenant-foundation write set.
--
-- The provisioning lane has no member context: the tenant being provisioned
-- does not exist yet, so no membership can be established. Authority in this
-- lane is the EXECUTE grant itself (the restricted runtime role is the
-- platform service identity); each function additionally:
--   * refuses to run while any member/worker/support context GUC is installed
--     (context-confusion guard),
--   * binds child-row inserts to a tenant created in the same transaction
--     (xmin = current xact), so the functions can never touch pre-existing
--     tenants or inject rows into them,
--   * re-validates every payload field server-side.
--
-- All functions take pg_catalog.text payloads parsed to jsonb internally —
-- never a jsonb parameter: postgres.js serializes a JS string bound to a
-- jsonb position as a jsonb string scalar (double-encoded), so every ->>
-- extractor would see NULL.

CREATE OR REPLACE FUNCTION public.novatrade_provisioning_system_lane()
RETURNS boolean
LANGUAGE plpgsql
STABLE
SET search_path = pg_catalog, public
AS $function$
BEGIN
  RETURN coalesce(pg_catalog.current_setting('app.tenant_id', true), '') = ''
     AND coalesce(pg_catalog.current_setting('app.membership_id', true), '') = ''
     AND coalesce(pg_catalog.current_setting('app.actor_id', true), '') = ''
     AND coalesce(pg_catalog.current_setting('app.role', true), '') = ''
     AND coalesce(pg_catalog.current_setting('app.support_grant_id', true), '') = ''
     AND coalesce(pg_catalog.current_setting('app.worker_name', true), '') = '';
END;
$function$;

COMMENT ON FUNCTION public.novatrade_provisioning_system_lane() IS
  'Internal: true only while no member/worker/support context GUC is installed. The provisioning lane is context-free by design.';
REVOKE ALL ON FUNCTION public.novatrade_provisioning_system_lane() FROM PUBLIC;

CREATE OR REPLACE FUNCTION public.novatrade_provisioning_session_tenant(p_tenant_id pg_catalog.text)
RETURNS boolean
LANGUAGE plpgsql
STABLE
SET search_path = pg_catalog, public
AS $function$
BEGIN
  RETURN EXISTS (
    SELECT 1
    FROM public.tenants AS tenant
    WHERE tenant.id = p_tenant_id::pg_catalog.uuid
      AND tenant.status = 'provisioning'
      AND tenant.xmin::pg_catalog.text::pg_catalog.int8
          = pg_catalog.pg_current_xact_id()::pg_catalog.text::pg_catalog.int8
  );
END;
$function$;

COMMENT ON FUNCTION public.novatrade_provisioning_session_tenant(pg_catalog.text) IS
  'Internal: true when the named tenant exists, is in provisioning status, and was inserted by the current transaction — the session-created binding.';
REVOKE ALL ON FUNCTION public.novatrade_provisioning_session_tenant(pg_catalog.text) FROM PUBLIC;

CREATE OR REPLACE FUNCTION public.novatrade_provisioning_journal_find(p_request pg_catalog.text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $function$
DECLARE
  v_request pg_catalog.jsonb;
  v_key pg_catalog.text;
  v_record pg_catalog.jsonb;
BEGIN
  IF NOT public.novatrade_provisioning_system_lane() THEN RETURN NULL; END IF;
  BEGIN
    v_request := p_request::pg_catalog.jsonb;
  EXCEPTION WHEN OTHERS THEN
    RETURN NULL;
  END;
  v_key := v_request ->> 'idempotencyKeyHash';
  IF v_key IS NULL OR v_key !~ '^[0-9a-f]{64}$' THEN RETURN NULL; END IF;

  SELECT pg_catalog.jsonb_build_object(
    'idempotencyKeyHashRef', row_.idempotency_key_hash,
    'inputHashRef', row_.input_hash,
    'requestId', row_.request_id,
    'state', row_.status,
    'result', row_.result_json
  ) INTO v_record
  FROM public.tenant_provisioning_journal AS row_
  WHERE row_.idempotency_key_hash = v_key;

  RETURN v_record;
END;
$function$;

COMMENT ON FUNCTION public.novatrade_provisioning_journal_find(pg_catalog.text) IS
  'L-02 system-lane read of the provisioning journal by key hash; returns NULL when absent.';
REVOKE ALL ON FUNCTION public.novatrade_provisioning_journal_find(pg_catalog.text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.novatrade_provisioning_journal_find(pg_catalog.text) FROM anon;
REVOKE ALL ON FUNCTION public.novatrade_provisioning_journal_find(pg_catalog.text) FROM authenticated;

CREATE OR REPLACE FUNCTION public.novatrade_provisioning_journal_reserve(p_request pg_catalog.text)
RETURNS TABLE(outcome pg_catalog.text, record pg_catalog.jsonb)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $function$
DECLARE
  v_request pg_catalog.jsonb;
  v_key pg_catalog.text;
  v_input pg_catalog.text;
  v_request_id pg_catalog.text;
  v_row public.tenant_provisioning_journal%ROWTYPE;
  v_record pg_catalog.jsonb;
BEGIN
  IF NOT public.novatrade_provisioning_system_lane() THEN
    RETURN QUERY SELECT 'denied'::pg_catalog.text, NULL::pg_catalog.jsonb;
    RETURN;
  END IF;
  BEGIN
    v_request := p_request::pg_catalog.jsonb;
  EXCEPTION WHEN OTHERS THEN
    RETURN QUERY SELECT 'invalid_request'::pg_catalog.text, NULL::pg_catalog.jsonb;
    RETURN;
  END;
  v_key := v_request ->> 'idempotencyKeyHash';
  v_input := v_request ->> 'inputHash';
  v_request_id := v_request ->> 'requestId';
  IF v_key IS NULL OR v_key !~ '^[0-9a-f]{64}$'
     OR v_input IS NULL OR v_input !~ '^[0-9a-f]{64}$'
     OR v_request_id IS NULL OR v_request_id !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
  THEN
    RETURN QUERY SELECT 'invalid_request'::pg_catalog.text, NULL::pg_catalog.jsonb;
    RETURN;
  END IF;

  SELECT * INTO v_row
  FROM public.tenant_provisioning_journal AS journal
  WHERE journal.idempotency_key_hash = v_key;

  IF NOT FOUND THEN
    BEGIN
      INSERT INTO public.tenant_provisioning_journal (idempotency_key_hash, input_hash, request_id)
      VALUES (v_key, v_input, v_request_id::pg_catalog.uuid);
      RETURN QUERY SELECT 'reserved'::pg_catalog.text, NULL::pg_catalog.jsonb;
      RETURN;
    EXCEPTION WHEN unique_violation THEN
      SELECT * INTO v_row
      FROM public.tenant_provisioning_journal AS journal
      WHERE journal.idempotency_key_hash = v_key;
    END;
  END IF;

  IF v_row.request_id::pg_catalog.text IS DISTINCT FROM v_request_id
     OR v_row.input_hash IS DISTINCT FROM v_input
  THEN
    RETURN QUERY SELECT 'conflict'::pg_catalog.text, NULL::pg_catalog.jsonb;
    RETURN;
  END IF;
  IF v_row.status = 'completed' THEN
    v_record := pg_catalog.jsonb_build_object(
      'idempotencyKeyHashRef', v_row.idempotency_key_hash,
      'inputHashRef', v_row.input_hash,
      'requestId', v_row.request_id,
      'state', v_row.status,
      'result', v_row.result_json
    );
    RETURN QUERY SELECT 'completed'::pg_catalog.text, v_record;
    RETURN;
  END IF;
  RETURN QUERY SELECT 'in_progress'::pg_catalog.text, NULL::pg_catalog.jsonb;
END;
$function$;

COMMENT ON FUNCTION public.novatrade_provisioning_journal_reserve(pg_catalog.text) IS
  'L-02 system-lane journal reservation: inserts an in_progress row or reports completed/in_progress/conflict for the key hash.';
REVOKE ALL ON FUNCTION public.novatrade_provisioning_journal_reserve(pg_catalog.text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.novatrade_provisioning_journal_reserve(pg_catalog.text) FROM anon;
REVOKE ALL ON FUNCTION public.novatrade_provisioning_journal_reserve(pg_catalog.text) FROM authenticated;

CREATE OR REPLACE FUNCTION public.novatrade_provisioning_journal_complete(p_request pg_catalog.text)
RETURNS TABLE(committed boolean)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $function$
DECLARE
  v_request pg_catalog.jsonb;
  v_key pg_catalog.text;
  v_input pg_catalog.text;
  v_request_id pg_catalog.text;
  v_result pg_catalog.jsonb;
  v_count pg_catalog.int8;
BEGIN
  IF NOT public.novatrade_provisioning_system_lane() THEN
    RETURN QUERY SELECT false;
    RETURN;
  END IF;
  BEGIN
    v_request := p_request::pg_catalog.jsonb;
  EXCEPTION WHEN OTHERS THEN
    RETURN QUERY SELECT false;
    RETURN;
  END;
  v_key := v_request ->> 'idempotencyKeyHash';
  v_input := v_request ->> 'inputHash';
  v_request_id := v_request ->> 'requestId';
  v_result := v_request -> 'result';
  IF v_key IS NULL OR v_key !~ '^[0-9a-f]{64}$'
     OR v_input IS NULL OR v_input !~ '^[0-9a-f]{64}$'
     OR v_request_id IS NULL OR v_request_id !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
     OR v_result IS NULL OR v_result = 'null'::pg_catalog.jsonb
  THEN
    RETURN QUERY SELECT false;
    RETURN;
  END IF;

  UPDATE public.tenant_provisioning_journal AS journal
  SET status = 'completed', result_json = v_result, completed_at = pg_catalog.statement_timestamp()
  WHERE journal.idempotency_key_hash = v_key
    AND journal.input_hash = v_input
    AND journal.request_id = v_request_id::pg_catalog.uuid
    AND journal.status = 'in_progress';
  GET DIAGNOSTICS v_count = ROW_COUNT;
  RETURN QUERY SELECT v_count = 1;
END;
$function$;

COMMENT ON FUNCTION public.novatrade_provisioning_journal_complete(pg_catalog.text) IS
  'L-02 system-lane journal completion: marks an in_progress reservation completed with its result json.';
REVOKE ALL ON FUNCTION public.novatrade_provisioning_journal_complete(pg_catalog.text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.novatrade_provisioning_journal_complete(pg_catalog.text) FROM anon;
REVOKE ALL ON FUNCTION public.novatrade_provisioning_journal_complete(pg_catalog.text) FROM authenticated;

CREATE OR REPLACE FUNCTION public.novatrade_provisioning_create_tenant(p_request pg_catalog.text)
RETURNS TABLE(record pg_catalog.jsonb)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $function$
DECLARE
  v_request pg_catalog.jsonb;
  v_id pg_catalog.text;
  v_slug pg_catalog.text;
  v_name pg_catalog.text;
  v_status pg_catalog.text;
  v_locale pg_catalog.text;
  v_timezone pg_catalog.text;
  v_created pg_catalog.text;
  v_updated pg_catalog.text;
BEGIN
  IF NOT public.novatrade_provisioning_system_lane() THEN RETURN; END IF;
  BEGIN
    v_request := p_request::pg_catalog.jsonb;
  EXCEPTION WHEN OTHERS THEN
    RETURN;
  END;
  v_id := v_request ->> 'id';
  v_slug := v_request ->> 'slug';
  v_name := v_request ->> 'name';
  v_status := v_request ->> 'status';
  v_locale := v_request ->> 'locale';
  v_timezone := v_request ->> 'timezone';
  v_created := v_request ->> 'createdAt';
  v_updated := v_request ->> 'updatedAt';
  IF v_id IS NULL OR v_id !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
     OR v_status IS NULL OR v_status <> 'provisioning'
     OR v_created IS NULL OR v_updated IS NULL
  THEN
    RETURN;
  END IF;

  RETURN QUERY
  WITH inserted AS (
    INSERT INTO public.tenants (id, slug, name, status, locale, timezone, created_at, updated_at)
    VALUES (
      v_id::pg_catalog.uuid, v_slug, v_name, v_status, v_locale, v_timezone,
      v_created::pg_catalog.timestamptz, v_updated::pg_catalog.timestamptz
    )
    RETURNING *
  )
  SELECT pg_catalog.jsonb_build_object(
    'id', row_.id,
    'slug', row_.slug,
    'name', row_.name,
    'status', row_.status,
    'locale', row_.locale,
    'timezone', row_.timezone,
    'createdAt', pg_catalog.to_char(row_.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
    'updatedAt', pg_catalog.to_char(row_.updated_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
  )
  FROM inserted AS row_;
END;
$function$;

COMMENT ON FUNCTION public.novatrade_provisioning_create_tenant(p_request pg_catalog.text) IS
  'L-02 system-lane tenant foundation insert; the new tenant anchors the session-created binding for the rest of the foundation.';
REVOKE ALL ON FUNCTION public.novatrade_provisioning_create_tenant(pg_catalog.text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.novatrade_provisioning_create_tenant(pg_catalog.text) FROM anon;
REVOKE ALL ON FUNCTION public.novatrade_provisioning_create_tenant(pg_catalog.text) FROM authenticated;

CREATE OR REPLACE FUNCTION public.novatrade_provisioning_create_workspace(p_request pg_catalog.text)
RETURNS TABLE(record pg_catalog.jsonb)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $function$
DECLARE
  v_request pg_catalog.jsonb;
  v_id pg_catalog.text;
  v_tenant_id pg_catalog.text;
  v_slug pg_catalog.text;
  v_name pg_catalog.text;
  v_status pg_catalog.text;
  v_created pg_catalog.text;
  v_updated pg_catalog.text;
BEGIN
  IF NOT public.novatrade_provisioning_system_lane() THEN RETURN; END IF;
  BEGIN
    v_request := p_request::pg_catalog.jsonb;
  EXCEPTION WHEN OTHERS THEN
    RETURN;
  END;
  v_id := v_request ->> 'id';
  v_tenant_id := v_request ->> 'tenantId';
  v_slug := v_request ->> 'slug';
  v_name := v_request ->> 'name';
  v_status := v_request ->> 'status';
  v_created := v_request ->> 'createdAt';
  v_updated := v_request ->> 'updatedAt';
  IF v_id IS NULL OR v_id !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
     OR v_tenant_id IS NULL OR v_tenant_id !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
     OR v_status IS NULL OR v_status <> 'provisioning'
     OR v_created IS NULL OR v_updated IS NULL
     OR NOT public.novatrade_provisioning_session_tenant(v_tenant_id)
  THEN
    RETURN;
  END IF;

  RETURN QUERY
  WITH inserted AS (
    INSERT INTO public.workspaces (id, tenant_id, slug, name, status, created_at, updated_at)
    VALUES (
      v_id::pg_catalog.uuid, v_tenant_id::pg_catalog.uuid, v_slug, v_name, v_status,
      v_created::pg_catalog.timestamptz, v_updated::pg_catalog.timestamptz
    )
    RETURNING *
  )
  SELECT pg_catalog.jsonb_build_object(
    'id', row_.id,
    'tenantId', row_.tenant_id,
    'slug', row_.slug,
    'name', row_.name,
    'status', row_.status,
    'createdAt', pg_catalog.to_char(row_.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
    'updatedAt', pg_catalog.to_char(row_.updated_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
  )
  FROM inserted AS row_;
END;
$function$;

COMMENT ON FUNCTION public.novatrade_provisioning_create_workspace(p_request pg_catalog.text) IS
  'L-02 system-lane workspace insert bound to a session-created provisioning tenant.';
REVOKE ALL ON FUNCTION public.novatrade_provisioning_create_workspace(pg_catalog.text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.novatrade_provisioning_create_workspace(pg_catalog.text) FROM anon;
REVOKE ALL ON FUNCTION public.novatrade_provisioning_create_workspace(pg_catalog.text) FROM authenticated;

CREATE OR REPLACE FUNCTION public.novatrade_provisioning_create_policy(p_request pg_catalog.text)
RETURNS TABLE(record pg_catalog.jsonb)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $function$
DECLARE
  v_request pg_catalog.jsonb;
  v_id pg_catalog.text;
  v_tenant_id pg_catalog.text;
  v_locale pg_catalog.text;
  v_timezone pg_catalog.text;
  v_mode pg_catalog.text;
  v_created pg_catalog.text;
  v_updated pg_catalog.text;
BEGIN
  IF NOT public.novatrade_provisioning_system_lane() THEN RETURN; END IF;
  BEGIN
    v_request := p_request::pg_catalog.jsonb;
  EXCEPTION WHEN OTHERS THEN
    RETURN;
  END;
  v_id := v_request ->> 'id';
  v_tenant_id := v_request ->> 'tenantId';
  v_locale := v_request ->> 'locale';
  v_timezone := v_request ->> 'timezone';
  v_mode := v_request ->> 'activeMaterialsMode';
  v_created := v_request ->> 'createdAt';
  v_updated := v_request ->> 'updatedAt';
  IF v_id IS NULL OR v_id !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
     OR v_tenant_id IS NULL OR v_tenant_id !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
     OR v_created IS NULL OR v_updated IS NULL
     OR NOT public.novatrade_provisioning_session_tenant(v_tenant_id)
  THEN
    RETURN;
  END IF;

  RETURN QUERY
  WITH inserted AS (
    INSERT INTO public.tenant_policies (
      id, tenant_id, version, locale, timezone, export_retention_days,
      operational_log_retention_days, raw_source_retention_days, contact_freshness_days,
      primary_delete_within_days, backup_expire_within_days, tombstone_retention_years,
      active_materials_mode, ai_processing_enabled, source_research_enabled,
      contact_research_enabled, outreach_drafting_enabled, copy_export_enabled,
      autonomous_send_enabled, require_source_plan_approval, require_knowledge_review,
      require_icp_review, require_lead_play_review, require_contact_review,
      require_outreach_review, created_at, updated_at
    )
    VALUES (
      v_id::pg_catalog.uuid, v_tenant_id::pg_catalog.uuid, 1, v_locale, v_timezone,
      (v_request ->> 'exportRetentionDays')::pg_catalog.int4,
      (v_request ->> 'operationalLogRetentionDays')::pg_catalog.int4,
      (v_request ->> 'rawSourceRetentionDays')::pg_catalog.int4,
      (v_request ->> 'contactFreshnessDays')::pg_catalog.int4,
      (v_request ->> 'primaryDeleteWithinDays')::pg_catalog.int4,
      (v_request ->> 'backupExpireWithinDays')::pg_catalog.int4,
      (v_request ->> 'tombstoneRetentionYears')::pg_catalog.int4,
      v_mode,
      coalesce((v_request ->> 'aiProcessingEnabled')::pg_catalog.bool, false),
      coalesce((v_request ->> 'sourceResearchEnabled')::pg_catalog.bool, false),
      coalesce((v_request ->> 'contactResearchEnabled')::pg_catalog.bool, false),
      coalesce((v_request ->> 'outreachDraftingEnabled')::pg_catalog.bool, false),
      coalesce((v_request ->> 'copyExportEnabled')::pg_catalog.bool, false),
      coalesce((v_request ->> 'autonomousSendEnabled')::pg_catalog.bool, false),
      coalesce((v_request ->> 'requireSourcePlanApproval')::pg_catalog.bool, true),
      coalesce((v_request ->> 'requireKnowledgeReview')::pg_catalog.bool, true),
      coalesce((v_request ->> 'requireIcpReview')::pg_catalog.bool, true),
      coalesce((v_request ->> 'requireLeadPlayReview')::pg_catalog.bool, true),
      coalesce((v_request ->> 'requireContactReview')::pg_catalog.bool, true),
      coalesce((v_request ->> 'requireOutreachReview')::pg_catalog.bool, true),
      v_created::pg_catalog.timestamptz, v_updated::pg_catalog.timestamptz
    )
    RETURNING *
  )
  SELECT pg_catalog.jsonb_build_object(
    'id', row_.id,
    'tenantId', row_.tenant_id,
    'version', row_.version,
    'locale', row_.locale,
    'timezone', row_.timezone,
    'exportRetentionDays', row_.export_retention_days,
    'operationalLogRetentionDays', row_.operational_log_retention_days,
    'rawSourceRetentionDays', row_.raw_source_retention_days,
    'contactFreshnessDays', row_.contact_freshness_days,
    'primaryDeleteWithinDays', row_.primary_delete_within_days,
    'backupExpireWithinDays', row_.backup_expire_within_days,
    'tombstoneRetentionYears', row_.tombstone_retention_years,
    'activeMaterialsMode', row_.active_materials_mode,
    'aiProcessingEnabled', row_.ai_processing_enabled,
    'sourceResearchEnabled', row_.source_research_enabled,
    'contactResearchEnabled', row_.contact_research_enabled,
    'outreachDraftingEnabled', row_.outreach_drafting_enabled,
    'copyExportEnabled', row_.copy_export_enabled,
    'autonomousSendEnabled', row_.autonomous_send_enabled,
    'requireSourcePlanApproval', row_.require_source_plan_approval,
    'requireKnowledgeReview', row_.require_knowledge_review,
    'requireIcpReview', row_.require_icp_review,
    'requireLeadPlayReview', row_.require_lead_play_review,
    'requireContactReview', row_.require_contact_review,
    'requireOutreachReview', row_.require_outreach_review,
    'createdAt', pg_catalog.to_char(row_.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
    'updatedAt', pg_catalog.to_char(row_.updated_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
  )
  FROM inserted AS row_;
END;
$function$;

COMMENT ON FUNCTION public.novatrade_provisioning_create_policy(p_request pg_catalog.text) IS
  'L-02 system-lane tenant policy insert (version 1) bound to a session-created provisioning tenant.';
REVOKE ALL ON FUNCTION public.novatrade_provisioning_create_policy(pg_catalog.text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.novatrade_provisioning_create_policy(pg_catalog.text) FROM anon;
REVOKE ALL ON FUNCTION public.novatrade_provisioning_create_policy(pg_catalog.text) FROM authenticated;

CREATE OR REPLACE FUNCTION public.novatrade_provisioning_create_membership(p_request pg_catalog.text)
RETURNS TABLE(record pg_catalog.jsonb)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $function$
DECLARE
  v_request pg_catalog.jsonb;
  v_id pg_catalog.text;
  v_tenant_id pg_catalog.text;
  v_identity pg_catalog.text;
  v_pending_hash pg_catalog.text;
  v_workspace pg_catalog.text;
  v_status pg_catalog.text;
  v_invited_by pg_catalog.text;
  v_created pg_catalog.text;
  v_updated pg_catalog.text;
BEGIN
  IF NOT public.novatrade_provisioning_system_lane() THEN RETURN; END IF;
  BEGIN
    v_request := p_request::pg_catalog.jsonb;
  EXCEPTION WHEN OTHERS THEN
    RETURN;
  END;
  v_id := v_request ->> 'id';
  v_tenant_id := v_request ->> 'tenantId';
  v_identity := v_request ->> 'authIdentityId';
  v_pending_hash := v_request ->> 'pendingIdentityRefHash';
  v_workspace := v_request ->> 'workspaceId';
  v_status := v_request ->> 'status';
  v_invited_by := v_request ->> 'invitedByMembershipId';
  v_created := v_request ->> 'createdAt';
  v_updated := v_request ->> 'updatedAt';
  IF v_id IS NULL OR v_id !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
     OR v_tenant_id IS NULL OR v_tenant_id !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
     OR v_status IS NULL OR v_status NOT IN ('pending', 'active')
     OR v_created IS NULL OR v_updated IS NULL
     OR NOT public.novatrade_provisioning_session_tenant(v_tenant_id)
     OR (v_identity IS NULL AND v_pending_hash IS NULL)
     OR (v_identity IS NOT NULL AND v_pending_hash IS NOT NULL)
     OR (v_identity IS NOT NULL AND v_identity !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$')
     OR (v_pending_hash IS NOT NULL AND v_pending_hash !~ '^[0-9a-f]{64}$')
     OR (v_workspace IS NOT NULL AND v_workspace !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$')
     OR (v_invited_by IS NOT NULL AND v_invited_by !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$')
  THEN
    RETURN;
  END IF;

  RETURN QUERY
  WITH inserted AS (
    INSERT INTO public.tenant_memberships (
      id, tenant_id, auth_identity_id, pending_identity_ref_hash, workspace_id,
      status, invited_by_membership_id, created_at, updated_at
    )
    VALUES (
      v_id::pg_catalog.uuid, v_tenant_id::pg_catalog.uuid, v_identity::pg_catalog.uuid,
      v_pending_hash, v_workspace::pg_catalog.uuid, v_status,
      v_invited_by::pg_catalog.uuid,
      v_created::pg_catalog.timestamptz, v_updated::pg_catalog.timestamptz
    )
    RETURNING *
  )
  SELECT pg_catalog.jsonb_build_object(
    'id', row_.id,
    'tenantId', row_.tenant_id,
    'authIdentityId', row_.auth_identity_id,
    'pendingIdentityRefHash', row_.pending_identity_ref_hash,
    'workspaceId', row_.workspace_id,
    'status', row_.status,
    'invitedByMembershipId', row_.invited_by_membership_id,
    'createdAt', pg_catalog.to_char(row_.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
    'updatedAt', pg_catalog.to_char(row_.updated_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
  )
  FROM inserted AS row_;
END;
$function$;

COMMENT ON FUNCTION public.novatrade_provisioning_create_membership(p_request pg_catalog.text) IS
  'L-02 system-lane membership insert bound to a session-created provisioning tenant; the identity XOR binding is revalidated.';
REVOKE ALL ON FUNCTION public.novatrade_provisioning_create_membership(pg_catalog.text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.novatrade_provisioning_create_membership(pg_catalog.text) FROM anon;
REVOKE ALL ON FUNCTION public.novatrade_provisioning_create_membership(pg_catalog.text) FROM authenticated;

CREATE OR REPLACE FUNCTION public.novatrade_provisioning_create_binding(p_request pg_catalog.text)
RETURNS TABLE(record pg_catalog.jsonb)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $function$
DECLARE
  v_request pg_catalog.jsonb;
  v_id pg_catalog.text;
  v_tenant_id pg_catalog.text;
  v_membership pg_catalog.text;
  v_role pg_catalog.text;
  v_reason pg_catalog.text;
  v_valid_from pg_catalog.text;
  v_assigned_by pg_catalog.text;
  v_created pg_catalog.text;
BEGIN
  IF NOT public.novatrade_provisioning_system_lane() THEN RETURN; END IF;
  BEGIN
    v_request := p_request::pg_catalog.jsonb;
  EXCEPTION WHEN OTHERS THEN
    RETURN;
  END;
  v_id := v_request ->> 'id';
  v_tenant_id := v_request ->> 'tenantId';
  v_membership := v_request ->> 'membershipId';
  v_role := v_request ->> 'role';
  v_reason := v_request ->> 'reasonCode';
  v_valid_from := v_request ->> 'validFrom';
  v_assigned_by := v_request ->> 'assignedByMembershipId';
  v_created := v_request ->> 'createdAt';
  IF v_id IS NULL OR v_id !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
     OR v_tenant_id IS NULL OR v_tenant_id !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
     OR v_membership IS NULL OR v_membership !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
     OR v_role IS NULL OR v_role NOT IN (
       'owner', 'admin', 'strategist_manager', 'researcher',
       'reviewer', 'outreach_operator', 'analyst_read_only')
     OR v_reason IS NULL OR v_reason NOT IN (
       'initial_provisioning', 'invitation', 'role_change',
       'owner_replacement', 'membership_reactivation', 'administrative_correction')
     OR v_created IS NULL OR v_valid_from IS NULL
     OR (v_assigned_by IS NOT NULL AND v_assigned_by !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$')
     OR NOT public.novatrade_provisioning_session_tenant(v_tenant_id)
     OR NOT EXISTS (
       SELECT 1
       FROM public.tenant_memberships AS membership
       WHERE membership.tenant_id = v_tenant_id::pg_catalog.uuid
         AND membership.id = v_membership::pg_catalog.uuid
         AND membership.xmin::pg_catalog.text::pg_catalog.int8
             = pg_catalog.pg_current_xact_id()::pg_catalog.text::pg_catalog.int8
     )
  THEN
    RETURN;
  END IF;

  RETURN QUERY
  WITH inserted AS (
    INSERT INTO public.tenant_role_bindings (
      id, tenant_id, membership_id, role, created_at, valid_from, revoked_at,
      assigned_by_membership_id, reason_code
    )
    VALUES (
      v_id::pg_catalog.uuid, v_tenant_id::pg_catalog.uuid, v_membership::pg_catalog.uuid,
      v_role, v_created::pg_catalog.timestamptz, v_valid_from::pg_catalog.timestamptz,
      NULL, v_assigned_by::pg_catalog.uuid, v_reason
    )
    RETURNING *
  )
  SELECT pg_catalog.jsonb_build_object(
    'id', row_.id,
    'tenantId', row_.tenant_id,
    'membershipId', row_.membership_id,
    'role', row_.role,
    'reasonCode', row_.reason_code,
    'assignedByMembershipId', row_.assigned_by_membership_id,
    'validFrom', pg_catalog.to_char(row_.valid_from AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
    'revokedAt', NULL,
    'createdAt', pg_catalog.to_char(row_.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
  )
  FROM inserted AS row_;
END;
$function$;

COMMENT ON FUNCTION public.novatrade_provisioning_create_binding(p_request pg_catalog.text) IS
  'L-02 system-lane role-binding insert bound to a session-created tenant and a session-created membership.';
REVOKE ALL ON FUNCTION public.novatrade_provisioning_create_binding(pg_catalog.text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.novatrade_provisioning_create_binding(pg_catalog.text) FROM anon;
REVOKE ALL ON FUNCTION public.novatrade_provisioning_create_binding(pg_catalog.text) FROM authenticated;

CREATE OR REPLACE FUNCTION public.novatrade_provisioning_create_invitation(p_request pg_catalog.text)
RETURNS TABLE(record pg_catalog.jsonb)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $function$
DECLARE
  v_request pg_catalog.jsonb;
  v_id pg_catalog.text;
  v_tenant_id pg_catalog.text;
  v_membership pg_catalog.text;
  v_request_id pg_catalog.text;
  v_kind pg_catalog.text;
  v_role pg_catalog.text;
  v_workspace pg_catalog.text;
  v_identity_hash pg_catalog.text;
  v_policy_version pg_catalog.text;
  v_generation pg_catalog.text;
  v_content_hash pg_catalog.text;
  v_expires pg_catalog.text;
  v_correlation pg_catalog.text;
  v_audit_event pg_catalog.text;
  v_issued pg_catalog.text;
BEGIN
  IF NOT public.novatrade_provisioning_system_lane() THEN RETURN; END IF;
  BEGIN
    v_request := p_request::pg_catalog.jsonb;
  EXCEPTION WHEN OTHERS THEN
    RETURN;
  END;
  v_id := v_request ->> 'id';
  v_tenant_id := v_request ->> 'tenantId';
  v_membership := v_request ->> 'membershipId';
  v_request_id := v_request ->> 'provisioningRequestId';
  v_kind := v_request ->> 'kind';
  v_role := v_request ->> 'role';
  v_workspace := v_request ->> 'workspaceId';
  v_identity_hash := v_request ->> 'expectedIdentityRefHash';
  v_policy_version := v_request ->> 'policyVersion';
  v_generation := v_request ->> 'generation';
  v_content_hash := v_request ->> 'contentHash';
  v_expires := v_request ->> 'expiresAt';
  v_correlation := v_request ->> 'correlationId';
  v_audit_event := v_request ->> 'auditEventId';
  v_issued := v_request ->> 'issuedAt';
  IF v_id IS NULL OR v_id !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
     OR v_tenant_id IS NULL OR v_tenant_id !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
     OR v_membership IS NULL OR v_membership !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
     OR v_kind IS NULL OR v_kind NOT IN ('owner', 'member')
     OR v_role IS NULL OR v_role NOT IN (
       'owner', 'admin', 'strategist_manager', 'researcher',
       'reviewer', 'outreach_operator', 'analyst_read_only')
     OR (v_kind = 'owner' AND v_role <> 'owner')
     OR v_identity_hash IS NULL OR v_identity_hash !~ '^[0-9a-f]{64}$'
     OR v_policy_version IS NULL OR v_policy_version !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{2,63}$'
     OR v_generation IS NULL OR v_generation !~ '^[0-9]+$'
     OR v_content_hash IS NULL OR v_content_hash !~ '^[0-9a-f]{64}$'
     OR v_expires IS NULL OR v_issued IS NULL
     OR v_correlation IS NULL OR v_correlation !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$'
     OR v_audit_event IS NULL OR v_audit_event !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
     OR (v_request_id IS NOT NULL AND v_request_id !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$')
     OR (v_workspace IS NOT NULL AND v_workspace !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$')
     OR NOT public.novatrade_provisioning_session_tenant(v_tenant_id)
  THEN
    RETURN;
  END IF;

  RETURN QUERY
  WITH inserted AS (
    INSERT INTO public.tenant_invitations (
      id, tenant_id, membership_id, provisioning_request_id, kind, role, workspace_id,
      expected_identity_ref_hash, policy_version, generation, content_hash, status,
      delivery_state, issued_at, expires_at, correlation_id, audit_event_id,
      created_at, updated_at
    )
    VALUES (
      v_id::pg_catalog.uuid, v_tenant_id::pg_catalog.uuid, v_membership::pg_catalog.uuid,
      v_request_id::pg_catalog.uuid, v_kind, v_role, v_workspace::pg_catalog.uuid,
      v_identity_hash, v_policy_version, v_generation::pg_catalog.int4, v_content_hash,
      'issued', 'queued', v_issued::pg_catalog.timestamptz, v_expires::pg_catalog.timestamptz,
      v_correlation, v_audit_event::pg_catalog.uuid,
      v_issued::pg_catalog.timestamptz, v_issued::pg_catalog.timestamptz
    )
    RETURNING *
  )
  SELECT pg_catalog.jsonb_build_object(
    'id', row_.id,
    'tenantId', row_.tenant_id,
    'membershipId', row_.membership_id,
    'provisioningRequestId', row_.provisioning_request_id,
    'kind', row_.kind,
    'role', row_.role,
    'workspaceId', row_.workspace_id,
    'expectedIdentityRefHash', row_.expected_identity_ref_hash,
    'policyVersion', row_.policy_version,
    'generation', row_.generation,
    'contentHash', row_.content_hash,
    'status', row_.status,
    'deliveryState', row_.delivery_state,
    'deliveryAdapter', row_.delivery_adapter,
    'deliveryRefHash', row_.delivery_ref_hash,
    'deliveryDetail', row_.delivery_detail,
    'issuedAt', pg_catalog.to_char(row_.issued_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
    'expiresAt', pg_catalog.to_char(row_.expires_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
    'acceptedAt', NULL,
    'acceptedAuthIdentityId', NULL,
    'revokedAt', NULL,
    'revokedReasonCode', NULL,
    'supersededByInvitationId', NULL,
    'correlationId', row_.correlation_id,
    'auditEventId', row_.audit_event_id,
    'createdAt', pg_catalog.to_char(row_.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
    'updatedAt', pg_catalog.to_char(row_.updated_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
  )
  FROM inserted AS row_;
END;
$function$;

COMMENT ON FUNCTION public.novatrade_provisioning_create_invitation(p_request pg_catalog.text) IS
  'L-02 system-lane invitation insert bound to a session-created provisioning tenant; the pending-membership guard also fires.';
REVOKE ALL ON FUNCTION public.novatrade_provisioning_create_invitation(pg_catalog.text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.novatrade_provisioning_create_invitation(pg_catalog.text) FROM anon;
REVOKE ALL ON FUNCTION public.novatrade_provisioning_create_invitation(pg_catalog.text) FROM authenticated;

CREATE OR REPLACE FUNCTION public.novatrade_provisioning_audit_append(p_request pg_catalog.text)
RETURNS TABLE(recorded boolean)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $function$
DECLARE
  v_request pg_catalog.jsonb;
  v_event pg_catalog.jsonb;
  v_event_id pg_catalog.text;
  v_event_type pg_catalog.text;
  v_entity_type pg_catalog.text;
  v_entity_id pg_catalog.text;
  v_tenant_id pg_catalog.text;
  v_invitation_id pg_catalog.text;
  v_correlation pg_catalog.text;
  v_actor_identity pg_catalog.text;
  v_actor_layer pg_catalog.text;
BEGIN
  IF NOT public.novatrade_provisioning_system_lane() THEN
    RETURN QUERY SELECT false;
    RETURN;
  END IF;
  BEGIN
    v_request := p_request::pg_catalog.jsonb;
  EXCEPTION WHEN OTHERS THEN
    RETURN QUERY SELECT false;
    RETURN;
  END;
  v_event := v_request -> 'event';
  IF v_event IS NULL OR pg_catalog.jsonb_typeof(v_event) <> 'object' THEN
    RETURN QUERY SELECT false;
    RETURN;
  END IF;
  v_event_id := v_event ->> 'eventId';
  v_event_type := v_event ->> 'eventType';
  v_entity_type := v_request ->> 'entityType';
  v_entity_id := v_request ->> 'entityId';
  v_tenant_id := v_event ->> 'tenantId';
  v_invitation_id := v_event ->> 'invitationId';
  v_correlation := v_event ->> 'correlationId';
  v_actor_identity := v_event ->> 'actorIdentityId';
  v_actor_layer := v_event ->> 'actorLayer';
  IF v_event_id IS NULL OR v_event_id !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
     OR v_event_type IS NULL OR v_event_type !~ '^[a-z][a-z0-9._-]{2,79}$'
     OR v_actor_layer IS NULL OR v_actor_layer <> 'system'
     OR v_entity_type IS NULL OR v_entity_type NOT IN ('tenant', 'tenant_invitation')
     OR v_entity_id IS NULL OR v_entity_id !~ '^[A-Za-z0-9][A-Za-z0-9._:/-]{0,255}$'
     OR v_tenant_id IS NULL OR v_tenant_id !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
     OR v_correlation IS NULL OR v_correlation !~ '^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$'
     OR v_actor_identity IS NULL OR v_actor_identity !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
  THEN
    RETURN QUERY SELECT false;
    RETURN;
  END IF;

  -- The audited tenant/invitation must be one this transaction wrote:
  -- a session-created tenant (foundation event) or an invitation whose row
  -- this transaction touched (delivery marking).
  IF NOT (
    public.novatrade_provisioning_session_tenant(v_tenant_id)
    OR (
      v_invitation_id IS NOT NULL
      AND v_invitation_id ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
      AND EXISTS (
        SELECT 1
        FROM public.tenant_invitations AS invitation
        WHERE invitation.tenant_id = v_tenant_id::pg_catalog.uuid
          AND invitation.id = v_invitation_id::pg_catalog.uuid
          AND invitation.xmin::pg_catalog.text::pg_catalog.int8
              = pg_catalog.pg_current_xact_id()::pg_catalog.text::pg_catalog.int8
      )
    )
  ) THEN
    RETURN QUERY SELECT false;
    RETURN;
  END IF;

  INSERT INTO public.audit_logs (
    id, action, entity_type, entity_id, metadata, scope_kind, tenant_id, workspace_id,
    correlation_id, actor_auth_identity_id, actor_membership_id, actor_launch_role,
    actor_role_binding_id, actor_layer
  )
  VALUES (
    v_event_id::pg_catalog.uuid, v_event_type, v_entity_type, v_entity_id,
    v_event, 'platform', NULL, NULL, v_correlation, v_actor_identity::pg_catalog.uuid,
    NULL, NULL, NULL, 'system'
  );
  RETURN QUERY SELECT true;
END;
$function$;

COMMENT ON FUNCTION public.novatrade_provisioning_audit_append(p_request pg_catalog.text) IS
  'L-02 system-lane append of a platform-scope system audit row; the audited tenant/invitation must be one this transaction wrote.';
REVOKE ALL ON FUNCTION public.novatrade_provisioning_audit_append(pg_catalog.text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.novatrade_provisioning_audit_append(pg_catalog.text) FROM anon;
REVOKE ALL ON FUNCTION public.novatrade_provisioning_audit_append(pg_catalog.text) FROM authenticated;

CREATE OR REPLACE FUNCTION public.novatrade_invitation_delivery_mark(p_request pg_catalog.text)
RETURNS TABLE(marked boolean, record pg_catalog.jsonb)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $function$
DECLARE
  v_request pg_catalog.jsonb;
  v_tenant_id pg_catalog.text;
  v_invitation_id pg_catalog.text;
  v_state pg_catalog.text;
  v_adapter pg_catalog.text;
  v_ref_hash pg_catalog.text;
  v_detail pg_catalog.text;
BEGIN
  IF NOT public.novatrade_provisioning_system_lane() THEN
    RETURN QUERY SELECT false, NULL::pg_catalog.jsonb;
    RETURN;
  END IF;
  BEGIN
    v_request := p_request::pg_catalog.jsonb;
  EXCEPTION WHEN OTHERS THEN
    RETURN QUERY SELECT false, NULL::pg_catalog.jsonb;
    RETURN;
  END;
  v_tenant_id := v_request ->> 'tenantId';
  v_invitation_id := v_request ->> 'invitationId';
  v_state := v_request ->> 'deliveryState';
  v_adapter := v_request ->> 'deliveryAdapter';
  v_ref_hash := v_request ->> 'deliveryRefHash';
  v_detail := v_request ->> 'deliveryDetail';
  IF v_tenant_id IS NULL OR v_tenant_id !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
     OR v_invitation_id IS NULL OR v_invitation_id !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
     OR v_state IS NULL OR v_state NOT IN ('delivered', 'delivery_failed')
     OR v_adapter IS NULL OR v_adapter !~ '^[a-z0-9][a-z0-9._-]{1,79}$'
     OR (v_ref_hash IS NOT NULL AND v_ref_hash !~ '^[0-9a-f]{64}$')
     OR (v_detail IS NOT NULL AND (pg_catalog.length(v_detail) < 1 OR pg_catalog.length(v_detail) > 240))
  THEN
    RETURN QUERY SELECT false, NULL::pg_catalog.jsonb;
    RETURN;
  END IF;

  RETURN QUERY
  WITH updated AS (
    UPDATE public.tenant_invitations AS invitation
    SET delivery_state = v_state,
        delivery_adapter = v_adapter,
        delivery_ref_hash = v_ref_hash,
        delivery_detail = v_detail
    WHERE invitation.tenant_id = v_tenant_id::pg_catalog.uuid
      AND invitation.id = v_invitation_id::pg_catalog.uuid
      AND invitation.status = 'issued'
      AND invitation.delivery_state IN ('queued', 'delivery_failed')
    RETURNING *
  )
  SELECT true, pg_catalog.jsonb_build_object(
    'id', row_.id,
    'tenantId', row_.tenant_id,
    'membershipId', row_.membership_id,
    'provisioningRequestId', row_.provisioning_request_id,
    'kind', row_.kind,
    'role', row_.role,
    'workspaceId', row_.workspace_id,
    'expectedIdentityRefHash', row_.expected_identity_ref_hash,
    'policyVersion', row_.policy_version,
    'generation', row_.generation,
    'contentHash', row_.content_hash,
    'status', row_.status,
    'deliveryState', row_.delivery_state,
    'deliveryAdapter', row_.delivery_adapter,
    'deliveryRefHash', row_.delivery_ref_hash,
    'deliveryDetail', row_.delivery_detail,
    'issuedAt', pg_catalog.to_char(row_.issued_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
    'expiresAt', pg_catalog.to_char(row_.expires_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
    'acceptedAt', pg_catalog.to_char(row_.accepted_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
    'acceptedAuthIdentityId', row_.accepted_auth_identity_id,
    'revokedAt', pg_catalog.to_char(row_.revoked_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
    'revokedReasonCode', row_.revoked_reason_code,
    'supersededByInvitationId', row_.superseded_by_invitation_id,
    'correlationId', row_.correlation_id,
    'auditEventId', row_.audit_event_id,
    'createdAt', pg_catalog.to_char(row_.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
    'updatedAt', pg_catalog.to_char(row_.updated_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
  )
  FROM updated AS row_;

  IF NOT FOUND THEN
    RETURN QUERY SELECT false, NULL::pg_catalog.jsonb;
  END IF;
END;
$function$;

COMMENT ON FUNCTION public.novatrade_invitation_delivery_mark(p_request pg_catalog.text) IS
  'L-02 system-lane delivery marking on a live invitation; the compare-and-set matches the canonical recordInvitationDelivery.';
REVOKE ALL ON FUNCTION public.novatrade_invitation_delivery_mark(pg_catalog.text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.novatrade_invitation_delivery_mark(pg_catalog.text) FROM anon;
REVOKE ALL ON FUNCTION public.novatrade_invitation_delivery_mark(pg_catalog.text) FROM authenticated;
