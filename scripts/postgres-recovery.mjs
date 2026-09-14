#!/usr/bin/env node
// PostgreSQL-native recovery tooling for the "novatrade-pg-recovery" contract
// (schema version 1, see scripts/postgres-recovery-contract.mjs and
// docs/DATA_RECOVERY_POSTGRES.md).
//
// Commands:
//   coverage --url <postgres-url>                     classify every public table (fail-closed)
//   backup   --url <postgres-url> --out <dir>         pg_dump -Fc archive + manifest + SHA256SUMS
//   verify   --dir <dir>                              offline archive integrity/contract check
//   restore  --dir <dir> --url <url> --database <db>  guarded atomic restore + post-verify
//
// pg_dump/pg_restore/psql are invoked as child processes. Override their argv
// prefix with --pg-dump-cmd/--pg-restore-cmd/--psql-cmd (whitespace-separated,
// e.g. "docker exec -i <container> pg_dump") or PG_DUMP_COMMAND /
// PG_RESTORE_COMMAND / PSQL_COMMAND. When the tools see a different network
// namespace than this script (e.g. docker exec), pass --tool-url with the URL
// as reachable from the tool side; it must name the SAME database and user,
// and the tool side must prove it lands on the same cluster instance
// (system_identifier probe). Credentials are never printed; a URL password is
// moved to PGPASSWORD for host-side tools, and tool stderr is never surfaced
// in errors — an allowlisted tool/exit/timeout diagnostic is returned, with
// raw stderr retained only via an explicit opt-in 0600 file
// (PG_RECOVERY_TOOL_STDERR_FILE).
//
// Consistency model: backup opens a REPEATABLE READ transaction, exports its
// snapshot via pg_export_snapshot(), and passes --snapshot to pg_dump so the
// archive and the manifest's per-table digests are captured under the exact
// same MVCC snapshot — concurrent writes during backup cannot split them.
//
// Restore model: every destructive check is re-verified inside the single
// psql transaction (database, user, cluster system_identifier, empty public
// schema, required roles and extensions), then `DROP SCHEMA public RESTRICT` —
// never CASCADE — swaps the schema only if nothing new appeared, and the
// archive script replays under its own \restrict guard. Any failure inside
// that transaction leaves the destination untouched; post-restore
// verification runs after commit, so a verification failure leaves the
// isolated destination in place for investigation (drop it manually).

import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";
import { pipeline } from "node:stream/promises";
import { pathToFileURL } from "node:url";

import postgres from "postgres";

import { parseCliArgs } from "./data-transfer-contract.mjs";
import {
  PG_RECOVERY_BOUNDARIES,
  PG_RECOVERY_DUMP_FILE,
  PG_RECOVERY_DUMP_FORMAT,
  PG_RECOVERY_FAMILIES,
  PG_RECOVERY_FORMAT,
  PG_RECOVERY_MANIFEST_FILE,
  PG_RECOVERY_REQUIRED_ROLE_BUILTINS,
  PG_RECOVERY_SCHEMA_VERSION,
  PG_RECOVERY_SECRET_BEARING_REASONS,
  PG_RECOVERY_TABLE_NAMES,
  PG_RECOVERY_TABLES,
  assertLoopbackUrl,
  classifyPublicTableSet,
  computeTableDigest,
  databaseNameOf,
  introspectPublicTables,
  listPublicTables,
  parseDatabaseUrl,
  redactUrl,
  serializeManifest,
  sha256Buffer,
  validatePostgresRecoveryArchive,
} from "./postgres-recovery-contract.mjs";

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);
const DEFAULT_TOOL_TIMEOUT_MS = 10 * 60 * 1000;
const MAX_TOOL_STDERR_BYTES = 64 * 1024;

function toolTimeoutMs(args) {
  const raw = args instanceof Map ? args.get("tool-timeout-ms") : undefined;
  const parsed = Number(raw ?? process.env.PG_RECOVERY_TOOL_TIMEOUT_MS ?? DEFAULT_TOOL_TIMEOUT_MS);
  if (!Number.isFinite(parsed) || parsed <= 0) return DEFAULT_TOOL_TIMEOUT_MS;
  return Math.floor(parsed);
}

function connectSql(rawUrl) {
  const url = parseDatabaseUrl(rawUrl);
  return postgres(rawUrl, {
    ssl: LOOPBACK_HOSTS.has(url.hostname) ? false : "require",
    prepare: false,
    max: 1,
    idle_timeout: 20,
    connect_timeout: 15,
    onnotice: () => undefined,
  });
}

function parseToolCommand(value, fallback) {
  if (value === undefined || value === null) return fallback;
  if (typeof value !== "string" || !value.trim()) throw new Error("tool command must be a non-empty argv string");
  return value.trim().split(/\s+/);
}

function toolPrefixes(args) {
  return {
    pgDump: parseToolCommand(args.get("pg-dump-cmd") ?? process.env.PG_DUMP_COMMAND, ["pg_dump"]),
    pgRestore: parseToolCommand(args.get("pg-restore-cmd") ?? process.env.PG_RESTORE_COMMAND, ["pg_restore"]),
    psql: parseToolCommand(args.get("psql-cmd") ?? process.env.PSQL_COMMAND, ["psql"]),
  };
}

// pg tools receive the database via --dbname <url>. When the URL carries a
// password it is moved to PGPASSWORD so it stays off argv for host-side tools.
// docker-exec style prefixes embed their own `-e PGPASSWORD=` and use a
// --tool-url valid inside that namespace.
function toolTarget(rawUrl, toolUrlOverride) {
  const toolUrl = toolUrlOverride ?? rawUrl;
  const parsed = parseDatabaseUrl(toolUrl, "tool URL");
  const env = {};
  if (parsed.password) {
    env.PGPASSWORD = decodeURIComponent(parsed.password);
    parsed.password = "";
  }
  return { dbname: parsed.toString(), env, url: parsed };
}

// The tool-side URL may traverse a different namespace (docker exec) but must
// target the same database under the same user identity as --url.
function assertToolUrlBinding(url, tool) {
  const expectedDb = databaseNameOf(url);
  const toolDb = databaseNameOf(tool.url);
  if (toolDb !== expectedDb) {
    throw new Error(`--tool-url database "${toolDb}" does not match --url database "${expectedDb}"; the tool target must be the same database reached through its own namespace`);
  }
  const expectedUser = decodeURIComponent(url.username || "");
  const toolUser = decodeURIComponent(tool.url.username || "");
  if (toolUser !== expectedUser) {
    throw new Error(`--tool-url user "${toolUser || "<none>"}" does not match --url user "${expectedUser || "<none>"}"`);
  }
}

// Tool failures never surface raw stderr: PostgreSQL ERROR lines can echo
// rejected input values and quoted secrets, and multiline continuations evade
// any prefix filter. The thrown error is a bounded allowlist only — tool name
// plus exit/timeout status. Raw stderr is retained only when the operator
// explicitly opts in by pointing PG_RECOVERY_TOOL_STDERR_FILE at a fresh path;
// it is then written exclusively with mode 0600 and never appears on
// console/receipts or inside the thrown error.
function retainToolStderr(stderr) {
  const target = process.env.PG_RECOVERY_TOOL_STDERR_FILE;
  if (!target || !stderr) return;
  try {
    fs.writeFileSync(path.resolve(target), stderr, { flag: "wx", mode: 0o600 });
  } catch {
    // debugging aid only — must never fail the operation or leak into errors
  }
}

function toolError(command, code, stderr, extra = "") {
  retainToolStderr(stderr);
  const status = typeof code === "string" ? code : `exit ${code}`;
  return new Error(`${command} failed (${status})${extra ? ` — ${extra}` : ""}; tool diagnostics withheld (set PG_RECOVERY_TOOL_STDERR_FILE to retain raw stderr in a private 0600 file)`);
}

// Spawn a pg tool with bounded stderr capture, a timeout, and guaranteed
// termination. `done` resolves on close; callers must also await their stdout
// pipeline (set up before awaiting done) so no output is lost mid-flight.
function spawnTool(argv, { env = {}, stdin = "ignore", timeoutMs = DEFAULT_TOOL_TIMEOUT_MS } = {}) {
  const [command, ...rest] = argv;
  const errChunks = [];
  let errBytes = 0;
  const child = spawn(command, rest, {
    env: { ...process.env, ...env },
    stdio: [stdin === "ignore" ? "ignore" : "pipe", "pipe", "pipe"],
  });
  child.stderr.on("data", (chunk) => {
    if (errBytes >= MAX_TOOL_STDERR_BYTES) return;
    const keep = Math.min(chunk.length, MAX_TOOL_STDERR_BYTES - errBytes);
    errChunks.push(chunk.subarray(0, keep));
    errBytes += keep;
  });
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    child.kill("SIGKILL");
  }, timeoutMs);
  if (timer.unref) timer.unref();
  const done = new Promise((resolvePromise, reject) => {
    let settled = false;
    child.on("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(new Error(`${command}: failed to launch (${error.message})`));
    });
    child.on("close", (code, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolvePromise({
        code: timedOut ? -1 : (code ?? -1),
        timedOut,
        signal,
        stderr: Buffer.concat(errChunks).toString("utf8"),
      });
    });
  });
  if (stdin !== "ignore" && child.stdin) {
    child.stdin.on("error", () => undefined); // EPIPE surfaces via close
    if (stdin === "manual") {
      // caller drives child.stdin directly (writes + end)
    } else if (Buffer.isBuffer(stdin) || typeof stdin === "string") {
      child.stdin.end(stdin);
    } else {
      stdin.pipe(child.stdin);
    }
  }
  const kill = () => { try { child.kill("SIGKILL"); } catch { /* already gone */ } };
  return { child, done, kill };
}

async function dumpPostgres({ prefix, dbname, env, outFile, snapshot, timeoutMs }) {
  const args = [...prefix, "--format=custom", "--schema=public", "--no-sync"];
  if (snapshot) args.push("--snapshot", snapshot);
  args.push("--dbname", dbname);
  const { child, done, kill } = spawnTool(args, { env, timeoutMs });
  const out = fs.createWriteStream(outFile, { flags: "wx", mode: 0o600 });
  try {
    const [result] = await Promise.all([done, pipeline(child.stdout, out)]);
    if (result.timedOut) throw toolError("pg_dump", "timeout", result.stderr, "tool timeout exceeded");
    if (result.code !== 0) throw toolError("pg_dump", result.code, result.stderr);
  } catch (error) {
    kill();
    await done.catch(() => undefined);
    throw error;
  }
  return fs.statSync(outFile).size;
}

// Render the custom archive to its SQL script, streamed to an exclusively
// created file inside a private mkdtemp directory (never a predictable path).
async function renderDumpScript(prefix, dumpPath, timeoutMs) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "novatrade-pg-recovery-"));
  fs.chmodSync(dir, 0o700);
  const scriptPath = path.join(dir, "restore.sql");
  const { child, done, kill } = spawnTool([...prefix, "-f", "-"], {
    stdin: fs.createReadStream(dumpPath),
    timeoutMs,
  });
  const out = fs.createWriteStream(scriptPath, { flags: "wx", mode: 0o600 });
  try {
    const [result] = await Promise.all([done, pipeline(child.stdout, out)]);
    if (result.timedOut) throw toolError("pg_restore -f -", "timeout", result.stderr, "tool timeout exceeded");
    if (result.code !== 0) throw toolError("pg_restore -f -", result.code, result.stderr);
  } catch (error) {
    kill();
    await done.catch(() => undefined);
    fs.rmSync(dir, { recursive: true, force: true });
    throw error;
  }
  return { dir, scriptPath };
}

async function dumpTocTableData(prefix, dumpPath, timeoutMs) {
  const { child, done, kill } = spawnTool([...prefix, "-l"], {
    stdin: fs.createReadStream(dumpPath),
    timeoutMs,
  });
  const entries = [];
  const rl = readline.createInterface({ input: child.stdout, crlfDelay: Infinity });
  // Both listeners are installed before awaiting completion — the line scan
  // finishes when stdout ends, which precedes close.
  const scan = (async () => {
    for await (const line of rl) {
      const match = /\d+;\s+\d+\s+\d+\s+TABLE DATA\s+public\s+([a-z_][a-z0-9_]*)/i.exec(line);
      if (match) entries.push(match[1]);
    }
  })();
  let result;
  try {
    [result] = await Promise.all([done, scan]);
  } catch (error) {
    kill();
    await done.catch(() => undefined);
    throw error;
  }
  if (result.timedOut) throw toolError("pg_restore -l", "timeout", result.stderr, "tool timeout exceeded");
  if (result.code !== 0) throw toolError("pg_restore -l", result.code, result.stderr);
  return entries.sort();
}

// Scan a rendered restore script for cluster-global role references:
// OWNER TO, GRANT/REVOKE grantees, CREATE POLICY ... TO, and ALTER DEFAULT
// PRIVILEGES FOR ROLE. Streams line-by-line so the script is never resident.
async function scanScriptRoles(scriptPath) {
  const roles = new Set();
  const push = (raw) => {
    const name = raw.trim().replace(/^"|"$/g, "");
    if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) roles.add(name);
  };
  const pushList = (rawList) => {
    for (const part of rawList.split(",")) push(part.replace(/\bWITH\b.*$/s, ""));
  };
  const rl = readline.createInterface({ input: fs.createReadStream(scriptPath), crlfDelay: Infinity });
  for await (const line of rl) {
    if (line.startsWith("\\") || line.startsWith("--")) continue;
    let match = /\bOWNER TO\s+"?([A-Za-z_][A-Za-z0-9_]*)"?/i.exec(line);
    if (match) push(match[1]);
    match = /\bFOR ROLE\s+"?([A-Za-z_][A-Za-z0-9_]*)"?/i.exec(line);
    if (match) push(match[1]);
    if (/^\s*GRANT\b/i.test(line)) {
      match = /\bTO\s+(.+?);?\s*$/i.exec(line);
      if (match) pushList(match[1]);
    }
    if (/^\s*REVOKE\b/i.test(line)) {
      match = /\bFROM\s+(.+?);?\s*$/i.exec(line);
      if (match) pushList(match[1]);
    }
    if (/^\s*CREATE\s+POLICY\b/i.test(line)) {
      match = /\bTO\s+([A-Za-z_"',][A-Za-z0-9_"',\s]*?)(?:\s+USING|\s+WITH|;|$)/i.exec(line);
      if (match) pushList(match[1]);
    }
  }
  return roles;
}

// Run a read-only probe through the tool-side path (the psql prefix +
// --tool-url pair that the destructive restore will use) and return its
// stdout. This is how the restore proves the tool lands on the same cluster
// instance, database, and user that the JS-side connection preflighted.
async function runScalarThroughTool(psqlPrefix, dbname, env, sqlText, timeoutMs) {
  const proc = spawnTool(
    [...psqlPrefix, "-X", "-q", "-A", "-t", "-F", "|", "--dbname", dbname, "-c", sqlText],
    { env, timeoutMs },
  );
  const outChunks = [];
  proc.child.stdout.on("data", (chunk) => outChunks.push(chunk));
  let result;
  try {
    result = await proc.done;
  } catch (error) {
    proc.kill();
    throw error;
  }
  if (result.timedOut) throw toolError("psql probe", "timeout", result.stderr, "tool timeout exceeded");
  if (result.code !== 0) throw toolError("psql probe", result.code, result.stderr);
  return Buffer.concat(outChunks).toString("utf8").trim();
}

async function serverIdentityViaSql(sql) {
  const rows = await sql.unsafe(
    "SELECT current_database() AS db, current_user AS usr, system_identifier::text AS sysid FROM pg_control_system()",
  );
  return { database: String(rows[0].db), user: String(rows[0].usr), systemIdentifier: String(rows[0].sysid) };
}

// Compare JS-side and tool-side identity. A mismatch proves --tool-url reaches
// a different cluster/database/user than the connection we preflighted.
async function assertSameToolTarget({ sql, tools, tool, timeoutMs }) {
  const jsIdentity = await serverIdentityViaSql(sql);
  const probe = await runScalarThroughTool(
    tools.psql, tool.dbname, tool.env,
    "SELECT current_database() || '|' || current_user || '|' || system_identifier::text FROM pg_control_system()",
    timeoutMs,
  );
  const [toolDb, toolUser, toolSysid] = probe.split("|");
  if (!toolDb || !toolUser || !toolSysid) {
    throw new Error("tool-side identity probe returned malformed output; cannot prove the target — refusing to continue");
  }
  if (toolDb !== jsIdentity.database || toolUser !== jsIdentity.user || toolSysid !== jsIdentity.systemIdentifier) {
    throw new Error(
      "tool target mismatch: the tool-side connection reached a different cluster/database/user than the verified --url connection "
      + `(database ${toolDb}/${jsIdentity.database}, user ${toolUser}/${jsIdentity.user}, cluster ${toolSysid}/${jsIdentity.systemIdentifier}); refusing to continue`,
    );
  }
  return jsIdentity;
}

async function serverVersionNum(sql) {
  const rows = await sql.unsafe("SELECT current_setting('server_version_num')::integer AS version");
  return Number(rows[0].version);
}

async function listClusterRoles(sql) {
  const rows = await sql.unsafe("SELECT rolname FROM pg_catalog.pg_roles");
  return new Set(rows.map((row) => String(row.rolname)));
}

async function listExtensions(sql) {
  const rows = await sql.unsafe(
    `SELECT e.extname AS name, n.nspname AS schema
       FROM pg_catalog.pg_extension e
       JOIN pg_catalog.pg_namespace n ON n.oid = e.extnamespace
      ORDER BY e.extname`,
  );
  return rows.map((row) => ({ name: String(row.name), schema: String(row.schema) }));
}

async function assertEmptyPublicSchema(sql) {
  const rows = await sql.unsafe(
    `SELECT
       (SELECT count(*)::integer FROM pg_catalog.pg_class c
          JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
         WHERE n.nspname = 'public' AND c.relkind IN ('r','p','S','v','m','f')) AS relations,
       (SELECT count(*)::integer FROM pg_catalog.pg_proc p
          JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
         WHERE n.nspname = 'public') AS functions,
       (SELECT count(*)::integer FROM pg_catalog.pg_type t
          JOIN pg_catalog.pg_namespace n ON n.oid = t.typnamespace
         WHERE n.nspname = 'public' AND t.typtype IN ('b','c','d','e')) AS types,
       (SELECT count(*)::integer FROM pg_catalog.pg_extension e
          JOIN pg_catalog.pg_namespace n ON n.oid = e.extnamespace
         WHERE n.nspname = 'public') AS extensions`,
  );
  const row = rows[0];
  const counts = `relations=${row.relations}, functions=${row.functions}, types=${row.types}, extensions=${row.extensions}`;
  if (row.relations !== 0 || row.functions !== 0 || row.types !== 0 || row.extensions !== 0) {
    throw new Error(`restore destination is not empty (${counts}); the recovery contract only restores into a freshly created database`);
  }
}

// In-transaction guard replayed verbatim by psql before the archive script.
// Every destructive prerequisite is re-checked inside the same transaction so
// a concurrent change between preflight and restore aborts everything; the
// DROP uses RESTRICT — never CASCADE — so an unexpected dependent object fails
// the drop instead of deleting unrelated data.
export function buildRestoreGuardSql({ database, user, systemIdentifier, requiredRoles, requiredExtensions }) {
  const lit = (value) => `'${String(value).replaceAll("'", "''")}'`;
  const roleList = requiredRoles.map(lit).join(", ");
  const extensionList = requiredExtensions.map(lit).join(", ");
  return `\\set ON_ERROR_STOP on
SET LOCAL lock_timeout = '15s';
DO $pg_recovery_guard$
DECLARE
  leftovers bigint;
  missing text;
BEGIN
  IF current_database() <> ${lit(database)} THEN
    RAISE EXCEPTION 'pg-recovery restore target mismatch: connected database %, expected %', current_database(), ${lit(database)};
  END IF;
  IF current_user <> ${lit(user)} THEN
    RAISE EXCEPTION 'pg-recovery restore identity mismatch: connected user %, expected %', current_user, ${lit(user)};
  END IF;
  IF (SELECT system_identifier::text FROM pg_catalog.pg_control_system()) <> ${lit(systemIdentifier)} THEN
    RAISE EXCEPTION 'pg-recovery restore target mismatch: connected cluster system_identifier %, expected the cluster verified at preflight', (SELECT system_identifier::text FROM pg_catalog.pg_control_system());
  END IF;
  SELECT count(*) INTO leftovers
    FROM pg_catalog.pg_class c
    JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
   WHERE n.nspname = 'public' AND c.relkind IN ('r','p','S','v','m','f');
  IF leftovers <> 0 THEN
    RAISE EXCEPTION 'pg-recovery restore destination public schema is not empty (% relations); refusing destructive restore', leftovers;
  END IF;
  SELECT count(*) INTO leftovers
    FROM pg_catalog.pg_proc p
    JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public';
  IF leftovers <> 0 THEN
    RAISE EXCEPTION 'pg-recovery restore destination public schema has % functions; refusing destructive restore', leftovers;
  END IF;
${requiredRoles.length > 0 ? `  SELECT string_agg(rolname, ', ' ORDER BY rolname) INTO missing
    FROM (SELECT unnest(ARRAY[${roleList}]::text[]) AS rolname) expected
   WHERE NOT EXISTS (SELECT 1 FROM pg_catalog.pg_roles r WHERE r.rolname = expected.rolname);
  IF missing IS NOT NULL THEN
    RAISE EXCEPTION 'pg-recovery restore is missing required roles: %', missing;
  END IF;` : ""}
${requiredExtensions.length > 0 ? `  SELECT string_agg(extname, ', ' ORDER BY extname) INTO missing
    FROM (SELECT unnest(ARRAY[${extensionList}]::text[]) AS extname) expected
   WHERE NOT EXISTS (SELECT 1 FROM pg_catalog.pg_extension e WHERE e.extname = expected.extname);
  IF missing IS NOT NULL THEN
    RAISE EXCEPTION 'pg-recovery restore is missing required extensions: %', missing;
  END IF;` : ""}
END
$pg_recovery_guard$;
DROP SCHEMA public RESTRICT;
`;
}

// ---------- commands ----------

export async function coverageCommand({ url }) {
  const parsed = parseDatabaseUrl(url);
  assertLoopbackUrl(parsed, { label: "coverage" });
  const sql = connectSql(url);
  try {
    const tables = await listPublicTables(sql);
    classifyPublicTableSet(tables, `database ${databaseNameOf(parsed)}`);
    const byFamily = new Map();
    for (const name of tables) {
      const entry = PG_RECOVERY_TABLES.find((table) => table.name === name);
      byFamily.set(entry.family, (byFamily.get(entry.family) ?? 0) + 1);
    }
    return { tableCount: tables.length, byFamily: Object.fromEntries(byFamily) };
  } finally {
    await sql.end({ timeout: 5 });
  }
}

// The output directory must not already exist: recovery archives are
// immutable point-in-time artifacts, and reusing a path risks truncating a
// previous good archive. Parents are created; the leaf is exclusive 0700.
function createExclusiveOutDir(outDir) {
  const resolved = path.resolve(outDir);
  fs.mkdirSync(path.dirname(resolved), { recursive: true });
  try {
    fs.mkdirSync(resolved, { mode: 0o700 });
  } catch (error) {
    if (error && error.code === "EEXIST") {
      throw new Error(`backup output path already exists: ${resolved} — refusing to overwrite; choose a fresh archive directory`);
    }
    throw error;
  }
  const stat = fs.lstatSync(resolved);
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new Error(`backup output path is not a real directory: ${resolved}`);
  }
  fs.chmodSync(resolved, 0o700);
  return resolved;
}

/**
 * @param {{
 *   url: string,
 *   outDir: string,
 *   tools: { pgDump: string[]; pgRestore: string[]; psql: string[] },
 *   toolUrl?: string,
 *   timeoutMs?: number,
 *   afterSnapshotExport?: () => void | Promise<void>,
 * }} options
 * @returns {Promise<Record<string, any>>} the written manifest
 */
export async function backupPostgresRecovery({ url, outDir, tools, toolUrl, timeoutMs, afterSnapshotExport }) {
  const parsed = parseDatabaseUrl(url);
  assertLoopbackUrl(parsed, { allowRemote: false, label: "backup source" });
  const tool = toolTarget(url, toolUrl);
  assertToolUrlBinding(parsed, tool);

  const out = createExclusiveOutDir(outDir);
  const owned = [PG_RECOVERY_DUMP_FILE, PG_RECOVERY_MANIFEST_FILE, "SHA256SUMS"].map((file) => path.join(out, file));
  const cleanupOwned = () => {
    for (const file of owned) fs.rmSync(file, { force: true });
    fs.rmdirSync(out, { recursive: false });
  };

  const session = connectSql(url);
  let reserved;
  try {
    reserved = await session.reserve();
  } catch (error) {
    await session.end({ timeout: 5 }).catch(() => undefined);
    cleanupOwned();
    throw error;
  }
  let inTx = false;
  try {
    // Bind the JS-side source and the tool-side path to the same cluster
    // instance/database/user before pg_dump runs: an exported snapshot id is
    // only meaningful on the cluster that exported it, and a tool-url pointing
    // elsewhere must fail before any archive is produced.
    await assertSameToolTarget({ sql: reserved, tools, tool, timeoutMs });
    // One REPEATABLE READ transaction exports the snapshot that pg_dump then
    // imports: archive bytes and manifest digests share one MVCC snapshot, so
    // concurrent writes can never split them.
    await reserved.unsafe("BEGIN ISOLATION LEVEL REPEATABLE READ");
    inTx = true;
    const snapshotRows = await reserved.unsafe("SELECT pg_export_snapshot() AS snapshot");
    const snapshot = String(snapshotRows[0].snapshot);
    const version = await serverVersionNum(reserved);
    const tables = await listPublicTables(reserved);
    classifyPublicTableSet(tables, `backup source ${databaseNameOf(parsed)}`);
    const introspection = await introspectPublicTables(reserved);
    const extensions = await listExtensions(reserved);
    if (typeof afterSnapshotExport === "function") await afterSnapshotExport();

    const dumpPath = owned[0];
    const bytes = await dumpPostgres({
      prefix: tools.pgDump, dbname: tool.dbname, env: tool.env, outFile: dumpPath, snapshot, timeoutMs,
    });
    const dumpSha = sha256Buffer(fs.readFileSync(dumpPath));

    const tocTables = await dumpTocTableData(tools.pgRestore, dumpPath, timeoutMs);
    const expectedTables = [...PG_RECOVERY_TABLE_NAMES].sort();
    if (tocTables.join(",") !== expectedTables.join(",")) {
      const missingFromDump = expectedTables.filter((name) => !tocTables.includes(name));
      const unexpected = tocTables.filter((name) => !expectedTables.includes(name));
      throw new Error(`dump TOC coverage mismatch — not archived [${missingFromDump.join(", ")}], unexpected [${unexpected.join(", ")}]`);
    }
    const rendered = await renderDumpScript(tools.pgRestore, dumpPath, timeoutMs);
    let requiredRoles;
    try {
      requiredRoles = [...(await scanScriptRoles(rendered.scriptPath))]
        .filter((role) => !PG_RECOVERY_REQUIRED_ROLE_BUILTINS.has(role))
        .sort();
    } finally {
      fs.rmSync(rendered.dir, { recursive: true, force: true });
    }

    const tableManifest = {};
    for (const name of PG_RECOVERY_TABLE_NAMES) {
      const meta = introspection.get(name);
      if (!meta) throw new Error(`classified table ${name} vanished during backup introspection`);
      const digest = await computeTableDigest(reserved, name, meta.columns);
      tableManifest[name] = {
        rows: digest.rows,
        sha256: digest.sha256,
        columns: meta.columns,
        primaryKey: meta.primaryKey,
        rlsEnabled: meta.rlsEnabled,
        rlsForced: meta.rlsForced,
        triggers: meta.triggers,
      };
    }

    const manifest = {
      format: PG_RECOVERY_FORMAT,
      schemaVersion: PG_RECOVERY_SCHEMA_VERSION,
      createdAt: new Date().toISOString(),
      generator: { tool: "scripts/postgres-recovery.mjs" },
      source: {
        kind: "postgres",
        database: databaseNameOf(parsed),
        serverVersionNum: version,
        hostClass: "loopback",
        consistency: "pg_export_snapshot",
        extensions: extensions.filter((extension) => extension.name !== "plpgsql"),
      },
      coverage: {
        contract: "pg-recovery-v1",
        schema: "public",
        tableCount: PG_RECOVERY_TABLE_NAMES.length,
        families: PG_RECOVERY_FAMILIES,
        boundaries: PG_RECOVERY_BOUNDARIES,
      },
      tables: tableManifest,
      archive: {
        file: PG_RECOVERY_DUMP_FILE,
        format: PG_RECOVERY_DUMP_FORMAT,
        bytes,
        sha256: dumpSha,
        secretBearing: true,
        secretBearingReasons: [...PG_RECOVERY_SECRET_BEARING_REASONS],
        requiredRoles,
        dumpTableData: tocTables,
      },
    };
    const manifestPath = owned[1];
    fs.writeFileSync(manifestPath, serializeManifest(manifest), { flag: "wx", mode: 0o600 });
    const checksumsPath = owned[2];
    const checksumLines = [
      `${sha256Buffer(fs.readFileSync(manifestPath))}  ${PG_RECOVERY_MANIFEST_FILE}`,
      `${dumpSha}  ${PG_RECOVERY_DUMP_FILE}`,
    ].join("\n") + "\n";
    fs.writeFileSync(checksumsPath, checksumLines, { flag: "wx", mode: 0o600 });
    await reserved.unsafe("COMMIT");
    inTx = false;
    return manifest;
  } catch (error) {
    if (inTx) {
      await reserved.unsafe("ROLLBACK").catch(() => undefined);
      inTx = false;
    }
    cleanupOwned();
    throw error;
  } finally {
    if (reserved) {
      try { reserved.release(); } catch { /* ended below */ }
    }
    await session.end({ timeout: 5 }).catch(() => undefined);
  }
}

export async function verifyRestoredDatabase({ url, manifest }) {
  const verify = connectSql(url);
  const mismatches = [];
  try {
    const restoredTables = await listPublicTables(verify);
    classifyPublicTableSet(restoredTables, "restored database");
    const introspection = await introspectPublicTables(verify);
    for (const name of PG_RECOVERY_TABLE_NAMES) {
      const expected = manifest.tables[name];
      const actual = introspection.get(name);
      if (!actual) {
        mismatches.push(`${name}: missing after restore`);
        continue;
      }
      if (actual.columns.join(",") !== expected.columns.join(",")) {
        mismatches.push(`${name}: column list differs`);
      }
      if (actual.primaryKey.join(",") !== expected.primaryKey.join(",")) {
        mismatches.push(`${name}: primary key differs`);
      }
      if (actual.rlsEnabled !== expected.rlsEnabled || actual.rlsForced !== expected.rlsForced) {
        mismatches.push(`${name}: RLS state differs (enabled ${actual.rlsEnabled}/${expected.rlsEnabled}, forced ${actual.rlsForced}/${expected.rlsForced})`);
      }
      const actualTriggers = actual.triggers.map((trigger) => `${trigger.name}:${trigger.enabled}`).join(",");
      const expectedTriggers = expected.triggers.map((trigger) => `${trigger.name}:${trigger.enabled}`).join(",");
      if (actualTriggers !== expectedTriggers) {
        mismatches.push(`${name}: trigger state differs (${actualTriggers} vs ${expectedTriggers})`);
      }
      const digest = await computeTableDigest(verify, name, actual.columns);
      if (digest.rows !== expected.rows || digest.sha256 !== expected.sha256) {
        mismatches.push(`${name}: content digest differs (rows ${digest.rows}/${expected.rows})`);
      }
    }
  } finally {
    await verify.end({ timeout: 5 });
  }
  if (mismatches.length > 0) {
    throw new Error(`post-restore verification failed — destination does not match the archive; drop the database and re-run after resolving:\n${mismatches.join("\n")}`);
  }
  return { tables: PG_RECOVERY_TABLE_NAMES.length };
}

/**
 * @param {{
 *   dir: string,
 *   url: string,
 *   database: string,
 *   allowRemote?: boolean,
 *   tools: { pgDump: string[]; pgRestore: string[]; psql: string[] },
 *   toolUrl?: string,
 *   timeoutMs?: number,
 *   beforeRestore?: () => void | Promise<void>,
 * }} options
 * @returns {Promise<{ database: string; tables: number }>}
 */
export async function restorePostgresRecovery({ dir, url, database, allowRemote, tools, toolUrl, timeoutMs, beforeRestore }) {
  const validated = validatePostgresRecoveryArchive(dir);
  const manifest = validated.manifest;
  const parsed = parseDatabaseUrl(url);
  assertLoopbackUrl(parsed, { allowRemote, label: "restore destination" });
  const urlDatabase = databaseNameOf(parsed);
  if (database !== urlDatabase) {
    throw new Error(`restore destination mismatch: --database ${database} does not equal the URL database ${urlDatabase}; naming the destination twice is required so a mistyped URL cannot silently target the wrong database`);
  }
  const tool = toolTarget(url, toolUrl);
  assertToolUrlBinding(parsed, tool);

  const sql = connectSql(url);
  let identity;
  try {
    const version = await serverVersionNum(sql);
    if (version < manifest.source.serverVersionNum) {
      throw new Error(`restore destination server ${version} is older than the archive source ${manifest.source.serverVersionNum}; custom-format archives only restore into the same or a newer PostgreSQL`);
    }
    const clusterRoles = await listClusterRoles(sql);
    const missingRoles = manifest.archive.requiredRoles.filter((role) => !clusterRoles.has(role));
    if (missingRoles.length > 0) {
      throw new Error(`restore destination cluster is missing required roles [${missingRoles.join(", ")}]; provision the migration-owned roles before restore (see docs/DATA_RECOVERY_POSTGRES.md)`);
    }
    const destExtensions = new Set((await listExtensions(sql)).map((extension) => extension.name));
    const missingExtensions = (manifest.source.extensions ?? []).filter((extension) => !destExtensions.has(extension.name));
    if (missingExtensions.length > 0) {
      throw new Error(`restore destination is missing required extensions [${missingExtensions.map((extension) => extension.name).join(", ")}]; install them before restore (extensions are a platform boundary)`);
    }
    await assertEmptyPublicSchema(sql);
    // Bind the verified --url connection and the destructive psql tool path to
    // the same cluster instance, database, and user before anything mutates.
    identity = await assertSameToolTarget({ sql, tools, tool, timeoutMs });
  } finally {
    await sql.end({ timeout: 5 });
  }

  // Optional seam used by tests to simulate a concurrent change landing
  // between preflight and the destructive transaction.
  if (typeof beforeRestore === "function") await beforeRestore();

  const dumpPath = path.join(validated.dir, PG_RECOVERY_DUMP_FILE);
  const rendered = await renderDumpScript(tools.pgRestore, dumpPath, timeoutMs);
  try {
    const guardSql = buildRestoreGuardSql({
      database: identity.database,
      user: identity.user,
      systemIdentifier: identity.systemIdentifier,
      requiredRoles: manifest.archive.requiredRoles,
      requiredExtensions: (manifest.source.extensions ?? []).map((extension) => extension.name),
    });
    const proc = spawnTool(
      [...tools.psql, "-X", "-q", "-v", "ON_ERROR_STOP=1", "--single-transaction", "--dbname", tool.dbname, "-f", "-"],
      { env: tool.env, stdin: "manual", timeoutMs },
    );
    proc.child.stdin.write(guardSql);
    fs.createReadStream(rendered.scriptPath).pipe(proc.child.stdin);
    const result = await proc.done;
    if (result.timedOut) {
      proc.kill();
      throw toolError("psql restore", "timeout", result.stderr, "tool timeout exceeded");
    }
    if (result.code !== 0) throw toolError("psql restore", result.code, result.stderr);
  } finally {
    fs.rmSync(rendered.dir, { recursive: true, force: true });
  }

  await verifyRestoredDatabase({ url, manifest });
  return { database: urlDatabase, tables: PG_RECOVERY_TABLE_NAMES.length };
}

// ---------- cli ----------

async function main() {
  const argv = process.argv.slice(2);
  const command = argv[0];
  const args = parseCliArgs(argv.slice(1));
  const tools = toolPrefixes(args);
  const timeoutMs = toolTimeoutMs(args);
  const url = args.get("url");
  const toolUrl = args.get("tool-url");
  const allowRemote = args.get("allow-remote") === true;

  switch (command) {
    case "coverage": {
      if (typeof url !== "string") throw new Error("coverage requires --url <postgres-url>");
      const result = await coverageCommand({ url });
      console.log(`Postgres recovery coverage: ${result.tableCount} public tables classified (all durable).`);
      for (const [family, count] of Object.entries(result.byFamily).sort()) {
        console.log(`  ${family}: ${count}`);
      }
      return;
    }
    case "backup": {
      if (typeof url !== "string") throw new Error("backup requires --url <postgres-url>");
      if (typeof args.get("out") !== "string") throw new Error("backup requires --out <dir>");
      const manifest = await backupPostgresRecovery({
        url,
        outDir: String(args.get("out")),
        tools,
        timeoutMs,
        toolUrl: typeof toolUrl === "string" ? toolUrl : undefined,
      });
      console.log(`Recovery archive written to ${String(args.get("out"))}: ${PG_RECOVERY_TABLE_NAMES.length} tables, ${manifest.archive.bytes} dump bytes, sha256 ${manifest.archive.sha256}`);
      console.log("Secret-bearing archive: store encrypted at rest with restricted access. Boundaries: auth/storage/vault/migrations/extensions/env are NOT in the archive.");
      return;
    }
    case "verify": {
      const dir = args.get("dir");
      if (typeof dir !== "string") throw new Error("verify requires --dir <dir>");
      const validated = validatePostgresRecoveryArchive(dir);
      const totalRows = Object.values(validated.manifest.tables).reduce((sum, table) => sum + table.rows, 0);
      console.log(`Archive ${validated.dir}: format ${PG_RECOVERY_FORMAT} v${PG_RECOVERY_SCHEMA_VERSION}, ${PG_RECOVERY_TABLE_NAMES.length} tables, ${totalRows} rows, integrity checks passed.`);
      return;
    }
    case "restore": {
      if (typeof url !== "string") throw new Error("restore requires --url <postgres-url>");
      const dir = args.get("dir");
      if (typeof dir !== "string") throw new Error("restore requires --dir <dir>");
      const database = args.get("database");
      if (typeof database !== "string") throw new Error("restore requires --database <name> matching the URL database");
      const result = await restorePostgresRecovery({
        dir,
        url,
        database,
        allowRemote,
        tools,
        timeoutMs,
        toolUrl: typeof toolUrl === "string" ? toolUrl : undefined,
      });
      console.log(`Restore verified: ${result.tables} tables in ${result.database} match the archive exactly (rows, content digests, RLS, triggers).`);
      return;
    }
    default:
      console.log("usage: node scripts/postgres-recovery.mjs <coverage|backup|verify|restore> [flags]");
      process.exit(command ? 1 : 0);
  }
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  main().catch((error) => {
    let message = error instanceof Error ? error.message : String(error);
    for (const candidate of process.argv.slice(2)) {
      if (/^postgres(ql)?:\/\//.test(candidate)) message = message.split(candidate).join(redactUrl(candidate));
    }
    console.error(message);
    process.exitCode = 1;
  });
}
