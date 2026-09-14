#!/usr/bin/env node
// CI disposable PostgreSQL 16 rehearsal orchestrator for the L-02 tenant-ops
// runtime-role lanes (T-015, T-030..T-042). One command brings up a uniquely
// named, digest-pinned postgres:16 container on a loopback ephemeral port,
// replays the portable migration history into a template database, clones the
// per-lane rehearsal databases, and grants each lane's restricted runtime role
// exactly its documented EXECUTE/SELECT surface. `run` executes each suite in
// its own vitest process under that lane's env; `down` removes only the
// container this run created (label-guarded). Never touches nova-local-*.

import { spawnSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { lstatSync, readdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const MIGRATIONS_DIR = join(ROOT, "supabase", "migrations");
const POSTGRES_16 =
  "postgres@sha256:33f923b05f64ca54ac4401c01126a6b92afe839a0aa0a52bc5aeb5cc958e5f20";
const LABEL = "nova-ci-rehearsal=1";
const TEMPLATE_DB = "nova_ci_template";

// Migrations needing Supabase-only runtime objects (pg_net/pg_cron/vault) —
// the documented portable-replay skips shared by every rehearsal lane.
const SUPABASE_ONLY_MIGRATIONS = new Set([
  "20260514161714_supabase_ai_verification_cron.sql",
  "20260514163203_scheduler_v2_sales_ready_pipeline.sql",
]);

// The four member/support RLS context helpers every lane that evaluates
// foundation-table policies needs EXECUTE on (migrations revoke them from
// PUBLIC).
const RLS_HELPERS = [
  "novatrade_rls_member_context",
  "novatrade_rls_support_context",
  "novatrade_rls_support_tenant_metadata_read",
  "novatrade_rls_support_workspace_metadata_read",
];

const FOUNDATION_TABLES = [
  "tenants",
  "workspaces",
  "tenant_memberships",
  "tenant_role_bindings",
  "tenant_policies",
  "support_access_grants",
  "support_access_grant_permissions",
  "support_access_grant_data_classes",
];

const PROVISIONING_API = [
  "novatrade_provisioning_journal_find",
  "novatrade_provisioning_journal_reserve",
  "novatrade_provisioning_journal_complete",
  "novatrade_provisioning_create_tenant",
  "novatrade_provisioning_create_workspace",
  "novatrade_provisioning_create_policy",
  "novatrade_provisioning_create_membership",
  "novatrade_provisioning_create_binding",
  "novatrade_provisioning_create_invitation",
  "novatrade_provisioning_audit_append",
  "novatrade_invitation_delivery_mark",
];

const MEMBERSHIP_ADMIN_API = [
  "novatrade_membership_journal_find",
  "novatrade_membership_journal_reserve",
  "novatrade_membership_journal_complete",
  "novatrade_membership_create_pending",
  "novatrade_membership_apply_mutation",
  "novatrade_membership_audit_append",
];

const EXPORT_API = [
  "novatrade_export_job_json",
  "novatrade_export_member_ctx",
  "novatrade_export_request",
  "novatrade_export_transition",
  "novatrade_export_audit_append",
];

const DELETION_API = [
  // novatrade_deletion_actor_ctx is an internal lane predicate: the runtime
  // role must NOT hold EXECUTE on it (T-041 proves the boundary).
  "novatrade_deletion_read",
  "novatrade_deletion_checkpoint_json",
  "novatrade_deletion_request",
  "novatrade_deletion_transition",
  "novatrade_deletion_tenant_cas",
  "novatrade_deletion_checkpoint_insert",
  "novatrade_deletion_checkpoint_transition",
  "novatrade_deletion_checkpoint_event",
  "novatrade_deletion_tombstone_insert",
  "novatrade_deletion_audit_append",
];

const INVITATION_API = [
  // The four internal STABLE helpers (context_free, lane, json, accept_ctx)
  // carry no runtime EXECUTE grant — T-040 asserts permission denied.
  "novatrade_invitation_read",
  "novatrade_invitation_live_read",
  "novatrade_invitation_tenant_read",
  "novatrade_invitation_workspace_read",
  "novatrade_invitation_membership_read",
  "novatrade_invitation_binding_read",
  "novatrade_invitation_policy_read",
  "novatrade_invitation_journal_find",
  "novatrade_invitation_journal_reserve",
  "novatrade_invitation_journal_complete",
  "novatrade_invitation_create",
  "novatrade_invitation_finalize",
  "novatrade_invitation_supersede",
  "novatrade_invitation_revoke",
  "novatrade_invitation_membership_status",
  "novatrade_invitation_binding_revoke",
  "novatrade_invitation_membership_create",
  "novatrade_invitation_binding_create",
  "novatrade_invitation_tenant_activate",
  "novatrade_invitation_workspace_activate",
  "novatrade_invitation_audit_append",
  "novatrade_invitation_delivery_mark",
];

const CUTOVER_API = [
  "novatrade_app_user_session_profile",
  "novatrade_app_user_ensure_active",
  "novatrade_tenant_lifecycle_snapshot_read",
  "novatrade_tenant_deletion_job_latest",
  "novatrade_tenant_export_job_latest",
  "novatrade_tenant_export_job_read",
];

const LIMIT_API = [
  "novatrade_tenant_limit_runtime_state",
  "novatrade_tenant_limit_consume",
  "novatrade_change_tenant_limit_configuration",
];

const SUPPORT_ACCESS_API = [
  "novatrade_support_access_grant_json",
  "novatrade_support_access_reserve",
  "novatrade_support_access_commit",
  "novatrade_support_access_append_event",
  "novatrade_support_access_create_grant",
  "novatrade_support_access_approve_grant",
  "novatrade_support_access_revoke_grant",
  "novatrade_support_principal_resolve",
  "novatrade_support_principal_current",
  "novatrade_support_access_grant_read",
  "novatrade_support_access_workspace_exists",
];

const SUPPORT_AUTHORIZATION_API = [
  // novatrade_support_lane_shape stays internal-only — T-042 asserts the
  // runtime role gets permission denied on it.
  "novatrade_support_access_reserve",
  "novatrade_support_access_commit",
  "novatrade_support_access_append_event",
  "novatrade_support_access_grant_read",
  "novatrade_support_access_workspace_exists",
  "novatrade_support_principal_resolve",
  "novatrade_support_principal_current",
];

/**
 * Lane matrix. `tables` maps a privilege set to public tables; `functions` is
 * the exact EXECUTE surface the suite's runtime role needs. Suites preflight
 * the runtime role's posture and several assert permission denied on internal
 * helpers, so this list is intentionally explicit — no wildcard grants.
 */
const LANES = [
  {
    id: "t015",
    flag: "T015_RUN_DISPOSABLE_AUDIT_TESTS",
    db: "t015_audit_context_rehearsal",
    role: "t015_runtime",
    files: ["src/lib/__tests__/tenant-audit-context-postgres.test.ts"],
    tables: [
      ["SELECT, INSERT", ["audit_logs"]],
      ["SELECT", ["tenant_memberships", "tenant_role_bindings"]],
    ],
    functions: [...RLS_HELPERS],
  },
  {
    id: "t030",
    flag: "T030_RUN_DISPOSABLE_PG_TESTS",
    db: "t030_db_context_rehearsal",
    role: "t030_runtime",
    // The same DATABASE_URL also wakes the dormant Postgres cases in the
    // portable tenant-db-context suite (documented in docs/TESTING.md).
    files: [
      "src/lib/__tests__/tenant-db-context-postgres.test.ts",
      "src/lib/__tests__/tenant-db-context.test.ts",
    ],
    tables: [["SELECT, INSERT, UPDATE, DELETE", FOUNDATION_TABLES]],
    functions: [...RLS_HELPERS],
  },
  {
    id: "t031",
    flag: "T031_RUN_DISPOSABLE_PG_TESTS",
    db: "t031_feature_policy_rehearsal",
    role: "t031_runtime",
    files: ["src/lib/__tests__/tenant-feature-policy-change-postgres.test.ts"],
    tables: [["SELECT, INSERT, UPDATE, DELETE", FOUNDATION_TABLES]],
    functions: [...RLS_HELPERS, "novatrade_apply_tenant_feature_policy_change"],
  },
  {
    id: "t032",
    flag: "T032_RUN_DISPOSABLE_PG_TESTS",
    db: "t032_retention_policy_rehearsal",
    role: "t032_runtime",
    files: ["src/lib/__tests__/tenant-retention-policy-change-postgres.test.ts"],
    tables: [["SELECT, INSERT, UPDATE, DELETE", FOUNDATION_TABLES]],
    functions: [...RLS_HELPERS, "novatrade_apply_tenant_retention_policy_change"],
  },
  {
    id: "t033",
    flag: "T033_RUN_DISPOSABLE_PG_TESTS",
    db: "t033_tenant_limits_rehearsal",
    role: "t033_runtime",
    files: ["src/lib/__tests__/tenant-limits-postgres.test.ts"],
    tables: [["SELECT, INSERT, UPDATE, DELETE", FOUNDATION_TABLES]],
    functions: [
      ...RLS_HELPERS,
      ...LIMIT_API,
      "novatrade_apply_tenant_feature_policy_change",
    ],
  },
  {
    id: "t034",
    flag: "T034_RUN_DISPOSABLE_PG_TESTS",
    db: "t034_lifecycle_rehearsal",
    role: "t034_runtime",
    files: ["src/lib/__tests__/tenant-lifecycle-transition-postgres.test.ts"],
    tables: [["SELECT, INSERT, UPDATE, DELETE", FOUNDATION_TABLES]],
    functions: [...RLS_HELPERS, "novatrade_transition_tenant_status"],
  },
  {
    id: "t035",
    flag: "T035_RUN_DISPOSABLE_PG_TESTS",
    db: "t035_support_access_rehearsal",
    role: "t035_runtime",
    files: ["src/lib/__tests__/tenant-support-access-postgres.test.ts"],
    tables: [["SELECT", FOUNDATION_TABLES]],
    functions: [...RLS_HELPERS, ...SUPPORT_ACCESS_API, ...LIMIT_API],
  },
  {
    id: "t036",
    flag: "T036_RUN_DISPOSABLE_PG_TESTS",
    db: "t036_provisioning_rehearsal",
    role: "t036_runtime",
    files: ["src/lib/__tests__/tenant-provisioning-postgres.test.ts"],
    // System lane: the runtime role holds EXECUTE on the eleven provisioning
    // API functions only — no table privileges (definers own the writes).
    tables: [],
    functions: PROVISIONING_API,
  },
  {
    id: "t037",
    flag: "T037_RUN_DISPOSABLE_PG_TESTS",
    db: "t037_membership_admin_rehearsal",
    role: "t037_runtime",
    files: ["src/lib/__tests__/tenant-membership-admin-postgres.test.ts"],
    tables: [
      [
        "SELECT",
        ["tenants", "workspaces", "tenant_memberships", "tenant_role_bindings", "audit_logs"],
      ],
    ],
    functions: [...RLS_HELPERS, ...MEMBERSHIP_ADMIN_API],
  },
  {
    id: "t038",
    flag: "T038_RUN_DISPOSABLE_PG_TESTS",
    db: "t038_export_ops_rehearsal",
    role: "t038_runtime",
    files: ["src/lib/__tests__/tenant-export-ops-postgres.test.ts"],
    // tenant_export_jobs SELECT: the shim maps INSERT/UPDATE/GET to definers
    // but the idempotency FIND and sweep list queries pass through raw.
    tables: [["SELECT", [...FOUNDATION_TABLES, "audit_logs", "tenant_export_jobs"]]],
    functions: [
      ...RLS_HELPERS,
      ...EXPORT_API,
      "novatrade_tenant_export_job_read",
    ],
  },
  {
    id: "t039",
    flag: "T039_RUN_DISPOSABLE_PG_TESTS",
    db: "t039_deletion_ops_rehearsal",
    role: "t039_runtime",
    files: ["src/lib/__tests__/tenant-deletion-ops-postgres.test.ts"],
    tables: [["SELECT", [...FOUNDATION_TABLES, "audit_logs"]]],
    functions: [...RLS_HELPERS, ...DELETION_API],
  },
  {
    id: "t040",
    flag: "T040_RUN_DISPOSABLE_PG_TESTS",
    db: "t040_invitation_ops_rehearsal",
    role: "t040_runtime",
    files: ["src/lib/__tests__/tenant-invitation-ops-postgres.test.ts"],
    tables: [],
    functions: [...RLS_HELPERS, ...INVITATION_API],
  },
  {
    id: "t041",
    flag: "T041_RUN_DISPOSABLE_PG_TESTS",
    db: "t041_action_cutover_rehearsal",
    role: "t041_runtime",
    files: ["src/lib/__tests__/tenant-cutover-ops-postgres.test.ts"],
    tables: [
      [
        "SELECT",
        [
          "tenants",
          "workspaces",
          "tenant_policies",
          "tenant_memberships",
          "tenant_role_bindings",
          "audit_logs",
          "tenant_export_jobs",
        ],
      ],
    ],
    functions: [
      ...RLS_HELPERS,
      ...CUTOVER_API,
      "novatrade_export_request",
      "novatrade_export_transition",
      "novatrade_export_audit_append",
    ],
  },
  {
    id: "t042",
    flag: "T042_RUN_DISPOSABLE_PG_TESTS",
    db: "t042_support_authorization_rehearsal",
    role: "t042_runtime",
    files: ["src/lib/__tests__/tenant-support-authorization-postgres.test.ts"],
    tables: [
      [
        "SELECT",
        [
          "tenants",
          "workspaces",
          "tenant_memberships",
          "tenant_role_bindings",
          "support_access_grants",
          "support_access_grant_permissions",
          "support_access_grant_data_classes",
          "platform_support_principals",
          "audit_logs",
        ],
      ],
    ],
    functions: [...RLS_HELPERS, ...SUPPORT_AUTHORIZATION_API],
  },
];

function log(msg) {
  console.log(`[ci-pg-rehearsal] ${msg}`);
}

// Every subprocess is bounded so a hung docker/psql/vitest cannot defeat the
// readiness deadline or stall the lane forever.
function sh(cmd, args, opts = {}) {
  const res = spawnSync(cmd, args, {
    encoding: "utf8",
    stdio: opts.pipe === false ? "inherit" : "pipe",
    input: opts.input,
    env: opts.env,
    timeout: opts.timeout ?? 30_000,
  });
  if (res.error) {
    if (!opts.allowFail) {
      throw new Error(`${cmd} ${args.join(" ")} failed: ${res.error.message}`);
    }
    return res;
  }
  if (res.status !== 0 && !opts.allowFail) {
    throw new Error(`${cmd} ${args.join(" ")} failed:\n${res.stderr || res.stdout}`);
  }
  return res;
}

// ---------- container naming, state, ownership ----------

const NAME_RE = /^nova-ci-[a-z0-9][a-z0-9-]{2,60}$/;
const PROTECTED_RE = /^nova-local/;

// Owned state lets commands in later processes rejoin the container `up`
// created without guessing names. Override for tests via CI_PG_STATE_FILE.
const STATE_FILE =
  process.env.CI_PG_STATE_FILE ||
  join(tmpdir(), `nova-ci-pg-${createHash("sha256").update(ROOT).digest("hex").slice(0, 12)}.json`);
const STATE_KIND = "nova-ci-postgres-rehearsal-v1";

function validateName(name) {
  if (PROTECTED_RE.test(name)) {
    throw new Error(`refusing protected nova-local-* name: ${name}`);
  }
  if (!NAME_RE.test(name)) {
    throw new Error(`container name must match ${NAME_RE} (got: ${name})`);
  }
  return name;
}

let resolvedName = "";

function readState() {
  let stat;
  try {
    stat = lstatSync(STATE_FILE);
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 1024
      || (stat.mode & 0o077) !== 0
      || (typeof process.getuid === "function" && stat.uid !== process.getuid())) {
    throw new Error("refusing an unowned or unsafe rehearsal state file");
  }
  let state;
  try {
    state = JSON.parse(readFileSync(STATE_FILE, "utf8"));
  } catch {
    throw new Error("refusing an invalid rehearsal state file");
  }
  if (!state || state.kind !== STATE_KIND || typeof state.name !== "string") {
    throw new Error("refusing an unowned rehearsal state file");
  }
  validateName(state.name);
  return state;
}

// One stable, validated name per invocation. Without CI_PG_NAME, commands
// rejoin the owned state `up` recorded; `up` generates one fresh name. Nothing
// silently adopts a foreign or protected container.
function containerName() {
  const state = readState();
  const selected = process.env.CI_PG_NAME || resolvedName;
  if (selected) {
    validateName(selected);
    if (state && state.name !== selected) {
      throw new Error("refusing state belonging to a different rehearsal container");
    }
    resolvedName = selected;
    return selected;
  }
  resolvedName = state?.name ?? `nova-ci-pg-${randomBytes(4).toString("hex")}`;
  return resolvedName;
}

function writeState(name) {
  // Exclusive creation preserves any pre-existing file, including symlinks.
  writeFileSync(STATE_FILE, JSON.stringify({ kind: STATE_KIND, name, pid: process.pid, at: new Date().toISOString() }) + "\n", {
    flag: "wx",
    mode: 0o600,
  });
}

function clearState(name) {
  const state = readState();
  if (!state) return;
  if (state.name !== name) throw new Error("refusing to delete another rehearsal's state");
  try {
    unlinkSync(STATE_FILE);
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
}

function docker(args, allowFail = false, timeout = 30_000) {
  return sh("docker", args, { allowFail, timeout });
}

function containerExists(name) {
  const res = docker(["inspect", name], true);
  return res.status === 0;
}

function ownedLabel(name) {
  const res = docker(
    ["inspect", "--format", '{{index .Config.Labels "nova-ci-rehearsal"}}', name],
    true,
  );
  return res.status === 0 && (res.stdout || "").trim() === "1";
}

// Every command that touches a container proves ownership before any SQL or
// state change: valid nova-ci-* name, container exists, carries our label.
function assertOwned(name) {
  validateName(name);
  if (!containerExists(name)) {
    throw new Error(`container ${name} is not running — run \`up\` first`);
  }
  if (!ownedLabel(name)) {
    throw new Error(`refusing to touch ${name}: missing ${LABEL} label`);
  }
}

// Only the process that created the container removes it on signal; adopted
// or preexisting containers are never deleted here.
let createdByThisProcess = false;
for (const sig of ["SIGINT", "SIGTERM"]) {
  process.on(sig, () => {
    if (createdByThisProcess) {
      try {
        docker(["rm", "--force", containerName()], true, 15_000);
        clearState(containerName());
      } catch {
        /* best-effort bounded cleanup */
      }
    }
    process.exit(sig === "SIGINT" ? 130 : 143);
  });
}

let cachedPort = "";
function containerPort(name) {
  if (cachedPort) return cachedPort;
  const out = docker(["port", name, "5432/tcp"]);
  const port = (out.stdout || "").trim().split(":").at(-1);
  if (!port || !/^\d+$/.test(port)) {
    throw new Error(`could not resolve published port for ${name}: ${out.stdout}`);
  }
  cachedPort = port;
  return port;
}

function sql(name, db, input, { allowFail = false, timeout = 300_000 } = {}) {
  const res = spawnSync(
    "docker",
    ["exec", "-i", name, "psql", "-X", "-v", "ON_ERROR_STOP=1", "-qAt",
      "-U", "postgres", "-d", db, "-f", "-"],
    { encoding: "utf8", input, stdio: ["pipe", "pipe", "pipe"], timeout },
  );
  if (res.error && !allowFail) {
    throw new Error(`psql -d ${db} failed: ${res.error.message}`);
  }
  if (res.status !== 0 && !allowFail) {
    throw new Error(`psql -d ${db} failed:\n${res.stderr || res.stdout}`);
  }
  return res;
}

function waitReady(name, secs = Number(process.env.CI_PG_READY_SECS || 90)) {
  const deadline = Date.now() + secs * 1000;
  while (Date.now() < deadline) {
    const res = docker(
      ["exec", name, "psql", "-X", "-U", "postgres", "-d", "postgres", "-Atc", "SELECT 1"],
      true,
      10_000,
    );
    if ((res.stdout || "").trim() === "1") return;
    spawnSync("sleep", ["0.5"], { timeout: 5_000 });
  }
  const logs = docker(["logs", name], true);
  throw new Error(
    `${name} did not become ready within ${secs}s\n${(logs.stdout || "") + (logs.stderr || "")}`.slice(0, 4000),
  );
}

// ---------- commands ----------

function up() {
  const name = containerName();
  if (readState()) throw new Error("owned rehearsal state already exists; run down before starting a new container");
  if (containerExists(name)) {
    throw new Error(`container ${name} already exists — refusing to adopt it`);
  }
  docker([
    "run", "--detach", "--rm",
    "--name", name,
    "--label", LABEL,
    "--publish", "127.0.0.1::5432",
    "--env", "POSTGRES_PASSWORD=postgres",
    "--env", "POSTGRES_DB=postgres",
    POSTGRES_16,
  ], false, 120_000);
  createdByThisProcess = true;
  let version = "";
  let stateWritten = false;
  try {
    waitReady(name);
    // Fail closed on anything but the pinned PostgreSQL 16 image.
    version = sql(name, "postgres", "SHOW server_version_num").stdout.trim();
    if (!version.startsWith("16")) {
      throw new Error(`expected PostgreSQL 16, got server_version_num=${version}`);
    }
    writeState(name);
    stateWritten = true;
    log(`up: ${name} on 127.0.0.1:${containerPort(name)} (postgres ${version})`);
  } catch (err) {
    // Bounded owned cleanup: remove only the container we just created.
    docker(["rm", "--force", name], true, 15_000);
    if (stateWritten) clearState(name);
    createdByThisProcess = false;
    throw err;
  }
}

function portableReplay(name, db) {
  sql(name, db, `
    CREATE SCHEMA IF NOT EXISTS auth;
    CREATE TABLE IF NOT EXISTS auth.users (id uuid PRIMARY KEY);
    DO $$ BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='anon') THEN CREATE ROLE anon NOLOGIN; END IF;
      IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='authenticated') THEN CREATE ROLE authenticated NOLOGIN; END IF;
    END $$;
    CREATE TABLE IF NOT EXISTS public.worker_runs (
      id text PRIMARY KEY, worker_name text NOT NULL, status text NOT NULL DEFAULT 'running',
      trigger_source text NOT NULL DEFAULT 'unknown', http_status integer,
      result_json jsonb NOT NULL DEFAULT '{}'::jsonb, error text,
      started_at timestamptz NOT NULL DEFAULT now(), completed_at timestamptz,
      created_at timestamptz NOT NULL DEFAULT now()
    );
  `);
  const files = readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith(".sql")).sort();
  let applied = 0;
  for (const f of files) {
    if (SUPABASE_ONLY_MIGRATIONS.has(f)) continue;
    sql(name, db, readFileSync(join(MIGRATIONS_DIR, f), "utf8"));
    applied += 1;
    // Post-202605110001 column shim required by the portable baseline — the
    // same shim the in-suite replayAllMigrations apply.
    if (f === "202605110001_full_schema.sql") {
      sql(name, db, `ALTER TABLE public.settings
        ADD COLUMN IF NOT EXISTS scheduler_ai_verification_enabled integer NOT NULL DEFAULT 1,
        ADD COLUMN IF NOT EXISTS scheduler_crawl_enabled integer NOT NULL DEFAULT 1,
        ADD COLUMN IF NOT EXISTS scheduler_enrichment_enabled integer NOT NULL DEFAULT 1,
        ADD COLUMN IF NOT EXISTS scheduler_artifact_enabled integer NOT NULL DEFAULT 1,
        ADD COLUMN IF NOT EXISTS scheduler_score_recompute_enabled integer NOT NULL DEFAULT 1;
        ALTER TABLE public.leads
        ADD COLUMN IF NOT EXISTS ai_website_feedback_status text,
        ADD COLUMN IF NOT EXISTS ai_corrected_website_url text,
        ADD COLUMN IF NOT EXISTS ai_false_positive_reason text,
        ADD COLUMN IF NOT EXISTS ai_reviewer_notes text,
        ADD COLUMN IF NOT EXISTS ai_feedback_at timestamptz;`);
    }
  }
  log(`template replay on ${db}: ${applied}/${files.length} migrations (${SUPABASE_ONLY_MIGRATIONS.size} Supabase-runtime-only skipped)`);
}

function provision() {
  const name = containerName();
  // Ownership is proven before any SQL: an unrelated or unlabeled container
  // is refused without a single write.
  assertOwned(name);
  waitReady(name, 30);

  // Cluster-wide NOLOGIN placeholders + per-lane restricted runtime roles
  // (idempotent so `provision` can be re-run against the same container).
  sql(name, "postgres", `
    DO $$ BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='anon') THEN CREATE ROLE anon NOLOGIN NOINHERIT; END IF;
      IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='authenticated') THEN CREATE ROLE authenticated NOLOGIN NOINHERIT; END IF;
    END $$;
    DO $$
    DECLARE r text;
    BEGIN
      FOREACH r IN ARRAY ARRAY[${LANES.map((l) => `'${l.role}'`).join(",")}] LOOP
        IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r) THEN
          EXECUTE format('CREATE ROLE %I LOGIN PASSWORD %L NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS', r, r);
        END IF;
      END LOOP;
    END $$;
  `);

  // Template: full portable migration history replayed once, then cloned per
  // lane so every suite lands on an identical freshly-migrated database.
  sql(name, "postgres", `DROP DATABASE IF EXISTS ${TEMPLATE_DB} WITH (FORCE);`, { allowFail: true });
  sql(name, "postgres", `CREATE DATABASE ${TEMPLATE_DB}`);
  portableReplay(name, TEMPLATE_DB);

  for (const lane of LANES) {
    // DROP ... WITH (FORCE) cannot run inside a transaction block — issue as
    // standalone statements.
    sql(name, "postgres", `DROP DATABASE IF EXISTS "${lane.db}" WITH (FORCE);`);
    sql(name, "postgres", `CREATE DATABASE "${lane.db}" WITH TEMPLATE ${TEMPLATE_DB} OWNER postgres`);

    const tableGrants = lane.tables
      .map(
        ([privs, tables]) =>
          `GRANT ${privs} ON TABLE ${tables.map((t) => `public.${t}`).join(", ")} TO ${lane.role};`,
      )
      .join("\n");
    // Resolve pronames to full signatures so overloading/arg lists can't drift
    // the grant; fail closed when a documented function is missing.
    sql(name, lane.db, `
      GRANT USAGE ON SCHEMA public TO ${lane.role};
      ${tableGrants}
      DO $$
      DECLARE
        expected CONSTANT text[] := ARRAY[${lane.functions.map((f) => `'${f}'`).join(",")}];
        fn record;
        granted int := 0;
      BEGIN
        FOR fn IN
          SELECT p.oid::regprocedure::text AS sig, p.proname
          FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
          WHERE n.nspname = 'public' AND p.proname = ANY(expected)
        LOOP
          EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO %I', fn.sig, '${lane.role}');
          granted := granted + 1;
        END LOOP;
        IF granted <> array_length(expected, 1) THEN
          RAISE EXCEPTION 'lane ${lane.db}: granted % of % expected functions', granted, array_length(expected, 1);
        END IF;
      END $$;
    `);
    log(`provisioned ${lane.db} (role ${lane.role}, ${lane.functions.length} EXECUTE grants)`);
  }
  log(`provision complete: ${LANES.length} lane databases on ${name}`);
}

function laneEnv(lane) {
  const name = containerName();
  const port = containerPort(name);
  const admin = `postgres://postgres:postgres@127.0.0.1:${port}/${lane.db}`;
  const env = {
    [lane.flag]: "1",
    [`${lane.id.toUpperCase()}_ADMIN_DATABASE_URL`]: admin,
    [`${lane.id.toUpperCase()}_RUNTIME_ROLE`]: lane.role,
    DATABASE_SSL: "disable",
  };
  if (lane.runtimeEnv !== false) {
    env.DATABASE_URL = `postgres://${lane.role}:${lane.role}@127.0.0.1:${port}/${lane.db}`;
  }
  return env;
}

function printEnv() {
  const name = containerName();
  assertOwned(name);
  const port = containerPort(name);
  console.log(`# L-02 tenant-ops rehearsal env for ${name} (127.0.0.1:${port})`);
  for (const lane of LANES) {
    for (const [k, v] of Object.entries(laneEnv(lane))) {
      console.log(`export ${k}=${v}   # ${lane.id}`);
    }
  }
}

function run(laneIds) {
  const name = containerName();
  assertOwned(name);
  const wanted = laneIds.length
    ? LANES.filter((l) => laneIds.includes(l.id))
    : LANES;
  const results = [];
  for (const lane of wanted) {
    const env = { ...process.env, ...laneEnv(lane) };
    log(`--- lane ${lane.id}: ${lane.files.join(", ")}`);
    const res = spawnSync(
      "npx",
      ["vitest", "run", ...lane.files],
      { stdio: "inherit", env, timeout: 900_000 },
    );
    if (res.error) {
      results.push({ id: lane.id, status: 1 });
      log(`lane ${lane.id} FAILED (${res.error.message})`);
      continue;
    }
    results.push({ id: lane.id, status: res.status });
    if (res.status !== 0) log(`lane ${lane.id} FAILED (exit ${res.status})`);
  }
  const failed = results.filter((r) => r.status !== 0);
  log(`lane summary: ${results.length - failed.length}/${results.length} passed${failed.length ? ` — failed: ${failed.map((r) => r.id).join(", ")}` : ""}`);
  // Set exitCode rather than process.exit so `all`'s finally can still run
  // `down` on failure.
  if (failed.length) process.exitCode = 1;
}

function down() {
  const name = containerName();
  validateName(name);
  if (!containerExists(name)) {
    clearState(name);
    log(`down: ${name} not present — nothing to remove`);
    return;
  }
  // Label guard: only ever remove containers this orchestrator started.
  if (!ownedLabel(name)) {
    throw new Error(`refusing to remove ${name}: missing ${LABEL} label`);
  }
  docker(["rm", "--force", name], false, 30_000);
  clearState(name);
  log(`down: removed ${name}`);
}

function authAudit() {
  const name = containerName();
  assertOwned(name);
  const port = containerPort(name);
  const result = spawnSync("npx", ["vitest", "run", "src/lib/__tests__/auth-audit-postgres.test.ts"], {
    cwd: ROOT,
    env: {
      ...process.env,
      NOVA_AUDIT_PG_REHEARSAL: "1",
      DATABASE_URL: `postgres://postgres:postgres@127.0.0.1:${port}/t015_audit_context_rehearsal`,
      DATABASE_SSL: "disable",
      NEXT_PUBLIC_APP_URL: "https://app.nova.test",
    },
    stdio: "inherit",
    timeout: 300_000,
  });
  if (result.error || result.status !== 0) process.exitCode = 1;
}

function all() {
  // `up` sits inside the try so a post-creation failure still reaches the
  // owned teardown; `createdByThisProcess` keeps a preexisting/adopted
  // container safe when `up` refuses to adopt it.
  try {
    up();
    provision();
    run([]);
  } finally {
    if (createdByThisProcess) down();
  }
}

// ---------- CLI ----------

const COMMANDS = new Set(["up", "provision", "env", "run", "auth-audit", "down", "all"]);
const LANE_IDS = new Set(LANES.map((l) => l.id));

function usage() {
  console.log(`usage: node scripts/ci-postgres-rehearsal.mjs [--help] <cmd>...

Commands run in order:
  up           start a uniquely named digest-pinned postgres:16 container
  provision    replay migrations + create per-lane DBs/roles/grants
  env          print per-lane env exports for the owned container
  run [lane..] run all lanes, or only the listed ids (${LANES.map((l) => l.id).join(" ")})
  auth-audit   prove pre-tenant auth audit on the owned disposable database
  down         remove the owned container (label-guarded)
  all          up + provision + run + guaranteed down (default)

Env: CI_PG_NAME (nova-ci-* name; required when rejoining a container across
processes without owned state), CI_PG_STATE_FILE, CI_PG_READY_SECS.`);
}

function parseArgv(argv) {
  if (argv.some((a) => a === "--help" || a === "-h")) {
    return { help: true, cmds: [], lanes: [] };
  }
  const badFlags = argv.filter((a) => a.startsWith("-"));
  if (badFlags.length) {
    throw new Error(`unknown flag(s): ${badFlags.join(", ")} — see --help`);
  }
  if (argv.length === 0) return { help: false, cmds: ["all"], lanes: [] };
  const cmds = [];
  const lanes = [];
  for (let i = 0; i < argv.length; i++) {
    const tok = argv[i];
    if (!COMMANDS.has(tok)) {
      throw new Error(`unknown command: ${tok} — see --help`);
    }
    if (cmds.includes(tok)) {
      throw new Error(`duplicate command: ${tok}`);
    }
    cmds.push(tok);
    if (tok === "run") {
      // Consume following non-command tokens as explicit lane ids.
      while (i + 1 < argv.length && !COMMANDS.has(argv[i + 1])) {
        const lane = argv[++i];
        if (!LANE_IDS.has(lane)) throw new Error(`unknown lane: ${lane}`);
        if (lanes.includes(lane)) throw new Error(`duplicate lane: ${lane}`);
        lanes.push(lane);
      }
    }
  }
  if (cmds.includes("all") && cmds.length > 1) {
    throw new Error("`all` cannot be combined with other commands");
  }
  return { help: false, cmds, lanes };
}

const parsed = parseArgv(process.argv.slice(2));
if (parsed.help) {
  usage();
} else {
  for (const cmd of parsed.cmds) {
    switch (cmd) {
      case "up": up(); break;
      case "provision": provision(); break;
      case "env": printEnv(); break;
      case "run": run(parsed.lanes); break;
      case "auth-audit": authAudit(); break;
      case "down": down(); break;
      case "all": all(); break;
    }
  }
}
