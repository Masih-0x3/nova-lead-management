import { isProxy } from "node:util/types";

import type { ReviewRepository, ReviewItemRow } from "./repository";
import {
  createReviewQueue,
  enqueueReviewQueueItem,
  transitionReviewQueueItem,
  type ReviewQueue,
} from "./review-queue";

export type ReviewServiceErrorCode =
  | "REVIEW_INPUT_INVALID"
  | "REVIEW_NOT_FOUND"
  | "REVIEW_STALE"
  | "REVIEW_CONFLICT";

export class ReviewServiceError extends Error {
  readonly code: ReviewServiceErrorCode;

  constructor(code: ReviewServiceErrorCode, message: string) {
    super(message);
    this.name = "ReviewServiceError";
    this.code = code;
  }
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const ITEM_ID = /^review-item:[0-9a-f]{64}$/u;
const CANONICAL_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u;
const KINDS = new Set(["ambiguous_account_resolution", "qualification_review", "buying_center_review"]);
const PRIORITIES = new Set(["low", "normal", "high", "urgent"]);

type PlainRecord = Record<string, unknown>;

function isPlainRecord(value: unknown): value is PlainRecord {
  if (!value || typeof value !== "object" || Array.isArray(value) || isProxy(value)) return false;
  try {
    const prototype = Object.getPrototypeOf(value);
    return prototype === Object.prototype || prototype === null;
  } catch {
    return false;
  }
}

function invalid(message: string): ReviewServiceError {
  return new ReviewServiceError("REVIEW_INPUT_INVALID", message);
}

function uuid(value: unknown, field: string): string {
  if (typeof value !== "string" || !UUID.test(value)) throw invalid(`${field} must be a UUID`);
  return value;
}

function nowIso(clock: (() => Date) | undefined): string {
  const observed = clock ? clock() : new Date();
  if (!(observed instanceof Date) || !Number.isFinite(observed.getTime())) {
    throw invalid("A valid clock is required");
  }
  return observed.toISOString();
}

function engineFailure(code: string): ReviewServiceError {
  if (code === "STALE_QUEUE" || code === "NOT_FOUND_OR_STALE") {
    return new ReviewServiceError("REVIEW_STALE", `The review queue is stale (${code}).`);
  }
  return new ReviewServiceError("REVIEW_CONFLICT", `The review operation was rejected (${code}).`);
}

export interface ReviewServiceDeps {
  readonly repository: ReviewRepository;
  readonly clock?: () => Date;
}

/** Returns the durable queue for a scope, creating it on first use. */
export async function getOrCreateQueue(
  deps: ReviewServiceDeps,
  scope: Readonly<{ tenantId: string; workspaceId: string }>,
): Promise<Readonly<{ queue: ReviewQueue; queueSha256: string; created: boolean }>> {
  const tenantId = uuid(scope.tenantId, "tenantId");
  const workspaceId = uuid(scope.workspaceId, "workspaceId");
  const existing = await deps.repository.getQueue(tenantId, workspaceId);
  if (existing) {
    return Object.freeze({
      queue: existing.payload as unknown as ReviewQueue,
      queueSha256: existing.queueSha256,
      created: false,
    });
  }
  const created = createReviewQueue({
    version: 1, tenantId, workspaceId, createdAt: nowIso(deps.clock),
  });
  if (!created.ok) throw engineFailure(created.code);
  const queue = created.queue;
  const persisted = await deps.repository.insertQueue(queue);
  if (persisted === "replayed") {
    const raced = await deps.repository.getQueue(tenantId, workspaceId);
    if (!raced) throw new ReviewServiceError("REVIEW_CONFLICT", "The review queue could not be loaded.");
    return Object.freeze({
      queue: raced.payload as unknown as ReviewQueue, queueSha256: raced.queueSha256, created: false,
    });
  }
  return Object.freeze({
    queue, queueSha256: queue.queueHash.slice("sha256:".length), created: true,
  });
}

export type EnqueueItemInput = Readonly<{
  tenantId: string;
  workspaceId: string;
  kind: "ambiguous_account_resolution" | "qualification_review" | "buying_center_review";
  subject: Readonly<{ subjectId: string; versionId: string; contentHash: string }>;
  priority: "low" | "normal" | "high" | "urgent";
  reason: string;
  uncertaintyIds?: readonly string[];
  at?: string;
}>;

/**
 * Enqueues a review item. Replay of an identical subject returns the current
 * queue unchanged (REVIEW_ITEM_REPLAYED); a divergent duplicate fails.
 */
export async function enqueueItem(
  deps: ReviewServiceDeps,
  rawInput: unknown,
): Promise<Readonly<{ queue: ReviewQueue; itemId: string; replayed: boolean }>> {
  if (!isPlainRecord(rawInput)) throw invalid("Expected a plain object");
  const tenantId = uuid(rawInput.tenantId, "tenantId");
  const workspaceId = uuid(rawInput.workspaceId, "workspaceId");
  const kind = typeof rawInput.kind === "string" && KINDS.has(rawInput.kind) ? rawInput.kind
    : (() => { throw invalid("kind is malformed"); })();
  const priority = typeof rawInput.priority === "string" && PRIORITIES.has(rawInput.priority)
    ? rawInput.priority : (() => { throw invalid("priority is malformed"); })();
  const at = rawInput.at === undefined ? nowIso(deps.clock)
    : typeof rawInput.at === "string" ? rawInput.at
      : (() => { throw invalid("at is malformed"); })();

  // A first event can be stamped by its producer before this lazy queue is
  // persisted (or in the same millisecond). Anchor a new empty log before
  // that event, preserving the event timestamp and the engine's strict
  // chronology. Existing queues retain their original creation/history.
  // `at` must satisfy the engine's canonical timestamp contract, not just
  // Date.parse's wider grammar — reject malformed events before creating any
  // persistent state, even if the engine would reject them later as well.
  const firstEventTime = Date.parse(at);
  if (!CANONICAL_TIMESTAMP.test(at)
    || !Number.isFinite(firstEventTime)
    || new Date(firstEventTime).toISOString() !== at) {
    throw invalid("at is malformed");
  }
  const { queue, queueSha256 } = await getOrCreateQueue({
    ...deps,
    clock: () => new Date(Math.min(Date.parse(nowIso(deps.clock)), firstEventTime - 1)),
  }, { tenantId, workspaceId });
  const enqueued = enqueueReviewQueueItem({
    version: 1, tenantId, workspaceId,
    current: queue,
    expectedQueueHash: queue.queueHash,
    item: {
      itemVersion: 1, kind, subject: rawInput.subject, priority,
      reason: rawInput.reason, uncertaintyIds: rawInput.uncertaintyIds ?? [],
    },
    at,
  });
  if (!enqueued.ok) throw engineFailure(enqueued.code);
  const next = enqueued.queue;
  const newEvent = next.events[next.events.length - 1];
  const newItem = next.items.find((item) => newEvent && item.itemId === newEvent.itemId);
  if (enqueued.code === "REVIEW_ITEM_REPLAYED" || !newEvent || !newItem) {
    const existingItem = next.items.find((item) =>
      isPlainRecord(item.subject) && isPlainRecord(rawInput.subject)
        && item.subject.subjectId === (rawInput.subject as PlainRecord).subjectId);
    return Object.freeze({
      queue: next,
      itemId: existingItem?.itemId ?? "",
      replayed: enqueued.code === "REVIEW_ITEM_REPLAYED",
    });
  }
  try {
    await deps.repository.updateQueue(queueSha256, next, at);
    await deps.repository.insertItem(
      { queueId: next.queueId, tenantId, workspaceId }, newItem);
    await deps.repository.insertEvent(
      { queueId: next.queueId, tenantId, workspaceId }, newEvent);
  } catch {
    throw new ReviewServiceError("REVIEW_STALE", "The review queue changed concurrently.");
  }
  return Object.freeze({ queue: next, itemId: newItem.itemId, replayed: false });
}

export type QueueTransitionInput = Readonly<{
  tenantId: string;
  workspaceId: string;
  itemId: string;
  action: "claim" | "release" | "resolve";
  actorId: string;
  at?: string;
  reason: string;
  leaseExpiresAt?: string;
  resolution?: Readonly<{ decision: "confirmed" | "dismissed" | "changes_requested"; note: string }>;
}>;

/** Applies a claim/release/resolve transition under optimistic concurrency. */
export async function transitionItem(
  deps: ReviewServiceDeps,
  rawInput: unknown,
): Promise<Readonly<{ queue: ReviewQueue; itemId: string }>> {
  if (!isPlainRecord(rawInput)) throw invalid("Expected a plain object");
  const tenantId = uuid(rawInput.tenantId, "tenantId");
  const workspaceId = uuid(rawInput.workspaceId, "workspaceId");
  const actorId = uuid(rawInput.actorId, "actorId");
  const itemId = typeof rawInput.itemId === "string" && ITEM_ID.test(rawInput.itemId)
    ? rawInput.itemId : (() => { throw invalid("itemId is malformed"); })();
  const action = rawInput.action === "claim" || rawInput.action === "release"
    || rawInput.action === "resolve" ? rawInput.action : (() => { throw invalid("action is malformed"); })();
  const at = rawInput.at === undefined ? nowIso(deps.clock)
    : typeof rawInput.at === "string" ? rawInput.at
      : (() => { throw invalid("at is malformed"); })();

  // A transition can never apply to a queue that does not exist — a fresh
  // queue has no items — so look up rather than lazily create: persisting an
  // empty queue here would anchor it at the service clock and reject every
  // earlier producer-stamped first event as INVALID_CHRONOLOGY forever.
  const stored = await deps.repository.getQueue(tenantId, workspaceId);
  if (!stored) throw engineFailure("NOT_FOUND_OR_STALE");
  const queue = stored.payload as unknown as ReviewQueue;
  const queueSha256 = stored.queueSha256;
  const transitioned = transitionReviewQueueItem({
    version: 1, tenantId, workspaceId,
    current: queue,
    expectedQueueHash: queue.queueHash,
    itemId, action,
    actor: { kind: "human", actorId },
    at, reason: rawInput.reason,
    leaseExpiresAt: rawInput.leaseExpiresAt ?? null,
    resolution: rawInput.resolution ?? null,
  });
  if (!transitioned.ok) throw engineFailure(transitioned.code);
  const next = transitioned.queue;
  const newEvent = next.events[next.events.length - 1];
  const nextItem = next.items.find((item) => item.itemId === itemId);
  if (!newEvent || !nextItem) {
    throw new ReviewServiceError("REVIEW_CONFLICT", "The transition produced no event or item.");
  }
  try {
    await deps.repository.updateQueue(queueSha256, next, at);
    await deps.repository.updateItem(next.queueId, nextItem);
    await deps.repository.insertEvent(
      { queueId: next.queueId, tenantId, workspaceId }, newEvent);
  } catch {
    throw new ReviewServiceError("REVIEW_STALE", "The review queue changed concurrently.");
  }
  return Object.freeze({ queue: next, itemId });
}

/* ---------- query projections ---------- */

export type ReviewItemView = Readonly<{
  itemId: string;
  kind: string;
  subjectId: string;
  subjectVersionId: string;
  priority: string;
  status: ReviewItemRow["status"];
  claimedBy: string | null;
  leaseExpiresAt: string | null;
  leaseActive: boolean;
  reason: string;
  uncertaintyIds: readonly string[];
  resolution: Record<string, unknown> | null;
  enqueuedAt: string;
  updatedAt: string;
}>;

export async function listReviewItemViews(
  repository: ReviewRepository,
  scope: Readonly<{ tenantId: string; workspaceId: string }>,
  filter: Readonly<{ kind?: string; status?: string; now?: string }> = {},
): Promise<readonly ReviewItemView[]> {
  const tenantId = uuid(scope.tenantId, "tenantId");
  const workspaceId = uuid(scope.workspaceId, "workspaceId");
  const rows = await repository.listItems(tenantId, workspaceId, {
    kind: filter.kind, status: filter.status,
  });
  const now = filter.now ?? nowIso(undefined);
  return Object.freeze(rows.map((row): ReviewItemView => Object.freeze({
    itemId: row.itemId,
    kind: row.kind,
    subjectId: typeof row.subject.subjectId === "string" ? row.subject.subjectId : "",
    subjectVersionId: typeof row.subject.versionId === "string" ? row.subject.versionId : "",
    priority: row.priority,
    status: row.status,
    claimedBy: row.claimedBy,
    leaseExpiresAt: row.leaseExpiresAt,
    leaseActive: row.status === "claimed" && row.leaseExpiresAt !== null
      && Date.parse(row.leaseExpiresAt) > Date.parse(now),
    reason: row.reason,
    uncertaintyIds: Object.freeze(row.uncertaintyIds.filter(
      (item): item is string => typeof item === "string")),
    resolution: row.resolution,
    enqueuedAt: row.enqueuedAt,
    updatedAt: row.updatedAt,
  })));
}

export type ReviewQueueSummary = Readonly<{
  queueId: string | null;
  queued: number;
  claimed: number;
  resolved: number;
  byKind: Readonly<Record<string, number>>;
  oldestQueuedAt: string | null;
}>;

export async function summarizeReviewQueue(
  repository: ReviewRepository,
  scope: Readonly<{ tenantId: string; workspaceId: string }>,
): Promise<ReviewQueueSummary> {
  const tenantId = uuid(scope.tenantId, "tenantId");
  const workspaceId = uuid(scope.workspaceId, "workspaceId");
  const queue = await repository.getQueue(tenantId, workspaceId);
  const items = await repository.listItems(tenantId, workspaceId);
  const byKind: Record<string, number> = {};
  let queued = 0;
  let claimed = 0;
  let resolved = 0;
  let oldestQueuedAt: string | null = null;
  for (const item of items) {
    byKind[item.kind] = (byKind[item.kind] ?? 0) + 1;
    if (item.status === "queued") {
      queued += 1;
      if (oldestQueuedAt === null || Date.parse(item.enqueuedAt) < Date.parse(oldestQueuedAt)) {
        oldestQueuedAt = item.enqueuedAt;
      }
    } else if (item.status === "claimed") claimed += 1;
    else resolved += 1;
  }
  return Object.freeze({
    queueId: queue?.queueId ?? null,
    queued, claimed, resolved,
    byKind: Object.freeze(byKind),
    oldestQueuedAt,
  });
}
