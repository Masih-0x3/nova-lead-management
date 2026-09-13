import { createHash } from "node:crypto";
import { isProxy } from "node:util/types";

import type { DbClient } from "@/lib/db";
import {
  parseCurrentState,
  type OutreachDraft,
  type OutreachDraftCurrentState,
  type OutreachDraftReviewSnapshot,
} from "@/lib/outreach/draft-review";
import type { OutreachExportReceipt } from "@/lib/outreach/export-receipt";
import type { OutreachPolicyDecision } from "@/lib/outreach/policy-gate";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const SAFE_REF = /^[A-Za-z0-9][A-Za-z0-9:._/-]{0,254}$/u;
const HASH = /^sha256:[0-9a-f]{64}$/u;
const VERSION_ID = /^outreach-draft-version:[0-9a-f]{64}$/u;
const RECEIPT_ID = /^outreach-export-receipt:[0-9a-f]{64}$/u;
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u;

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value) || isProxy(value)) return false;
  try {
    const prototype = Object.getPrototypeOf(value);
    return prototype === Object.prototype || prototype === null;
  } catch {
    return false;
  }
}

export class OutreachRepositoryError extends Error {
  readonly code: "OUTREACH_PERSISTENCE_INVALID" | "OUTREACH_PERSISTENCE_CONFLICT";

  constructor(code: OutreachRepositoryError["code"], message: string) {
    super(message);
    this.name = "OutreachRepositoryError";
    this.code = code;
  }
}

function invalid(message: string): OutreachRepositoryError {
  return new OutreachRepositoryError("OUTREACH_PERSISTENCE_INVALID", message);
}

function conflict(message: string): OutreachRepositoryError {
  return new OutreachRepositoryError("OUTREACH_PERSISTENCE_CONFLICT", message);
}

function sha256(value: unknown): string {
  return `sha256:${createHash("sha256").update(JSON.stringify(value), "utf8").digest("hex")}`;
}

/** Source binding persisted alongside a draft for handoff revalidation. */
export type OutreachSourceBinding = Readonly<{
  claimId: string;
  sourceKey: string;
  sourceKind: "knowledge" | "account";
  sourceVersionId: string;
  locator: string;
  statement: string;
  /** Live-source locator for revalidation (claim id, account version, contact version). */
  resolution: Readonly<{
    kind: "understanding_fact" | "account_profile" | "contact_role";
    factClaimId?: string;
    factEvidenceId?: string;
    understandingVersionId?: string;
    accountVersion?: number;
    contactVersionId?: string;
    contactStableKey?: string;
  }>;
}>;

export type OutreachEvidencePayload = Readonly<{
  citations: readonly unknown[];
  evidence: readonly unknown[];
  bindings: readonly OutreachSourceBinding[];
}>;

export interface StoredOutreachDraft {
  readonly tenantId: string;
  readonly workspaceId: string;
  readonly accountId: string;
  readonly stableKey: string;
  readonly revision: number;
  readonly draftKind: string;
  readonly playVersionId: string | null;
  readonly contactVersionId: string | null;
  readonly agentRunId: string | null;
  readonly agentResultRef: string | null;
  readonly createdBy: string;
  readonly draft: OutreachDraft;
  readonly evidencePayload: OutreachEvidencePayload;
  readonly createdAt: string;
}

export interface StoredOutreachCurrentState {
  readonly tenantId: string;
  readonly workspaceId: string;
  readonly accountId: string;
  readonly stableKey: string;
  readonly state: OutreachDraftCurrentState;
  readonly updatedAt: string;
}

/**
 * One immutable handoff-attempt record. Blocked attempts carry a domain
 * policy decision when the gate produced one plus a service-level block code;
 * released attempts carry the export receipt. No attempt ever carries
 * delivery, send, or provider state.
 */
export interface StoredOutreachHandoffAttempt {
  readonly tenantId: string;
  readonly workspaceId: string;
  readonly accountId: string;
  readonly stableKey: string;
  readonly attemptId: string;
  readonly action: "copy" | "export";
  readonly status: "blocked" | "released";
  readonly blockCode: string | null;
  readonly decision: OutreachPolicyDecision | null;
  readonly receipt: OutreachExportReceipt | null;
  readonly draftVersionId: string;
  readonly contactVersionId: string | null;
  readonly contactStableKey: string | null;
  readonly actorId: string;
  readonly decidedAt: string;
  readonly completedAt: string | null;
  readonly plannedAt: string;
  readonly recipientLocalDay: string | null;
  readonly idempotencyKey: string;
}

export interface OutreachRepository {
  insertDraftVersion(record: StoredOutreachDraft): Promise<"created" | "replayed">;
  getDraftVersion(
    tenantId: string, workspaceId: string, accountId: string, versionId: string,
  ): Promise<StoredOutreachDraft | null>;
  getLatestDraftVersion(
    tenantId: string, workspaceId: string, accountId: string, stableKey: string,
  ): Promise<StoredOutreachDraft | null>;
  listDraftVersions(
    tenantId: string, workspaceId: string, filter?: Readonly<{ accountId?: string }>,
  ): Promise<readonly StoredOutreachDraft[]>;
  updateDraftReview(expectedReviewHash: string, record: StoredOutreachDraft): Promise<void>;

  insertCurrentState(record: StoredOutreachCurrentState): Promise<"created" | "replayed">;
  getCurrentState(
    tenantId: string, workspaceId: string, accountId: string, stableKey: string,
  ): Promise<StoredOutreachCurrentState | null>;
  updateCurrentState(expectedStateHash: string, record: StoredOutreachCurrentState): Promise<void>;

  insertHandoffAttempt(
    record: StoredOutreachHandoffAttempt, inputHash: string,
  ): Promise<"created" | "replayed">;
  getHandoffAttemptByIdempotency(
    tenantId: string, workspaceId: string, accountId: string, idempotencyKey: string,
  ): Promise<Readonly<{ attempt: StoredOutreachHandoffAttempt; inputHash: string }> | null>;
  listHandoffAttempts(
    tenantId: string, workspaceId: string,
    filter?: Readonly<{ accountId?: string; stableKey?: string; contactStableKey?: string }>,
  ): Promise<readonly StoredOutreachHandoffAttempt[]>;
  countContactDayReleasedAttempts(
    tenantId: string, workspaceId: string, accountId: string,
    contactStableKey: string, recipientLocalDay: string,
  ): Promise<number>;
}

function iso(value: unknown): string {
  return value instanceof Date ? value.toISOString()
    : typeof value === "string" && ISO.test(value) ? value
      : (() => { throw invalid("bad timestamp"); })();
}

function json(value: unknown): unknown {
  return typeof value === "string" ? JSON.parse(value) : value;
}

function jsonText(value: unknown): string {
  return JSON.stringify(value);
}

/**
 * Re-derives the version identity from the persisted draft payload and checks
 * every relational column against it. A drifted row is an integrity
 * violation, never a normal read.
 */
function verifyDraftPayload(payload: unknown): OutreachDraft | null {
  if (!isPlainRecord(payload)) return null;
  const draft = payload as unknown as OutreachDraft;
  const scopeOk = typeof draft.tenantId === "string" && UUID.test(draft.tenantId)
    && typeof draft.workspaceId === "string" && UUID.test(draft.workspaceId)
    && typeof draft.accountId === "string" && UUID.test(draft.accountId)
    && typeof draft.stableKey === "string" && SAFE_REF.test(draft.stableKey);
  if (!scopeOk || draft.schemaVersion !== 1 || !Number.isSafeInteger(draft.revision)
    || draft.revision < 1 || typeof draft.createdAt !== "string" || !ISO.test(draft.createdAt)
    || typeof draft.subject !== "string" || typeof draft.body !== "string"
    || typeof draft.contentHash !== "string" || !HASH.test(draft.contentHash)
    || typeof draft.validationHash !== "string" || !HASH.test(draft.validationHash)
    || typeof draft.evidenceDigest !== "string" || !HASH.test(draft.evidenceDigest)
    || typeof draft.versionHash !== "string" || !HASH.test(draft.versionHash)
    || typeof draft.versionId !== "string" || !VERSION_ID.test(draft.versionId)
    || (draft.revision === 1 ? draft.supersedesVersionId !== null
      : !(typeof draft.supersedesVersionId === "string" && VERSION_ID.test(draft.supersedesVersionId)))) {
    return null;
  }
  const contentHash = sha256({ subject: draft.subject, body: draft.body });
  if (contentHash !== draft.contentHash) return null;
  const versionHash = sha256({
    tenantId: draft.tenantId, workspaceId: draft.workspaceId, accountId: draft.accountId,
    stableKey: draft.stableKey, revision: draft.revision,
    supersedesVersionId: draft.supersedesVersionId, createdAt: draft.createdAt,
    contentHash: draft.contentHash, evidenceDigest: draft.evidenceDigest,
  });
  if (versionHash !== draft.versionHash
    || draft.versionId !== `outreach-draft-version:${versionHash.slice("sha256:".length)}`) {
    return null;
  }
  const review = draft.review as OutreachDraftReviewSnapshot | undefined;
  if (!review || review.versionId !== draft.versionId || review.versionHash !== draft.versionHash
    || review.stableKey !== draft.stableKey || review.revision !== draft.revision
    || review.tenantId !== draft.tenantId || review.workspaceId !== draft.workspaceId
    || review.accountId !== draft.accountId || review.contentHash !== draft.contentHash
    || review.validationHash !== draft.validationHash || review.evidenceDigest !== draft.evidenceDigest
    || typeof review.reviewHash !== "string" || !HASH.test(review.reviewHash)
    || (review.status !== "draft" && review.status !== "in_review"
      && review.status !== "approved" && review.status !== "rejected")) {
    return null;
  }
  return draft;
}

function verifyEvidencePayload(value: unknown): OutreachEvidencePayload | null {
  if (!isPlainRecord(value)) return null;
  const citations = value.citations;
  const evidence = value.evidence;
  const bindings = value.bindings;
  if (!Array.isArray(citations) || isProxy(citations) || citations.length > 256
    || !Array.isArray(evidence) || isProxy(evidence) || evidence.length > 256
    || !Array.isArray(bindings) || isProxy(bindings) || bindings.length > 256) return null;
  for (const binding of bindings) {
    if (!isPlainRecord(binding) || typeof binding.claimId !== "string"
      || typeof binding.sourceKey !== "string"
      || (binding.sourceKind !== "knowledge" && binding.sourceKind !== "account")
      || typeof binding.sourceVersionId !== "string" || typeof binding.locator !== "string"
      || typeof binding.statement !== "string" || !isPlainRecord(binding.resolution)
      || typeof binding.resolution.kind !== "string") return null;
  }
  return Object.freeze({
    citations: Object.freeze([...citations]),
    evidence: Object.freeze([...evidence]),
    bindings: Object.freeze([...bindings]) as readonly OutreachSourceBinding[],
  });
}

function rowToDraft(row: Record<string, unknown>): StoredOutreachDraft {
  if (!isPlainRecord(row)) throw invalid("outreach_draft_versions row is malformed");
  const draft = verifyDraftPayload(json(row.payload));
  const evidencePayload = verifyEvidencePayload(json(row.evidence_payload));
  const tenantId = typeof row.tenant_id === "string" && UUID.test(row.tenant_id)
    ? row.tenant_id : null;
  const workspaceId = typeof row.workspace_id === "string" && UUID.test(row.workspace_id)
    ? row.workspace_id : null;
  const accountId = typeof row.account_id === "string" && UUID.test(row.account_id)
    ? row.account_id : null;
  const supersedes = row.supersedes_version_id === null || row.supersedes_version_id === undefined
    ? null
    : typeof row.supersedes_version_id === "string" && VERSION_ID.test(row.supersedes_version_id)
      ? row.supersedes_version_id : undefined;
  const playVersionId = row.play_version_id === null || row.play_version_id === undefined
    ? null : typeof row.play_version_id === "string" ? row.play_version_id : undefined;
  const contactVersionId = row.contact_version_id === null || row.contact_version_id === undefined
    ? null : typeof row.contact_version_id === "string" ? row.contact_version_id : undefined;
  const agentRunId = row.agent_run_id === null || row.agent_run_id === undefined
    ? null : typeof row.agent_run_id === "string" && UUID.test(row.agent_run_id)
      ? row.agent_run_id : undefined;
  const agentResultRef = row.agent_result_ref === null || row.agent_result_ref === undefined
    ? null : typeof row.agent_result_ref === "string" ? row.agent_result_ref : undefined;
  const createdBy = typeof row.created_by === "string" && UUID.test(row.created_by)
    ? row.created_by : null;
  if (!draft || !evidencePayload || !tenantId || !workspaceId || !accountId
    || supersedes === undefined || playVersionId === undefined || contactVersionId === undefined
    || agentRunId === undefined || agentResultRef === undefined || !createdBy
    || draft.versionId !== row.version_id || draft.tenantId !== tenantId
    || draft.workspaceId !== workspaceId || draft.accountId !== accountId
    || draft.stableKey !== row.stable_key || draft.revision !== row.revision
    || draft.supersedesVersionId !== supersedes
    || draft.review.status !== row.review_status
    || draft.contentHash !== `sha256:${row.content_sha256}`
    || draft.validationHash !== `sha256:${row.validation_sha256}`
    || draft.evidenceDigest !== `sha256:${row.evidence_sha256}`
    || draft.versionHash !== `sha256:${row.version_sha256}`
    || draft.review.reviewHash !== `sha256:${row.review_sha256}`
    || draft.createdAt !== iso(row.created_at)) {
    throw invalid("outreach_draft_versions payload is inconsistent with its relational columns");
  }
  return Object.freeze({
    tenantId, workspaceId, accountId,
    stableKey: draft.stableKey,
    revision: draft.revision,
    draftKind: typeof row.draft_kind === "string" ? row.draft_kind
      : (() => { throw invalid("bad draft kind"); })(),
    playVersionId,
    contactVersionId,
    agentRunId,
    agentResultRef,
    createdBy,
    draft,
    evidencePayload,
    createdAt: draft.createdAt,
  });
}

/**
 * The domain parser rebuilds every nested record in the exact key order the
 * builder hashed before recomputing `stateHash`; hashing the raw jsonb payload
 * would fail because Postgres does not preserve object key order.
 */
function verifyCurrentStatePayload(payload: unknown): OutreachDraftCurrentState | null {
  return parseCurrentState(payload);
}

function rowToCurrent(row: Record<string, unknown>): StoredOutreachCurrentState {
  if (!isPlainRecord(row)) throw invalid("outreach_draft_current row is malformed");
  const state = verifyCurrentStatePayload(json(row.payload));
  if (!state || state.tenantId !== row.tenant_id || state.workspaceId !== row.workspace_id
    || state.accountId !== row.account_id || state.stableKey !== row.stable_key
    || state.stateHash !== `sha256:${row.state_sha256}`) {
    throw invalid("outreach_draft_current payload is inconsistent with its relational columns");
  }
  return Object.freeze({
    tenantId: state.tenantId,
    workspaceId: state.workspaceId,
    accountId: state.accountId,
    stableKey: state.stableKey,
    state,
    updatedAt: iso(row.updated_at),
  });
}

/**
 * Both verifiers rebuild the hashed payload in the exact key order the domain
 * builders used, because the stored jsonb document does not preserve the
 * writer's key order and a raw `JSON.stringify` of it cannot reproduce the hash.
 */
function verifyReceiptPayload(payload: unknown): OutreachExportReceipt | null {
  if (!isPlainRecord(payload)) return null;
  const receipt = payload as unknown as OutreachExportReceipt;
  const draft = isPlainRecord(receipt.draft) ? receipt.draft : null;
  const policy = isPlainRecord(receipt.policy) ? receipt.policy : null;
  const actor = isPlainRecord(receipt.actor) ? receipt.actor : null;
  if (receipt.receiptVersion !== 1 || typeof receipt.receiptId !== "string"
    || !RECEIPT_ID.test(receipt.receiptId)
    || (receipt.action !== "copy" && receipt.action !== "export")
    || receipt.completion !== "caller_attested"
    || typeof receipt.receiptHash !== "string" || !HASH.test(receipt.receiptHash)
    || !draft || !policy || !actor) return null;
  const canonical = {
    receiptVersion: 1,
    tenantId: receipt.tenantId,
    workspaceId: receipt.workspaceId,
    accountId: receipt.accountId,
    action: receipt.action,
    completion: "caller_attested",
    idempotencyKey: receipt.idempotencyKey,
    draft: { versionId: draft.versionId, stateHash: draft.stateHash, reviewHash: draft.reviewHash },
    policy: {
      decisionHash: policy.decisionHash, policyVersion: policy.policyVersion, purpose: policy.purpose,
    },
    actor: { kind: actor.kind, actorId: actor.actorId },
    decidedAt: receipt.decidedAt,
    completedAt: receipt.completedAt,
  };
  if (sha256(canonical) !== receipt.receiptHash
    || receipt.receiptId !== `outreach-export-receipt:${receipt.receiptHash.slice("sha256:".length)}`) {
    return null;
  }
  return receipt;
}

function verifyDecisionPayload(payload: unknown): OutreachPolicyDecision | null {
  if (!isPlainRecord(payload)) return null;
  const decision = payload as unknown as OutreachPolicyDecision;
  const draft = isPlainRecord(decision.draft) ? decision.draft : null;
  const contact = isPlainRecord(decision.contact) ? decision.contact : null;
  const actor = isPlainRecord(decision.actor) ? decision.actor : null;
  if (decision.decisionVersion !== 1
    || (decision.result !== "allow" && decision.result !== "deny")
    || (decision.action !== "copy" && decision.action !== "export")
    || typeof decision.decisionHash !== "string" || !HASH.test(decision.decisionHash)
    || !draft || !contact || !actor || !Array.isArray(decision.reasons)) return null;
  const canonical = {
    decisionVersion: 1,
    tenantId: decision.tenantId,
    workspaceId: decision.workspaceId,
    accountId: decision.accountId,
    result: decision.result,
    action: decision.action,
    reasons: [...decision.reasons],
    draft: { versionId: draft.versionId, stateHash: draft.stateHash, reviewHash: draft.reviewHash },
    contact: {
      versionId: contact.versionId, contentHash: contact.contentHash, reviewHash: contact.reviewHash,
    },
    policyVersion: decision.policyVersion,
    purpose: decision.purpose,
    actor: { kind: actor.kind, actorId: actor.actorId },
    decidedAt: decision.decidedAt,
  };
  if (sha256(canonical) !== decision.decisionHash) return null;
  return decision;
}

function rowToAttempt(row: Record<string, unknown>): StoredOutreachHandoffAttempt {
  if (!isPlainRecord(row)) throw invalid("outreach_handoff_attempts row is malformed");
  const payload = json(row.payload);
  if (!isPlainRecord(payload)) throw invalid("outreach_handoff_attempts payload is malformed");
  const decision = payload.decision === null || payload.decision === undefined
    ? null : verifyDecisionPayload(payload.decision);
  const receipt = payload.receipt === null || payload.receipt === undefined
    ? null : verifyReceiptPayload(payload.receipt);
  if (payload.decision !== null && payload.decision !== undefined && !decision) {
    throw invalid("outreach_handoff_attempts decision payload is invalid");
  }
  if (payload.receipt !== null && payload.receipt !== undefined && !receipt) {
    throw invalid("outreach_handoff_attempts receipt payload is invalid");
  }
  const status = row.status;
  const tenantId = typeof row.tenant_id === "string" && UUID.test(row.tenant_id)
    ? row.tenant_id : undefined;
  const workspaceId = typeof row.workspace_id === "string" && UUID.test(row.workspace_id)
    ? row.workspace_id : undefined;
  const accountId = typeof row.account_id === "string" && UUID.test(row.account_id)
    ? row.account_id : undefined;
  const blockCode = row.block_code === null || row.block_code === undefined
    ? null : typeof row.block_code === "string" ? row.block_code : undefined;
  const contactVersionId = row.contact_version_id === null || row.contact_version_id === undefined
    ? null : typeof row.contact_version_id === "string" ? row.contact_version_id : undefined;
  const contactStableKey = row.contact_stable_key === null || row.contact_stable_key === undefined
    ? null
    : typeof row.contact_stable_key === "string" && SAFE_REF.test(row.contact_stable_key)
      ? row.contact_stable_key : undefined;
  const recipientLocalDay = row.recipient_local_day === null || row.recipient_local_day === undefined
    ? null : typeof row.recipient_local_day === "string" ? row.recipient_local_day : undefined;
  const completedAt = row.completed_at === null || row.completed_at === undefined
    ? null : iso(row.completed_at);
  if ((status !== "blocked" && status !== "released") || blockCode === undefined
    || !tenantId || !workspaceId || !accountId
    || contactVersionId === undefined || contactStableKey === undefined
    || recipientLocalDay === undefined || typeof row.attempt_id !== "string"
    || typeof row.draft_version_id !== "string" || !VERSION_ID.test(row.draft_version_id)
    || (row.action !== "copy" && row.action !== "export")
    || typeof row.actor_id !== "string" || !UUID.test(row.actor_id)
    || typeof row.idempotency_key !== "string"
    || typeof row.stable_key !== "string" || !SAFE_REF.test(row.stable_key)
    || (status === "blocked" && (blockCode === null || receipt !== null))
    || (status === "released" && (receipt === null || completedAt === null))) {
    throw invalid("outreach_handoff_attempts row is malformed");
  }
  const attempt: StoredOutreachHandoffAttempt = Object.freeze({
    tenantId,
    workspaceId,
    accountId,
    stableKey: row.stable_key as string,
    attemptId: row.attempt_id as string,
    action: row.action as "copy" | "export",
    status: status as "blocked" | "released",
    blockCode,
    decision,
    receipt,
    draftVersionId: row.draft_version_id as string,
    contactVersionId,
    contactStableKey,
    actorId: row.actor_id as string,
    decidedAt: iso(row.decided_at),
    completedAt,
    plannedAt: iso(row.planned_at),
    recipientLocalDay,
    idempotencyKey: row.idempotency_key as string,
  });
  return attempt;
}

const DRAFT_SELECT =
  `SELECT version_id, tenant_id, workspace_id, account_id, stable_key, revision,
    supersedes_version_id, draft_kind, play_version_id, contact_version_id,
    agent_run_id, agent_result_ref, created_by, review_status, content_sha256, validation_sha256,
    evidence_sha256, version_sha256, review_sha256, payload, evidence_payload, created_at
   FROM public.outreach_draft_versions`;

export function createPostgresOutreachRepository(db: DbClient): OutreachRepository {
  if (!db || typeof db.prepare !== "function") throw new TypeError("A database client is required");

  const repository: OutreachRepository = {
    async insertDraftVersion(record) {
      const draft = record.draft;
      const inserted = await db.prepare(
        `INSERT INTO public.outreach_draft_versions
          (version_id, tenant_id, workspace_id, account_id, stable_key, revision,
           supersedes_version_id, draft_kind, play_version_id, contact_version_id,
           agent_run_id, agent_result_ref, created_by, review_status, content_sha256,
           validation_sha256, evidence_sha256, version_sha256, review_sha256,
           payload, evidence_payload, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?::jsonb, ?::jsonb, ?)
         ON CONFLICT (version_id) DO NOTHING RETURNING version_id`,
      ).all(
        draft.versionId, draft.tenantId, draft.workspaceId, draft.accountId, draft.stableKey,
        draft.revision, draft.supersedesVersionId, record.draftKind, record.playVersionId,
        record.contactVersionId, record.agentRunId, record.agentResultRef, record.createdBy,
        draft.review.status,
        draft.contentHash.slice(7), draft.validationHash.slice(7), draft.evidenceDigest.slice(7),
        draft.versionHash.slice(7), draft.review.reviewHash.slice(7),
        jsonText(draft), jsonText(record.evidencePayload), draft.createdAt,
      );
      if (!Array.isArray(inserted) || isProxy(inserted)) throw invalid("bad draft insert result");
      return inserted.length === 1 ? "created" : "replayed";
    },

    async getDraftVersion(tenantId, workspaceId, accountId, versionId) {
      const row = await db.prepare(
        `${DRAFT_SELECT} WHERE tenant_id = ? AND workspace_id = ? AND account_id = ? AND version_id = ?`,
      ).get(tenantId, workspaceId, accountId, versionId);
      if (row === undefined) return null;
      return rowToDraft(row);
    },

    async getLatestDraftVersion(tenantId, workspaceId, accountId, stableKey) {
      const row = await db.prepare(
        `${DRAFT_SELECT} WHERE tenant_id = ? AND workspace_id = ? AND account_id = ? AND stable_key = ?
         ORDER BY revision DESC LIMIT 1`,
      ).get(tenantId, workspaceId, accountId, stableKey);
      if (row === undefined) return null;
      return rowToDraft(row);
    },

    async listDraftVersions(tenantId, workspaceId, filter) {
      const rows = filter?.accountId === undefined
        ? await db.prepare(
          `${DRAFT_SELECT} WHERE tenant_id = ? AND workspace_id = ?
           ORDER BY account_id, stable_key, revision DESC LIMIT 1000`,
        ).all(tenantId, workspaceId)
        : await db.prepare(
          `${DRAFT_SELECT} WHERE tenant_id = ? AND workspace_id = ? AND account_id = ?
           ORDER BY stable_key, revision DESC LIMIT 1000`,
        ).all(tenantId, workspaceId, filter.accountId);
      if (!Array.isArray(rows) || isProxy(rows)) throw invalid("bad draft list result");
      return Object.freeze(rows.map(rowToDraft));
    },

    async updateDraftReview(expectedReviewHash, record) {
      const draft = record.draft;
      const result = await db.prepare(
        `UPDATE public.outreach_draft_versions
          SET review_status = ?, review_sha256 = ?, payload = ?::jsonb
          WHERE version_id = ? AND tenant_id = ? AND workspace_id = ? AND account_id = ?
            AND review_sha256 = ?`,
      ).run(
        draft.review.status, draft.review.reviewHash.slice(7), jsonText(draft),
        draft.versionId, draft.tenantId, draft.workspaceId, draft.accountId,
        expectedReviewHash.startsWith("sha256:") ? expectedReviewHash.slice(7) : expectedReviewHash,
      );
      if (!result || result.changes !== 1) {
        throw conflict("The draft review changed concurrently.");
      }
    },

    async insertCurrentState(record) {
      const inserted = await db.prepare(
        `INSERT INTO public.outreach_draft_current
          (tenant_id, workspace_id, account_id, stable_key, state_sha256, payload, updated_at)
         VALUES (?, ?, ?, ?, ?, ?::jsonb, ?)
         ON CONFLICT (tenant_id, workspace_id, account_id, stable_key) DO NOTHING
         RETURNING stable_key`,
      ).all(
        record.tenantId, record.workspaceId, record.accountId, record.stableKey,
        record.state.stateHash.slice(7), jsonText(record.state), record.updatedAt,
      );
      if (!Array.isArray(inserted) || isProxy(inserted)) throw invalid("bad current insert result");
      return inserted.length === 1 ? "created" : "replayed";
    },

    async getCurrentState(tenantId, workspaceId, accountId, stableKey) {
      const row = await db.prepare(
        `SELECT tenant_id, workspace_id, account_id, stable_key, state_sha256, payload, updated_at
         FROM public.outreach_draft_current
         WHERE tenant_id = ? AND workspace_id = ? AND account_id = ? AND stable_key = ?`,
      ).get(tenantId, workspaceId, accountId, stableKey);
      if (row === undefined) return null;
      return rowToCurrent(row);
    },

    async updateCurrentState(expectedStateHash, record) {
      const result = await db.prepare(
        `UPDATE public.outreach_draft_current
          SET state_sha256 = ?, payload = ?::jsonb, updated_at = ?
          WHERE tenant_id = ? AND workspace_id = ? AND account_id = ? AND stable_key = ?
            AND state_sha256 = ?`,
      ).run(
        record.state.stateHash.slice(7), jsonText(record.state), record.updatedAt,
        record.tenantId, record.workspaceId, record.accountId, record.stableKey,
        expectedStateHash.startsWith("sha256:") ? expectedStateHash.slice(7) : expectedStateHash,
      );
      if (!result || result.changes !== 1) {
        throw conflict("The current draft state changed concurrently.");
      }
    },

    async insertHandoffAttempt(record, inputHash) {
      const payload = {
        status: record.status,
        blockCode: record.blockCode,
        decision: record.decision,
        receipt: record.receipt,
      };
      const inserted = await db.prepare(
        `INSERT INTO public.outreach_handoff_attempts
          (attempt_id, tenant_id, workspace_id, account_id, stable_key, draft_version_id,
           action, status, block_code, contact_version_id, contact_stable_key,
           idempotency_key, input_sha256, actor_id, decided_at, completed_at,
           planned_at, recipient_local_day, payload)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?::jsonb)
         ON CONFLICT (tenant_id, workspace_id, account_id, idempotency_key) DO NOTHING
         RETURNING attempt_id`,
      ).all(
        record.attemptId, record.tenantId, record.workspaceId, record.accountId,
        record.stableKey, record.draftVersionId, record.action, record.status,
        record.blockCode, record.contactVersionId, record.contactStableKey,
        record.idempotencyKey, inputHash.slice(7), record.actorId, record.decidedAt,
        record.completedAt, record.plannedAt, record.recipientLocalDay, jsonText(payload),
      );
      if (!Array.isArray(inserted) || isProxy(inserted)) throw invalid("bad attempt insert result");
      return inserted.length === 1 ? "created" : "replayed";
    },

    async getHandoffAttemptByIdempotency(tenantId, workspaceId, accountId, idempotencyKey) {
      const row = await db.prepare(
        `SELECT * FROM public.outreach_handoff_attempts
         WHERE tenant_id = ? AND workspace_id = ? AND account_id = ? AND idempotency_key = ?`,
      ).get(tenantId, workspaceId, accountId, idempotencyKey);
      if (row === undefined) return null;
      const attempt = rowToAttempt(row as Record<string, unknown>);
      const inputHash = typeof (row as Record<string, unknown>).input_sha256 === "string"
        ? `sha256:${(row as Record<string, unknown>).input_sha256}` : null;
      if (!inputHash || !HASH.test(inputHash)) throw invalid("bad attempt input hash");
      return Object.freeze({ attempt, inputHash });
    },

    async listHandoffAttempts(tenantId, workspaceId, filter) {
      const conditions = ["tenant_id = ?", "workspace_id = ?"];
      const values: unknown[] = [tenantId, workspaceId];
      if (filter?.accountId !== undefined) {
        values.push(filter.accountId);
        conditions.push("account_id = ?");
      }
      if (filter?.stableKey !== undefined) {
        values.push(filter.stableKey);
        conditions.push("stable_key = ?");
      }
      if (filter?.contactStableKey !== undefined) {
        values.push(filter.contactStableKey);
        conditions.push("contact_stable_key = ?");
      }
      const rows = await db.prepare(
        `SELECT * FROM public.outreach_handoff_attempts
         WHERE ${conditions.join(" AND ")}
         ORDER BY decided_at ASC, attempt_id ASC LIMIT 1000`,
      ).all(...values);
      if (!Array.isArray(rows) || isProxy(rows)) throw invalid("bad attempt list result");
      return Object.freeze(rows.map(rowToAttempt));
    },

    async countContactDayReleasedAttempts(
      tenantId, workspaceId, accountId, contactStableKey, recipientLocalDay,
    ) {
      const row = await db.prepare(
        `SELECT COUNT(*)::text AS count FROM public.outreach_handoff_attempts
         WHERE tenant_id = ? AND workspace_id = ? AND account_id = ?
           AND contact_stable_key = ? AND recipient_local_day = ? AND status = 'released'`,
      ).get(tenantId, workspaceId, accountId, contactStableKey, recipientLocalDay);
      const count = row && typeof (row as Record<string, unknown>).count === "string"
        ? Number((row as Record<string, unknown>).count) : Number.NaN;
      if (!Number.isSafeInteger(count) || count < 0) throw invalid("bad attempt count result");
      return count;
    },
  };
  return Object.freeze(repository);
}
