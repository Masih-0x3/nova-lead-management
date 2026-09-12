import { createHash } from "node:crypto";
import { isProxy } from "node:util/types";

import type { DbClient } from "@/lib/db";
import {
  buildOutcomeRecord,
  type OutcomeRecord,
} from "@/lib/outcomes/outcome-record";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const SAFE_REF = /^[A-Za-z0-9][A-Za-z0-9:._/-]{0,254}$/u;
const HASH = /^sha256:[0-9a-f]{64}$/u;
const VERSION_ID = /^outcome-version:[0-9a-f]{64}$/u;
const PLAY_VERSION = /^lead-play-version:[0-9a-f]{64}$/u;
const DRAFT_VERSION = /^outreach-draft-version:[0-9a-f]{64}$/u;
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u;
const MAX_LIST = 10_000;

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value) || isProxy(value)) return false;
  try {
    const prototype = Object.getPrototypeOf(value);
    return prototype === Object.prototype || prototype === null;
  } catch {
    return false;
  }
}

export class OutcomeRepositoryError extends Error {
  readonly code: "OUTCOME_PERSISTENCE_INVALID" | "OUTCOME_PERSISTENCE_CONFLICT";

  constructor(code: OutcomeRepositoryError["code"], message: string) {
    super(message);
    this.name = "OutcomeRepositoryError";
    this.code = code;
  }
}

function invalid(message: string): OutcomeRepositoryError {
  return new OutcomeRepositoryError("OUTCOME_PERSISTENCE_INVALID", message);
}

export interface StoredOutcomeVersion {
  readonly tenantId: string;
  readonly workspaceId: string;
  readonly accountId: string;
  readonly playVersionId: string;
  readonly stableKey: string;
  readonly revision: number;
  readonly draftVersionId: string | null;
  readonly record: OutcomeRecord;
  readonly createdAt: string;
}

export interface OutcomeRepository {
  insertVersion(record: OutcomeRecord): Promise<"created" | "replayed">;
  getVersion(
    tenantId: string, workspaceId: string, accountId: string, versionId: string,
  ): Promise<StoredOutcomeVersion | null>;
  getLatestVersion(
    tenantId: string, workspaceId: string, accountId: string,
    playVersionId: string, stableKey: string,
  ): Promise<StoredOutcomeVersion | null>;
  listVersions(
    tenantId: string,
    workspaceId: string,
    filter?: Readonly<{
      accountId?: string;
      playVersionId?: string;
      stableKey?: string;
      limit?: number;
    }>,
  ): Promise<readonly StoredOutcomeVersion[]>;
}

function iso(value: unknown): string {
  return value instanceof Date ? value.toISOString()
    : typeof value === "string" && ISO.test(value) ? value
      : (() => { throw invalid("bad timestamp"); })();
}

function json(value: unknown): unknown {
  return typeof value === "string" ? JSON.parse(value) : value;
}

function hashJson(value: unknown): string {
  return `sha256:${createHash("sha256").update(JSON.stringify(value), "utf8").digest("hex")}`;
}

/**
 * Recomputes the stored record's content hash from its payload fields, in
 * the exact key order the domain builder hashed them. Works for every
 * revision because every hashed field lives inside the payload itself.
 */
function recomputeContentHash(candidate: OutcomeRecord): string {
  const base = {
    tenantId: candidate.tenantId,
    workspaceId: candidate.workspaceId,
    accountId: candidate.accountId,
    playVersionId: candidate.playVersionId,
    stableKey: candidate.stableKey,
    revision: candidate.revision,
    supersedesVersionId: candidate.supersedesVersionId,
    outcome: candidate.outcome,
    channel: candidate.channel,
    bounceClassification: candidate.bounceClassification,
    occurredAt: candidate.occurredAt,
    recordedAt: candidate.recordedAt,
    notes: candidate.notes,
    source: candidate.source,
    recordedBy: candidate.recordedBy,
    outreachDraftVersionRef: candidate.outreachDraftVersionRef,
    attribution: candidate.attribution,
    audit: candidate.audit,
  };
  return hashJson(base);
}

/**
 * Re-derives the version identity of a stored outcome payload. Revision-1
 * records are fully rebuilt through the domain builder; later revisions are
 * verified by recomputing the content and version hashes (the predecessor
 * is bound by the supersedes FK and revalidated by the report builder).
 */
function verifyOutcomePayload(payload: unknown): OutcomeRecord | null {
  if (!isPlainRecord(payload)) return null;
  const candidate = payload as OutcomeRecord;
  if (candidate.schemaVersion !== 1 || typeof candidate.versionId !== "string"
    || !VERSION_ID.test(candidate.versionId)
    || typeof candidate.tenantId !== "string" || !UUID.test(candidate.tenantId)
    || typeof candidate.workspaceId !== "string" || !UUID.test(candidate.workspaceId)
    || typeof candidate.accountId !== "string" || !UUID.test(candidate.accountId)
    || typeof candidate.playVersionId !== "string" || !PLAY_VERSION.test(candidate.playVersionId)
    || typeof candidate.stableKey !== "string" || !SAFE_REF.test(candidate.stableKey)
    || !Number.isSafeInteger(candidate.revision) || candidate.revision < 1
    || (candidate.revision === 1 ? candidate.supersedesVersionId !== null
      : !(typeof candidate.supersedesVersionId === "string"
        && VERSION_ID.test(candidate.supersedesVersionId)))
    || typeof candidate.contentHash !== "string" || !HASH.test(candidate.contentHash)
    || typeof candidate.versionHash !== "string" || !HASH.test(candidate.versionHash)) {
    return null;
  }
  if (recomputeContentHash(candidate) !== candidate.contentHash
    || hashJson({ schemaVersion: 1, contentHash: candidate.contentHash }) !== candidate.versionHash
    || candidate.versionId !== `outcome-version:${candidate.versionHash.slice(7)}`) {
    return null;
  }
  if (candidate.revision === 1) {
    const rebuilt = buildOutcomeRecord({
      version: 1,
      tenantId: candidate.tenantId,
      workspaceId: candidate.workspaceId,
      accountId: candidate.accountId,
      playVersionId: candidate.playVersionId,
      stableKey: candidate.stableKey,
      revision: 1,
      predecessor: null,
      outcome: candidate.outcome,
      channel: candidate.channel,
      bounceClassification: candidate.bounceClassification,
      occurredAt: candidate.occurredAt,
      recordedAt: candidate.recordedAt,
      notes: candidate.notes,
      source: candidate.source,
      recordedBy: candidate.recordedBy,
      outreachDraftVersionRef: candidate.outreachDraftVersionRef,
      attribution: candidate.attribution,
      correction: null,
    });
    if (!rebuilt.ok
      || JSON.stringify(rebuilt.record) !== JSON.stringify(payload)) return null;
    return rebuilt.record;
  }
  const audit = candidate.audit;
  if (!Array.isArray(audit) || audit.length !== candidate.revision) return null;
  return candidate;
}

function rowToVersion(row: Record<string, unknown>): StoredOutcomeVersion {
  if (!isPlainRecord(row)) throw invalid("outcome_record_versions row is malformed");
  const record = verifyOutcomePayload(json(row.payload));
  const tenantId = typeof row.tenant_id === "string" && UUID.test(row.tenant_id)
    ? row.tenant_id : null;
  const workspaceId = typeof row.workspace_id === "string" && UUID.test(row.workspace_id)
    ? row.workspace_id : null;
  const accountId = typeof row.account_id === "string" && UUID.test(row.account_id)
    ? row.account_id : null;
  const playVersionId = typeof row.play_version_id === "string" && PLAY_VERSION.test(row.play_version_id)
    ? row.play_version_id : null;
  const supersedes = row.supersedes_version_id === null || row.supersedes_version_id === undefined
    ? null
    : typeof row.supersedes_version_id === "string" && VERSION_ID.test(row.supersedes_version_id)
      ? row.supersedes_version_id : undefined;
  const draftVersionId = row.draft_version_id === null || row.draft_version_id === undefined
    ? null
    : typeof row.draft_version_id === "string" && DRAFT_VERSION.test(row.draft_version_id)
      ? row.draft_version_id : undefined;
  if (!record || !tenantId || !workspaceId || !accountId || !playVersionId
    || supersedes === undefined || draftVersionId === undefined
    || record.versionId !== row.version_id || record.tenantId !== tenantId
    || record.workspaceId !== workspaceId || record.accountId !== accountId
    || record.playVersionId !== playVersionId
    || record.stableKey !== row.stable_key || record.revision !== row.revision
    || record.supersedesVersionId !== supersedes
    || record.outcome !== row.outcome
    || record.channel !== row.channel
    || (record.bounceClassification ?? null)
      !== (row.bounce_classification === undefined ? null : row.bounce_classification)
    || (record.outreachDraftVersionRef?.versionId ?? null) !== draftVersionId
    || record.recordedBy.actorId !== row.recorded_by
    || record.source.kind !== row.source_kind
    || record.occurredAt !== iso(row.occurred_at)
    || record.recordedAt !== iso(row.recorded_at)
    || record.contentHash !== `sha256:${row.content_sha256}`
    || record.versionHash !== `sha256:${row.version_sha256}`) {
    throw invalid("outcome_record_versions payload is inconsistent with its relational columns");
  }
  return Object.freeze({
    tenantId,
    workspaceId,
    accountId,
    playVersionId,
    stableKey: record.stableKey,
    revision: record.revision,
    draftVersionId,
    record,
    createdAt: iso(row.created_at),
  });
}

const VERSION_SELECT =
  `SELECT version_id, tenant_id, workspace_id, account_id, play_version_id, stable_key,
    revision, supersedes_version_id, outcome, channel, bounce_classification,
    draft_version_id, source_kind, recorded_by, occurred_at, recorded_at,
    content_sha256, version_sha256, payload, created_at
   FROM public.outcome_record_versions`;

export function createPostgresOutcomeRepository(db: DbClient): OutcomeRepository {
  if (!db || typeof db.prepare !== "function") throw new TypeError("A database client is required");

  const repository: OutcomeRepository = {
    async insertVersion(record) {
      const inserted = await db.prepare(
        `INSERT INTO public.outcome_record_versions
          (version_id, tenant_id, workspace_id, account_id, play_version_id, stable_key,
           revision, supersedes_version_id, outcome, channel, bounce_classification,
           draft_version_id, source_kind, recorded_by, occurred_at, recorded_at,
           content_sha256, version_sha256, payload, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?::jsonb, ?)
         ON CONFLICT (version_id) DO NOTHING RETURNING version_id`,
      ).all(
        record.versionId, record.tenantId, record.workspaceId, record.accountId,
        record.playVersionId, record.stableKey, record.revision, record.supersedesVersionId,
        record.outcome, record.channel, record.bounceClassification,
        record.outreachDraftVersionRef?.versionId ?? null, record.source.kind,
        record.recordedBy.actorId, record.occurredAt, record.recordedAt,
        record.contentHash.slice(7), record.versionHash.slice(7),
        JSON.stringify(record), record.recordedAt,
      );
      if (!Array.isArray(inserted) || isProxy(inserted)) throw invalid("bad outcome insert result");
      return inserted.length === 1 ? "created" : "replayed";
    },

    async getVersion(tenantId, workspaceId, accountId, versionId) {
      const row = await db.prepare(
        `${VERSION_SELECT} WHERE tenant_id = ? AND workspace_id = ? AND account_id = ?
         AND version_id = ?`,
      ).get(tenantId, workspaceId, accountId, versionId);
      if (row === undefined) return null;
      return rowToVersion(row);
    },

    async getLatestVersion(tenantId, workspaceId, accountId, playVersionId, stableKey) {
      const row = await db.prepare(
        `${VERSION_SELECT} WHERE tenant_id = ? AND workspace_id = ? AND account_id = ?
         AND play_version_id = ? AND stable_key = ?
         ORDER BY revision DESC LIMIT 1`,
      ).get(tenantId, workspaceId, accountId, playVersionId, stableKey);
      if (row === undefined) return null;
      return rowToVersion(row);
    },

    async listVersions(tenantId, workspaceId, filter) {
      const limit = filter?.limit !== undefined && Number.isSafeInteger(filter.limit)
        && filter.limit > 0 ? Math.min(filter.limit, MAX_LIST) : 1000;
      const conditions = ["tenant_id = ?", "workspace_id = ?"];
      const values: unknown[] = [tenantId, workspaceId];
      if (filter?.accountId !== undefined) {
        values.push(filter.accountId);
        conditions.push("account_id = ?");
      }
      if (filter?.playVersionId !== undefined) {
        values.push(filter.playVersionId);
        conditions.push("play_version_id = ?");
      }
      if (filter?.stableKey !== undefined) {
        values.push(filter.stableKey);
        conditions.push("stable_key = ?");
      }
      const rows = await db.prepare(
        `${VERSION_SELECT} WHERE ${conditions.join(" AND ")}
         ORDER BY account_id, play_version_id, stable_key, revision ASC LIMIT ${limit}`,
      ).all(...values);
      if (!Array.isArray(rows) || isProxy(rows)) throw invalid("bad outcome list result");
      return Object.freeze(rows.map(rowToVersion));
    },
  };
  return Object.freeze(repository);
}
