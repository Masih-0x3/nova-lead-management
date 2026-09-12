import { describe, expect, it, vi } from "vitest";

import type { ReviewQueue } from "@/lib/review/review-queue";
import type {
  ReviewItemRow,
  ReviewQueueRow,
  ReviewRepository,
} from "@/lib/review/repository";
import {
  enqueueItem,
  getOrCreateQueue,
  listReviewItemViews,
  summarizeReviewQueue,
  transitionItem,
} from "@/lib/review/service";

const TENANT = "10000000-0000-4000-8000-000000000001";
const WORKSPACE = "20000000-0000-4000-8000-000000000001";
const HUMAN = "30000000-0000-4000-8000-000000000001";
const HASH_A = `sha256:${"a".repeat(64)}`;

function queueRow(queue: ReviewQueue): ReviewQueueRow {
  return Object.freeze({
    queueId: queue.queueId,
    tenantId: queue.tenantId,
    workspaceId: queue.workspaceId,
    queueSha256: queue.queueHash.slice("sha256:".length),
    payload: queue as unknown as Record<string, unknown>,
    createdAt: queue.createdAt,
    updatedAt: queue.createdAt,
  });
}

function itemRow(queue: ReviewQueue, item: ReviewQueue["items"][number]): ReviewItemRow {
  return Object.freeze({
    itemId: item.itemId,
    queueId: queue.queueId,
    tenantId: queue.tenantId,
    workspaceId: queue.workspaceId,
    kind: item.kind,
    subject: item.subject as unknown as Record<string, unknown>,
    priority: item.priority,
    reason: item.reason,
    uncertaintyIds: Object.freeze([...item.uncertaintyIds]),
    status: item.status,
    claimedBy: item.claimedBy,
    leaseExpiresAt: item.leaseExpiresAt,
    resolution: item.resolution as Record<string, unknown> | null,
    enqueuedAt: item.enqueuedAt,
    updatedAt: item.enqueuedAt,
  });
}

interface FakeStore {
  repository: ReviewRepository;
  queues: Map<string, ReviewQueueRow>;
  items: Map<string, ReviewItemRow>;
  events: unknown[];
}

function fakeStore(): FakeStore {
  const queues = new Map<string, ReviewQueueRow>();
  const items = new Map<string, ReviewItemRow>();
  const events: unknown[] = [];
  const queueKey = (tenantId: string, workspaceId: string) => `${tenantId}/${workspaceId}`;
  return {
    queues, items, events,
    repository: {
      insertQueue: vi.fn(async (queue) => {
        const row = queueRow(queue as unknown as ReviewQueue);
        if (queues.has(queueKey(row.tenantId, row.workspaceId))) return "replayed";
        queues.set(queueKey(row.tenantId, row.workspaceId), row);
        return "created";
      }),
      getQueue: vi.fn(async (tenantId, workspaceId) =>
        queues.get(queueKey(tenantId, workspaceId)) ?? null),
      updateQueue: vi.fn(async (expectedQueueSha256, queue) => {
        const record = queue as unknown as ReviewQueue;
        const key = queueKey(record.tenantId, record.workspaceId);
        const current = queues.get(key);
        if (!current || current.queueSha256 !== expectedQueueSha256) {
          throw new Error("stale queue hash");
        }
        queues.set(key, queueRow(record));
      }),
      insertItem: vi.fn(async (scope, item) => {
        const record = item as unknown as ReviewQueue["items"][number];
        const queue = queues.get(queueKey(scope.tenantId, scope.workspaceId));
        if (!queue || queue.queueId !== scope.queueId) throw new Error("scope mismatch");
        items.set(record.itemId, itemRow(queue.payload as unknown as ReviewQueue, record));
      }),
      updateItem: vi.fn(async (queueId, item) => {
        const record = item as unknown as ReviewQueue["items"][number];
        const existing = items.get(record.itemId);
        if (!existing || existing.queueId !== queueId) throw new Error("item not found");
        items.set(record.itemId, Object.freeze({
          ...existing,
          status: record.status,
          claimedBy: record.claimedBy,
          leaseExpiresAt: record.leaseExpiresAt,
          resolution: record.resolution as Record<string, unknown> | null,
          updatedAt: record.enqueuedAt,
        }));
      }),
      insertEvent: vi.fn(async (scope, event) => {
        events.push({ scope, event });
      }),
      listItems: vi.fn(async (tenantId, workspaceId) =>
        [...items.values()].filter((item) =>
          item.tenantId === tenantId && item.workspaceId === workspaceId)),
      listEvents: vi.fn(async () => []),
    },
  };
}

function enqueueInput(overrides: Record<string, unknown> = {}) {
  return {
    tenantId: TENANT,
    workspaceId: WORKSPACE,
    kind: "qualification_review",
    subject: {
      subjectId: "account-qualification:synthetic",
      versionId: "account-qualification-version:synthetic-v1",
      contentHash: HASH_A,
    },
    priority: "high",
    reason: "The automated decision needs a human review.",
    uncertaintyIds: ["uncertainty:low-confidence"],
    at: "2026-08-30T12:01:00.000Z",
    ...overrides,
  };
}

describe("l05 review queue service", () => {
  it("creates the durable queue on first use and reuses it after", async () => {
    const store = fakeStore();
    const deps = { repository: store.repository, clock: () => new Date("2026-08-30T12:00:00.000Z") };
    const first = await getOrCreateQueue(deps, { tenantId: TENANT, workspaceId: WORKSPACE });
    expect(first.created).toBe(true);
    expect(first.queue.queueId).toMatch(/^review-queue:[0-9a-f]{64}$/u);
    const second = await getOrCreateQueue(deps, { tenantId: TENANT, workspaceId: WORKSPACE });
    expect(second.created).toBe(false);
    expect(second.queue.queueId).toBe(first.queue.queueId);
    expect(store.repository.insertQueue).toHaveBeenCalledTimes(1);
  });

  it("enqueues an item with an event and replays an identical enqueue", async () => {
    const store = fakeStore();
    const deps = { repository: store.repository, clock: () => new Date("2026-08-30T12:00:00.000Z") };
    const first = await enqueueItem(deps, enqueueInput());
    expect(first.replayed).toBe(false);
    expect(first.itemId).toMatch(/^review-item:[0-9a-f]{64}$/u);
    expect(store.items.size).toBe(1);
    expect(store.events).toHaveLength(1);

    const replay = await enqueueItem(deps, enqueueInput());
    expect(replay.replayed).toBe(true);
    expect(replay.itemId).toBe(first.itemId);
    expect(store.items.size).toBe(1);
    expect(store.events).toHaveLength(1);
  });

  it("claims, releases, and resolves an item with lease + event persistence", async () => {
    const store = fakeStore();
    const deps = { repository: store.repository, clock: () => new Date("2026-08-30T12:00:00.000Z") };
    const { itemId } = await enqueueItem(deps, enqueueInput());

    const claimed = await transitionItem(deps, {
      tenantId: TENANT, workspaceId: WORKSPACE, itemId, action: "claim",
      actorId: HUMAN, at: "2026-08-30T12:02:00.000Z",
      reason: "Claim the item for human review.",
      leaseExpiresAt: "2026-08-30T13:02:00.000Z",
    });
    expect(claimed.itemId).toBe(itemId);
    expect(store.items.get(itemId)?.status).toBe("claimed");
    expect(store.items.get(itemId)?.claimedBy).toBe(HUMAN);

    await transitionItem(deps, {
      tenantId: TENANT, workspaceId: WORKSPACE, itemId, action: "release",
      actorId: HUMAN, at: "2026-08-30T12:30:00.000Z",
      reason: "Release the item back to the queue.",
    });
    expect(store.items.get(itemId)?.status).toBe("queued");

    await transitionItem(deps, {
      tenantId: TENANT, workspaceId: WORKSPACE, itemId, action: "claim",
      actorId: HUMAN, at: "2026-08-30T12:31:00.000Z",
      reason: "Reclaim the released item.",
      leaseExpiresAt: "2026-08-30T13:31:00.000Z",
    });
    await transitionItem(deps, {
      tenantId: TENANT, workspaceId: WORKSPACE, itemId, action: "resolve",
      actorId: HUMAN, at: "2026-08-30T12:45:00.000Z",
      reason: "Resolve after reviewing the cited evidence.",
      resolution: { decision: "confirmed", note: "Confirmed the qualification decision." },
    });
    expect(store.items.get(itemId)?.status).toBe("resolved");
    expect(store.items.get(itemId)?.resolution).toMatchObject({ decision: "confirmed" });
    expect(store.events).toHaveLength(5);
  });

  it("maps a concurrent queue update to REVIEW_STALE", async () => {
    const store = fakeStore();
    const { repository } = store;
    const clock = () => new Date("2026-08-30T12:00:00.000Z");
    const seeded = await enqueueItem({ repository, clock }, enqueueInput());
    repository.updateQueue = vi.fn(async () => {
      throw new Error("hash moved");
    });
    await expect(transitionItem({ repository, clock }, {
      tenantId: TENANT, workspaceId: WORKSPACE, itemId: seeded.itemId, action: "claim",
      actorId: HUMAN, at: "2026-08-30T12:02:00.000Z",
      reason: "Claim while another writer holds the queue.",
      leaseExpiresAt: "2026-08-30T13:02:00.000Z",
    })).rejects.toMatchObject({ code: "REVIEW_STALE" });
  });

  it("rejects malformed input and unknown kinds before persistence", async () => {
    const store = fakeStore();
    const deps = { repository: store.repository, clock: () => new Date("2026-08-30T12:00:00.000Z") };
    await expect(enqueueItem(deps, enqueueInput({ kind: "nonsense" })))
      .rejects.toMatchObject({ code: "REVIEW_INPUT_INVALID" });
    await expect(enqueueItem(deps, { tenantId: "bad" }))
      .rejects.toMatchObject({ code: "REVIEW_INPUT_INVALID" });
    expect(store.repository.insertQueue).not.toHaveBeenCalled();
  });

  it("projects queue summaries and item views for the UI lane", async () => {
    const store = fakeStore();
    const deps = { repository: store.repository, clock: () => new Date("2026-08-30T12:00:00.000Z") };
    const { itemId } = await enqueueItem(deps, enqueueInput());
    const summary = await summarizeReviewQueue(store.repository,
      { tenantId: TENANT, workspaceId: WORKSPACE });
    expect(summary.queued).toBe(1);
    expect(summary.byKind).toEqual({ qualification_review: 1 });
    expect(summary.queueId).toMatch(/^review-queue:/u);

    const views = await listReviewItemViews(store.repository,
      { tenantId: TENANT, workspaceId: WORKSPACE });
    expect(views).toHaveLength(1);
    expect(views[0]).toMatchObject({
      itemId, kind: "qualification_review", status: "queued", leaseActive: false,
    });
  });
});
