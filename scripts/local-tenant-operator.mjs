#!/usr/bin/env node
// L-02 local operator surface: drives the platform-operator invitation
// operations (status / reissue / revoke) plus a member-actor `invite`
// convenience on the SQLite compatibility runtime (nosite-leads.db — the
// DATABASE_URL-absent path) through the canonical tenancy services. Every op
// is journaled/idempotent — re-running a command replays the recorded result.
//
// Usage:
//   npm run local:tenancy:operator -- status <invitationId>
//   npm run local:tenancy:operator -- reissue <invitationId> [expiresAtIso]
//   npm run local:tenancy:operator -- revoke <invitationId>
//   npm run local:tenancy:operator -- invite <authIdentityId> [role]
//
// Knobs (env):
//   LOCAL_OPERATOR_IDENTITY    operator auth identity recorded in audit
//                              (default the local operator subject)
//   LOCAL_OPERATOR_REASON_CODE audit reason code (default local.ops)
//   LOCAL_OPERATOR_REASON      audit reason text
//   LOCAL_OPERATOR_IDEM        override the derived idempotency key
//
// The driver is TypeScript under scripts/ and imports the canonical services;
// this wrapper bundles it with the vendored esbuild and runs the bundle.

import { spawnSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const entry = join(root, "scripts", "local-tenant-operator.driver.ts");
const cacheDir = join(root, "node_modules", ".cache");
const outfile = join(cacheDir, "nova-local-tenant-operator.mjs");

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

// getDb() resolves nosite-leads.db from process.cwd() — pin it to the repo root.
process.chdir(root);

const driver = await import(pathToFileURL(outfile).href);
try {
  await driver.main(process.argv.slice(2));
} catch (error) {
  const code = error && typeof error === "object" && "code" in error ? ` [${error.code}]` : "";
  console.error(`[operator] failed${code}: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
}
