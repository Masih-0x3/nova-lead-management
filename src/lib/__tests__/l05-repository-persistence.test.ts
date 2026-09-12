import { describe, expect, it, vi } from "vitest";

import type { DbClient, DbStatement } from "@/lib/db";
import {
  ContactPersistenceError,
  createPostgresContactRepository,
} from "@/lib/contacts/repository";
import {
  createPostgresReviewRepository,
  ReviewPersistenceError,
} from "@/lib/review/repository";
import {
  createPostgresQualificationRepository,
  QualificationPersistenceError,
} from "@/lib/qualification/repository";
import {
  createPostgresDiscoveryRepository,
  DiscoveryPersistenceError,
} from "@/lib/discovery/repository";

const TENANT = "10000000-0000-4000-8000-000000000001";
const WORKSPACE = "20000000-0000-4000-8000-000000000001";
const ACCOUNT = "30000000-0000-4000-8000-000000000001";

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

const contactRecord = {
  versionId: `contact-version:${"a".repeat(64)}`,
  tenantId: TENANT,
  workspaceId: WORKSPACE,
  accountId: ACCOUNT,
  stableKey: "contact:synthetic",
  revision: 1,
  supersedesVersionId: null,
  review: { status: "draft", reviewHash: `sha256:${"b".repeat(64)}` },
  suppressionDisposition: "clear",
  freshness: { state: "KNOWN" },
  identity: { contactPointClass: "named_business_email" },
  sourceReceipt: { connectorKey: "customer-list" },
  contentHash: `sha256:${"c".repeat(64)}`,
  versionHash: `sha256:${"d".repeat(64)}`,
  createdAt: "2026-08-30T13:00:00.000Z",
};

describe("l05 repository persistence", () => {
  it("scopes every contact read by tenant + workspace", async () => {
    const { db, calls } = fakeDb([]);
    const repository = createPostgresContactRepository(db);
    await repository.listContacts(TENANT, WORKSPACE);
    await repository.getContact(TENANT, WORKSPACE, contactRecord.versionId);
    await repository.listAccountContacts(TENANT, WORKSPACE, ACCOUNT);
    for (const call of calls) {
      expect(call.params.slice(0, 2)).toEqual([TENANT, WORKSPACE]);
      expect(call.query).toContain("tenant_id = ?");
      expect(call.query).toContain("workspace_id = ?");
    }
  });

  it("returns created/replayed for idempotent contact inserts", async () => {
    const { db } = fakeDb([{
      match: "INSERT INTO public.contact_record_versions",
      handler: { all: () => [{ version_id: contactRecord.versionId }] },
    }]);
    const repository = createPostgresContactRepository(db);
    await expect(repository.insertContact(contactRecord)).resolves.toBe("created");
  });

  it("fails closed when a contact row is malformed", async () => {
    const { db } = fakeDb([{
      match: "FROM public.contact_record_versions",
      handler: { get: () => ({ version_id: "contact-version:not-a-hash" }) },
    }]);
    const repository = createPostgresContactRepository(db);
    await expect(repository.getContact(TENANT, WORKSPACE, contactRecord.versionId))
      .rejects.toBeInstanceOf(ContactPersistenceError);
  });

  it("detects a stale contact review update via zero-row conditional write", async () => {
    const { db, calls } = fakeDb([{
      match: "UPDATE public.contact_record_versions",
      handler: { run: () => ({ changes: 0 }) },
    }]);
    const repository = createPostgresContactRepository(db);
    await expect(repository.updateContactReview(`sha256:${"b".repeat(64)}`, contactRecord))
      .rejects.toBeInstanceOf(ContactPersistenceError);
    const update = calls.find((call) => call.query.includes("UPDATE"));
    // The expected prior review hash is bound as the final predicate parameter.
    expect(update?.params.at(-1)).toBe("b".repeat(64));
  });

  it("scopes review-queue reads and preserves filter clauses", async () => {
    const { db, calls } = fakeDb([]);
    const repository = createPostgresReviewRepository(db);
    await repository.listItems(TENANT, WORKSPACE, { kind: "qualification_review", status: "queued" });
    const list = calls.at(-1);
    expect(list?.params).toEqual([TENANT, WORKSPACE, "qualification_review", "queued"]);
    expect(list?.query).toContain("kind = ?");
    expect(list?.query).toContain("status = ?");
  });

  it("detects a stale review queue document update", async () => {
    const { db } = fakeDb([{
      match: "UPDATE public.review_queue_documents",
      handler: { run: () => ({ changes: 0 }) },
    }]);
    const repository = createPostgresReviewRepository(db);
    await expect(repository.updateQueue("f".repeat(64), {
      queueId: `review-queue:${"a".repeat(64)}`,
      tenantId: TENANT, workspaceId: WORKSPACE,
      queueHash: `sha256:${"c".repeat(64)}`,
      createdAt: "2026-08-30T12:00:00.000Z",
    }, "2026-08-30T12:05:00.000Z")).rejects.toBeInstanceOf(ReviewPersistenceError);
  });

  it("rejects malformed review item rows", async () => {
    const { db } = fakeDb([{
      match: "FROM public.review_queue_items",
      handler: { all: () => [{ item_id: "review-item:garbage", status: "bogus" }] },
    }]);
    const repository = createPostgresReviewRepository(db);
    await expect(repository.listItems(TENANT, WORKSPACE))
      .rejects.toBeInstanceOf(ReviewPersistenceError);
  });

  it("fails closed when a qualification row fails to parse", async () => {
    const { db } = fakeDb([{
      match: "FROM public.account_qualification_snapshots",
      handler: { get: () => ({ version_id: "account-qualification:xyz" }) },
    }]);
    const repository = createPostgresQualificationRepository(db);
    await expect(repository.getQualification(TENANT, WORKSPACE, ACCOUNT,
      `account-qualification:${"a".repeat(64)}`))
      .rejects.toBeInstanceOf(QualificationPersistenceError);
  });

  it("detects a stale discovery run update", async () => {
    const { db } = fakeDb([{
      match: "UPDATE public.discovery_runs",
      handler: { run: () => ({ changes: 0 }) },
    }]);
    const repository = createPostgresDiscoveryRepository(db);
    const run = {
      runId: `discovery-run:${"a".repeat(64)}`,
      tenantId: TENANT,
      workspaceId: WORKSPACE,
      plan: {
        planId: `discovery-plan:${"b".repeat(64)}`,
        tenantId: TENANT, workspaceId: WORKSPACE,
      },
      status: "running",
      runHash: `sha256:${"c".repeat(64)}`,
      createdAt: "2026-08-30T17:00:00.000Z",
      updatedAt: "2026-08-30T17:01:00.000Z",
    };
    await expect(repository.updateRun(`sha256:${"c".repeat(64)}`, run))
      .rejects.toBeInstanceOf(DiscoveryPersistenceError);
  });
});
