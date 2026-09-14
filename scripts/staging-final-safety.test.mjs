import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import {
  cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync,
  watch, writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const SOURCE = process.env.NOVA_STAGING_TEST_SOURCE_ROOT
  || join(dirname(fileURLToPath(import.meta.url)), "..");

function fixture(t, mode = "none") {
  const root = mkdtempSync(join(tmpdir(), "nova-staging-independent-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, "scripts"));
  mkdirSync(join(root, "supabase/local"), { recursive: true });
  mkdirSync(join(root, "bin"));
  for (const file of ["staging-rehearsal.mjs", "local-supabase.mjs", "staging-rehearsal.selftest.mjs"]) {
    cpSync(join(SOURCE, "scripts", file), join(root, "scripts", file));
  }
  for (const file of ["compose.yml", "gateway.conf"]) {
    cpSync(join(SOURCE, "supabase/local", file), join(root, "supabase/local", file));
  }
  const log = join(root, "calls.jsonl");
  const removed = join(root, "foreign-was-removed");
  const runId = "rparentprobe1";
  const project = `nova-staging-${runId}`;
  const foreignName = mode === "volume" ? `${project}_nova-pgdata` : `${project}_default`;
  const fake = `#!${process.execPath}
import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
const args = process.argv.slice(2);
appendFileSync(${JSON.stringify(log)}, JSON.stringify(args) + '\\n');
const mode = ${JSON.stringify(mode)};
const foreignName = ${JSON.stringify(foreignName)};
const removed = ${JSON.stringify(removed)};
if (args[0] === 'ps') {
  const upAttempted = readFileSync(${JSON.stringify(log)}, 'utf8').includes('"up"');
  process.exit(mode === 'unavailable' || (mode === 'lost-inspection' && upAttempted) ? 42 : 0);
}
if (args[0] === 'compose' && args.includes('up')) process.exit(1);
if (args[0] === 'compose' && args.includes('down')) {
  if (mode === 'volume' || mode === 'network') writeFileSync(removed, 'deleted');
  process.exit(0);
}
if ((args[0] === 'volume' || args[0] === 'network') && args[1] === 'inspect') {
  if (args[0] !== mode || existsSync(removed)) {
    process.stderr.write('Error: no such ' + args[0] + '\\n'); process.exit(1);
  }
  if (args.includes('--format')) process.stdout.write('foreign-project');
  else process.stdout.write(JSON.stringify([{Name:foreignName,Labels:{'com.docker.compose.project':'foreign-project'}}]));
  process.exit(0);
}
if ((args[0] === 'volume' || args[0] === 'network') && args[1] === 'ls') {
  if (args[0] === mode && !existsSync(removed)) process.stdout.write(foreignName + '\\n');
  process.exit(0);
}
process.exit(0);
`;
  writeFileSync(join(root, "bin/docker"), fake, { mode: 0o700 });
  return { root, log, removed, runId, project };
}

function run(f, script = "staging-rehearsal.mjs", args = ["rehearse"], extraEnv = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [join(f.root, "scripts", script), ...args], {
      cwd: f.root,
      env: {
        ...process.env,
        PATH: `${join(f.root, "bin")}:${process.env.PATH}`,
        NOVA_STAGING_RUN_ID: f.runId,
        NOVA_STAGING_DB_PORT: "59131",
        NOVA_STAGING_GW_PORT: "59132",
        NOVA_STAGING_APP_PORT: "59133",
        ...extraEnv,
      },
      stdio: ["ignore", "pipe", "pipe"],
      detached: true,
    });
    let stdout = "", stderr = "";
    child.stdout.on("data", (data) => { stdout = (stdout + data).slice(-5000); });
    child.stderr.on("data", (data) => { stderr = (stderr + data).slice(-5000); });
    const timer = setTimeout(() => {
      try { process.kill(-child.pid, "SIGKILL"); } catch { /* closed */ }
    }, 40_000);
    child.once("error", (error) => { clearTimeout(timer); reject(error); });
    child.once("close", (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal, stdout, stderr });
    });
  });
}

function calls(f) {
  return existsSync(f.log)
    ? readFileSync(f.log, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line))
    : [];
}

for (const kind of ["volume", "network"]) {
  test(`cleanup refuses a same-name ${kind} with a foreign ownership label`, async (t) => {
    const f = fixture(t, kind);
    const result = await run(f);
    assert.notEqual(result.code, 0);
    assert.equal(existsSync(f.removed), false, `foreign ${kind} was deleted`);
    assert.equal(calls(f).some((argv) => argv[0] === "compose" && argv.includes("down")), false);
  });
}

test("unavailable Docker inspection refuses before allocating or mutating resources", async (t) => {
  const f = fixture(t, "unavailable");
  const result = await run(f);
  assert.notEqual(result.code, 0);
  assert.equal(calls(f).some((argv) => argv[0] === "compose"), false);
  assert.equal(existsSync(join(f.root, "staging-artifacts", f.runId)), false);
});

test("cleanup refuses deletion if container inspection becomes unavailable after startup", async (t) => {
  const f = fixture(t, "lost-inspection");
  const result = await run(f);
  assert.notEqual(result.code, 0);
  assert.equal(calls(f).some((argv) => argv[0] === "compose" && argv.includes("up")), true);
  assert.equal(calls(f).some((argv) => argv[0] === "compose" && argv.includes("down")), false);
});

test("dotenv export and whitespace syntax is neutralized without publishing values", async (t) => {
  const f = fixture(t);
  writeFileSync(join(f.root, ".env.local"), "export PARENT_SECRET = probe-sensitive-value\n  PARENT_ENDPOINT: https://never-contact.example\n");
  const result = await run(f);
  assert.notEqual(result.code, 0); // fake stack deliberately refuses to start
  const receipt = JSON.parse(readFileSync(join(f.root, "staging-artifacts", f.runId, "receipt.json"), "utf8"));
  assert.ok(receipt.environment.neutralizedEnvKeys.includes("PARENT_SECRET"));
  assert.ok(receipt.environment.neutralizedEnvKeys.includes("PARENT_ENDPOINT"));
  assert.equal(JSON.stringify(receipt).includes("probe-sensitive-value"), false);
  assert.equal(JSON.stringify(receipt).includes("never-contact.example"), false);
});

test("the harness selftest never temporarily overwrites its checkout's dotenv file", async (t) => {
  const f = fixture(t);
  const envPath = join(f.root, ".env.local");
  const original = "PARENT_SENTINEL=preserve-existing-developer-config\n";
  writeFileSync(envPath, original, { mode: 0o600 });
  let touched = false;
  const watcher = watch(f.root, (_, name) => {
    if (String(name) !== ".env.local") return;
    if (!existsSync(envPath) || readFileSync(envPath, "utf8") !== original) touched = true;
  });
  try {
    await run(f, "staging-rehearsal.selftest.mjs", [], { NOVA_STAGING_APP_PORT: "59133" });
  } finally {
    watcher.close();
  }
  assert.equal(touched, false, "selftest temporarily replaced checkout .env.local");
  assert.equal(readFileSync(envPath, "utf8"), original);
});
