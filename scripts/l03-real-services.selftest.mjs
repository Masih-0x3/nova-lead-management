import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SECRET = "private-diagnostic-value-do-not-publish";

test("failure receipts and default console output do not publish raw tool diagnostics", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "nova-l03-safety-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const cli = join(dir, "fake-docker");
  const receiptPath = join(dir, "receipt.json");
  writeFileSync(cli, `#!${process.execPath}
const args = process.argv.slice(2);
if (args[0] === '--version') process.exit(0);
if (args.includes('exists') || args.includes('inspect')) {
  process.stderr.write('Error: no such resource\\n'); process.exit(1);
}
if (args[0] === 'network' && args[1] === 'create') {
  process.stderr.write('ERROR: invalid private input ${SECRET}\\nmultiline continuation ${SECRET}\\n');
  process.exit(23);
}
process.exit(0);
`, { mode: 0o700 });
  const result = spawnSync(process.execPath, [join(ROOT, "scripts/l03-real-services.mjs"), "--receipt", receiptPath], {
    cwd: ROOT,
    env: { ...process.env, CONTAINER_CLI: cli, L03_DEBUG: "0" },
    encoding: "utf8", timeout: 20_000,
  });
  assert.equal(result.status, 1);
  const raw = readFileSync(receiptPath, "utf8");
  const receipt = JSON.parse(raw);
  assert.equal(receipt.result, "fail");
  assert.equal(receipt.cleanup.verified, true);
  assert.equal(raw.includes(SECRET), false, "receipt leaked raw provider diagnostic");
  assert.equal(`${result.stdout}${result.stderr}`.includes(SECRET), false, "console leaked raw provider diagnostic");
});

test("Docker-compatible post-cleanup inspection detects a network that still exists", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "nova-l03-network-safety-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const cli = join(dir, "fake-docker");
  const receiptPath = join(dir, "receipt.json");
  const marker = join(dir, "network-exists");
  writeFileSync(cli, `#!${process.execPath}
import { existsSync, writeFileSync } from 'node:fs';
const args = process.argv.slice(2);
if (args[0] === '--version') process.exit(0);
// Docker does not have Podman's 'network exists' or 'container exists'.
if (args.includes('exists')) { process.stderr.write('unknown command exists'); process.exit(1); }
if (args.includes('inspect')) {
  if (args[0] === 'network' && existsSync(${JSON.stringify(marker)})) {
    process.stdout.write('[{"Name":"owned-network-still-present"}]'); process.exit(0);
  }
  process.stderr.write('Error: no such resource\\n'); process.exit(1);
}
if (args[0] === 'network' && args[1] === 'create') {
  writeFileSync(${JSON.stringify(marker)}, 'created'); process.exit(0);
}
if (args[0] === 'run') process.exit(7); // fail the first owned container start
// Simulate removal reporting success, while post-inspection still sees it.
process.exit(0);
`, { mode: 0o700 });
  const result = spawnSync(process.execPath, [join(ROOT, "scripts/l03-real-services.mjs"), "--receipt", receiptPath], {
    cwd: ROOT,
    env: { ...process.env, CONTAINER_CLI: cli, L03_DEBUG: "0" },
    encoding: "utf8", timeout: 20_000,
  });
  assert.equal(result.status, 1);
  const receipt = JSON.parse(readFileSync(receiptPath, "utf8"));
  assert.equal(receipt.cleanup.verified, false, "reported verified cleanup while network remained");
  assert.equal(receipt.cleanup.networkRemoved, false);
});

test("recognized Podman missing-resource diagnostics are compatible with verified cleanup", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "nova-l03-podman-safety-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const cli = join(dir, "fake-podman");
  const receiptPath = join(dir, "receipt.json");
  writeFileSync(cli, `#!${process.execPath}
const args = process.argv.slice(2);
if (args[0] === '--version') process.exit(0);
if (args.includes('inspect')) {
  process.stderr.write(args[0] === 'network'
    ? 'Error: network missing: unable to find network with name or ID missing: network not found\\n'
    : 'Error: no such container "missing"\\n');
  process.exit(125);
}
if (args[0] === 'network' && args[1] === 'create') process.exit(7);
process.exit(0);
`, { mode: 0o700 });
  const result = spawnSync(process.execPath, [join(ROOT, "scripts/l03-real-services.mjs"), "--receipt", receiptPath], {
    cwd: ROOT,
    env: { ...process.env, CONTAINER_CLI: cli, L03_DEBUG: "0" },
    encoding: "utf8", timeout: 20_000,
  });
  assert.equal(result.status, 1);
  const receipt = JSON.parse(readFileSync(receiptPath, "utf8"));
  assert.equal(receipt.cleanup.verified, true);
  assert.equal(receipt.cleanup.networkRemoved, true);
});
