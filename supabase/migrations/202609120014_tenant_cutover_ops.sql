-- L-02 T-041 (0X3-234): tenant cutover read/ensure surface.
--
-- Retiring the old paths flips the shared LOCAL_MUTATIONS_UNAVAILABLE gate:
-- every action surface dispatches to the proven PostgreSQL twins and the
-- protected pages stop short-circuiting to the SQLite-only loaders. Three
-- read/ensure shapes sit on deny-all tables, so they need definer ports:
--
--   1. app_users session profile — getSession's ensureAppUserForAuthUser does
--      read+touch / bootstrap-create / pending-phantom; app_users carries RLS
--      with zero policies, so the whole contract moves server-side.
--   2. app_users ensure-active — the invitation-acceptance path inserts the
--      accepted member's profile iff missing; persisted rows are never
--      rewritten.
--   3. Tenant lifecycle snapshot bundle — the tenancy page reads audit_logs
--      and tenant_deletion_jobs (both zero-policy) plus the tenant row. The
--      read is gated by the structural actor context (T-039), not member RLS,
--      so suspended/archived tenants still render a truthful snapshot.

-- ---------------------------------------------------------------------------
-- Platform lane: app_users session profile (ensureAppUserForAuthUser port).
-- Context-free: getSession runs before any tenant context exists. The
-- bootstrap-admin path stays server-side so a caller cannot mint the first
-- admin by guessing the env email — the candidate is compared in-database.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.novatrade_app_user_session_profile(
  p_user_id pg_catalog.uuid,
  p_email pg_catalog.text,
  p_bootstrap_email pg_catalog.text
)
RETURNS pg_catalog.jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
DECLARE
  v_row public.app_users%ROWTYPE;
  v_email pg_catalog.text := pg_catalog.lower(pg_catalog.btrim(coalesce(p_email, '')));
  v_now pg_catalog.timestamptz := pg_catalog.now();
BEGIN
  IF p_user_id IS NULL OR v_email = '' THEN
    RETURN NULL;
  END IF;

  SELECT * INTO v_row
  FROM public.app_users
  WHERE user_id = p_user_id;
  IF FOUND THEN
    UPDATE public.app_users
       SET last_seen_at = v_now,
           updated_at = v_now
     WHERE user_id = p_user_id;
    RETURN pg_catalog.jsonb_build_object(
      'userId', v_row.user_id::pg_catalog.text,
      'email', v_row.email,
      'displayName', v_row.display_name,
      'role', v_row.role::pg_catalog.text,
      'status', v_row.status::pg_catalog.text
    );
  END IF;

  IF p_bootstrap_email IS NOT NULL
     AND pg_catalog.btrim(p_bootstrap_email) <> ''
     AND v_email = pg_catalog.lower(pg_catalog.btrim(p_bootstrap_email))
     AND NOT EXISTS (SELECT 1 FROM public.app_users WHERE role = 'admin')
  THEN
    INSERT INTO public.app_users
      (id, user_id, email, display_name, role, status, created_by, is_team_lead, created_at, updated_at)
    VALUES
      (pg_catalog.gen_random_uuid()::pg_catalog.text, p_user_id, v_email, 'Admin',
       'admin', 'active', NULL, 0, v_now, v_now);
    RETURN pg_catalog.jsonb_build_object(
      'userId', p_user_id::pg_catalog.text,
      'email', v_email,
      'displayName', 'Admin',
      'role', 'admin',
      'status', 'active'
    );
  END IF;

  -- Pending phantom: no row is persisted until a tenant membership admits the
  -- identity; the session layer renders the inactive shape from this payload.
  RETURN pg_catalog.jsonb_build_object(
    'userId', p_user_id::pg_catalog.text,
    'email', v_email,
    'displayName', NULL,
    'role', NULL,
    'status', 'pending'
  );
END;
$$;

COMMENT ON FUNCTION public.novatrade_app_user_session_profile(pg_catalog.uuid, pg_catalog.text, pg_catalog.text) IS
  'L-02 T-041 platform lane: app_users session profile ensure — existing row touch + profile, bootstrap-first-admin insert, or pending phantom. PUBLIC API.';

-- ---------------------------------------------------------------------------
-- Platform lane: ensure an accepted member's app_users profile exists.
-- Insert-if-missing ONLY — an existing active or disabled row is deliberate
-- platform state and is never rewritten by acceptance. The INSERT path is
-- admission-bound: the identity must hold an active membership and the app
-- role is derived from the live owner/admin bindings, so the runtime
-- credential alone cannot mint a profile or escalate its role.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.novatrade_app_user_ensure_active(
  p_user_id pg_catalog.uuid,
  p_email pg_catalog.text,
  p_display_name pg_catalog.text,
  p_role pg_catalog.text
)
RETURNS pg_catalog.void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
DECLARE
  v_email pg_catalog.text := pg_catalog.lower(pg_catalog.btrim(coalesce(p_email, '')));
  v_now pg_catalog.timestamptz := pg_catalog.now();
  v_is_admin pg_catalog.bool;
BEGIN
  IF p_user_id IS NULL OR v_email = '' THEN
    RAISE EXCEPTION 'app user ensure refused: user_id and email are required'
      USING ERRCODE = '22023';
  END IF;
  IF p_role NOT IN ('admin', 'researcher') THEN
    RAISE EXCEPTION 'app user ensure refused: unsupported app role'
      USING ERRCODE = '22023';
  END IF;

  -- A persisted row is deliberate platform state — the operation is a no-op
  -- regardless of who asks, and the admission gate below never runs for it.
  IF EXISTS (SELECT 1 FROM public.app_users WHERE user_id = p_user_id) THEN
    RETURN;
  END IF;

  -- The acceptance proof is the persisted membership state itself: the
  -- identity must hold an active membership, and the app role is derived
  -- from the live owner/admin bindings rather than trusted from the caller.
  -- A runtime credential alone cannot mint an admin profile.
  IF NOT EXISTS (
    SELECT 1
    FROM public.tenant_memberships AS membership
    WHERE membership.auth_identity_id = p_user_id
      AND membership.status = 'active'
  ) THEN
    RAISE EXCEPTION 'app user ensure refused: no active membership admits the identity'
      USING ERRCODE = '42501';
  END IF;

  SELECT coalesce(pg_catalog.bool_or(binding.role = ANY (ARRAY['owner', 'admin'])), false)
    INTO v_is_admin
  FROM public.tenant_memberships AS membership
  JOIN public.tenant_role_bindings AS binding
    ON binding.membership_id = membership.id
   AND binding.revoked_at IS NULL
  WHERE membership.auth_identity_id = p_user_id
    AND membership.status = 'active';

  IF p_role IS DISTINCT FROM (CASE WHEN v_is_admin THEN 'admin' ELSE 'researcher' END) THEN
    RAISE EXCEPTION 'app user ensure refused: role does not match derived membership role'
      USING ERRCODE = '22023';
  END IF;

  INSERT INTO public.app_users
    (id, user_id, email, display_name, role, status, created_by, is_team_lead, created_at, updated_at)
  VALUES
    (pg_catalog.gen_random_uuid()::pg_catalog.text, p_user_id, v_email,
     NULLIF(pg_catalog.btrim(coalesce(p_display_name, '')), ''), p_role::public.app_role,
     'active', NULL, 0, v_now, v_now)
  ON CONFLICT (user_id) DO NOTHING;
END;
$$;

COMMENT ON FUNCTION public.novatrade_app_user_ensure_active(pg_catalog.uuid, pg_catalog.text, pg_catalog.text, pg_catalog.text) IS
  'L-02 T-041 platform lane: insert-if-missing app_users profile for an accepted member. Never rewrites a persisted row. PUBLIC API.';

-- ---------------------------------------------------------------------------
-- Tenant lifecycle snapshot bundle for the tenancy page. audit_logs and
-- tenant_deletion_jobs are zero-policy; the structural actor context (live
-- membership + live binding agreement, any member role, no tenant-status
-- gate) is the honest boundary: suspended and archived tenants still render
-- their recorded snapshot while foreign tenants are refused.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.novatrade_tenant_lifecycle_snapshot_read(
  p_tenant_id pg_catalog.uuid
)
RETURNS pg_catalog.jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
DECLARE
  v_tenant public.tenants%ROWTYPE;
  v_audit pg_catalog.jsonb;
  v_deletion pg_catalog.jsonb;
BEGIN
  IF p_tenant_id IS NULL
     OR NOT public.novatrade_deletion_actor_ctx()
     OR pg_catalog.current_setting('app.tenant_id', true) IS DISTINCT FROM p_tenant_id::pg_catalog.text
  THEN
    RETURN NULL;
  END IF;

  SELECT * INTO v_tenant FROM public.tenants WHERE id = p_tenant_id;
  IF NOT FOUND THEN
    RETURN NULL;
  END IF;

  SELECT coalesce(
           pg_catalog.jsonb_agg(payload ORDER BY sort_key DESC),
           '[]'::pg_catalog.jsonb)
    INTO v_audit
  FROM (
    SELECT pg_catalog.jsonb_build_object(
             'id', a.id,
             'action', a.action,
             'metadata', a.metadata::pg_catalog.text,
             'created_at', pg_catalog.to_char(a.created_at AT TIME ZONE 'UTC',
                             'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
             'workspace_id', a.workspace_id::pg_catalog.text,
             'actor_auth_identity_id', a.actor_auth_identity_id::pg_catalog.text
           ) AS payload,
           a.created_at AS sort_key
      FROM public.audit_logs AS a
     WHERE a.action IN (
            'tenant.provisioned',
            'tenant.suspended',
            'tenant.resumed',
            'tenant.archived',
            'tenant.deletion.requested',
            'tenant.deletion.primary_deleted',
            'tenant.deletion.completed',
            'tenant.deletion.canceled')
       AND (a.tenant_id = p_tenant_id OR a.entity_id = p_tenant_id::pg_catalog.text)
     ORDER BY a.created_at DESC
     LIMIT 500
  ) AS recent;

  SELECT pg_catalog.jsonb_build_object(
           'id', j.id::pg_catalog.text,
           'freeze_handoff_status', j.freeze_handoff_status,
           'access_revocation_handoff_status', j.access_revocation_handoff_status
         )
    INTO v_deletion
  FROM public.tenant_deletion_jobs AS j
  WHERE j.tenant_id = p_tenant_id
    AND j.workspace_id IS NULL
  ORDER BY j.created_at DESC, j.id DESC
  LIMIT 1;

  RETURN pg_catalog.jsonb_build_object(
    'tenant', pg_catalog.jsonb_build_object(
      'id', v_tenant.id::pg_catalog.text,
      'slug', v_tenant.slug,
      'name', v_tenant.name,
      'status', v_tenant.status,
      'locale', v_tenant.locale,
      'timezone', v_tenant.timezone,
      'created_at', pg_catalog.to_char(v_tenant.created_at AT TIME ZONE 'UTC',
                      'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
      'updated_at', pg_catalog.to_char(v_tenant.updated_at AT TIME ZONE 'UTC',
                      'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')),
    'audit', v_audit,
    'deletion', v_deletion
  );
END;
$$;

COMMENT ON FUNCTION public.novatrade_tenant_lifecycle_snapshot_read(pg_catalog.uuid) IS
  'L-02 T-041 member-lane read bundle for the tenancy page: tenant row + transition audit receipts + latest tenant-wide deletion job. Gated by the structural actor context so non-active tenants stay truthful. PUBLIC API.';

-- Lightweight latest-deletion-job lookup for the data-lifecycle panel. Same
-- actor-context gate as the snapshot bundle; returns NULL for absence so the
-- caller's non-enumerating surface is preserved.
CREATE OR REPLACE FUNCTION public.novatrade_tenant_deletion_job_latest(
  p_tenant_id pg_catalog.uuid
)
RETURNS pg_catalog.uuid
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
DECLARE
  v_id pg_catalog.uuid;
BEGIN
  IF p_tenant_id IS NULL
     OR NOT public.novatrade_deletion_actor_ctx()
     OR pg_catalog.current_setting('app.tenant_id', true) IS DISTINCT FROM p_tenant_id::pg_catalog.text
  THEN
    RETURN NULL;
  END IF;

  SELECT j.id INTO v_id
  FROM public.tenant_deletion_jobs AS j
  WHERE j.tenant_id = p_tenant_id
    AND j.workspace_id IS NULL
  ORDER BY j.created_at DESC, j.id DESC
  LIMIT 1;
  RETURN v_id;
END;
$$;

COMMENT ON FUNCTION public.novatrade_tenant_deletion_job_latest(pg_catalog.uuid) IS
  'L-02 T-041 member-lane read: latest tenant-wide deletion job id under the structural actor context. PUBLIC API.';

-- Symmetric export-job lookup. tenant_export_jobs carries member-select RLS,
-- but member context requires tenant status 'active' — the actor-context gate
-- keeps a suspended tenant's recorded export job visible to its own members.
CREATE OR REPLACE FUNCTION public.novatrade_tenant_export_job_latest(
  p_tenant_id pg_catalog.uuid
)
RETURNS pg_catalog.uuid
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
DECLARE
  v_id pg_catalog.uuid;
BEGIN
  IF p_tenant_id IS NULL
     OR NOT public.novatrade_deletion_actor_ctx()
     OR pg_catalog.current_setting('app.tenant_id', true) IS DISTINCT FROM p_tenant_id::pg_catalog.text
  THEN
    RETURN NULL;
  END IF;

  SELECT j.id INTO v_id
  FROM public.tenant_export_jobs AS j
  WHERE j.tenant_id = p_tenant_id
    AND j.workspace_id IS NULL
  ORDER BY j.created_at DESC, j.id DESC
  LIMIT 1;
  RETURN v_id;
END;
$$;

COMMENT ON FUNCTION public.novatrade_tenant_export_job_latest(pg_catalog.uuid) IS
  'L-02 T-041 member-lane read: latest tenant-wide export job id under the structural actor context. PUBLIC API.';

-- Point read of a single export job row. Member-RLS member context requires
-- tenant status 'active'; the actor-context gate keeps the recorded job
-- readable on suspended/archived tenants for the same live membership.
CREATE OR REPLACE FUNCTION public.novatrade_tenant_export_job_read(
  p_tenant_id pg_catalog.uuid,
  p_job_id pg_catalog.uuid
)
RETURNS SETOF public.tenant_export_jobs
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
BEGIN
  IF p_tenant_id IS NULL
     OR p_job_id IS NULL
     OR NOT public.novatrade_deletion_actor_ctx()
     OR pg_catalog.current_setting('app.tenant_id', true) IS DISTINCT FROM p_tenant_id::pg_catalog.text
  THEN
    RETURN;
  END IF;

  RETURN QUERY
  SELECT j.*
  FROM public.tenant_export_jobs AS j
  WHERE j.tenant_id = p_tenant_id
    AND j.id = p_job_id;
END;
$$;

COMMENT ON FUNCTION public.novatrade_tenant_export_job_read(pg_catalog.uuid, pg_catalog.uuid) IS
  'L-02 T-041 member-lane read: one export job row under the structural actor context, including non-active tenant states. PUBLIC API.';

REVOKE ALL ON FUNCTION public.novatrade_app_user_session_profile(pg_catalog.uuid, pg_catalog.text, pg_catalog.text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.novatrade_app_user_session_profile(pg_catalog.uuid, pg_catalog.text, pg_catalog.text) FROM anon;
REVOKE ALL ON FUNCTION public.novatrade_app_user_session_profile(pg_catalog.uuid, pg_catalog.text, pg_catalog.text) FROM authenticated;
REVOKE ALL ON FUNCTION public.novatrade_app_user_ensure_active(pg_catalog.uuid, pg_catalog.text, pg_catalog.text, pg_catalog.text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.novatrade_app_user_ensure_active(pg_catalog.uuid, pg_catalog.text, pg_catalog.text, pg_catalog.text) FROM anon;
REVOKE ALL ON FUNCTION public.novatrade_app_user_ensure_active(pg_catalog.uuid, pg_catalog.text, pg_catalog.text, pg_catalog.text) FROM authenticated;
REVOKE ALL ON FUNCTION public.novatrade_tenant_lifecycle_snapshot_read(pg_catalog.uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.novatrade_tenant_lifecycle_snapshot_read(pg_catalog.uuid) FROM anon;
REVOKE ALL ON FUNCTION public.novatrade_tenant_lifecycle_snapshot_read(pg_catalog.uuid) FROM authenticated;
REVOKE ALL ON FUNCTION public.novatrade_tenant_deletion_job_latest(pg_catalog.uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.novatrade_tenant_deletion_job_latest(pg_catalog.uuid) FROM anon;
REVOKE ALL ON FUNCTION public.novatrade_tenant_deletion_job_latest(pg_catalog.uuid) FROM authenticated;
REVOKE ALL ON FUNCTION public.novatrade_tenant_export_job_latest(pg_catalog.uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.novatrade_tenant_export_job_latest(pg_catalog.uuid) FROM anon;
REVOKE ALL ON FUNCTION public.novatrade_tenant_export_job_latest(pg_catalog.uuid) FROM authenticated;
REVOKE ALL ON FUNCTION public.novatrade_tenant_export_job_read(pg_catalog.uuid, pg_catalog.uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.novatrade_tenant_export_job_read(pg_catalog.uuid, pg_catalog.uuid) FROM anon;
REVOKE ALL ON FUNCTION public.novatrade_tenant_export_job_read(pg_catalog.uuid, pg_catalog.uuid) FROM authenticated;
