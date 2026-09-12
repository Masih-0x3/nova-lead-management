import { isProxy } from "node:util/types";

import type { DbClient } from "@/lib/db";

export class QualificationPersistenceError extends Error {
  readonly code = "QUALIFICATION_PERSISTENCE" as const;

  constructor() {
    super("The qualification state could not be loaded or persisted safely.");
    this.name = "QualificationPersistenceError";
  }
}

function fail(): never {
  throw new QualificationPersistenceError();
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const SHA256 = /^[0-9a-f]{64}$/u;
const QUALIFICATION_ID = /^account-qualification:[0-9a-f]{64}$/u;
const PLAY_VERSION = /^lead-play-version:[0-9a-f]{64}$/u;
const DECISIONS = new Set(["qualified", "needs_review", "unqualified"]);
const REVIEW_STATUSES = new Set(["unreviewed", "confirmed", "overridden"]);

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

function numeric(value: unknown): number {
  const normalized = typeof value === "string" && /^-?[0-9]+(\.[0-9]+)?$/u.test(value)
    ? Number(value) : value;
  if (typeof normalized !== "number" || !Number.isFinite(normalized)) fail();
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

export type QualificationRow = Readonly<{
  versionId: string;
  tenantId: string;
  workspaceId: string;
  accountId: string;
  playVersionId: string;
  playContentSha256: string;
  policySha256: string;
  qualificationSha256: string;
  weightedScore: number;
  automatedDecision: "qualified" | "needs_review" | "unqualified";
  decision: "qualified" | "needs_review" | "unqualified";
  reviewStatus: "unreviewed" | "confirmed" | "overridden";
  evaluatedAt: string;
  payload: Record<string, unknown>;
  createdAt: string;
}>;

function parseRow(value: unknown): QualificationRow {
  const r = requiredRow(value);
  const automated = r.automated_decision;
  const decision = r.decision;
  const reviewStatus = r.review_status;
  if (typeof automated !== "string" || !DECISIONS.has(automated)) fail();
  if (typeof decision !== "string" || !DECISIONS.has(decision)) fail();
  if (typeof reviewStatus !== "string" || !REVIEW_STATUSES.has(reviewStatus)) fail();
  if (typeof r.play_version_id !== "string" || !PLAY_VERSION.test(r.play_version_id)) fail();
  const payload = r.payload;
  if (!isPlainRecord(payload)) fail();
  return Object.freeze({
    versionId: typeof r.version_id === "string" && QUALIFICATION_ID.test(r.version_id)
      ? r.version_id : fail(),
    tenantId: uuid(r.tenant_id),
    workspaceId: uuid(r.workspace_id),
    accountId: uuid(r.account_id),
    playVersionId: r.play_version_id,
    playContentSha256: sha(r.play_content_sha256),
    policySha256: sha(r.policy_sha256),
    qualificationSha256: sha(r.qualification_sha256),
    weightedScore: numeric(r.weighted_score),
    automatedDecision: automated as QualificationRow["automatedDecision"],
    decision: decision as QualificationRow["decision"],
    reviewStatus: reviewStatus as QualificationRow["reviewStatus"],
    evaluatedAt: timestamp(r.evaluated_at),
    payload,
    createdAt: timestamp(r.created_at),
  });
}

function columnsOf(record: Readonly<Record<string, unknown>>) {
  const automated = record.automatedDecision;
  const decision = record.decision;
  const reviewStatus = record.reviewStatus;
  if (typeof automated !== "string" || !DECISIONS.has(automated)) fail();
  if (typeof decision !== "string" || !DECISIONS.has(decision)) fail();
  if (typeof reviewStatus !== "string" || !REVIEW_STATUSES.has(reviewStatus)) fail();
  const versionId = record.versionId;
  const playVersionId = record.playVersionId;
  if (typeof versionId !== "string" || !QUALIFICATION_ID.test(versionId)) fail();
  if (typeof playVersionId !== "string" || !PLAY_VERSION.test(playVersionId)) fail();
  const stripSha = (value: unknown) => typeof value === "string" && value.startsWith("sha256:")
    && SHA256.test(value.slice(7)) ? value.slice(7) : fail();
  return {
    versionId,
    tenantId: uuid(record.tenantId),
    workspaceId: uuid(record.workspaceId),
    accountId: uuid(record.accountId),
    playVersionId,
    playContentSha256: stripSha(record.playContentHash),
    policySha256: stripSha(record.policyHash),
    qualificationSha256: stripSha(record.qualificationHash),
    weightedScore: numeric(record.weightedScore),
    automatedDecision: automated,
    decision,
    reviewStatus,
    evaluatedAt: timestamp(record.evaluatedAt),
  };
}

const SELECT = `SELECT version_id, tenant_id, workspace_id, account_id, play_version_id,
  play_content_sha256, policy_sha256, qualification_sha256, weighted_score,
  automated_decision, decision, review_status, evaluated_at, payload, created_at
  FROM public.account_qualification_snapshots`;

export interface QualificationRepository {
  insertQualification(record: Readonly<Record<string, unknown>>): Promise<"created" | "replayed">;
  getQualification(
    tenantId: string, workspaceId: string, accountId: string, versionId: string,
  ): Promise<QualificationRow | null>;
  listQualifications(
    tenantId: string, workspaceId: string, accountId?: string,
  ): Promise<readonly QualificationRow[]>;
  applyReview(expectedQualificationSha256: string, record: Readonly<Record<string, unknown>>): Promise<void>;
}

export function createPostgresQualificationRepository(db: DbClient): QualificationRepository {
  if (!db || typeof db.prepare !== "function") throw new TypeError("A database client is required");

  const repository: QualificationRepository = {
    async insertQualification(record) {
      const columns = columnsOf(record);
      const inserted = await db.prepare(
        `INSERT INTO public.account_qualification_snapshots
          (version_id, tenant_id, workspace_id, account_id, play_version_id,
           play_content_sha256, policy_sha256, qualification_sha256, weighted_score,
           automated_decision, decision, review_status, evaluated_at, payload)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?::jsonb)
          ON CONFLICT (version_id) DO NOTHING RETURNING version_id`,
      ).all(
        columns.versionId, columns.tenantId, columns.workspaceId, columns.accountId,
        columns.playVersionId, columns.playContentSha256, columns.policySha256,
        columns.qualificationSha256, columns.weightedScore, columns.automatedDecision,
        columns.decision, columns.reviewStatus, columns.evaluatedAt, jsonText(record),
      );
      if (!Array.isArray(inserted) || isProxy(inserted)) fail();
      return inserted.length === 1 ? "created" : "replayed";
    },
    async getQualification(tenantId, workspaceId, accountId, versionId) {
      const found = await db.prepare(
        `${SELECT} WHERE tenant_id = ? AND workspace_id = ? AND account_id = ? AND version_id = ?`,
      ).get(tenantId, workspaceId, accountId, versionId);
      if (found === undefined) return null;
      return parseRow(found);
    },
    async listQualifications(tenantId, workspaceId, accountId) {
      const rows = accountId === undefined
        ? await db.prepare(
          `${SELECT} WHERE tenant_id = ? AND workspace_id = ?
            ORDER BY evaluated_at DESC, version_id LIMIT 500`,
        ).all(tenantId, workspaceId)
        : await db.prepare(
          `${SELECT} WHERE tenant_id = ? AND workspace_id = ? AND account_id = ?
            ORDER BY evaluated_at DESC, version_id LIMIT 500`,
        ).all(tenantId, workspaceId, accountId);
      if (!Array.isArray(rows) || isProxy(rows)) fail();
      return Object.freeze(rows.map((entry) => parseRow(entry)));
    },
    async applyReview(expectedQualificationSha256, record) {
      const columns = columnsOf(record);
      const parentSha = expectedQualificationSha256.startsWith("sha256:")
        ? expectedQualificationSha256.slice(7) : expectedQualificationSha256;
      if (!SHA256.test(parentSha)) fail();
      const events = Array.isArray(record.reviewEvents) ? record.reviewEvents : fail();
      const lastEvent = events.length > 0 ? events.at(-1) : fail();
      if (!isPlainRecord(lastEvent)
        || lastEvent.fromQualificationHash !== `sha256:${parentSha}`) fail();
      const inserted = await db.prepare(
        `INSERT INTO public.account_qualification_snapshots
          (version_id, tenant_id, workspace_id, account_id, play_version_id,
           play_content_sha256, policy_sha256, qualification_sha256, weighted_score,
           automated_decision, decision, review_status, evaluated_at, payload)
          SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?::jsonb
          WHERE EXISTS (
            SELECT 1 FROM public.account_qualification_snapshots parent
            WHERE parent.tenant_id = ? AND parent.workspace_id = ? AND parent.account_id = ?
              AND parent.qualification_sha256 = ?
          )
          ON CONFLICT (version_id) DO NOTHING RETURNING version_id`,
      ).all(
        columns.versionId, columns.tenantId, columns.workspaceId, columns.accountId,
        columns.playVersionId, columns.playContentSha256, columns.policySha256,
        columns.qualificationSha256, columns.weightedScore, columns.automatedDecision,
        columns.decision, columns.reviewStatus, columns.evaluatedAt, jsonText(record),
        columns.tenantId, columns.workspaceId, columns.accountId, parentSha,
      );
      if (!Array.isArray(inserted) || isProxy(inserted)) fail();
      if (inserted.length === 1) return;
      const existing = await db.prepare(
        `SELECT version_id FROM public.account_qualification_snapshots
          WHERE tenant_id = ? AND workspace_id = ? AND account_id = ? AND version_id = ?`,
      ).get(columns.tenantId, columns.workspaceId, columns.accountId, columns.versionId);
      if (existing === undefined) fail();
    },
  };
  return Object.freeze(repository);
}
