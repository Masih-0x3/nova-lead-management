-- L-02: Postgres write path for tenant feature-policy changes.
--
-- Foundation tables deny every member-context write (the T-027
-- deny_all_other_verbs policies), so the restricted runtime role can never
-- UPDATE tenant_policies or INSERT audit_logs directly. The designed path is
-- this SECURITY DEFINER function: it validates the transaction-local member
-- GUC context installed by withTenantDbContext (the same
-- novatrade_rls_member_context() the RLS policies use), requires tenant-wide
-- owner/admin authority, then applies the version-CAS policy update and the
-- member-layer audit row atomically. The audit trigger independently
-- re-validates the server-derived context the function copies from the GUCs.
--
-- Every authorization/context failure returns a single 'denied' outcome row
-- instead of raising, so the function stays non-enumerating for callers that
-- hold only EXECUTE. Write-time failures (guard trigger, constraints)
-- deliberately propagate so the statement aborts and the CAS update rolls
-- back with the audit insert.

CREATE OR REPLACE FUNCTION public.novatrade_apply_tenant_feature_policy_change(
  p_policy_field pg_catalog.text,
  p_enabled pg_catalog.bool,
  p_expected_version pg_catalog.int4,
  p_audit_metadata pg_catalog.text
)
RETURNS TABLE (
  outcome pg_catalog.text,
  policy_version pg_catalog.int4
)
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
DECLARE
  v_tenant_id pg_catalog.text := coalesce(pg_catalog.current_setting('app.tenant_id', true), '');
  v_workspace_id pg_catalog.text := coalesce(pg_catalog.current_setting('app.workspace_id', true), '');
  v_actor_id pg_catalog.text := coalesce(pg_catalog.current_setting('app.actor_id', true), '');
  v_membership_id pg_catalog.text := coalesce(pg_catalog.current_setting('app.membership_id', true), '');
  v_role pg_catalog.text := coalesce(pg_catalog.current_setting('app.role', true), '');
  v_binding_id pg_catalog.text := coalesce(pg_catalog.current_setting('app.role_binding_id', true), '');
  v_correlation_id pg_catalog.text := coalesce(pg_catalog.current_setting('app.correlation_id', true), '');
  v_column pg_catalog.text;
  v_current_version pg_catalog.int4;
  v_updated pg_catalog.int4;
BEGIN
  -- The member context is validated by the same helper the RLS policies use:
  -- an active tenant, the session workspace (empty here) belonging to it, a
  -- live membership matching tenant + actor identity, and a current role
  -- binding matching membership + role. Tenant policy changes additionally
  -- require a tenant-wide session (no workspace scope), a tenant-wide
  -- membership, and the feature:manage capability the permission matrix
  -- reserves for owner and admin.
  IF NOT public.novatrade_rls_member_context()
     OR v_workspace_id <> ''
     OR v_role NOT IN ('owner', 'admin')
     OR NOT EXISTS (
       SELECT 1 FROM public.tenant_memberships AS membership
       WHERE membership.tenant_id::pg_catalog.text = v_tenant_id
         AND membership.id::pg_catalog.text = v_membership_id
         AND membership.workspace_id IS NULL
     )
  THEN
    RETURN QUERY SELECT 'denied'::pg_catalog.text, NULL::pg_catalog.int4;
    RETURN;
  END IF;

  -- The whitelist deliberately excludes autonomousSendEnabled: the canonical
  -- service makes autonomous send unchangeable (AUTONOMOUS_SEND_FORBIDDEN),
  -- and the runtime role holds EXECUTE on this function, so the database
  -- boundary must not offer a bypass around the service-level prohibition.
  v_column := CASE p_policy_field
    WHEN 'aiProcessingEnabled' THEN 'ai_processing_enabled'
    WHEN 'sourceResearchEnabled' THEN 'source_research_enabled'
    WHEN 'contactResearchEnabled' THEN 'contact_research_enabled'
    WHEN 'outreachDraftingEnabled' THEN 'outreach_drafting_enabled'
    WHEN 'copyExportEnabled' THEN 'copy_export_enabled'
    ELSE NULL
  END;
  IF v_column IS NULL OR p_enabled IS NULL OR p_expected_version IS NULL THEN
    RETURN QUERY SELECT 'invalid_field'::pg_catalog.text, NULL::pg_catalog.int4;
    RETURN;
  END IF;

  SELECT policy.version INTO v_current_version
  FROM public.tenant_policies AS policy
  WHERE policy.tenant_id::pg_catalog.text = v_tenant_id;
  IF NOT FOUND THEN
    RETURN QUERY SELECT 'policy_missing'::pg_catalog.text, NULL::pg_catalog.int4;
    RETURN;
  END IF;
  IF v_current_version <> p_expected_version THEN
    RETURN QUERY SELECT 'version_conflict'::pg_catalog.text, v_current_version;
    RETURN;
  END IF;

  EXECUTE pg_catalog.format(
    'UPDATE public.tenant_policies
        SET %I = $1, version = version + 1, updated_at = pg_catalog.statement_timestamp()
      WHERE tenant_id::text = $2 AND version = $3',
    v_column
  ) USING p_enabled, v_tenant_id, p_expected_version;
  GET DIAGNOSTICS v_updated = ROW_COUNT;
  IF v_updated <> 1 THEN
    RETURN QUERY SELECT 'version_conflict'::pg_catalog.text, v_current_version;
    RETURN;
  END IF;

  -- The append-only guard trigger re-validates every field below; a context
  -- mismatch raises and aborts the whole statement, so a policy change can
  -- never land without its audit row.
  INSERT INTO public.audit_logs (
    id, action, entity_type, entity_id, metadata, scope_kind,
    tenant_id, workspace_id, correlation_id,
    actor_auth_identity_id, actor_membership_id,
    actor_launch_role, actor_role_binding_id, actor_layer
  ) VALUES (
    pg_catalog.gen_random_uuid()::pg_catalog.text,
    'tenant_feature_policy_changed',
    'tenant',
    v_tenant_id,
    p_audit_metadata::pg_catalog.jsonb,
    'tenant',
    v_tenant_id::pg_catalog.uuid,
    NULL,
    v_correlation_id,
    v_actor_id::pg_catalog.uuid,
    v_membership_id::pg_catalog.uuid,
    v_role,
    v_binding_id::pg_catalog.uuid,
    'member'
  );

  RETURN QUERY SELECT 'applied'::pg_catalog.text, v_current_version + 1;
END;
$$;

COMMENT ON FUNCTION public.novatrade_apply_tenant_feature_policy_change(pg_catalog.text, pg_catalog.bool, pg_catalog.int4, pg_catalog.text) IS
  'L-02 tenant feature-policy write path: validates the withTenantDbContext member GUC context (tenant-wide owner/admin), CAS-updates tenant_policies, and appends the member-layer audit row atomically. Denials return outcome rows; write failures abort atomically.';

REVOKE ALL ON FUNCTION public.novatrade_apply_tenant_feature_policy_change(pg_catalog.text, pg_catalog.bool, pg_catalog.int4, pg_catalog.text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.novatrade_apply_tenant_feature_policy_change(pg_catalog.text, pg_catalog.bool, pg_catalog.int4, pg_catalog.text) FROM anon;
REVOKE ALL ON FUNCTION public.novatrade_apply_tenant_feature_policy_change(pg_catalog.text, pg_catalog.bool, pg_catalog.int4, pg_catalog.text) FROM authenticated;
