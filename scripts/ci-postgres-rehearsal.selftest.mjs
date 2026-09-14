#!/usr/bin/env node
// Fake-process regression suite for ci-postgres-rehearsal.mjs. Stubs `docker`
// and `npx` on PATH with a state-machine fake so the runner's naming,
// ownership, CLI parsing, and cleanup guarantees are proven without touching
// a real daemon, database, or any nova-local-* resource.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test, { after } from "node:test";
import { fileURLToPath } from "node:url";

const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), "ci-postgres-rehearsal.mjs");
const fixtureDirs = new Set();
after(() => {
  for (const dir of fixtureDirs) rmSync(dir, { recursive: true, force: true });
});

const FAKE_DOCKER = `#!/usr/bin/env node
// State-machine fake docker. State: <FAKE_DOCKER_STATE>.created holds the
// container name while "running"; FAKE_DOCKER_LOG records every invocation;
// "sqlexec" lines mark psql -f calls (i.e. SQL writes).
const fs = require("node:fs");
const log = process.env.FAKE_DOCKER_LOG;
const state = process.env.FAKE_DOCKER_STATE;
const args = process.argv.slice(2);
fs.appendFileSync(log, "docker " + args.join(" ") + "\\n");
const verb = args[0];
const createdFile = state + ".created";
const created = () => fs.existsSync(createdFile);
const createdName = () => (created() ? fs.readFileSync(createdFile, "utf8").trim() : "");
switch (verb) {
  case "run": {
    const i = args.indexOf("--name");
    fs.writeFileSync(createdFile, args[i + 1]);
    console.log("fakecontainerid");
    process.exit(0);
  }
  case "inspect": {
    const name = args[args.length - 1];
    if (!created() || createdName() !== name) process.exit(1);
    if (args.includes("--format")) console.log(process.env.FAKE_LABEL ?? "1");
    else console.log("{}");
    process.exit(0);
  }
  case "port": console.log("127.0.0.1:55440"); process.exit(0);
  case "logs": console.log("fake logs"); process.exit(0);
  case "rm": fs.rmSync(createdFile, { force: true }); process.exit(0);
  case "exec": {
    if (args.includes("-f")) {
      let input = "";
      try { input = fs.readFileSync(0, "utf8"); } catch {}
      fs.appendFileSync(log, "sqlexec\\n");
      if (input.includes("server_version_num")) console.log("160014");
      process.exit(0);
    }
    // readiness probe
    if (process.env.FAKE_READY === "1") { console.log("1"); process.exit(0); }
    process.exit(1);
  }
  default: process.exit(0);
}
`;

const FAKE_NPX = `#!/usr/bin/env node
require("node:fs").appendFileSync(
  process.env.FAKE_DOCKER_LOG,
  "npx " + process.argv.slice(2).join(" ") + "\\n",
);
process.exit(Number(process.env.FAKE_NPX_EXIT || 0));
`;

function baseEnv(over = {}) {
  const dir = mkdtempSync(join(tmpdir(), "ci-pg-selftest-"));
  fixtureDirs.add(dir);
  const bin = join(dir, "bin");
  mkdirSync(bin);
  writeFileSync(join(bin, "docker"), FAKE_DOCKER, { mode: 0o755 });
  writeFileSync(join(bin, "npx"), FAKE_NPX, { mode: 0o755 });
  return {
    PATH: `${bin}:${process.env.PATH}`,
    FAKE_DOCKER_LOG: join(dir, "docker.log"),
    FAKE_DOCKER_STATE: join(dir, "state"),
    CI_PG_STATE_FILE: join(dir, "owned.json"),
    FAKE_READY: "1",
    FAKE_NPX_EXIT: "0",
    CI_PG_READY_SECS: "2",
    ...over,
  };
}

function runScript(args, env) {
  const e = { ...process.env, ...env };
  if (!("CI_PG_NAME" in env)) delete e.CI_PG_NAME;
  return spawnSync("node", [SCRIPT, ...args], { encoding: "utf8", env: e, timeout: 60_000 });
}

const logOf = (env) => (existsSync(env.FAKE_DOCKER_LOG) ? readFileSync(env.FAKE_DOCKER_LOG, "utf8") : "");
const sqlCount = (env) => (logOf(env).match(/sqlexec/g) || []).length;
const createdFile = (env) => `${env.FAKE_DOCKER_STATE}.created`;

test("default name is stable within and across invocations via owned state", () => {
  const env = baseEnv();
  let r = runScript(["up"], env);
  assert.equal(r.status, 0, r.stderr);
  const name = readFileSync(createdFile(env), "utf8").trim();
  assert.match(name, /^nova-ci-pg-[0-9a-f]{8}$/);
  // A second process (no CI_PG_NAME) must resolve the same name.
  r = runScript(["env"], env);
  assert.equal(r.status, 0, r.stderr);
  assert.ok(r.stdout.includes(name), "env output should reference the same container");
  r = runScript(["down"], env);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(existsSync(createdFile(env)), false);
});

test("unknown flags fail closed with zero docker calls", () => {
  const env = baseEnv();
  const r = runScript(["--bogus"], env);
  assert.notEqual(r.status, 0);
  assert.equal(sqlCount(env), 0);
  assert.ok(!logOf(env).includes("docker run"));
});

test("--help is inert", () => {
  const env = baseEnv();
  const r = runScript(["--help"], env);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /usage:/);
  assert.equal(logOf(env), "");
});

test("unknown command fails closed", () => {
  const env = baseEnv();
  const r = runScript(["t041"], env);
  assert.notEqual(r.status, 0);
  assert.equal(logOf(env), "");
});

test("run <lane> selects that lane and does not fall through to it as a command", () => {
  const env = baseEnv();
  assert.equal(runScript(["up"], env).status, 0);
  const r = runScript(["run", "t041"], env);
  assert.equal(r.status, 0, r.stderr + r.stdout);
  assert.match(logOf(env), /npx vitest run .*tenant-cutover-ops-postgres\.test\.ts/);
  assert.ok(!/unknown (command|lane)/.test(r.stderr));
});

test("unknown lane id is rejected before any lane runs", () => {
  const env = baseEnv();
  assert.equal(runScript(["up"], env).status, 0);
  const r = runScript(["run", "nope"], env);
  assert.notEqual(r.status, 0);
  assert.ok(!logOf(env).includes("npx vitest"));
});

test("provision refuses an unlabeled container before any SQL write", () => {
  const env = baseEnv({ FAKE_LABEL: "0" });
  assert.equal(runScript(["up"], env).status, 0);
  const before = sqlCount(env);
  const r = runScript(["provision"], env);
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /missing .* label|refusing/);
  assert.equal(sqlCount(env), before, "zero SQL may be issued against a foreign container");
});

test("run refuses an unlabeled container", () => {
  const env = baseEnv({ FAKE_LABEL: "0" });
  assert.equal(runScript(["up"], env).status, 0);
  const r = runScript(["run", "t041"], env);
  assert.notEqual(r.status, 0);
  assert.ok(!logOf(env).includes("npx vitest"));
});

test("protected nova-local-* names are rejected outright", () => {
  const env = baseEnv({ CI_PG_NAME: "nova-local-db" });
  const r = runScript(["down"], env);
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /nova-local/);
  assert.equal(logOf(env), "", "must not even inspect a protected name");
});

test("startup readiness failure removes the created container", () => {
  const env = baseEnv({ FAKE_READY: "0", CI_PG_READY_SECS: "1" });
  const r = runScript(["up"], env);
  assert.notEqual(r.status, 0);
  assert.match(logOf(env), /docker rm --force/);
  assert.equal(existsSync(createdFile(env)), false);
});

test("failing lanes still tear the owned container down in `all`", () => {
  const env = baseEnv({ FAKE_NPX_EXIT: "1" });
  const r = runScript(["all"], env);
  assert.equal(r.status, 1);
  assert.match(logOf(env), /docker rm --force/);
  assert.equal(existsSync(createdFile(env)), false);
});

test("all leaves no container or state behind on success", () => {
  const env = baseEnv();
  const r = runScript(["all"], env);
  assert.equal(r.status, 0, r.stderr + r.stdout);
  assert.equal(existsSync(createdFile(env)), false);
  assert.equal(existsSync(env.CI_PG_STATE_FILE), false);
});

test("down preserves an unowned state file", () => {
  const env = baseEnv({ CI_PG_NAME: "nova-ci-parent-state-probe" });
  writeFileSync(env.CI_PG_STATE_FILE, "important user configuration\n");
  const r = runScript(["down"], env);
  assert.notEqual(r.status, 0);
  assert.equal(readFileSync(env.CI_PG_STATE_FILE, "utf8"), "important user configuration\n");
  assert.equal(logOf(env), "");
});

test("up preserves an unowned state file", () => {
  const env = baseEnv({ CI_PG_NAME: "nova-ci-parent-state-probe" });
  writeFileSync(env.CI_PG_STATE_FILE, "important user configuration\n");
  const r = runScript(["up"], env);
  assert.notEqual(r.status, 0);
  assert.equal(readFileSync(env.CI_PG_STATE_FILE, "utf8"), "important user configuration\n");
  assert.equal(logOf(env), "");
});

test("up refuses a symlink state file without modifying its target", () => {
  const env = baseEnv({ CI_PG_NAME: "nova-ci-parent-state-probe" });
  const target = join(dirname(env.CI_PG_STATE_FILE), "user-data.json");
  writeFileSync(target, "important user configuration\n");
  symlinkSync(target, env.CI_PG_STATE_FILE);
  const r = runScript(["up"], env);
  assert.notEqual(r.status, 0);
  assert.equal(readFileSync(target, "utf8"), "important user configuration\n");
  assert.equal(logOf(env), "");
});
