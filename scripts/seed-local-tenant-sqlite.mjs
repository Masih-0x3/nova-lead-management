#!/usr/bin/env node
// L-02 local seed: provisions a tenant on the SQLite compatibility runtime
// (nova-leads.db — the DATABASE_URL-absent path) through the canonical
// tenancy services so the member-facing /users and /tenancy surfaces are
// exercisable in a browser. Idempotent: re-running replays journaled keys.
//
// Usage: npm run local:seed:sqlite
//
// Knobs (env):
//   LOCAL_SEED_TENANT_SLUG        default local-dev
//   LOCAL_SEED_TENANT_NAME        default "Local Development"
//   LOCAL_SEED_OWNER_IDENTITY_ID  default L-01 admin auth id (admin@nova.local)
//   LOCAL_SEED_MEMBER_IDENTITY_ID default L-01 researcher auth id
//   LOCAL_SEED_MEMBER=0           skip the second member
//   LOCAL_SEED_ACCEPT=0           leave invitations issued for manual acceptance
//
// The driver is TypeScript under scripts/ and imports the canonical services;
// this wrapper bundles it with the vendored esbuild and runs the bundle.

import { spawnSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const entry = join(root, "scripts", "local-tenant-seed.driver.ts");
const cacheDir = join(root, "node_modules", ".cache");
const outfile = join(cacheDir, "nova-local-tenant-seed.mjs");

mkdirSync(cacheDir, { recursive: true });

const esbuild = join(root, "node_modules", ".bin", "esbuild");
const build = spawnSync(
  esbuild,
  [
    "--bundle", "--platform=node", "--format=esm",
    "--alias:@=" + join(root, "src"),
    // server-only and next/headers are Next-runtime markers; the driver never
    // executes auth/session code paths, so they are stubbed for plain Node.
    "--alias:server-only=" + join(root, "scripts", "lib", "server-only-stub.mjs"),
    "--alias:next/headers=" + join(root, "scripts", "lib", "next-headers-stub.mjs"),
    "--external:better-sqlite3", "--external:postgres",
    entry,
    `--outfile=${outfile}`,
  ],
  { cwd: root, stdio: "inherit" },
);
if (build.status !== 0) {
  process.exit(build.status ?? 1);
}

// getDb() resolves nova-leads.db from process.cwd() — pin it to the repo root.
process.chdir(root);

const driver = await import(pathToFileURL(outfile).href);
try {
  await driver.main();
} catch (error) {
  const code = error && typeof error === "object" && "code" in error ? ` [${error.code}]` : "";
  console.error(`[seed] failed${code}: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
}
