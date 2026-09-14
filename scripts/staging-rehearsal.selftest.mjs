#!/usr/bin/env node
/**
 * Focused safety probes for scripts/staging-rehearsal.mjs (ephemeral harness).
 *
 * Every scenario runs in a private fixture root under tmpdir(): copies of
 * scripts/{staging-rehearsal,local-supabase}.mjs + supabase/local/{compose.yml,
 * gateway.conf} plus synthetic .env* files. The real checkout is NEVER
 * touched — no .env.local writes, no staging-artifacts, no auth state.
 *
 * Proves, without touching real Nova data or containers:
 *   1. help/--help/bare are inert — even with malformed ambient env — and
 *      perform zero docker calls and zero filesystem mutation.
 *   2. Removed/unknown commands & flags (down, --keep, --run, extras) reject
 *      with exit 2 before any mutation; malformed ports/run ids exit before
 *      any mutation.
 *   3. Port-conflict, foreign same-prefix leftovers, and an unreachable
 *      docker daemon refuse with only read-only probes and no artifacts.
 *   4. Symlinked/pre-existing run artifact dirs are refused before mutation.
 *   5. An inherited production NEXT_PUBLIC_APP_URL cannot escape localhost —
 *      the receipt always records http://localhost:<port> — and dotenv keys
 *      (incl. `export K =` / `K:` grammar) are neutralized: names recorded,
 *      values never.
 *   6. Foreign same-name volume/network at teardown => compose down is never
 *      invoked; private state retained; receipt=CLEANUP_FAILED.
 *   7. SIGINT during foreign-contaminated teardown refuses cleanup.
 *   8. SIGTERM mid-`up` performs bounded owned cleanup: compose down -v
 *      scoped to the run project, private dir removed, and the spawned
 *      grandchild process group has no survivors.
 *
 * A fake `docker` shim on PATH records every invocation to a baked-in log
 * path (env vars cannot survive the orchestrator's allowlisted child env).
 */

import { spawn } from "node:child_process";
import {
  cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync,
  symlinkSync, writeFileSync,
} from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import net from "node:net";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

let passed = 0, failed = 0;
const fixtures = [];
function ok(name, cond, extra = "") {
  if (cond) { passed++; console.log(`  PASS ${name}`); }
  else { failed++; console.error(`  FAIL ${name} ${extra}`); }
}
// Private project root: the harness scripts + compose assets, nothing else.
// All scenario mutations (env files, artifacts) happen inside this dir.
function fixtureRoot(tag) {
  const root = mkdtempSync(join(tmpdir(), `staging-selftest-${tag}-`));
  fixtures.push(root);
  mkdirSync(join(root, "scripts"), { recursive: true });
  mkdirSync(join(root, "supabase", "local"), { recursive: true });
  mkdirSync(join(root, "supabase", "migrations"), { recursive: true });
  for (const f of ["staging-rehearsal.mjs", "local-supabase.mjs"]) {
    cpSync(join(ROOT, "scripts", f), join(root, "scripts", f));
  }
  for (const f of ["compose.yml", "gateway.conf"]) {
    cpSync(join(ROOT, "supabase", "local", f), join(root, "supabase", "local", f));
  }
  return root;
}

// Fake docker: every argv logged to <dir>/docker.log. Knobs:
//   psNames        — printed for `docker ps*` calls
//   psExit         — exit code for `docker ps` (daemon-unavailable probe)
//   upSleepSecs    — `compose ... up` sleeps this long (signal tests)
//   upExit         — `compose ... up` exits with this code
//   upGrandchild   — `compose ... up` spawns `sleep 60` grandchild (pid->file)
//   phaseForeign   — `ps` also prints `<run>-foreign` once `up` ran
//   foreignVol     — `<kind> inspect <name>` reports foreign-project; ls lists it
//   foreignNet     — same for the network
//   psFailAfterPhase — `ps` exits 42 once the `up` phase marker exists
function fakeDockerDir(tag, o = {}) {
  const dir = mkdtempSync(join(tmpdir(), `staging-fakedocker-${tag}-`));
  fixtures.push(dir);
  const log = join(dir, "docker.log");
  const phase = join(dir, "phase");
  const gcpid = join(dir, "gcpid");
  writeFileSync(join(dir, "docker"), `#!/usr/bin/env bash
echo "$@" >> ${JSON.stringify(log)}
if [[ "$1" == "ps" ]]; then
  ${o.psFailAfterPhase ? `if [[ -f ${JSON.stringify(phase)} ]]; then exit 42; fi` : ""}
  printf '%s' ${JSON.stringify(o.psNames || "")}
  ${o.phaseForeign ? `if [[ -f ${JSON.stringify(phase)} && "$*" == *"${o.phaseForeign}-"* ]]; then printf '%s-foreign\\n' "${o.phaseForeign}"; fi` : ""}
  exit ${o.psExit ?? 0}
fi
if [[ "$1" == "compose" ]]; then
  touch ${JSON.stringify(phase)}
  if [[ "$*" == *" up "* || "$*" == *" up" ]]; then
    ${o.upGrandchild ? `sleep 60 & echo $! > ${JSON.stringify(gcpid)}` : ""}
    sleep ${o.upSleepSecs || 0}
    exit ${o.upExit || 0}
  fi
  exit 0
fi
if [[ "$1" == "volume" || "$1" == "network" ]]; then
  foreign=""
  ${o.foreignVol ? `[[ "$1" == "volume" ]] && foreign=${JSON.stringify(o.foreignVol)}` : ""}
  ${o.foreignNet ? `[[ "$1" == "network" ]] && foreign=${JSON.stringify(o.foreignNet)}` : ""}
  if [[ "$2" == "inspect" ]]; then
    if [[ -n "$foreign" && "$3" == "$foreign" ]]; then printf 'foreign-project'; exit 0; fi
    exit 1
  fi
  if [[ "$2" == "ls" ]]; then
    [[ -n "$foreign" ]] && printf '%s\\n' "$foreign"
    exit 0
  fi
fi
if [[ "$1" == "inspect" ]]; then printf '%s' ${JSON.stringify(o.inspectValue || "")}; fi
exit 0
`, { mode: 0o755 });
  return { dir, log, phase, gcpid };
}

// Fake `node` + `npx` shims for the full-green pipeline probe: canned stage
// output for the script children, and `next start` launches a REAL http
// server (with a sleep grandchild) so the app lifecycle — health check,
// SIGTERM stop, group teardown — is exercised for real.
function fakeRuntimeBin(tag) {
  const dir = mkdtempSync(join(tmpdir(), `staging-fakebin-${tag}-`));
  fixtures.push(dir);
  const gcpid = join(dir, "app-grandchild.pid");
  const realNode = process.execPath;
  writeFileSync(join(dir, "node"), `#!/usr/bin/env bash
args="$*"
if [[ "$args" == *"local-supabase.mjs verify"* ]]; then
  printf '  PASS containers (3)\\n  PASS tenant (ok)\\n  PASS lease-roles (ok)\\n'
  exit 0
fi
if [[ "$args" == *"local-supabase.mjs"* ]]; then exit 0; fi
if [[ "$args" == *"seed-acceptance-tenant.mjs"* ]]; then exit 0; fi
if [[ "$args" == *"server-traces.selftest.mjs"* ]]; then exit 0; fi
if [[ "$args" == *"run-e2e.mjs acceptance"* ]]; then echo "  2 passed"; exit 0; fi
if [[ "$args" == *"run-e2e.mjs auth"* && "$args" == *"--grep-invert"* ]]; then echo "  26 passed"; exit 0; fi
if [[ "$args" == *"run-e2e.mjs auth"* && "$args" == *"--grep"* ]]; then echo "  12 passed"; exit 0; fi
exit 0
`, { mode: 0o755 });
  writeFileSync(join(dir, "npx"), `#!/usr/bin/env bash
if [[ "$*" == *"next build"* ]]; then mkdir -p .next; exit 0; fi
if [[ "$*" == *"next start"* ]]; then
  port=""; prev=""
  for a in "$@"; do [[ "$prev" == "-p" ]] && port="$a"; prev="$a"; done
  sleep 300 & echo $! > ${JSON.stringify(gcpid)}
  ${JSON.stringify(realNode)} -e "require('http').createServer((q,s)=>{s.writeHead(200,{'content-type':'application/json'});s.end(JSON.stringify({ok:true}))}).listen($port,'127.0.0.1')" &
  wait
fi
exit 0
`, { mode: 0o755 });
  return { dir, gcpid };
}

// Spawn the harness inside a private fixture root. Ambient NOVA_STAGING_*
// vars are stripped so a caller's own run identity cannot leak into probes.
function runScript(root, args, { env = {}, docker, pathDirs = [], timeout = 60_000, killAfter = null } = {}) {
  const clean = { ...process.env };
  for (const k of Object.keys(clean)) if (k.startsWith("NOVA_STAGING_")) delete clean[k];
  const shimPath = [docker?.dir, ...pathDirs].filter(Boolean).join(":");
  const child = spawn(process.execPath, [join(root, "scripts", "staging-rehearsal.mjs"), ...args], {
    cwd: root,
    env: { ...clean, ...env, PATH: shimPath ? `${shimPath}:${process.env.PATH}` : process.env.PATH },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "", stderr = "";
  child.stdout.on("data", (d) => { stdout += d; });
  child.stderr.on("data", (d) => { stderr += d; });
  return new Promise((resolve) => {
    const timer = setTimeout(() => { child.kill("SIGKILL"); }, timeout);
    const killTimer = killAfter ? setTimeout(() => child.kill(killAfter.signal), killAfter.ms) : null;
    child.on("exit", (code, sig) => {
      clearTimeout(timer); if (killTimer) clearTimeout(killTimer);
      resolve({ code, sig, stdout, stderr,
        dockerLog: docker && existsSync(docker.log) ? readFileSync(docker.log, "utf8") : "" });
    });
  });
}

// A docker call is read-only iff it is ps / inspect / volume|network inspect|ls.
const READONLY = /^(ps\b|inspect\b|(volume|network) (inspect|ls)\b)/;
const mutating = (log) => log.split("\n").filter((l) => l.trim() && !READONLY.test(l.trim()));
const readReceipt = (root, rid) =>
  JSON.parse(readFileSync(join(root, "staging-artifacts", rid, "receipt.json"), "utf8"));
const artDir = (root, rid) => join(root, "staging-artifacts", rid);

async function main() {
  // ---- 1: inert help (incl. malformed ambient env) + fail-closed CLI ----
  for (const [name, args, env, expectCode] of [
    ["help-flag", ["--help"], {}, 0],
    ["help-bad-env", ["--help"], { NOVA_STAGING_DB_PORT: "abc", NOVA_STAGING_RUN_ID: "!!" }, 0],
    ["help-cmd", ["help"], {}, 0],
    ["bare", [], {}, 0],
    ["unknown-flag", ["rehearse", "--wipe"], {}, 2],
    ["removed-down", ["down"], {}, 2],
    ["removed-keep", ["rehearse", "--keep"], {}, 2],
    ["removed-run", ["down", "--run", "rabc1"], {}, 2],
    ["extra-arg", ["rehearse", "fast"], {}, 2],
    ["unknown-cmd", ["nuke"], {}, 2],
    ["bad-port", ["rehearse"], { NOVA_STAGING_DB_PORT: "abc" }, 1],
    ["bad-port-range", ["rehearse"], { NOVA_STAGING_APP_PORT: "99999" }, 1],
    ["bad-runid", ["rehearse"], { NOVA_STAGING_RUN_ID: "bad id" }, 1],
  ]) {
    const root = fixtureRoot(name);
    const docker = fakeDockerDir(name);
    const r = await runScript(root, args, { env, docker });
    ok(name, r.code === expectCode && mutating(r.dockerLog).length === 0
      && (expectCode === 0 ? /Usage/.test(r.stdout) : true)
      && !existsSync(join(root, "staging-artifacts")),
      `code=${r.code} log=${JSON.stringify(r.dockerLog.slice(0, 200))}`);
  }

  // ---- 3a: port-conflict refuses before ANY mutation (real socket) ----
  {
    const root = fixtureRoot("ports");
    const blocker = net.createServer().listen(55499, "127.0.0.1");
    await new Promise((r) => blocker.once("listening", r));
    const docker = fakeDockerDir("ports");
    const r = await runScript(root, ["rehearse"], {
      docker,
      env: { NOVA_STAGING_DB_PORT: "55499", NOVA_STAGING_RUN_ID: "rportprobe1" },
    });
    blocker.close();
    ok("port-conflict-refusal", r.code === 1
      && /already in use/.test(r.stderr)
      && mutating(r.dockerLog).length === 0
      && !existsSync(artDir(root, "rportprobe1")),
      `code=${r.code} stderr=${r.stderr.slice(0, 120)} mut=${JSON.stringify(mutating(r.dockerLog))}`);
  }

  // ---- 3b: unreachable docker daemon refuses before ANY mutation ----
  {
    const root = fixtureRoot("unavail");
    const docker = fakeDockerDir("unavail", { psExit: 42 });
    const r = await runScript(root, ["rehearse"], {
      docker, env: { NOVA_STAGING_RUN_ID: "runavail1", NOVA_STAGING_DB_PORT: "55497" },
    });
    ok("docker-unavailable-refusal", r.code === 1
      && /docker inspection failed/.test(r.stderr)
      && !r.dockerLog.split("\n").some((l) => l.startsWith("compose"))
      && !existsSync(artDir(root, "runavail1")),
      `code=${r.code} stderr=${r.stderr.slice(0, 140)}`);
  }

  // ---- 3c: foreign same-prefix leftovers refused at preflight ----
  {
    const root = fixtureRoot("foreign");
    const docker = fakeDockerDir("foreign", { psNames: "nova-staging-rforeign1-db\n" });
    const r = await runScript(root, ["rehearse"], {
      docker, env: { NOVA_STAGING_RUN_ID: "rforeign1", NOVA_STAGING_DB_PORT: "55496" },
    });
    ok("foreign-prefix-refusal", r.code === 1
      && /leftover containers/.test(r.stderr)
      && mutating(r.dockerLog).length === 0
      && !existsSync(artDir(root, "rforeign1")),
      `code=${r.code} stderr=${r.stderr.slice(0, 120)}`);
  }

  // ---- 4: symlinked + pre-existing artifact dirs refused ----
  {
    const root = fixtureRoot("symlink");
    const docker = fakeDockerDir("symlink");
    mkdirSync(join(root, "staging-artifacts"), { recursive: true });
    symlinkSync(tmpdir(), join(root, "staging-artifacts", "rsymprobe1"));
    const r = await runScript(root, ["rehearse"], {
      docker, env: { NOVA_STAGING_RUN_ID: "rsymprobe1", NOVA_STAGING_DB_PORT: "55498" },
    });
    ok("symlink-artifacts-refused", r.code === 1 && /already exists|symlink/.test(r.stderr)
      && mutating(r.dockerLog).length === 0,
      `code=${r.code} stderr=${r.stderr.slice(0, 120)}`);

    mkdirSync(join(root, "staging-artifacts", "rexists1"), { recursive: true });
    const r2 = await runScript(root, ["rehearse"], {
      docker, env: { NOVA_STAGING_RUN_ID: "rexists1", NOVA_STAGING_DB_PORT: "55498" },
    });
    ok("existing-artifacts-refused", r2.code === 1 && /already exists/.test(r2.stderr)
      && mutating(r2.dockerLog).length === 0,
      `code=${r2.code} stderr=${r2.stderr.slice(0, 120)}`);
  }

  // ---- 5: inherited prod URL cannot escape localhost + dotenv neutralized ----
  {
    // Synthetic dotenv INSIDE the fixture root only — never the real checkout.
    const root = fixtureRoot("origin");
    writeFileSync(join(root, ".env.local"),
      "OPENAI_API_KEY=sk-probe-secret-9\nEVIL_MARKER=should-not-escape\n" +
      "export PARENT_SECRET = probe-sensitive-value\n  PARENT_ENDPOINT: https://never-contact.example\n");
    const docker = fakeDockerDir("origin", { upExit: 1 });
    const r = await runScript(root, ["rehearse"], {
      docker,
      env: {
        NOVA_STAGING_RUN_ID: "rorigin1",
        NOVA_STAGING_DB_PORT: "55495",
        NOVA_STAGING_APP_PORT: "55490",
        NEXT_PUBLIC_APP_URL: "https://prod.evil.example",
      },
    });
    const receipt = readReceipt(root, "rorigin1");
    const raw = JSON.stringify(receipt);
    ok("origin-localhost-only", r.code === 1
      && receipt.environment.appOrigin === "http://localhost:55490"
      && !raw.includes("prod.evil"),
      `origin=${receipt.environment.appOrigin}`);
    ok("dotenv-neutralized",
      ["OPENAI_API_KEY", "EVIL_MARKER", "PARENT_SECRET", "PARENT_ENDPOINT"]
        .every((k) => receipt.environment.neutralizedEnvKeys.includes(k))
      && !raw.includes("sk-probe-secret-9") && !raw.includes("should-not-escape")
      && !raw.includes("probe-sensitive-value") && !raw.includes("never-contact.example"),
      `keys=${receipt.environment.neutralizedEnvKeys.join(",")}`);
    ok("early-fail-clean-teardown", receipt.cleanup.verified === true
      && receipt.cleanup.privateArtifactsRemoved === true,
      `cleanup=${JSON.stringify(receipt.cleanup)}`);
  }

  // ---- 6a: foreign same-name VOLUME at teardown => refuse, never compose down ----
  {
    const rid = "rfvol1";
    const root = fixtureRoot("fvol");
    const docker = fakeDockerDir("fvol", { upExit: 1, foreignVol: `nova-staging-${rid}_nova-pgdata` });
    const r = await runScript(root, ["rehearse"], {
      docker, env: { NOVA_STAGING_RUN_ID: rid, NOVA_STAGING_DB_PORT: "55492" },
    });
    const receipt = readReceipt(root, rid);
    const downed = r.dockerLog.split("\n").some((l) => l.includes(" down "));
    ok("foreign-volume-refusal", r.code !== 0
      && !downed
      && receipt.cleanup.composeDown === "refused"
      && receipt.cleanup.verified === false
      && receipt.errorCode === "CLEANUP_FAILED"
      && existsSync(join(artDir(root, rid), "private")),
      `code=${r.code} down=${downed} cleanup=${JSON.stringify(receipt.cleanup)}`);
  }

  // ---- 6b: foreign same-name NETWORK at teardown => refuse ----
  {
    const rid = "rfnet1";
    const root = fixtureRoot("fnet");
    const docker = fakeDockerDir("fnet", { upExit: 1, foreignNet: `nova-staging-${rid}_default` });
    const r = await runScript(root, ["rehearse"], {
      docker, env: { NOVA_STAGING_RUN_ID: rid, NOVA_STAGING_DB_PORT: "55491" },
    });
    const receipt = readReceipt(root, rid);
    const downed = r.dockerLog.split("\n").some((l) => l.includes(" down "));
    ok("foreign-network-refusal", r.code !== 0
      && !downed
      && receipt.cleanup.composeDown === "refused"
      && receipt.cleanup.verified === false
      && existsSync(join(artDir(root, rid), "private")),
      `code=${r.code} down=${downed} cleanup=${JSON.stringify(receipt.cleanup)}`);
  }

  // ---- 7: SIGINT + foreign container at teardown => refuse, keep state ----
  {
    const rid = "rsigf1";
    const root = fixtureRoot("sigforeign");
    const docker = fakeDockerDir("sigforeign", { upSleepSecs: 30, phaseForeign: `nova-staging-${rid}` });
    const r = await runScript(root, ["rehearse"], {
      docker,
      env: { NOVA_STAGING_RUN_ID: rid, NOVA_STAGING_DB_PORT: "55494" },
      killAfter: { ms: 4000, signal: "SIGINT" },
      timeout: 30_000,
    });
    const receipt = readReceipt(root, rid);
    const downed = r.dockerLog.split("\n").some((l) => l.includes(" down "));
    ok("sigint-foreign-refusal", r.code !== 0
      && receipt.result === "fail"
      && receipt.errorCode === "CLEANUP_FAILED"
      && !downed
      && existsSync(join(artDir(root, rid), "private")),
      `code=${r.code} err=${receipt.errorCode} down=${downed} log=${r.dockerLog.slice(-300)}`);
  }

  // ---- 8: SIGTERM mid-up => bounded owned cleanup + no grandchild survivors ----
  {
    const rid = "rsigt1";
    const root = fixtureRoot("sigterm");
    const docker = fakeDockerDir("sigterm", { upSleepSecs: 30, upGrandchild: true });
    const r = await runScript(root, ["rehearse"], {
      docker,
      env: { NOVA_STAGING_RUN_ID: rid, NOVA_STAGING_DB_PORT: "55493" },
      killAfter: { ms: 4000, signal: "SIGTERM" },
      timeout: 30_000,
    });
    const cleaned = r.dockerLog.includes("down -v") && r.dockerLog.includes(`-p nova-staging-${rid}`);
    let gcAlive = false;
    if (existsSync(docker.gcpid)) {
      const gpid = +readFileSync(docker.gcpid, "utf8").trim();
      try { process.kill(gpid, 0); gcAlive = true; } catch { /* dead */ }
      if (gcAlive) { try { process.kill(gpid, "SIGKILL"); } catch {} }
    }
    const receipt = existsSync(join(artDir(root, rid), "receipt.json")) ? readReceipt(root, rid) : null;
    ok("sigterm-owned-cleanup", r.code === 143 && cleaned && !gcAlive
      && receipt?.cleanup?.verified === true
      && !existsSync(join(artDir(root, rid), "private")),
      `code=${r.code} sig=${r.sig} gcAlive=${gcAlive} log=${JSON.stringify(r.dockerLog.slice(-400))}`);
  }

  // ---- 9: docker inspection dies AFTER startup => teardown refuses ----
  {
    const rid = "rpsfail1";
    const root = fixtureRoot("psfail");
    const docker = fakeDockerDir("psfail", { upExit: 1, psFailAfterPhase: true });
    const r = await runScript(root, ["rehearse"], {
      docker, env: { NOVA_STAGING_RUN_ID: rid, NOVA_STAGING_DB_PORT: "55489" },
      timeout: 60_000,
    });
    const receipt = readReceipt(root, rid);
    const downed = r.dockerLog.split("\n").some((l) => l.includes(" down "));
    ok("ps-failure-refuses-teardown", r.code !== 0
      && !downed
      && receipt.cleanup.composeDown === "refused"
      && receipt.cleanup.verified === false
      && receipt.errorCode === "CLEANUP_FAILED"
      && existsSync(join(artDir(root, rid), "private")),
      `code=${r.code} down=${downed} cleanup=${JSON.stringify(receipt.cleanup)}`);
  }

  // ---- 10: full-green pipeline => app stopped, cleanup verified, receipt pass ----
  {
    const rid = "rgreen1";
    const root = fixtureRoot("green");
    const docker = fakeDockerDir("green");
    const bins = fakeRuntimeBin("green");
    const r = await runScript(root, ["rehearse"], {
      docker, pathDirs: [bins.dir],
      env: { NOVA_STAGING_RUN_ID: rid, NOVA_STAGING_DB_PORT: "55488", NOVA_STAGING_APP_PORT: "55487" },
      timeout: 60_000,
    });
    const receipt = readReceipt(root, rid);
    let gcAlive = false;
    if (existsSync(bins.gcpid)) {
      const gpid = +readFileSync(bins.gcpid, "utf8").trim();
      try { process.kill(gpid, 0); gcAlive = true; } catch { /* dead */ }
      if (gcAlive) { try { process.kill(gpid, "SIGKILL"); } catch {} }
    }
    const e2eOk = receipt.e2e.acceptance?.passed === 2
      && receipt.e2e.admin?.passed === 26 && receipt.e2e.researcher?.passed === 12
      && [receipt.e2e.acceptance, receipt.e2e.admin, receipt.e2e.researcher]
        .every((s) => s.failed === 0 && s.skipped === 0 && s.flaky === 0);
    ok("full-green-shutdown", r.code === 0
      && receipt.result === "pass"
      && receipt.cleanup.appStopped === "sigterm"
      && receipt.cleanup.verified === true
      && receipt.cleanup.privateArtifactsRemoved === true
      && e2eOk && !gcAlive
      && r.dockerLog.includes("down -v"),
      `code=${r.code} app=${receipt.cleanup.appStopped} gcAlive=${gcAlive} e2e=${JSON.stringify(receipt.e2e)} stderr=${r.stderr.slice(-200)}`);
  }

  for (const f of fixtures) rmSync(f, { recursive: true, force: true });
  console.log(`\nstaging-rehearsal selftest: ${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
