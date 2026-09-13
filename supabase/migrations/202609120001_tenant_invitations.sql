-- 0X3-232/233: durable tenant-scoped invitation records, the invitation
-- mutation journal, and the tenant provisioning journal.
--
-- Invitations bind exactly one tenant, one pending membership, one proposed
-- role, and one expected identity reference hash. Raw invitation tokens,
-- recipient emails, and provider secrets are never stored; only
-- non-reversible references. Rows are append-only: reissue supersedes, and
-- terminal states are immutable.

CREATE TABLE public.tenant_invitations (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL
    CONSTRAINT tenant_invitations_tenant_id_fkey
    REFERENCES public.tenants (id)
    ON UPDATE RESTRICT
    ON DELETE RESTRICT,
  membership_id uuid NOT NULL,
  provisioning_request_id uuid,
  kind text NOT NULL
    CONSTRAINT tenant_invitations_kind_chk
    CHECK (kind IN ('owner', 'member')),
  role text NOT NULL
    CONSTRAINT tenant_invitations_role_chk
    CHECK (role IN (
      'owner', 'admin', 'strategist_manager', 'researcher',
      'reviewer', 'outreach_operator', 'analyst_read_only'
    )),
  workspace_id uuid,
  -- Non-reversible recipient binding; the raw identity is never stored.
  expected_identity_ref_hash text NOT NULL
    CONSTRAINT tenant_invitations_expected_identity_chk
    CHECK (expected_identity_ref_hash ~ '^[0-9a-f]{64}$'),
  -- Tenant policy generation the offer was issued under (tenant-policy-vN).
  policy_version text NOT NULL
    CONSTRAINT tenant_invitations_policy_version_chk
    CHECK (policy_version ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{2,63}$'),
  generation integer NOT NULL
    CONSTRAINT tenant_invitations_generation_chk
    CHECK (generation >= 1),
  content_hash text NOT NULL
    CONSTRAINT tenant_invitations_content_hash_chk
    CHECK (content_hash ~ '^[0-9a-f]{64}$'),
  status text NOT NULL DEFAULT 'issued'
    CONSTRAINT tenant_invitations_status_chk
    CHECK (status IN ('issued', 'accepted', 'revoked', 'superseded', 'expired')),
  delivery_state text NOT NULL DEFAULT 'queued'
    CONSTRAINT tenant_invitations_delivery_state_chk
    CHECK (delivery_state IN ('queued', 'delivered', 'delivery_failed')),
  delivery_adapter text
    CONSTRAINT tenant_invitations_delivery_adapter_chk
    CHECK (delivery_adapter IS NULL OR delivery_adapter ~ '^[a-z0-9][a-z0-9._-]{1,79}$'),
  delivery_ref_hash text
    CONSTRAINT tenant_invitations_delivery_ref_chk
    CHECK (delivery_ref_hash IS NULL OR delivery_ref_hash ~ '^[0-9a-f]{64}$'),
  delivery_detail text
    CONSTRAINT tenant_invitations_delivery_detail_chk
    CHECK (delivery_detail IS NULL OR length(delivery_detail) BETWEEN 1 AND 240),
  issued_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  accepted_at timestamptz,
  accepted_auth_identity_id uuid,
  revoked_at timestamptz,
  revoked_reason_code text
    CONSTRAINT tenant_invitations_revoked_reason_chk
    CHECK (revoked_reason_code IS NULL OR revoked_reason_code ~ '^[a-z0-9][a-z0-9._-]{2,79}$'),
  superseded_by_invitation_id uuid,
  correlation_id text NOT NULL
    CONSTRAINT tenant_invitations_correlation_chk
    CHECK (correlation_id ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$'),
  audit_event_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT pg_catalog.now(),
  updated_at timestamptz NOT NULL DEFAULT pg_catalog.now(),
  CONSTRAINT tenant_invitations_membership_fkey
    FOREIGN KEY (tenant_id, membership_id)
    REFERENCES public.tenant_memberships (tenant_id, id)
    ON UPDATE RESTRICT
    ON DELETE RESTRICT,
  CONSTRAINT tenant_invitations_workspace_fkey
    FOREIGN KEY (tenant_id, workspace_id)
    REFERENCES public.workspaces (tenant_id, id)
    ON UPDATE RESTRICT
    ON DELETE RESTRICT,
  CONSTRAINT tenant_invitations_superseded_by_fkey
    FOREIGN KEY (tenant_id, superseded_by_invitation_id)
    REFERENCES public.tenant_invitations (tenant_id, id)
    ON UPDATE RESTRICT
    ON DELETE RESTRICT
    DEFERRABLE INITIALLY DEFERRED,
  -- Tenant-aware candidate key for the journal and self-referential FKs.
  CONSTRAINT tenant_invitations_tenant_id_id_unique UNIQUE (tenant_id, id),
  CONSTRAINT tenant_invitations_generation_unique UNIQUE (tenant_id, membership_id, generation),
  CONSTRAINT tenant_invitations_expiry_chk CHECK (expires_at > issued_at),
  CONSTRAINT tenant_invitations_owner_role_chk CHECK (kind <> 'owner' OR role = 'owner'),
  CONSTRAINT tenant_invitations_accepted_facts_chk CHECK (
    CASE WHEN status = 'accepted'
      THEN accepted_at IS NOT NULL AND accepted_auth_identity_id IS NOT NULL
      ELSE accepted_at IS NULL AND accepted_auth_identity_id IS NULL
    END
  ),
  CONSTRAINT tenant_invitations_closed_facts_chk CHECK (
    CASE WHEN status IN ('revoked', 'superseded', 'expired')
      THEN revoked_at IS NOT NULL AND revoked_reason_code IS NOT NULL
      ELSE revoked_at IS NULL AND revoked_reason_code IS NULL
    END
  ),
  CONSTRAINT tenant_invitations_superseded_facts_chk CHECK (
    CASE WHEN status = 'superseded'
      THEN superseded_by_invitation_id IS NOT NULL
      ELSE superseded_by_invitation_id IS NULL
    END
  ),
  CONSTRAINT tenant_invitations_delivery_facts_chk CHECK (
    CASE WHEN delivery_state = 'queued'
      THEN delivery_adapter IS NULL
      ELSE delivery_adapter IS NOT NULL
    END
  )
);

COMMENT ON TABLE public.tenant_invitations IS
  'Durable, append-only tenant invitation. One live issued row per membership; acceptance is a compare-and-set against status, expiry, and content hash.';

COMMENT ON COLUMN public.tenant_invitations.expected_identity_ref_hash IS
  'Lowercase 64-hex digest of the expected auth identity. Raw recipient material is prohibited.';

COMMENT ON COLUMN public.tenant_invitations.content_hash IS
  'Canonical hash of the binding facts (ids, role, expected identity, policy generation, expiry). Acceptance re-checks it.';

COMMENT ON COLUMN public.tenant_invitations.delivery_ref_hash IS
  'Non-reversible provider delivery reference; raw links and tokens are prohibited.';

-- At most one live invitation per membership.
CREATE UNIQUE INDEX tenant_invitations_live_membership_unique
  ON public.tenant_invitations (tenant_id, membership_id)
  WHERE status = 'issued';

CREATE INDEX idx_tenant_invitations_tenant_status
  ON public.tenant_invitations (tenant_id, status, updated_at DESC);

CREATE INDEX idx_tenant_invitations_membership
  ON public.tenant_invitations (tenant_id, membership_id, generation);

CREATE OR REPLACE FUNCTION public.novatrade_tenant_invitations_insert_guard()
RETURNS trigger
LANGUAGE plpgsql
AS $function$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM public.tenant_memberships AS membership
    WHERE membership.tenant_id = NEW.tenant_id
      AND membership.id = NEW.membership_id
      AND membership.status = 'pending'
      AND membership.workspace_id IS NOT DISTINCT FROM NEW.workspace_id
  ) THEN
    RAISE EXCEPTION 'tenant invitation membership is not pending or workspace mismatch';
  END IF;
  IF NEW.status <> 'issued' THEN
    RAISE EXCEPTION 'tenant invitation status must start issued';
  END IF;
  IF NEW.delivery_state <> 'queued' THEN
    RAISE EXCEPTION 'tenant invitation delivery must start queued';
  END IF;
  RETURN NEW;
END;
$function$;

CREATE TRIGGER trg_novatrade_tenant_invitations_insert_guard
  BEFORE INSERT ON public.tenant_invitations
  FOR EACH ROW EXECUTE FUNCTION public.novatrade_tenant_invitations_insert_guard();

CREATE OR REPLACE FUNCTION public.novatrade_tenant_invitations_update_guard()
RETURNS trigger
LANGUAGE plpgsql
AS $function$
BEGIN
  IF NEW.id IS DISTINCT FROM OLD.id
    OR NEW.tenant_id IS DISTINCT FROM OLD.tenant_id
    OR NEW.membership_id IS DISTINCT FROM OLD.membership_id
    OR NEW.provisioning_request_id IS DISTINCT FROM OLD.provisioning_request_id
    OR NEW.kind IS DISTINCT FROM OLD.kind
    OR NEW.role IS DISTINCT FROM OLD.role
    OR NEW.workspace_id IS DISTINCT FROM OLD.workspace_id
    OR NEW.expected_identity_ref_hash IS DISTINCT FROM OLD.expected_identity_ref_hash
    OR NEW.policy_version IS DISTINCT FROM OLD.policy_version
    OR NEW.generation IS DISTINCT FROM OLD.generation
    OR NEW.content_hash IS DISTINCT FROM OLD.content_hash
    OR NEW.issued_at IS DISTINCT FROM OLD.issued_at
    OR NEW.expires_at IS DISTINCT FROM OLD.expires_at
    OR NEW.correlation_id IS DISTINCT FROM OLD.correlation_id
    OR NEW.audit_event_id IS DISTINCT FROM OLD.audit_event_id
    OR NEW.created_at IS DISTINCT FROM OLD.created_at
  THEN
    RAISE EXCEPTION 'tenant invitation binding facts are immutable';
  END IF;

  IF OLD.status <> 'issued' AND NEW.status IS DISTINCT FROM OLD.status THEN
    RAISE EXCEPTION 'tenant invitation status is terminal';
  END IF;

  IF OLD.status <> 'issued' AND (
    NEW.accepted_at IS DISTINCT FROM OLD.accepted_at
    OR NEW.accepted_auth_identity_id IS DISTINCT FROM OLD.accepted_auth_identity_id
    OR NEW.revoked_at IS DISTINCT FROM OLD.revoked_at
    OR NEW.revoked_reason_code IS DISTINCT FROM OLD.revoked_reason_code
    OR NEW.superseded_by_invitation_id IS DISTINCT FROM OLD.superseded_by_invitation_id
  ) THEN
    RAISE EXCEPTION 'tenant invitation terminal facts are immutable';
  END IF;

  IF NEW.status = 'issued' AND (
    NEW.accepted_at IS NOT NULL
    OR NEW.accepted_auth_identity_id IS NOT NULL
    OR NEW.revoked_at IS NOT NULL
    OR NEW.revoked_reason_code IS NOT NULL
    OR NEW.superseded_by_invitation_id IS NOT NULL
  ) THEN
    RAISE EXCEPTION 'tenant invitation issued row cannot carry terminal facts';
  END IF;

  IF OLD.status <> 'issued' AND (
    NEW.delivery_state IS DISTINCT FROM OLD.delivery_state
    OR NEW.delivery_adapter IS DISTINCT FROM OLD.delivery_adapter
    OR NEW.delivery_ref_hash IS DISTINCT FROM OLD.delivery_ref_hash
    OR NEW.delivery_detail IS DISTINCT FROM OLD.delivery_detail
  ) THEN
    RAISE EXCEPTION 'tenant invitation delivery is locked after close';
  END IF;

  IF OLD.delivery_state = 'delivered' AND (
    NEW.delivery_state IS DISTINCT FROM 'delivered'
    OR NEW.delivery_adapter IS DISTINCT FROM OLD.delivery_adapter
    OR NEW.delivery_ref_hash IS DISTINCT FROM OLD.delivery_ref_hash
  ) THEN
    RAISE EXCEPTION 'tenant invitation delivered state is immutable';
  END IF;

  NEW.updated_at := pg_catalog.now();
  RETURN NEW;
END;
$function$;

CREATE TRIGGER trg_novatrade_tenant_invitations_update_guard
  BEFORE UPDATE ON public.tenant_invitations
  FOR EACH ROW EXECUTE FUNCTION public.novatrade_tenant_invitations_update_guard();

CREATE OR REPLACE FUNCTION public.novatrade_tenant_invitations_no_delete()
RETURNS trigger
LANGUAGE plpgsql
AS $function$
BEGIN
  RAISE EXCEPTION 'tenant_invitations rows are append-only';
END;
$function$;

CREATE TRIGGER trg_novatrade_tenant_invitations_no_delete
  BEFORE DELETE ON public.tenant_invitations
  FOR EACH ROW EXECUTE FUNCTION public.novatrade_tenant_invitations_no_delete();

ALTER TABLE public.tenant_invitations ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.tenant_invitations FROM PUBLIC;
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    EXECUTE 'REVOKE ALL ON TABLE public.tenant_invitations FROM anon';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    EXECUTE 'REVOKE ALL ON TABLE public.tenant_invitations FROM authenticated';
  END IF;
END;
$$;

REVOKE ALL ON FUNCTION public.novatrade_tenant_invitations_insert_guard() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.novatrade_tenant_invitations_update_guard() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.novatrade_tenant_invitations_no_delete() FROM PUBLIC;

-- Invitation mutation journal: durable idempotency for issue/accept/reissue/revoke.
CREATE TABLE public.tenant_invitation_journal (
  idempotency_key_hash text PRIMARY KEY
    CONSTRAINT tenant_invitation_journal_key_chk
    CHECK (idempotency_key_hash ~ '^[0-9a-f]{64}$'),
  input_hash text NOT NULL
    CONSTRAINT tenant_invitation_journal_input_chk
    CHECK (input_hash ~ '^[0-9a-f]{64}$'),
  operation text NOT NULL
    CONSTRAINT tenant_invitation_journal_operation_chk
    CHECK (operation IN ('issue', 'accept', 'reissue', 'revoke')),
  tenant_id uuid NOT NULL,
  invitation_id uuid NOT NULL,
  status text NOT NULL DEFAULT 'reserved'
    CONSTRAINT tenant_invitation_journal_status_chk
    CHECK (status IN ('reserved', 'completed')),
  result_json jsonb,
  created_at timestamptz NOT NULL DEFAULT pg_catalog.now(),
  completed_at timestamptz,
  CONSTRAINT tenant_invitation_journal_state_chk CHECK (
    CASE WHEN status = 'reserved'
      THEN result_json IS NULL AND completed_at IS NULL
      ELSE result_json IS NOT NULL AND completed_at IS NOT NULL
    END
  ),
  CONSTRAINT tenant_invitation_journal_invitation_fkey
    FOREIGN KEY (tenant_id, invitation_id)
    REFERENCES public.tenant_invitations (tenant_id, id)
    ON UPDATE RESTRICT
    ON DELETE RESTRICT
    DEFERRABLE INITIALLY DEFERRED
);

CREATE OR REPLACE FUNCTION public.novatrade_tenant_invitation_journal_update_guard()
RETURNS trigger
LANGUAGE plpgsql
AS $function$
BEGIN
  IF NEW.idempotency_key_hash IS DISTINCT FROM OLD.idempotency_key_hash
    OR NEW.input_hash IS DISTINCT FROM OLD.input_hash
    OR NEW.operation IS DISTINCT FROM OLD.operation
    OR NEW.tenant_id IS DISTINCT FROM OLD.tenant_id
    OR NEW.invitation_id IS DISTINCT FROM OLD.invitation_id
    OR NEW.created_at IS DISTINCT FROM OLD.created_at
  THEN
    RAISE EXCEPTION 'journal reservation facts are immutable';
  END IF;
  IF OLD.status = 'completed' AND (
    NEW.status IS DISTINCT FROM 'completed'
    OR NEW.result_json IS DISTINCT FROM OLD.result_json
    OR NEW.completed_at IS DISTINCT FROM OLD.completed_at
  ) THEN
    RAISE EXCEPTION 'journal completion is terminal';
  END IF;
  IF NEW.status = 'reserved' AND (NEW.result_json IS NOT NULL OR NEW.completed_at IS NOT NULL) THEN
    RAISE EXCEPTION 'journal reserved rows cannot carry completion facts';
  END IF;
  RETURN NEW;
END;
$function$;

CREATE TRIGGER trg_novatrade_tenant_invitation_journal_update_guard
  BEFORE UPDATE ON public.tenant_invitation_journal
  FOR EACH ROW EXECUTE FUNCTION public.novatrade_tenant_invitation_journal_update_guard();

CREATE OR REPLACE FUNCTION public.novatrade_tenant_invitation_journal_no_delete()
RETURNS trigger
LANGUAGE plpgsql
AS $function$
BEGIN
  RAISE EXCEPTION 'tenant_invitation_journal rows are append-only';
END;
$function$;

CREATE TRIGGER trg_novatrade_tenant_invitation_journal_no_delete
  BEFORE DELETE ON public.tenant_invitation_journal
  FOR EACH ROW EXECUTE FUNCTION public.novatrade_tenant_invitation_journal_no_delete();

ALTER TABLE public.tenant_invitation_journal ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.tenant_invitation_journal FROM PUBLIC;
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    EXECUTE 'REVOKE ALL ON TABLE public.tenant_invitation_journal FROM anon';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    EXECUTE 'REVOKE ALL ON TABLE public.tenant_invitation_journal FROM authenticated';
  END IF;
END;
$$;

REVOKE ALL ON FUNCTION public.novatrade_tenant_invitation_journal_update_guard() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.novatrade_tenant_invitation_journal_no_delete() FROM PUBLIC;

-- Tenant provisioning journal: durable idempotency for provisionTenant.
CREATE TABLE public.tenant_provisioning_journal (
  idempotency_key_hash text PRIMARY KEY
    CONSTRAINT tenant_provisioning_journal_key_chk
    CHECK (idempotency_key_hash ~ '^[0-9a-f]{64}$'),
  input_hash text NOT NULL
    CONSTRAINT tenant_provisioning_journal_input_chk
    CHECK (input_hash ~ '^[0-9a-f]{64}$'),
  request_id uuid NOT NULL,
  status text NOT NULL DEFAULT 'in_progress'
    CONSTRAINT tenant_provisioning_journal_status_chk
    CHECK (status IN ('in_progress', 'completed')),
  result_json jsonb,
  created_at timestamptz NOT NULL DEFAULT pg_catalog.now(),
  completed_at timestamptz,
  CONSTRAINT tenant_provisioning_journal_state_chk CHECK (
    CASE WHEN status = 'in_progress'
      THEN result_json IS NULL AND completed_at IS NULL
      ELSE result_json IS NOT NULL AND completed_at IS NOT NULL
    END
  )
);

CREATE OR REPLACE FUNCTION public.novatrade_tenant_provisioning_journal_update_guard()
RETURNS trigger
LANGUAGE plpgsql
AS $function$
BEGIN
  IF NEW.idempotency_key_hash IS DISTINCT FROM OLD.idempotency_key_hash
    OR NEW.input_hash IS DISTINCT FROM OLD.input_hash
    OR NEW.request_id IS DISTINCT FROM OLD.request_id
    OR NEW.created_at IS DISTINCT FROM OLD.created_at
  THEN
    RAISE EXCEPTION 'journal reservation facts are immutable';
  END IF;
  IF OLD.status = 'completed' AND (
    NEW.status IS DISTINCT FROM 'completed'
    OR NEW.result_json IS DISTINCT FROM OLD.result_json
    OR NEW.completed_at IS DISTINCT FROM OLD.completed_at
  ) THEN
    RAISE EXCEPTION 'journal completion is terminal';
  END IF;
  IF NEW.status = 'in_progress' AND (NEW.result_json IS NOT NULL OR NEW.completed_at IS NOT NULL) THEN
    RAISE EXCEPTION 'journal in-progress rows cannot carry completion facts';
  END IF;
  RETURN NEW;
END;
$function$;

CREATE TRIGGER trg_novatrade_tenant_provisioning_journal_update_guard
  BEFORE UPDATE ON public.tenant_provisioning_journal
  FOR EACH ROW EXECUTE FUNCTION public.novatrade_tenant_provisioning_journal_update_guard();

CREATE OR REPLACE FUNCTION public.novatrade_tenant_provisioning_journal_no_delete()
RETURNS trigger
LANGUAGE plpgsql
AS $function$
BEGIN
  RAISE EXCEPTION 'tenant_provisioning_journal rows are append-only';
END;
$function$;

CREATE TRIGGER trg_novatrade_tenant_provisioning_journal_no_delete
  BEFORE DELETE ON public.tenant_provisioning_journal
  FOR EACH ROW EXECUTE FUNCTION public.novatrade_tenant_provisioning_journal_no_delete();

ALTER TABLE public.tenant_provisioning_journal ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.tenant_provisioning_journal FROM PUBLIC;
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    EXECUTE 'REVOKE ALL ON TABLE public.tenant_provisioning_journal FROM anon';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    EXECUTE 'REVOKE ALL ON TABLE public.tenant_provisioning_journal FROM authenticated';
  END IF;
END;
$$;

REVOKE ALL ON FUNCTION public.novatrade_tenant_provisioning_journal_update_guard() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.novatrade_tenant_provisioning_journal_no_delete() FROM PUBLIC;
