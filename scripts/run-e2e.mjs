import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { assertAcceptanceSafety, assertE2EAuth, assertMutationSafety } from "./e2e-safety.mjs";

const playwrightCli = fileURLToPath(new URL("../node_modules/playwright/cli.js", import.meta.url));
const rootDir = fileURLToPath(new URL("..", import.meta.url));
const mode = process.argv[2] ?? "all-read-only";

// The acceptance lane needs the local-stack env (.env.local) in the test
// process: lease issuer URL, cron secret, DATABASE_URL. Existing environment
// always wins; the file only fills gaps. Values are never echoed.
function loadEnvLocal() {
  const path = `${rootDir}/.env.local`;
  if (!existsSync(path)) return;
  for (const line of readFileSync(path, "utf8").split("\n")) {
    const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2];
  }
}
loadEnvLocal();

const modes = {
  "all-read-only": {
    auth: true,
    args: ["test", "--project=public-read-only", "--project=authenticated-read-only"],
  },
  public: {
    auth: false,
    args: ["test", "--project=public-read-only"],
  },
  auth: {
    auth: true,
    args: ["test", "--project=authenticated-read-only"],
  },
  launch: {
    auth: true,
    args: ["test", "e2e/launch-auth-screenshots.spec.ts", "--project=authenticated-read-only"],
  },
  mutating: {
    auth: true,
    mutating: true,
    args: ["test", "--project=mutating"],
  },
  acceptance: {
    auth: false,
    acceptance: true,
    args: ["test", "--project=acceptance"],
  },
};

const selected = modes[mode];
if (!selected) {
  console.error(`Unknown E2E mode: ${mode}. Expected one of: ${Object.keys(modes).join(", ")}`);
  process.exit(2);
}

try {
  if (selected.auth) assertE2EAuth();
  if (selected.mutating) assertMutationSafety();
  if (selected.acceptance) assertAcceptanceSafety();
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(2);
}

// The acceptance suite needs its isolated tenant foundation before it runs.
// The seed is idempotent, so running it here is safe to repeat.
if (selected.acceptance) {
  const seed = spawnSync(process.execPath, ["scripts/seed-acceptance-tenant.mjs"], {
    env: process.env,
    stdio: "inherit",
  });
  if (seed.status !== 0) process.exit(seed.status ?? 1);
}

const result = spawnSync(process.execPath, [playwrightCli, ...selected.args, ...process.argv.slice(3)], {
  env: process.env,
  stdio: "inherit",
});

if (result.error) {
  console.error(result.error);
  process.exit(1);
}

process.exit(result.status ?? 1);
