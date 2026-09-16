import Database from "better-sqlite3";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

import {
  DATA_EXPORT_SCHEMA_VERSION,
  LEGACY_DATA_EXPORT_SCHEMA_VERSION,
  TABLE_NAMES,
  DYNAMIC_SOURCE_TABLES,
  loadSqliteUniqueKeyMetadata,
  parseCliArgs,
  quoteIdent,
  sqliteKeyMetadataSupportsIdentity,
  tableContractsForSchemaVersion,
  validateDataExportDirectory,
} from "./data-transfer-contract.mjs";
import {
  PG_RECOVERY_TABLE_NAMES,
  PG_RECOVERY_TABLE_BY_NAME,
  validatePostgresRecoveryArchive,
} from "./postgres-recovery-contract.mjs";

const repoRoot = path.resolve(import.meta.dirname, "..");

// The SQLite tenant membership mutation journal is deliberately outside the
// portable recovery export contract: it is local admin state (never tenant
// data) and it is excluded from the manifest-locked SQLITE_SCHEMA_V1 by its
// own schema tests. L-02 additionally ports it as a Postgres twin
// (202609120010); the pg-recovery contract marks it `sqliteAuxiliary`, and the
// Postgres guard below allows that explicit dual-homing.
const SQLITE_LOCAL_AUXILIARY_TABLES = Object.freeze(["tenant_membership_mutation_journal"]);

function verifyTrackedTableCoverage() {
  const sqliteSchema = fs.readFileSync(path.join(repoRoot, "src/lib/db/schema.ts"), "utf8");
  const sqliteTables = extractCreatedTables(sqliteSchema);
  assertExactTableSet(sqliteTables, "src/lib/db/schema.ts", {
    allowedMissing: new Set(DYNAMIC_SOURCE_TABLES),
    allowedExtra: new Set(SQLITE_LOCAL_AUXILIARY_TABLES),
  });

  const migrationsDir = path.join(repoRoot, "supabase/migrations");
  const migrationSql = fs.readdirSync(migrationsDir)
    .filter((file) => file.endsWith(".sql"))
    .sort()
    .map((file) => fs.readFileSync(path.join(migrationsDir, file), "utf8"))
    .join("\n");
  const migrationTables = extractCreatedTables(migrationSql);
  // The migrated public-table set must equal the pg-recovery contract exactly:
  // every table the migrations create is classified (durable today; an
  // explicit exclusion requires a reason in the contract), and every
  // classified table exists. An unclassified new migration table fails closed.
  const unclassified = [...migrationTables].filter((table) => !PG_RECOVERY_TABLE_BY_NAME.has(table)).sort();
  const contractOnly = PG_RECOVERY_TABLE_NAMES.filter((table) => !migrationTables.has(table)).sort();
  if (unclassified.length > 0 || contractOnly.length > 0) {
    throw new Error(
      `supabase/migrations: pg-recovery coverage mismatch; unclassified [${unclassified.join(", ")}], missing [${contractOnly.join(", ")}]. `
      + "Update scripts/postgres-recovery-contract.mjs with an explicit classification for each new public table.",
    );
  }
  // The frozen v3/v4 portable contract remains a strict subset of the
  // pg-recovery classification and keeps its `portable` marker.
  const portableMissing = TABLE_NAMES.filter((table) => {
    const entry = PG_RECOVERY_TABLE_BY_NAME.get(table);
    return !entry || entry.portable !== true;
  });
  if (portableMissing.length > 0) {
    throw new Error(`postgres-recovery-contract: portable v3/v4 tables lost their portable classification: [${portableMissing.join(", ")}]`);
  }
  // SQLite-local auxiliaries must never appear on PostgreSQL, except for
  // tables explicitly dual-homed via `sqliteAuxiliary` in the pg-recovery
  // contract (L-02 ports the membership-mutation journal as a Postgres twin;
  // see its migration header).
  for (const table of SQLITE_LOCAL_AUXILIARY_TABLES) {
    if (migrationTables.has(table) && PG_RECOVERY_TABLE_BY_NAME.get(table)?.sqliteAuxiliary !== true) {
      throw new Error(`supabase/migrations: SQLite-local auxiliary table ${table} must never be created on PostgreSQL`);
    }
  }
}

export function verifySqliteDatabase(inputPath, tableContracts, selectedSchemaVersion) {
  if (!fs.existsSync(inputPath)) throw new Error(`SQLite DB not found: ${inputPath}`);
  const db = new Database(inputPath, { readonly: true, fileMustExist: true });
  try {
    for (const contract of tableContracts) {
      const schema = db.prepare(`PRAGMA table_info(${quoteIdent(contract.name)})`).all();
      if (schema.length === 0) {
        if (contract.dynamicSource) throw new Error(`${contract.name}: T-028 SQLite preparation is required; receipt table is not prepared`);
        throw new Error(`${contract.name}: missing from SQLite database`);
      }
      const primaryKey = schema
        .filter(({ pk }) => Number(pk) > 0)
        .sort((left, right) => Number(left.pk) - Number(right.pk))
        .map(({ name }) => String(name));
      if (selectedSchemaVersion === LEGACY_DATA_EXPORT_SCHEMA_VERSION
        && !sameStringArray(primaryKey, contract.physicalPrimaryKey)) {
        throw new Error(`${contract.name}: SQLite primary key does not match the recovery contract`);
      }
      const columns = new Set(schema.map(({ name }) => String(name)));
      for (const column of contract.rowIdentity) {
        if (!columns.has(column)) throw new Error(`${contract.name}: schema-${selectedSchemaVersion} row identity column ${column} is missing`);
      }
      if (selectedSchemaVersion !== LEGACY_DATA_EXPORT_SCHEMA_VERSION) {
        const uniqueKeys = loadSqliteUniqueKeyMetadata(db, contract.name);
        if (!sqliteKeyMetadataSupportsIdentity(primaryKey, uniqueKeys, contract)) {
          throw new Error(`${contract.name}: schema-${selectedSchemaVersion} row identity lacks exact SQLite unique enforcement`);
        }
      }
      for (const column of contract.excludedColumns) {
        if (!columns.has(column)) throw new Error(`${contract.name}: protected source column ${column} is missing`);
      }
    }
  } finally {
    db.close();
  }
}

function extractCreatedTables(sql) {
  const tables = new Set();
  const pattern = /CREATE\s+TABLE(?:\s+IF\s+NOT\s+EXISTS)?\s+(?:public\.)?([a-z_][a-z0-9_]*)/gi;
  const commentFree = sql.split("\n")
    .filter((line) => !/^\s*--/.test(line))
    .join("\n");
  for (const match of commentFree.matchAll(pattern)) tables.add(match[1]);
  return tables;
}

function assertExactTableSet(actual, label, { allowedMissing = new Set(), allowedExtra = new Set() } = {}) {
  const missing = TABLE_NAMES.filter((table) => !actual.has(table) && !allowedMissing.has(table));
  const unexpected = [...actual].filter((table) => !TABLE_NAMES.includes(table) && !allowedExtra.has(table));
  if (missing.length > 0 || unexpected.length > 0) {
    throw new Error(`${label}: recovery table set mismatch; missing [${missing.join(", ")}], unexpected [${unexpected.join(", ")}]`);
  }
}

function sameStringArray(left, right) {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function main() {
  const args = parseCliArgs(process.argv.slice(2));
  const schemaVersion = Number(args.get("schema-version") ?? DATA_EXPORT_SCHEMA_VERSION);
  const contracts = tableContractsForSchemaVersion(schemaVersion);

  verifyTrackedTableCoverage();
  console.log(`Recovery contract: ${TABLE_NAMES.length} portable v3/v4 tables match SQLite schema; all ${PG_RECOVERY_TABLE_NAMES.length} migrated public tables are classified by the pg-recovery contract.`);

  const dbArg = args.get("db");
  if (typeof dbArg === "string") {
    verifySqliteDatabase(path.resolve(dbArg), contracts, schemaVersion);
    console.log(`SQLite schema: ${path.resolve(dbArg)} matches recovery schema ${schemaVersion} (read-only check).`);
  } else if (dbArg === true) {
    throw new Error("--db requires a SQLite file path");
  }

  const dirArg = args.get("dir");
  if (typeof dirArg === "string") {
    const validated = validateDataExportDirectory(dirArg);
    const totalRows = validated.manifest.tableOrder.reduce(
      (sum, table) => sum + validated.manifest.tables[table].rows,
      0,
    );
    console.log(`Export archive: ${validated.dir} passed manifest, checksum, row, key, and secret-exclusion checks (${totalRows} rows).`);
  } else if (dirArg === true) {
    throw new Error("--dir requires an export directory path");
  }

  const pgArchiveArg = args.get("pg-archive");
  if (typeof pgArchiveArg === "string") {
    const validated = validatePostgresRecoveryArchive(pgArchiveArg);
    const totalRows = Object.values(validated.manifest.tables).reduce((sum, table) => sum + table.rows, 0);
    console.log(`Postgres recovery archive: ${validated.dir} passed integrity, coverage, and contract checks (${PG_RECOVERY_TABLE_NAMES.length} tables, ${totalRows} rows).`);
  } else if (pgArchiveArg === true) {
    throw new Error("--pg-archive requires a recovery archive directory path");
  }
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) main();
