-- L-02 member-side membership-administration write path — the Postgres twin
-- of createLocalTenantMembershipAdministrationService.
--
-- tenant_memberships and tenant_role_bindings carry owner/admin member-select
-- policies plus deny-all write policies, so every mutation (invite, role
-- change, workspace assignment, disable, reactivate, revoke, remove) goes
-- through these SECURITY DEFINER functions. Each re-validates the
-- transaction-local member GUCs installed by withTenantDbContext
-- (novatrade_rls_member_context, the same helper the RLS policies use) and
-- binds tenant, actor-membership, and actor-binding facts to the accepted
-- context — a direct EXECUTE caller cannot mutate another tenant's roster or
-- borrow another member's authority.
--
-- Reads (listMemberships / getMembership / findByIdentitySelectorHash /
-- getWorkspace / assertActor) are intentionally absent here: the member-select
-- policies on memberships, role bindings, and workspaces already expose
-- exactly the accepted-context slice, so the adapter reads them through
-- member RLS like the other canonical ports. Using the definer snapshot
-- builder for reads would bypass the workspace-visibility filter.
--
-- The mutation journal is a new Postgres table ported from the SQLite schema
-- (tenant_membership_mutation_journal): RLS-enabled with zero policies, so
-- only these functions can touch it. Journal rows are reserved then completed
-- in the same transaction; the state check constraint mirrors the SQLite one.
--
-- Request payloads are text, not jsonb: the postgres.js driver double-encodes
-- a JS string bound to a jsonb parameter, so every function takes text and
-- parses internally (the p_audit_metadata convention). Nested payloads such
-- as result_json travel inside the request jsonb and are extracted as jsonb,
-- so they never pass through the driver's scalar encoder.
--
-- Timestamp discipline: the memberships guard trigger stamps updated_at =
-- now() = transaction_timestamp(). The adapter's service clock returns the
-- transaction-start instant captured inside the coordinator, so effectiveAt
-- equals the trigger stamp at millisecond precision — satisfying the
-- canonical contract's updatedAt === effectiveAt equality without weakening
-- the guard for any other writer.

CREATE TABLE public.tenant_membership_mutation_journal (
  idempotency_key_hash text CONSTRAINT tenant_membership_mutation_journal_pkey PRIMARY KEY
    CONSTRAINT tenant_membership_mutation_journal_key_chk
    CHECK (idempotency_key_hash ~ '^[0-9a-f]{64}$'),
  input_hash text NOT NULL
    CONSTRAINT tenant_membership_mutation_journal_input_chk
    CHECK (input_hash ~ '^[0-9a-f]{64}$'),
  tenant_id uuid NOT NULL,
  actor_membership_id uuid NOT NULL,
  actor_role_binding_id uuid NOT NULL,
  operation text NOT NULL
    CONSTRAINT tenant_membership_mutation_journal_operation_chk
    CHECK (operation IN (
      'invite', 'assign_role', 'assign_workspace',
      'disable', 'reactivate', 'revoke', 'remove'
    )),
  target_membership_id uuid,
  replacement_membership_id uuid,
  status text NOT NULL DEFAULT 'reserved'
    CONSTRAINT tenant_membership_mutation_journal_status_chk
    CHECK (status IN ('reserved', 'completed')),
  result_json jsonb,
  created_at timestamptz NOT NULL DEFAULT pg_catalog.now(),
  completed_at timestamptz,
  CONSTRAINT tenant_membership_mutation_journal_actor_membership_fkey
    FOREIGN KEY (tenant_id, actor_membership_id)
    REFERENCES public.tenant_memberships (tenant_id, id)
    ON UPDATE RESTRICT
    ON DELETE RESTRICT,
  CONSTRAINT tenant_membership_mutation_journal_actor_binding_fkey
    FOREIGN KEY (tenant_id, actor_role_binding_id)
    REFERENCES public.tenant_role_bindings (tenant_id, id)
    ON UPDATE RESTRICT
    ON DELETE RESTRICT,
  CONSTRAINT tenant_membership_mutation_journal_state_chk CHECK (
    CASE WHEN status = 'reserved'
      THEN result_json IS NULL AND completed_at IS NULL
      ELSE target_membership_id IS NOT NULL AND result_json IS NOT NULL
        AND completed_at IS NOT NULL
    END
  ),
  CONSTRAINT tenant_membership_mutation_journal_timestamps_chk CHECK (
    completed_at IS NULL OR completed_at >= created_at
  )
);

COMMENT ON TABLE public.tenant_membership_mutation_journal IS
  'Membership-mutation idempotency ledger: one reservation lane per (tenant, actor, operation, key) with reserve-then-complete semantics ported from the SQLite schema.';

CREATE INDEX idx_tenant_membership_mutation_journal_tenant_created
  ON public.tenant_membership_mutation_journal
  (tenant_id, created_at DESC, idempotency_key_hash);

-- The journal's actor-binding foreign key anchors on the
-- tenant_role_bindings_tenant_id_id_unique (tenant_id, id) constraint that
-- 202607270007_add_tenant_audit_context.sql already created — no new index
-- is needed here.

ALTER TABLE public.tenant_membership_mutation_journal ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.tenant_membership_mutation_journal FORCE ROW LEVEL SECURITY;

-- Canonical snapshot renderer for the write functions' return payloads. The
-- shape is exactly the MembershipSnapshot the canonical service validates:
-- membership record, ordered role history, and the single open binding.
-- INTERNAL ONLY — reads must ride member RLS so workspace-scoped members keep
-- their accepted-context slice; this function is revoked from every caller.
CREATE OR REPLACE FUNCTION public.novatrade_membership_snapshot_json(
  p_tenant_id pg_catalog.uuid,
  p_membership_id pg_catalog.uuid
)
RETURNS pg_catalog.jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
DECLARE
  v_membership public.tenant_memberships%ROWTYPE;
  v_bindings pg_catalog.jsonb;
  v_current pg_catalog.jsonb;
BEGIN
  SELECT * INTO v_membership
  FROM public.tenant_memberships AS membership
  WHERE membership.tenant_id = p_tenant_id AND membership.id = p_membership_id;
  IF NOT FOUND THEN
    RETURN NULL;
  END IF;

  SELECT
    pg_catalog.jsonb_agg(binding.snapshot ORDER BY binding.valid_from ASC, binding.id ASC),
    pg_catalog.jsonb_agg(binding.snapshot ORDER BY binding.valid_from ASC, binding.id ASC)
      FILTER (WHERE binding.revoked_at IS NULL)
  INTO v_bindings, v_current
  FROM (
    SELECT binding.id, binding.valid_from, binding.revoked_at,
      pg_catalog.jsonb_build_object(
        'id', binding.id::pg_catalog.text,
        'tenantId', binding.tenant_id::pg_catalog.text,
        'membershipId', binding.membership_id::pg_catalog.text,
        'role', binding.role,
        'createdAt', pg_catalog.to_char(binding.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
        'validFrom', pg_catalog.to_char(binding.valid_from AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
        'revokedAt', CASE WHEN binding.revoked_at IS NULL THEN NULL
          ELSE pg_catalog.to_char(binding.revoked_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') END,
        'assignedByMembershipId', binding.assigned_by_membership_id::pg_catalog.text,
        'reasonCode', binding.reason_code
      ) AS snapshot
    FROM public.tenant_role_bindings AS binding
    WHERE binding.tenant_id = p_tenant_id AND binding.membership_id = p_membership_id
  ) AS binding;

  RETURN pg_catalog.jsonb_build_object(
    'membership', pg_catalog.jsonb_build_object(
      'id', v_membership.id::pg_catalog.text,
      'tenantId', v_membership.tenant_id::pg_catalog.text,
      'authIdentityId', v_membership.auth_identity_id::pg_catalog.text,
      'pendingIdentityRefHash', v_membership.pending_identity_ref_hash,
      'workspaceId', v_membership.workspace_id::pg_catalog.text,
      'status', v_membership.status,
      'invitedByMembershipId', v_membership.invited_by_membership_id::pg_catalog.text,
      'createdAt', pg_catalog.to_char(v_membership.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
      'updatedAt', pg_catalog.to_char(v_membership.updated_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
    ),
    'roleBindings', coalesce(v_bindings, '[]'::pg_catalog.jsonb),
    'currentRoleBinding', CASE WHEN v_current IS NULL THEN NULL ELSE v_current -> 0 END
  );
END;
$$;

COMMENT ON FUNCTION public.novatrade_membership_snapshot_json(pg_catalog.uuid, pg_catalog.uuid) IS
  'Internal builder: renders one membership plus its ordered role-binding history and single current binding as the canonical MembershipSnapshot jsonb.';
REVOKE ALL ON FUNCTION public.novatrade_membership_snapshot_json(pg_catalog.uuid, pg_catalog.uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.novatrade_membership_snapshot_json(pg_catalog.uuid, pg_catalog.uuid) FROM anon;
REVOKE ALL ON FUNCTION public.novatrade_membership_snapshot_json(pg_catalog.uuid, pg_catalog.uuid) FROM authenticated;

-- Completed-journal lookup for the replay short-circuit. The journal lane is
-- bound to the member context's tenant and actor membership; a completed
-- entry for another actor or tenant is invisible, never disclosed.
CREATE OR REPLACE FUNCTION public.novatrade_membership_journal_find(
  p_request pg_catalog.text
)
RETURNS TABLE (record pg_catalog.jsonb)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
DECLARE
  v_request pg_catalog.jsonb := p_request::pg_catalog.jsonb;
  v_key_hash pg_catalog.text := v_request ->> 'idempotencyKeyHash';
  v_tenant_id pg_catalog.text := coalesce(pg_catalog.current_setting('app.tenant_id', true), '');
  v_membership_id pg_catalog.text := coalesce(pg_catalog.current_setting('app.membership_id', true), '');
BEGIN
  IF NOT public.novatrade_rls_member_context() THEN
    RETURN;
  END IF;
  IF v_key_hash IS NULL OR v_key_hash !~ '^[0-9a-f]{64}$' THEN
    RETURN;
  END IF;

  RETURN QUERY
    SELECT pg_catalog.jsonb_build_object(
      'idempotencyKeyHash', journal.idempotency_key_hash,
      'inputHash', journal.input_hash,
      'tenantId', journal.tenant_id::pg_catalog.text,
      'actorMembershipId', journal.actor_membership_id::pg_catalog.text,
      'actorRoleBindingId', journal.actor_role_binding_id::pg_catalog.text,
      'operation', journal.operation,
      'targetMembershipId', journal.target_membership_id::pg_catalog.text,
      'replacementMembershipId', journal.replacement_membership_id::pg_catalog.text,
      'result', journal.result_json
    )
    FROM public.tenant_membership_mutation_journal AS journal
    WHERE journal.idempotency_key_hash = v_key_hash
      AND journal.tenant_id::pg_catalog.text = v_tenant_id
      AND journal.actor_membership_id::pg_catalog.text = v_membership_id
      AND journal.status = 'completed';
END;
$$;

COMMENT ON FUNCTION public.novatrade_membership_journal_find(pg_catalog.text) IS
  'L-02 member-context journal lookup; returns the completed reservation entry bound to the installed tenant and actor membership, else zero rows.';
REVOKE ALL ON FUNCTION public.novatrade_membership_journal_find(pg_catalog.text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.novatrade_membership_journal_find(pg_catalog.text) FROM anon;
REVOKE ALL ON FUNCTION public.novatrade_membership_journal_find(pg_catalog.text) FROM authenticated;

-- Idempotency reservation, mirroring the SQLite port's find/insert race
-- handling plus the local invite hard cap (100 invite operations per tenant
-- per rolling 24 hours). Tenant, actor membership, and actor binding are
-- bound to the member GUCs — a caller cannot reserve another member's lane.
CREATE OR REPLACE FUNCTION public.novatrade_membership_journal_reserve(
  p_request pg_catalog.text
)
RETURNS TABLE (outcome pg_catalog.text)
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
DECLARE
  v_request pg_catalog.jsonb := p_request::pg_catalog.jsonb;
  v_key_hash pg_catalog.text := v_request ->> 'idempotencyKeyHash';
  v_input_hash pg_catalog.text := v_request ->> 'inputHash';
  v_tenant pg_catalog.text := v_request ->> 'tenantId';
  v_actor pg_catalog.text := v_request ->> 'actorMembershipId';
  v_binding pg_catalog.text := v_request ->> 'actorRoleBindingId';
  v_operation pg_catalog.text := v_request ->> 'operation';
  v_target pg_catalog.text := v_request ->> 'targetMembershipId';
  v_replacement pg_catalog.text := v_request ->> 'replacementMembershipId';
  v_guc_tenant pg_catalog.text := coalesce(pg_catalog.current_setting('app.tenant_id', true), '');
  v_guc_membership pg_catalog.text := coalesce(pg_catalog.current_setting('app.membership_id', true), '');
  v_guc_binding pg_catalog.text := coalesce(pg_catalog.current_setting('app.role_binding_id', true), '');
  v_existing public.tenant_membership_mutation_journal%ROWTYPE;
  v_invite_count pg_catalog.int8;
BEGIN
  IF NOT public.novatrade_rls_member_context() THEN
    RETURN QUERY SELECT 'denied'::pg_catalog.text;
    RETURN;
  END IF;

  IF v_key_hash IS NULL OR v_key_hash !~ '^[0-9a-f]{64}$'
     OR v_input_hash IS NULL OR v_input_hash !~ '^[0-9a-f]{64}$'
     OR v_tenant IS NULL OR v_tenant !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
     OR v_actor IS NULL OR v_actor !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
     OR v_binding IS NULL OR v_binding !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
     OR v_operation IS NULL OR v_operation NOT IN (
       'invite', 'assign_role', 'assign_workspace',
       'disable', 'reactivate', 'revoke', 'remove')
     OR (v_operation = 'invite' AND (v_target IS NOT NULL OR v_replacement IS NOT NULL))
     OR (v_operation <> 'invite' AND (v_target IS NULL
        OR v_target !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'))
     OR (v_replacement IS NOT NULL
        AND v_replacement !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$')
  THEN
    RETURN QUERY SELECT 'invalid_request'::pg_catalog.text;
    RETURN;
  END IF;

  IF v_tenant IS DISTINCT FROM v_guc_tenant
     OR v_actor IS DISTINCT FROM v_guc_membership
     OR v_binding IS DISTINCT FROM v_guc_binding THEN
    RETURN QUERY SELECT 'denied'::pg_catalog.text;
    RETURN;
  END IF;

  SELECT * INTO v_existing
  FROM public.tenant_membership_mutation_journal AS journal
  WHERE journal.idempotency_key_hash = v_key_hash;
  IF FOUND THEN
    IF v_existing.input_hash IS DISTINCT FROM v_input_hash
       OR v_existing.tenant_id::pg_catalog.text IS DISTINCT FROM v_tenant
       OR v_existing.actor_membership_id::pg_catalog.text IS DISTINCT FROM v_actor
       OR v_existing.actor_role_binding_id::pg_catalog.text IS DISTINCT FROM v_binding
       OR v_existing.operation IS DISTINCT FROM v_operation
       OR v_existing.target_membership_id::pg_catalog.text IS DISTINCT FROM v_target
       OR v_existing.replacement_membership_id::pg_catalog.text IS DISTINCT FROM v_replacement THEN
      RETURN QUERY SELECT 'conflict'::pg_catalog.text;
      RETURN;
    END IF;
    IF v_existing.status = 'completed' THEN
      RETURN QUERY SELECT 'completed'::pg_catalog.text;
      RETURN;
    END IF;
    RETURN QUERY SELECT 'in_progress'::pg_catalog.text;
    RETURN;
  END IF;

  -- The invite hard cap lives in the reservation lane, exactly like the
  -- SQLite backend: it bounds journal growth, not roster size.
  IF v_operation = 'invite' THEN
    SELECT pg_catalog.count(*) INTO v_invite_count
    FROM public.tenant_membership_mutation_journal AS journal
    WHERE journal.tenant_id::pg_catalog.text = v_guc_tenant
      AND journal.operation = 'invite'
      AND journal.created_at >= pg_catalog.now() - INTERVAL '24 hours';
    IF v_invite_count >= 100 THEN
      RETURN QUERY SELECT 'policy_blocked'::pg_catalog.text;
      RETURN;
    END IF;
  END IF;

  INSERT INTO public.tenant_membership_mutation_journal (
    idempotency_key_hash, input_hash, tenant_id, actor_membership_id,
    actor_role_binding_id, operation, target_membership_id,
    replacement_membership_id
  ) VALUES (
    v_key_hash, v_input_hash, v_tenant::pg_catalog.uuid, v_actor::pg_catalog.uuid,
    v_binding::pg_catalog.uuid, v_operation,
    CASE WHEN v_target IS NULL THEN NULL ELSE v_target::pg_catalog.uuid END,
    CASE WHEN v_replacement IS NULL THEN NULL ELSE v_replacement::pg_catalog.uuid END
  )
  ON CONFLICT (idempotency_key_hash) DO NOTHING;

  IF FOUND THEN
    RETURN QUERY SELECT 'reserved'::pg_catalog.text;
    RETURN;
  END IF;

  -- Lost the insert race: re-read and report the holder's state.
  SELECT * INTO v_existing
  FROM public.tenant_membership_mutation_journal AS journal
  WHERE journal.idempotency_key_hash = v_key_hash;
  IF NOT FOUND
     OR v_existing.input_hash IS DISTINCT FROM v_input_hash
     OR v_existing.tenant_id::pg_catalog.text IS DISTINCT FROM v_tenant
     OR v_existing.actor_membership_id::pg_catalog.text IS DISTINCT FROM v_actor
     OR v_existing.actor_role_binding_id::pg_catalog.text IS DISTINCT FROM v_binding
     OR v_existing.operation IS DISTINCT FROM v_operation
     OR v_existing.target_membership_id::pg_catalog.text IS DISTINCT FROM v_target
     OR v_existing.replacement_membership_id::pg_catalog.text IS DISTINCT FROM v_replacement THEN
    RETURN QUERY SELECT 'conflict'::pg_catalog.text;
    RETURN;
  END IF;
  IF v_existing.status = 'completed' THEN
    RETURN QUERY SELECT 'completed'::pg_catalog.text;
    RETURN;
  END IF;
  RETURN QUERY SELECT 'in_progress'::pg_catalog.text;
END;
$$;

COMMENT ON FUNCTION public.novatrade_membership_journal_reserve(pg_catalog.text) IS
  'L-02 member-context journal reservation; binds tenant/actor/binding to the member GUCs, enforces the 100-invites-per-24h cap, and reports reserved/completed/in_progress/conflict without cross-lane disclosure.';
REVOKE ALL ON FUNCTION public.novatrade_membership_journal_reserve(pg_catalog.text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.novatrade_membership_journal_reserve(pg_catalog.text) FROM anon;
REVOKE ALL ON FUNCTION public.novatrade_membership_journal_reserve(pg_catalog.text) FROM authenticated;

-- Post-mutation accepted-context proof. The pre-mutation functions re-run
-- novatrade_rls_member_context(), but the completion/audit lane runs after
-- the mutation — and a self-demotion, self-revoke, or self-remove revokes
-- the actor's own role binding (or tombstones the membership) inside the
-- same transaction, which kills the live-context check even though the
-- context legitimately authorised the mutation. Membership and binding
-- rows are never deleted (status tombstones / revoked_at), so requiring
-- the rows behind the GUCs to exist — with role, auth-identity, and
-- workspace agreement — still proves the GUC set was a real accepted
-- context while remaining callable after the mutation it authorised.
CREATE OR REPLACE FUNCTION public.novatrade_membership_actor_ctx_valid()
RETURNS pg_catalog.bool
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
DECLARE
  v_guc_tenant pg_catalog.text := coalesce(pg_catalog.current_setting('app.tenant_id', true), '');
  v_guc_workspace pg_catalog.text := coalesce(pg_catalog.current_setting('app.workspace_id', true), '');
  v_guc_actor pg_catalog.text := coalesce(pg_catalog.current_setting('app.actor_id', true), '');
  v_guc_membership pg_catalog.text := coalesce(pg_catalog.current_setting('app.membership_id', true), '');
  v_guc_role pg_catalog.text := coalesce(pg_catalog.current_setting('app.role', true), '');
  v_guc_binding pg_catalog.text := coalesce(pg_catalog.current_setting('app.role_binding_id', true), '');
  v_guc_correlation pg_catalog.text := coalesce(pg_catalog.current_setting('app.correlation_id', true), '');
BEGIN
  IF v_guc_tenant !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
     OR v_guc_actor !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
     OR v_guc_membership !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
     OR v_guc_binding !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
     OR (v_guc_workspace <> ''
         AND v_guc_workspace !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$')
     OR v_guc_role NOT IN (
       'owner', 'admin', 'strategist_manager', 'researcher',
       'reviewer', 'outreach_operator', 'analyst_read_only')
     OR v_guc_correlation = ''
  THEN
    RETURN false;
  END IF;

  RETURN EXISTS (
    SELECT 1
    FROM public.tenant_role_bindings AS binding
    JOIN public.tenant_memberships AS membership
      ON membership.tenant_id = binding.tenant_id
     AND membership.id = binding.membership_id
    WHERE binding.tenant_id::pg_catalog.text = v_guc_tenant
      AND binding.id::pg_catalog.text = v_guc_binding
      AND binding.membership_id::pg_catalog.text = v_guc_membership
      AND binding.role = v_guc_role
      AND membership.auth_identity_id::pg_catalog.text = v_guc_actor
      AND membership.workspace_id::pg_catalog.text IS NOT DISTINCT FROM
        NULLIF(v_guc_workspace, ''));
END;
$$;

COMMENT ON FUNCTION public.novatrade_membership_actor_ctx_valid() IS
  'L-02 internal post-mutation context proof; accepts when the installed member GUCs still resolve to real membership+binding rows (revoked/tombstoned included) with role, auth-identity, and workspace agreement.';
REVOKE ALL ON FUNCTION public.novatrade_membership_actor_ctx_valid() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.novatrade_membership_actor_ctx_valid() FROM anon;
REVOKE ALL ON FUNCTION public.novatrade_membership_actor_ctx_valid() FROM authenticated;

-- Journal completion: the same CAS shape as the SQLite port — every reserved
-- field must still match and the row must still be 'reserved'.
CREATE OR REPLACE FUNCTION public.novatrade_membership_journal_complete(
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
  v_key_hash pg_catalog.text := v_request ->> 'idempotencyKeyHash';
  v_input_hash pg_catalog.text := v_request ->> 'inputHash';
  v_tenant pg_catalog.text := v_request ->> 'tenantId';
  v_actor pg_catalog.text := v_request ->> 'actorMembershipId';
  v_binding pg_catalog.text := v_request ->> 'actorRoleBindingId';
  v_operation pg_catalog.text := v_request ->> 'operation';
  v_target pg_catalog.text := v_request ->> 'targetMembershipId';
  v_replacement pg_catalog.text := v_request ->> 'replacementMembershipId';
  v_effective_at pg_catalog.text := v_request ->> 'effectiveAt';
  v_result pg_catalog.jsonb := v_request -> 'result';
  v_guc_tenant pg_catalog.text := coalesce(pg_catalog.current_setting('app.tenant_id', true), '');
  v_guc_membership pg_catalog.text := coalesce(pg_catalog.current_setting('app.membership_id', true), '');
  v_guc_binding pg_catalog.text := coalesce(pg_catalog.current_setting('app.role_binding_id', true), '');
  v_updated pg_catalog.int4;
BEGIN
  IF NOT public.novatrade_membership_actor_ctx_valid() THEN
    RETURN QUERY SELECT false;
    RETURN;
  END IF;

  IF v_key_hash IS NULL OR v_key_hash !~ '^[0-9a-f]{64}$'
     OR v_input_hash IS NULL OR v_input_hash !~ '^[0-9a-f]{64}$'
     OR v_tenant IS NULL OR v_tenant IS DISTINCT FROM v_guc_tenant
     OR v_actor IS NULL OR v_actor IS DISTINCT FROM v_guc_membership
     OR v_binding IS NULL OR v_binding IS DISTINCT FROM v_guc_binding
     OR v_operation IS NULL OR v_operation NOT IN (
       'invite', 'assign_role', 'assign_workspace',
       'disable', 'reactivate', 'revoke', 'remove')
     OR v_target IS NULL OR v_target !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
     OR (v_replacement IS NOT NULL
        AND v_replacement !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$')
     OR v_effective_at IS NULL
        OR v_effective_at !~ '^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$'
     OR v_result IS NULL OR pg_catalog.jsonb_typeof(v_result) <> 'object'
  THEN
    RETURN QUERY SELECT false;
    RETURN;
  END IF;

  -- effectiveAt is the transaction-start instant by adapter design, so
  -- now() is the same moment at microsecond precision — the millisecond-
  -- truncated ISO value would land just under created_at and trip the
  -- timestamps check constraint.
  UPDATE public.tenant_membership_mutation_journal AS journal
  SET status = 'completed',
      target_membership_id = v_target::pg_catalog.uuid,
      result_json = v_result,
      completed_at = pg_catalog.now()
  WHERE journal.idempotency_key_hash = v_key_hash
    AND journal.input_hash = v_input_hash
    AND journal.tenant_id::pg_catalog.text = v_tenant
    AND journal.actor_membership_id::pg_catalog.text = v_actor
    AND journal.actor_role_binding_id::pg_catalog.text = v_binding
    AND journal.operation = v_operation
    AND journal.status = 'reserved'
    AND journal.target_membership_id IS NOT DISTINCT FROM
      CASE WHEN v_operation = 'invite' THEN NULL ELSE v_target::pg_catalog.uuid END
    AND journal.replacement_membership_id IS NOT DISTINCT FROM
      CASE WHEN v_replacement IS NULL THEN NULL ELSE v_replacement::pg_catalog.uuid END;
  GET DIAGNOSTICS v_updated = ROW_COUNT;

  RETURN QUERY SELECT v_updated = 1;
END;
$$;

COMMENT ON FUNCTION public.novatrade_membership_journal_complete(pg_catalog.text) IS
  'L-02 member-context journal completion; CAS-marks the matching reservation completed with the result payload and operation timestamp.';
REVOKE ALL ON FUNCTION public.novatrade_membership_journal_complete(pg_catalog.text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.novatrade_membership_journal_complete(pg_catalog.text) FROM anon;
REVOKE ALL ON FUNCTION public.novatrade_membership_journal_complete(pg_catalog.text) FROM authenticated;

-- Pending-membership creation (the invite write). Tenant and inviter are
-- bound to the member GUCs; a workspace assignment must name an in-tenant
-- workspace. The role binding opens with reason_code 'invitation' exactly
-- like the SQLite insert.
CREATE OR REPLACE FUNCTION public.novatrade_membership_create_pending(
  p_request pg_catalog.text
)
RETURNS TABLE (record pg_catalog.jsonb)
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
DECLARE
  v_request pg_catalog.jsonb := p_request::pg_catalog.jsonb;
  v_membership_id pg_catalog.text := v_request ->> 'membershipId';
  v_tenant pg_catalog.text := v_request ->> 'tenantId';
  v_pending_hash pg_catalog.text := v_request ->> 'pendingIdentityRefHash';
  v_workspace pg_catalog.text := v_request ->> 'workspaceId';
  v_invited_by pg_catalog.text := v_request ->> 'invitedByMembershipId';
  v_role pg_catalog.text := v_request ->> 'role';
  v_effective_at pg_catalog.text := v_request ->> 'effectiveAt';
  v_guc_tenant pg_catalog.text := coalesce(pg_catalog.current_setting('app.tenant_id', true), '');
  v_guc_membership pg_catalog.text := coalesce(pg_catalog.current_setting('app.membership_id', true), '');
BEGIN
  IF NOT public.novatrade_rls_member_context() THEN
    RETURN;
  END IF;

  IF v_membership_id IS NULL OR v_membership_id !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
     OR v_tenant IS NULL OR v_tenant IS DISTINCT FROM v_guc_tenant
     OR v_pending_hash IS NULL OR v_pending_hash !~ '^[0-9a-f]{64}$'
     OR v_invited_by IS NULL OR v_invited_by IS DISTINCT FROM v_guc_membership
     OR v_role IS NULL OR v_role NOT IN (
       'owner', 'admin', 'strategist_manager', 'researcher', 'reviewer',
       'outreach_operator', 'analyst_read_only')
     OR v_effective_at IS NULL
        OR v_effective_at !~ '^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$'
     OR (v_workspace IS NOT NULL AND (
       v_workspace !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
       OR NOT EXISTS (
         SELECT 1 FROM public.workspaces AS workspace
         WHERE workspace.tenant_id::pg_catalog.text = v_guc_tenant
           AND workspace.id::pg_catalog.text = v_workspace)))
  THEN
    RETURN;
  END IF;

  INSERT INTO public.tenant_memberships (
    id, tenant_id, auth_identity_id, pending_identity_ref_hash, workspace_id,
    status, invited_by_membership_id, created_at, updated_at
  ) VALUES (
    v_membership_id::pg_catalog.uuid,
    v_guc_tenant::pg_catalog.uuid,
    NULL,
    v_pending_hash,
    CASE WHEN v_workspace IS NULL THEN NULL ELSE v_workspace::pg_catalog.uuid END,
    'pending',
    v_guc_membership::pg_catalog.uuid,
    v_effective_at::pg_catalog.timestamptz,
    v_effective_at::pg_catalog.timestamptz
  );

  INSERT INTO public.tenant_role_bindings (
    id, tenant_id, membership_id, role, created_at, valid_from, revoked_at,
    assigned_by_membership_id, reason_code
  ) VALUES (
    pg_catalog.gen_random_uuid(),
    v_guc_tenant::pg_catalog.uuid,
    v_membership_id::pg_catalog.uuid,
    v_role,
    v_effective_at::pg_catalog.timestamptz,
    v_effective_at::pg_catalog.timestamptz,
    NULL,
    v_guc_membership::pg_catalog.uuid,
    'invitation'
  );

  RETURN QUERY
    SELECT public.novatrade_membership_snapshot_json(
      v_guc_tenant::pg_catalog.uuid, v_membership_id::pg_catalog.uuid);
END;
$$;

COMMENT ON FUNCTION public.novatrade_membership_create_pending(pg_catalog.text) IS
  'L-02 member-context pending-membership creation; binds tenant/inviter to the member GUCs, requires an in-tenant workspace when scoped, and returns the canonical snapshot.';
REVOKE ALL ON FUNCTION public.novatrade_membership_create_pending(pg_catalog.text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.novatrade_membership_create_pending(pg_catalog.text) FROM anon;
REVOKE ALL ON FUNCTION public.novatrade_membership_create_pending(pg_catalog.text) FROM authenticated;

-- Target mutation: expected-state revalidation, the last-owner guard, the
-- atomic replacement-owner promotion, the status/workspace CAS, and the role
-- binding edges — one function so the whole transition shares the membership
-- row lock. Outcomes:
--   applied        → mutation committed; target/replacement snapshots returned
--   state_conflict → expected status/workspace/binding no longer matches
--   owner_guard    → the mutation would strand or misuse the last owner
--   denied         → member context absent or GUC binding mismatch
--   invalid_request→ malformed payload
CREATE OR REPLACE FUNCTION public.novatrade_membership_apply_mutation(
  p_request pg_catalog.text
)
RETURNS TABLE (
  outcome pg_catalog.text,
  target pg_catalog.jsonb,
  replacement pg_catalog.jsonb
)
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
DECLARE
  v_request pg_catalog.jsonb := p_request::pg_catalog.jsonb;
  v_target_id pg_catalog.text := v_request ->> 'targetMembershipId';
  v_actor pg_catalog.text := v_request ->> 'actorMembershipId';
  v_expected_statuses pg_catalog.jsonb := v_request -> 'expectedStatus';
  v_has_status pg_catalog.bool := v_request ? 'status';
  v_status pg_catalog.text := v_request ->> 'status';
  v_has_workspace pg_catalog.bool := v_request ? 'workspaceId';
  v_workspace pg_catalog.text := v_request ->> 'workspaceId';
  v_role_change pg_catalog.jsonb := v_request -> 'roleChange';
  v_replacement_id pg_catalog.text := v_request ->> 'replacementOwnerMembershipId';
  v_expected_workspace pg_catalog.text := v_request ->> 'expectedWorkspaceId';
  v_expected_binding_id pg_catalog.text := v_request ->> 'expectedCurrentRoleBindingId';
  v_expected_role pg_catalog.text := v_request ->> 'expectedCurrentRole';
  v_effective_at pg_catalog.text := v_request ->> 'effectiveAt';
  v_guc_tenant pg_catalog.text := coalesce(pg_catalog.current_setting('app.tenant_id', true), '');
  v_guc_membership pg_catalog.text := coalesce(pg_catalog.current_setting('app.membership_id', true), '');
  v_current public.tenant_memberships%ROWTYPE;
  v_binding public.tenant_role_bindings%ROWTYPE;
  v_candidate public.tenant_memberships%ROWTYPE;
  v_candidate_binding public.tenant_role_bindings%ROWTYPE;
  v_loses_owner pg_catalog.bool;
  v_owner_count pg_catalog.int8;
  v_updated pg_catalog.int4;
BEGIN
  IF NOT public.novatrade_rls_member_context() THEN
    RETURN QUERY SELECT 'denied'::pg_catalog.text, NULL::pg_catalog.jsonb, NULL::pg_catalog.jsonb;
    RETURN;
  END IF;

  IF v_target_id IS NULL OR v_target_id !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
     OR v_actor IS NULL OR v_actor !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
     OR v_expected_statuses IS NULL OR pg_catalog.jsonb_typeof(v_expected_statuses) <> 'array'
        OR pg_catalog.jsonb_array_length(v_expected_statuses) < 1
     OR (v_has_status AND (v_status IS NULL OR v_status NOT IN (
       'pending', 'active', 'suspended', 'disabled', 'revoked', 'removed', 'expired')))
     OR (v_has_workspace AND v_workspace IS NOT NULL
        AND v_workspace !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$')
     OR (v_role_change IS NOT NULL AND (
       pg_catalog.jsonb_typeof(v_role_change) <> 'object'
       OR v_role_change ->> 'kind' IS NULL
       OR v_role_change ->> 'kind' NOT IN ('replace', 'revoke', 'keep')
       OR (v_role_change ->> 'kind' = 'replace' AND (v_role_change ->> 'role') IS NULL)
       OR (v_role_change ->> 'kind' = 'replace' AND (v_role_change ->> 'role') NOT IN (
         'owner', 'admin', 'strategist_manager', 'researcher', 'reviewer',
         'outreach_operator', 'analyst_read_only'))))
     OR (v_replacement_id IS NOT NULL
        AND v_replacement_id !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$')
     OR (v_expected_workspace IS NOT NULL
        AND v_expected_workspace !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$')
     OR (v_expected_binding_id IS NOT NULL
        AND v_expected_binding_id !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$')
     OR (v_expected_role IS NOT NULL AND v_expected_role NOT IN (
       'owner', 'admin', 'strategist_manager', 'researcher', 'reviewer',
       'outreach_operator', 'analyst_read_only'))
     OR v_effective_at IS NULL
        OR v_effective_at !~ '^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$'
  THEN
    RETURN QUERY SELECT 'invalid_request'::pg_catalog.text, NULL::pg_catalog.jsonb, NULL::pg_catalog.jsonb;
    RETURN;
  END IF;

  IF v_actor IS DISTINCT FROM v_guc_membership THEN
    RETURN QUERY SELECT 'denied'::pg_catalog.text, NULL::pg_catalog.jsonb, NULL::pg_catalog.jsonb;
    RETURN;
  END IF;

  -- Lock the target row for the whole transition; the CAS below re-proves
  -- the expected state anyway, the lock just serializes concurrent writers.
  SELECT * INTO v_current
  FROM public.tenant_memberships AS membership
  WHERE membership.tenant_id::pg_catalog.text = v_guc_tenant
    AND membership.id::pg_catalog.text = v_target_id
  FOR UPDATE;

  SELECT * INTO v_binding
  FROM public.tenant_role_bindings AS binding
  WHERE binding.tenant_id::pg_catalog.text = v_guc_tenant
    AND binding.membership_id::pg_catalog.text = v_target_id
    AND binding.revoked_at IS NULL;

  -- FOUND reflects the binding SELECT, so existence is checked on the row.
  IF v_current.id IS NULL
     OR NOT (v_current.status = ANY (
       SELECT pg_catalog.jsonb_array_elements_text(v_expected_statuses)))
     OR v_current.workspace_id::pg_catalog.text IS DISTINCT FROM v_expected_workspace
     OR (v_binding.id IS NULL) <> (v_expected_binding_id IS NULL)
     OR (v_binding.id IS NOT NULL AND v_binding.id::pg_catalog.text IS DISTINCT FROM v_expected_binding_id)
     OR (v_binding.role IS NULL) <> (v_expected_role IS NULL)
     OR (v_binding.role IS NOT NULL AND v_binding.role IS DISTINCT FROM v_expected_role)
  THEN
    RETURN QUERY SELECT 'state_conflict'::pg_catalog.text, NULL::pg_catalog.jsonb, NULL::pg_catalog.jsonb;
    RETURN;
  END IF;

  -- Last-owner guard: demoting, disabling, revoking, or removing the sole
  -- active owner requires an atomic replacement promotion.
  v_loses_owner := v_current.status = 'active' AND v_binding.role = 'owner'
    AND ((v_role_change IS NOT NULL AND v_role_change ->> 'kind' = 'replace'
          AND v_role_change ->> 'role' IS DISTINCT FROM 'owner')
      OR v_status IN ('disabled', 'revoked', 'removed'));
  SELECT pg_catalog.count(*) INTO v_owner_count
  FROM public.tenant_memberships AS membership
  JOIN public.tenant_role_bindings AS binding
    ON binding.tenant_id = membership.tenant_id
   AND binding.membership_id = membership.id
   AND binding.revoked_at IS NULL
   AND binding.role = 'owner'
  WHERE membership.tenant_id::pg_catalog.text = v_guc_tenant
    AND membership.status = 'active';
  IF v_loses_owner AND v_owner_count = 1 AND v_replacement_id IS NULL THEN
    RETURN QUERY SELECT 'owner_guard'::pg_catalog.text, NULL::pg_catalog.jsonb, NULL::pg_catalog.jsonb;
    RETURN;
  END IF;

  IF v_replacement_id IS NOT NULL THEN
    SELECT * INTO v_candidate
    FROM public.tenant_memberships AS membership
    WHERE membership.tenant_id::pg_catalog.text = v_guc_tenant
      AND membership.id::pg_catalog.text = v_replacement_id
    FOR UPDATE;
    SELECT * INTO v_candidate_binding
    FROM public.tenant_role_bindings AS binding
    WHERE binding.tenant_id::pg_catalog.text = v_guc_tenant
      AND binding.membership_id::pg_catalog.text = v_replacement_id
      AND binding.revoked_at IS NULL;
    IF v_candidate.id IS NULL
       OR NOT v_loses_owner
       OR v_candidate.id::pg_catalog.text = v_target_id
       OR v_candidate.status IS DISTINCT FROM 'active'
       OR v_candidate_binding.id IS NULL
       OR v_candidate_binding.role = 'owner' THEN
      RETURN QUERY SELECT 'owner_guard'::pg_catalog.text, NULL::pg_catalog.jsonb, NULL::pg_catalog.jsonb;
      RETURN;
    END IF;

    UPDATE public.tenant_role_bindings AS binding
    SET revoked_at = v_effective_at::pg_catalog.timestamptz
    WHERE binding.tenant_id::pg_catalog.text = v_guc_tenant
      AND binding.id = v_candidate_binding.id
      AND binding.membership_id = v_candidate_binding.membership_id
      AND binding.revoked_at IS NULL
      AND binding.role = v_candidate_binding.role;
    GET DIAGNOSTICS v_updated = ROW_COUNT;
    IF v_updated <> 1 THEN
      RETURN QUERY SELECT 'state_conflict'::pg_catalog.text, NULL::pg_catalog.jsonb, NULL::pg_catalog.jsonb;
      RETURN;
    END IF;
    INSERT INTO public.tenant_role_bindings (
      id, tenant_id, membership_id, role, created_at, valid_from, revoked_at,
      assigned_by_membership_id, reason_code
    ) VALUES (
      pg_catalog.gen_random_uuid(), v_guc_tenant::pg_catalog.uuid,
      v_candidate.id, 'owner',
      v_effective_at::pg_catalog.timestamptz,
      v_effective_at::pg_catalog.timestamptz,
      NULL, v_guc_membership::pg_catalog.uuid, 'owner_replacement'
    );
    -- The touch update stamps updated_at via the memberships guard trigger.
    UPDATE public.tenant_memberships AS membership
    SET updated_at = v_effective_at::pg_catalog.timestamptz
    WHERE membership.tenant_id::pg_catalog.text = v_guc_tenant
      AND membership.id = v_candidate.id
      AND membership.status = 'active';
    GET DIAGNOSTICS v_updated = ROW_COUNT;
    IF v_updated <> 1 THEN
      RETURN QUERY SELECT 'state_conflict'::pg_catalog.text, NULL::pg_catalog.jsonb, NULL::pg_catalog.jsonb;
      RETURN;
    END IF;
  END IF;

  UPDATE public.tenant_memberships AS membership
  SET status = CASE WHEN v_has_status THEN v_status ELSE membership.status END,
      workspace_id = CASE WHEN v_has_workspace
        THEN v_workspace::pg_catalog.uuid ELSE membership.workspace_id END,
      updated_at = v_effective_at::pg_catalog.timestamptz
  WHERE membership.tenant_id::pg_catalog.text = v_guc_tenant
    AND membership.id = v_current.id
    AND membership.status = v_current.status
    AND membership.workspace_id IS NOT DISTINCT FROM v_current.workspace_id;
  GET DIAGNOSTICS v_updated = ROW_COUNT;
  IF v_updated <> 1 THEN
    RETURN QUERY SELECT 'state_conflict'::pg_catalog.text, NULL::pg_catalog.jsonb, NULL::pg_catalog.jsonb;
    RETURN;
  END IF;

  IF v_role_change IS NOT NULL AND v_role_change ->> 'kind' = 'replace' THEN
    IF v_binding.id IS NULL THEN
      RETURN QUERY SELECT 'state_conflict'::pg_catalog.text, NULL::pg_catalog.jsonb, NULL::pg_catalog.jsonb;
      RETURN;
    END IF;
    UPDATE public.tenant_role_bindings AS binding
    SET revoked_at = v_effective_at::pg_catalog.timestamptz
    WHERE binding.tenant_id::pg_catalog.text = v_guc_tenant
      AND binding.id = v_binding.id
      AND binding.membership_id = v_binding.membership_id
      AND binding.revoked_at IS NULL
      AND binding.role = v_binding.role;
    GET DIAGNOSTICS v_updated = ROW_COUNT;
    IF v_updated <> 1 THEN
      RETURN QUERY SELECT 'state_conflict'::pg_catalog.text, NULL::pg_catalog.jsonb, NULL::pg_catalog.jsonb;
      RETURN;
    END IF;
    INSERT INTO public.tenant_role_bindings (
      id, tenant_id, membership_id, role, created_at, valid_from, revoked_at,
      assigned_by_membership_id, reason_code
    ) VALUES (
      pg_catalog.gen_random_uuid(), v_guc_tenant::pg_catalog.uuid,
      v_current.id, v_role_change ->> 'role',
      v_effective_at::pg_catalog.timestamptz,
      v_effective_at::pg_catalog.timestamptz,
      NULL, v_guc_membership::pg_catalog.uuid, 'role_change'
    );
  ELSIF v_role_change IS NOT NULL AND v_role_change ->> 'kind' = 'revoke' AND v_binding.id IS NOT NULL THEN
    UPDATE public.tenant_role_bindings AS binding
    SET revoked_at = v_effective_at::pg_catalog.timestamptz
    WHERE binding.tenant_id::pg_catalog.text = v_guc_tenant
      AND binding.id = v_binding.id
      AND binding.membership_id = v_binding.membership_id
      AND binding.revoked_at IS NULL
      AND binding.role = v_binding.role;
    GET DIAGNOSTICS v_updated = ROW_COUNT;
    IF v_updated <> 1 THEN
      RETURN QUERY SELECT 'state_conflict'::pg_catalog.text, NULL::pg_catalog.jsonb, NULL::pg_catalog.jsonb;
      RETURN;
    END IF;
  END IF;

  RETURN QUERY SELECT
    'applied'::pg_catalog.text,
    public.novatrade_membership_snapshot_json(v_guc_tenant::pg_catalog.uuid, v_current.id),
    CASE WHEN v_candidate.id IS NULL THEN NULL
      ELSE public.novatrade_membership_snapshot_json(v_guc_tenant::pg_catalog.uuid, v_candidate.id) END;
END;
$$;

COMMENT ON FUNCTION public.novatrade_membership_apply_mutation(pg_catalog.text) IS
  'L-02 member-context membership mutation; revalidates expected state under the target row lock, enforces the last-owner guard with atomic replacement promotion, applies the status/workspace CAS and role-binding edges, and returns both snapshots.';
REVOKE ALL ON FUNCTION public.novatrade_membership_apply_mutation(pg_catalog.text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.novatrade_membership_apply_mutation(pg_catalog.text) FROM anon;
REVOKE ALL ON FUNCTION public.novatrade_membership_apply_mutation(pg_catalog.text) FROM authenticated;

-- Member-layer audit append for 'tenant.membership.mutated'. Every actor and
-- scope column is bound to the member GUCs; the payload's actor/tenant/
-- correlation fields must agree with the context (a mismatch is a fabricated
-- event and refuses). The metadata is the service-computed event verbatim.
CREATE OR REPLACE FUNCTION public.novatrade_membership_audit_append(
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
  v_guc_correlation pg_catalog.text := coalesce(pg_catalog.current_setting('app.correlation_id', true), '');
  v_after_workspace pg_catalog.text := v_event -> 'after' ->> 'workspaceId';
  v_target_id pg_catalog.text := v_event ->> 'targetMembershipId';
BEGIN
  IF NOT public.novatrade_membership_actor_ctx_valid() THEN
    RETURN QUERY SELECT false;
    RETURN;
  END IF;

  IF v_event IS NULL OR pg_catalog.jsonb_typeof(v_event) <> 'object'
     OR v_event ->> 'action' IS DISTINCT FROM 'tenant.membership.mutated'
     OR v_event ->> 'tenantId' IS DISTINCT FROM v_guc_tenant
     OR v_event -> 'actor' ->> 'authIdentityId' IS DISTINCT FROM v_guc_actor
     OR v_event -> 'actor' ->> 'membershipId' IS DISTINCT FROM v_guc_membership
     OR v_event -> 'actor' ->> 'role' IS DISTINCT FROM v_guc_role
     OR v_event -> 'actor' ->> 'roleBindingId' IS DISTINCT FROM v_guc_binding
     -- The event's correlationId is the command's own correlation, not the
     -- ambient context correlation: production callers wrap mutations in an
     -- ambient 'membership-admin:{op}:{requestId}' context while the command
     -- carries e.g. 'membership-role:{requestId}'. The ledger records the
     -- command correlation (matching the local backend verbatim); only its
     -- shape is validated here.
     OR v_event ->> 'correlationId' IS NULL
        OR v_event ->> 'correlationId' !~ '^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$'
     OR v_target_id IS NULL
        OR v_target_id !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
     OR NOT EXISTS (
       SELECT 1 FROM public.tenant_memberships AS membership
       WHERE membership.tenant_id::pg_catalog.text = v_guc_tenant
         AND membership.id::pg_catalog.text = v_target_id)
     OR (v_after_workspace IS NOT NULL AND (
       v_after_workspace !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
       OR NOT EXISTS (
         SELECT 1 FROM public.workspaces AS workspace
         WHERE workspace.tenant_id::pg_catalog.text = v_guc_tenant
           AND workspace.id::pg_catalog.text = v_after_workspace)))
  THEN
    RETURN QUERY SELECT false;
    RETURN;
  END IF;

  INSERT INTO public.audit_logs (
    id, action, entity_type, entity_id, metadata, scope_kind,
    tenant_id, workspace_id, correlation_id,
    actor_auth_identity_id, actor_membership_id,
    actor_launch_role, actor_role_binding_id, actor_layer
  ) VALUES (
    pg_catalog.gen_random_uuid(),
    'tenant.membership.mutated',
    'tenant_membership',
    v_target_id,
    v_event,
    'tenant',
    v_guc_tenant::pg_catalog.uuid,
    CASE WHEN v_after_workspace IS NULL THEN NULL ELSE v_after_workspace::pg_catalog.uuid END,
    v_event ->> 'correlationId',
    v_guc_actor::pg_catalog.uuid,
    v_guc_membership::pg_catalog.uuid,
    v_guc_role,
    v_guc_binding::pg_catalog.uuid,
    'member'
  );

  RETURN QUERY SELECT true;
END;
$$;

COMMENT ON FUNCTION public.novatrade_membership_audit_append(pg_catalog.text) IS
  'L-02 member-context audit append for tenant.membership.mutated; binds every actor/scope column to the member GUCs, requires the event to agree with the context and name a live in-tenant target, and stores the event verbatim as metadata.';
REVOKE ALL ON FUNCTION public.novatrade_membership_audit_append(pg_catalog.text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.novatrade_membership_audit_append(pg_catalog.text) FROM anon;
REVOKE ALL ON FUNCTION public.novatrade_membership_audit_append(pg_catalog.text) FROM authenticated;
