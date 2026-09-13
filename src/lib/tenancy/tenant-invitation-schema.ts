/**
 * Local SQLite DDL for tenant invitations and the provisioning/invitation
 * mutation journals. The canonical Postgres schema lives in
 * supabase/migrations/202609120001_tenant_invitations.sql; this DDL mirrors it
 * for the local runtime and tests.
 */

const UUID_COLUMN_CHECK = (column: string) => `
    length(${column}) = 36 AND
    length(replace(${column}, '-', '')) = 32 AND
    ${column} NOT GLOB '*[^0-9A-Fa-f-]*' AND
    substr(${column}, 9, 1) = '-' AND
    substr(${column}, 14, 1) = '-' AND
    substr(${column}, 19, 1) = '-' AND
    substr(${column}, 24, 1) = '-'
`;

const NULLABLE_UUID_COLUMN_CHECK = (column: string) => `
    ${column} IS NULL OR (
      ${UUID_COLUMN_CHECK(column)}
    )
`;

const HASH_COLUMN_CHECK = (column: string) => `
    length(${column}) = 64 AND ${column} NOT GLOB '*[^0-9a-f]*'
`;

const NULLABLE_HASH_COLUMN_CHECK = (column: string) => `
    ${column} IS NULL OR (${HASH_COLUMN_CHECK(column)})
`;

const TIMESTAMP_COLUMN_CHECK = (column: string) => `
    length(${column}) = 24 AND
    ${column} GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9].[0-9][0-9][0-9]Z'
`;

const NULLABLE_TIMESTAMP_COLUMN_CHECK = (column: string) => `
    ${column} IS NULL OR (${TIMESTAMP_COLUMN_CHECK(column)})
`;

export const TENANT_INVITATION_LOCAL_DDL = `
CREATE TABLE IF NOT EXISTS tenant_invitations (
  id TEXT PRIMARY KEY NOT NULL CONSTRAINT tenant_invitations_id_format_chk CHECK (
    ${UUID_COLUMN_CHECK("id")}
  ),
  tenant_id TEXT NOT NULL CONSTRAINT tenant_invitations_tenant_id_format_chk CHECK (
    ${UUID_COLUMN_CHECK("tenant_id")}
  ) REFERENCES tenants(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  membership_id TEXT NOT NULL CONSTRAINT tenant_invitations_membership_id_format_chk CHECK (
    ${UUID_COLUMN_CHECK("membership_id")}
  ),
  provisioning_request_id TEXT CONSTRAINT tenant_invitations_request_id_format_chk CHECK (
    ${NULLABLE_UUID_COLUMN_CHECK("provisioning_request_id")}
  ),
  kind TEXT NOT NULL CONSTRAINT tenant_invitations_kind_chk
    CHECK (kind IN ('owner', 'member')),
  role TEXT NOT NULL CONSTRAINT tenant_invitations_role_chk
    CHECK (role IN ('owner', 'admin', 'strategist_manager', 'researcher', 'reviewer', 'outreach_operator', 'analyst_read_only')),
  workspace_id TEXT CONSTRAINT tenant_invitations_workspace_id_format_chk CHECK (
    ${NULLABLE_UUID_COLUMN_CHECK("workspace_id")}
  ),
  expected_identity_ref_hash TEXT NOT NULL CONSTRAINT tenant_invitations_expected_identity_chk CHECK (
    ${HASH_COLUMN_CHECK("expected_identity_ref_hash")}
  ),
  policy_version TEXT NOT NULL CONSTRAINT tenant_invitations_policy_version_chk CHECK (
    policy_version GLOB '[A-Za-z0-9][A-Za-z0-9._:-]*' AND length(policy_version) BETWEEN 3 AND 64
  ),
  generation INTEGER NOT NULL CONSTRAINT tenant_invitations_generation_chk
    CHECK (typeof(generation) = 'integer' AND generation >= 1),
  content_hash TEXT NOT NULL CONSTRAINT tenant_invitations_content_hash_chk CHECK (
    ${HASH_COLUMN_CHECK("content_hash")}
  ),
  status TEXT NOT NULL DEFAULT 'issued' CONSTRAINT tenant_invitations_status_chk
    CHECK (status IN ('issued', 'accepted', 'revoked', 'superseded', 'expired')),
  delivery_state TEXT NOT NULL DEFAULT 'queued' CONSTRAINT tenant_invitations_delivery_state_chk
    CHECK (delivery_state IN ('queued', 'delivered', 'delivery_failed')),
  delivery_adapter TEXT CONSTRAINT tenant_invitations_delivery_adapter_chk CHECK (
    delivery_adapter IS NULL OR (
      delivery_adapter GLOB '[A-Za-z0-9][A-Za-z0-9._-]*' AND length(delivery_adapter) BETWEEN 2 AND 80
    )
  ),
  delivery_ref_hash TEXT CONSTRAINT tenant_invitations_delivery_ref_chk CHECK (
    ${NULLABLE_HASH_COLUMN_CHECK("delivery_ref_hash")}
  ),
  delivery_detail TEXT CONSTRAINT tenant_invitations_delivery_detail_chk CHECK (
    delivery_detail IS NULL OR length(delivery_detail) BETWEEN 1 AND 240
  ),
  issued_at TEXT NOT NULL CONSTRAINT tenant_invitations_issued_at_utc_chk CHECK (
    ${TIMESTAMP_COLUMN_CHECK("issued_at")}
  ),
  expires_at TEXT NOT NULL CONSTRAINT tenant_invitations_expires_at_utc_chk CHECK (
    ${TIMESTAMP_COLUMN_CHECK("expires_at")}
  ),
  accepted_at TEXT CONSTRAINT tenant_invitations_accepted_at_utc_chk CHECK (
    ${NULLABLE_TIMESTAMP_COLUMN_CHECK("accepted_at")}
  ),
  accepted_auth_identity_id TEXT CONSTRAINT tenant_invitations_accepted_identity_chk CHECK (
    ${NULLABLE_UUID_COLUMN_CHECK("accepted_auth_identity_id")}
  ),
  revoked_at TEXT CONSTRAINT tenant_invitations_revoked_at_utc_chk CHECK (
    ${NULLABLE_TIMESTAMP_COLUMN_CHECK("revoked_at")}
  ),
  revoked_reason_code TEXT CONSTRAINT tenant_invitations_revoked_reason_chk CHECK (
    revoked_reason_code IS NULL OR (
      revoked_reason_code NOT GLOB '*[^a-z0-9._-]*' AND length(revoked_reason_code) BETWEEN 3 AND 80
    )
  ),
  superseded_by_invitation_id TEXT CONSTRAINT tenant_invitations_superseded_by_chk CHECK (
    ${NULLABLE_UUID_COLUMN_CHECK("superseded_by_invitation_id")}
  ),
  correlation_id TEXT NOT NULL CONSTRAINT tenant_invitations_correlation_chk CHECK (
    correlation_id GLOB '[A-Za-z0-9][A-Za-z0-9._:-]*' AND length(correlation_id) BETWEEN 8 AND 128
  ),
  audit_event_id TEXT NOT NULL CONSTRAINT tenant_invitations_audit_event_chk CHECK (
    ${UUID_COLUMN_CHECK("audit_event_id")}
  ),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
    CONSTRAINT tenant_invitations_created_at_utc_chk CHECK (
      ${TIMESTAMP_COLUMN_CHECK("created_at")}
    ),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
    CONSTRAINT tenant_invitations_updated_at_utc_chk CHECK (
      ${TIMESTAMP_COLUMN_CHECK("updated_at")}
    ),
  CONSTRAINT tenant_invitations_membership_fkey
    FOREIGN KEY (tenant_id, membership_id)
    REFERENCES tenant_memberships (tenant_id, id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT tenant_invitations_workspace_fkey
    FOREIGN KEY (tenant_id, workspace_id)
    REFERENCES workspaces (tenant_id, id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT tenant_invitations_superseded_by_fkey
    FOREIGN KEY (tenant_id, superseded_by_invitation_id)
    REFERENCES tenant_invitations (tenant_id, id)
    ON UPDATE RESTRICT ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
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

CREATE UNIQUE INDEX IF NOT EXISTS tenant_invitations_live_membership_unique
  ON tenant_invitations (tenant_id, membership_id)
  WHERE status = 'issued';

CREATE INDEX IF NOT EXISTS idx_tenant_invitations_tenant_status
  ON tenant_invitations (tenant_id, status, updated_at DESC);

CREATE INDEX IF NOT EXISTS idx_tenant_invitations_membership
  ON tenant_invitations (tenant_id, membership_id, generation);

CREATE TRIGGER IF NOT EXISTS trg_novatrade_tenant_invitations_insert_guard
BEFORE INSERT ON tenant_invitations
FOR EACH ROW
BEGIN
  SELECT RAISE(ABORT, 'tenant invitation membership is not pending or workspace mismatch')
  WHERE NOT EXISTS (
    SELECT 1 FROM tenant_memberships membership
    WHERE membership.tenant_id = NEW.tenant_id
      AND membership.id = NEW.membership_id
      AND membership.status = 'pending'
      AND membership.workspace_id IS NEW.workspace_id
  );
  SELECT RAISE(ABORT, 'tenant invitation status must start issued')
  WHERE NEW.status <> 'issued';
  SELECT RAISE(ABORT, 'tenant invitation delivery must start queued')
  WHERE NEW.delivery_state <> 'queued';
END;

CREATE TRIGGER IF NOT EXISTS trg_novatrade_tenant_invitations_update_guard
BEFORE UPDATE ON tenant_invitations
FOR EACH ROW
BEGIN
  SELECT CASE WHEN NEW.id IS NOT OLD.id THEN RAISE(ABORT, 'tenant invitation id is immutable') END;
  SELECT CASE WHEN NEW.tenant_id IS NOT OLD.tenant_id THEN RAISE(ABORT, 'tenant invitation tenant_id is immutable') END;
  SELECT CASE WHEN NEW.membership_id IS NOT OLD.membership_id THEN RAISE(ABORT, 'tenant invitation membership_id is immutable') END;
  SELECT CASE WHEN NEW.provisioning_request_id IS NOT OLD.provisioning_request_id THEN RAISE(ABORT, 'tenant invitation provisioning_request_id is immutable') END;
  SELECT CASE WHEN NEW.kind IS NOT OLD.kind THEN RAISE(ABORT, 'tenant invitation kind is immutable') END;
  SELECT CASE WHEN NEW.role IS NOT OLD.role THEN RAISE(ABORT, 'tenant invitation role is immutable') END;
  SELECT CASE WHEN NEW.workspace_id IS NOT OLD.workspace_id THEN RAISE(ABORT, 'tenant invitation workspace_id is immutable') END;
  SELECT CASE WHEN NEW.expected_identity_ref_hash IS NOT OLD.expected_identity_ref_hash THEN RAISE(ABORT, 'tenant invitation expected identity is immutable') END;
  SELECT CASE WHEN NEW.policy_version IS NOT OLD.policy_version THEN RAISE(ABORT, 'tenant invitation policy_version is immutable') END;
  SELECT CASE WHEN NEW.generation IS NOT OLD.generation THEN RAISE(ABORT, 'tenant invitation generation is immutable') END;
  SELECT CASE WHEN NEW.content_hash IS NOT OLD.content_hash THEN RAISE(ABORT, 'tenant invitation content_hash is immutable') END;
  SELECT CASE WHEN NEW.issued_at IS NOT OLD.issued_at THEN RAISE(ABORT, 'tenant invitation issued_at is immutable') END;
  SELECT CASE WHEN NEW.expires_at IS NOT OLD.expires_at THEN RAISE(ABORT, 'tenant invitation expires_at is immutable') END;
  SELECT CASE WHEN NEW.correlation_id IS NOT OLD.correlation_id THEN RAISE(ABORT, 'tenant invitation correlation_id is immutable') END;
  SELECT CASE WHEN NEW.audit_event_id IS NOT OLD.audit_event_id THEN RAISE(ABORT, 'tenant invitation audit_event_id is immutable') END;
  SELECT CASE WHEN NEW.created_at IS NOT OLD.created_at THEN RAISE(ABORT, 'tenant invitation created_at is immutable') END;

  SELECT RAISE(ABORT, 'tenant invitation status is terminal')
  WHERE OLD.status <> 'issued' AND NEW.status IS NOT OLD.status;

  SELECT RAISE(ABORT, 'tenant invitation terminal facts are immutable')
  WHERE OLD.status <> 'issued' AND (
    NEW.accepted_at IS NOT OLD.accepted_at OR
    NEW.accepted_auth_identity_id IS NOT OLD.accepted_auth_identity_id OR
    NEW.revoked_at IS NOT OLD.revoked_at OR
    NEW.revoked_reason_code IS NOT OLD.revoked_reason_code OR
    NEW.superseded_by_invitation_id IS NOT OLD.superseded_by_invitation_id
  );

  SELECT RAISE(ABORT, 'tenant invitation issued row cannot carry terminal facts')
  WHERE NEW.status = 'issued' AND (
    NEW.accepted_at IS NOT NULL OR
    NEW.accepted_auth_identity_id IS NOT NULL OR
    NEW.revoked_at IS NOT NULL OR
    NEW.revoked_reason_code IS NOT NULL OR
    NEW.superseded_by_invitation_id IS NOT NULL
  );

  SELECT RAISE(ABORT, 'tenant invitation delivery is locked after close')
  WHERE OLD.status <> 'issued' AND (
    NEW.delivery_state IS NOT OLD.delivery_state OR
    NEW.delivery_adapter IS NOT OLD.delivery_adapter OR
    NEW.delivery_ref_hash IS NOT OLD.delivery_ref_hash OR
    NEW.delivery_detail IS NOT OLD.delivery_detail
  );

  SELECT RAISE(ABORT, 'tenant invitation delivered state is immutable')
  WHERE OLD.delivery_state = 'delivered' AND (
    NEW.delivery_state IS NOT 'delivered' OR
    NEW.delivery_adapter IS NOT OLD.delivery_adapter OR
    NEW.delivery_ref_hash IS NOT OLD.delivery_ref_hash
  );
END;

CREATE TRIGGER IF NOT EXISTS trg_novatrade_tenant_invitations_touch_updated_at
AFTER UPDATE ON tenant_invitations
FOR EACH ROW
WHEN NEW.updated_at IS OLD.updated_at
BEGIN
  UPDATE tenant_invitations
  SET updated_at = CASE
    WHEN strftime('%Y-%m-%dT%H:%M:%fZ', 'now') = OLD.updated_at
      THEN strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '+1 second')
    ELSE strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
  END
  WHERE id = NEW.id;
END;

CREATE TRIGGER IF NOT EXISTS trg_novatrade_tenant_invitations_no_delete
BEFORE DELETE ON tenant_invitations
FOR EACH ROW
BEGIN
  SELECT RAISE(ABORT, 'tenant_invitations rows are append-only');
END;

CREATE TABLE IF NOT EXISTS tenant_invitation_journal (
  idempotency_key_hash TEXT PRIMARY KEY NOT NULL CONSTRAINT tenant_invitation_journal_key_chk CHECK (
    ${HASH_COLUMN_CHECK("idempotency_key_hash")}
  ),
  input_hash TEXT NOT NULL CONSTRAINT tenant_invitation_journal_input_chk CHECK (
    ${HASH_COLUMN_CHECK("input_hash")}
  ),
  operation TEXT NOT NULL CONSTRAINT tenant_invitation_journal_operation_chk
    CHECK (operation IN ('issue', 'accept', 'reissue', 'revoke')),
  tenant_id TEXT NOT NULL CONSTRAINT tenant_invitation_journal_tenant_chk CHECK (
    ${UUID_COLUMN_CHECK("tenant_id")}
  ),
  invitation_id TEXT NOT NULL CONSTRAINT tenant_invitation_journal_invitation_chk CHECK (
    ${UUID_COLUMN_CHECK("invitation_id")}
  ),
  status TEXT NOT NULL DEFAULT 'reserved' CONSTRAINT tenant_invitation_journal_status_chk
    CHECK (status IN ('reserved', 'completed')),
  result_json TEXT CONSTRAINT tenant_invitation_journal_result_chk
    CHECK (result_json IS NULL OR json_valid(result_json)),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
    CONSTRAINT tenant_invitation_journal_created_chk CHECK (
      ${TIMESTAMP_COLUMN_CHECK("created_at")}
    ),
  completed_at TEXT CONSTRAINT tenant_invitation_journal_completed_chk CHECK (
    ${NULLABLE_TIMESTAMP_COLUMN_CHECK("completed_at")}
  ),
  CONSTRAINT tenant_invitation_journal_state_chk CHECK (
    CASE WHEN status = 'reserved'
      THEN result_json IS NULL AND completed_at IS NULL
      ELSE result_json IS NOT NULL AND completed_at IS NOT NULL
    END
  ),
  CONSTRAINT tenant_invitation_journal_invitation_fkey
    FOREIGN KEY (tenant_id, invitation_id)
    REFERENCES tenant_invitations (tenant_id, id)
    ON UPDATE RESTRICT ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED
);

CREATE TRIGGER IF NOT EXISTS trg_novatrade_tenant_invitation_journal_update_guard
BEFORE UPDATE ON tenant_invitation_journal
FOR EACH ROW
BEGIN
  SELECT CASE WHEN NEW.idempotency_key_hash IS NOT OLD.idempotency_key_hash THEN RAISE(ABORT, 'journal key hash is immutable') END;
  SELECT CASE WHEN NEW.input_hash IS NOT OLD.input_hash THEN RAISE(ABORT, 'journal input hash is immutable') END;
  SELECT CASE WHEN NEW.operation IS NOT OLD.operation THEN RAISE(ABORT, 'journal operation is immutable') END;
  SELECT CASE WHEN NEW.tenant_id IS NOT OLD.tenant_id THEN RAISE(ABORT, 'journal tenant_id is immutable') END;
  SELECT CASE WHEN NEW.invitation_id IS NOT OLD.invitation_id THEN RAISE(ABORT, 'journal invitation_id is immutable') END;
  SELECT CASE WHEN NEW.created_at IS NOT OLD.created_at THEN RAISE(ABORT, 'journal created_at is immutable') END;
  SELECT RAISE(ABORT, 'journal completion is terminal')
  WHERE OLD.status = 'completed' AND (
    NEW.status IS NOT 'completed' OR
    NEW.result_json IS NOT OLD.result_json OR
    NEW.completed_at IS NOT OLD.completed_at
  );
  SELECT RAISE(ABORT, 'journal reservation facts are immutable')
  WHERE NEW.status = 'reserved' AND (
    NEW.result_json IS NOT NULL OR NEW.completed_at IS NOT NULL
  );
END;

CREATE TRIGGER IF NOT EXISTS trg_novatrade_tenant_invitation_journal_no_delete
BEFORE DELETE ON tenant_invitation_journal
FOR EACH ROW
BEGIN
  SELECT RAISE(ABORT, 'tenant_invitation_journal rows are append-only');
END;

CREATE TABLE IF NOT EXISTS tenant_provisioning_journal (
  idempotency_key_hash TEXT PRIMARY KEY NOT NULL CONSTRAINT tenant_provisioning_journal_key_chk CHECK (
    ${HASH_COLUMN_CHECK("idempotency_key_hash")}
  ),
  input_hash TEXT NOT NULL CONSTRAINT tenant_provisioning_journal_input_chk CHECK (
    ${HASH_COLUMN_CHECK("input_hash")}
  ),
  request_id TEXT NOT NULL CONSTRAINT tenant_provisioning_journal_request_chk CHECK (
    ${UUID_COLUMN_CHECK("request_id")}
  ),
  status TEXT NOT NULL DEFAULT 'in_progress' CONSTRAINT tenant_provisioning_journal_status_chk
    CHECK (status IN ('in_progress', 'completed')),
  result_json TEXT CONSTRAINT tenant_provisioning_journal_result_chk
    CHECK (result_json IS NULL OR json_valid(result_json)),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
    CONSTRAINT tenant_provisioning_journal_created_chk CHECK (
      ${TIMESTAMP_COLUMN_CHECK("created_at")}
    ),
  completed_at TEXT CONSTRAINT tenant_provisioning_journal_completed_chk CHECK (
    ${NULLABLE_TIMESTAMP_COLUMN_CHECK("completed_at")}
  ),
  CONSTRAINT tenant_provisioning_journal_state_chk CHECK (
    CASE WHEN status = 'in_progress'
      THEN result_json IS NULL AND completed_at IS NULL
      ELSE result_json IS NOT NULL AND completed_at IS NOT NULL
    END
  )
);

CREATE TRIGGER IF NOT EXISTS trg_novatrade_tenant_provisioning_journal_update_guard
BEFORE UPDATE ON tenant_provisioning_journal
FOR EACH ROW
BEGIN
  SELECT CASE WHEN NEW.idempotency_key_hash IS NOT OLD.idempotency_key_hash THEN RAISE(ABORT, 'journal key hash is immutable') END;
  SELECT CASE WHEN NEW.input_hash IS NOT OLD.input_hash THEN RAISE(ABORT, 'journal input hash is immutable') END;
  SELECT CASE WHEN NEW.request_id IS NOT OLD.request_id THEN RAISE(ABORT, 'journal request_id is immutable') END;
  SELECT CASE WHEN NEW.created_at IS NOT OLD.created_at THEN RAISE(ABORT, 'journal created_at is immutable') END;
  SELECT RAISE(ABORT, 'journal completion is terminal')
  WHERE OLD.status = 'completed' AND (
    NEW.status IS NOT 'completed' OR
    NEW.result_json IS NOT OLD.result_json OR
    NEW.completed_at IS NOT OLD.completed_at
  );
  SELECT RAISE(ABORT, 'journal in-progress facts are immutable')
  WHERE NEW.status = 'in_progress' AND (
    NEW.result_json IS NOT NULL OR NEW.completed_at IS NOT NULL
  );
END;

CREATE TRIGGER IF NOT EXISTS trg_novatrade_tenant_provisioning_journal_no_delete
BEFORE DELETE ON tenant_provisioning_journal
FOR EACH ROW
BEGIN
  SELECT RAISE(ABORT, 'tenant_provisioning_journal rows are append-only');
END;
`;
