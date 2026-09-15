#!/usr/bin/env node
// L03 real-service rehearsal (single ephemeral run).
//
// Provisions a disposable stack — Postgres + supabase/storage-api + clamd + a
// TLS edge — on a private container network, runs the env-gated vitest
// rehearsal suite from inside that network, verifies cleanup, and writes one
// sanitized JSON receipt. No host ports are published; nothing outside this
// run's labeled resources is ever touched.
//
//   node scripts/l03-real-services.mjs [--receipt PATH]
//   node scripts/l03-real-services.mjs --help
//
// Container CLI: $CONTAINER_CLI, else docker, else podman.
// Secret material (CA keys, JWTs, state) lives only in a private mkdtemp dir
// that is removed on teardown; the receipt is the only surviving artifact and
// contains no raw logs, no env values, and no secrets.
//
// clamd's wire protocol is unauthenticated and unencrypted TCP: the daemon
// must only ever be reachable on a private network — exactly what this
// rehearsal provisions (an owned, unpublished container network).

import { spawnSync } from "node:child_process";
import { createHmac, randomBytes } from "node:crypto";
import {
  chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync,
  realpathSync, rmSync, writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const ASSETS = join(ROOT, "scripts", "l03-real-services");
const MODULES = realpathSync(join(ROOT, "node_modules"));
const DEBUG = process.env.L03_DEBUG === "1";

const RUN_ID = `l03r-${Date.now().toString(36)}-${randomBytes(4).toString("hex")}`;
const LABEL = "nova.l03.rehearsal.run";
const NETWORK = `nova-${RUN_ID}-net`;
const NAMES = {
  db: `nova-${RUN_ID}-db`,
  migrate: `nova-${RUN_ID}-migrate`,
  storage: `nova-${RUN_ID}-storage`,
  clamd: `nova-${RUN_ID}-clamd`,
  probe: `nova-${RUN_ID}-probe`,
  tls: `nova-${RUN_ID}-tls`,
  test: `nova-${RUN_ID}-test`,
};
const IMAGE = {
  db: "docker.io/library/postgres:16-alpine",
  storage: "docker.io/supabase/storage-api:v1.77.0",
  clamd: "docker.io/clamav/clamav:1.5.4-debian13-slim",
  node: "docker.io/library/node:24.21.0-bookworm-slim",
};
const BUCKET = "nova-quarantine";
const EXPECTED_TESTS = 12;

const CHILD_TIMEOUT_MS = {
  short: 30_000,
  migrate: 180_000,
  probe: 300_000,
  vitest: 600_000,
};

function log(msg) { console.log(`[l03-rehearsal] ${msg}`); }

const JWT_LIKE = /eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]*/gu;

/** Strip secrets (env values, JWT-shaped tokens) from any text we publish. */
function sanitize(text) {
  return String(text)
    .replace(JWT_LIKE, "[redacted-jwt]")
    .replace(/(?:[A-Z0-9_]+_KEY|DATABASE_URL|SECRET|PASSWORD|TOKEN)=[^\s"']+/gu, "[redacted]")
    .slice(0, 2_000);
}

// ---------- container cli ----------

function detectCli() {
  const forced = process.env.CONTAINER_CLI?.trim();
  if (forced) {
    if (spawnSync(forced, ["--version"], { encoding: "utf8" }).status === 0) return forced;
    throw new Error(`CONTAINER_CLI=${forced} is not runnable`);
  }
  for (const candidate of ["docker", "podman"]) {
    if (spawnSync(candidate, ["--version"], { encoding: "utf8" }).status === 0) {
      return candidate;
    }
  }
  throw new Error("no container CLI found (need docker or podman)");
}

let CLI = "";
function cli(args, opts = {}) {
  const res = spawnSync(CLI, args, {
    encoding: "utf8",
    timeout: opts.timeoutMs ?? CHILD_TIMEOUT_MS.short,
    stdio: "pipe",
  });
  if (res.status !== 0 && !opts.allowFail) {
    const redacted = args.map((arg, index) =>
      index > 0 && (args[index - 1] === "-e" || args[index - 1] === "--env")
        ? `${arg.split("=")[0]}=<redacted>`
        : arg);
    throw new Error(
      `${CLI} ${redacted.join(" ")} failed (status ${res.status}): ${sanitize(res.stderr || res.stdout || res.error?.message || "")}`,
    );
  }
  if (DEBUG && res.stdout) process.stdout.write(sanitize(res.stdout) + "\n");
  return res;
}

function resourceExists(kind, name) {
  // `exists` is Podman-only. Docker returns "unknown command" for it, which
  // must not be misread as proof that a resource was removed.
  const result = cli([kind, "inspect", name], { allowFail: true });
  if (result.status === 0) return true;
  const absent = /no such (?:container|network|resource)|(?:container|network) not found|no (?:container|network) .+ found/iu;
  if ([1, 125].includes(result.status) && absent.test(result.stderr || "")) return false;
  throw new Error("RESOURCE_INSPECTION_FAILED");
}

// ---------- run state ----------

const state = {
  dir: null,
  createdContainers: [],
  createdNetwork: false,
  secrets: null,
};

function stateDir() {
  if (state.dir) return state.dir;
  const dir = mkdtempSync(join(tmpdir(), "nova-l03-rehearsal-"));
  chmodSync(dir, 0o700);
  mkdirSync(join(dir, "out"), { mode: 0o700 });
  writeFileSync(join(dir, "OWNED"), `${RUN_ID}\n`, { mode: 0o600 });
  state.dir = dir;
  return dir;
}

function b64url(value) {
  return Buffer.from(JSON.stringify(value)).toString("base64url");
}

function mintJwt(secret, role) {
  const header = b64url({ alg: "HS256", typ: "JWT" });
  const payload = b64url({
    iss: "supabase",
    role,
    iat: Math.floor(Date.now() / 1_000) - 60,
    exp: Math.floor(Date.now() / 1_000) + 3_600,
  });
  const sig = createHmac("sha256", secret)
    .update(`${header}.${payload}`)
    .digest("base64url");
  return `${header}.${payload}.${sig}`;
}

function runContainer(name, args, opts = {}) {
  // Every container gets the run label and a fixed unique name; owned teardown
  // sweeps by label, so nothing can leak unnamed.
  const res = cli([
    "run", ...(args.includes("--rm") ? [] : ["--rm"]),
    "--name", name, "--network", NETWORK,
    "--label", `${LABEL}=${RUN_ID}`,
    ...args,
  ], opts);
  if (res.status === 0 && !args.includes("--rm")) state.createdContainers.push(name);
  return res;
}

// ---------- certs ----------

function ensureCerts() {
  const certs = join(stateDir(), "certs");
  mkdirSync(certs, { mode: 0o700 });
  const tlsName = NAMES.tls;
  const ext = `subjectAltName=DNS:${tlsName},DNS:localhost`;
  const openssl = (args) => {
    const res = spawnSync("openssl", args, { encoding: "utf8" });
    if (res.status !== 0) throw new Error(`openssl failed: ${sanitize(res.stderr)}`);
  };
  openssl(["req", "-x509", "-newkey", "rsa:2048", "-nodes",
    "-keyout", join(certs, "ca.key"), "-out", join(certs, "ca.crt"),
    "-days", "1", "-subj", "/CN=nova-l03-rehearsal-ca"]);
  openssl(["req", "-newkey", "rsa:2048", "-nodes",
    "-keyout", join(certs, "server.key"), "-out", join(certs, "server.csr"),
    "-subj", `/CN=${tlsName}`, "-addext", ext]);
  writeFileSync(join(certs, "ext.cnf"), `${ext}\nbasicConstraints=critical,CA:false\n`, { mode: 0o600 });
  openssl(["x509", "-req", "-in", join(certs, "server.csr"),
    "-CA", join(certs, "ca.crt"), "-CAkey", join(certs, "ca.key"),
    "-CAcreateserial", "-out", join(certs, "server.crt"),
    "-days", "1", "-extfile", join(certs, "ext.cnf")]);
  for (const f of ["ca.key", "server.key", "server.csr"]) {
    chmodSync(join(certs, f), 0o600);
  }
  log("rehearsal CA + TLS cert generated inside private state dir");
}

// ---------- up ----------

function up() {
  for (const name of Object.values(NAMES)) {
    if (resourceExists("container", name)) {
      throw new Error(`refusing to adopt pre-existing container ${name}`);
    }
  }
  if (resourceExists("network", NETWORK)) {
    throw new Error(`refusing to adopt pre-existing network ${NETWORK}`);
  }

  ensureCerts();
  const jwtSecret = `l03-rehearsal-jwt-${randomBytes(24).toString("hex")}`;
  const serviceKey = mintJwt(jwtSecret, "service_role");
  const anonKey = mintJwt(jwtSecret, "anon");
  state.secrets = { jwtSecret, serviceKey, anonKey };
  const dbUrl = `postgres://postgres:postgres@${NAMES.db}:5432/postgres`;

  cli(["network", "create", "--label", `${LABEL}=${RUN_ID}`, NETWORK]);
  state.createdNetwork = true;

  runContainer(NAMES.db, [
    "-d", "-e", "POSTGRES_PASSWORD=postgres", "-e", "POSTGRES_DB=postgres", IMAGE.db,
  ]);
  for (let i = 0; i < 240; i += 1) {
    if (cli(["exec", NAMES.db, "pg_isready", "-h", "127.0.0.1", "-U", "postgres"], { allowFail: true }).status === 0) break;
    if (i === 239) throw new Error("postgres never became ready");
    spawnSync("sleep", ["0.5"]);
  }
  log("postgres ready");

  runContainer(NAMES.migrate, [
    "--rm",
    "-e", `DATABASE_URL=${dbUrl}`, "-e", "DB_INSTALL_ROLES=true",
    "-e", `AUTH_JWT_SECRET=${jwtSecret}`, "-e", "AUTH_JWT_ALGORITHM=HS256",
    "--entrypoint", "node", IMAGE.storage, "dist/scripts/migrate-call.js",
  ], { timeoutMs: CHILD_TIMEOUT_MS.migrate });
  log("storage tenant migrations applied");

  runContainer(NAMES.storage, [
    "-d",
    "-e", "SERVER_PORT=5000", "-e", "SERVER_REGION=local", "-e", "TENANT_ID=stub",
    "-e", `AUTH_JWT_SECRET=${jwtSecret}`, "-e", "AUTH_JWT_ALGORITHM=HS256",
    "-e", `ANON_KEY=${anonKey}`, "-e", `SERVICE_KEY=${serviceKey}`,
    "-e", `DATABASE_URL=${dbUrl}`,
    "-e", "STORAGE_BACKEND=file",
    "-e", "FILE_STORAGE_BACKEND_PATH=/var/lib/storage",
    "-e", "UPLOAD_FILE_SIZE_LIMIT=52428800",
    "-e", "UPLOAD_SIGNED_URL_EXPIRATION_TIME=300",
    "-e", "IMAGE_TRANSFORMATION_ENABLED=false",
    IMAGE.storage,
  ]);

  runContainer(NAMES.clamd, [
    "-d", "-e", "CLAMAV_NO_FRESHCLAMD=true", IMAGE.clamd,
  ]);

  // label=disable: repo/cert paths are mounted read-only; unconfining these
  // disposable containers avoids SELinux relabeling host files.
  runContainer(NAMES.tls, [
    "-d", "--security-opt", "label=disable",
    "-v", `${join(stateDir(), "certs")}:/rehearsal-certs:ro`,
    "-v", `${ASSETS}:/rehearsal:ro`,
    "-e", `UPSTREAM_ORIGIN=http://${NAMES.storage}:5000`,
    IMAGE.node, "node", "/rehearsal/tls-proxy.mjs",
  ]);

  const probe = runContainer(NAMES.probe, [
    "--rm", "--security-opt", "label=disable",
    "-v", `${ASSETS}:/rehearsal:ro`,
    "-e", `STORAGE_ORIGIN=http://${NAMES.storage}:5000`,
    "-e", `SERVICE_KEY=${serviceKey}`, "-e", `BUCKET=${BUCKET}`,
    "-e", `CLAMD_HOST=${NAMES.clamd}`, "-e", "CLAMD_PORT=3310",
    IMAGE.node, "node", "/rehearsal/probe-setup.mjs",
  ], { timeoutMs: CHILD_TIMEOUT_MS.probe, allowFail: true });
  if (DEBUG && probe.stdout) process.stdout.write(sanitize(probe.stdout) + "\n");
  if (probe.status !== 0) {
    throw new Error(`readiness probe failed (status ${probe.status}): ${sanitize(probe.stderr)}`);
  }
  const clamdVersion =
    /^clamd_version=ClamAV ([0-9]+\.[0-9]+\.[0-9]+)\//mu.exec(probe.stdout)?.[1];
  if (!clamdVersion) throw new Error("could not capture clamd engine version");
  const privateBucket = /^bucket_name=\S+ public=false$/mu.test(probe.stdout);
  if (!privateBucket) throw new Error("quarantine bucket was not verified private");

  writeFileSync(join(stateDir(), "run.json"), JSON.stringify({
    runId: RUN_ID,
    bucket: BUCKET,
    clamdVersion,
    storageOrigin: `https://${NAMES.tls}`,
    clamdHost: NAMES.clamd,
  }), { mode: 0o600 });
  log(`stack up; clamd engine ${clamdVersion}; bucket "${BUCKET}" verified private`);
  return { clamdVersion };
}

// ---------- rehearsal test ----------

function test({ clamdVersion }) {
  const outDir = join(stateDir(), "out");
  const env = [
    "NOVA_L03_REAL_SERVICES=1",
    `L03_STORAGE_ORIGIN=https://${NAMES.tls}`,
    "L03_STORAGE_CA_FILE=/rehearsal-certs/ca.crt",
    `L03_SERVICE_KEY=${state.secrets.serviceKey}`,
    `L03_ANON_KEY=${state.secrets.anonKey}`,
    `L03_BUCKET=${BUCKET}`,
    `L03_CLAMD_HOST=${NAMES.clamd}`,
    "L03_CLAMD_PORT=3310",
    "L03_CLAMD_DEAD_PORT=3399",
    `L03_CLAMD_VERSION=${clamdVersion}`,
    "CI=1",
  ];
  const result = cli([
    "run", "--rm", "--name", NAMES.test, "--network", NETWORK,
    "--label", `${LABEL}=${RUN_ID}`,
    "--security-opt", "label=disable",
    "-v", `${ROOT}:${ROOT}`,
    "-v", `${MODULES}:${MODULES}:ro`,
    "-v", `${join(stateDir(), "certs")}:/rehearsal-certs:ro`,
    "-v", `${outDir}:/rehearsal-out`,
    "-w", ROOT,
    ...env.flatMap((entry) => ["-e", entry]),
    IMAGE.node, "node", "node_modules/vitest/vitest.mjs", "run",
    "--reporter=json", "--outputFile=/rehearsal-out/vitest-report.json",
    "src/lib/__tests__/document-l03-real-services.test.ts",
  ], { timeoutMs: CHILD_TIMEOUT_MS.vitest, allowFail: true });

  if (DEBUG && result.stdout) process.stdout.write(sanitize(result.stdout) + "\n");

  let report = null;
  const reportPath = join(outDir, "vitest-report.json");
  if (existsSync(reportPath)) {
    try { report = JSON.parse(readFileSync(reportPath, "utf8")); } catch { report = null; }
  }
  const tests = report
    ? (report.testResults ?? []).flatMap((file) =>
      (file.assertionResults ?? []).map((a) => ({
        name: String(a.fullName ?? a.title ?? "").slice(0, 200),
        status: String(a.status),
      })))
    : [];
  const passed = tests.filter((t) => t.status === "passed").length;
  const failed = tests.filter((t) => t.status === "failed").length;
  const skipped = tests.filter((t) => t.status !== "passed" && t.status !== "failed").length;
  return {
    cliStatus: result.status,
    tests,
    passed,
    failed,
    skipped,
    timedOut: result.error?.code === "ETIMEDOUT" || result.signal === "SIGTERM",
  };
}

// ---------- teardown (owned resources only) ----------

function down() {
  const problems = [];
  // Remove only containers carrying this run's label.
  const listed = cli(
    ["ps", "-aq", "--filter", `label=${LABEL}=${RUN_ID}`],
    { allowFail: true },
  );
  const ids = (listed.stdout ?? "").split("\n").map((s) => s.trim()).filter(Boolean);
  for (const id of ids) {
    // Podman's forced removal does not consistently apply --rm's anonymous
    // volume cleanup. These containers were created by this run; their only
    // host mounts are explicit read-only binds, never shared named volumes.
    if (cli(["rm", "-f", "-v", id], { allowFail: true }).status !== 0) {
      problems.push(`container ${id} could not be removed`);
    }
  }
  if (state.createdNetwork) {
    if (cli(["network", "rm", NETWORK], { allowFail: true }).status !== 0) {
      problems.push(`network ${NETWORK} could not be removed`);
    }
    state.createdNetwork = false;
  }
  if (state.dir) {
    // Guard: only ever remove the exact private dir this run created.
    const dir = state.dir;
    const owned = existsSync(join(dir, "OWNED")) &&
      readFileSync(join(dir, "OWNED"), "utf8").trim() === RUN_ID &&
      realpathSync(dir).startsWith(realpathSync(tmpdir()));
    if (owned) rmSync(dir, { recursive: true, force: true });
    else problems.push(`state dir ${dir} failed ownership check; left in place`);
  }

  // Verify absence: no labeled containers, no owned network, no state dir.
  const remaining = cli(
    ["ps", "-aq", "--filter", `label=${LABEL}=${RUN_ID}`],
    { allowFail: true },
  ).stdout.split("\n").map((s) => s.trim()).filter(Boolean);
  const networkLeft = resourceExists("network", NETWORK);
  const dirLeft = state.dir ? existsSync(state.dir) : false;
  const verified = problems.length === 0 && remaining.length === 0 && !networkLeft && !dirLeft;
  return {
    verified,
    removedContainers: ids.length,
    problems,
    networkRemoved: !networkLeft,
    stateDirRemoved: !dirLeft,
  };
}

// ---------- receipt ----------

function writeReceipt(receiptPath, receipt) {
  if (!receiptPath) return null;
  const target = resolve(receiptPath);
  if (existsSync(target) || lstatSync(target, { throwIfNoEntry: false })?.isSymbolicLink()) {
    throw new Error(`receipt path already exists or is a symlink: ${target}`);
  }
  writeFileSync(target, JSON.stringify(receipt, null, 2) + "\n", { mode: 0o600 });
  return target;
}

// ---------- main ----------

const USAGE = `usage: l03-real-services.mjs [--receipt PATH]
Runs the disposable L03 real-service rehearsal end to end: provisions an
owned, labeled stack (Postgres + supabase/storage-api + clamd + TLS edge) on
a private container network, runs the env-gated vitest rehearsal suite from
inside it, verifies teardown, and writes a sanitized JSON receipt.

Options:
  --receipt PATH   receipt destination (default: a private temp file whose
                   path is printed at the end)
  --help           print this message

Environment:
  CONTAINER_CLI    container CLI to use (default: docker, then podman)`;

function parseArgs(argv) {
  const args = { receipt: null };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--help" || arg === "-h") return { help: true };
    if (arg === "--receipt" && argv[i + 1] && !argv[i + 1].startsWith("-")) {
      args.receipt = argv[++i];
      continue;
    }
    if (arg === "rehearse") continue;
    throw new Error(`unknown argument: ${arg}`);
  }
  return args;
}

async function main() {
  let parsed;
  try {
    parsed = parseArgs(process.argv.slice(2));
  } catch (error) {
    console.error(`${error.message}\n${USAGE}`);
    process.exit(2);
  }
  if (parsed.help) {
    console.log(USAGE);
    return;
  }

  CLI = detectCli();
  const startedAt = new Date().toISOString();
  const receipt = {
    schema: "nova-l03-real-services-receipt/1",
    runId: RUN_ID,
    containerCli: CLI,
    startedAt,
    finishedAt: null,
    result: "fail",
    clamdVersion: null,
    expectedTests: EXPECTED_TESTS,
    tests: { total: 0, passed: 0, failed: 0, skipped: 0, items: [] },
    markers: [],
    failures: [],
    cleanup: null,
  };

  let interrupted = false;
  const onSignal = (sig) => {
    interrupted = true;
    receipt.failures.push(`interrupted by ${sig}`);
  };
  process.on("SIGINT", () => onSignal("SIGINT"));
  process.on("SIGTERM", () => onSignal("SIGTERM"));

  let phase = "stack";
  try {
    const { clamdVersion } = up();
    receipt.clamdVersion = clamdVersion;
    phase = "tests";
    const outcome = test({ clamdVersion });
    receipt.tests = {
      total: outcome.tests.length,
      passed: outcome.passed,
      failed: outcome.failed,
      skipped: outcome.skipped,
      items: outcome.tests.map(({ name, status }) => ({ name, status })),
    };
    for (const t of outcome.tests) {
      if (t.status === "failed") receipt.failures.push("TEST_FAILED");
    }
    const countsOk = outcome.passed === EXPECTED_TESTS &&
      outcome.failed === 0 && outcome.skipped === 0 &&
      outcome.tests.length === EXPECTED_TESTS;
    if (outcome.cliStatus !== 0 && countsOk) {
      receipt.failures.push(`vitest exited ${outcome.cliStatus}`);
    }
    if (outcome.timedOut) receipt.failures.push("vitest run exceeded its bounded timeout");
    if (!countsOk) {
      receipt.failures.push(
        `expected exactly ${EXPECTED_TESTS} passing tests; got ` +
        `${outcome.passed} passed / ${outcome.failed} failed / ${outcome.skipped} skipped`,
      );
    }
    if (outcome.cliStatus === 0 && countsOk && !outcome.timedOut) {
      receipt.result = "pass";
    }
  } catch {
    // Provider/tool diagnostics can echo arbitrary credentials or object data,
    // even after pattern redaction. Publish only known phase codes; test names
    // and statuses already identify the failing checks without their raw diff.
    receipt.failures.push(phase === "stack" ? "STACK_FAILED" : "TEST_EXECUTION_FAILED");
  } finally {
    try {
      receipt.cleanup = down();
    } catch {
      receipt.cleanup = { verified: false, problems: ["CLEANUP_INSPECTION_FAILED"] };
    }
    if (!receipt.cleanup.verified) {
      receipt.result = "fail";
      receipt.failures.push("cleanup verification failed; owned resources may remain");
    }
  }
  receipt.finishedAt = new Date().toISOString();
  if (interrupted) receipt.result = "fail";

  const defaultReceipt = join(tmpdir(), `nova-l03-rehearsal-receipt-${RUN_ID}.json`);
  const receiptPath = writeReceipt(parsed.receipt ?? defaultReceipt, receipt);
  log(`receipt: ${receiptPath}`);
  log(`result=${receipt.result} tests=${receipt.tests.passed}/${receipt.tests.total} cleanup.verified=${receipt.cleanup?.verified}`);
  if (receipt.failures.length) {
    for (const f of receipt.failures) console.error(`[l03-rehearsal] failure: ${f}`);
  }
  process.exit(receipt.result === "pass" ? 0 : 1);
}

await main();
