#!/usr/bin/env node
/**
 * Nova Trade — isolated ephemeral staging rehearsal.
 *
 *   node scripts/staging-rehearsal.mjs rehearse
 *   node scripts/staging-rehearsal.mjs help | --help
 *
 * rehearse = compose up -> migrate (ALL supabase migrations incl. the two
 * supabase-runtime-only ones) -> canonical seeds -> verify -> production build
 * -> serve -> L08 acceptance + admin/researcher browser smoke -> sanitized
 * receipt -> bounded teardown. There is no keep/down surface: every run is
 * ephemeral, uniquely named, and always cleaned up.
 *
 * Safety contract:
 *  - Unique identity per run: compose project `nova-staging-<run>`,
 *    containers `nova-staging-<run>-{db,auth,gateway}`, own data volume and
 *    bridge network. Nothing shared exists; teardown verifies each resource's
 *    name AND `nova.staging.run=<run>` compose label before removing it.
 *  - Zero mutation before ownership: all preflight checks are read-only; the
 *    try/finally begins only after the run artifact dir is created with an
 *    exclusive non-recursive mkdir (0700). A preflight refusal touches nothing.
 *  - The app is an in-memory detached child of this process; signals and the
 *    hard deadline kill its process group, never a pid file.
 *  - Playwright output is routed into this run's private artifact dir; shared
 *    test-results/playwright-report dirs are never touched.
 *  - Children get an allowlisted env + generated staging env file; every key
 *    found in ROOT/.env* files is neutralized to "" first so a stray operator
 *    .env.local cannot reach the runtime; provider API keys are force-emptied.
 *  - receipt.json is strictly allowlisted (stage names, counts, codes) and is
 *    the only uploadable artifact. Logs/env/certs/test output live in
 *    staging-artifacts/<run>/private/ (0700/0600) and are deleted only when
 *    cleanup is fully verified; on cleanup failure they are retained, the
 *    receipt reports failure, and the leftover run identity is printed.
 */

import { spawnSync, spawn } from "node:child_process";
import {
  existsSync, lstatSync, mkdirSync, readdirSync, readFileSync,
  rmSync, writeFileSync, openSync, closeSync,
} from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { randomBytes } from "node:crypto";
import net from "node:net";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const LOCAL_SUPABASE = join(ROOT, "scripts", "local-supabase.mjs");
const COMPOSE_FILE = join(ROOT, "supabase/local/compose.yml");
const ART_ROOT = join(ROOT, "staging-artifacts");
const PROTECTED = ["nova-local-db", "nova-local-auth", "nova-local-gateway", "nova-local-testdb"];
const RUN_NAME_RE = /^nova-staging-[a-z0-9]+-(db|auth|gateway|testdb)$/;
const RUN_ID_RE = /^r[a-z0-9]{4,24}$/;
const UP_TIMEOUT_MS = 300_000;
const RUN_DEADLINE_MS = 45 * 60_000;
const OUT_CAP = 512 * 1024; // bounded child output capture (tail)

// Exact expected coverage (parent baseline: L08 2/2, admin 26/26, researcher
// 12/12). A silently-skipped or missing spec must never pass — if a suite
// legitimately grows, update the constant.
const SUITES = {
  acceptance: {
    expected: 2, mode: "acceptance",
    extraEnv: { E2E_ACCEPTANCE: "1" },
    args: [],
  },
  admin: {
    expected: 26, mode: "auth",
    extraEnv: {},
    args: ["--grep-invert", "Researcher Smoke Test"],
  },
  researcher: {
    expected: 12, mode: "auth",
    extraEnv: {},
    args: ["--grep", "Researcher Smoke Test"],
  },
};

// Env keys that must never reach the staging runtime with real values. Set to
// "" (not deleted) so .env* files cannot inject them either; provider code
// throws before egress when the key is empty.
const DISABLED_PROVIDER_ENV = {
  OPENAI_API_KEY: "",
  OPENAI_MODEL: "",
  GOOGLE_PLACES_API_KEY: "",
  NEXT_PUBLIC_GOOGLE_MAPS_BROWSER_KEY: "",
};

// Dotenv files Next.js auto-loads. Every key found in them is neutralized to
// "" before the generated staging env is overlaid — only key NAMES are ever
// recorded, never values.
const DOTENV_FILES = [".env", ".env.local", ".env.production", ".env.production.local"];

// Clean base env for every child: no inherited provider endpoints, customer
// DB URLs, or worker scheduler knobs from the operator's shell.
const BASE_ENV_KEYS = [
  "PATH", "HOME", "USER", "LOGNAME", "SHELL", "LANG", "LC_ALL", "LC_CTYPE",
  "TMPDIR", "TERM", "CI", "GITHUB_ACTIONS", "DOCKER_HOST", "XDG_RUNTIME_DIR",
  "PLAYWRIGHT_BROWSERS_PATH",
];
const BASE_ENV = Object.fromEntries(
  BASE_ENV_KEYS.filter((k) => process.env[k] !== undefined).map((k) => [k, process.env[k]]),
);

// Documented local-only credentials (public dummies — the same defaults the
// seed scripts and e2e helpers use when nothing is overridden). Never written
// to the receipt; they only authenticate against the disposable stack.
const CREDS = {
  admin: { email: "admin@nova.local", password: "nova-local-admin-pw" },
  researcher: { email: "researcher@nova.local", password: "nova-local-researcher-pw" },
  acceptanceAdmin: { email: "acceptance-admin@nova.local", password: "acceptance-admin-local" },
  acceptanceApprover: { email: "acceptance-approver@nova.local", password: "acceptance-approver-local" },
};

function log(m) { console.log(`[staging] ${m}`); }
function fail(m) { console.error(`[staging] ERROR: ${m}`); process.exit(1); }
class StageError extends Error { constructor(stage) { super(stage); this.stage = stage; } }
class ShutdownError extends Error { constructor(sig) { super(sig); this.sig = sig; } }

// ---- shutdown plumbing ----
// Long stages run through runAsync (detached process group + live handle) so
// SIGINT/SIGTERM and the hard deadline can kill the whole child tree instead
// of waiting out a blocked call. Short probes stay spawnSync with bounded
// timeouts. The handler only records intent and kills live process groups;
// real cleanup runs in the normal finally once the in-flight await unwinds.
let activeProc = null;
let shutdownSig = null;
function onSignal(sig) {
  if (shutdownSig) return;
  shutdownSig = sig;
  log(`${sig} — shutting down`);
  for (const c of [activeProc, appChild]) {
    try { if (c) process.kill(-c.pid, "SIGKILL"); } catch { /* gone */ }
  }
}
function throwIfShutdown() { if (shutdownSig) throw new ShutdownError(shutdownSig); }

let appChild = null;

function runAsync(cmd, args, opts = {}) {
  return new Promise((resolve, reject) => {
    throwIfShutdown();
    const child = spawn(cmd, args, {
      cwd: ROOT,
      env: opts.env || stackEnv(),
      detached: true, // own process group — descendants die with the group
      stdio: opts.inherit ? ["inherit", "inherit", "inherit"] : ["ignore", "pipe", "pipe"],
    });
    activeProc = child;
    let stdout = "", stderr = "";
    const cap = (buf, d) => (buf.length > OUT_CAP ? buf.slice(-OUT_CAP) : buf) + d;
    child.stdout?.on("data", (d) => { stdout = cap(stdout, d); });
    child.stderr?.on("data", (d) => { stderr = cap(stderr, d); });
    const timer = opts.timeout
      ? setTimeout(() => { try { process.kill(-child.pid, "SIGKILL"); } catch { /* gone */ } }, opts.timeout)
      : null;
    child.on("error", reject);
    // resolve on close (stdio fully drained), not exit — no orphan pipes.
    child.on("close", (code) => {
      if (activeProc === child) activeProc = null;
      if (timer) clearTimeout(timer);
      resolve({ status: code, stdout, stderr });
    });
  });
}

function sh(cmd, args, opts = {}) {
  if (!opts.duringShutdown) throwIfShutdown();
  const r = spawnSync(cmd, args, {
    cwd: ROOT,
    env: opts.env || stackEnv(),
    encoding: "utf8",
    timeout: opts.timeout ?? 120_000,
    maxBuffer: 8 * 1024 * 1024,
    stdio: opts.inherit ? ["inherit", "inherit", "inherit"] : ["ignore", "pipe", "pipe"],
  });
  if (r.error) throw r.error;
  if (opts.allowFail) return r;
  if (r.status !== 0) {
    const out = `${r.stdout || ""}\n${r.stderr || ""}`.slice(-3000);
    throw new Error(`${cmd} ${args.join(" ")} exited ${r.status}\n${out}`);
  }
  return r.stdout || "";
}
function out(cmd, args, o = {}) {
  const r = sh(cmd, args, o);
  return String(typeof r === "string" ? r : (r.stdout || "")).trim();
}

// ---------- config (validated lazily so help stays inert) ----------

function int(name, dflt) {
  const v = process.env[name];
  if (v === undefined) return dflt;
  if (!/^\d+$/.test(v) || +v < 1 || +v > 65535) {
    fail(`invalid ${name}=${JSON.stringify(v)}: expected an integer port 1-65535`);
  }
  return +v;
}

function buildConfig() {
  const runId = (() => {
    const v = process.env.NOVA_STAGING_RUN_ID;
    if (v === undefined) return `r${Date.now().toString(36)}${randomBytes(3).toString("hex")}`;
    if (!RUN_ID_RE.test(v)) fail(`invalid NOVA_STAGING_RUN_ID ${JSON.stringify(v)}`);
    return v;
  })();
  const run = `nova-staging-${runId}`;
  const appPort = int("NOVA_STAGING_APP_PORT", 3100);
  return {
    runId,
    run,
    containers: [`${run}-db`, `${run}-auth`, `${run}-gateway`],
    dbContainer: `${run}-db`,
    dbPort: int("NOVA_STAGING_DB_PORT", 55433),
    gwPort: int("NOVA_STAGING_GW_PORT", 55421),
    testdbPort: int("NOVA_STAGING_TESTDB_PORT", 55434),
    appPort,
    // Canonical origin is always computed — never inherited from the ambient
    // shell (a stray production NEXT_PUBLIC_APP_URL must not drive browsers).
    appOrigin: `http://localhost:${appPort}`,
    volume: `${run}_nova-pgdata`,
    network: `${run}_default`,
    runArtifacts: join(ART_ROOT, runId),
    get private() { return join(this.runArtifacts, "private"); },
    get ownerFile() { return join(this.runArtifacts, "owner.json"); },
    get receiptFile() { return join(this.runArtifacts, "receipt.json"); },
    get stackEnvFile() { return join(this.private, "stack.env"); },
    get appEnvFile() { return join(this.private, "app.env"); },
    get certsDir() { return join(this.private, "certs"); },
    get appLog() { return join(this.private, "next-server.log"); },
    get docStoreRoot() { return join(this.private, "document-objects"); },
    docSigningSecret: randomBytes(24).toString("hex"),
  };
}

// ---------- env plumbing ----------

function readEnvFile(path) {
  const env = {};
  if (!existsSync(path)) return env;
  for (const l of readFileSync(path, "utf8").split("\n")) {
    const m = l.match(/^([A-Z0-9_]+)=(.*)$/);
    if (m) env[m[1]] = m[2];
  }
  return env;
}

// Key-name extraction using the same grammar dotenv/Next accept:
// optional leading whitespace, optional `export`, key [\w.-]+, then either
// `=` (optional surrounding space) or `:` followed by whitespace. Only the
// NAME is captured — values are never read, stored, or printed.
const DOTENV_KEY = /^\s*(?:export\s+)?([\w.-]+)(?:\s*=\s*?|:\s+?)/;
const DOTENV_MAX_BYTES = 1024 * 1024;
const DOTENV_MAX_LINES = 10_000;
function dotenvKeyNames(path) {
  const keys = new Set();
  let st;
  try { st = lstatSync(path); } catch { return keys; }
  if (!st.isFile() || st.isSymbolicLink()) return keys;
  if (st.size > DOTENV_MAX_BYTES) fail(`${path} exceeds ${DOTENV_MAX_BYTES} bytes — refusing to parse`);
  const lines = readFileSync(path, "utf8").split("\n");
  if (lines.length > DOTENV_MAX_LINES) fail(`${path} exceeds ${DOTENV_MAX_LINES} lines — refusing to parse`);
  for (const l of lines) {
    const m = l.match(DOTENV_KEY);
    if (m) keys.add(m[1]);
  }
  return keys;
}

function stackEnv() {
  return {
    ...BASE_ENV,
    NOVA_STACK_PROFILE: "staging",
    NOVA_STAGING_RUN_ID: CFG.runId,
    NOVA_COMPOSE_PROJECT: CFG.run,
    NOVA_DB_CONTAINER: CFG.containers[0],
    NOVA_AUTH_CONTAINER: CFG.containers[1],
    NOVA_GATEWAY_CONTAINER: CFG.containers[2],
    NOVA_TESTDB_CONTAINER: `${CFG.run}-testdb`,
    NOVA_DB_PORT: String(CFG.dbPort),
    NOVA_GATEWAY_PORT: String(CFG.gwPort),
    NOVA_TESTDB_PORT: String(CFG.testdbPort),
    NOVA_GATEWAY_URL: `http://127.0.0.1:${CFG.gwPort}`,
    NOVA_APP_ORIGIN: CFG.appOrigin,
    NOVA_CERTS_DIR: CFG.certsDir,
    NOVA_STACK_ENV_FILE: CFG.stackEnvFile,
    NOVA_APP_ENV_FILE: CFG.appEnvFile,
    NOVA_VERIFY_TENANT_SLUG: "local-demo",
    COMPOSE_PROFILES: "staging",
  };
}

// Key names found in ROOT/.env* — neutralized to "" in the app env so a stray
// operator dotenv cannot leak values into the staging runtime. Names only.
function neutralizedKeys() {
  const keys = new Set(Object.keys(DISABLED_PROVIDER_ENV));
  for (const f of DOTENV_FILES) {
    for (const k of dotenvKeyNames(join(ROOT, f))) keys.add(k);
  }
  return [...keys].sort();
}

function appEnv() {
  const neutral = Object.fromEntries(neutralizedKeys().map((k) => [k, ""]));
  return {
    ...BASE_ENV,
    ...neutral,                          // dotenv keys -> "" first
    ...readEnvFile(CFG.appEnvFile),      // generated staging config wins
    ...DISABLED_PROVIDER_ENV,            // providers can never come back
    // Fresh run-owned document-acceptance knobs — never the shared local
    // .data/document-objects path or a reused signing secret. The sibling
    // real-service lane proves Supabase Storage + ClamAV separately; this
    // browser lane pins the local backends with run-owned state.
    NOVA_DOCUMENT_STORAGE_BACKEND: "local",
    NOVA_DOCUMENT_SCANNER_BACKEND: "local",
    NOVA_DOCUMENT_LOCAL_ACCEPTANCE: "1",
    NOVA_DOCUMENT_UPLOAD_ORIGIN: CFG.appOrigin,
    NOVA_SCANNER_POLICY_VERSION: "launch-v1",
    NOVA_DOCUMENT_STORE_ROOT: CFG.docStoreRoot,
    NOVA_DOCUMENT_SIGNING_SECRET: CFG.docSigningSecret,
    NOVA_SCANNER_BLOCKED_SHA256: "",
    NOVA_APP_ORIGIN: CFG.appOrigin,
    NEXT_PUBLIC_APP_URL: CFG.appOrigin,
    NODE_ENV: "production",
  };
}

// ---------- preflight: strictly read-only, zero mutation ----------

function portFree(port) {
  return new Promise((resolve) => {
    const s = net.connect({ host: "127.0.0.1", port });
    s.once("connect", () => { s.destroy(); resolve(false); });
    s.once("error", () => resolve(true));
    s.setTimeout(2000, () => { s.destroy(); resolve(true); });
  });
}

async function preflight() {
  // Docker inspection must be trustworthy before ANY mutation. An
  // unreachable/broken daemon is NOT proof of absence — refuse.
  const probe = sh("docker", ["ps"], { allowFail: true, env: BASE_ENV });
  if (probe.status !== 0) {
    fail(`docker inspection failed (exit ${probe.status}) — refusing to start; cannot verify protected containers or leftovers`);
  }
  for (const c of PROTECTED) {
    const present = sh("docker", ["ps", "-a", "-q", "--filter", `name=^${c}$`], { allowFail: true });
    if (present.status !== 0) fail(`docker inspection failed for protected container ${c} — refusing`);
    if (String(present.stdout || "").trim()) {
      const running = sh("docker", ["ps", "-q", "--filter", `name=^${c}$`], { allowFail: true });
      if (running.status !== 0) fail(`docker inspection failed for protected container ${c} — refusing`);
      const isRunning = String(running.stdout || "").trim();
      log(`protected ${c} present (${isRunning ? "running" : "stopped"}) — will not touch it`);
    } else {
      log(`protected ${c} not present — nothing to preserve (CI)`);
    }
  }
  for (const [name, port] of [["postgres", CFG.dbPort], ["gateway", CFG.gwPort], ["app", CFG.appPort]]) {
    if (!(await portFree(port))) {
      fail(`port ${port} (${name}) is already in use — refusing to start. ` +
        `A leftover staging run may hold it; look for containers named ${CFG.run}-* or earlier runs.`);
    }
  }
  const strayR = sh("docker", ["ps", "-a", "--format", "{{.Names}}", "--filter", `name=^${CFG.run}-`], { allowFail: true });
  if (strayR.status !== 0) fail("docker inspection failed for run-prefix leftovers — refusing");
  const stray = String(strayR.stdout || "").trim();
  if (stray) fail(`leftover containers for this run exist:\n${stray}`);
  // Artifact paths: parent must be absent or a real uid-owned dir; the run dir
  // must not exist at all (never reuse, never follow a symlink). lstat is
  // unconditional — a dangling symlink still counts as occupied.
  try {
    const st = lstatSync(ART_ROOT);
    if (st.isSymbolicLink()) fail(`refusing symlinked staging-artifacts dir: ${ART_ROOT}`);
    if (!st.isDirectory()) fail(`staging-artifacts is not a directory: ${ART_ROOT}`);
    if (st.uid !== process.getuid()) fail(`staging-artifacts is not owned by current uid: ${ART_ROOT}`);
  } catch (e) {
    if (e.code !== "ENOENT") throw e;
  }
  try {
    lstatSync(CFG.runArtifacts);
    fail(`artifact dir ${CFG.runArtifacts} already exists — refusing to reuse a run dir`);
  } catch (e) {
    if (e.code !== "ENOENT") throw e;
  }
}

// Exclusive creation = the ownership boundary. Everything after this point is
// run-owned and inside the try/finally cleanup path.
function createRunDirs() {
  if (!existsSync(ART_ROOT)) mkdirSync(ART_ROOT, { mode: 0o700 });
  // Non-recursive on purpose: a preexisting run dir throws EEXIST here, and
  // preflight already rejected it — a throw now is a refused race, not reuse.
  mkdirSync(CFG.runArtifacts, { mode: 0o700 });
  mkdirSync(CFG.private, { mode: 0o700 });
}

function writeOwner() {
  writeFileSync(CFG.ownerFile, JSON.stringify({
    runId: CFG.runId,
    composeProject: CFG.run,
    containers: CFG.containers,
    volume: CFG.volume,
    network: CFG.network,
    ports: { postgres: CFG.dbPort, gateway: CFG.gwPort, app: CFG.appPort },
    appOrigin: CFG.appOrigin,
    neutralizedEnvKeys: neutralizedKeys(),
    createdAt: new Date().toISOString(),
  }, null, 2), { mode: 0o600 });
}

// ---------- receipt (strict allowlist — never raw child output) ----------

const receipt = { result: "unknown" };
function initReceipt() {
  Object.assign(receipt, {
    rehearsal: "nova-staging",
    runId: CFG.runId,
    commit: out("git", ["rev-parse", "--short", "HEAD"], { env: BASE_ENV, allowFail: true }) || "unknown",
    startedAt: new Date().toISOString(),
    result: "unknown",
    failedStage: null,
    errorCode: null,
    environment: {
      composeProject: CFG.run,
      containers: CFG.containers,
      ports: { postgres: CFG.dbPort, gateway: CFG.gwPort, app: CFG.appPort },
      appOrigin: CFG.appOrigin,
      supabaseImage: "docker.io/supabase/postgres:15.14.1.170",
      neutralizedEnvKeys: neutralizedKeys(),
    },
    migrations: {},
    seeds: {},
    verify: {},
    e2e: {},
    servicesRehearsal: "not-integrated", // parent wires sibling service/recovery hooks
    cleanup: {},
    limitations: [
      "services/recovery rehearsal hooks are not yet integrated (parent-owned)",
      "provider API keys force-disabled; no egress to OpenAI/Google possible",
    ],
  });
}

function failCode(stage, code, detail) {
  console.error(`[staging] ERROR at ${stage}: ${detail}`);
  receipt.result = "fail";
  receipt.failedStage = stage;
  receipt.errorCode = code;
  process.exitCode = 1;
  throw new StageError(stage);
}
function stage(name, fn) { receipt.failedStage = name; return fn(); }

// ---------- pipeline stages ----------

async function up() {
  const res = await runAsync("node", [LOCAL_SUPABASE, "up"], { timeout: UP_TIMEOUT_MS });
  throwIfShutdown();
  if (res.status !== 0) {
    failCode("up", "STACK_UP_FAILED", `${(res.stdout || "").slice(-2000)}\n${(res.stderr || "").slice(-2000)}`);
  }
  // Replay ALL migration files on the real supabase/postgres image (the two
  // supabase-runtime-only migrations apply here, unlike the portable lanes).
  const m = await runAsync("node", [LOCAL_SUPABASE, "migrate"], { timeout: UP_TIMEOUT_MS });
  throwIfShutdown();
  if (m.status !== 0) {
    failCode("migrate", "MIGRATION_REPLAY_FAILED", `${(m.stdout || "").slice(-2000)}\n${(m.stderr || "").slice(-2000)}`);
  }
}

let migrationIdsCache = null;
function migrationIds() {
  if (migrationIdsCache) return migrationIdsCache;
  const dir = join(ROOT, "supabase", "migrations");
  migrationIdsCache = readdirSync(dir).filter((f) => /^\d+_.*\.sql$/.test(f)).sort();
  return migrationIdsCache;
}

function migrateCheck() {
  // local-supabase already replayed every migration file; verify the ledger
  // rows match the file count (includes the two supabase-runtime-only files).
  // The ledger records the full filename stem (version = filename minus .sql).
  const files = migrationIds();
  const versions = files.map((f) => f.replace(/\.sql$/, ""));
  const applied = +out("docker", ["exec", CFG.dbContainer, "psql", "-U", "postgres", "-d", "postgres", "-qAt", "-c",
    "SELECT count(*) FROM supabase_migrations.schema_migrations WHERE version IN (" +
    versions.map((v) => `'${v}'`).join(",") + ")"]);
  receipt.migrations = {
    migrationFiles: files.length,
    ledgerRows: applied,
    supabaseRuntimeOnly: 2,
    allFilesApplied: applied === files.length,
  };
  if (applied !== files.length) {
    failCode("migrate", "MIGRATION_LEDGER_INCOMPLETE", `ledger=${applied} files=${files.length}`);
  }
  log(`migrations: ${applied}/${files.length} files applied (incl. 2 supabase-runtime-only)`);
}

async function seeds() {
  // Canonical L-01 seed via local-supabase: restricted lease roles + local-demo
  // admin/researcher foundation. Kept as an explicit pre-e2e stage so the
  // parent-owned auth-audit suite can slot in after this point (its specs
  // expect freshly seeded rows).
  const r1 = await runAsync("node", [LOCAL_SUPABASE, "seed"], { timeout: 240_000 });
  throwIfShutdown();
  if (r1.status !== 0) failCode("seed", "LOCAL_DEMO_SEED_FAILED", (r1.stderr || r1.stdout || "").slice(-2000));
  receipt.seeds["local-demo"] = "ok";
  log("seeded local-demo tenant (admin + researcher)");

  const r2 = await runAsync("node", [join(ROOT, "scripts", "seed-acceptance-tenant.mjs")], {
    timeout: 240_000,
    env: {
      ...BASE_ENV,
      DATABASE_URL: `postgresql://postgres:postgres@127.0.0.1:${CFG.dbPort}/postgres`,
      ACCEPTANCE_ADMIN_EMAIL: CREDS.acceptanceAdmin.email,
      ACCEPTANCE_ADMIN_PASSWORD: CREDS.acceptanceAdmin.password,
      ACCEPTANCE_APPROVER_EMAIL: CREDS.acceptanceApprover.email,
      ACCEPTANCE_APPROVER_PASSWORD: CREDS.acceptanceApprover.password,
    },
  });
  throwIfShutdown();
  if (r2.status !== 0) failCode("seed", "ACCEPTANCE_SEED_FAILED", (r2.stderr || r2.stdout || "").slice(-2000));
  receipt.seeds.acceptance = "ok";
  log("seeded acceptance tenant (admin + approver)");
}

async function verify() {
  const res = await runAsync("node", [LOCAL_SUPABASE, "verify"], { timeout: 120_000 });
  throwIfShutdown();
  const o = String(res.stdout || "") + String(res.stderr || "");
  if (res.status !== 0) failCode("verify", "STACK_VERIFY_FAILED", o.slice(-3000));
  // verify() prints "  PASS <check name> (<value>)" lines.
  for (const line of o.split("\n")) {
    const m = line.match(/^\s*(PASS|FAIL)\s+(.+?)\s*\(/);
    if (m) receipt.verify[m[2].replace(/\s+/g, "_")] = m[1];
  }
  const checks = Object.entries(receipt.verify);
  if (checks.length === 0 || checks.some(([, v]) => v !== "PASS")) {
    failCode("verify", "VERIFY_CHECKS_FAILED", `${checks.filter(([, v]) => v !== "PASS").length} checks not PASS`);
  }
  log(`verify: ${checks.length}/${checks.length} checks PASS (incl. least-privilege lease role proofs)`);
}

async function build() {
  // Turbopack panics when node_modules is a symlink out of the project root
  // (shared-worktree dev layout). CI's `npm ci` produces a real directory;
  // fall back to webpack only for the symlinked case.
  const symlinked = existsSync(join(ROOT, "node_modules"))
    && lstatSync(join(ROOT, "node_modules")).isSymbolicLink();
  const bundler = process.env.NOVA_STAGING_BUNDLER || (symlinked ? "webpack" : "turbopack");
  const r = await runAsync("npx", ["next", "build", bundler === "webpack" ? "--webpack" : "--turbopack"],
    { env: appEnv(), timeout: 900_000, inherit: true });
  throwIfShutdown();
  if (r.status !== 0) failCode("build", "NEXT_BUILD_FAILED", `next build --${bundler} exited ${r.status}`);
  // Output-trace safety (parent d6550bf): the server NFT manifests must not
  // bundle local databases, .env*, private keys, or rehearsal artifacts.
  const st = await runAsync("node", [join(ROOT, "scripts", "server-traces.selftest.mjs")],
    { env: BASE_ENV, timeout: 120_000 });
  throwIfShutdown();
  if (st.status !== 0) failCode("build", "SERVER_TRACES_UNSAFE", "server trace manifests include local/private files");
  receipt.environment.bundler = bundler;
  receipt.environment.serverTraces = "clean";
  log(`build ok (${bundler}); server traces clean`);
}

function startApp() {
  // Raw fd (not a WriteStream): spawn stdio accepts integer fds, and the
  // synchronous open means no deferred open() can race private-dir removal.
  const logFd = openSync(CFG.appLog, "a");
  try {
    appChild = spawn("npx", ["next", "start", "-p", String(CFG.appPort), "-H", "127.0.0.1"], {
      cwd: ROOT,
      env: appEnv(),
      stdio: ["ignore", logFd, logFd],
      detached: true, // own process group — the whole npx->next tree dies together
    });
  } finally {
    closeSync(logFd); // the child holds its own dup now
  }
  appChild.on("error", (e) => log(`app process error: ${e.code || e.message}`));
  appChild.closePromise = new Promise((res) => appChild.on("close", res));
}

async function waitHttp(url, { expectOk = false, attempts = 90 } = {}) {
  for (let i = 0; i < attempts; i++) {
    throwIfShutdown();
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(5000), redirect: "manual" });
      if (expectOk ? res.status === 200 : res.status < 600) return true;
    } catch (e) { if (e instanceof ShutdownError) throw e; }
    await new Promise((r) => setTimeout(r, 1000));
  }
  return false;
}

const sleepMs = (ms) => new Promise((r) => setTimeout(r, ms));
async function stopAppChild(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return "not-running";
  try { process.kill(-child.pid, "SIGTERM"); } catch { return "term-failed"; }
  const closed = await Promise.race([child.closePromise.then(() => true), sleepMs(8000).then(() => false)]);
  if (!closed) {
    try { process.kill(-child.pid, "SIGKILL"); } catch { /* gone */ }
    const killed = await Promise.race([child.closePromise.then(() => true), sleepMs(3000).then(() => false)]);
    // Only report stopped once the child actually closed — a live process
    // group means cleanup is NOT verified.
    return killed ? "sigkill" : "still-live";
  }
  return "sigterm";
}

// ---------- e2e ----------

async function runE2E(name, spec) {
  const outDir = join(CFG.private, "test-results", name);
  const args = [
    join(ROOT, "scripts", "run-e2e.mjs"), spec.mode,
    "--workers=1", "--output", outDir, ...spec.args,
  ];
  const r = await runAsync("node", args, {
    timeout: 900_000,
    env: {
      ...appEnv(),
      E2E_BASE_URL: CFG.appOrigin,
      // Acceptance specs write their handoff state here (parent fb393cb) —
      // never the checkout's e2e/.acceptance-state.json.
      E2E_ACCEPTANCE_STATE_FILE: join(CFG.private, "acceptance-state.json"),
      // Researcher suite reuses the E2E_SUPABASE_* login vars.
      E2E_SUPABASE_EMAIL: name === "researcher" ? CREDS.researcher.email : CREDS.admin.email,
      E2E_SUPABASE_PASSWORD: name === "researcher" ? CREDS.researcher.password : CREDS.admin.password,
      ACCEPTANCE_ADMIN_EMAIL: CREDS.acceptanceAdmin.email,
      ACCEPTANCE_ADMIN_PASSWORD: CREDS.acceptanceAdmin.password,
      ACCEPTANCE_APPROVER_EMAIL: CREDS.acceptanceApprover.email,
      ACCEPTANCE_APPROVER_PASSWORD: CREDS.acceptanceApprover.password,
      ...spec.extraEnv,
    },
  });
  throwIfShutdown();
  const o = `${r.stdout || ""}\n${r.stderr || ""}`;
  const count = (re) => { const m = o.match(re); return m ? +m[1] : 0; };
  const result = {
    expected: spec.expected,
    passed: count(/(\d+) passed/),
    failed: count(/(\d+) failed/) + count(/(\d+) did not run/) + count(/(\d+) interrupted/),
    skipped: count(/(\d+) skipped/),
    flaky: count(/(\d+) flaky/),
    exitCode: r.status,
  };
  receipt.e2e[name] = result;
  if (r.status !== 0 || result.passed !== spec.expected
      || result.failed !== 0 || result.skipped !== 0 || result.flaky !== 0) {
    console.error(o.slice(-4000));
    failCode("e2e", `E2E_${name.toUpperCase()}_FAILED`,
      `${name}: expected ${spec.expected} passed/0 failed/0 skipped/0 flaky, ` +
      `got ${result.passed}/${result.failed}/${result.skipped}/${result.flaky} (exit ${r.status})`);
  }
  log(`e2e ${name}: ${result.passed}/${spec.expected} passed, 0 failed, 0 skipped, 0 flaky`);
}

// ---------- verified owned-only cleanup ----------

function dockerLabel(name, label) {
  const r = sh("docker", ["inspect", name, "--format", `{{index .Config.Labels "${label}"}}`],
    { allowFail: true, env: BASE_ENV, duringShutdown: true });
  return r.status === 0 ? String(r.stdout || "").trim() : null;
}
// Inspect a volume/network label. null = not inspectable (absent or daemon
// trouble — distinguished via ls). "" = exists but label unset.
function resourceLabel(kind, name, label) {
  const r = sh("docker", [kind, "inspect", name, "--format", `{{index .Labels "${label}"}}`],
    { allowFail: true, env: BASE_ENV, duringShutdown: true });
  return r.status === 0 ? String(r.stdout || "").trim() : null;
}
function resourceListed(kind, name) {
  const r = sh("docker", [kind, "ls", "-q", "--filter", `name=^${name}$`],
    { allowFail: true, env: BASE_ENV, duringShutdown: true });
  if (r.status !== 0) return null; // listing itself failed — unverifiable
  return String(r.stdout || "").trim().length > 0;
}
// owned = carries this run's id label, or the exact compose project label.
// foreign = inspectable but owned by someone else / unlabeled.
// unknown = listed but not inspectable, or listing failed — never treat
// unknown as absent; refuse destructive cleanup.
function resourceState(kind, name) {
  const runLabel = resourceLabel(kind, name, "nova.staging.run");
  if (runLabel === CFG.runId) return "owned";
  if (runLabel !== null) {
    for (const l of ["com.docker.compose.project", "io.podman.compose.project"]) {
      if (resourceLabel(kind, name, l) === CFG.run) return "owned";
    }
    return "foreign";
  }
  const listed = resourceListed(kind, name);
  if (listed === null || listed) return "unknown";
  return "absent";
}
function listNames(kind, extra = []) {
  const r = sh("docker", [kind, "ls", "-q", "--filter", `name=^${CFG.run}`, ...extra],
    { allowFail: true, env: BASE_ENV, duringShutdown: true });
  return r.status === 0 ? String(r.stdout || "").trim().split("\n").filter(Boolean) : null;
}

// Remove only what THIS run verifiably created. A failed or unverifiable
// cleanup turns an otherwise-passing receipt into a failure.
async function teardownOwned() {
  const c = receipt.cleanup;
  try { c.appStopped = appChild ? await stopAppChild(appChild) : "none"; }
  catch { c.appStopped = "error"; }
  appChild = null;

  // Ownership proof before any removal: every container under our prefix must
  // be an expected name AND carry this run's label. Anything else = refuse.
  const containerNames = () => {
    const r = sh("docker", ["ps", "-a", "--format", "{{.Names}}", "--filter", `name=^${CFG.run}-`],
      { allowFail: true, env: BASE_ENV, duringShutdown: true });
    return r.status === 0 ? String(r.stdout || "").trim().split("\n").filter(Boolean) : null;
  };
  const found = containerNames();
  // null = the listing itself failed — unknown is never an empty list.
  // Refuse destructive cleanup when we cannot prove what exists.
  const unowned = found === null ? ["<container-listing-unverifiable>"]
    : found.filter(
      (n) => !RUN_NAME_RE.test(n) || !CFG.containers.includes(n) || dockerLabel(n, "nova.staging.run") !== CFG.runId,
    );
  // Volume + network ownership must be proven BEFORE the destructive compose
  // call: a same-name resource with foreign labels, or one whose state cannot
  // be inspected at all, means we never created it — refuse, never adopt.
  const volState = resourceState("volume", CFG.volume);
  const netState = resourceState("network", CFG.network);
  c.volumeState = volState;
  c.networkState = netState;

  if (unowned.length || volState === "foreign" || volState === "unknown"
      || netState === "foreign" || netState === "unknown") {
    c.refusedForeign = [
      ...unowned,
      ...(volState === "foreign" || volState === "unknown" ? [`volume:${CFG.volume}:${volState}`] : []),
      ...(netState === "foreign" || netState === "unknown" ? [`network:${CFG.network}:${netState}`] : []),
    ];
    c.composeDown = "refused";
  } else {
    const r = sh("docker", ["compose", "--env-file", CFG.stackEnvFile, "-f", COMPOSE_FILE,
      "-p", CFG.run, "down", "-v", "--timeout", "15"],
      { allowFail: true, timeout: 90_000, env: stackEnv(), duringShutdown: true });
    c.composeDown = r.status === 0 ? "ok" : "failed";
  }

  // Post-verify: containers, volume AND network must all be absent.
  const left = containerNames() || ["<unverifiable>"];
  const vols = listNames("volume") || ["<unverifiable>"];
  const nets = listNames("network") || ["<unverifiable>"];
  c.containersRemaining = left;
  c.volumesRemaining = vols;
  c.networksRemaining = nets;
  c.volumeRemoved = vols.length === 0;
  c.networkRemoved = nets.length === 0;

  // "still-live"/"term-failed"/"error" all mean the app tree may survive —
  // cleanup is not verified unless the child observably closed.
  const appOk = ["none", "not-running", "sigterm", "sigkill"].includes(c.appStopped);
  const clean = appOk && c.composeDown === "ok"
    && left.length === 0 && vols.length === 0 && nets.length === 0;
  c.verified = clean;
  if (clean) {
    // Private state is removed only after verified cleanup — and a removal
    // failure can never report pass.
    try {
      rmSync(CFG.private, { recursive: true, force: true });
      c.privateArtifactsRemoved = !existsSync(CFG.private);
    } catch {
      c.privateArtifactsRemoved = false;
    }
    if (!c.privateArtifactsRemoved) {
      c.verified = false;
      receipt.result = "fail";
      receipt.errorCode = "PRIVATE_CLEANUP_FAILED";
      receipt.failedStage = "cleanup";
      process.exitCode = 1;
      log(`private artifact removal failed — retained ${CFG.private} (0700/0600, not uploadable)`);
    }
  } else {
    // Keep private state (0700/0600) for operator forensics; it is never
    // uploaded. Report the leftover run identity.
    c.privateArtifactsRemoved = false;
    receipt.result = "fail";
    receipt.errorCode = "CLEANUP_FAILED";
    receipt.failedStage = "cleanup";
    process.exitCode = 1;
    log(`cleanup failed — leftover run identity: ${CFG.runId} ` +
      `(project ${CFG.run}, prefix ${CFG.run}-*, volume ${CFG.volume}, network ${CFG.network})`);
    log(`run dir retained at ${CFG.runArtifacts} (private state preserved 0700/0600, not uploadable)`);
  }
  log(`teardown: compose=${c.composeDown} containers=${left.length} volumes=${vols.length} networks=${nets.length} verified=${clean}`);
}

// ---------- main ----------

async function rehearse() {
  await preflight();          // read-only; a refusal here mutates nothing
  createRunDirs();            // exclusive ownership boundary
  writeOwner();
  initReceipt();
  const deadline = setTimeout(() => onSignal("SIGTERM"), RUN_DEADLINE_MS);
  try {
    await stage("up", up);
    stage("migrate", migrateCheck);
    await stage("seed", seeds);
    await stage("verify", verify);
    await stage("build", build);
    await stage("start", async () => {
      startApp();
      if (!(await waitHttp(`${CFG.appOrigin}/api/health`, { expectOk: true }))) {
        failCode("start", "APP_NOT_HEALTHY", `${CFG.appOrigin}/api/health never returned 200`);
      }
      log(`app serving ${CFG.appOrigin}`);
    });
    for (const [name, spec] of Object.entries(SUITES)) {
      await stage("e2e", async () => runE2E(name, spec));
    }
    receipt.result = "pass";
    receipt.failedStage = null;
    log("rehearsal PASS — writing receipt");
  } catch (e) {
    if (e instanceof ShutdownError) {
      receipt.result = "fail";
      receipt.errorCode = "SHUTDOWN";
      process.exitCode = e.sig === "SIGINT" ? 130 : 143;
    } else {
      if (!(e instanceof StageError)) {
        receipt.result = "fail";
        receipt.errorCode = "UNEXPECTED";
        console.error(`[staging] unexpected: ${e.message}`);
      }
      process.exitCode = 1;
    }
  } finally {
    clearTimeout(deadline);
    receipt.finishedAt = new Date().toISOString();
    await teardownOwned();
    writeFileSync(CFG.receiptFile, JSON.stringify(receipt, null, 2));
    log(`receipt: ${CFG.receiptFile}`);
  }
}
process.on("SIGINT", () => onSignal("SIGINT"));
process.on("SIGTERM", () => onSignal("SIGTERM"));

// ---------- CLI: strictly parsed before ANY env/config/mutation ----------

const args = process.argv.slice(2);
const usage = `Usage: node scripts/staging-rehearsal.mjs <command>

  rehearse   isolated ephemeral staging rehearsal: up, migrate, seed, verify,
             build, serve, e2e, sanitized receipt, verified owned teardown
  help       this message`;

// --help/-h/help and bare invocation are inert even with malformed ambient env.
if (args.length === 0 || args.includes("--help") || args.includes("-h") || args[0] === "help") {
  console.log(usage);
  process.exit(0);
}
if (args[0] !== "rehearse") {
  console.error(`unknown command: ${args[0]}\n${usage}`);
  process.exit(2);
}
if (args.length > 1) {
  console.error(`unexpected arguments for rehearse: ${args.slice(1).join(" ")}\n${usage}`);
  process.exit(2);
}

// From here on, env-derived config is validated and only then may anything
// be created.
const CFG = buildConfig();
rehearse().catch((e) => {
  // Unreachable in practice — preflight failures exit inside fail() before any
  // mutation, and the pipeline has its own finally. No fallback cleanup here:
  // if ownership was never established, nothing must be touched.
  console.error(`[staging] fatal before ownership established: ${e.message}`);
  process.exit(1);
});
