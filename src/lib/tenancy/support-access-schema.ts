/**
 * Local SQLite DDL for the support-access operation journal, the append-only
 * support decision event ledger, and the local platform-support principal
 * registry. The grant tables themselves live in the frozen base schema
 * (support_access_grants + permission/data-class scope tables); the canonical
 * Postgres equivalents of the tables below live in
 * supabase/migrations/202609120002_support_access_operations.sql.
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

const TIMESTAMP_COLUMN_CHECK = (column: string) => `
    length(${column}) = 24 AND
    ${column} GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9].[0-9][0-9][0-9]Z'
`;

const NULLABLE_TIMESTAMP_COLUMN_CHECK = (column: string) => `
    ${column} IS NULL OR (${TIMESTAMP_COLUMN_CHECK(column)})
`;

export const SUPPORT_ACCESS_LOCAL_DDL = `
CREATE TABLE IF NOT EXISTS support_access_journal (
  idempotency_key_hash TEXT PRIMARY KEY NOT NULL CONSTRAINT support_access_journal_key_chk CHECK (
    ${HASH_COLUMN_CHECK("idempotency_key_hash")}
  ),
  input_hash TEXT NOT NULL CONSTRAINT support_access_journal_input_chk CHECK (
    ${HASH_COLUMN_CHECK("input_hash")}
  ),
  operation TEXT NOT NULL CONSTRAINT support_access_journal_operation_chk
    CHECK (operation IN ('request', 'approve', 'revoke', 'check', 'authorize_and_run', 'list_current', 'list_history')),
  tenant_id TEXT CONSTRAINT support_access_journal_tenant_chk CHECK (
    ${NULLABLE_UUID_COLUMN_CHECK("tenant_id")}
  ),
  actor_namespace TEXT NOT NULL CONSTRAINT support_access_journal_actor_chk CHECK (
    length(actor_namespace) BETWEEN 1 AND 128
  ),
  status TEXT NOT NULL DEFAULT 'reserved' CONSTRAINT support_access_journal_status_chk
    CHECK (status IN ('reserved', 'completed')),
  result_json TEXT CONSTRAINT support_access_journal_result_chk
    CHECK (result_json IS NULL OR json_valid(result_json)),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
    CONSTRAINT support_access_journal_created_chk CHECK (
      ${TIMESTAMP_COLUMN_CHECK("created_at")}
    ),
  completed_at TEXT CONSTRAINT support_access_journal_completed_chk CHECK (
    ${NULLABLE_TIMESTAMP_COLUMN_CHECK("completed_at")}
  ),
  CONSTRAINT support_access_journal_state_chk CHECK (
    CASE WHEN status = 'reserved'
      THEN result_json IS NULL AND completed_at IS NULL
      ELSE result_json IS NOT NULL AND completed_at IS NOT NULL
    END
  )
);

CREATE TRIGGER IF NOT EXISTS trg_novatrade_support_access_journal_update_guard
BEFORE UPDATE ON support_access_journal
FOR EACH ROW
BEGIN
  SELECT CASE WHEN NEW.idempotency_key_hash IS NOT OLD.idempotency_key_hash THEN RAISE(ABORT, 'journal key hash is immutable') END;
  SELECT CASE WHEN NEW.input_hash IS NOT OLD.input_hash THEN RAISE(ABORT, 'journal input hash is immutable') END;
  SELECT CASE WHEN NEW.operation IS NOT OLD.operation THEN RAISE(ABORT, 'journal operation is immutable') END;
  SELECT CASE WHEN NEW.tenant_id IS NOT OLD.tenant_id THEN RAISE(ABORT, 'journal tenant_id is immutable') END;
  SELECT CASE WHEN NEW.actor_namespace IS NOT OLD.actor_namespace THEN RAISE(ABORT, 'journal actor namespace is immutable') END;
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

CREATE TRIGGER IF NOT EXISTS trg_novatrade_support_access_journal_no_delete
BEFORE DELETE ON support_access_journal
FOR EACH ROW
BEGIN
  SELECT RAISE(ABORT, 'support_access_journal rows are append-only');
END;

CREATE TABLE IF NOT EXISTS support_access_events (
  event_id TEXT PRIMARY KEY NOT NULL CONSTRAINT support_access_events_event_chk CHECK (
    ${UUID_COLUMN_CHECK("event_id")}
  ),
  operation TEXT NOT NULL CONSTRAINT support_access_events_operation_chk
    CHECK (operation IN ('request', 'approve', 'revoke', 'check', 'authorize_and_run', 'list_current', 'list_history')),
  tenant_id TEXT CONSTRAINT support_access_events_tenant_chk CHECK (
    ${NULLABLE_UUID_COLUMN_CHECK("tenant_id")}
  ),
  workspace_id TEXT CONSTRAINT support_access_events_workspace_chk CHECK (
    ${NULLABLE_UUID_COLUMN_CHECK("workspace_id")}
  ),
  actor_layer TEXT NOT NULL CONSTRAINT support_access_events_actor_layer_chk
    CHECK (actor_layer IN ('member', 'support', 'worker')),
  actor_id TEXT CONSTRAINT support_access_events_actor_chk CHECK (
    ${NULLABLE_UUID_COLUMN_CHECK("actor_id")}
  ),
  support_grant_id TEXT CONSTRAINT support_access_events_grant_chk CHECK (
    ${NULLABLE_UUID_COLUMN_CHECK("support_grant_id")}
  ),
  permission TEXT CONSTRAINT support_access_events_permission_chk CHECK (
    permission IS NULL OR (
      permission GLOB '[a-z]*' AND permission NOT GLOB '*[^a-z:_-]*' AND length(permission) BETWEEN 3 AND 40
    )
  ),
  data_classes_json TEXT NOT NULL CONSTRAINT support_access_events_data_classes_chk
    CHECK (json_valid(data_classes_json)),
  decision_code TEXT NOT NULL CONSTRAINT support_access_events_decision_chk CHECK (
    decision_code IN (
      'OK_SUPPORT_GRANT_REQUESTED', 'OK_SUPPORT_GRANT_APPROVED', 'OK_SUPPORT_GRANT_REVOKED',
      'OK_SUPPORT_AUTHORIZED', 'OK_SUPPORT_REPLAY',
      'SUPPORT_GRANT_REQUIRED', 'SUPPORT_SCOPE_MISMATCH', 'SUPPORT_WORKSPACE_SCOPE_INVALID',
      'SUPPORT_POLICY_BLOCKED', 'SUPPORT_SELF_ACTION', 'SUPPORT_STATE_CONFLICT',
      'SUPPORT_NOT_FOUND_OR_FORBIDDEN', 'SUPPORT_MALFORMED', 'SUPPORT_INTERNAL'
    )
  ),
  reason_code TEXT NOT NULL CONSTRAINT support_access_events_reason_chk CHECK (
    reason_code GLOB '[a-z]*' AND reason_code NOT GLOB '*[^a-z0-9._-]*' AND length(reason_code) BETWEEN 3 AND 80
  ),
  correlation_id TEXT NOT NULL CONSTRAINT support_access_events_correlation_chk CHECK (
    correlation_id GLOB '[A-Za-z0-9]*' AND correlation_id NOT GLOB '*[^A-Za-z0-9._:/-]*' AND length(correlation_id) BETWEEN 1 AND 128
  ),
  attempt_id TEXT NOT NULL CONSTRAINT support_access_events_attempt_chk CHECK (
    ${UUID_COLUMN_CHECK("attempt_id")}
  ),
  input_hash TEXT NOT NULL CONSTRAINT support_access_events_input_chk CHECK (
    ${HASH_COLUMN_CHECK("input_hash")}
  ),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
    CONSTRAINT support_access_events_created_chk CHECK (
      ${TIMESTAMP_COLUMN_CHECK("created_at")}
    )
);

CREATE INDEX IF NOT EXISTS idx_support_access_events_tenant_created
  ON support_access_events (tenant_id, created_at DESC, event_id);

CREATE INDEX IF NOT EXISTS idx_support_access_events_grant
  ON support_access_events (support_grant_id, created_at DESC)
  WHERE support_grant_id IS NOT NULL;

CREATE TRIGGER IF NOT EXISTS trg_novatrade_support_access_events_no_update
BEFORE UPDATE ON support_access_events
FOR EACH ROW
BEGIN
  SELECT RAISE(ABORT, 'support_access_events rows are append-only');
END;

CREATE TRIGGER IF NOT EXISTS trg_novatrade_support_access_events_no_delete
BEFORE DELETE ON support_access_events
FOR EACH ROW
BEGIN
  SELECT RAISE(ABORT, 'support_access_events rows are append-only');
END;

-- Local registry for the principal-resolver port. Production resolves the
-- platform-support principal from the authenticated platform session; the
-- local adapter resolves it against this operator-managed directory.
CREATE TABLE IF NOT EXISTS platform_support_principals (
  reference TEXT PRIMARY KEY NOT NULL CONSTRAINT platform_support_principals_ref_chk CHECK (
    length(reference) BETWEEN 1 AND 256
  ),
  auth_identity_id TEXT NOT NULL CONSTRAINT platform_support_principals_identity_chk CHECK (
    ${UUID_COLUMN_CHECK("auth_identity_id")}
  ),
  status TEXT NOT NULL DEFAULT 'active' CONSTRAINT platform_support_principals_status_chk
    CHECK (status IN ('active', 'disabled')),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
    CONSTRAINT platform_support_principals_created_chk CHECK (
      ${TIMESTAMP_COLUMN_CHECK("created_at")}
    ),
  CONSTRAINT platform_support_principals_identity_unique UNIQUE (auth_identity_id)
);

CREATE TRIGGER IF NOT EXISTS trg_novatrade_platform_support_principals_update_guard
BEFORE UPDATE ON platform_support_principals
FOR EACH ROW
BEGIN
  SELECT CASE WHEN NEW.reference IS NOT OLD.reference THEN RAISE(ABORT, 'support principal reference is immutable') END;
  SELECT CASE WHEN NEW.auth_identity_id IS NOT OLD.auth_identity_id THEN RAISE(ABORT, 'support principal identity is immutable') END;
  SELECT CASE WHEN NEW.created_at IS NOT OLD.created_at THEN RAISE(ABORT, 'support principal created_at is immutable') END;
  SELECT RAISE(ABORT, 'support principal cannot be re-enabled')
  WHERE OLD.status = 'disabled' AND NEW.status IS NOT 'disabled';
END;
`;
