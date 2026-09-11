import "server-only";

import { createHash } from "node:crypto";
import { isProxy } from "node:util/types";

import type { DbClient } from "@/lib/db";
import type {
  BusinessUnderstandingReviewEvent,
  BusinessUnderstandingReviewSnapshot,
} from "@/lib/understanding/business-understanding";
import type {
  QuestionAnswerRecord,
  AnswerClaimUpdateProposal,
} from "@/lib/understanding/question-planner";
import type {
  QuestionRepository,
  StoredQuestionSession,
} from "@/lib/understanding/question-service";
import type {
  StoredUnderstandingVersion,
  UnderstandingRepository,
  UnderstandingScope,
} from "@/lib/understanding/service";

/**
 * Postgres repositories for L-04 understanding + adaptive questions.
 *
 * Writes go through the `novatrade_l04_*` SECURITY DEFINER capabilities
 * (member-gated, idempotent, scope-checked); reads are plain SELECTs under the
 * caller's installed tenant GUCs and the `l04_*_member_select` policies.
 */

function parseJson(value: unknown): unknown {
  if (typeof value === "string") return JSON.parse(value);
  return value;
}

function iso(value: unknown): string {
  if (value instanceof Date) return value.toISOString();
  const text = String(value);
  const parsed = Date.parse(text);
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : text;
}

interface UnderstandingRow {
  readonly version_id: string;
  readonly tenant_id: string;
  readonly workspace_id: string | null;
  readonly proposal_ref: string;
  readonly revision: number | string;
  readonly supersedes_proposal_ref: string | null;
  readonly supersedes_version_id: string | null;
  readonly content_hash: string;
  readonly claim_set_hash: string;
  readonly review_hash: string;
  readonly status: string;
  readonly source: unknown;
  readonly review: unknown;
  readonly created_at: unknown;
  readonly updated_at: unknown;
}

const UNDERSTANDING_SELECT = `SELECT version_id,tenant_id::text AS tenant_id,
  workspace_id::text AS workspace_id,proposal_ref,revision,supersedes_proposal_ref,
  supersedes_version_id,content_hash,claim_set_hash,review_hash,status,source,review,
  created_at,updated_at
  FROM public.business_understanding_versions`;

function mapUnderstanding(row: UnderstandingRow): StoredUnderstandingVersion {
  return Object.freeze({
    tenantId: row.tenant_id,
    workspaceId: row.workspace_id,
    versionId: row.version_id,
    proposalRef: row.proposal_ref,
    revision: Number(row.revision),
    supersedesProposalRef: row.supersedes_proposal_ref,
    supersedesVersionId: row.supersedes_version_id,
    contentHash: row.content_hash,
    claimSetHash: row.claim_set_hash,
    source: parseJson(row.source),
    review: parseJson(row.review) as BusinessUnderstandingReviewSnapshot,
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
  });
}

export class PostgresUnderstandingRepository implements UnderstandingRepository {
  constructor(private readonly db: DbClient) {
    if (isProxy(db)) throw new Error("Invalid repository dependency.");
  }

  async getVersion(
    scope: UnderstandingScope,
    versionId: string,
  ): Promise<StoredUnderstandingVersion | null> {
    const row = await this.db.prepare(
      `${UNDERSTANDING_SELECT} WHERE version_id=? AND tenant_id=? AND workspace_id IS NOT DISTINCT FROM ?`,
    ).get<UnderstandingRow>(versionId, scope.tenantId, scope.workspaceId);
    return row ? mapUnderstanding(row) : null;
  }

  async getLatestVersionByProposalRef(
    scope: UnderstandingScope,
    proposalRef: string,
  ): Promise<StoredUnderstandingVersion | null> {
    const row = await this.db.prepare(
      `${UNDERSTANDING_SELECT} WHERE tenant_id=? AND workspace_id IS NOT DISTINCT FROM ?
       AND proposal_ref=? ORDER BY revision DESC, created_at DESC LIMIT 1`,
    ).get<UnderstandingRow>(scope.tenantId, scope.workspaceId, proposalRef);
    return row ? mapUnderstanding(row) : null;
  }

  async listVersions(scope: UnderstandingScope): Promise<readonly StoredUnderstandingVersion[]> {
    const rows = await this.db.prepare(
      `${UNDERSTANDING_SELECT} WHERE tenant_id=? AND workspace_id IS NOT DISTINCT FROM ?
       ORDER BY created_at, version_id`,
    ).all<UnderstandingRow>(scope.tenantId, scope.workspaceId);
    return Object.freeze(rows.map(mapUnderstanding));
  }

  async appendVersion(
    record: StoredUnderstandingVersion,
  ): Promise<"created" | "replayed" | "conflict"> {
    const review = record.review;
    const row = await this.db.prepare(
      "SELECT kind FROM public.novatrade_l04_append_understanding_version(?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
    ).get<{ kind?: unknown }>(
      record.tenantId,
      record.workspaceId,
      record.versionId,
      record.proposalRef,
      String(record.revision),
      record.supersedesProposalRef,
      record.supersedesVersionId,
      record.contentHash,
      record.claimSetHash,
      review.reviewHash,
      "draft",
      JSON.stringify(record.source),
      JSON.stringify(review),
      record.createdAt,
      record.updatedAt,
    );
    return row?.kind === "created" ? "created"
      : row?.kind === "replay" ? "replayed" : "conflict";
  }

  async applyReviewTransition(
    scope: UnderstandingScope,
    versionId: string,
    expectedReviewHash: string,
    review: BusinessUnderstandingReviewSnapshot,
    event: BusinessUnderstandingReviewEvent,
  ): Promise<"updated" | "stale" | "not_found"> {
    const row = await this.db.prepare(
      "SELECT kind FROM public.novatrade_l04_transition_understanding_review(?,?,?,?,?,?,?,?,?)",
    ).get<{ kind?: unknown }>(
      scope.tenantId,
      scope.workspaceId,
      versionId,
      expectedReviewHash,
      event.to,
      review.reviewHash,
      JSON.stringify(review),
      JSON.stringify(event),
      event.at,
    );
    return row?.kind === "updated" ? "updated"
      : row?.kind === "not_found" ? "not_found" : "stale";
  }
}

interface SessionRow {
  readonly session_ref: string;
  readonly tenant_id: string;
  readonly workspace_id: string | null;
  readonly tenant_ref: string;
  readonly understanding_version_id: string;
  readonly session: unknown;
  readonly created_at: unknown;
}

interface AnswerRow {
  readonly answer_id: string;
  readonly session_ref: string;
  readonly question_ref: string;
  readonly uncertainty_id: string;
  readonly disposition: string;
  readonly answer: unknown;
  readonly claim_update: unknown;
  readonly recorded_at: unknown;
}

function mapSession(row: SessionRow): StoredQuestionSession {
  return Object.freeze({
    tenantId: row.tenant_id,
    workspaceId: row.workspace_id,
    tenantRef: row.tenant_ref,
    sessionRef: row.session_ref,
    understandingVersionId: row.understanding_version_id,
    session: parseJson(row.session) as StoredQuestionSession["session"],
    createdAt: iso(row.created_at),
  });
}

export class PostgresQuestionRepository implements QuestionRepository {
  constructor(private readonly db: DbClient) {
    if (isProxy(db)) throw new Error("Invalid repository dependency.");
  }

  async getSession(
    scope: UnderstandingScope,
    sessionRef: string,
  ): Promise<StoredQuestionSession | null> {
    const row = await this.db.prepare(
      `SELECT session_ref,tenant_id::text AS tenant_id,workspace_id::text AS workspace_id,
        tenant_ref,understanding_version_id,session,created_at
       FROM public.adaptive_question_sessions
       WHERE tenant_id=? AND workspace_id IS NOT DISTINCT FROM ? AND session_ref=?`,
    ).get<SessionRow>(scope.tenantId, scope.workspaceId, sessionRef);
    return row ? mapSession(row) : null;
  }

  async appendSession(record: StoredQuestionSession): Promise<"created" | "replayed" | "conflict"> {
    const sessionHash = `sha256:${createHash("sha256")
      .update(JSON.stringify(record.session)).digest("hex")}`;
    const row = await this.db.prepare(
      "SELECT kind FROM public.novatrade_l04_append_question_session(?,?,?,?,?,?,?,?)",
    ).get<{ kind?: unknown }>(
      record.tenantId,
      record.workspaceId,
      record.sessionRef,
      record.tenantRef,
      record.understandingVersionId,
      JSON.stringify(record.session),
      sessionHash,
      record.createdAt,
    );
    return row?.kind === "created" ? "created"
      : row?.kind === "replay" ? "replayed" : "conflict";
  }

  async listAnswers(
    scope: UnderstandingScope,
    tenantRef: string,
    sessionRef: string,
    understandingVersionId: string,
  ): Promise<readonly QuestionAnswerRecord[]> {
    const rows = await this.db.prepare(
      `SELECT answer,recorded_at
       FROM public.adaptive_question_answers
       WHERE tenant_id=? AND workspace_id IS NOT DISTINCT FROM ?
         AND session_ref=? AND tenant_ref=? AND understanding_version_id=?
       ORDER BY recorded_at, answer_id`,
    ).all<AnswerRow>(
      scope.tenantId, scope.workspaceId, sessionRef, tenantRef, understandingVersionId);
    return Object.freeze(rows.map((row) => parseJson(row.answer) as QuestionAnswerRecord));
  }

  async appendAnswer(
    scope: UnderstandingScope,
    answer: QuestionAnswerRecord,
    claimUpdate: AnswerClaimUpdateProposal | null,
  ): Promise<"appended" | "conflict"> {
    const row = await this.db.prepare(
      "SELECT kind FROM public.novatrade_l04_append_question_answer(?,?,?,?,?,?,?,?,?,?,?,?)",
    ).get<{ kind?: unknown }>(
      scope.tenantId,
      scope.workspaceId,
      answer.sessionRef,
      answer.tenantRef,
      answer.understandingVersionId,
      answer.answerId,
      answer.questionRef,
      answer.uncertaintyId,
      answer.disposition,
      JSON.stringify(answer),
      claimUpdate === null ? null : JSON.stringify(claimUpdate),
      answer.recordedAt,
    );
    return row?.kind === "appended" ? "appended" : "conflict";
  }
}

export function createPostgresUnderstandingRepository(db: DbClient): PostgresUnderstandingRepository {
  return new PostgresUnderstandingRepository(db);
}

export function createPostgresQuestionRepository(db: DbClient): PostgresQuestionRepository {
  return new PostgresQuestionRepository(db);
}
