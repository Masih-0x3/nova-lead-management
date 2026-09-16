import { isProxy } from "node:util/types";

import type { DbClient } from "@/lib/db";

export class ReviewPersistenceError extends Error {
  readonly code = "REVIEW_PERSISTENCE" as const;

  constructor() {
    super("The review queue state could not be loaded or persisted safely.");
    this.name = "ReviewPersistenceError";
  }
}

function fail(): never {
  throw new ReviewPersistenceError();
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const SHA256 = /^[0-9a-f]{64}$/u;
const QUEUE_ID = /^review-queue:[0-9a-f]{64}$/u;
const ITEM_ID = /^review-item:[0-9a-f]{64}$/u;
const KINDS = new Set(["ambiguous_account_resolution", "qualification_review", "buying_center_review"]);
const STATUSES = new Set(["queued", "claimed", "resolved"]);
const PRIORITIES = new Set(["low", "normal", "high", "urgent"]);
const ACTIONS = new Set(["enqueue", "claim", "release", "resolve"]);

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value) || isProxy(value)) return false;
  try {
    const prototype = Object.getPrototypeOf(value);
    return prototype === Object.prototype || prototype === null;
  } catch {
    return false;
  }
}

function requiredRow(value: unknown): Record<string, unknown> {
  if (!isPlainRecord(value)) fail();
  return value;
}

function uuid(value: unknown): string {
  if (typeof value !== "string" || !UUID.test(value)) fail();
  return value;
}

function sha(value: unknown): string {
  if (typeof value !== "string" || !SHA256.test(value)) fail();
  return value;
}

function intValue(value: unknown): number {
  const normalized = typeof value === "string" && /^[0-9]+$/u.test(value) ? Number(value) : value;
  if (typeof normalized !== "number" || !Number.isSafeInteger(normalized) || normalized < 0) fail();
  return normalized;
}

function timestamp(value: unknown): string {
  if (value instanceof Date) {
    if (Number.isFinite(value.getTime())) return value.toISOString();
    fail();
  }
  if (typeof value !== "string") fail();
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) fail();
  return new Date(parsed).toISOString();
}

function nullableTimestamp(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  return timestamp(value);
}

function jsonText(value: unknown): string {
  try {
    const serialized = JSON.stringify(value);
    if (typeof serialized !== "string") fail();
    return serialized;
  } catch {
    fail();
  }
}

export type ReviewQueueRow = Readonly<{
  queueId: string;
  tenantId: string;
  workspaceId: string;
  queueSha256: string;
  payload: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}>;

export type ReviewItemRow = Readonly<{
  itemId: string;
  queueId: string;
  tenantId: string;
  workspaceId: string;
  kind: string;
  subject: Record<string, unknown>;
  priority: string;
  reason: string;
  uncertaintyIds: readonly unknown[];
  status: "queued" | "claimed" | "resolved";
  claimedBy: string | null;
  leaseExpiresAt: string | null;
  resolution: Record<string, unknown> | null;
  enqueuedAt: string;
  updatedAt: string;
}>;

export type ReviewEventRow = Readonly<{
  queueId: string;
  sequence: number;
  tenantId: string;
  workspaceId: string;
  itemId: string;
  action: "enqueue" | "claim" | "release" | "resolve";
  actorId: string | null;
  at: string;
  reason: string;
  payload: Record<string, unknown>;
}>;

function parseQueueRow(value: unknown): ReviewQueueRow {
  const r = requiredRow(value);
  if (!isPlainRecord(r.payload)) fail();
  return Object.freeze({
    queueId: typeof r.queue_id === "string" && QUEUE_ID.test(r.queue_id) ? r.queue_id : fail(),
    tenantId: uuid(r.tenant_id),
    workspaceId: uuid(r.workspace_id),
    queueSha256: sha(r.queue_sha256),
    payload: r.payload,
    createdAt: timestamp(r.created_at),
    updatedAt: timestamp(r.updated_at),
  });
}

function parseItemRow(value: unknown): ReviewItemRow {
  const r = requiredRow(value);
  const status = r.status;
  if (typeof status !== "string" || !STATUSES.has(status)) fail();
  if (typeof r.kind !== "string" || !KINDS.has(r.kind)) fail();
  if (typeof r.priority !== "string" || !PRIORITIES.has(r.priority)) fail();
  if (!isPlainRecord(r.subject)) fail();
  if (!Array.isArray(r.uncertainty_ids)) fail();
  if (r.resolution !== null && !isPlainRecord(r.resolution)) fail();
  return Object.freeze({
    itemId: typeof r.item_id === "string" && ITEM_ID.test(r.item_id) ? r.item_id : fail(),
    queueId: typeof r.queue_id === "string" && QUEUE_ID.test(r.queue_id) ? r.queue_id : fail(),
    tenantId: uuid(r.tenant_id),
    workspaceId: uuid(r.workspace_id),
    kind: r.kind,
    subject: r.subject,
    priority: r.priority,
    reason: typeof r.reason === "string" ? r.reason : fail(),
    uncertaintyIds: Object.freeze([...r.uncertainty_ids]),
    status: status as ReviewItemRow["status"],
    claimedBy: r.claimed_by === null ? null : uuid(r.claimed_by),
    leaseExpiresAt: nullableTimestamp(r.lease_expires_at),
    resolution: r.resolution === null ? null : r.resolution,
    enqueuedAt: timestamp(r.enqueued_at),
    updatedAt: timestamp(r.updated_at),
  });
}

function parseEventRow(value: unknown): ReviewEventRow {
  const r = requiredRow(value);
  const action = r.action;
  if (typeof action !== "string" || !ACTIONS.has(action)) fail();
  if (!isPlainRecord(r.payload)) fail();
  return Object.freeze({
    queueId: typeof r.queue_id === "string" && QUEUE_ID.test(r.queue_id) ? r.queue_id : fail(),
    sequence: intValue(r.sequence),
    tenantId: uuid(r.tenant_id),
    workspaceId: uuid(r.workspace_id),
    itemId: typeof r.item_id === "string" && ITEM_ID.test(r.item_id) ? r.item_id : fail(),
    action: action as ReviewEventRow["action"],
    actorId: r.actor_id === null ? null : uuid(r.actor_id),
    at: timestamp(r.at),
    reason: typeof r.reason === "string" ? r.reason : fail(),
    payload: r.payload,
  });
}

export interface ReviewRepository {
  /** Inserts a queue document; returns 'created' or 'replayed' when the same queue exists. */
  insertQueue(queue: Readonly<Record<string, unknown>>): Promise<"created" | "replayed">;
  getQueue(tenantId: string, workspaceId: string): Promise<ReviewQueueRow | null>;
  /** Replaces the queue document under optimistic concurrency on the previous hash. */
  updateQueue(
    expectedQueueSha256: string,
    queue: Readonly<Record<string, unknown>>,
    updatedAt: string,
  ): Promise<void>;
  insertItem(
    scope: Readonly<{ queueId: string; tenantId: string; workspaceId: string }>,
    item: Readonly<Record<string, unknown>>,
  ): Promise<void>;
  updateItem(
    queueId: string, item: Readonly<Record<string, unknown>>,
  ): Promise<void>;
  insertEvent(
    scope: Readonly<{ queueId: string; tenantId: string; workspaceId: string }>,
    event: Readonly<Record<string, unknown>>,
  ): Promise<void>;
  listItems(
    tenantId: string, workspaceId: string,
    filter?: Readonly<{ kind?: string; status?: string }>,
  ): Promise<readonly ReviewItemRow[]>;
  listEvents(tenantId: string, workspaceId: string, limit?: number): Promise<readonly ReviewEventRow[]>;
}

function queueColumns(queue: Readonly<Record<string, unknown>>) {
  const queueId = queue.queueId;
  const queueHash = queue.queueHash;
  return {
    queueId: typeof queueId === "string" && QUEUE_ID.test(queueId) ? queueId : fail(),
    tenantId: uuid(queue.tenantId),
    workspaceId: uuid(queue.workspaceId),
    queueSha256: typeof queueHash === "string" && queueHash.startsWith("sha256:")
      ? sha(queueHash.slice(7)) : fail(),
    createdAt: timestamp(queue.createdAt),
  };
}

function itemColumns(item: Readonly<Record<string, unknown>>) {
  const status = item.status;
  if (typeof status !== "string" || !STATUSES.has(status)) fail();
  const kind = item.kind;
  const priority = item.priority;
  const claimedBy = item.claimedBy;
  if (typeof kind !== "string" || !KINDS.has(kind)) fail();
  if (typeof priority !== "string" || !PRIORITIES.has(priority)) fail();
  return {
    itemId: typeof item.itemId === "string" && ITEM_ID.test(item.itemId) ? item.itemId : fail(),
    kind,
    subject: isPlainRecord(item.subject) ? item.subject : fail(),
    priority,
    reason: typeof item.reason === "string" ? item.reason : fail(),
    uncertaintyIds: Array.isArray(item.uncertaintyIds) ? item.uncertaintyIds : fail(),
    status,
    claimedBy: claimedBy === null ? null : uuid(claimedBy),
    leaseExpiresAt: nullableTimestamp(item.leaseExpiresAt),
    resolution: item.resolution === null ? null : isPlainRecord(item.resolution) ? item.resolution : fail(),
    enqueuedAt: timestamp(item.enqueuedAt),
    updatedAt: timestamp(item.updatedAt),
  };
}

function eventColumns(event: Readonly<Record<string, unknown>>) {
  const action = event.action;
  if (typeof action !== "string" || !ACTIONS.has(action)) fail();
  const actor = event.actor;
  return {
    sequence: intValue(event.sequence),
    itemId: typeof event.itemId === "string" && ITEM_ID.test(event.itemId) ? event.itemId : fail(),
    action,
    actorId: actor === null || actor === undefined ? null
      : isPlainRecord(actor) ? uuid(actor.actorId) : fail(),
    at: timestamp(event.at),
    reason: typeof event.reason === "string" ? event.reason : fail(),
  };
}

export function createPostgresReviewRepository(db: DbClient): ReviewRepository {
  if (!db || typeof db.prepare !== "function") throw new TypeError("A database client is required");

  const repository: ReviewRepository = {
    async insertQueue(queue) {
      const columns = queueColumns(queue);
      const inserted = await db.prepare(
        `INSERT INTO public.review_queue_documents
          (queue_id, tenant_id, workspace_id, queue_sha256, payload, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?::jsonb, ?, ?)
          ON CONFLICT (queue_id) DO NOTHING RETURNING queue_id`,
      ).all(
        columns.queueId, columns.tenantId, columns.workspaceId, columns.queueSha256,
        jsonText(queue), columns.createdAt, columns.createdAt,
      );
      if (!Array.isArray(inserted) || isProxy(inserted)) fail();
      return inserted.length === 1 ? "created" : "replayed";
    },
    async getQueue(tenantId, workspaceId) {
      const found = await db.prepare(
        `SELECT queue_id, tenant_id, workspace_id, queue_sha256, payload, created_at, updated_at
          FROM public.review_queue_documents WHERE tenant_id = ? AND workspace_id = ?`,
      ).get(tenantId, workspaceId);
      if (found === undefined) return null;
      return parseQueueRow(found);
    },
    async updateQueue(expectedQueueSha256, queue, updatedAt) {
      const columns = queueColumns(queue);
      const result = await db.prepare(
        `UPDATE public.review_queue_documents
          SET queue_sha256 = ?, payload = ?::jsonb, updated_at = ?
          WHERE queue_id = ? AND tenant_id = ? AND workspace_id = ? AND queue_sha256 = ?`,
      ).run(
        columns.queueSha256, jsonText(queue), updatedAt,
        columns.queueId, columns.tenantId, columns.workspaceId,
        expectedQueueSha256.startsWith("sha256:")
          ? expectedQueueSha256.slice(7) : expectedQueueSha256,
      );
      if (!result || typeof result.changes !== "number" || result.changes !== 1) fail();
    },
    async insertItem(scope, item) {
      const columns = itemColumns(item);
      const queueId = typeof scope.queueId === "string" && QUEUE_ID.test(scope.queueId)
        ? scope.queueId : fail();
      const result = await db.prepare(
        `INSERT INTO public.review_queue_items
          (item_id, queue_id, tenant_id, workspace_id, kind, subject, priority, reason,
           uncertainty_ids, status, claimed_by, lease_expires_at, resolution, enqueued_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?::jsonb, ?, ?, ?::jsonb, ?, ?, ?, ?::jsonb, ?, ?)`,
      ).run(
        columns.itemId, queueId, uuid(scope.tenantId), uuid(scope.workspaceId), columns.kind,
        jsonText(columns.subject), columns.priority, columns.reason, jsonText(columns.uncertaintyIds),
        columns.status, columns.claimedBy, columns.leaseExpiresAt,
        columns.resolution === null ? null : jsonText(columns.resolution),
        columns.enqueuedAt, columns.updatedAt,
      );
      if (!result || typeof result.changes !== "number" || result.changes !== 1) fail();
    },
    async updateItem(queueId, item) {
      const columns = itemColumns(item);
      const result = await db.prepare(
        `UPDATE public.review_queue_items
          SET status = ?, claimed_by = ?, lease_expires_at = ?, resolution = ?::jsonb, updated_at = ?
          WHERE queue_id = ? AND item_id = ?`,
      ).run(
        columns.status, columns.claimedBy, columns.leaseExpiresAt,
        columns.resolution === null ? null : jsonText(columns.resolution), columns.updatedAt,
        typeof queueId === "string" && QUEUE_ID.test(queueId) ? queueId : fail(), columns.itemId,
      );
      if (!result || typeof result.changes !== "number" || result.changes !== 1) fail();
    },
    async insertEvent(scope, event) {
      const columns = eventColumns(event);
      const queueId = typeof scope.queueId === "string" && QUEUE_ID.test(scope.queueId)
        ? scope.queueId : fail();
      const result = await db.prepare(
        `INSERT INTO public.review_queue_events
          (queue_id, sequence, tenant_id, workspace_id, item_id, action, actor_id, at, reason, payload)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?::jsonb)`,
      ).run(
        queueId, columns.sequence, uuid(scope.tenantId), uuid(scope.workspaceId), columns.itemId,
        columns.action, columns.actorId, columns.at, columns.reason, jsonText(event),
      );
      if (!result || typeof result.changes !== "number" || result.changes !== 1) fail();
    },
    async listItems(tenantId, workspaceId, filter) {
      const clauses = ["tenant_id = ?", "workspace_id = ?"];
      const params: unknown[] = [tenantId, workspaceId];
      if (filter?.kind !== undefined) {
        clauses.push("kind = ?");
        params.push(filter.kind);
      }
      if (filter?.status !== undefined) {
        clauses.push("status = ?");
        params.push(filter.status);
      }
      const rows = await db.prepare(
        `SELECT item_id, queue_id, tenant_id, workspace_id, kind, subject, priority, reason,
           uncertainty_ids, status, claimed_by, lease_expires_at, resolution, enqueued_at, updated_at
          FROM public.review_queue_items WHERE ${clauses.join(" AND ")}
          ORDER BY enqueued_at DESC, item_id LIMIT 500`,
      ).all(...params);
      if (!Array.isArray(rows) || isProxy(rows)) fail();
      return Object.freeze(rows.map((entry) => parseItemRow(entry)));
    },
    async listEvents(tenantId, workspaceId, limit) {
      const rows = await db.prepare(
        `SELECT queue_id, sequence, tenant_id, workspace_id, item_id, action, actor_id, at, reason, payload
          FROM public.review_queue_events WHERE tenant_id = ? AND workspace_id = ?
          ORDER BY at DESC, sequence DESC LIMIT ?`,
      ).all(tenantId, workspaceId, limit ?? 200);
      if (!Array.isArray(rows) || isProxy(rows)) fail();
      return Object.freeze(rows.map((entry) => parseEventRow(entry)));
    },
  };
  return Object.freeze(repository);
}
