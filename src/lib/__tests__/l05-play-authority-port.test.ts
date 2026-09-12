import { describe, expect, it, vi } from "vitest";

import type { DbClient, DbStatement } from "@/lib/db";
import { createPostgresPlayAuthorityPort } from "@/lib/discovery/play-authority-port";

const TENANT = "10000000-0000-4000-8000-000000000001";
const WORKSPACE = "20000000-0000-4000-8000-000000000001";
const PLAY_VERSION = `lead-play-version:${"a".repeat(64)}`;
const STABLE_KEY = "play.discovery.standard";

type Handler = {
  get?: (params: unknown[]) => unknown;
  all?: (params: unknown[]) => unknown[];
  run?: (params: unknown[]) => { changes: number };
};

interface CapturedStatement extends DbStatement {
  query: string;
}

function fakeDb(handlers: Array<{ match: string | RegExp; handler: Handler }>): {
  db: DbClient;
  calls: Array<{ query: string; params: unknown[] }>;
} {
  const calls: Array<{ query: string; params: unknown[] }> = [];
  const db: DbClient = {
    prepare(query: string): CapturedStatement {
      const found = handlers.find((entry) =>
        typeof entry.match === "string" ? query.includes(entry.match) : entry.match.test(query));
      const record = { query, params: [] as unknown[] };
      calls.push(record);
      const wrap = (fn: (params: unknown[]) => unknown) =>
        async (...params: unknown[]) => {
          record.params = params;
          return fn(params);
        };
      return Object.assign({
        query,
        get: wrap(async () => found?.handler.get?.(record.params)),
        all: wrap(async () => found?.handler.all?.(record.params) ?? []),
        run: wrap(async () => found?.handler.run?.(record.params) ?? { changes: 1 }),
      }) as CapturedStatement;
    },
    exec: vi.fn(async () => undefined),
  };
  return { db, calls };
}

const ALL_TABLES: Handler = { get: () => ({ present: "public.x" }) };

function versionRow(overrides: Record<string, unknown> = {}): Handler {
  return {
    get: () => ({
      stable_key: STABLE_KEY,
      source: { proposalVersion: 1 },
      review: { reviewVersion: 1, status: "approved" },
      ...overrides,
    }),
  };
}

function activationRow(overrides: Record<string, unknown> = {}): Handler {
  return { get: () => ({ state: { stateVersion: 1, stableKey: STABLE_KEY }, ...overrides }) };
}

const SELECTOR = { tenantId: TENANT, workspaceId: WORKSPACE, playVersionId: PLAY_VERSION } as const;

describe("l05 postgres play authority port", () => {
  it("requires a database client", () => {
    expect(() => createPostgresPlayAuthorityPort(null as unknown as DbClient)).toThrow(TypeError);
    expect(() => createPostgresPlayAuthorityPort({} as DbClient)).toThrow(TypeError);
  });

  it("fails closed when an L-04 table is absent", async () => {
    const { db, calls } = fakeDb([
      { match: "to_regclass", handler: { get: (params) => (params[0] === "public.lead_play_versions" ? { present: "public.lead_play_versions" } : { present: null }) } },
    ]);
    const port = createPostgresPlayAuthorityPort(db);
    expect(await port.loadPlayAuthority(SELECTOR)).toBeNull();
    expect(calls.some((call) => call.query.includes("lead_play_versions") && !call.query.includes("to_regclass"))).toBe(false);
  });

  it("fails closed when the play version row is missing", async () => {
    const { db } = fakeDb([
      { match: "to_regclass", handler: ALL_TABLES },
      { match: "FROM public.lead_play_versions", handler: { get: () => undefined } },
    ]);
    const port = createPostgresPlayAuthorityPort(db);
    expect(await port.loadPlayAuthority(SELECTOR)).toBeNull();
  });

  it("fails closed when stored payloads are not documents", async () => {
    const { db } = fakeDb([
      { match: "to_regclass", handler: ALL_TABLES },
      { match: "FROM public.lead_play_versions", handler: versionRow({ source: "not-a-document" }) },
    ]);
    const port = createPostgresPlayAuthorityPort(db);
    expect(await port.loadPlayAuthority(SELECTOR)).toBeNull();
  });

  it("fails closed when the activation state row is missing", async () => {
    const { db } = fakeDb([
      { match: "to_regclass", handler: ALL_TABLES },
      { match: "FROM public.lead_play_versions", handler: versionRow() },
      { match: "FROM public.lead_play_activation_states", handler: { get: () => undefined } },
    ]);
    const port = createPostgresPlayAuthorityPort(db);
    expect(await port.loadPlayAuthority(SELECTOR)).toBeNull();
  });

  it("fails closed on storage errors", async () => {
    const { db } = fakeDb([
      { match: "to_regclass", handler: ALL_TABLES },
      { match: "FROM public.lead_play_versions", handler: { get: () => { throw new Error("boom"); } } },
    ]);
    const port = createPostgresPlayAuthorityPort(db);
    expect(await port.loadPlayAuthority(SELECTOR)).toBeNull();
  });

  it("loads activation, review, and source documents bound to the caller scope", async () => {
    const { db, calls } = fakeDb([
      { match: "to_regclass", handler: ALL_TABLES },
      { match: "FROM public.lead_play_versions", handler: versionRow() },
      { match: "FROM public.lead_play_activation_states", handler: activationRow() },
    ]);
    const port = createPostgresPlayAuthorityPort(db);
    const authority = await port.loadPlayAuthority(SELECTOR);
    expect(authority).toEqual({
      activationState: { stateVersion: 1, stableKey: STABLE_KEY },
      playReview: { reviewVersion: 1, status: "approved" },
      playSource: { proposalVersion: 1 },
    });

    const versionQuery = calls.find((call) => call.query.includes("FROM public.lead_play_versions"));
    expect(versionQuery?.params).toEqual([TENANT, WORKSPACE, PLAY_VERSION]);
    expect(versionQuery?.query).toContain("tenant_id = ?");
    expect(versionQuery?.query).toContain("version_id = ?");
    const activationQuery = calls.find((call) => call.query.includes("FROM public.lead_play_activation_states"));
    expect(activationQuery?.params).toEqual([TENANT, WORKSPACE, STABLE_KEY]);
    expect(activationQuery?.query).toContain("stable_key = ?");
  });

  it("scopes the activation lookup by the version row's stable_key, not a caller claim", async () => {
    const { db, calls } = fakeDb([
      { match: "to_regclass", handler: ALL_TABLES },
      { match: "FROM public.lead_play_versions", handler: versionRow({ stable_key: "play.other" }) },
      { match: "FROM public.lead_play_activation_states", handler: activationRow() },
    ]);
    const port = createPostgresPlayAuthorityPort(db);
    await port.loadPlayAuthority(SELECTOR);
    const activationQuery = calls.find((call) => call.query.includes("FROM public.lead_play_activation_states"));
    expect(activationQuery?.params).toEqual([TENANT, WORKSPACE, "play.other"]);
  });
});
