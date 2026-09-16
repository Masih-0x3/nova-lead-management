-- L-02: Postgres write path for tenant retention-policy changes.
--
-- Same design as novatrade_apply_tenant_feature_policy_change: foundation
-- tables deny every member-context write (the T-027 deny_all_other_verbs
-- policies), so the restricted runtime role can never UPDATE tenant_policies
-- or INSERT audit_logs directly. This SECURITY DEFINER function validates
-- the transaction-local member GUC context installed by withTenantDbContext
-- (the same novatrade_rls_member_context() the RLS policies use), requires
-- tenant-wide owner/admin authority (the tenant:manage capability), then
-- applies the version-CAS policy update and the member-layer audit row
-- atomically. The audit trigger independently re-validates the
-- server-derived context the function copies from the GUCs.
--
-- Each retention knob carries an int 1..max contract in the canonical
-- tenantPolicySchema; those maxima are mirrored here because the runtime
-- role holds EXECUTE — a caller bypassing the TypeScript service must not
-- be able to set out-of-contract retention periods.
--
-- Every authorization/context failure returns a single 'denied' outcome row
-- instead of raising, so the function stays non-enumerating for callers
-- that hold only EXECUTE. Write-time failures (guard trigger, constraints)
-- deliberately propagate so the statement aborts and the CAS update rolls
-- back with the audit insert.

CREATE OR REPLACE FUNCTION public.novatrade_apply_tenant_retention_policy_change(
  p_policy_field pg_catalog.text,
  p_days pg_catalog.int4,
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
  v_max_days pg_catalog.int4;
  v_current_version pg_catalog.int4;
  v_updated pg_catalog.int4;
BEGIN
  -- The member context is validated by the same helper the RLS policies use:
  -- an active tenant, the session workspace (empty here) belonging to it, a
  -- live membership matching tenant + actor identity, and a current role
  -- binding matching membership + role. Retention policy changes additionally
  -- require a tenant-wide session (no workspace scope), a tenant-wide
  -- membership, and the tenant:manage capability the permission matrix
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

  SELECT knobs.sql_column, knobs.max_days INTO v_column, v_max_days
  FROM (VALUES
    ('exportRetentionDays',         'export_retention_days',          7),
    ('operationalLogRetentionDays', 'operational_log_retention_days', 30),
    ('rawSourceRetentionDays',      'raw_source_retention_days',      180),
    ('contactFreshnessDays',        'contact_freshness_days',         180),
    ('primaryDeleteWithinDays',     'primary_delete_within_days',     30),
    ('backupExpireWithinDays',      'backup_expire_within_days',      35)
  ) AS knobs(field_name, sql_column, max_days)
  WHERE knobs.field_name = p_policy_field;

  IF v_column IS NULL OR p_days IS NULL OR p_expected_version IS NULL
     OR p_days < 1 OR p_days > v_max_days THEN
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
  ) USING p_days, v_tenant_id, p_expected_version;
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
    'tenant_retention_policy_changed',
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

COMMENT ON FUNCTION public.novatrade_apply_tenant_retention_policy_change(pg_catalog.text, pg_catalog.int4, pg_catalog.int4, pg_catalog.text) IS
  'L-02 tenant retention-policy write path: validates the withTenantDbContext member GUC context (tenant-wide owner/admin), CAS-updates tenant_policies with the schema-mirrored per-knob day bounds, and appends the member-layer audit row atomically. Denials return outcome rows; write failures abort atomically.';

REVOKE ALL ON FUNCTION public.novatrade_apply_tenant_retention_policy_change(pg_catalog.text, pg_catalog.int4, pg_catalog.int4, pg_catalog.text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.novatrade_apply_tenant_retention_policy_change(pg_catalog.text, pg_catalog.int4, pg_catalog.int4, pg_catalog.text) FROM anon;
REVOKE ALL ON FUNCTION public.novatrade_apply_tenant_retention_policy_change(pg_catalog.text, pg_catalog.int4, pg_catalog.int4, pg_catalog.text) FROM authenticated;
