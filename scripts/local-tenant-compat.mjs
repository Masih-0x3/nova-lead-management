#!/usr/bin/env node
// L-02 local compatibility-cutover lane: stages a legacy-shaped SQLite
// fixture and drives the canonical T-028 backfill (prepare → run → replay →
// snapshot-restore rollback) through src/lib/tenancy/compatibility-backfill.
//
// Usage:
//   npm run local:tenancy:compat -- stage
//   npm run local:tenancy:compat -- prepare
//   npm run local:tenancy:compat -- run
//   npm run local:tenancy:compat -- replay
//   npm run local:tenancy:compat -- verify
//   npm run local:tenancy:compat -- rollback
//
// Knobs (env):
//   LOCAL_COMPAT_DB    fixture path (default nova-leads-legacy.db)
//   LOCAL_COMPAT_IDEM  idempotency key (default local-compat-backfill-v1)
//
// The driver is TypeScript under scripts/; this wrapper bundles it with the
// vendored esbuild and runs the bundle.

import { spawnSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const entry = join(root, "scripts", "local-tenant-compat.driver.ts");
const cacheDir = join(root, "node_modules", ".cache");
const outfile = join(cacheDir, "nova-local-tenant-compat.mjs");

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

// The fixture resolves from process.cwd() — pin it to the repo root.
process.chdir(root);

const driver = await import(pathToFileURL(outfile).href);
try {
  await driver.main(process.argv.slice(2));
} catch (error) {
  const code = error && typeof error === "object" && "code" in error ? ` [${error.code}]` : "";
  console.error(`[compat] failed${code}: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
}
