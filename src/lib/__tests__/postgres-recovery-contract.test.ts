// Unit tests for the novatrade-pg-recovery contract (scripts/postgres-recovery-contract.mjs).
// Always run — no database required. Covers fail-closed classification, digest
// canonicalization, manifest validation negatives, and URL safety guards.
import { mkdtempSync, rmSync, writeFileSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { afterAll, describe, expect, it } from "vitest";

import { TABLE_NAMES } from "../../../scripts/data-transfer-contract.mjs";
import {
  PG_RECOVERY_BOUNDARIES,
  PG_RECOVERY_DUMP_FILE,
  PG_RECOVERY_FAMILIES,
  PG_RECOVERY_MANIFEST_FILE,
  PG_RECOVERY_CHECKSUMS_FILE,
  PG_RECOVERY_TABLE_BY_NAME,
  PG_RECOVERY_TABLE_NAMES,
  assertLoopbackUrl,
  canonicalizeRow,
  classifyPublicTableSet,
  databaseNameOf,
  digestRows,
  parseDatabaseUrl,
  redactUrl,
  serializeManifest,
  sha256Buffer,
  validatePostgresRecoveryArchive,
} from "../../../scripts/postgres-recovery-contract.mjs";

const dirs: string[] = [];
function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "pgrcv-contract-"));
  dirs.push(dir);
  return dir;
}

afterAll(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

function migrationTableNames(): Set<string> {
  // Mirrors the extractor in scripts/verify-data-recovery.mjs: CREATE TABLE
  // statements only, comment-only lines stripped first.
  const sql = readdirSync(resolve("supabase/migrations"))
    .filter((file) => file.endsWith(".sql")).sort()
    .map((file) => readFileSync(join("supabase", "migrations", file), "utf8"))
    .join("\n");
  const tables = new Set<string>();
  const pattern = /CREATE\s+TABLE(?:\s+IF\s+NOT\s+EXISTS)?\s+(?:public\.)?([a-z_][a-z0-9_]*)/gi;
  const commentFree = sql.split("\n").filter((line) => !/^\s*--/.test(line)).join("\n");
  for (const match of commentFree.matchAll(pattern)) tables.add(match[1]);
  return tables;
}

function baseManifest(dumpBytes: Buffer): Record<string, unknown> {
  const tables: Record<string, unknown> = {};
  for (const name of PG_RECOVERY_TABLE_NAMES) {
    tables[name] = {
      rows: 0,
      sha256: "0".repeat(64),
      columns: ["id"],
      primaryKey: ["id"],
      rlsEnabled: false,
      rlsForced: false,
      triggers: [],
    };
  }
  return {
    format: "novatrade-pg-recovery",
    schemaVersion: 1,
    createdAt: "2026-09-14T00:00:00.000Z",
    generator: { tool: "scripts/postgres-recovery.mjs" },
    source: {
      kind: "postgres",
      database: "unit_test",
      serverVersionNum: 160000,
      hostClass: "loopback",
      consistency: "pg_export_snapshot",
      extensions: [{ name: "pgcrypto", schema: "extensions" }],
    },
    coverage: {
      contract: "pg-recovery-v1",
      schema: "public",
      tableCount: PG_RECOVERY_TABLE_NAMES.length,
      families: PG_RECOVERY_FAMILIES,
      boundaries: PG_RECOVERY_BOUNDARIES,
    },
    tables,
    archive: {
      file: PG_RECOVERY_DUMP_FILE,
      format: "pg_dump-custom",
      bytes: dumpBytes.byteLength,
      sha256: sha256Buffer(dumpBytes),
      secretBearing: true,
      secretBearingReasons: ["test"],
      requiredRoles: [],
      dumpTableData: [...PG_RECOVERY_TABLE_NAMES].sort(),
    },
  };
}

function writeArchive(dir: string, manifest: Record<string, unknown>, dump: Buffer): void {
  writeFileSync(join(dir, PG_RECOVERY_MANIFEST_FILE), serializeManifest(manifest));
  writeFileSync(join(dir, PG_RECOVERY_DUMP_FILE), dump);
  writeFileSync(join(dir, PG_RECOVERY_CHECKSUMS_FILE), [
    `${sha256Buffer(readFileSync(join(dir, PG_RECOVERY_MANIFEST_FILE)))}  ${PG_RECOVERY_MANIFEST_FILE}`,
    `${sha256Buffer(dump)}  ${PG_RECOVERY_DUMP_FILE}`,
  ].join("\n") + "\n");
}

describe("pg-recovery contract classification", () => {
  it("classifies exactly the migration-created public table set", () => {
    const migrated = migrationTableNames();
    const contract = new Set(PG_RECOVERY_TABLE_NAMES);
    const unclassified = [...migrated].filter((name) => !contract.has(name));
    const contractOnly = [...contract].filter((name) => !migrated.has(name));
    expect(unclassified, "migration tables missing from the contract").toEqual([]);
    expect(contractOnly, "contract entries with no migration table").toEqual([]);
    expect(PG_RECOVERY_TABLE_NAMES).toHaveLength(migrated.size);
  });

  it("fails closed on an unclassified new table", () => {
    expect(() => classifyPublicTableSet([...PG_RECOVERY_TABLE_NAMES, "brand_new_table"]))
      .toThrow(/unclassified.*brand_new_table/i);
  });

  it("fails closed on a vanished classified table", () => {
    const missingOne = PG_RECOVERY_TABLE_NAMES.filter((name) => name !== "tenants");
    expect(() => classifyPublicTableSet(missingOne)).toThrow(/missing.*tenants/i);
  });

  it("keeps every frozen v3/v4 portable table marked portable", () => {
    for (const name of TABLE_NAMES) {
      const entry = PG_RECOVERY_TABLE_BY_NAME.get(name);
      expect(entry, `portable table ${name} missing from pg contract`).toBeDefined();
      expect(entry?.portable).toBe(true);
    }
  });

  it("marks only tenant_membership_mutation_journal as the SQLite auxiliary", () => {
    const aux = PG_RECOVERY_TABLE_NAMES.filter(
      (name) => PG_RECOVERY_TABLE_BY_NAME.get(name)?.sqliteAuxiliary === true);
    expect(aux).toEqual(["tenant_membership_mutation_journal"]);
  });

  it("declares the platform-owned recovery boundaries", () => {
    const scopes = PG_RECOVERY_BOUNDARIES.map((boundary) => boundary.scope).sort();
    expect(scopes).toEqual([
      "auth", "environment", "extensions", "storage", "supabase_migrations", "vault",
    ]);
  });

  it("records the secret-bearing columns on settings", () => {
    const settings = PG_RECOVERY_TABLE_BY_NAME.get("settings");
    expect(settings?.secretColumns).toEqual(expect.arrayContaining([
      "openai_api_key_encrypted",
      "google_places_api_key_encrypted",
      "google_maps_browser_api_key_encrypted",
    ]));
  });
});

describe("pg-recovery digest canonicalization", () => {
  it("produces order-independent row digests", () => {
    const left = canonicalizeRow({ b: 2, a: 1 });
    const right = canonicalizeRow({ a: 1, b: 2 });
    expect(left).toBe(right);
    expect(digestRows([{ b: 2, a: 1 }])).toBe(digestRows([{ a: 1, b: 2 }]));
  });

  it("canonicalizes Dates, bigints, Buffers, and nested objects deterministically", () => {
    const row = {
      at: new Date("2026-08-29T12:00:00.000Z"),
      n: BigInt(42),
      blob: Buffer.from([0xde, 0xad]),
      nested: { y: [1, null], x: true },
    };
    const first = digestRows([row]);
    const second = digestRows([{ blob: Buffer.from([0xde, 0xad]), nested: { x: true, y: [1, null] }, n: BigInt(42), at: new Date("2026-08-29T12:00:00.000Z") }]);
    expect(first).toBe(second);
  });

  it("distinguishes row order and contents", () => {
    const a = digestRows([{ id: 1 }]);
    const b = digestRows([{ id: 2 }]);
    expect(a).not.toBe(b);
    expect(digestRows([{ id: 1 }, { id: 2 }])).toBe(digestRows([{ id: 2 }, { id: 1 }]));
  });

  it("rejects non-finite numbers", () => {
    expect(() => canonicalizeRow({ v: Number.NaN })).toThrow(/non-finite/i);
    expect(() => canonicalizeRow({ v: Number.POSITIVE_INFINITY })).toThrow(/non-finite/i);
  });
});

describe("pg-recovery URL guards", () => {
  it("accepts loopback and refuses remote endpoints without acknowledgement", () => {
    const loopback = parseDatabaseUrl("postgresql://postgres:pw@127.0.0.1:5432/app");
    expect(() => assertLoopbackUrl(loopback)).not.toThrow();
    const remote = parseDatabaseUrl("postgresql://postgres:pw@db.internal:5432/app");
    expect(() => assertLoopbackUrl(remote)).toThrow(/loopback/i);
    expect(() => assertLoopbackUrl(remote, { allowRemote: true })).not.toThrow();
  });

  it("rejects non-postgres schemes and missing database names", () => {
    expect(() => parseDatabaseUrl("https://example.com/db")).toThrow(/postgres/i);
    expect(() => parseDatabaseUrl("not a url")).toThrow(/valid URL/i);
    expect(() => databaseNameOf(parseDatabaseUrl("postgresql://h:1/"))).toThrow(/name a database/i);
  });

  it("redacts credentials from URLs", () => {
    const redacted = redactUrl("postgresql://admin:s3cret-pw@127.0.0.1:5432/app");
    expect(redacted).not.toContain("s3cret-pw");
    expect(redactUrl("not a url")).toBe("<invalid-url>");
  });
});

describe("pg-recovery archive validation", () => {
  it("accepts a well-formed archive", () => {
    const dir = tempDir();
    const dump = Buffer.from("PGDMP fixture bytes");
    writeArchive(dir, baseManifest(dump), dump);
    const validated = validatePostgresRecoveryArchive(dir);
    expect(validated.manifest.format).toBe("novatrade-pg-recovery");
    expect(Object.keys(validated.manifest.tables)).toHaveLength(PG_RECOVERY_TABLE_NAMES.length);
  });

  it("rejects a corrupted dump", () => {
    const dir = tempDir();
    const dump = Buffer.from("PGDMP fixture bytes");
    writeArchive(dir, baseManifest(dump), dump);
    const corrupt = Buffer.from(dump);
    corrupt[0] = corrupt[0] ^ 0xff;
    writeFileSync(join(dir, PG_RECOVERY_DUMP_FILE), corrupt);
    expect(() => validatePostgresRecoveryArchive(dir)).toThrow(/SHA256SUMS|corrupted|tampered/i);
  });

  it("rejects a manifest edited without updating the checksum envelope", () => {
    const dir = tempDir();
    const dump = Buffer.from("PGDMP fixture bytes");
    writeArchive(dir, baseManifest(dump), dump);
    const manifest = JSON.parse(readFileSync(join(dir, PG_RECOVERY_MANIFEST_FILE), "utf8"));
    delete manifest.tables.tenants;
    writeFileSync(join(dir, PG_RECOVERY_MANIFEST_FILE), JSON.stringify(manifest));
    expect(() => validatePostgresRecoveryArchive(dir)).toThrow(/SHA256SUMS|corrupted|tampered/i);
  });

  it("rejects a consistently tampered manifest that drops a table", () => {
    const dir = tempDir();
    const dump = Buffer.from("PGDMP fixture bytes");
    const manifest = baseManifest(dump);
    const tables = manifest.tables as Record<string, unknown>;
    delete tables.tenants;
    writeArchive(dir, manifest, dump);
    expect(() => validatePostgresRecoveryArchive(dir)).toThrow(/coverage mismatch/i);
  });

  it("rejects a consistently tampered manifest that adds an unclassified table", () => {
    const dir = tempDir();
    const dump = Buffer.from("PGDMP fixture bytes");
    const manifest = baseManifest(dump);
    const tables = manifest.tables as Record<string, unknown>;
    tables.sneaky_extra = {
      rows: 0, sha256: "0".repeat(64), columns: ["id"], primaryKey: ["id"],
      rlsEnabled: false, rlsForced: false, triggers: [],
    };
    (manifest.archive as { dumpTableData: string[] }).dumpTableData.push("sneaky_extra");
    writeArchive(dir, manifest, dump);
    expect(() => validatePostgresRecoveryArchive(dir)).toThrow(/coverage|unclassified|dumpTableData/i);
  });

  it("rejects wrong format/schemaVersion and non-secret-bearing archives", () => {
    for (const mutate of [
      (manifest: Record<string, unknown>) => { manifest.format = "other"; },
      (manifest: Record<string, unknown>) => { manifest.schemaVersion = 2; },
      (manifest: Record<string, unknown>) => {
        (manifest.archive as { secretBearing: boolean }).secretBearing = false;
      },
      (manifest: Record<string, unknown>) => {
        (manifest.archive as { secretBearingReasons: string[] }).secretBearingReasons = [];
      },
    ]) {
      const dir = tempDir();
      const dump = Buffer.from("PGDMP fixture bytes");
      const manifest = baseManifest(dump);
      mutate(manifest);
      writeArchive(dir, manifest, dump);
      expect(() => validatePostgresRecoveryArchive(dir)).toThrow();
    }
  });

  it("rejects missing files and malformed checksum envelopes", () => {
    const dir = tempDir();
    const dump = Buffer.from("PGDMP fixture bytes");
    writeArchive(dir, baseManifest(dump), dump);
    expect(() => validatePostgresRecoveryArchive(dir)).not.toThrow();
    rmSync(join(dir, PG_RECOVERY_DUMP_FILE));
    expect(() => validatePostgresRecoveryArchive(dir)).toThrow(/missing required file/i);

    const dir2 = tempDir();
    writeArchive(dir2, baseManifest(dump), dump);
    writeFileSync(join(dir2, PG_RECOVERY_CHECKSUMS_FILE), "garbage line\n");
    expect(() => validatePostgresRecoveryArchive(dir2)).toThrow(/malformed/i);
  });
});
