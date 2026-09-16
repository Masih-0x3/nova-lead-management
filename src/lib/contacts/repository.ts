import { isProxy } from "node:util/types";

import type { DbClient } from "@/lib/db";

export class ContactPersistenceError extends Error {
  readonly code = "CONTACT_PERSISTENCE" as const;

  constructor() {
    super("The contact state could not be loaded or persisted safely.");
    this.name = "ContactPersistenceError";
  }
}

function fail(): never {
  throw new ContactPersistenceError();
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const SHA256 = /^[0-9a-f]{64}$/u;
const CONTACT_VERSION = /^contact-version:[0-9a-f]{64}$/u;
const CENTER_VERSION = /^buying-center-version:[0-9a-f]{64}$/u;
const REVIEW_STATUSES = new Set(["draft", "in_review", "approved", "rejected"]);
const SUPPRESSIONS = new Set([
  "clear", "opt_out", "do_not_contact", "complaint", "hard_bounce", "soft_bounce",
  "deletion_pending", "deleted_tombstone", "source_prohibited", "conflicted", "unknown",
]);
const EPISTEMIC = new Set(["KNOWN", "UNKNOWN", "CONFLICTED", "STALE", "NA"]);

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

function jsonText(value: unknown): string {
  try {
    const serialized = JSON.stringify(value);
    if (typeof serialized !== "string") fail();
    return serialized;
  } catch {
    fail();
  }
}

function payloadOf(record: Record<string, unknown>): Record<string, unknown> {
  const payload = record.payload;
  if (!isPlainRecord(payload)) fail();
  return payload;
}

export type ContactVersionRow = Readonly<{
  versionId: string;
  tenantId: string;
  workspaceId: string;
  accountId: string;
  stableKey: string;
  revision: number;
  supersedesVersionId: string | null;
  reviewStatus: "draft" | "in_review" | "approved" | "rejected";
  suppressionDisposition: string;
  freshnessState: string;
  contactPointClass: string;
  connectorKey: string;
  contentSha256: string;
  versionSha256: string;
  reviewSha256: string;
  payload: Record<string, unknown>;
  createdAt: string;
}>;

export type BuyingCenterRow = Readonly<{
  versionId: string;
  tenantId: string;
  workspaceId: string;
  accountId: string;
  playVersionId: string;
  stableKey: string;
  revision: number;
  supersedesVersionId: string | null;
  reviewStatus: "draft" | "in_review" | "approved" | "rejected";
  hypothesisCount: number;
  verifiedContactCount: number;
  contentSha256: string;
  versionSha256: string;
  reviewSha256: string;
  payload: Record<string, unknown>;
  createdAt: string;
}>;

function parseContactRow(value: unknown): ContactVersionRow {
  const r = requiredRow(value);
  const reviewStatus = r.review_status;
  const suppression = r.suppression_disposition;
  const freshness = r.freshness_state;
  if (typeof reviewStatus !== "string" || !REVIEW_STATUSES.has(reviewStatus)) fail();
  if (typeof suppression !== "string" || !SUPPRESSIONS.has(suppression)) fail();
  if (typeof freshness !== "string" || !EPISTEMIC.has(freshness)) fail();
  return Object.freeze({
    versionId: typeof r.version_id === "string" && CONTACT_VERSION.test(r.version_id) ? r.version_id : fail(),
    tenantId: uuid(r.tenant_id),
    workspaceId: uuid(r.workspace_id),
    accountId: uuid(r.account_id),
    stableKey: typeof r.stable_key === "string" && r.stable_key.length <= 300 ? r.stable_key : fail(),
    revision: intValue(r.revision),
    supersedesVersionId: r.supersedes_version_id === null ? null
      : typeof r.supersedes_version_id === "string" && CONTACT_VERSION.test(r.supersedes_version_id)
        ? r.supersedes_version_id : fail(),
    reviewStatus: reviewStatus as ContactVersionRow["reviewStatus"],
    suppressionDisposition: suppression,
    freshnessState: freshness,
    contactPointClass: typeof r.contact_point_class === "string" ? r.contact_point_class : fail(),
    connectorKey: typeof r.connector_key === "string" ? r.connector_key : fail(),
    contentSha256: sha(r.content_sha256),
    versionSha256: sha(r.version_sha256),
    reviewSha256: sha(r.review_sha256),
    payload: payloadOf(r),
    createdAt: timestamp(r.created_at),
  });
}

function parseCenterRow(value: unknown): BuyingCenterRow {
  const r = requiredRow(value);
  const reviewStatus = r.review_status;
  if (typeof reviewStatus !== "string" || !REVIEW_STATUSES.has(reviewStatus)) fail();
  return Object.freeze({
    versionId: typeof r.version_id === "string" && CENTER_VERSION.test(r.version_id) ? r.version_id : fail(),
    tenantId: uuid(r.tenant_id),
    workspaceId: uuid(r.workspace_id),
    accountId: uuid(r.account_id),
    playVersionId: typeof r.play_version_id === "string" ? r.play_version_id : fail(),
    stableKey: typeof r.stable_key === "string" && r.stable_key.length <= 300 ? r.stable_key : fail(),
    revision: intValue(r.revision),
    supersedesVersionId: r.supersedes_version_id === null ? null
      : typeof r.supersedes_version_id === "string" && CENTER_VERSION.test(r.supersedes_version_id)
        ? r.supersedes_version_id : fail(),
    reviewStatus: reviewStatus as BuyingCenterRow["reviewStatus"],
    hypothesisCount: intValue(r.hypothesis_count),
    verifiedContactCount: intValue(r.verified_contact_count),
    contentSha256: sha(r.content_sha256),
    versionSha256: sha(r.version_sha256),
    reviewSha256: sha(r.review_sha256),
    payload: payloadOf(r),
    createdAt: timestamp(r.created_at),
  });
}

const CONTACT_SELECT = `SELECT version_id, tenant_id, workspace_id, account_id, stable_key, revision,
  supersedes_version_id, review_status, suppression_disposition, freshness_state,
  contact_point_class, connector_key, content_sha256, version_sha256, review_sha256,
  payload, created_at FROM public.contact_record_versions`;

const CENTER_SELECT = `SELECT version_id, tenant_id, workspace_id, account_id, play_version_id,
  stable_key, revision, supersedes_version_id, review_status, hypothesis_count,
  verified_contact_count, content_sha256, version_sha256, review_sha256, payload, created_at
  FROM public.buying_center_versions`;

export interface ContactRepository {
  insertContact(record: Readonly<Record<string, unknown>>): Promise<"created" | "replayed">;
  getContact(tenantId: string, workspaceId: string, versionId: string): Promise<ContactVersionRow | null>;
  listContacts(tenantId: string, workspaceId: string): Promise<readonly ContactVersionRow[]>;
  listAccountContacts(tenantId: string, workspaceId: string, accountId: string): Promise<readonly ContactVersionRow[]>;
  updateContactReview(expectedReviewSha256: string, record: Readonly<Record<string, unknown>>): Promise<void>;
  insertCenter(record: Readonly<Record<string, unknown>>): Promise<"created" | "replayed">;
  getCenter(tenantId: string, workspaceId: string, versionId: string): Promise<BuyingCenterRow | null>;
  listCenters(tenantId: string, workspaceId: string): Promise<readonly BuyingCenterRow[]>;
  listAccountCenters(tenantId: string, workspaceId: string, accountId: string): Promise<readonly BuyingCenterRow[]>;
  updateCenterReview(expectedReviewSha256: string, record: Readonly<Record<string, unknown>>): Promise<void>;
}

function contactColumns(record: Readonly<Record<string, unknown>>) {
  const review = isPlainRecord(record.review) ? record.review : fail();
  const freshness = isPlainRecord(record.freshness) ? record.freshness : fail();
  const identity = isPlainRecord(record.identity) ? record.identity : fail();
  const receipt = isPlainRecord(record.sourceReceipt) ? record.sourceReceipt : fail();
  const reviewStatus = record.review !== undefined ? review.status : null;
  const suppression = record.suppressionDisposition;
  if (typeof reviewStatus !== "string" || !REVIEW_STATUSES.has(reviewStatus)) fail();
  if (typeof suppression !== "string" || !SUPPRESSIONS.has(suppression)) fail();
  return {
    versionId: typeof record.versionId === "string" && CONTACT_VERSION.test(record.versionId)
      ? record.versionId : fail(),
    tenantId: uuid(record.tenantId),
    workspaceId: uuid(record.workspaceId),
    accountId: uuid(record.accountId),
    stableKey: typeof record.stableKey === "string" ? record.stableKey : fail(),
    revision: intValue(record.revision),
    supersedesVersionId: record.supersedesVersionId === null ? null
      : typeof record.supersedesVersionId === "string" && CONTACT_VERSION.test(record.supersedesVersionId)
        ? record.supersedesVersionId : fail(),
    reviewStatus,
    suppression,
    freshnessState: typeof freshness.state === "string" && EPISTEMIC.has(freshness.state)
      ? freshness.state : fail(),
    contactPointClass: typeof identity.contactPointClass === "string" ? identity.contactPointClass : fail(),
    connectorKey: typeof receipt.connectorKey === "string" ? receipt.connectorKey : fail(),
    contentSha256: typeof record.contentHash === "string" && record.contentHash.startsWith("sha256:")
      ? record.contentHash.slice(7) : fail(),
    versionSha256: typeof record.versionHash === "string" && record.versionHash.startsWith("sha256:")
      ? record.versionHash.slice(7) : fail(),
    reviewSha256: typeof review.reviewHash === "string" && review.reviewHash.startsWith("sha256:")
      ? review.reviewHash.slice(7) : fail(),
    createdAt: timestamp(record.createdAt),
  };
}

function centerColumns(record: Readonly<Record<string, unknown>>) {
  const review = isPlainRecord(record.review) ? record.review : fail();
  const reviewStatus = review.status;
  const hypotheses = Array.isArray(record.hypotheses) ? record.hypotheses : fail();
  const verified = hypotheses.filter((item) => isPlainRecord(item)
    && isPlainRecord(item.contactVersionRef)).length;
  if (typeof reviewStatus !== "string" || !REVIEW_STATUSES.has(reviewStatus)) fail();
  return {
    versionId: typeof record.versionId === "string" && CENTER_VERSION.test(record.versionId)
      ? record.versionId : fail(),
    tenantId: uuid(record.tenantId),
    workspaceId: uuid(record.workspaceId),
    accountId: uuid(record.accountId),
    playVersionId: typeof record.playVersionId === "string" ? record.playVersionId : fail(),
    stableKey: typeof record.stableKey === "string" ? record.stableKey : fail(),
    revision: intValue(record.revision),
    supersedesVersionId: record.supersedesVersionId === null ? null
      : typeof record.supersedesVersionId === "string" && CENTER_VERSION.test(record.supersedesVersionId)
        ? record.supersedesVersionId : fail(),
    reviewStatus,
    hypothesisCount: hypotheses.length,
    verifiedContactCount: verified,
    contentSha256: typeof record.contentHash === "string" && record.contentHash.startsWith("sha256:")
      ? record.contentHash.slice(7) : fail(),
    versionSha256: typeof record.versionHash === "string" && record.versionHash.startsWith("sha256:")
      ? record.versionHash.slice(7) : fail(),
    reviewSha256: typeof review.reviewHash === "string" && review.reviewHash.startsWith("sha256:")
      ? review.reviewHash.slice(7) : fail(),
    createdAt: timestamp(record.createdAt),
  };
}

function expectChanges(result: { changes: number } | null | undefined): void {
  if (!result || typeof result.changes !== "number" || result.changes !== 1) fail();
}

export function createPostgresContactRepository(db: DbClient): ContactRepository {
  if (!db || typeof db.prepare !== "function") throw new TypeError("A database client is required");

  const repository: ContactRepository = {
    async insertContact(record) {
      const columns = contactColumns(record);
      const inserted = await db.prepare(
        `INSERT INTO public.contact_record_versions
          (version_id, tenant_id, workspace_id, account_id, stable_key, revision,
           supersedes_version_id, review_status, suppression_disposition, freshness_state,
           contact_point_class, connector_key, content_sha256, version_sha256, review_sha256,
           payload, created_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?::jsonb, ?)
          ON CONFLICT (version_id) DO NOTHING RETURNING version_id`,
      ).all(
        columns.versionId, columns.tenantId, columns.workspaceId, columns.accountId,
        columns.stableKey, columns.revision, columns.supersedesVersionId, columns.reviewStatus,
        columns.suppression, columns.freshnessState, columns.contactPointClass, columns.connectorKey,
        columns.contentSha256, columns.versionSha256, columns.reviewSha256,
        jsonText(record), columns.createdAt,
      );
      if (!Array.isArray(inserted) || isProxy(inserted)) fail();
      return inserted.length === 1 ? "created" : "replayed";
    },
    async getContact(tenantId, workspaceId, versionId) {
      const found = await db.prepare(
        `${CONTACT_SELECT} WHERE tenant_id = ? AND workspace_id = ? AND version_id = ?`,
      ).get(tenantId, workspaceId, versionId);
      if (found === undefined) return null;
      return parseContactRow(found);
    },
    async listContacts(tenantId, workspaceId) {
      const rows = await db.prepare(
        `${CONTACT_SELECT} WHERE tenant_id = ? AND workspace_id = ?
          ORDER BY created_at DESC, version_id LIMIT 500`,
      ).all(tenantId, workspaceId);
      if (!Array.isArray(rows) || isProxy(rows)) fail();
      return Object.freeze(rows.map((entry) => parseContactRow(entry)));
    },
    async listAccountContacts(tenantId, workspaceId, accountId) {
      const rows = await db.prepare(
        `${CONTACT_SELECT} WHERE tenant_id = ? AND workspace_id = ? AND account_id = ?
          ORDER BY stable_key, revision DESC`,
      ).all(tenantId, workspaceId, accountId);
      if (!Array.isArray(rows) || isProxy(rows)) fail();
      return Object.freeze(rows.map((entry) => parseContactRow(entry)));
    },
    async updateContactReview(expectedReviewSha256, record) {
      const columns = contactColumns(record);
      expectChanges(await db.prepare(
        `UPDATE public.contact_record_versions
          SET review_status = ?, review_sha256 = ?, payload = ?::jsonb
          WHERE version_id = ? AND tenant_id = ? AND workspace_id = ? AND account_id = ?
            AND review_sha256 = ?`,
      ).run(
        columns.reviewStatus, columns.reviewSha256, jsonText(record),
        columns.versionId, columns.tenantId, columns.workspaceId, columns.accountId,
        expectedReviewSha256.startsWith("sha256:") ? expectedReviewSha256.slice(7) : expectedReviewSha256,
      ));
    },
    async insertCenter(record) {
      const columns = centerColumns(record);
      const inserted = await db.prepare(
        `INSERT INTO public.buying_center_versions
          (version_id, tenant_id, workspace_id, account_id, play_version_id, stable_key,
           revision, supersedes_version_id, review_status, hypothesis_count,
           verified_contact_count, content_sha256, version_sha256, review_sha256, payload, created_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?::jsonb, ?)
          ON CONFLICT (version_id) DO NOTHING RETURNING version_id`,
      ).all(
        columns.versionId, columns.tenantId, columns.workspaceId, columns.accountId,
        columns.playVersionId, columns.stableKey, columns.revision, columns.supersedesVersionId,
        columns.reviewStatus, columns.hypothesisCount, columns.verifiedContactCount,
        columns.contentSha256, columns.versionSha256, columns.reviewSha256,
        jsonText(record), columns.createdAt,
      );
      if (!Array.isArray(inserted) || isProxy(inserted)) fail();
      return inserted.length === 1 ? "created" : "replayed";
    },
    async getCenter(tenantId, workspaceId, versionId) {
      const found = await db.prepare(
        `${CENTER_SELECT} WHERE tenant_id = ? AND workspace_id = ? AND version_id = ?`,
      ).get(tenantId, workspaceId, versionId);
      if (found === undefined) return null;
      return parseCenterRow(found);
    },
    async listCenters(tenantId, workspaceId) {
      const rows = await db.prepare(
        `${CENTER_SELECT} WHERE tenant_id = ? AND workspace_id = ?
          ORDER BY created_at DESC, version_id LIMIT 500`,
      ).all(tenantId, workspaceId);
      if (!Array.isArray(rows) || isProxy(rows)) fail();
      return Object.freeze(rows.map((entry) => parseCenterRow(entry)));
    },
    async listAccountCenters(tenantId, workspaceId, accountId) {
      const rows = await db.prepare(
        `${CENTER_SELECT} WHERE tenant_id = ? AND workspace_id = ? AND account_id = ?
          ORDER BY play_version_id, revision DESC`,
      ).all(tenantId, workspaceId, accountId);
      if (!Array.isArray(rows) || isProxy(rows)) fail();
      return Object.freeze(rows.map((entry) => parseCenterRow(entry)));
    },
    async updateCenterReview(expectedReviewSha256, record) {
      const columns = centerColumns(record);
      expectChanges(await db.prepare(
        `UPDATE public.buying_center_versions
          SET review_status = ?, review_sha256 = ?, payload = ?::jsonb
          WHERE version_id = ? AND tenant_id = ? AND workspace_id = ? AND account_id = ?
            AND review_sha256 = ?`,
      ).run(
        columns.reviewStatus, columns.reviewSha256, jsonText(record),
        columns.versionId, columns.tenantId, columns.workspaceId, columns.accountId,
        expectedReviewSha256.startsWith("sha256:") ? expectedReviewSha256.slice(7) : expectedReviewSha256,
      ));
    },
  };
  return Object.freeze(repository);
}
