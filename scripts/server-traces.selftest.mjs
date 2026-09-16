import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const TRACES = join(ROOT, ".next");

test("production file traces exclude local data, credentials, and rehearsal artifacts", () => {
  const files = readdirSync(TRACES, { recursive: true }).filter((name) => name.endsWith(".nft.json"));
  assert.ok(files.length > 0, "Run the production build before checking server traces");
  const unsafe = new Set();
  for (const file of files) {
    const manifestPath = join(TRACES, file);
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    assert.ok(Array.isArray(manifest.files), `Missing file list: ${file}`);
    for (const entry of manifest.files) {
      const traced = relative(ROOT, resolve(dirname(manifestPath), entry));
      const parts = traced.split(sep);
      const sensitive = parts.some((part) =>
        (part.startsWith(".env") && part !== ".env.example")
        || [".git", ".auth", ".data", "staging-artifacts", "data-export", "test-results", "playwright-report"].includes(part)
        || /\.(?:db|sqlite|sqlite3)(?:-(?:wal|shm|journal))?$/.test(part)
        || part.endsWith(".key"));
      if (sensitive) unsafe.add(traced);
    }
  }
  assert.deepEqual([...unsafe].sort(), [], "Runtime-local files must be provisioned separately, never bundled");
});
