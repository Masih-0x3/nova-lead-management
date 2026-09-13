-- T-040: tenant invitation operations — member issue, recipient acceptance,
-- and operator reissue/revoke/status on the zero-policy tenant_invitations
-- and tenant_invitation_journal tables.
--
-- Three caller lanes share one surface:
--   * member lane   — issue runs under an accepted member context installed
--                     by withTenantDbContext; the function re-derives actor
--                     authority from the GUC set, never from payload claims.
--   * identity lane — accept runs context-free; the durable invitation row is
--                     the capability and the CAS binds recipient hash,
--                     expiry, and content hash atomically. Post-finalize
--                     writes are bound to an invitation accepted in the same
--                     transaction (xmin binding), so no function can activate
--                     a membership without a real same-tx finalize.
--   * system lane   — operator reissue/revoke/status run context-free; the
--                     operator claim is payload-carried exactly like the
--                     provisioning lane.
--
-- All functions take pg_catalog.text payloads parsed to jsonb internally —
-- never a jsonb parameter: postgres.js serializes a JS string bound to a
-- jsonb position as a jsonb string scalar (double-encoded), so every ->>
-- extractor would see NULL.

CREATE OR REPLACE FUNCTION public.novatrade_invitation_context_free()
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
     AND coalesce(pg_catalog.current_setting('app.role_binding_id', true), '') = ''
     AND coalesce(pg_catalog.current_setting('app.support_grant_id', true), '') = ''
     AND coalesce(pg_catalog.current_setting('app.worker_name', true), '') = '';
END;
$function$;

COMMENT ON FUNCTION public.novatrade_invitation_context_free() IS
  'Internal: true only while no member/worker/support context GUC is installed. The invitation identity/system lanes are context-free by design.';
REVOKE ALL ON FUNCTION public.novatrade_invitation_context_free() FROM PUBLIC;

CREATE OR REPLACE FUNCTION public.novatrade_invitation_lane(p_tenant_id pg_catalog.text)
RETURNS boolean
LANGUAGE plpgsql
STABLE
SET search_path = pg_catalog, public
AS $function$
BEGIN
  -- Context-free lane: no GUCs at all.
  IF public.novatrade_invitation_context_free() THEN
    RETURN true;
  END IF;
  -- Member lane: a fully accepted member context scoped to the same tenant.
  RETURN public.novatrade_rls_member_context()
     AND pg_catalog.current_setting('app.tenant_id', true) = p_tenant_id;
END;
$function$;

COMMENT ON FUNCTION public.novatrade_invitation_lane(pg_catalog.text) IS
  'Internal: true inside either invitation lane — context-free, or an accepted member context bound to the named tenant.';
REVOKE ALL ON FUNCTION public.novatrade_invitation_lane(pg_catalog.text) FROM PUBLIC;

CREATE OR REPLACE FUNCTION public.novatrade_invitation_json(p_row public.tenant_invitations)
RETURNS pg_catalog.jsonb
LANGUAGE sql
STABLE
SET search_path = pg_catalog, public
AS $function$
  SELECT pg_catalog.jsonb_build_object(
    'id', p_row.id,
    'tenantId', p_row.tenant_id,
    'membershipId', p_row.membership_id,
    'provisioningRequestId', p_row.provisioning_request_id,
    'kind', p_row.kind,
    'role', p_row.role,
    'workspaceId', p_row.workspace_id,
    'expectedIdentityRefHash', p_row.expected_identity_ref_hash,
    'policyVersion', p_row.policy_version,
    'generation', p_row.generation,
    'contentHash', p_row.content_hash,
    'status', p_row.status,
    'deliveryState', p_row.delivery_state,
    'deliveryAdapter', p_row.delivery_adapter,
    'deliveryRefHash', p_row.delivery_ref_hash,
    'deliveryDetail', p_row.delivery_detail,
    'issuedAt', pg_catalog.to_char(p_row.issued_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
    'expiresAt', pg_catalog.to_char(p_row.expires_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
    'acceptedAt', pg_catalog.to_char(p_row.accepted_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
    'acceptedAuthIdentityId', p_row.accepted_auth_identity_id,
    'revokedAt', pg_catalog.to_char(p_row.revoked_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
    'revokedReasonCode', p_row.revoked_reason_code,
    'supersededByInvitationId', p_row.superseded_by_invitation_id,
    'correlationId', p_row.correlation_id,
    'auditEventId', p_row.audit_event_id,
    'createdAt', pg_catalog.to_char(p_row.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
    'updatedAt', pg_catalog.to_char(p_row.updated_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
  );
$function$;

COMMENT ON FUNCTION public.novatrade_invitation_json(public.tenant_invitations) IS
  'Internal: renders a tenant_invitations row in the canonical camelCase domain shape.';
REVOKE ALL ON FUNCTION public.novatrade_invitation_json(public.tenant_invitations) FROM PUBLIC;

CREATE OR REPLACE FUNCTION public.novatrade_invitation_accept_ctx(
  p_tenant_id pg_catalog.text,
  p_membership_id pg_catalog.text
)
RETURNS boolean
LANGUAGE plpgsql
STABLE
SET search_path = pg_catalog, public
AS $function$
BEGIN
  -- An invitation row CASed to accepted by this transaction is the authority
  -- for every post-finalize write bound to its invited membership.
  RETURN public.novatrade_invitation_context_free()
     AND EXISTS (
       SELECT 1
       FROM public.tenant_invitations AS invitation
       WHERE invitation.tenant_id = p_tenant_id::pg_catalog.uuid
         AND invitation.membership_id = p_membership_id::pg_catalog.uuid
         AND invitation.status = 'accepted'
         AND invitation.xmin::pg_catalog.text::pg_catalog.int8
             = pg_catalog.pg_current_xact_id()::pg_catalog.text::pg_catalog.int8
     );
END;
$function$;

COMMENT ON FUNCTION public.novatrade_invitation_accept_ctx(pg_catalog.text, pg_catalog.text) IS
  'Internal: true when an invitation for the named membership was finalized to accepted by the current transaction — the post-finalize write binding.';
REVOKE ALL ON FUNCTION public.novatrade_invitation_accept_ctx(pg_catalog.text, pg_catalog.text) FROM PUBLIC;

-- ---------------------------------------------------------------------------
-- Reads. Every read is lane-gated: context-free, or an accepted member
-- context whose tenant matches the row's tenant. Definer reads bypass the
-- zero-policy/RLS posture; lane refusal returns NULL so a denied read is
-- indistinguishable from an absent row.
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.novatrade_invitation_read(p_request pg_catalog.text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $function$
DECLARE
  v_request pg_catalog.jsonb;
  v_invitation_id pg_catalog.text;
  v_row public.tenant_invitations;
BEGIN
  BEGIN
    v_request := p_request::pg_catalog.jsonb;
  EXCEPTION WHEN OTHERS THEN
    RETURN NULL;
  END;
  v_invitation_id := v_request ->> 'invitationId';
  IF v_invitation_id IS NULL OR v_invitation_id !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN
    RETURN NULL;
  END IF;

  SELECT * INTO v_row
  FROM public.tenant_invitations AS invitation
  WHERE invitation.id = v_invitation_id::pg_catalog.uuid;

  IF NOT FOUND OR NOT public.novatrade_invitation_lane(v_row.tenant_id::pg_catalog.text) THEN
    RETURN NULL;
  END IF;
  RETURN public.novatrade_invitation_json(v_row);
END;
$function$;

COMMENT ON FUNCTION public.novatrade_invitation_read(pg_catalog.text) IS
  'L-02 lane-gated invitation read by id; the canonical getInvitationById. NULL when absent or outside the caller lane.';
REVOKE ALL ON FUNCTION public.novatrade_invitation_read(pg_catalog.text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.novatrade_invitation_read(pg_catalog.text) FROM anon;
REVOKE ALL ON FUNCTION public.novatrade_invitation_read(pg_catalog.text) FROM authenticated;

CREATE OR REPLACE FUNCTION public.novatrade_invitation_live_read(p_request pg_catalog.text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $function$
DECLARE
  v_request pg_catalog.jsonb;
  v_tenant_id pg_catalog.text;
  v_membership_id pg_catalog.text;
  v_row public.tenant_invitations;
BEGIN
  BEGIN
    v_request := p_request::pg_catalog.jsonb;
  EXCEPTION WHEN OTHERS THEN
    RETURN NULL;
  END;
  v_tenant_id := v_request ->> 'tenantId';
  v_membership_id := v_request ->> 'membershipId';
  IF v_tenant_id IS NULL OR v_tenant_id !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
     OR v_membership_id IS NULL OR v_membership_id !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
     OR NOT public.novatrade_invitation_lane(v_tenant_id) THEN
    RETURN NULL;
  END IF;

  SELECT * INTO v_row
  FROM public.tenant_invitations AS invitation
  WHERE invitation.tenant_id = v_tenant_id::pg_catalog.uuid
    AND invitation.membership_id = v_membership_id::pg_catalog.uuid
    AND invitation.status = 'issued'
  ORDER BY invitation.generation DESC, invitation.id DESC
  LIMIT 1;

  IF NOT FOUND THEN RETURN NULL; END IF;
  RETURN public.novatrade_invitation_json(v_row);
END;
$function$;

COMMENT ON FUNCTION public.novatrade_invitation_live_read(pg_catalog.text) IS
  'L-02 lane-gated live (issued) invitation read for a membership; the canonical getLiveInvitationForMembership.';
REVOKE ALL ON FUNCTION public.novatrade_invitation_live_read(pg_catalog.text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.novatrade_invitation_live_read(pg_catalog.text) FROM anon;
REVOKE ALL ON FUNCTION public.novatrade_invitation_live_read(pg_catalog.text) FROM authenticated;

CREATE OR REPLACE FUNCTION public.novatrade_invitation_tenant_read(p_request pg_catalog.text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $function$
DECLARE
  v_request pg_catalog.jsonb;
  v_tenant_id pg_catalog.text;
  v_row public.tenants;
BEGIN
  BEGIN
    v_request := p_request::pg_catalog.jsonb;
  EXCEPTION WHEN OTHERS THEN
    RETURN NULL;
  END;
  v_tenant_id := v_request ->> 'tenantId';
  IF v_tenant_id IS NULL OR v_tenant_id !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
     OR NOT public.novatrade_invitation_lane(v_tenant_id) THEN
    RETURN NULL;
  END IF;

  SELECT * INTO v_row
  FROM public.tenants AS tenant
  WHERE tenant.id = v_tenant_id::pg_catalog.uuid;

  IF NOT FOUND THEN RETURN NULL; END IF;
  RETURN pg_catalog.jsonb_build_object(
    'id', v_row.id,
    'slug', v_row.slug,
    'name', v_row.name,
    'status', v_row.status,
    'locale', v_row.locale,
    'timezone', v_row.timezone,
    'created_at', pg_catalog.to_char(v_row.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
    'updated_at', pg_catalog.to_char(v_row.updated_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
  );
END;
$function$;

COMMENT ON FUNCTION public.novatrade_invitation_tenant_read(pg_catalog.text) IS
  'L-02 lane-gated tenant read for the invitation service; snake_case row shape for the repository mapper.';
REVOKE ALL ON FUNCTION public.novatrade_invitation_tenant_read(pg_catalog.text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.novatrade_invitation_tenant_read(pg_catalog.text) FROM anon;
REVOKE ALL ON FUNCTION public.novatrade_invitation_tenant_read(pg_catalog.text) FROM authenticated;

CREATE OR REPLACE FUNCTION public.novatrade_invitation_workspace_read(p_request pg_catalog.text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $function$
DECLARE
  v_request pg_catalog.jsonb;
  v_tenant_id pg_catalog.text;
  v_workspace_id pg_catalog.text;
  v_row public.workspaces;
BEGIN
  BEGIN
    v_request := p_request::pg_catalog.jsonb;
  EXCEPTION WHEN OTHERS THEN
    RETURN NULL;
  END;
  v_tenant_id := v_request ->> 'tenantId';
  v_workspace_id := v_request ->> 'workspaceId';
  IF v_tenant_id IS NULL OR v_tenant_id !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
     OR v_workspace_id IS NULL OR v_workspace_id !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
     OR NOT public.novatrade_invitation_lane(v_tenant_id) THEN
    RETURN NULL;
  END IF;

  SELECT * INTO v_row
  FROM public.workspaces AS workspace
  WHERE workspace.tenant_id = v_tenant_id::pg_catalog.uuid
    AND workspace.id = v_workspace_id::pg_catalog.uuid;

  IF NOT FOUND THEN RETURN NULL; END IF;
  RETURN pg_catalog.jsonb_build_object(
    'id', v_row.id,
    'tenant_id', v_row.tenant_id,
    'slug', v_row.slug,
    'name', v_row.name,
    'status', v_row.status,
    'created_at', pg_catalog.to_char(v_row.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
    'updated_at', pg_catalog.to_char(v_row.updated_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
  );
END;
$function$;

COMMENT ON FUNCTION public.novatrade_invitation_workspace_read(pg_catalog.text) IS
  'L-02 lane-gated workspace read for the invitation service; snake_case row shape for the repository mapper.';
REVOKE ALL ON FUNCTION public.novatrade_invitation_workspace_read(pg_catalog.text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.novatrade_invitation_workspace_read(pg_catalog.text) FROM anon;
REVOKE ALL ON FUNCTION public.novatrade_invitation_workspace_read(pg_catalog.text) FROM authenticated;

CREATE OR REPLACE FUNCTION public.novatrade_invitation_membership_read(p_request pg_catalog.text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $function$
DECLARE
  v_request pg_catalog.jsonb;
  v_tenant_id pg_catalog.text;
  v_membership_id pg_catalog.text;
  v_row public.tenant_memberships;
BEGIN
  BEGIN
    v_request := p_request::pg_catalog.jsonb;
  EXCEPTION WHEN OTHERS THEN
    RETURN NULL;
  END;
  v_tenant_id := v_request ->> 'tenantId';
  v_membership_id := v_request ->> 'membershipId';
  IF v_tenant_id IS NULL OR v_tenant_id !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
     OR v_membership_id IS NULL OR v_membership_id !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
     OR NOT public.novatrade_invitation_lane(v_tenant_id) THEN
    RETURN NULL;
  END IF;

  SELECT * INTO v_row
  FROM public.tenant_memberships AS membership
  WHERE membership.tenant_id = v_tenant_id::pg_catalog.uuid
    AND membership.id = v_membership_id::pg_catalog.uuid;

  IF NOT FOUND THEN RETURN NULL; END IF;
  RETURN pg_catalog.jsonb_build_object(
    'id', v_row.id,
    'tenant_id', v_row.tenant_id,
    'auth_identity_id', v_row.auth_identity_id,
    'pending_identity_ref_hash', v_row.pending_identity_ref_hash,
    'workspace_id', v_row.workspace_id,
    'status', v_row.status,
    'invited_by_membership_id', v_row.invited_by_membership_id,
    'created_at', pg_catalog.to_char(v_row.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
    'updated_at', pg_catalog.to_char(v_row.updated_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
  );
END;
$function$;

COMMENT ON FUNCTION public.novatrade_invitation_membership_read(pg_catalog.text) IS
  'L-02 lane-gated membership read for the invitation service; snake_case row shape for the repository mapper.';
REVOKE ALL ON FUNCTION public.novatrade_invitation_membership_read(pg_catalog.text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.novatrade_invitation_membership_read(pg_catalog.text) FROM anon;
REVOKE ALL ON FUNCTION public.novatrade_invitation_membership_read(pg_catalog.text) FROM authenticated;

CREATE OR REPLACE FUNCTION public.novatrade_invitation_binding_read(p_request pg_catalog.text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $function$
DECLARE
  v_request pg_catalog.jsonb;
  v_tenant_id pg_catalog.text;
  v_membership_id pg_catalog.text;
  v_row public.tenant_role_bindings;
BEGIN
  BEGIN
    v_request := p_request::pg_catalog.jsonb;
  EXCEPTION WHEN OTHERS THEN
    RETURN NULL;
  END;
  v_tenant_id := v_request ->> 'tenantId';
  v_membership_id := v_request ->> 'membershipId';
  IF v_tenant_id IS NULL OR v_tenant_id !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
     OR v_membership_id IS NULL OR v_membership_id !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
     OR NOT public.novatrade_invitation_lane(v_tenant_id) THEN
    RETURN NULL;
  END IF;

  SELECT * INTO v_row
  FROM public.tenant_role_bindings AS binding
  WHERE binding.tenant_id = v_tenant_id::pg_catalog.uuid
    AND binding.membership_id = v_membership_id::pg_catalog.uuid
    AND binding.revoked_at IS NULL
  ORDER BY binding.valid_from DESC, binding.id DESC
  LIMIT 1;

  IF NOT FOUND THEN RETURN NULL; END IF;
  RETURN pg_catalog.jsonb_build_object(
    'id', v_row.id,
    'tenant_id', v_row.tenant_id,
    'membership_id', v_row.membership_id,
    'role', v_row.role,
    'created_at', pg_catalog.to_char(v_row.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
    'valid_from', pg_catalog.to_char(v_row.valid_from AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
    'revoked_at', pg_catalog.to_char(v_row.revoked_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
    'assigned_by_membership_id', v_row.assigned_by_membership_id,
    'reason_code', v_row.reason_code
  );
END;
$function$;

COMMENT ON FUNCTION public.novatrade_invitation_binding_read(pg_catalog.text) IS
  'L-02 lane-gated current role-binding read for the invitation service; snake_case row shape for the repository mapper.';
REVOKE ALL ON FUNCTION public.novatrade_invitation_binding_read(pg_catalog.text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.novatrade_invitation_binding_read(pg_catalog.text) FROM anon;
REVOKE ALL ON FUNCTION public.novatrade_invitation_binding_read(pg_catalog.text) FROM authenticated;

CREATE OR REPLACE FUNCTION public.novatrade_invitation_policy_read(p_request pg_catalog.text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $function$
DECLARE
  v_request pg_catalog.jsonb;
  v_tenant_id pg_catalog.text;
  v_row public.tenant_policies;
BEGIN
  BEGIN
    v_request := p_request::pg_catalog.jsonb;
  EXCEPTION WHEN OTHERS THEN
    RETURN NULL;
  END;
  v_tenant_id := v_request ->> 'tenantId';
  IF v_tenant_id IS NULL OR v_tenant_id !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
     OR NOT public.novatrade_invitation_lane(v_tenant_id) THEN
    RETURN NULL;
  END IF;

  SELECT * INTO v_row
  FROM public.tenant_policies AS policy
  WHERE policy.tenant_id = v_tenant_id::pg_catalog.uuid
  ORDER BY policy.version DESC, policy.updated_at DESC, policy.id DESC
  LIMIT 1;

  IF NOT FOUND THEN RETURN NULL; END IF;
  RETURN pg_catalog.jsonb_build_object(
    'id', v_row.id,
    'tenant_id', v_row.tenant_id,
    'version', v_row.version,
    'locale', v_row.locale,
    'timezone', v_row.timezone,
    'export_retention_days', v_row.export_retention_days,
    'operational_log_retention_days', v_row.operational_log_retention_days,
    'raw_source_retention_days', v_row.raw_source_retention_days,
    'contact_freshness_days', v_row.contact_freshness_days,
    'primary_delete_within_days', v_row.primary_delete_within_days,
    'backup_expire_within_days', v_row.backup_expire_within_days,
    'tombstone_retention_years', v_row.tombstone_retention_years,
    'active_materials_mode', v_row.active_materials_mode,
    'ai_processing_enabled', v_row.ai_processing_enabled,
    'source_research_enabled', v_row.source_research_enabled,
    'contact_research_enabled', v_row.contact_research_enabled,
    'outreach_drafting_enabled', v_row.outreach_drafting_enabled,
    'copy_export_enabled', v_row.copy_export_enabled,
    'autonomous_send_enabled', v_row.autonomous_send_enabled,
    'require_source_plan_approval', v_row.require_source_plan_approval,
    'require_knowledge_review', v_row.require_knowledge_review,
    'require_icp_review', v_row.require_icp_review,
    'require_lead_play_review', v_row.require_lead_play_review,
    'require_contact_review', v_row.require_contact_review,
    'require_outreach_review', v_row.require_outreach_review,
    'created_at', pg_catalog.to_char(v_row.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
    'updated_at', pg_catalog.to_char(v_row.updated_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
  );
END;
$function$;

COMMENT ON FUNCTION public.novatrade_invitation_policy_read(pg_catalog.text) IS
  'L-02 lane-gated current tenant-policy read for the invitation service; snake_case row shape for the repository mapper.';
REVOKE ALL ON FUNCTION public.novatrade_invitation_policy_read(pg_catalog.text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.novatrade_invitation_policy_read(pg_catalog.text) FROM anon;
REVOKE ALL ON FUNCTION public.novatrade_invitation_policy_read(pg_catalog.text) FROM authenticated;

-- ---------------------------------------------------------------------------
-- Invitation mutation journal. The deferred invitation FK lets a reservation
-- precede its invitation row inside the issuing transaction. Lane-gated like
-- the reads; member-lane callers stay bound to their tenant.
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.novatrade_invitation_journal_find(p_request pg_catalog.text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $function$
DECLARE
  v_request pg_catalog.jsonb;
  v_key pg_catalog.text;
  v_row public.tenant_invitation_journal;
BEGIN
  BEGIN
    v_request := p_request::pg_catalog.jsonb;
  EXCEPTION WHEN OTHERS THEN
    RETURN NULL;
  END;
  v_key := v_request ->> 'idempotencyKeyHash';
  IF v_key IS NULL OR v_key !~ '^[0-9a-f]{64}$' THEN RETURN NULL; END IF;

  SELECT * INTO v_row
  FROM public.tenant_invitation_journal AS journal
  WHERE journal.idempotency_key_hash = v_key;

  IF NOT FOUND OR NOT public.novatrade_invitation_lane(v_row.tenant_id::pg_catalog.text) THEN
    RETURN NULL;
  END IF;

  RETURN pg_catalog.jsonb_build_object(
    'idempotencyKeyHashRef', v_row.idempotency_key_hash,
    'inputHashRef', v_row.input_hash,
    'operation', v_row.operation,
    'tenantId', v_row.tenant_id,
    'invitationId', v_row.invitation_id,
    'state', v_row.status,
    'result', v_row.result_json
  );
END;
$function$;

COMMENT ON FUNCTION public.novatrade_invitation_journal_find(pg_catalog.text) IS
  'L-02 lane-gated invitation journal read by key hash; returns NULL when absent or outside the caller lane.';
REVOKE ALL ON FUNCTION public.novatrade_invitation_journal_find(pg_catalog.text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.novatrade_invitation_journal_find(pg_catalog.text) FROM anon;
REVOKE ALL ON FUNCTION public.novatrade_invitation_journal_find(pg_catalog.text) FROM authenticated;

CREATE OR REPLACE FUNCTION public.novatrade_invitation_journal_reserve(p_request pg_catalog.text)
RETURNS TABLE(outcome pg_catalog.text, record pg_catalog.jsonb)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $function$
DECLARE
  v_request pg_catalog.jsonb;
  v_key pg_catalog.text;
  v_input pg_catalog.text;
  v_operation pg_catalog.text;
  v_tenant_id pg_catalog.text;
  v_invitation_id pg_catalog.text;
  v_row public.tenant_invitation_journal;
BEGIN
  BEGIN
    v_request := p_request::pg_catalog.jsonb;
  EXCEPTION WHEN OTHERS THEN
    RETURN QUERY SELECT 'conflict', NULL::pg_catalog.jsonb;
    RETURN;
  END;
  v_key := v_request ->> 'idempotencyKeyHash';
  v_input := v_request ->> 'inputHash';
  v_operation := v_request ->> 'operation';
  v_tenant_id := v_request ->> 'tenantId';
  v_invitation_id := v_request ->> 'invitationId';
  IF v_key IS NULL OR v_key !~ '^[0-9a-f]{64}$'
     OR v_input IS NULL OR v_input !~ '^[0-9a-f]{64}$'
     OR v_operation IS NULL OR v_operation NOT IN ('issue', 'accept', 'reissue', 'revoke')
     OR v_tenant_id IS NULL OR v_tenant_id !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
     OR v_invitation_id IS NULL OR v_invitation_id !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
     OR NOT public.novatrade_invitation_lane(v_tenant_id) THEN
    RETURN QUERY SELECT 'conflict', NULL::pg_catalog.jsonb;
    RETURN;
  END IF;

  SELECT * INTO v_row
  FROM public.tenant_invitation_journal AS journal
  WHERE journal.idempotency_key_hash = v_key
  FOR UPDATE;

  IF FOUND THEN
    IF v_row.operation <> v_operation
       OR v_row.input_hash <> v_input
       OR v_row.tenant_id <> v_tenant_id::pg_catalog.uuid
       OR v_row.invitation_id <> v_invitation_id::pg_catalog.uuid THEN
      RETURN QUERY SELECT 'conflict', NULL::pg_catalog.jsonb;
      RETURN;
    END IF;
    IF v_row.status = 'completed' THEN
      RETURN QUERY
      SELECT 'completed', pg_catalog.jsonb_build_object(
        'idempotencyKeyHashRef', v_row.idempotency_key_hash,
        'inputHashRef', v_row.input_hash,
        'operation', v_row.operation,
        'tenantId', v_row.tenant_id,
        'invitationId', v_row.invitation_id,
        'state', v_row.status,
        'result', v_row.result_json
      );
      RETURN;
    END IF;
    RETURN QUERY SELECT 'in_progress', NULL::pg_catalog.jsonb;
    RETURN;
  END IF;

  INSERT INTO public.tenant_invitation_journal (
    idempotency_key_hash, input_hash, operation, tenant_id, invitation_id, status
  ) VALUES (
    v_key, v_input, v_operation, v_tenant_id::pg_catalog.uuid,
    v_invitation_id::pg_catalog.uuid, 'reserved'
  );

  RETURN QUERY SELECT 'reserved', NULL::pg_catalog.jsonb;
END;
$function$;

COMMENT ON FUNCTION public.novatrade_invitation_journal_reserve(pg_catalog.text) IS
  'L-02 lane-gated invitation journal reservation; replays completed records, flags in-flight rows, and refuses mismatched keys.';
REVOKE ALL ON FUNCTION public.novatrade_invitation_journal_reserve(pg_catalog.text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.novatrade_invitation_journal_reserve(pg_catalog.text) FROM anon;
REVOKE ALL ON FUNCTION public.novatrade_invitation_journal_reserve(pg_catalog.text) FROM authenticated;

CREATE OR REPLACE FUNCTION public.novatrade_invitation_journal_complete(p_request pg_catalog.text)
RETURNS TABLE(committed boolean)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $function$
DECLARE
  v_request pg_catalog.jsonb;
  v_key pg_catalog.text;
  v_result pg_catalog.jsonb;
  v_row public.tenant_invitation_journal;
BEGIN
  BEGIN
    v_request := p_request::pg_catalog.jsonb;
  EXCEPTION WHEN OTHERS THEN
    RETURN QUERY SELECT false;
    RETURN;
  END;
  v_key := v_request ->> 'idempotencyKeyHash';
  v_result := coalesce(v_request -> 'result', 'null'::pg_catalog.jsonb);
  IF v_key IS NULL OR v_key !~ '^[0-9a-f]{64}$'
     OR v_result = 'null'::pg_catalog.jsonb THEN
    RETURN QUERY SELECT false;
    RETURN;
  END IF;

  SELECT * INTO v_row
  FROM public.tenant_invitation_journal AS journal
  WHERE journal.idempotency_key_hash = v_key
  FOR UPDATE;

  IF NOT FOUND OR v_row.status <> 'reserved'
     OR NOT public.novatrade_invitation_lane(v_row.tenant_id::pg_catalog.text) THEN
    RETURN QUERY SELECT false;
    RETURN;
  END IF;

  UPDATE public.tenant_invitation_journal AS journal
  SET status = 'completed',
      result_json = v_result,
      completed_at = pg_catalog.now()
  WHERE journal.idempotency_key_hash = v_key;

  RETURN QUERY SELECT true;
END;
$function$;

COMMENT ON FUNCTION public.novatrade_invitation_journal_complete(pg_catalog.text) IS
  'L-02 lane-gated invitation journal completion; terminal committed state with the operation result payload.';
REVOKE ALL ON FUNCTION public.novatrade_invitation_journal_complete(pg_catalog.text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.novatrade_invitation_journal_complete(pg_catalog.text) FROM anon;
REVOKE ALL ON FUNCTION public.novatrade_invitation_journal_complete(pg_catalog.text) FROM authenticated;

-- ---------------------------------------------------------------------------
-- Invitation writes.
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.novatrade_invitation_create(p_request pg_catalog.text)
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
  v_member_lane pg_catalog.bool;
BEGIN
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
     OR (v_workspace IS NOT NULL AND v_workspace !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$') THEN
    RETURN;
  END IF;

  -- Lane binding: a member-context issue must come from a live owner/admin of
  -- the same tenant; the context-free lane covers operator reissue.
  v_member_lane := public.novatrade_rls_member_context();
  IF v_member_lane THEN
    IF pg_catalog.current_setting('app.tenant_id', true) <> v_tenant_id
       OR pg_catalog.current_setting('app.role', true) NOT IN ('owner', 'admin') THEN
      RETURN;
    END IF;
  ELSIF NOT public.novatrade_invitation_context_free() THEN
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
  SELECT public.novatrade_invitation_json(row_.*) FROM inserted AS row_;
END;
$function$;

COMMENT ON FUNCTION public.novatrade_invitation_create(pg_catalog.text) IS
  'L-02 dual-lane invitation insert: member lane requires a live owner/admin of the same tenant; context-free covers operator reissue.';
REVOKE ALL ON FUNCTION public.novatrade_invitation_create(pg_catalog.text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.novatrade_invitation_create(pg_catalog.text) FROM anon;
REVOKE ALL ON FUNCTION public.novatrade_invitation_create(pg_catalog.text) FROM authenticated;

CREATE OR REPLACE FUNCTION public.novatrade_invitation_finalize(p_request pg_catalog.text)
RETURNS TABLE(record pg_catalog.jsonb)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $function$
DECLARE
  v_request pg_catalog.jsonb;
  v_tenant_id pg_catalog.text;
  v_invitation_id pg_catalog.text;
  v_content_hash pg_catalog.text;
  v_identity_hash pg_catalog.text;
  v_accepted_at pg_catalog.text;
  v_identity pg_catalog.text;
BEGIN
  -- Identity lane only: the recipient binding is re-checked inside the CAS so
  -- a stale read or a wrong identity can never finalize the row.
  IF NOT public.novatrade_invitation_context_free() THEN RETURN; END IF;
  BEGIN
    v_request := p_request::pg_catalog.jsonb;
  EXCEPTION WHEN OTHERS THEN
    RETURN;
  END;
  v_tenant_id := v_request ->> 'tenantId';
  v_invitation_id := v_request ->> 'invitationId';
  v_content_hash := v_request ->> 'expectedContentHash';
  v_identity_hash := v_request ->> 'expectedIdentityRefHash';
  v_accepted_at := v_request ->> 'acceptedAt';
  v_identity := v_request ->> 'acceptedAuthIdentityId';
  IF v_tenant_id IS NULL OR v_tenant_id !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
     OR v_invitation_id IS NULL OR v_invitation_id !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
     OR v_content_hash IS NULL OR v_content_hash !~ '^[0-9a-f]{64}$'
     OR v_identity_hash IS NULL OR v_identity_hash !~ '^[0-9a-f]{64}$'
     OR v_accepted_at IS NULL
     OR v_identity IS NULL OR v_identity !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN
    RETURN;
  END IF;

  RETURN QUERY
  WITH updated AS (
    UPDATE public.tenant_invitations AS invitation
    SET status = 'accepted',
        accepted_at = v_accepted_at::pg_catalog.timestamptz,
        accepted_auth_identity_id = v_identity::pg_catalog.uuid
    WHERE invitation.tenant_id = v_tenant_id::pg_catalog.uuid
      AND invitation.id = v_invitation_id::pg_catalog.uuid
      AND invitation.status = 'issued'
      AND invitation.expires_at > v_accepted_at::pg_catalog.timestamptz
      AND invitation.content_hash = v_content_hash
      AND invitation.expected_identity_ref_hash = v_identity_hash
    RETURNING *
  )
  SELECT public.novatrade_invitation_json(row_.*) FROM updated AS row_;
END;
$function$;

COMMENT ON FUNCTION public.novatrade_invitation_finalize(pg_catalog.text) IS
  'L-02 identity-lane acceptance CAS: issued→accepted re-checking expiry, content hash, and the recipient hash inside the compare-and-set.';
REVOKE ALL ON FUNCTION public.novatrade_invitation_finalize(pg_catalog.text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.novatrade_invitation_finalize(pg_catalog.text) FROM anon;
REVOKE ALL ON FUNCTION public.novatrade_invitation_finalize(pg_catalog.text) FROM authenticated;

CREATE OR REPLACE FUNCTION public.novatrade_invitation_supersede(p_request pg_catalog.text)
RETURNS TABLE(record pg_catalog.jsonb)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $function$
DECLARE
  v_request pg_catalog.jsonb;
  v_tenant_id pg_catalog.text;
  v_invitation_id pg_catalog.text;
  v_at pg_catalog.text;
  v_reason pg_catalog.text;
  v_replacement pg_catalog.text;
BEGIN
  IF NOT public.novatrade_invitation_context_free() THEN RETURN; END IF;
  BEGIN
    v_request := p_request::pg_catalog.jsonb;
  EXCEPTION WHEN OTHERS THEN
    RETURN;
  END;
  v_tenant_id := v_request ->> 'tenantId';
  v_invitation_id := v_request ->> 'invitationId';
  v_at := v_request ->> 'at';
  v_reason := v_request ->> 'reasonCode';
  v_replacement := v_request ->> 'supersededByInvitationId';
  IF v_tenant_id IS NULL OR v_tenant_id !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
     OR v_invitation_id IS NULL OR v_invitation_id !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
     OR v_at IS NULL
     OR v_reason IS NULL OR v_reason !~ '^[a-z0-9][a-z0-9._-]{2,79}$'
     OR v_replacement IS NULL OR v_replacement !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN
    RETURN;
  END IF;

  RETURN QUERY
  WITH updated AS (
    UPDATE public.tenant_invitations AS invitation
    SET status = 'superseded',
        revoked_at = v_at::pg_catalog.timestamptz,
        revoked_reason_code = v_reason,
        superseded_by_invitation_id = v_replacement::pg_catalog.uuid
    WHERE invitation.tenant_id = v_tenant_id::pg_catalog.uuid
      AND invitation.id = v_invitation_id::pg_catalog.uuid
      AND invitation.status = 'issued'
    RETURNING *
  )
  SELECT public.novatrade_invitation_json(row_.*) FROM updated AS row_;
END;
$function$;

COMMENT ON FUNCTION public.novatrade_invitation_supersede(pg_catalog.text) IS
  'L-02 system-lane issued→superseded CAS naming the replacement invitation; the deferred self-FK resolves at commit.';
REVOKE ALL ON FUNCTION public.novatrade_invitation_supersede(pg_catalog.text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.novatrade_invitation_supersede(pg_catalog.text) FROM anon;
REVOKE ALL ON FUNCTION public.novatrade_invitation_supersede(pg_catalog.text) FROM authenticated;

CREATE OR REPLACE FUNCTION public.novatrade_invitation_revoke(p_request pg_catalog.text)
RETURNS TABLE(record pg_catalog.jsonb)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $function$
DECLARE
  v_request pg_catalog.jsonb;
  v_tenant_id pg_catalog.text;
  v_invitation_id pg_catalog.text;
  v_at pg_catalog.text;
  v_reason pg_catalog.text;
BEGIN
  IF NOT public.novatrade_invitation_context_free() THEN RETURN; END IF;
  BEGIN
    v_request := p_request::pg_catalog.jsonb;
  EXCEPTION WHEN OTHERS THEN
    RETURN;
  END;
  v_tenant_id := v_request ->> 'tenantId';
  v_invitation_id := v_request ->> 'invitationId';
  v_at := v_request ->> 'at';
  v_reason := v_request ->> 'reasonCode';
  IF v_tenant_id IS NULL OR v_tenant_id !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
     OR v_invitation_id IS NULL OR v_invitation_id !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
     OR v_at IS NULL
     OR v_reason IS NULL OR v_reason !~ '^[a-z0-9][a-z0-9._-]{2,79}$' THEN
    RETURN;
  END IF;

  RETURN QUERY
  WITH updated AS (
    UPDATE public.tenant_invitations AS invitation
    SET status = 'revoked',
        revoked_at = v_at::pg_catalog.timestamptz,
        revoked_reason_code = v_reason
    WHERE invitation.tenant_id = v_tenant_id::pg_catalog.uuid
      AND invitation.id = v_invitation_id::pg_catalog.uuid
      AND invitation.status = 'issued'
    RETURNING *
  )
  SELECT public.novatrade_invitation_json(row_.*) FROM updated AS row_;
END;
$function$;

COMMENT ON FUNCTION public.novatrade_invitation_revoke(pg_catalog.text) IS
  'L-02 system-lane issued→revoked CAS; the canonical revokeInvitation write.';
REVOKE ALL ON FUNCTION public.novatrade_invitation_revoke(pg_catalog.text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.novatrade_invitation_revoke(pg_catalog.text) FROM anon;
REVOKE ALL ON FUNCTION public.novatrade_invitation_revoke(pg_catalog.text) FROM authenticated;

CREATE OR REPLACE FUNCTION public.novatrade_invitation_membership_status(p_request pg_catalog.text)
RETURNS TABLE(record pg_catalog.jsonb)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $function$
DECLARE
  v_request pg_catalog.jsonb;
  v_tenant_id pg_catalog.text;
  v_membership_id pg_catalog.text;
  v_status pg_catalog.text;
BEGIN
  -- Identity lane, post-finalize only: the invited membership may activate
  -- (pre-bound identity) or expire (pending identity replaced below).
  BEGIN
    v_request := p_request::pg_catalog.jsonb;
  EXCEPTION WHEN OTHERS THEN
    RETURN;
  END;
  v_tenant_id := v_request ->> 'tenantId';
  v_membership_id := v_request ->> 'membershipId';
  v_status := v_request ->> 'status';
  IF v_tenant_id IS NULL OR v_tenant_id !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
     OR v_membership_id IS NULL OR v_membership_id !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
     OR v_status IS NULL OR v_status NOT IN ('active', 'expired')
     OR NOT public.novatrade_invitation_accept_ctx(v_tenant_id, v_membership_id) THEN
    RETURN;
  END IF;

  RETURN QUERY
  WITH updated AS (
    UPDATE public.tenant_memberships AS membership
    SET status = v_status
    FROM public.tenant_invitations AS invitation
    WHERE membership.tenant_id = v_tenant_id::pg_catalog.uuid
      AND membership.id = v_membership_id::pg_catalog.uuid
      AND invitation.tenant_id = membership.tenant_id
      AND invitation.membership_id = membership.id
      AND invitation.status = 'accepted'
      AND membership.status = 'pending'
      AND (
        (v_status = 'active'
          AND membership.auth_identity_id IS NOT NULL
          AND membership.auth_identity_id = invitation.accepted_auth_identity_id)
        OR (v_status = 'expired' AND membership.auth_identity_id IS NULL)
      )
    RETURNING membership.*
  )
  SELECT pg_catalog.jsonb_build_object(
    'id', row_.id,
    'tenant_id', row_.tenant_id,
    'auth_identity_id', row_.auth_identity_id,
    'pending_identity_ref_hash', row_.pending_identity_ref_hash,
    'workspace_id', row_.workspace_id,
    'status', row_.status,
    'invited_by_membership_id', row_.invited_by_membership_id,
    'created_at', pg_catalog.to_char(row_.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
    'updated_at', pg_catalog.to_char(row_.updated_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
  ) FROM updated AS row_;
END;
$function$;

COMMENT ON FUNCTION public.novatrade_invitation_membership_status(pg_catalog.text) IS
  'L-02 identity-lane invited-membership transition: pending→active only when the row was pre-bound to the accepting identity, pending→expired otherwise. Requires a same-transaction finalize.';
REVOKE ALL ON FUNCTION public.novatrade_invitation_membership_status(pg_catalog.text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.novatrade_invitation_membership_status(pg_catalog.text) FROM anon;
REVOKE ALL ON FUNCTION public.novatrade_invitation_membership_status(pg_catalog.text) FROM authenticated;

CREATE OR REPLACE FUNCTION public.novatrade_invitation_binding_revoke(p_request pg_catalog.text)
RETURNS TABLE(record pg_catalog.jsonb)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $function$
DECLARE
  v_request pg_catalog.jsonb;
  v_tenant_id pg_catalog.text;
  v_membership_id pg_catalog.text;
  v_at pg_catalog.text;
BEGIN
  -- Identity lane, post-finalize: revoke the invited membership's live
  -- binding when its pending membership is being replaced.
  BEGIN
    v_request := p_request::pg_catalog.jsonb;
  EXCEPTION WHEN OTHERS THEN
    RETURN;
  END;
  v_tenant_id := v_request ->> 'tenantId';
  v_membership_id := v_request ->> 'membershipId';
  v_at := v_request ->> 'revokedAt';
  IF v_tenant_id IS NULL OR v_tenant_id !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
     OR v_membership_id IS NULL OR v_membership_id !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
     OR v_at IS NULL
     OR NOT public.novatrade_invitation_accept_ctx(v_tenant_id, v_membership_id) THEN
    RETURN;
  END IF;

  RETURN QUERY
  WITH current_binding AS (
    SELECT binding.id
    FROM public.tenant_role_bindings AS binding
    WHERE binding.tenant_id = v_tenant_id::pg_catalog.uuid
      AND binding.membership_id = v_membership_id::pg_catalog.uuid
      AND binding.revoked_at IS NULL
    ORDER BY binding.valid_from DESC, binding.id DESC
    LIMIT 1
  ), updated AS (
    UPDATE public.tenant_role_bindings AS binding
    SET revoked_at = v_at::pg_catalog.timestamptz
    FROM current_binding
    WHERE binding.tenant_id = v_tenant_id::pg_catalog.uuid
      AND binding.id = current_binding.id
      AND binding.revoked_at IS NULL
    RETURNING binding.*
  )
  SELECT pg_catalog.jsonb_build_object(
    'id', row_.id,
    'tenant_id', row_.tenant_id,
    'membership_id', row_.membership_id,
    'role', row_.role,
    'created_at', pg_catalog.to_char(row_.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
    'valid_from', pg_catalog.to_char(row_.valid_from AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
    'revoked_at', pg_catalog.to_char(row_.revoked_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
    'assigned_by_membership_id', row_.assigned_by_membership_id,
    'reason_code', row_.reason_code
  ) FROM updated AS row_;
END;
$function$;

COMMENT ON FUNCTION public.novatrade_invitation_binding_revoke(pg_catalog.text) IS
  'L-02 identity-lane live-binding revocation on the invited membership; requires a same-transaction finalize.';
REVOKE ALL ON FUNCTION public.novatrade_invitation_binding_revoke(pg_catalog.text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.novatrade_invitation_binding_revoke(pg_catalog.text) FROM anon;
REVOKE ALL ON FUNCTION public.novatrade_invitation_binding_revoke(pg_catalog.text) FROM authenticated;

CREATE OR REPLACE FUNCTION public.novatrade_invitation_membership_create(p_request pg_catalog.text)
RETURNS TABLE(record pg_catalog.jsonb)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $function$
DECLARE
  v_request pg_catalog.jsonb;
  v_tenant_id pg_catalog.text;
  v_id pg_catalog.text;
  v_identity pg_catalog.text;
  v_workspace pg_catalog.text;
  v_inviter pg_catalog.text;
  v_at pg_catalog.text;
  v_invitation public.tenant_invitations;
BEGIN
  -- Identity lane, post-finalize: the replacement membership must match an
  -- invitation accepted by this transaction — identity and workspace are
  -- re-derived server-side so the caller cannot bind a different recipient.
  BEGIN
    v_request := p_request::pg_catalog.jsonb;
  EXCEPTION WHEN OTHERS THEN
    RETURN;
  END;
  v_tenant_id := v_request ->> 'tenantId';
  v_id := v_request ->> 'id';
  v_identity := v_request ->> 'authIdentityId';
  v_workspace := v_request ->> 'workspaceId';
  v_inviter := v_request ->> 'invitedByMembershipId';
  v_at := v_request ->> 'createdAt';
  IF v_tenant_id IS NULL OR v_tenant_id !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
     OR v_id IS NULL OR v_id !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
     OR v_identity IS NULL OR v_identity !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
     OR (v_workspace IS NOT NULL AND v_workspace !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$')
     OR (v_inviter IS NOT NULL AND v_inviter !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$')
     OR v_at IS NULL THEN
    RETURN;
  END IF;

  SELECT invitation.* INTO v_invitation
  FROM public.tenant_invitations AS invitation
  JOIN public.tenant_memberships AS invited
    ON invited.tenant_id = invitation.tenant_id
   AND invited.id = invitation.membership_id
   AND invited.status = 'expired'
  WHERE invitation.tenant_id = v_tenant_id::pg_catalog.uuid
    AND invitation.status = 'accepted'
    AND invitation.accepted_auth_identity_id = v_identity::pg_catalog.uuid
    AND invitation.workspace_id IS NOT DISTINCT FROM v_workspace::pg_catalog.uuid
    AND invited.invited_by_membership_id IS NOT DISTINCT FROM v_inviter::pg_catalog.uuid
    AND invitation.xmin::pg_catalog.text::pg_catalog.int8
        = pg_catalog.pg_current_xact_id()::pg_catalog.text::pg_catalog.int8
  ORDER BY invitation.generation DESC, invitation.id DESC
  LIMIT 1;

  IF v_invitation.id IS NULL THEN RETURN; END IF;

  RETURN QUERY
  WITH inserted AS (
    INSERT INTO public.tenant_memberships (
      id, tenant_id, auth_identity_id, pending_identity_ref_hash, workspace_id,
      status, invited_by_membership_id, created_at, updated_at
    )
    VALUES (
      v_id::pg_catalog.uuid, v_tenant_id::pg_catalog.uuid,
      v_identity::pg_catalog.uuid, NULL, v_workspace::pg_catalog.uuid,
      'active', v_inviter::pg_catalog.uuid,
      v_at::pg_catalog.timestamptz, v_at::pg_catalog.timestamptz
    )
    RETURNING *
  )
  SELECT pg_catalog.jsonb_build_object(
    'id', row_.id,
    'tenant_id', row_.tenant_id,
    'auth_identity_id', row_.auth_identity_id,
    'pending_identity_ref_hash', row_.pending_identity_ref_hash,
    'workspace_id', row_.workspace_id,
    'status', row_.status,
    'invited_by_membership_id', row_.invited_by_membership_id,
    'created_at', pg_catalog.to_char(row_.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
    'updated_at', pg_catalog.to_char(row_.updated_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
  ) FROM inserted AS row_;
END;
$function$;

COMMENT ON FUNCTION public.novatrade_invitation_membership_create(pg_catalog.text) IS
  'L-02 identity-lane replacement membership: the row must match an invitation accepted this transaction — identity, workspace, and inviter are re-verified server-side.';
REVOKE ALL ON FUNCTION public.novatrade_invitation_membership_create(pg_catalog.text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.novatrade_invitation_membership_create(pg_catalog.text) FROM anon;
REVOKE ALL ON FUNCTION public.novatrade_invitation_membership_create(pg_catalog.text) FROM authenticated;

CREATE OR REPLACE FUNCTION public.novatrade_invitation_binding_create(p_request pg_catalog.text)
RETURNS TABLE(record pg_catalog.jsonb)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $function$
DECLARE
  v_request pg_catalog.jsonb;
  v_tenant_id pg_catalog.text;
  v_id pg_catalog.text;
  v_membership_id pg_catalog.text;
  v_at pg_catalog.text;
  v_invitation public.tenant_invitations;
  v_membership public.tenant_memberships;
BEGIN
  -- Identity lane, post-finalize: the replacement binding carries the
  -- invitation's role onto a membership created by this transaction.
  BEGIN
    v_request := p_request::pg_catalog.jsonb;
  EXCEPTION WHEN OTHERS THEN
    RETURN;
  END;
  v_tenant_id := v_request ->> 'tenantId';
  v_id := v_request ->> 'id';
  v_membership_id := v_request ->> 'membershipId';
  v_at := v_request ->> 'validFrom';
  IF v_tenant_id IS NULL OR v_tenant_id !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
     OR v_id IS NULL OR v_id !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
     OR v_membership_id IS NULL OR v_membership_id !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
     OR v_at IS NULL THEN
    RETURN;
  END IF;

  SELECT * INTO v_membership
  FROM public.tenant_memberships AS membership
  WHERE membership.tenant_id = v_tenant_id::pg_catalog.uuid
    AND membership.id = v_membership_id::pg_catalog.uuid
    AND membership.status = 'active'
    AND membership.auth_identity_id IS NOT NULL
    AND membership.xmin::pg_catalog.text::pg_catalog.int8
        = pg_catalog.pg_current_xact_id()::pg_catalog.text::pg_catalog.int8;

  IF v_membership.id IS NULL THEN RETURN; END IF;

  SELECT invitation.* INTO v_invitation
  FROM public.tenant_invitations AS invitation
  WHERE invitation.tenant_id = v_tenant_id::pg_catalog.uuid
    AND invitation.status = 'accepted'
    AND invitation.accepted_auth_identity_id = v_membership.auth_identity_id
    AND invitation.workspace_id IS NOT DISTINCT FROM v_membership.workspace_id
    AND invitation.xmin::pg_catalog.text::pg_catalog.int8
        = pg_catalog.pg_current_xact_id()::pg_catalog.text::pg_catalog.int8
  ORDER BY invitation.generation DESC, invitation.id DESC
  LIMIT 1;

  IF v_invitation.id IS NULL THEN RETURN; END IF;

  RETURN QUERY
  WITH inserted AS (
    INSERT INTO public.tenant_role_bindings (
      id, tenant_id, membership_id, role, created_at, valid_from,
      assigned_by_membership_id, reason_code
    )
    VALUES (
      v_id::pg_catalog.uuid, v_tenant_id::pg_catalog.uuid,
      v_membership_id::pg_catalog.uuid, v_invitation.role,
      v_at::pg_catalog.timestamptz, v_at::pg_catalog.timestamptz,
      v_membership.invited_by_membership_id, 'invitation'
    )
    RETURNING *
  )
  SELECT pg_catalog.jsonb_build_object(
    'id', row_.id,
    'tenant_id', row_.tenant_id,
    'membership_id', row_.membership_id,
    'role', row_.role,
    'created_at', pg_catalog.to_char(row_.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
    'valid_from', pg_catalog.to_char(row_.valid_from AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
    'revoked_at', pg_catalog.to_char(row_.revoked_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
    'assigned_by_membership_id', row_.assigned_by_membership_id,
    'reason_code', row_.reason_code
  ) FROM inserted AS row_;
END;
$function$;

COMMENT ON FUNCTION public.novatrade_invitation_binding_create(pg_catalog.text) IS
  'L-02 identity-lane replacement binding: the role is derived from the invitation accepted this transaction onto a same-transaction membership.';
REVOKE ALL ON FUNCTION public.novatrade_invitation_binding_create(pg_catalog.text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.novatrade_invitation_binding_create(pg_catalog.text) FROM anon;
REVOKE ALL ON FUNCTION public.novatrade_invitation_binding_create(pg_catalog.text) FROM authenticated;

CREATE OR REPLACE FUNCTION public.novatrade_invitation_tenant_activate(p_request pg_catalog.text)
RETURNS TABLE(record pg_catalog.jsonb)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $function$
DECLARE
  v_request pg_catalog.jsonb;
  v_tenant_id pg_catalog.text;
BEGIN
  -- Identity lane, owner-kind only: acceptance activates the provisioning
  -- tenant atomically with the same-transaction finalize.
  BEGIN
    v_request := p_request::pg_catalog.jsonb;
  EXCEPTION WHEN OTHERS THEN
    RETURN;
  END;
  v_tenant_id := v_request ->> 'tenantId';
  IF v_tenant_id IS NULL OR v_tenant_id !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
     OR NOT EXISTS (
       SELECT 1
       FROM public.tenant_invitations AS invitation
       WHERE invitation.tenant_id = v_tenant_id::pg_catalog.uuid
         AND invitation.kind = 'owner'
         AND invitation.status = 'accepted'
         AND invitation.xmin::pg_catalog.text::pg_catalog.int8
             = pg_catalog.pg_current_xact_id()::pg_catalog.text::pg_catalog.int8
     ) THEN
    RETURN;
  END IF;
  IF NOT public.novatrade_invitation_context_free() THEN RETURN; END IF;

  RETURN QUERY
  WITH updated AS (
    UPDATE public.tenants AS tenant
    SET status = 'active'
    WHERE tenant.id = v_tenant_id::pg_catalog.uuid
      AND tenant.status = 'provisioning'
    RETURNING *
  )
  SELECT pg_catalog.jsonb_build_object(
    'id', row_.id,
    'slug', row_.slug,
    'name', row_.name,
    'status', row_.status,
    'locale', row_.locale,
    'timezone', row_.timezone,
    'created_at', pg_catalog.to_char(row_.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
    'updated_at', pg_catalog.to_char(row_.updated_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
  ) FROM updated AS row_;
END;
$function$;

COMMENT ON FUNCTION public.novatrade_invitation_tenant_activate(pg_catalog.text) IS
  'L-02 identity-lane owner-acceptance tenant activation: provisioning→active CAS bound to a same-transaction owner-invitation finalize.';
REVOKE ALL ON FUNCTION public.novatrade_invitation_tenant_activate(pg_catalog.text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.novatrade_invitation_tenant_activate(pg_catalog.text) FROM anon;
REVOKE ALL ON FUNCTION public.novatrade_invitation_tenant_activate(pg_catalog.text) FROM authenticated;

CREATE OR REPLACE FUNCTION public.novatrade_invitation_workspace_activate(p_request pg_catalog.text)
RETURNS TABLE(record pg_catalog.jsonb)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $function$
DECLARE
  v_request pg_catalog.jsonb;
  v_tenant_id pg_catalog.text;
  v_workspace_id pg_catalog.text;
BEGIN
  BEGIN
    v_request := p_request::pg_catalog.jsonb;
  EXCEPTION WHEN OTHERS THEN
    RETURN;
  END;
  v_tenant_id := v_request ->> 'tenantId';
  v_workspace_id := v_request ->> 'workspaceId';
  IF v_tenant_id IS NULL OR v_tenant_id !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
     OR v_workspace_id IS NULL OR v_workspace_id !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
     OR NOT public.novatrade_invitation_context_free()
     OR NOT EXISTS (
       SELECT 1
       FROM public.tenant_invitations AS invitation
       WHERE invitation.tenant_id = v_tenant_id::pg_catalog.uuid
         AND invitation.kind = 'owner'
         AND invitation.status = 'accepted'
         AND invitation.workspace_id = v_workspace_id::pg_catalog.uuid
         AND invitation.xmin::pg_catalog.text::pg_catalog.int8
             = pg_catalog.pg_current_xact_id()::pg_catalog.text::pg_catalog.int8
     ) THEN
    RETURN;
  END IF;

  RETURN QUERY
  WITH updated AS (
    UPDATE public.workspaces AS workspace
    SET status = 'active'
    WHERE workspace.tenant_id = v_tenant_id::pg_catalog.uuid
      AND workspace.id = v_workspace_id::pg_catalog.uuid
      AND workspace.status = 'provisioning'
    RETURNING *
  )
  SELECT pg_catalog.jsonb_build_object(
    'id', row_.id,
    'tenant_id', row_.tenant_id,
    'slug', row_.slug,
    'name', row_.name,
    'status', row_.status,
    'created_at', pg_catalog.to_char(row_.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
    'updated_at', pg_catalog.to_char(row_.updated_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
  ) FROM updated AS row_;
END;
$function$;

COMMENT ON FUNCTION public.novatrade_invitation_workspace_activate(pg_catalog.text) IS
  'L-02 identity-lane owner-acceptance workspace activation: provisioning→active CAS bound to the same accepted owner invitation.';
REVOKE ALL ON FUNCTION public.novatrade_invitation_workspace_activate(pg_catalog.text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.novatrade_invitation_workspace_activate(pg_catalog.text) FROM anon;
REVOKE ALL ON FUNCTION public.novatrade_invitation_workspace_activate(pg_catalog.text) FROM authenticated;

-- ---------------------------------------------------------------------------
-- Audit append. Three lanes:
--   * member ctx + member-layer event   → tenant-scope row, actor fields
--     bound to the installed GUC set.
--   * context-free + member-layer event → tenant-scope row, requires a
--     same-transaction finalize and a membership touched this transaction
--     (the acceptance audit).
--   * non-member layer under either lane → platform-scope row; membership,
--     role, and binding fields must be null.
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.novatrade_invitation_audit_append(p_request pg_catalog.text)
RETURNS TABLE(applied boolean)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $function$
DECLARE
  v_request pg_catalog.jsonb;
  v_event_id pg_catalog.text;
  v_event_type pg_catalog.text;
  v_request_id pg_catalog.text;
  v_invitation_id pg_catalog.text;
  v_correlation pg_catalog.text;
  v_key_hash pg_catalog.text;
  v_input_hash pg_catalog.text;
  v_actor_layer pg_catalog.text;
  v_actor_identity pg_catalog.text;
  v_actor_membership pg_catalog.text;
  v_actor_role pg_catalog.text;
  v_actor_binding pg_catalog.text;
  v_tenant_id pg_catalog.text;
  v_workspace pg_catalog.text;
  v_result_code pg_catalog.text;
  v_member_lane pg_catalog.bool;
  v_free_lane pg_catalog.bool;
  v_member_event pg_catalog.bool;
BEGIN
  BEGIN
    v_request := p_request::pg_catalog.jsonb;
  EXCEPTION WHEN OTHERS THEN
    RETURN QUERY SELECT false;
    RETURN;
  END;
  v_event_id := v_request ->> 'eventId';
  v_event_type := v_request ->> 'eventType';
  v_request_id := v_request ->> 'requestId';
  v_invitation_id := v_request ->> 'invitationId';
  v_correlation := v_request ->> 'correlationId';
  v_key_hash := v_request ->> 'idempotencyKeyHashRef';
  v_input_hash := v_request ->> 'inputHashRef';
  v_actor_layer := v_request ->> 'actorLayer';
  v_actor_identity := v_request ->> 'actorIdentityId';
  v_actor_membership := v_request ->> 'actorMembershipId';
  v_actor_role := v_request ->> 'actorRole';
  v_actor_binding := v_request ->> 'actorRoleBindingId';
  v_tenant_id := v_request ->> 'tenantId';
  v_workspace := v_request ->> 'workspaceId';
  v_result_code := v_request ->> 'resultCode';
  IF v_event_id IS NULL OR v_event_id !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
     OR v_event_type IS NULL OR v_event_type NOT IN (
       'tenant.invitation_issued', 'tenant.invitation_delivery_recorded',
       'tenant.invitation_accepted', 'tenant.invitation_reissued',
       'tenant.invitation_revoked', 'tenant.provisioned')
     OR v_invitation_id IS NULL OR v_invitation_id !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
     OR v_correlation IS NULL OR v_correlation !~ '^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$'
     OR (v_key_hash IS NOT NULL AND v_key_hash !~ '^[0-9a-f]{64}$')
     OR (v_input_hash IS NOT NULL AND v_input_hash !~ '^[0-9a-f]{64}$')
     OR v_actor_layer IS NULL OR v_actor_layer NOT IN ('member', 'system')
     OR v_actor_identity IS NULL OR v_actor_identity !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
     OR v_tenant_id IS NULL OR v_tenant_id !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
     OR (v_workspace IS NOT NULL AND v_workspace !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$')
     OR (v_request_id IS NOT NULL AND v_request_id !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$')
     OR v_result_code IS NULL OR v_result_code !~ '^[A-Z][A-Z0-9_]{1,63}$' THEN
    RETURN QUERY SELECT false;
    RETURN;
  END IF;

  v_member_lane := public.novatrade_rls_member_context();
  v_free_lane := public.novatrade_invitation_context_free();
  v_member_event := v_actor_layer = 'member';

  IF v_member_event THEN
    IF v_actor_membership IS NULL OR v_actor_membership !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
       OR v_actor_role IS NULL OR v_actor_role NOT IN (
         'owner', 'admin', 'strategist_manager', 'researcher',
         'reviewer', 'outreach_operator', 'analyst_read_only')
       OR v_actor_binding IS NULL OR v_actor_binding !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN
      RETURN QUERY SELECT false;
      RETURN;
    END IF;
    IF v_member_lane THEN
      -- Member-lane event: the actor fields must equal the installed context.
      -- The event's workspace is the target resource's, not the actor's —
      -- the audit guard trigger already enforces its tenant FK.
      IF pg_catalog.current_setting('app.tenant_id', true) <> v_tenant_id
         OR pg_catalog.current_setting('app.actor_id', true) <> v_actor_identity
         OR pg_catalog.current_setting('app.membership_id', true) <> v_actor_membership
         OR pg_catalog.current_setting('app.role', true) <> v_actor_role
         OR pg_catalog.current_setting('app.role_binding_id', true) <> v_actor_binding THEN
        RETURN QUERY SELECT false;
        RETURN;
      END IF;
    ELSIF v_free_lane THEN
      -- Identity-lane acceptance event: a same-transaction finalize plus a
      -- membership row touched by this transaction is the write authority.
      IF NOT EXISTS (
           SELECT 1
           FROM public.tenant_invitations AS invitation
           WHERE invitation.tenant_id = v_tenant_id::pg_catalog.uuid
             AND invitation.id = v_invitation_id::pg_catalog.uuid
             AND invitation.status = 'accepted'
             AND invitation.xmin::pg_catalog.text::pg_catalog.int8
                 = pg_catalog.pg_current_xact_id()::pg_catalog.text::pg_catalog.int8
         )
         OR NOT EXISTS (
           SELECT 1
           FROM public.tenant_memberships AS membership
           WHERE membership.tenant_id = v_tenant_id::pg_catalog.uuid
             AND membership.id = v_actor_membership::pg_catalog.uuid
             AND membership.auth_identity_id = v_actor_identity::pg_catalog.uuid
             AND membership.xmin::pg_catalog.text::pg_catalog.int8
                 = pg_catalog.pg_current_xact_id()::pg_catalog.text::pg_catalog.int8
         ) THEN
        RETURN QUERY SELECT false;
        RETURN;
      END IF;
    ELSE
      RETURN QUERY SELECT false;
      RETURN;
    END IF;

    INSERT INTO public.audit_logs (
      id, action, entity_type, entity_id, metadata, scope_kind,
      tenant_id, workspace_id, correlation_id,
      actor_auth_identity_id, actor_membership_id, actor_launch_role,
      actor_role_binding_id, actor_layer
    ) VALUES (
      v_event_id::pg_catalog.uuid, v_event_type, 'tenant_invitation', v_invitation_id,
      v_request, 'tenant', v_tenant_id::pg_catalog.uuid, v_workspace::pg_catalog.uuid,
      v_correlation, v_actor_identity::pg_catalog.uuid,
      v_actor_membership::pg_catalog.uuid, v_actor_role,
      v_actor_binding::pg_catalog.uuid, 'member'
    );
  ELSE
    -- System-layer event: platform scope under either lane; member fields
    -- must be absent.
    IF NOT (v_member_lane OR v_free_lane)
       OR v_actor_membership IS NOT NULL
       OR v_actor_role IS NOT NULL
       OR v_actor_binding IS NOT NULL THEN
      RETURN QUERY SELECT false;
      RETURN;
    END IF;

    INSERT INTO public.audit_logs (
      id, action, entity_type, entity_id, metadata, scope_kind,
      tenant_id, workspace_id, correlation_id,
      actor_auth_identity_id, actor_membership_id, actor_launch_role,
      actor_role_binding_id, actor_layer
    ) VALUES (
      v_event_id::pg_catalog.uuid, v_event_type, 'tenant_invitation', v_invitation_id,
      v_request, 'platform', NULL, NULL,
      v_correlation, v_actor_identity::pg_catalog.uuid,
      NULL, NULL, NULL, 'system'
    );
  END IF;

  RETURN QUERY SELECT true;
END;
$function$;

COMMENT ON FUNCTION public.novatrade_invitation_audit_append(pg_catalog.text) IS
  'L-02 invitation audit append: GUC-bound member events, same-transaction acceptance events, and platform-scope system events.';
REVOKE ALL ON FUNCTION public.novatrade_invitation_audit_append(pg_catalog.text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.novatrade_invitation_audit_append(pg_catalog.text) FROM anon;
REVOKE ALL ON FUNCTION public.novatrade_invitation_audit_append(pg_catalog.text) FROM authenticated;

-- ---------------------------------------------------------------------------
-- Delivery marking widened to the member lane: post-commit marking runs
-- inside whatever lane the coordinator opened — an ambient member context
-- must not refuse it. The CAS itself is unchanged.
-- ---------------------------------------------------------------------------

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
     OR NOT public.novatrade_invitation_lane(v_tenant_id) THEN
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
  SELECT true, public.novatrade_invitation_json(row_.*)
  FROM updated AS row_;

  IF NOT FOUND THEN
    RETURN QUERY SELECT false, NULL::pg_catalog.jsonb;
  END IF;
END;
$function$;

COMMENT ON FUNCTION public.novatrade_invitation_delivery_mark(pg_catalog.text) IS
  'L-02 dual-lane delivery marking on a live invitation; the compare-and-set matches the canonical recordInvitationDelivery.';
REVOKE ALL ON FUNCTION public.novatrade_invitation_delivery_mark(pg_catalog.text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.novatrade_invitation_delivery_mark(pg_catalog.text) FROM anon;
REVOKE ALL ON FUNCTION public.novatrade_invitation_delivery_mark(pg_catalog.text) FROM authenticated;
