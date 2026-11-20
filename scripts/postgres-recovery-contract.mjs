// PostgreSQL-native recovery coverage contract (format "novatrade-pg-recovery",
// schema version 1). This is the authoritative disaster-recovery contract for
// the Postgres-authoritative data plane: it classifies every migrated public
// table, drives the pg_dump/pg_restore archive tooling in
// scripts/postgres-recovery.mjs, and replaces the historical
// verify-data-recovery.mjs Postgres bypass allowlist with a fail-closed
// classification set.
//
// Ownership boundary: this contract covers ONLY the `public` schema of the
// application database. Supabase Auth (auth.*), Supabase Storage object bytes
// (storage.*), Supabase Vault secrets (vault.*), the supabase_migrations
// ledger, platform extensions (pgcrypto/pg_net/pg_cron), and environment
// variables are declared PG_RECOVERY_BOUNDARIES — restored by their owning
// platform lane, never by this archive. The frozen v3/v4
// "nova-data-export" contract in data-transfer-contract.mjs keeps sole
// ownership of the legacy SQLite→Postgres portable lane; portable tables are
// marked `portable` below to record that dual coverage.

import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

export const PG_RECOVERY_FORMAT = "novatrade-pg-recovery";
export const PG_RECOVERY_SCHEMA_VERSION = 1;
export const PG_RECOVERY_MANIFEST_FILE = "manifest.json";
export const PG_RECOVERY_DUMP_FILE = "data.dump";
export const PG_RECOVERY_CHECKSUMS_FILE = "SHA256SUMS";
export const PG_RECOVERY_DUMP_FORMAT = "pg_dump-custom";

// Recovery classes. "durable" tables are dumped with schema+data and verified
// by row count and content digest after restore. "excluded" is reserved for a
// future public table that is genuinely non-recoverable by design; it requires
// an explicit `reason` and is never assignable to tenant/audit/runtime data.
export const PG_RECOVERY_CLASS_DURABLE = "durable";

export const PG_RECOVERY_FAMILIES = Object.freeze({
  "reference": "portable reference geography/market data (v3/v4 portable contract also covers it)",
  "tenant-foundation": "tenant, workspace, membership, policy, support-access, export and deletion state (v3/v4 portable contract also covers it)",
  "legacy-operations": "legacy lead/crawl/outreach operations and audit state (v3/v4 portable contract also covers it)",
  "agent-runtime": "Postgres-only agent run, step, tool-call, budget and lease state (F-06/F-08, L-04)",
  "connector-runtime": "Postgres-only connector, source-policy, source-run and source provenance state (F-09)",
  "document-intake": "Postgres-only document intake, upload reservation, malware-scan and extraction job state (F-04/F-05)",
  "tenant-operations": "Postgres-only L-02 invitation, provisioning, support, limit-store and membership-journal state",
  "knowledge": "Postgres-only L-03 document lifecycle, URL intake, extraction output, evidence, citation and claim state",
  "strategy": "Postgres-only L-04 business-understanding, adaptive-question, ICP and lead-play state",
  "discovery-contacts": "Postgres-only L-05 discovery, canonical account, contact, qualification and review-queue state",
  "outreach-outcomes": "Postgres-only L-06 outreach draft, handoff, suppression, outcome and learning-proposal state",
});

/**
 * @param {string} name
 * @param {string} family
 * @param {Record<string, unknown>} [extra]
 * @returns {Readonly<{ name: string; recoveryClass: string; family: string } & Record<string, unknown>>}
 */
function entry(name, family, extra = {}) {
  return Object.freeze({ name, recoveryClass: PG_RECOVERY_CLASS_DURABLE, family, ...extra });
}

// Strict classification of every public table created by supabase/migrations.
// Order is contract-significant: portable v3/v4 tables first (in manifest
// order), then the Postgres-only expansion families in migration order. Any
// migrated public table absent from this list fails coverage closed.
export const PG_RECOVERY_TABLES = Object.freeze([
  // --- reference (portable v3/v4) ---
  entry("zip_codes", "reference", { portable: true }),
  entry("location_markets", "reference", { portable: true }),
  entry("location_cells", "reference", { portable: true }),
  // --- tenant foundation (portable v3/v4) ---
  entry("tenants", "tenant-foundation", { portable: true }),
  entry("workspaces", "tenant-foundation", { portable: true }),
  entry("tenant_memberships", "tenant-foundation", { portable: true }),
  entry("tenant_role_bindings", "tenant-foundation", { portable: true }),
  entry("tenant_policies", "tenant-foundation", { portable: true }),
  entry("support_access_grants", "tenant-foundation", { portable: true }),
  entry("support_access_grant_permissions", "tenant-foundation", { portable: true }),
  entry("support_access_grant_data_classes", "tenant-foundation", { portable: true }),
  entry("tenant_export_jobs", "tenant-foundation", { portable: true }),
  entry("tenant_deletion_jobs", "tenant-foundation", { portable: true }),
  entry("tenant_deletion_checkpoints", "tenant-foundation", { portable: true }),
  entry("tenant_deletion_checkpoint_events", "tenant-foundation", { portable: true }),
  entry("tenant_deletion_tombstones", "tenant-foundation", { portable: true }),
  entry("compatibility_backfill_receipts", "tenant-foundation", { portable: true }),
  // --- legacy operations (portable v3/v4) ---
  entry("settings", "legacy-operations", { portable: true, secretColumns: ["openai_api_key_encrypted", "google_places_api_key_encrypted", "google_maps_browser_api_key_encrypted"] }),
  entry("app_users", "legacy-operations", { portable: true }),
  entry("user_market_access", "legacy-operations", { portable: true }),
  entry("crawl_runs", "legacy-operations", { portable: true }),
  entry("crawl_units", "legacy-operations", { portable: true }),
  entry("leads", "legacy-operations", { portable: true }),
  entry("lead_notes", "legacy-operations", { portable: true }),
  entry("outreach_events", "legacy-operations", { portable: true }),
  entry("admin_requests", "legacy-operations", { portable: true }),
  entry("demos", "legacy-operations", { portable: true }),
  entry("place_cache", "legacy-operations", { portable: true }),
  entry("places_master", "legacy-operations", { portable: true }),
  entry("place_observations", "legacy-operations", { portable: true }),
  entry("api_usage_events", "legacy-operations", { portable: true }),
  entry("ai_lead_verifications", "legacy-operations", { portable: true }),
  entry("ai_usage_events", "legacy-operations", { portable: true }),
  entry("lead_ai_artifacts", "legacy-operations", { portable: true }),
  entry("ai_feedback_events", "legacy-operations", { portable: true }),
  entry("worker_runs", "legacy-operations", { portable: true }),
  entry("audit_logs", "legacy-operations", { portable: true }),
  // --- agent runtime (F-06/F-08, L-04) ---
  entry("agent_prompt_versions", "agent-runtime"),
  entry("agent_policy_versions", "agent-runtime"),
  entry("agent_runs", "agent-runtime"),
  entry("agent_run_lease_history", "agent-runtime"),
  entry("agent_run_steps", "agent-runtime"),
  entry("agent_tool_calls", "agent-runtime"),
  entry("agent_usage_reservations", "agent-runtime"),
  entry("agent_usage_settlements", "agent-runtime"),
  entry("agent_run_inputs", "agent-runtime"),
  // --- connector runtime (F-09) ---
  entry("connector_versions", "connector-runtime"),
  entry("connector_accounts", "connector-runtime"),
  entry("source_policy_versions", "connector-runtime"),
  entry("source_runs", "connector-runtime"),
  entry("source_run_units", "connector-runtime"),
  entry("source_run_lease_history", "connector-runtime"),
  entry("source_observations", "connector-runtime"),
  entry("source_usage_reservations", "connector-runtime"),
  entry("source_usage_settlements", "connector-runtime"),
  entry("current_source_policy_activations", "connector-runtime"),
  // --- document intake/extraction (F-04/F-05) ---
  entry("documents", "document-intake"),
  entry("document_versions", "document-intake"),
  entry("document_upload_reservations", "document-intake"),
  entry("document_version_finalizations", "document-intake"),
  entry("document_scan_jobs", "document-intake"),
  entry("document_scan_outbox", "document-intake"),
  entry("document_scan_lease_history", "document-intake"),
  entry("document_extraction_jobs", "document-intake"),
  entry("document_extraction_lease_history", "document-intake"),
  entry("tenant_worker_dispatch_leases", "document-intake"),
  // --- L-05 discovery/contacts/qualification ---
  entry("discovery_plans", "discovery-contacts"),
  entry("discovery_runs", "discovery-contacts"),
  entry("canonical_accounts", "discovery-contacts"),
  entry("account_source_observations", "discovery-contacts"),
  entry("account_resolutions", "discovery-contacts"),
  entry("account_merge_events", "discovery-contacts"),
  entry("account_merge_snapshots", "discovery-contacts"),
  entry("contact_record_versions", "discovery-contacts"),
  entry("buying_center_versions", "discovery-contacts"),
  entry("account_qualification_snapshots", "discovery-contacts"),
  entry("review_queue_documents", "discovery-contacts"),
  entry("review_queue_items", "discovery-contacts"),
  entry("review_queue_events", "discovery-contacts"),
  // --- L-02 tenant operations ---
  entry("tenant_invitations", "tenant-operations"),
  entry("tenant_invitation_journal", "tenant-operations"),
  entry("tenant_provisioning_journal", "tenant-operations"),
  entry("support_access_journal", "tenant-operations"),
  entry("support_access_events", "tenant-operations"),
  entry("platform_support_principals", "tenant-operations"),
  entry("tenant_limit_buckets", "tenant-operations"),
  entry("tenant_limit_idempotency", "tenant-operations"),
  entry("tenant_limit_configuration", "tenant-operations"),
  entry("platform_limit_configuration", "tenant-operations"),
  entry("tenant_limit_events", "tenant-operations"),
  // Dual-homed: also a SQLite-local auxiliary table (ported by 202609120010).
  entry("tenant_membership_mutation_journal", "tenant-operations", { sqliteAuxiliary: true }),
  // --- L-03 document lifecycle + knowledge ---
  entry("document_url_sources", "knowledge"),
  entry("document_url_intake_requests", "knowledge"),
  entry("document_lifecycle_events", "knowledge"),
  entry("document_deletion_requests", "knowledge"),
  entry("document_retention_evaluations", "knowledge"),
  entry("document_extraction_outputs", "knowledge"),
  entry("knowledge_evidence_items", "knowledge"),
  entry("knowledge_citations", "knowledge"),
  entry("knowledge_claims", "knowledge"),
  entry("knowledge_claim_versions", "knowledge"),
  entry("knowledge_claim_evidence_edges", "knowledge"),
  entry("knowledge_claim_review_decisions", "knowledge"),
  // --- L-04 understanding/strategy ---
  entry("business_understanding_versions", "strategy"),
  entry("business_understanding_review_events", "strategy"),
  entry("adaptive_question_sessions", "strategy"),
  entry("adaptive_question_answers", "strategy"),
  entry("icp_versions", "strategy"),
  entry("icp_review_events", "strategy"),
  entry("lead_play_versions", "strategy"),
  entry("lead_play_review_events", "strategy"),
  entry("lead_play_simulations", "strategy"),
  entry("lead_play_simulation_reviews", "strategy"),
  entry("lead_play_activation_states", "strategy"),
  // --- L-06 outreach/outcomes ---
  entry("outreach_draft_versions", "outreach-outcomes"),
  entry("outreach_draft_current", "outreach-outcomes"),
  entry("outreach_handoff_attempts", "outreach-outcomes"),
  entry("outcome_record_versions", "outreach-outcomes"),
  entry("suppression_records", "outreach-outcomes"),
  entry("learning_proposal_versions", "outreach-outcomes"),
]);

export const PG_RECOVERY_TABLE_NAMES = Object.freeze(PG_RECOVERY_TABLES.map(({ name }) => name));
export const PG_RECOVERY_TABLE_BY_NAME = new Map(PG_RECOVERY_TABLES.map((table) => [table.name, table]));

// Out-of-scope boundaries. Every scope is platform-owned and restored by its
// own lane; the archive never carries these objects.
export const PG_RECOVERY_BOUNDARIES = Object.freeze([
  Object.freeze({
    scope: "auth",
    reason: "Supabase Auth owns auth.users/identities/credentials. Public rows DO carry auth user UUIDs as foreign-key values, but never credentials; real Auth rows must exist before the public restore runs, since foreign keys validate at restore time.",
  }),
  Object.freeze({
    scope: "storage",
    reason: "Supabase Storage object bytes are outside the database. The archive restores only object_key/storage-ref/checksum metadata; blobs are re-verified against Storage separately.",
  }),
  Object.freeze({
    scope: "vault",
    reason: "Supabase Vault secrets (worker_cron_secret, worker_base_url, connector credentials) are never dumped; re-provision them through Vault.",
  }),
  Object.freeze({
    scope: "supabase_migrations",
    reason: "The migration ledger is environment-owned. The archive carries the resulting schema state; operators re-record applied versions per the runbook.",
  }),
  Object.freeze({
    scope: "extensions",
    reason: "pgcrypto/pg_net/pg_cron and scheduler runtime state are platform-provisioned (extensions schema, cron jobs). Destination prep installs required extensions before restore.",
  }),
  Object.freeze({
    scope: "environment",
    reason: "Environment secrets (NOVA_ENCRYPTION_SECRET, JWT signing keys, WORKER_CRON_SECRET, provider keys) are deploy-time configuration, never archived.",
  }),
]);

// Why the archive is privileged/secret-bearing even though the schema stores
// only ciphertext and opaque hashes.
export const PG_RECOVERY_SECRET_BEARING_REASONS = Object.freeze([
  "settings.openai_api_key_encrypted, settings.google_places_api_key_encrypted, settings.google_maps_browser_api_key_encrypted hold provider-key ciphertext",
  "tenant, contact, document and outreach rows are confidential customer data",
  "lease/credential columns store opaque hashes that must stay tamper-evident",
]);

export const PG_RECOVERY_REQUIRED_ROLE_BUILTINS = Object.freeze(new Set(["PUBLIC", "pg_database_owner", "postgres"]));

// ---------- classification ----------

export function classifyPublicTableSet(actualTableNames, label = "public schema") {
  const actual = new Set(actualTableNames);
  const unknown = [...actual].filter((name) => !PG_RECOVERY_TABLE_BY_NAME.has(name)).sort();
  const missing = PG_RECOVERY_TABLE_NAMES.filter((name) => !actual.has(name));
  if (unknown.length > 0 || missing.length > 0) {
    const parts = [];
    if (unknown.length > 0) parts.push(`unclassified [${unknown.join(", ")}]`);
    if (missing.length > 0) parts.push(`missing [${missing.join(", ")}]`);
    throw new Error(`${label}: Postgres recovery coverage mismatch — ${parts.join("; ")}. Update scripts/postgres-recovery-contract.mjs with an explicit classification; do not leave new tables unclassified.`);
  }
  return PG_RECOVERY_TABLES;
}

// ---------- deterministic value canonicalization ----------

function canonicalizeValue(value) {
  if (value === null || value === undefined) return null;
  if (value instanceof Date) return { "\0:d": value.toISOString() };
  if (Buffer.isBuffer(value) || value instanceof Uint8Array) return { "\0:x": Buffer.from(value).toString("hex") };
  if (typeof value === "bigint") return { "\0:i": String(value) };
  if (Array.isArray(value)) return value.map(canonicalizeValue);
  if (typeof value === "object") {
    if (value instanceof String || value instanceof Number || value instanceof Boolean) {
      return canonicalizeValue(value.valueOf());
    }
    const entries = Object.entries(value)
      .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
      .map(([key, entry]) => [key, canonicalizeValue(entry)]);
    return Object.fromEntries(entries);
  }
  if (typeof value === "number" && !Number.isFinite(value)) {
    throw new Error("non-finite number cannot be canonically digested");
  }
  return value;
}

export function canonicalizeRow(row) {
  const entries = Object.keys(row)
    .sort()
    .map((key) => [key, canonicalizeValue(row[key])]);
  return JSON.stringify(Object.fromEntries(entries));
}

export function digestRows(rows) {
  const serialized = rows.map(canonicalizeRow).sort();
  return createHash("sha256").update(serialized.join("\n")).digest("hex");
}

// ---------- live database introspection ----------

const PUBLIC_SCHEMA = "public";

export async function listPublicTables(sql) {
  const rows = await sql.unsafe(
    `SELECT c.relname AS name
       FROM pg_catalog.pg_class c
       JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = $1 AND c.relkind IN ('r', 'p')
      ORDER BY c.relname`,
    [PUBLIC_SCHEMA],
  );
  return rows.map((row) => String(row.name));
}

export async function introspectPublicTables(sql) {
  const tableRows = await sql.unsafe(
    `SELECT c.relname AS name,
            c.relrowsecurity AS rls_enabled,
            c.relforcerowsecurity AS rls_forced
       FROM pg_catalog.pg_class c
       JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = $1 AND c.relkind IN ('r', 'p')
      ORDER BY c.relname`,
    [PUBLIC_SCHEMA],
  );
  const columnRows = await sql.unsafe(
    `SELECT table_name AS name, column_name
       FROM information_schema.columns
      WHERE table_schema = $1
      ORDER BY table_name, ordinal_position`,
    [PUBLIC_SCHEMA],
  );
  const keyRows = await sql.unsafe(
    `SELECT table_class.relname AS name,
            attribute.attname AS column_name,
            key_column.ordinality AS ord
       FROM pg_catalog.pg_index index_record
       JOIN pg_catalog.pg_class table_class ON table_class.oid = index_record.indrelid
       JOIN pg_catalog.pg_namespace namespace_record ON namespace_record.oid = table_class.relnamespace
       CROSS JOIN LATERAL pg_catalog.unnest(index_record.indkey::smallint[]) WITH ORDINALITY AS key_column(attnum, ordinality)
       JOIN pg_catalog.pg_attribute attribute
         ON attribute.attrelid = table_class.oid
        AND attribute.attnum = key_column.attnum
      WHERE namespace_record.nspname = $1
        AND index_record.indisprimary
      ORDER BY table_class.relname, key_column.ordinality`,
    [PUBLIC_SCHEMA],
  );
  const triggerRows = await sql.unsafe(
    `SELECT table_class.relname AS name,
            trigger_record.tgname AS trigger_name,
            trigger_record.tgenabled AS enabled
       FROM pg_catalog.pg_trigger trigger_record
       JOIN pg_catalog.pg_class table_class ON table_class.oid = trigger_record.tgrelid
       JOIN pg_catalog.pg_namespace namespace_record ON namespace_record.oid = table_class.relnamespace
      WHERE namespace_record.nspname = $1
        AND NOT trigger_record.tgisinternal
      ORDER BY table_class.relname, trigger_record.tgname`,
    [PUBLIC_SCHEMA],
  );

  const tables = new Map();
  for (const row of tableRows) {
    tables.set(String(row.name), {
      name: String(row.name),
      columns: [],
      primaryKey: [],
      rlsEnabled: row.rls_enabled === true,
      rlsForced: row.rls_forced === true,
      triggers: [],
    });
  }
  for (const row of columnRows) {
    tables.get(String(row.name))?.columns.push(String(row.column_name));
  }
  for (const row of keyRows) {
    tables.get(String(row.name))?.primaryKey.push(String(row.column_name));
  }
  for (const row of triggerRows) {
    tables.get(String(row.name))?.triggers.push({ name: String(row.trigger_name), enabled: String(row.enabled) });
  }
  return tables;
}

export async function computeTableDigest(sql, tableName, columns) {
  const selected = columns.map((column) => `"${column.replaceAll('"', '""')}"`).join(", ");
  const rows = await sql.unsafe(`SELECT ${selected} FROM "public"."${tableName.replaceAll('"', '""')}"`);
  return { rows: rows.length, sha256: digestRows(rows) };
}

// ---------- destination/endpoint safety ----------

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);

export function parseDatabaseUrl(raw, label = "database URL") {
  let url;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(`${label} is not a valid URL`);
  }
  if (!["postgres:", "postgresql:"].includes(url.protocol)) {
    throw new Error(`${label} must use postgres:// or postgresql://`);
  }
  return url;
}

export function assertLoopbackUrl(url, { allowRemote = false, label = "database" } = {}) {
  if (LOOPBACK_HOSTS.has(url.hostname)) return;
  if (allowRemote) return;
  throw new Error(`${label} host must be loopback (localhost/127.0.0.1/::1); pass the explicit remote acknowledgement for approved remote restore work`);
}

export function databaseNameOf(url) {
  const name = decodeURIComponent(url.pathname.replace(/^\//, ""));
  if (!name) throw new Error("database URL must name a database path");
  return name;
}

export function redactUrl(raw) {
  try {
    const url = new URL(raw);
    if (url.password) url.password = "…";
    if (url.username) url.username = url.username ? `${url.username}` : url.username;
    return url.toString();
  } catch {
    return "<invalid-url>";
  }
}

// ---------- manifest ----------

function sortObjectDeep(value) {
  if (Array.isArray(value)) return value.map(sortObjectDeep);
  if (value && typeof value === "object" && value.constructor === Object) {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
        .map(([key, entry]) => [key, sortObjectDeep(entry)]),
    );
  }
  return value;
}

export function serializeManifest(manifest) {
  return `${JSON.stringify(sortObjectDeep(manifest), null, 2)}\n`;
}

export function sha256Buffer(buffer) {
  return createHash("sha256").update(buffer).digest("hex");
}

export function writeChecksumsFile(dir, entries) {
  const lines = entries.map(([sha, file]) => `${sha}  ${file}`).join("\n") + "\n";
  fs.writeFileSync(path.join(dir, PG_RECOVERY_CHECKSUMS_FILE), lines, { mode: 0o600 });
}

// Offline archive validation: structure, contract version, coverage equality,
// per-file byte/sha256 integrity, and secret-bearing flags. Never reads row
// contents and never touches a database.
export function validatePostgresRecoveryArchive(inputDir) {
  const dir = path.resolve(inputDir);
  const manifestPath = path.join(dir, PG_RECOVERY_MANIFEST_FILE);
  const dumpPath = path.join(dir, PG_RECOVERY_DUMP_FILE);
  const checksumsPath = path.join(dir, PG_RECOVERY_CHECKSUMS_FILE);

  for (const filePath of [manifestPath, dumpPath, checksumsPath]) {
    if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
      throw new Error(`archive is missing required file: ${path.basename(filePath)}`);
    }
  }

  // SHA256SUMS is the outer integrity envelope; verify it before trusting the
  // manifest's own claims.
  const checksumLines = fs.readFileSync(checksumsPath, "utf8").split("\n").filter(Boolean);
  const checksums = new Map();
  for (const line of checksumLines) {
    const match = /^([0-9a-f]{64})  ([A-Za-z0-9._-]+)$/.exec(line);
    if (!match) throw new Error("SHA256SUMS contains a malformed line");
    checksums.set(match[2], match[1]);
  }
  for (const file of [PG_RECOVERY_MANIFEST_FILE, PG_RECOVERY_DUMP_FILE]) {
    if (!checksums.has(file)) throw new Error(`SHA256SUMS lacks an entry for ${file}`);
  }
  if (checksums.size !== 2) throw new Error("SHA256SUMS must contain exactly the manifest and dump entries");
  const manifestBytes = fs.readFileSync(manifestPath);
  const dumpBytes = fs.readFileSync(dumpPath);
  if (sha256Buffer(manifestBytes) !== checksums.get(PG_RECOVERY_MANIFEST_FILE)) {
    throw new Error("manifest.json does not match SHA256SUMS — archive is corrupted or tampered");
  }
  if (sha256Buffer(dumpBytes) !== checksums.get(PG_RECOVERY_DUMP_FILE)) {
    throw new Error("data.dump does not match SHA256SUMS — archive is corrupted or tampered");
  }

  let manifest;
  try {
    manifest = JSON.parse(manifestBytes.toString("utf8"));
  } catch (error) {
    throw new Error(`archive manifest is not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!manifest || typeof manifest !== "object" || Array.isArray(manifest)) {
    throw new Error("archive manifest must be a JSON object");
  }
  const expectedKeys = ["archive", "coverage", "createdAt", "format", "generator", "schemaVersion", "source", "tables"];
  const actualKeys = Object.keys(manifest).sort();
  if (actualKeys.join(",") !== [...expectedKeys].sort().join(",")) {
    throw new Error("archive manifest has unexpected or missing keys");
  }
  if (manifest.format !== PG_RECOVERY_FORMAT) {
    throw new Error(`unsupported recovery format: ${String(manifest.format ?? "missing")}`);
  }
  if (manifest.schemaVersion !== PG_RECOVERY_SCHEMA_VERSION) {
    throw new Error(`unsupported recovery schema version: ${String(manifest.schemaVersion ?? "missing")}`);
  }

  const { archive, coverage, source, tables } = manifest;
  if (!source || source.kind !== "postgres" || typeof source.database !== "string" || !source.database) {
    throw new Error("archive manifest source is malformed");
  }
  if (typeof source.serverVersionNum !== "number" || !Number.isInteger(source.serverVersionNum)) {
    throw new Error("archive manifest source.serverVersionNum must be an integer");
  }

  if (!archive || archive.file !== PG_RECOVERY_DUMP_FILE || archive.format !== PG_RECOVERY_DUMP_FORMAT) {
    throw new Error("archive descriptor must name data.dump in pg_dump-custom format");
  }
  if (!Number.isInteger(archive.bytes) || archive.bytes !== dumpBytes.byteLength) {
    throw new Error("archive byte count mismatch — data.dump is corrupted or tampered");
  }
  if (archive.sha256 !== checksums.get(PG_RECOVERY_DUMP_FILE)) {
    throw new Error("archive.sha256 does not match the checksum envelope");
  }
  if (archive.secretBearing !== true || !Array.isArray(archive.secretBearingReasons) || archive.secretBearingReasons.length === 0) {
    throw new Error("archive must be marked secret-bearing with explicit reasons");
  }
  if (!Array.isArray(archive.requiredRoles) || archive.requiredRoles.some((role) => typeof role !== "string" || !role)) {
    throw new Error("archive requiredRoles must be an array of role names");
  }
  if (!Array.isArray(archive.dumpTableData) || archive.dumpTableData.length !== PG_RECOVERY_TABLE_NAMES.length) {
    throw new Error("archive dumpTableData must cover every classified table");
  }

  if (!coverage || coverage.contract !== "pg-recovery-v1" || coverage.schema !== PUBLIC_SCHEMA) {
    throw new Error("archive coverage contract is malformed");
  }
  if (coverage.tableCount !== PG_RECOVERY_TABLE_NAMES.length) {
    throw new Error("archive coverage.tableCount does not match the recovery contract");
  }
  if (!Array.isArray(coverage.boundaries) || coverage.boundaries.length !== PG_RECOVERY_BOUNDARIES.length) {
    throw new Error("archive coverage.boundaries does not match the recovery contract");
  }

  if (!tables || typeof tables !== "object" || Array.isArray(tables)) {
    throw new Error("archive manifest tables must be an object");
  }
  const manifestTables = Object.keys(tables).sort();
  const expectedTables = [...PG_RECOVERY_TABLE_NAMES].sort();
  if (manifestTables.join(",") !== expectedTables.join(",")) {
    const unexpected = manifestTables.filter((name) => !PG_RECOVERY_TABLE_BY_NAME.has(name));
    const missingTables = expectedTables.filter((name) => !manifestTables.includes(name));
    throw new Error(`archive table coverage mismatch — unexpected [${unexpected.join(", ")}], missing [${missingTables.join(", ")}]`);
  }
  for (const [name, info] of Object.entries(tables)) {
    const contract = PG_RECOVERY_TABLE_BY_NAME.get(name);
    if (!contract) throw new Error(`archive contains unclassified table ${name}`);
    if (contract.recoveryClass !== PG_RECOVERY_CLASS_DURABLE) {
      throw new Error(`archive includes excluded table ${name}`);
    }
    if (!Number.isInteger(info.rows) || info.rows < 0) throw new Error(`${name}: rows must be a non-negative integer`);
    if (typeof info.sha256 !== "string" || !/^[0-9a-f]{64}$/.test(info.sha256)) {
      throw new Error(`${name}: sha256 must be a lowercase SHA-256 digest`);
    }
    if (!Array.isArray(info.columns) || info.columns.some((column) => typeof column !== "string" || !column)) {
      throw new Error(`${name}: columns must be an array of non-empty strings`);
    }
    if (!Array.isArray(info.primaryKey)) throw new Error(`${name}: primaryKey must be an array`);
    if (typeof info.rlsEnabled !== "boolean" || typeof info.rlsForced !== "boolean") {
      throw new Error(`${name}: rls flags must be booleans`);
    }
    if (!Array.isArray(info.triggers) || info.triggers.some((trigger) => typeof trigger?.name !== "string" || typeof trigger?.enabled !== "string")) {
      throw new Error(`${name}: triggers must be an array of {name, enabled}`);
    }
  }
  return { dir, manifest };
}
