import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";
import { SCHEMA_SQL } from "@/lib/db/schema";

/**
 * 0X3-234 inventory: every table in the local SQLite schema must be
 * accounted for by exactly one reconciliation class. If a new table lands
 * without an explicit classification, this test fails instead of silently
 * widening the unreconciled set.
 */

const BACKFILL_MIGRATION = "202607270010_add_compatibility_tenant_backfill.sql";

function schemaTables(): string[] {
  const tables = [...SCHEMA_SQL.matchAll(/CREATE TABLE IF NOT EXISTS ([a-z_]+)/g)].map(
    (match) => match[1],
  );
  return [...new Set(tables)].sort();
}

function migrationSource(): string {
  return readFileSync(join(process.cwd(), "supabase", "migrations", BACKFILL_MIGRATION), "utf8");
}

function backfillAllowlist(source: string): string[] {
  const match = source.match(/allowed_tables\s+constant\s+text\[\]\s*:=\s*ARRAY\[([\s\S]*?)\];/);
  if (!match) throw new Error("backfill allowlist not found");
  return [...match[1].matchAll(/'([a-z_]+)'/g)].map((entry) => entry[1]).sort();
}

/** Identity rows reconcile through the manifest legacyUsers mapping, not a table update. */
const MANIFEST_IDENTITY_TABLES = new Set(["app_users"]);

/**
 * Deliberately platform-global: shared geography reference data resolved via
 * market_id, plus the runtime worker envelope that is documented as never
 * carrying tenant authority (migration 202607290003 header).
 */
const PLATFORM_GLOBAL_TABLES = new Set([
  "location_cells",
  "location_markets",
  "worker_runs",
  "zip_codes",
]);

/** Tenant infrastructure introduced post-cutover; no legacy rows exist. */
const TENANT_INFRA_TABLES = new Set([
  "support_access_grant_data_classes",
  "support_access_grant_permissions",
  "support_access_grants",
  "tenant_deletion_checkpoint_events",
  "tenant_deletion_checkpoints",
  "tenant_deletion_jobs",
  "tenant_deletion_tombstones",
  "tenant_export_jobs",
  "tenant_membership_mutation_journal",
  "tenant_memberships",
  "tenant_policies",
  "tenant_role_bindings",
  "tenants",
  "workspaces",
]);

describe("0X3-234 legacy reconciliation inventory", () => {
  it("the backfill allowlist covers every tenant-scoped legacy table", () => {
    const tables = schemaTables();
    const allowlist = backfillAllowlist(migrationSource());

    const unreconciled = tables.filter(
      (table) =>
        !allowlist.includes(table)
        && !MANIFEST_IDENTITY_TABLES.has(table)
        && !PLATFORM_GLOBAL_TABLES.has(table)
        && !TENANT_INFRA_TABLES.has(table),
    );

    expect(unreconciled).toEqual([]);
  });

  it("every allowlist entry names a real table", () => {
    const tables = new Set(schemaTables());
    const unknown = backfillAllowlist(migrationSource()).filter((table) => !tables.has(table));
    expect(unknown).toEqual([]);
  });

  it("audit_logs is preserved as legacy_unscoped, not tenant-rewritten", () => {
    const source = migrationSource();
    expect(source).toContain("preserved_tables constant text[] := ARRAY['audit_logs']");
  });
});
