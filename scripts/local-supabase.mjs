#!/usr/bin/env node
// Local Supabase stack orchestrator for Nova Trade (L-01).
// Brings up a local-only supabase/postgres + gotrue + nginx gateway compose
// stack, applies migrations, provisions restricted worker-lease roles, and
// seeds a disposable local tenant identity. All secrets are local-only dummies
// written to .env.local (gitignored); nothing here may point off-loopback.

import { execFileSync, execSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync, chmodSync } from "node:fs";
import { createHmac, randomBytes } from "node:crypto";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const STACK_DIR = join(ROOT, "supabase", "local");
const COMPOSE = join(STACK_DIR, "compose.yml");
const CERTS_DIR = join(STACK_DIR, "certs");
const STACK_ENV = join(STACK_DIR, ".env");
const ENV_LOCAL = join(ROOT, ".env.local");
const MIGRATIONS_DIR = join(ROOT, "supabase", "migrations");

const DB_CONTAINER = "nova-local-db";
const GATEWAY_URL = "http://127.0.0.1:54321";
const DB_PORT = 5433;
const DB_SUPER_URL = `postgresql://postgres:postgres@127.0.0.1:${DB_PORT}/postgres`;
// Canonical lease role names owned by scripts/seed-local-tenant.mjs.
const CANONICAL_ISSUER_ROLE = "novatrade_worker_lease_issuer";
const CANONICAL_RESOLVER_ROLE = "novatrade_worker_lease_resolver";

const ADMIN_EMAIL = "admin@nova.local";
const ADMIN_PASSWORD = "nova-local-admin-pw";
const RESEARCHER_EMAIL = "researcher@nova.local";
const RESEARCHER_PASSWORD = "nova-local-researcher-pw";

function sh(cmd, args, opts = {}) {
  const res = spawnSync(cmd, args, { encoding: "utf8", stdio: opts.pipe === false ? "inherit" : "pipe", ...opts });
  if (res.status !== 0 && !opts.allowFail) {
    throw new Error(`${cmd} ${args.join(" ")} failed:\n${res.stderr || res.stdout}`);
  }
  return res;
}

function compose(args, opts = {}) {
  return sh("docker", ["compose", "-f", COMPOSE, "--env-file", STACK_ENV, ...args], opts);
}

function log(msg) { console.log(`[local-supabase] ${msg}`); }

// ---------- env ----------

function parseEnvFile(path) {
  if (!existsSync(path)) return {};
  const out = {};
  for (const line of readFileSync(path, "utf8").split("\n")) {
    const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (m) out[m[1]] = m[2];
  }
  return out;
}

function mintJwt(secret, role) {
  const b64 = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");
  const header = b64({ alg: "HS256", typ: "JWT" });
  const payload = b64({ iss: "supabase", role, iat: 1757530000, exp: 2075000000 });
  const sig = createHmac("sha256", secret).update(`${header}.${payload}`).digest("base64url");
  return `${header}.${payload}.${sig}`;
}

function ensureEnv() {
  // Stack env (JWT secret for gotrue)
  let stackEnv = parseEnvFile(STACK_ENV);
  if (!stackEnv.NOVA_LOCAL_JWT_SECRET) {
    stackEnv.NOVA_LOCAL_JWT_SECRET = `nova-local-${randomBytes(24).toString("hex")}`;
    mkdirSync(STACK_DIR, { recursive: true });
    writeFileSync(STACK_ENV, `NOVA_LOCAL_JWT_SECRET=${stackEnv.NOVA_LOCAL_JWT_SECRET}\n`, { mode: 0o600 });
    log("generated local JWT secret in supabase/local/.env");
  }
  const secret = stackEnv.NOVA_LOCAL_JWT_SECRET;

  // App env
  const env = parseEnvFile(ENV_LOCAL);
  const defaults = {
    DATABASE_URL: DB_SUPER_URL,
    POSTGRES_MAX_CONNECTIONS: "4",
    NEXT_PUBLIC_APP_URL: "http://localhost:3000",
    NEXT_PUBLIC_SUPABASE_URL: GATEWAY_URL,
    NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: mintJwt(secret, "anon"),
    SUPABASE_SERVICE_ROLE_KEY: mintJwt(secret, "service_role"),
    NOSITE_BOOTSTRAP_ADMIN_EMAIL: ADMIN_EMAIL,
    NOSITE_ENCRYPTION_SECRET: randomBytes(24).toString("hex") + "0".repeat(8),
    WORKER_CRON_SECRET: `nova-local-cron-${randomBytes(16).toString("hex")}`,
    WORKER_ROUTE_TIMEOUT_MS: "45000",
    TENANT_WORKER_LEASE_ISSUER_DATABASE_URL: `postgresql://${CANONICAL_ISSUER_ROLE}:${env.LOCAL_WORKER_LEASE_ISSUER_PASSWORD || "nova-lease-issuer-local"}@127.0.0.1:${DB_PORT}/postgres`,
    TENANT_WORKER_LEASE_RESOLVER_DATABASE_URL: `postgresql://${CANONICAL_RESOLVER_ROLE}:${env.LOCAL_WORKER_LEASE_RESOLVER_PASSWORD || "nova-lease-resolver-local"}@127.0.0.1:${DB_PORT}/postgres`,
    LOCAL_WORKER_LEASE_ISSUER_PASSWORD: "nova-lease-issuer-local",
    LOCAL_WORKER_LEASE_RESOLVER_PASSWORD: "nova-lease-resolver-local",
    LOCAL_ADMIN_PASSWORD: ADMIN_PASSWORD,
    LOCAL_RESEARCHER_PASSWORD: RESEARCHER_PASSWORD,
    E2E_SUPABASE_EMAIL: ADMIN_EMAIL,
    E2E_SUPABASE_PASSWORD: ADMIN_PASSWORD,
  };
  let changed = false;
  const lines = [];
  for (const [k, v] of Object.entries(defaults)) {
    if (!env[k]) { env[k] = v; changed = true; }
    lines.push(`${k}=${env[k]}`);
  }
  if (changed || !existsSync(ENV_LOCAL)) {
    writeFileSync(ENV_LOCAL, lines.join("\n") + "\n", { mode: 0o600 });
    log("wrote .env.local with local-only values");
  }
  return env;
}

// ---------- certs (app forces ssl: "require" on DATABASE_URL) ----------

function ensureCerts() {
  const key = join(CERTS_DIR, "server.key");
  const crt = join(CERTS_DIR, "server.crt");
  if (existsSync(key) && existsSync(crt)) return;
  mkdirSync(CERTS_DIR, { recursive: true });
  execSync(
    `openssl req -x509 -newkey rsa:2048 -nodes -keyout "${key}" -out "${crt}" -days 3650 -subj "/CN=localhost"`,
    { stdio: "pipe" },
  );
  chmodSync(key, 0o644); // container copies + chowns; see compose entrypoint
  log("generated self-signed postgres TLS certs in supabase/local/certs");
}

// ---------- lifecycle ----------

function up() {
  ensureCerts();
  ensureEnv();
  // DB first: supabase/postgres does not make `postgres` a superuser, and the
  // gotrue/admin roles' passwords must be pinned before auth can migrate.
  compose(["up", "-d", "db"], { pipe: false });
  waitHealthy(DB_CONTAINER, 180);
  // The image demotes `postgres` to non-superuser after init; repo migrations
  // are written to run as the postgres superuser (they ALTER DEFAULT
  // PRIVILEGES FOR ROLE postgres), so re-promote it for local dev.
  const pin = [
    "ALTER ROLE postgres WITH SUPERUSER",
    "ALTER ROLE supabase_admin WITH LOGIN PASSWORD 'postgres'",
    "ALTER ROLE supabase_auth_admin WITH LOGIN PASSWORD 'postgres'",
    // seed-local-tenant.mjs calls public.crypt/public.gen_salt; the image
    // installs pgcrypto in `extensions` (Supabase convention), so expose
    // thin public-schema wrappers instead of relocating the extension.
    "CREATE OR REPLACE FUNCTION public.crypt(text, text) RETURNS text LANGUAGE sql IMMUTABLE AS $$ SELECT extensions.crypt($1, $2) $$",
    "CREATE OR REPLACE FUNCTION public.gen_salt(text) RETURNS text LANGUAGE sql VOLATILE AS $$ SELECT extensions.gen_salt($1) $$",
    "CREATE OR REPLACE FUNCTION public.gen_salt(text, integer) RETURNS text LANGUAGE sql VOLATILE AS $$ SELECT extensions.gen_salt($1, $2) $$",
  ].join(";");
  const res = sh("docker", ["exec", DB_CONTAINER, "psql", "-U", "supabase_admin", "-d", "postgres", "-c", pin], { allowFail: true });
  if (res.status !== 0) log(`role pin warning: ${(res.stderr || "").trim()}`);
  compose(["up", "-d"], { pipe: false });
  waitHealthy("nova-local-auth", 120);
  waitHttp(`${GATEWAY_URL}/auth/v1/health`, 60);
  log("stack is up: postgres=127.0.0.1:5433 (TLS) auth/gateway=http://127.0.0.1:54321/auth/v1");
}

function down(clear) {
  compose(["down", ...(clear ? ["-v"] : [])], { pipe: false });
  log(clear ? "stack down + data volume removed" : "stack down (data kept)");
}

function waitHealthy(name, secs) {
  const deadline = Date.now() + secs * 1000;
  while (Date.now() < deadline) {
    const res = sh("docker", ["inspect", "--format", "{{.State.Health.Status}}", name], { allowFail: true });
    if (res.stdout.trim() === "healthy") { log(`${name} healthy`); return; }
    execSync("sleep 2");
  }
  throw new Error(`${name} did not become healthy`);
}

async function waitHttp(url, secs) {
  const deadline = Date.now() + secs * 1000;
  while (Date.now() < deadline) {
    try { const r = await fetch(url); if (r.status < 500) { log(`${url} responding`); return; } } catch {}
    await new Promise((r) => setTimeout(r, 2000));
  }
  throw new Error(`${url} not responding`);
}

// ---------- migrations ----------

function psqlAs(user, args, input) {
  return sh("docker", ["exec", "-i", DB_CONTAINER, "psql", "-U", user, "-d", "postgres", "-v", "ON_ERROR_STOP=1", "-q", ...args], { input, allowFail: true });
}

function migrate() {
  // Neutralize the image's bundled ALTER DEFAULT PRIVILEGES (they auto-grant
  // object privileges to anon/authenticated/service_role/postgres). Repo
  // migrations own default-privilege policy for role postgres and several
  // later migrations assert exact ACL state — stray default grants trip
  // their drift checks.
  psqlAs("postgres", ["-f", "-"], `
    ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public REVOKE ALL ON TABLES FROM anon, authenticated, service_role;
    ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public REVOKE ALL ON SEQUENCES FROM anon, authenticated, service_role;
    ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public REVOKE ALL ON FUNCTIONS FROM anon, authenticated, service_role;
    ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public REVOKE ALL ON TYPES FROM anon, authenticated, service_role;
    ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public REVOKE ALL ON SCHEMAS FROM anon, authenticated, service_role;
    ALTER DEFAULT PRIVILEGES FOR ROLE supabase_admin IN SCHEMA public REVOKE ALL ON TABLES FROM postgres, anon, authenticated, service_role;
    ALTER DEFAULT PRIVILEGES FOR ROLE supabase_admin IN SCHEMA public REVOKE ALL ON SEQUENCES FROM postgres, anon, authenticated, service_role;
    ALTER DEFAULT PRIVILEGES FOR ROLE supabase_admin IN SCHEMA public REVOKE ALL ON FUNCTIONS FROM postgres, anon, authenticated, service_role;
    ALTER DEFAULT PRIVILEGES FOR ROLE supabase_admin IN SCHEMA public REVOKE ALL ON TYPES FROM postgres, anon, authenticated, service_role;
    ALTER DEFAULT PRIVILEGES FOR ROLE supabase_admin IN SCHEMA public REVOKE ALL ON SCHEMAS FROM postgres, anon, authenticated, service_role;
  `);
  // Ledger mirrors supabase CLI convention: supabase_migrations.schema_migrations.
  psqlAs("postgres", ["-f", "-"], "CREATE SCHEMA IF NOT EXISTS supabase_migrations; CREATE TABLE IF NOT EXISTS supabase_migrations.schema_migrations(version text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())");
  const applied = new Set(
    (psqlAs("postgres", ["-tAc", "SELECT version FROM supabase_migrations.schema_migrations"]).stdout || "")
      .split("\n").map((s) => s.trim()).filter(Boolean),
  );
  const files = readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith(".sql")).sort();
  log(`applying migrations (${applied.size} already applied of ${files.length})`);
  for (const f of files) {
    const version = f.replace(/\.sql$/, "");
    if (applied.has(version)) continue;
    const res = psqlAs("postgres", ["-f", "-"], readFileSync(join(MIGRATIONS_DIR, f), "utf8"));
    if (res.status !== 0) {
      console.error(`MIGRATION FAILED: ${f}\n${res.stderr}`);
      process.exit(1);
    }
    const rec = psqlAs("postgres", ["-c", `INSERT INTO supabase_migrations.schema_migrations(version) VALUES ('${version}')`]);
    if (rec.status !== 0) { console.error(`ledger write failed for ${f}`); process.exit(1); }
    if (/WARNING/i.test(res.stderr || "")) console.warn(`  ${f}: ${res.stderr.trim().split("\n")[0]}`);
  }
  const cnt = psqlAs("postgres", ["-tAc", "SELECT count(*) FROM information_schema.tables WHERE table_schema='public'"]).stdout.trim();
  log(`migrations applied — public schema has ${cnt} tables`);
}

// ---------- seed + restricted lease roles (0X3-227/0X3-228) ----------
// Delegates to the canonical L-01 seed (scripts/seed-local-tenant.mjs /
// `npm run local:seed`), which provisions the worker lease issuer/resolver
// roles with an exact capability proof and seeds the admin + researcher
// tenant foundation in one idempotent pass.

function runCanonicalSeed() {
  const env = ensureEnv();
  const res = sh("node", [join(ROOT, "scripts", "seed-local-tenant.mjs")], {
    pipe: false,
    env: {
      ...process.env,
      DATABASE_URL: DB_SUPER_URL,
      LOCAL_ADMIN_EMAIL: ADMIN_EMAIL,
      LOCAL_ADMIN_PASSWORD: env.LOCAL_ADMIN_PASSWORD,
      LOCAL_RESEARCHER_EMAIL: RESEARCHER_EMAIL,
      LOCAL_RESEARCHER_PASSWORD: env.LOCAL_RESEARCHER_PASSWORD,
      LOCAL_WORKER_LEASE_ISSUER_PASSWORD: env.LOCAL_WORKER_LEASE_ISSUER_PASSWORD,
      LOCAL_WORKER_LEASE_RESOLVER_PASSWORD: env.LOCAL_WORKER_LEASE_RESOLVER_PASSWORD,
    },
  });
  if (res.status !== 0) process.exit(res.status ?? 1);
}

function roles() {
  runCanonicalSeed();
  log("restricted lease roles provisioned via scripts/seed-local-tenant.mjs");
}

async function seed() {
  runCanonicalSeed();
}

// ---------- disposable PG16 rehearsal cluster ----------

const TESTDB_CONTAINER = "nova-local-testdb";
const TESTDB_PORT = 5434;
const TESTDB_ADMIN = `postgresql://postgres:postgres@127.0.0.1:${TESTDB_PORT}`;
// Migrations that need Supabase-only runtime objects (pg_net/pg_cron/vault);
// documented skips shared by every portable replay (docs/validation/*t027*).
const SUPABASE_ONLY_MIGRATIONS = new Set([
  "20260514161714_supabase_ai_verification_cron.sql",
  "20260514163203_scheduler_v2_sales_ready_pipeline.sql",
]);
const TEST_DBS = [
  "f01_session_bootstrap_rehearsal",
  "f01_lead_rls_rehearsal",
  "t027_rls_rehearsal",
  "t028_compatibility_rehearsal",
  "t029_tenant_foundation_rehearsal",
  "g002_location_crawl_rehearsal_v1",
  "g003_lead_crm_rehearsal_v1",
  "g007sr4_min_reviews_rehearsal_v1",
  "l01_worker_routes_rehearsal",
];
// Rehearsal DBs whose suites do NOT replay migrations themselves.
const PREMIGRATED_DBS = ["t027_rls_rehearsal", "g007sr4_min_reviews_rehearsal_v1"];
const T027_ROLE = "t027_runtime_app";
const F01_BOOTSTRAP_ROLE = "f01_bootstrap_runtime_local";

function tpsql(db, args, input) {
  return sh("docker", ["exec", "-i", TESTDB_CONTAINER, "psql", "-U", "postgres", "-d", db, "-v", "ON_ERROR_STOP=1", "-q", ...args], { input, allowFail: true });
}

function portableReplay(db) {
  tpsql(db, ["-f", "-"], `
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
    const res = tpsql(db, ["-f", "-"], readFileSync(join(MIGRATIONS_DIR, f), "utf8"));
    if (res.status !== 0) { console.error(`portable replay failed on ${db}: ${f}\n${res.stderr}`); process.exit(1); }
    applied++;
    // Post-202605110001 column shim required by the portable baseline (same
    // shim the in-file replayMigrations apply — see tenant-session tests).
    if (f === "202605110001_full_schema.sql") {
      tpsql(db, ["-f", "-"], `ALTER TABLE public.settings
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
  log(`portable replay on ${db}: ${applied}/${files.length} migrations (${SUPABASE_ONLY_MIGRATIONS.size} Supabase-runtime-only skipped)`);
}

function testProvision() {
  waitHealthy(TESTDB_CONTAINER, 90);
  // Rehearsal DBs are single-use: several migrations are not idempotent on
  // re-apply (e.g. tenant-scope replaces 2-col uniques with 4-col), so reset
  // every named DB on each provision. PREMIGRATED_DBS then get a fresh
  // portable replay; the rest stay empty for suite-side replay.
  for (const db of TEST_DBS) {
    tpsql("postgres", ["-c", `DROP DATABASE IF EXISTS "${db}" WITH (FORCE)`]);
    const res = tpsql("postgres", ["-c", `CREATE DATABASE "${db}"`]);
    if (res.status !== 0) { console.error(res.stderr); process.exit(1); }
  }
  tpsql("postgres", ["-f", "-"], `
    DO $$ BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='${T027_ROLE}') THEN
        CREATE ROLE ${T027_ROLE} LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS PASSWORD 't027-local';
      END IF;
      IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='${F01_BOOTSTRAP_ROLE}') THEN
        CREATE ROLE ${F01_BOOTSTRAP_ROLE} LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS PASSWORD 'f01-local';
      END IF;
      -- Pre-create bootstrap roles cluster-wide with the safe shape
      -- (NOINHERIT NOLOGIN) that Q-006A's ensureBootstrapRolesAreSafe accepts;
      -- suite preambles use IF NOT EXISTS so this shape survives every replay.
      IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='anon') THEN CREATE ROLE anon NOLOGIN NOINHERIT; END IF;
      IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='authenticated') THEN CREATE ROLE authenticated NOLOGIN NOINHERIT; END IF;
    END $$;
    GRANT CONNECT ON DATABASE f01_session_bootstrap_rehearsal TO "${F01_BOOTSTRAP_ROLE}";
  `);
  for (const db of PREMIGRATED_DBS) portableReplay(db);
  // T-027 runtime role: schema usage + CRUD on the 8 foundation tables +
  // EXECUTE on the 4 hardened boolean helpers (per docs/validation t027 doc).
  const res = tpsql("t027_rls_rehearsal", ["-f", "-"], `
    GRANT CONNECT ON DATABASE t027_rls_rehearsal TO "${T027_ROLE}";
    GRANT USAGE ON SCHEMA public TO "${T027_ROLE}";
    GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE
      public.tenants, public.workspaces, public.tenant_memberships, public.tenant_role_bindings,
      public.tenant_policies, public.support_access_grants, public.support_access_grant_permissions,
      public.support_access_grant_data_classes
      TO "${T027_ROLE}";
    GRANT EXECUTE ON FUNCTION
      public.novatrade_rls_member_context(),
      public.novatrade_rls_support_context(),
      public.novatrade_rls_support_tenant_metadata_read(),
      public.novatrade_rls_support_workspace_metadata_read()
      TO "${T027_ROLE}";
  `);
  if (res.status !== 0) { console.error(res.stderr); process.exit(1); }
  log(`test cluster provisioned: ${TEST_DBS.length} rehearsal DBs + roles ${T027_ROLE}, ${F01_BOOTSTRAP_ROLE}`);
}

function testEnv() {
  const a = TESTDB_ADMIN;
  const lines = [
    "# Disposable PG16 rehearsal exports — run: eval \"$(node scripts/local-supabase.mjs test-env)\"",
    `Q002_POSTGRES16=1`,
    `Q002_POSTGRES_ADMIN_URL=${a}/postgres`,
    `Q006A_POSTGRES16=1`,
    `Q006A_POSTGRES_ADMIN_URL=${a}/postgres`,
    `Q006A_DISPOSABLE_CLUSTER_ACK=I_ACKNOWLEDGE_Q006A_DISPOSABLE_POSTGRES16`,
    `G002_RUN_DISPOSABLE_PG_TESTS=1`,
    `G002_DATABASE_URL=${a}/g002_location_crawl_rehearsal_v1`,
    `G003_RUN_DISPOSABLE_PG_TESTS=1`,
    `G003_DATABASE_URL=${a}/g003_lead_crm_rehearsal_v1`,
    `G004A_RUN_DISPOSABLE_PG_TESTS=1`,
    `G005_RUN_DISPOSABLE_PG_TESTS=1`,
    `G007SR4_RUN_DISPOSABLE_PG_TESTS=1`,
    `G007SR4_DATABASE_URL=${a}/g007sr4_min_reviews_rehearsal_v1`,
    `T027_RUN_DISPOSABLE_RLS_TESTS=1`,
    `T027_ADMIN_DATABASE_URL=${a}/t027_rls_rehearsal`,
    `T027_RUNTIME_ROLE=${T027_ROLE}`,
    `T027_RUNTIME_DATABASE_URL=postgresql://${T027_ROLE}:t027-local@127.0.0.1:${TESTDB_PORT}/t027_rls_rehearsal`,
    `T028_RUN_DISPOSABLE_PG_TESTS=1`,
    `T028_DATABASE_URL=${a}/t028_compatibility_rehearsal`,
    `T029_RUN_DISPOSABLE_PG_TESTS=1`,
    `T029_DATABASE_URL=${a}/t029_tenant_foundation_rehearsal`,
    `F01_RUN_DISPOSABLE_PG_TESTS=1`,
    `F01_DATABASE_URL=${a}/f01_lead_rls_rehearsal`,
    `F01_EXPORT_JOB_RLS_RUN_DISPOSABLE_TESTS=1`,
    `F01_WORKER_DISPATCH_RUN_DISPOSABLE_TESTS=1`,
    `F01_BOOTSTRAP_RUN_DISPOSABLE_TESTS=1`,
    `F01_BOOTSTRAP_ADMIN_DATABASE_URL=${a}/f01_session_bootstrap_rehearsal`,
    `F01_BOOTSTRAP_RUNTIME_DATABASE_URL=postgresql://${F01_BOOTSTRAP_ROLE}:f01-local@127.0.0.1:${TESTDB_PORT}/f01_session_bootstrap_rehearsal`,
    `F01_BOOTSTRAP_RUNTIME_ROLE=${F01_BOOTSTRAP_ROLE}`,
    `F04_DOCUMENT_INTAKE_RUN_DISPOSABLE_TESTS=1`,
    `F04_DOCUMENT_RESERVATION_RUN_DISPOSABLE_TESTS=1`,
    `F05_EXTRACTION_JOB_RUN_DISPOSABLE_TESTS=1`,
    `F06_AGENT_RUNTIME_RUN_DISPOSABLE_TESTS=1`,
    `F09_CONNECTOR_RUNTIME_RUN_DISPOSABLE_TESTS=1`,
    `F09_SOURCE_POLICY_LIFECYCLE_RUN_DISPOSABLE_TESTS=1`,
    // L-01 worker-route rehearsal: the suite self-provisions its restricted
    // lease roles (l01_* pattern) on this exact disposable database.
    `L01_WORKER_ROUTES_RUN_DISPOSABLE_TESTS=1`,
    `L01_WORKER_ROUTES_ADMIN_DATABASE_URL=${a}/l01_worker_routes_rehearsal`,
    `TENANT_WORKER_LEASE_ISSUER_DATABASE_URL=postgresql://l01_lease_issuer:l01-issuer@127.0.0.1:${TESTDB_PORT}/l01_worker_routes_rehearsal`,
    `TENANT_WORKER_LEASE_RESOLVER_DATABASE_URL=postgresql://l01_lease_resolver:l01-resolver@127.0.0.1:${TESTDB_PORT}/l01_worker_routes_rehearsal`,
  ];
  for (const l of lines) console.log(l.startsWith("#") ? l : `export ${l}`);
}

// ---------- verify ----------

async function verify() {
  const checks = [];
  const q = (sql) => psqlAs("postgres", ["-tAc", sql]).stdout.trim();
  checks.push(["leases table", q("SELECT to_regclass('public.tenant_worker_dispatch_leases') IS NOT NULL")]);
  checks.push(["acquire fn", q("SELECT to_regprocedure('public.novatrade_acquire_tenant_worker_lease(text,text,text,text,text,text,text,text,text,text,text,text)') IS NOT NULL")]);
  checks.push(["resolve fn", q("SELECT to_regprocedure('public.novatrade_resolve_tenant_worker_lease(text,text,text)') IS NOT NULL")]);
  checks.push(["issuer role", q(`SELECT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='${CANONICAL_ISSUER_ROLE}' AND rolcanlogin AND NOT rolinherit AND NOT rolsuper)`)]);
  checks.push(["resolver role", q(`SELECT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='${CANONICAL_RESOLVER_ROLE}' AND rolcanlogin AND NOT rolinherit AND NOT rolsuper)`)]);
  checks.push(["issuer canAcquire", q(`SELECT has_function_privilege('${CANONICAL_ISSUER_ROLE}','public.novatrade_acquire_tenant_worker_lease(text,text,text,text,text,text,text,text,text,text,text,text)','EXECUTE')`)]);
  checks.push(["resolver canResolve", q(`SELECT has_function_privilege('${CANONICAL_RESOLVER_ROLE}','public.novatrade_resolve_tenant_worker_lease(text,text,text)','EXECUTE')`)]);
  checks.push(["issuer no lease table privs", q(`SELECT NOT has_table_privilege('${CANONICAL_ISSUER_ROLE}','public.tenant_worker_dispatch_leases','SELECT') AND NOT has_table_privilege('${CANONICAL_ISSUER_ROLE}','public.tenant_worker_dispatch_leases','INSERT')`)]);
  checks.push(["resolver no lease table privs", q(`SELECT NOT has_table_privilege('${CANONICAL_RESOLVER_ROLE}','public.tenant_worker_dispatch_leases','SELECT') AND NOT has_table_privilege('${CANONICAL_RESOLVER_ROLE}','public.tenant_worker_dispatch_leases','UPDATE')`)]);
  checks.push(["auth users", q(`SELECT count(*) >= 2 FROM auth.users`)]);
  checks.push(["tenant seeded", q(`SELECT status='active' FROM public.tenants WHERE slug='nova-local'`)]);
  checks.push(["app_users seeded", q(`SELECT count(*) >= 2 FROM public.app_users`)]);
  try {
    const r = await fetch(`${GATEWAY_URL}/auth/v1/health`);
    checks.push(["auth gateway /health", String(r.status === 200 || r.status === 404)]);
  } catch { checks.push(["auth gateway /health", "false"]); }
  let fail = 0;
  for (const [name, v] of checks) { console.log(`  ${v === "t" || v === "true" ? "PASS" : "FAIL"} ${name} (${v})`); if (!(v === "t" || v === "true")) fail++; }
  log(fail ? `${fail} checks failed` : "all checks passed");
  process.exit(fail ? 1 : 0);
}

// ---------- cli ----------

const cmd = process.argv[2];
const main = async () => {
  switch (cmd) {
    case "up": up(); break;
    case "down": down(process.argv.includes("--clear")); break;
    case "migrate": migrate(); break;
    case "roles": roles(); break;
    case "seed": await seed(); break;
    case "env": { const e = ensureEnv(); for (const [k, v] of Object.entries(e)) console.log(`${k}=${v}`); break; }
    case "verify": await verify(); break;
    case "test-provision": testProvision(); break;
    case "test-env": testEnv(); break;
    case "all": up(); migrate(); roles(); await seed(); testProvision(); await verify(); break;
    case "psql": execFileSync("docker", ["exec", "-it", DB_CONTAINER, "psql", "-U", "postgres", "-d", "postgres"], { stdio: "inherit" }); break;
    case "status": compose(["ps"], { pipe: false }); break;
    default:
      console.log("usage: node scripts/local-supabase.mjs <up|down [--clear]|migrate|roles|seed|env|verify|test-provision|test-env|all|psql|status>");
      process.exit(cmd ? 1 : 0);
  }
};
main().catch((e) => { console.error(`[local-supabase] ERROR: ${e.message}`); process.exit(1); });
