/**
 * Local SQLite DDL for the tenant-limit store: rate-limit buckets, consume
 * idempotency records, per-tenant action configuration (caps and kill
 * switches), the platform kill-switch configuration, and the append-only
 * limit decision event ledger. The canonical Postgres equivalents live in
 * supabase/migrations/202609120003_tenant_limit_store.sql.
 */

const HASH_COLUMN_CHECK = (column: string) => `
    length(${column}) = 64 AND ${column} NOT GLOB '*[^0-9a-f]*'
`;

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

const TIMESTAMP_COLUMN_CHECK = (column: string) => `
    length(${column}) = 24 AND
    ${column} GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9].[0-9][0-9][0-9]Z'
`;

const LIMIT_ACTION_CHECK = (column: string) => `
    ${column} IN (
      'membership_invite', 'support_grant_request', 'support_grant_approval',
      'knowledge_upload', 'export_request', 'deletion_request', 'worker_start',
      'agent_plan_expensive', 'recovery_bookkeeping'
    )
`;

export const TENANT_LIMITS_LOCAL_DDL = `
-- Sliding-window counters. bucket_key values are opaque service-computed
-- digests (tenant:<hash> / actor:<hash>); raw tenant or actor ids never appear.
CREATE TABLE IF NOT EXISTS tenant_limit_buckets (
  bucket_key TEXT PRIMARY KEY NOT NULL CONSTRAINT tenant_limit_buckets_key_chk CHECK (
    length(bucket_key) BETWEEN 9 AND 200 AND bucket_key NOT GLOB '*[^A-Za-z0-9:_-]*'
  ),
  used INTEGER NOT NULL DEFAULT 0 CONSTRAINT tenant_limit_buckets_used_chk CHECK (
    typeof(used) = 'integer' AND used >= 0
  ),
  reset_at_ms INTEGER NOT NULL CONSTRAINT tenant_limit_buckets_reset_chk CHECK (
    typeof(reset_at_ms) = 'integer' AND reset_at_ms >= 0
  ),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
    CONSTRAINT tenant_limit_buckets_updated_chk CHECK (
      ${TIMESTAMP_COLUMN_CHECK("updated_at")}
    )
);

CREATE TRIGGER IF NOT EXISTS trg_novatrade_tenant_limit_buckets_update_guard
BEFORE UPDATE ON tenant_limit_buckets
FOR EACH ROW
BEGIN
  SELECT CASE WHEN NEW.bucket_key IS NOT OLD.bucket_key THEN RAISE(ABORT, 'bucket key is immutable') END;
  SELECT CASE WHEN NEW.used < OLD.used AND NEW.reset_at_ms IS OLD.reset_at_ms THEN RAISE(ABORT, 'bucket count can only decrease on window reset') END;
END;

CREATE TABLE IF NOT EXISTS tenant_limit_idempotency (
  idempotency_key TEXT PRIMARY KEY NOT NULL CONSTRAINT tenant_limit_idempotency_key_chk CHECK (
    ${HASH_COLUMN_CHECK("idempotency_key")}
  ),
  request_hash TEXT NOT NULL CONSTRAINT tenant_limit_idempotency_request_chk CHECK (
    ${HASH_COLUMN_CHECK("request_hash")}
  ),
  tenant_id TEXT NOT NULL CONSTRAINT tenant_limit_idempotency_tenant_chk CHECK (
    ${UUID_COLUMN_CHECK("tenant_id")}
  ),
  action TEXT NOT NULL CONSTRAINT tenant_limit_idempotency_action_chk CHECK (
    ${LIMIT_ACTION_CHECK("action")}
  ),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
    CONSTRAINT tenant_limit_idempotency_created_chk CHECK (
      ${TIMESTAMP_COLUMN_CHECK("created_at")}
    )
);

CREATE TRIGGER IF NOT EXISTS trg_novatrade_tenant_limit_idempotency_no_update
BEFORE UPDATE ON tenant_limit_idempotency
FOR EACH ROW
BEGIN
  SELECT RAISE(ABORT, 'tenant_limit_idempotency rows are append-only');
END;

CREATE TRIGGER IF NOT EXISTS trg_novatrade_tenant_limit_idempotency_no_delete
BEFORE DELETE ON tenant_limit_idempotency
FOR EACH ROW
BEGIN
  SELECT RAISE(ABORT, 'tenant_limit_idempotency rows are append-only');
END;

-- Per-tenant, per-action quota configuration. configuration_version CASes
-- every mutation; policy_cap overrides the platform hard cap downward and
-- action_kill blocks the action entirely for the tenant.
CREATE TABLE IF NOT EXISTS tenant_limit_configuration (
  tenant_id TEXT NOT NULL CONSTRAINT tenant_limit_configuration_tenant_chk CHECK (
    ${UUID_COLUMN_CHECK("tenant_id")}
  ) REFERENCES tenants(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  action TEXT NOT NULL CONSTRAINT tenant_limit_configuration_action_chk CHECK (
    ${LIMIT_ACTION_CHECK("action")}
  ),
  configuration_version INTEGER NOT NULL DEFAULT 1 CONSTRAINT tenant_limit_configuration_version_chk CHECK (
    typeof(configuration_version) = 'integer' AND configuration_version >= 1
  ),
  policy_cap INTEGER CONSTRAINT tenant_limit_configuration_cap_chk CHECK (
    policy_cap IS NULL OR (typeof(policy_cap) = 'integer' AND policy_cap BETWEEN 1 AND 1000000)
  ),
  action_kill INTEGER NOT NULL DEFAULT 0 CONSTRAINT tenant_limit_configuration_kill_chk CHECK (
    action_kill IN (0, 1)
  ),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
    CONSTRAINT tenant_limit_configuration_updated_chk CHECK (
      ${TIMESTAMP_COLUMN_CHECK("updated_at")}
    ),
  PRIMARY KEY (tenant_id, action)
);

CREATE TRIGGER IF NOT EXISTS trg_novatrade_tenant_limit_configuration_update_guard
BEFORE UPDATE ON tenant_limit_configuration
FOR EACH ROW
BEGIN
  SELECT CASE WHEN NEW.tenant_id IS NOT OLD.tenant_id THEN RAISE(ABORT, 'limit configuration tenant is immutable') END;
  SELECT CASE WHEN NEW.action IS NOT OLD.action THEN RAISE(ABORT, 'limit configuration action is immutable') END;
  SELECT CASE WHEN NEW.configuration_version IS NOT OLD.configuration_version + 1 THEN RAISE(ABORT, 'limit configuration version must advance exactly one') END;
END;

-- Singleton platform-wide kill-switch configuration row.
CREATE TABLE IF NOT EXISTS platform_limit_configuration (
  id TEXT PRIMARY KEY NOT NULL CONSTRAINT platform_limit_configuration_id_chk CHECK (id = 'platform'),
  configuration_version INTEGER NOT NULL DEFAULT 1 CONSTRAINT platform_limit_configuration_version_chk CHECK (
    typeof(configuration_version) = 'integer' AND configuration_version >= 1
  ),
  global_kill INTEGER NOT NULL DEFAULT 0 CONSTRAINT platform_limit_configuration_global_chk CHECK (
    global_kill IN (0, 1)
  ),
  action_kills_json TEXT NOT NULL DEFAULT '{}' CONSTRAINT platform_limit_configuration_kills_chk CHECK (
    json_valid(action_kills_json)
  ),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
    CONSTRAINT platform_limit_configuration_updated_chk CHECK (
      ${TIMESTAMP_COLUMN_CHECK("updated_at")}
    )
);

CREATE TRIGGER IF NOT EXISTS trg_novatrade_platform_limit_configuration_update_guard
BEFORE UPDATE ON platform_limit_configuration
FOR EACH ROW
BEGIN
  SELECT CASE WHEN NEW.id IS NOT OLD.id THEN RAISE(ABORT, 'platform configuration id is immutable') END;
  SELECT CASE WHEN NEW.configuration_version IS NOT OLD.configuration_version + 1 THEN RAISE(ABORT, 'platform configuration version must advance exactly one') END;
END;

CREATE TRIGGER IF NOT EXISTS trg_novatrade_platform_limit_configuration_no_delete
BEFORE DELETE ON platform_limit_configuration
FOR EACH ROW
BEGIN
  SELECT RAISE(ABORT, 'platform_limit_configuration row cannot be deleted');
END;

-- Append-only ledger for configuration changes; consume decisions are
-- rate-shaped noise and are not individually durable.
CREATE TABLE IF NOT EXISTS tenant_limit_events (
  event_id TEXT PRIMARY KEY NOT NULL CONSTRAINT tenant_limit_events_event_chk CHECK (
    ${UUID_COLUMN_CHECK("event_id")}
  ),
  event_type TEXT NOT NULL CONSTRAINT tenant_limit_events_type_chk CHECK (
    event_type IN ('tenant_limit_configuration_changed', 'platform_limit_kill_switch_changed')
  ),
  tenant_id TEXT CONSTRAINT tenant_limit_events_tenant_chk CHECK (
    ${NULLABLE_UUID_COLUMN_CHECK("tenant_id")}
  ),
  action TEXT CONSTRAINT tenant_limit_events_action_chk CHECK (
    action IS NULL OR ${LIMIT_ACTION_CHECK("action")}
  ),
  payload_json TEXT NOT NULL CONSTRAINT tenant_limit_events_payload_chk CHECK (
    json_valid(payload_json)
  ),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
    CONSTRAINT tenant_limit_events_created_chk CHECK (
      ${TIMESTAMP_COLUMN_CHECK("created_at")}
    )
);

CREATE INDEX IF NOT EXISTS idx_tenant_limit_events_tenant_created
  ON tenant_limit_events (tenant_id, created_at DESC, event_id);

CREATE TRIGGER IF NOT EXISTS trg_novatrade_tenant_limit_events_no_update
BEFORE UPDATE ON tenant_limit_events
FOR EACH ROW
BEGIN
  SELECT RAISE(ABORT, 'tenant_limit_events rows are append-only');
END;

CREATE TRIGGER IF NOT EXISTS trg_novatrade_tenant_limit_events_no_delete
BEFORE DELETE ON tenant_limit_events
FOR EACH ROW
BEGIN
  SELECT RAISE(ABORT, 'tenant_limit_events rows are append-only');
END;
`;
