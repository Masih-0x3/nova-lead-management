import { createHash } from "node:crypto";
import { isProxy } from "node:util/types";

import type { DbClient } from "@/lib/db";
import type { LearningProposal } from "@/lib/outcomes/learning-proposal";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const SAFE_REF = /^[A-Za-z0-9][A-Za-z0-9:._/-]{0,254}$/u;
const HASH = /^sha256:[0-9a-f]{64}$/u;
const VERSION_ID = /^learning-proposal-version:[0-9a-f]{64}$/u;
const PLAY_VERSION = /^lead-play-version:[0-9a-f]{64}$/u;
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u;
const REVIEW_STATUSES = new Set(["draft", "in_review", "approved", "rejected"]);

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value) || isProxy(value)) return false;
  try {
    const prototype = Object.getPrototypeOf(value);
    return prototype === Object.prototype || prototype === null;
  } catch {
    return false;
  }
}

export class LearningRepositoryError extends Error {
  readonly code: "LEARNING_PERSISTENCE_INVALID" | "LEARNING_PERSISTENCE_CONFLICT";

  constructor(code: LearningRepositoryError["code"], message: string) {
    super(message);
    this.name = "LearningRepositoryError";
    this.code = code;
  }
}

function invalid(message: string): LearningRepositoryError {
  return new LearningRepositoryError("LEARNING_PERSISTENCE_INVALID", message);
}

function conflict(message: string): LearningRepositoryError {
  return new LearningRepositoryError("LEARNING_PERSISTENCE_CONFLICT", message);
}

export interface StoredLearningProposal {
  readonly tenantId: string;
  readonly workspaceId: string;
  readonly accountId: string;
  readonly playVersionId: string;
  readonly stableKey: string;
  readonly revision: number;
  readonly proposal: LearningProposal;
  readonly createdAt: string;
}

export interface LearningRepository {
  insertVersion(proposal: LearningProposal): Promise<"created" | "replayed">;
  getVersion(
    tenantId: string, workspaceId: string, accountId: string, versionId: string,
  ): Promise<StoredLearningProposal | null>;
  getLatestVersion(
    tenantId: string, workspaceId: string, accountId: string,
    playVersionId: string, stableKey: string,
  ): Promise<StoredLearningProposal | null>;
  listVersions(
    tenantId: string,
    workspaceId: string,
    filter?: Readonly<{ accountId?: string; playVersionId?: string; stableKey?: string }>,
  ): Promise<readonly StoredLearningProposal[]>;
  updateReview(expectedReviewHash: string, proposal: LearningProposal): Promise<void>;
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
 * Recomputes the proposal's content and version hashes from the payload in
 * the exact key order the domain builder hashed. A stored row whose payload
 * was tampered with cannot satisfy this check.
 */
function verifyProposalShape(payload: unknown): LearningProposal | null {
  if (!isPlainRecord(payload)) return null;
  const proposal = payload as LearningProposal;
  if (proposal.schemaVersion !== 1 || typeof proposal.versionId !== "string"
    || !VERSION_ID.test(proposal.versionId)
    || typeof proposal.tenantId !== "string" || !UUID.test(proposal.tenantId)
    || typeof proposal.workspaceId !== "string" || !UUID.test(proposal.workspaceId)
    || typeof proposal.accountId !== "string" || !UUID.test(proposal.accountId)
    || typeof proposal.playVersionId !== "string" || !PLAY_VERSION.test(proposal.playVersionId)
    || typeof proposal.stableKey !== "string" || !SAFE_REF.test(proposal.stableKey)
    || !Number.isSafeInteger(proposal.revision) || proposal.revision < 1
    || (proposal.revision === 1 ? proposal.supersedesVersionId !== null
      : !(typeof proposal.supersedesVersionId === "string"
        && VERSION_ID.test(proposal.supersedesVersionId)))
    || typeof proposal.contentHash !== "string" || !HASH.test(proposal.contentHash)
    || typeof proposal.versionHash !== "string" || !HASH.test(proposal.versionHash)
    || typeof proposal.createdAt !== "string" || !ISO.test(proposal.createdAt)) {
    return null;
  }
  const base = {
    tenantId: proposal.tenantId,
    workspaceId: proposal.workspaceId,
    accountId: proposal.accountId,
    playVersionId: proposal.playVersionId,
    stableKey: proposal.stableKey,
    revision: proposal.revision,
    supersedesVersionId: proposal.supersedesVersionId,
    createdAt: proposal.createdAt,
    outcomeRefs: proposal.outcomeRefs,
    cohort: proposal.cohort,
    metric: proposal.metric,
    target: proposal.target,
    change: proposal.change,
    uncertainties: proposal.uncertainties,
    expectedImpact: proposal.expectedImpact,
    rollback: proposal.rollback,
  };
  if (hashJson(base) !== proposal.contentHash
    || hashJson({ schemaVersion: 1, contentHash: proposal.contentHash }) !== proposal.versionHash
    || proposal.versionId !== `learning-proposal-version:${proposal.versionHash.slice(7)}`) {
    return null;
  }
  const review = proposal.review;
  if (!isPlainRecord(review) || review.versionId !== proposal.versionId
    || review.tenantId !== proposal.tenantId || review.workspaceId !== proposal.workspaceId
    || review.accountId !== proposal.accountId || review.playVersionId !== proposal.playVersionId
    || review.contentHash !== proposal.contentHash
    || typeof review.status !== "string" || !REVIEW_STATUSES.has(review.status)
    || typeof review.reviewHash !== "string" || !HASH.test(review.reviewHash)
    || !Array.isArray(review.events)) return null;
  return proposal;
}

function rowToProposal(row: Record<string, unknown>): StoredLearningProposal {
  if (!isPlainRecord(row)) throw invalid("learning_proposal_versions row is malformed");
  const proposal = verifyProposalShape(json(row.payload));
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
  if (!proposal || !tenantId || !workspaceId || !accountId || !playVersionId
    || supersedes === undefined
    || proposal.versionId !== row.version_id || proposal.tenantId !== tenantId
    || proposal.workspaceId !== workspaceId || proposal.accountId !== accountId
    || proposal.playVersionId !== playVersionId
    || proposal.stableKey !== row.stable_key || proposal.revision !== row.revision
    || proposal.supersedesVersionId !== supersedes
    || proposal.review.status !== row.review_status
    || proposal.metric.metricKey !== row.metric_key
    || proposal.contentHash !== `sha256:${row.content_sha256}`
    || proposal.versionHash !== `sha256:${row.version_sha256}`
    || proposal.review.reviewHash !== `sha256:${row.review_sha256}`
    || proposal.createdAt !== iso(row.created_at)) {
    throw invalid("learning_proposal_versions payload is inconsistent with its relational columns");
  }
  return Object.freeze({
    tenantId,
    workspaceId,
    accountId,
    playVersionId,
    stableKey: proposal.stableKey,
    revision: proposal.revision,
    proposal,
    createdAt: proposal.createdAt,
  });
}

const VERSION_SELECT =
  `SELECT version_id, tenant_id, workspace_id, account_id, play_version_id, stable_key,
    revision, supersedes_version_id, review_status, metric_key,
    content_sha256, version_sha256, review_sha256, payload, created_at
   FROM public.learning_proposal_versions`;

export function createPostgresLearningRepository(db: DbClient): LearningRepository {
  if (!db || typeof db.prepare !== "function") throw new TypeError("A database client is required");

  const repository: LearningRepository = {
    async insertVersion(proposal) {
      const inserted = await db.prepare(
        `INSERT INTO public.learning_proposal_versions
          (version_id, tenant_id, workspace_id, account_id, play_version_id, stable_key,
           revision, supersedes_version_id, review_status, metric_key,
           content_sha256, version_sha256, review_sha256, payload, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?::jsonb, ?)
         ON CONFLICT (version_id) DO NOTHING RETURNING version_id`,
      ).all(
        proposal.versionId, proposal.tenantId, proposal.workspaceId, proposal.accountId,
        proposal.playVersionId, proposal.stableKey, proposal.revision,
        proposal.supersedesVersionId, proposal.review.status, proposal.metric.metricKey,
        proposal.contentHash.slice(7), proposal.versionHash.slice(7),
        proposal.review.reviewHash.slice(7), JSON.stringify(proposal), proposal.createdAt,
      );
      if (!Array.isArray(inserted) || isProxy(inserted)) throw invalid("bad proposal insert result");
      return inserted.length === 1 ? "created" : "replayed";
    },

    async getVersion(tenantId, workspaceId, accountId, versionId) {
      const row = await db.prepare(
        `${VERSION_SELECT} WHERE tenant_id = ? AND workspace_id = ? AND account_id = ?
         AND version_id = ?`,
      ).get(tenantId, workspaceId, accountId, versionId);
      if (row === undefined) return null;
      return rowToProposal(row);
    },

    async getLatestVersion(tenantId, workspaceId, accountId, playVersionId, stableKey) {
      const row = await db.prepare(
        `${VERSION_SELECT} WHERE tenant_id = ? AND workspace_id = ? AND account_id = ?
         AND play_version_id = ? AND stable_key = ?
         ORDER BY revision DESC LIMIT 1`,
      ).get(tenantId, workspaceId, accountId, playVersionId, stableKey);
      if (row === undefined) return null;
      return rowToProposal(row);
    },

    async listVersions(tenantId, workspaceId, filter) {
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
         ORDER BY account_id, play_version_id, stable_key, revision ASC LIMIT 1000`,
      ).all(...values);
      if (!Array.isArray(rows) || isProxy(rows)) throw invalid("bad proposal list result");
      return Object.freeze(rows.map(rowToProposal));
    },

    async updateReview(expectedReviewHash, proposal) {
      const result = await db.prepare(
        `UPDATE public.learning_proposal_versions
          SET review_status = ?, review_sha256 = ?, payload = ?::jsonb
          WHERE version_id = ? AND tenant_id = ? AND workspace_id = ? AND account_id = ?
            AND review_sha256 = ?`,
      ).run(
        proposal.review.status, proposal.review.reviewHash.slice(7), JSON.stringify(proposal),
        proposal.versionId, proposal.tenantId, proposal.workspaceId, proposal.accountId,
        expectedReviewHash.startsWith("sha256:") ? expectedReviewHash.slice(7) : expectedReviewHash,
      );
      if (!result || result.changes !== 1) {
        throw conflict("The proposal review changed concurrently.");
      }
    },
  };
  return Object.freeze(repository);
}
