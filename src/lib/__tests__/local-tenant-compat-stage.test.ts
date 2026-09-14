import Database from "better-sqlite3";
import {
  existsSync,
  lstatSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const dirs: string[] = [];

function freshDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "local-compat-stage-"));
  dirs.push(dir);
  return dir;
}

async function loadDriver(dbPath: string) {
  vi.stubEnv("LOCAL_COMPAT_DB", dbPath);
  vi.resetModules();
  return import("../../../scripts/local-tenant-compat.driver");
}

afterEach(() => {
  vi.unstubAllEnvs();
  while (dirs.length > 0) rmSync(dirs.pop() as string, { recursive: true, force: true });
});

describe("local-tenant-compat stage()", () => {
  it("refuses to stage over an existing database and snapshot without mutating either", async () => {
    const dir = freshDir();
    const dbPath = join(dir, "user-production.db");
    writeFileSync(dbPath, "pre-existing user data");
    writeFileSync(`${dbPath}.pre-backfill`, "existing snapshot bytes");
    writeFileSync(`${dbPath}-wal`, "existing wal bytes");
    const { main } = await loadDriver(dbPath);

    await expect(main(["stage"])).rejects.toThrow(/refusing to stage over existing path/);

    expect(readFileSync(dbPath, "utf8")).toBe("pre-existing user data");
    expect(readFileSync(`${dbPath}.pre-backfill`, "utf8")).toBe("existing snapshot bytes");
    expect(readFileSync(`${dbPath}-wal`, "utf8")).toBe("existing wal bytes");
  });

  it("refuses when only a sidecar exists, and when the path is a dangling symlink", async () => {
    const dir = freshDir();
    const sidecarOnly = join(dir, "sidecar-only.db");
    writeFileSync(`${sidecarOnly}-shm`, "orphaned shm");
    const { main } = await loadDriver(sidecarOnly);
    await expect(main(["stage"])).rejects.toThrow(/refusing to stage over existing path/);
    expect(existsSync(sidecarOnly)).toBe(false);
    expect(readFileSync(`${sidecarOnly}-shm`, "utf8")).toBe("orphaned shm");

    const symlinked = join(dir, "linked.db");
    symlinkSync(join(dir, "missing-target.db"), symlinked);
    const { main: mainForSymlink } = await loadDriver(symlinked);
    await expect(mainForSymlink(["stage"])).rejects.toThrow(/refusing to stage over existing path/);
    expect(lstatSync(symlinked).isSymbolicLink()).toBe(true);
  });

  it("stages a complete fresh legacy fixture on a clean path", async () => {
    const dir = freshDir();
    const dbPath = join(dir, "fresh-fixture.db");
    const { main } = await loadDriver(dbPath);

    await main(["stage"]);

    const db = new Database(dbPath, { readonly: true });
    try {
      const users = db.prepare(
        "SELECT COUNT(*) AS count FROM app_users",
      ).get() as { count: number };
      const leads = db.prepare(
        "SELECT COUNT(*) AS count FROM leads",
      ).get() as { count: number };
      expect(users.count).toBe(3);
      expect(leads.count).toBe(1);
    } finally {
      db.close();
    }
  });
});
