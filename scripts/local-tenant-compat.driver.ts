/**
 * L-02 local compatibility-cutover driver — bundled by
 * scripts/local-tenant-compat.mjs.
 *
 * Exercises the T-028 legacy-row reconciliation end to end against a real
 * fixture file (`nova-leads-legacy.db`, overridable via LOCAL_COMPAT_DB):
 *
 *   stage    — create a fresh legacy-shaped database: the full schema plus
 *              pre-tenancy rows that carry no tenant scope columns at all
 *   prepare  — prepareSqliteCompatibilityBackfill: adds the nullable scope
 *              columns and the operator-only receipt ledger (idempotent)
 *   run      — snapshot the file, build the manifest by introspecting live
 *              rows, then runSqliteCompatibilityBackfill: installs the
 *              compatibility tenant/workspace/policy + memberships and stamps
 *              every legacy row with the tenant scope in one transaction
 *   replay   — re-runs the same manifest/idempotency key: the receipt ledger
 *              replays the recorded receipt after full drift verification
 *   verify   — read-only dump: per-table scoped counts, memberships, receipt
 *   rollback — restores the pre-run file snapshot (the receipt's own
 *              rollback: "snapshot_restore_only" contract) and proves the
 *              pre-cutover state returns: no tenant, no scoped rows
 *
 * Every identifier is derived deterministically from the fixture seed so the
 * manifest hash — and therefore replay — is stable across processes.
 */
import Database from "better-sqlite3";
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, lstatSync } from "node:fs";
import { SCHEMA_SQL } from "@/lib/db/schema";
import {
  COMPATIBILITY_TENANT_TABLES,
  SQLITE_COMPATIBILITY_CHECKSUM_ALGORITHM,
  SQLITE_COMPATIBILITY_SOURCE_ENGINE,
  compatibilityContentChecksum,
  prepareSqliteCompatibilityBackfill,
  runSqliteCompatibilityBackfill,
  type CompatibilityBackfillManifest,
  type CompatibilityUserMapping,
  type SqliteBackfillDb,
} from "@/lib/tenancy/compatibility-backfill";

const DB_PATH = process.env.LOCAL_COMPAT_DB ?? "nova-leads-legacy.db";
const SNAPSHOT_PATH = `${DB_PATH}.pre-backfill`;
const IDEMPOTENCY_KEY = process.env.LOCAL_COMPAT_IDEM ?? "local-compat-backfill-v1";

type TestDb = Database.Database;

function adapter(db: TestDb): SqliteBackfillDb {
  return {
    all: <T extends Record<string, unknown>>(sql: string, params: readonly unknown[] = []) =>
      db.prepare(sql).all(...params) as T[],
    get: <T extends Record<string, unknown>>(sql: string, params: readonly unknown[] = []) =>
      db.prepare(sql).get(...params) as T | undefined,
    run: (sql: string, params: readonly unknown[] = []) => db.prepare(sql).run(...params),
    transaction: <T>(work: (tx: SqliteBackfillDb) => T, mode?: "deferred" | "immediate") => {
      if (mode === "immediate") {
        db.exec("BEGIN IMMEDIATE");
        try {
          const result = work(adapter(db));
          db.exec("COMMIT");
          return result;
        } catch (error) {
          db.exec("ROLLBACK");
          throw error;
        }
      }
      return db.transaction(() => work(adapter(db)))();
    },
  };
}

function openDb(): TestDb {
  if (!existsSync(DB_PATH)) {
    throw new Error(`${DB_PATH} does not exist — run 'stage' first.`);
  }
  const db = new Database(DB_PATH);
  db.pragma("foreign_keys = ON");
  return db;
}

/** UUID-shaped deterministic id (version nibble 4, variant 8) from a seed. */
function deterministicId(...parts: string[]): string {
  const hex = createHash("sha256").update(["local-compat", ...parts].join(":"), "utf8").digest("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

const OWNER_AUTH = deterministicId("auth", "owner");
const RESEARCHER_AUTH = deterministicId("auth", "researcher");
const DISABLED_AUTH = deterministicId("auth", "disabled");
const TENANT_ID = deterministicId("tenant");
const WORKSPACE_ID = deterministicId("workspace");
const POLICY_ID = deterministicId("policy");

function stage(): void {
  // stage() only ever creates a fresh fixture. If LOCAL_COMPAT_DB (or any of
  // its sidecars / the snapshot path) already exists — including as a symlink
  // — refuse before touching anything; deleting an existing file is the
  // operator's deliberate action, never this tool's.
  const targets = ["", "-journal", "-wal", "-shm"].map((suffix) => `${DB_PATH}${suffix}`);
  targets.push(SNAPSHOT_PATH);
  const existing = targets.filter((target) => {
    try {
      lstatSync(target);
      return true;
    } catch {
      return false;
    }
  });
  if (existing.length > 0) {
    throw new Error(
      `[compat] refusing to stage over existing path(s): ${existing.join(", ")} — ` +
      "remove them deliberately or point LOCAL_COMPAT_DB at a fresh path.",
    );
  }
  const db = new Database(DB_PATH);
  db.pragma("foreign_keys = ON");
  db.exec(SCHEMA_SQL);
  const run = (sql: string, ...params: unknown[]) => db.prepare(sql).run(...params);

  run("INSERT INTO location_markets (id, name, country_code, admin_area1) VALUES (?, ?, 'US', 'CO')", "market-denver", "Denver");
  run("INSERT INTO app_users (id, user_id, email, role, status) VALUES (?, ?, ?, ?, 'active')", "legacy-owner", OWNER_AUTH, "owner@legacy.local", "admin");
  run("INSERT INTO app_users (id, user_id, email, role, status) VALUES (?, ?, ?, ?, 'active')", "legacy-researcher", RESEARCHER_AUTH, "researcher@legacy.local", "researcher");
  run("INSERT INTO app_users (id, user_id, email, role, status) VALUES (?, ?, ?, ?, 'disabled')", "legacy-disabled", DISABLED_AUTH, "disabled@legacy.local", "researcher");
  run("UPDATE app_users SET created_by = ?, team_lead_user_id = ? WHERE id = 'legacy-researcher'", OWNER_AUTH, OWNER_AUTH);
  run("INSERT INTO user_market_access (user_id, market_id, created_by_user_id) VALUES (?, ?, ?)", OWNER_AUTH, "market-denver", OWNER_AUTH);
  run("INSERT INTO crawl_runs (id, categories, status, created_by_user_id) VALUES (?, '[]', 'done', ?)", "run-a", OWNER_AUTH);
  run("INSERT INTO crawl_units (id, crawl_run_id, zip, category) VALUES (?, ?, '80202', 'industrial')", "unit-a", "run-a");
  run("INSERT INTO places_master (place_id, name) VALUES (?, ?)", "place-a", "Synthetic Materials Co");
  run("INSERT INTO place_cache (place_id, raw_json) VALUES (?, '{}')", "place-a");
  run("INSERT INTO place_observations (id, place_id, endpoint, sku, raw_json) VALUES (?, 'place-a', 'places.details', 'standard', '{}')", "obs-a");
  run("INSERT INTO leads (id, place_id, name, assigned_to_user_id) VALUES (?, 'place-a', 'Synthetic Materials Co', ?)", "lead-a", OWNER_AUTH);
  run("INSERT INTO lead_notes (id, lead_id, author_user_id, body) VALUES (?, 'lead-a', ?, 'synthetic note')", "note-a", OWNER_AUTH);
  run("INSERT INTO outreach_events (id, lead_id, channel, actor_user_id) VALUES (?, 'lead-a', 'call', ?)", "outreach-a", OWNER_AUTH);
  run("INSERT INTO admin_requests (id, lead_id, request_type, created_by_user_id, assigned_admin_user_id) VALUES (?, 'lead-a', 'quote_request', ?, ?)", "request-a", OWNER_AUTH, OWNER_AUTH);
  run("INSERT INTO demos (id, lead_id, slug, published_by_user_id) VALUES (?, 'lead-a', 'synthetic-demo', ?)", "demo-a", OWNER_AUTH);
  run("INSERT INTO ai_lead_verifications (id, lead_id, model, status, recommendation, requested_by_user_id) VALUES (?, 'lead-a', 'local-fixture', 'verified', 'keep', ?)", "ver-a", OWNER_AUTH);
  run("INSERT INTO lead_ai_artifacts (id, lead_id, artifact_type, input_hash, prompt_version, requested_by_user_id) VALUES (?, 'lead-a', 'business_detail', ?, 'v1', ?)", "art-a", sha256("artifact-input-a"), OWNER_AUTH);
  run("INSERT INTO ai_feedback_events (id, lead_id, feedback_kind, verdict, actor_user_id) VALUES (?, 'lead-a', 'verification', 'correct', ?)", "fb-a", OWNER_AUTH);
  run("INSERT INTO ai_usage_events (id, model, actor_user_id) VALUES (?, 'local-fixture', ?)", "use-a", OWNER_AUTH);
  run("INSERT INTO api_usage_events (id, endpoint, sku) VALUES (?, 'places.details', 'standard')", "api-a");
  run("INSERT INTO audit_logs (id, action) VALUES (?, ?)", "audit-legacy-1", "legacy.bootstrap");
  db.close();
  console.log(`[compat] staged legacy fixture at ${DB_PATH}`);
}

function buildManifest(db: TestDb): CompatibilityBackfillManifest {
  interface UserRow { id: string; user_id: string; email: string; role: string; status: string }
  const users = db.prepare("SELECT id, user_id, email, role, status FROM app_users ORDER BY id").all() as UserRow[];
  if (users.length === 0) throw new Error("No app_users rows — run 'stage' first.");
  const owner = users.find((user) => user.role === "admin" && user.status === "active");
  if (!owner) throw new Error("No active admin app_user to bind as tenant owner.");
  const legacyUsers: CompatibilityUserMapping[] = users.map((user) => ({
    legacyUserId: user.id,
    authIdentityId: user.user_id,
    expectedEmail: user.email,
    expectedLegacyRole: user.role as "admin" | "researcher",
    expectedStatus: user.status as "active" | "disabled",
    membershipId: deterministicId("membership", user.id),
    workspaceId: WORKSPACE_ID,
    membershipRole: user.role === "admin" ? "owner" : "researcher",
    membershipStatus: user.status === "active" ? "active" : "suspended",
    roleBindingId: deterministicId("binding", user.id),
    marketAccessIds: (db.prepare("SELECT market_id FROM user_market_access WHERE user_id = ?").all(user.user_id) as Array<{ market_id: string }>).map((row) => row.market_id).sort(),
  }));
  const legacyTables = COMPATIBILITY_TENANT_TABLES.map((table) => {
    const rows = db.prepare(`SELECT * FROM "${table}"`).all() as Array<Record<string, unknown>>;
    return { table, rowCount: rows.length, contentChecksum: compatibilityContentChecksum(rows) };
  });
  return {
    schemaVersion: 1,
    sourceEngine: SQLITE_COMPATIBILITY_SOURCE_ENGINE,
    checksumAlgorithm: SQLITE_COMPATIBILITY_CHECKSUM_ALGORITHM,
    idempotencyKey: IDEMPOTENCY_KEY,
    sourceSnapshotFingerprint: sha256(JSON.stringify(legacyTables.map((entry) => [entry.table, entry.contentChecksum]))),
    tenantId: TENANT_ID,
    tenantSlug: "legacy-compatibility",
    tenantName: "Legacy Compatibility Tenant",
    workspaceId: WORKSPACE_ID,
    workspaceSlug: "legacy-website-lead",
    workspaceName: "Legacy Website Lead",
    ownerLegacyUserId: owner.id,
    ownerAuthIdentityId: owner.user_id,
    policyId: POLICY_ID,
    policyVersion: 1,
    policyHash: sha256("local-compat-baseline-policy-v1"),
    legacyUsers,
    legacyTables,
  };
}

export async function main(argv: readonly string[]): Promise<void> {
  const [command] = argv;
  switch (command) {
    case "stage": {
      stage();
      return;
    }
    case "prepare": {
      const db = openDb();
      try {
        const receipt = prepareSqliteCompatibilityBackfill(adapter(db));
        console.log(`[compat] prepare: tenantColumns=[${receipt.addedTenantColumns.join(",")}] workspaceColumns=[${receipt.addedWorkspaceColumns.join(",")}] receiptTableCreated=${receipt.receiptTableCreated}`);
      } finally {
        db.close();
      }
      return;
    }
    case "run":
    case "replay": {
      let db = openDb();
      const manifest = buildManifest(db);
      db.close();
      if (command === "run") {
        // The receipt's rollback contract is snapshot_restore_only — take the
        // pre-cutover file copy the rollback lane restores.
        copyFileSync(DB_PATH, SNAPSHOT_PATH);
      }
      db = openDb();
      try {
        const receipt = runSqliteCompatibilityBackfill(adapter(db), manifest);
        console.log(`[compat] ${command}: receipt=${receipt.receiptId} tenant=${receipt.tenantId} users=${receipt.userCount} tables=${Object.keys(receipt.tableCounts).length} manifest=${receipt.manifestHash.slice(0, 12)} rollback=${receipt.rollback}`);
      } finally {
        db.close();
      }
      return;
    }
    case "verify": {
      const db = openDb();
      try {
        for (const table of COMPATIBILITY_TENANT_TABLES) {
          const row = db.prepare(`SELECT COUNT(*) AS total, SUM(CASE WHEN tenant_id IS NOT NULL THEN 1 ELSE 0 END) AS scoped FROM "${table}"`).get() as { total: number; scoped: number | null };
          console.log(`[compat] ${table}: total=${row.total} scoped=${row.scoped ?? 0}`);
        }
        const memberships = db.prepare("SELECT id, auth_identity_id, status FROM tenant_memberships ORDER BY id").all() as Array<Record<string, unknown>>;
        console.log(`[compat] memberships: ${JSON.stringify(memberships)}`);
        const receipt = db.prepare("SELECT id, status, tenant_id, user_count, substr(manifest_hash, 1, 12) AS manifest FROM compatibility_backfill_receipts").all();
        console.log(`[compat] receipts: ${JSON.stringify(receipt)}`);
      } finally {
        db.close();
      }
      return;
    }
    case "rollback": {
      if (!existsSync(SNAPSHOT_PATH)) {
        throw new Error(`No pre-backfill snapshot at ${SNAPSHOT_PATH} — run 'run' first.`);
      }
      copyFileSync(SNAPSHOT_PATH, DB_PATH);
      const db = openDb();
      try {
        const tenants = (db.prepare("SELECT COUNT(*) AS count FROM tenants").get() as { count: number }).count;
        const memberships = (db.prepare("SELECT COUNT(*) AS count FROM tenant_memberships").get() as { count: number }).count;
        const receipts = (db.prepare("SELECT COUNT(*) AS count FROM compatibility_backfill_receipts").get() as { count: number }).count;
        const scoped = db.prepare(`SELECT COUNT(*) AS count FROM leads WHERE tenant_id IS NOT NULL`).get() as { count: number };
        if (tenants !== 0 || memberships !== 0 || receipts !== 0 || scoped.count !== 0) {
          throw new Error(`rollback verification failed: tenants=${tenants} memberships=${memberships} receipts=${receipts} scopedLeads=${scoped.count}`);
        }
        console.log(`[compat] rollback: snapshot restored — tenants=${tenants} memberships=${memberships} receipts=${receipts} scopedLeads=0`);
      } finally {
        db.close();
      }
      return;
    }
    default:
      console.error("usage: local:tenancy:compat <stage|prepare|run|replay|verify|rollback>");
      process.exitCode = 2;
  }
}
