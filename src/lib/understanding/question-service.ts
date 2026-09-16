import "server-only";

import { isProxy } from "node:util/types";

import {
  planAdaptiveQuestionSession,
  recordQuestionAnswer,
  ADAPTIVE_QUESTION_POLICY_VERSION,
  MAX_ADAPTIVE_QUESTIONS_PER_SESSION,
  type AdaptiveQuestionCandidate,
  type AdaptiveQuestionSession,
  type AnswerClaimUpdateProposal,
  type QuestionAnswerRecord,
} from "@/lib/understanding/question-planner";
import {
  hydrateUnderstandingVersion,
  type UnderstandingRepository,
  type UnderstandingScope,
} from "@/lib/understanding/service";

/**
 * Durable boundary for adaptive question sessions (L-04 / 0X3-245).
 *
 * The planner owns ranking, repeat suppression, and answer integrity. This
 * service binds sessions to a persisted understanding version, requires every
 * candidate uncertaintyId to resolve against that version's uncertainty set,
 * persists sessions and answers immutably, and never applies answer-derived
 * claim updates automatically.
 */

export interface StoredQuestionSession {
  readonly tenantId: string;
  readonly workspaceId: string | null;
  readonly tenantRef: string;
  readonly sessionRef: string;
  readonly understandingVersionId: string;
  readonly session: AdaptiveQuestionSession;
  readonly createdAt: string;
}

export interface QuestionRepository {
  getSession(
    scope: UnderstandingScope,
    sessionRef: string,
  ): Promise<StoredQuestionSession | null>;
  appendSession(record: StoredQuestionSession): Promise<"created" | "replayed" | "conflict">;
  listAnswers(
    scope: UnderstandingScope,
    tenantRef: string,
    sessionRef: string,
    understandingVersionId: string,
  ): Promise<readonly QuestionAnswerRecord[]>;
  appendAnswer(
    scope: UnderstandingScope,
    answer: QuestionAnswerRecord,
    claimUpdate: AnswerClaimUpdateProposal | null,
  ): Promise<"appended" | "conflict">;
}

export type QuestionServiceCode =
  | "QUESTIONS_PLANNED"
  | "NO_ELIGIBLE_QUESTIONS"
  | "QUESTION_SESSION_REPLAYED"
  | "QUESTION_SESSION_LISTED"
  | "ANSWER_RECORDED"
  | "ANSWER_HISTORY_LISTED"
  | "MALFORMED_INPUT"
  | "NOT_FOUND"
  | "PERSISTENCE_CONFLICT";

export type QuestionServiceResult<T = undefined> =
  | Readonly<{ ok: true; code: QuestionServiceCode; value: T }>
  | Readonly<{ ok: false; code: QuestionServiceCode }>;

export interface PlanQuestionSessionRequest {
  readonly sessionRef: string;
  readonly understandingVersionId: string;
  readonly maxQuestions?: number;
  readonly uncertainties: readonly AdaptiveQuestionCandidate[];
}

export interface PlanQuestionSessionDependencies {
  readonly repository: QuestionRepository;
  readonly understanding: UnderstandingRepository;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const REF = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,199}$/u;
const VERSION_ID = /^understanding-version:[a-f0-9]{64}$/u;

function fail(code: QuestionServiceCode): QuestionServiceResult<never> {
  return Object.freeze({ ok: false, code });
}

function validScope(scope: UnderstandingScope): boolean {
  return typeof scope?.tenantId === "string" && UUID.test(scope.tenantId)
    && (scope.workspaceId === null
      || (typeof scope.workspaceId === "string" && UUID.test(scope.workspaceId)));
}

/** Stable, REF-safe tenant reference used inside planner records. */
export function understandingTenantRef(tenantId: string): string {
  return `tenant:${tenantId}`;
}

/**
 * Plans a small grouped question session bound to a stored understanding
 * version. Every candidate's uncertaintyId must resolve against that version's
 * persisted uncertainty set — the session can never ask about uncertainty the
 * understanding did not record.
 */
export async function planQuestionSession(
  scope: UnderstandingScope,
  request: PlanQuestionSessionRequest,
  dependencies: PlanQuestionSessionDependencies,
): Promise<QuestionServiceResult<AdaptiveQuestionSession>> {
  try {
    if (!validScope(scope) || isProxy(request)) return fail("MALFORMED_INPUT");
    if (typeof request.sessionRef !== "string" || !REF.test(request.sessionRef)
      || typeof request.understandingVersionId !== "string"
      || !VERSION_ID.test(request.understandingVersionId)
      || !Array.isArray(request.uncertainties)) {
      return fail("MALFORMED_INPUT");
    }
    const maxQuestions = request.maxQuestions === undefined
      ? MAX_ADAPTIVE_QUESTIONS_PER_SESSION
      : request.maxQuestions;
    if (typeof maxQuestions !== "number" || !Number.isSafeInteger(maxQuestions)
      || maxQuestions < 1 || maxQuestions > MAX_ADAPTIVE_QUESTIONS_PER_SESSION) {
      return fail("MALFORMED_INPUT");
    }

    const understanding = await dependencies.understanding.getVersion(scope, request.understandingVersionId);
    if (!understanding) return fail("NOT_FOUND");
    const hydrated = hydrateUnderstandingVersion(understanding);
    if (!hydrated.ok) return fail("MALFORMED_INPUT");

    const knownUncertaintyIds = new Set(
      hydrated.value.proposal.uncertainties.map((uncertainty) => uncertainty.claimId),
    );
    for (const candidate of request.uncertainties) {
      if (!candidate || typeof candidate.uncertaintyId !== "string"
        || !knownUncertaintyIds.has(candidate.uncertaintyId)) {
        return fail("MALFORMED_INPUT");
      }
    }

    const tenantRef = understandingTenantRef(scope.tenantId);
    const priorAnswers = await dependencies.repository.listAnswers(
      scope,
      tenantRef,
      request.sessionRef,
      request.understandingVersionId,
    );
    const planned = planAdaptiveQuestionSession({
      version: 1,
      policyVersion: ADAPTIVE_QUESTION_POLICY_VERSION,
      tenantRef,
      sessionRef: request.sessionRef,
      understandingVersionId: request.understandingVersionId,
      maxQuestions,
      uncertainties: request.uncertainties,
      answerHistory: priorAnswers,
    });
    if (!planned.ok) return fail("MALFORMED_INPUT");

    const persisted = await dependencies.repository.appendSession(Object.freeze({
      tenantId: scope.tenantId,
      workspaceId: scope.workspaceId,
      tenantRef,
      sessionRef: request.sessionRef,
      understandingVersionId: request.understandingVersionId,
      session: planned.session,
      createdAt: new Date().toISOString(),
    }));
    if (persisted === "conflict") return fail("PERSISTENCE_CONFLICT");
    return Object.freeze({
      ok: true,
      code: persisted === "replayed"
        ? "QUESTION_SESSION_REPLAYED"
        : planned.code === "QUESTIONS_PLANNED" ? "QUESTIONS_PLANNED" : "NO_ELIGIBLE_QUESTIONS",
      value: planned.session,
    });
  } catch {
    return fail("MALFORMED_INPUT");
  }
}

export interface RecordQuestionAnswerRequest {
  readonly answerId: string;
  readonly sessionRef: string;
  readonly questionRef: string;
  readonly uncertaintyId: string;
  readonly questionIdentity: string;
  readonly decisionKey: string;
  readonly disposition: QuestionAnswerRecord["disposition"];
  readonly answerText?: string | null;
  readonly evidenceRefs?: readonly string[];
  readonly supersedesAnswerId?: string | null;
}

export interface RecordQuestionAnswerDependencies {
  readonly repository: QuestionRepository;
  readonly understanding: UnderstandingRepository;
  readonly clock?: { now(): string };
}

export interface RecordedQuestionAnswer {
  readonly answer: QuestionAnswerRecord;
  readonly claimUpdateProposal: AnswerClaimUpdateProposal | null;
}

/**
 * Records one answer immutably inside its session. Corrections must chain to a
 * prior answer of the same question binding; answer-derived claim updates are
 * returned as proposals only and are never applied to understanding here.
 */
export async function recordAdaptiveQuestionAnswer(
  scope: UnderstandingScope,
  request: RecordQuestionAnswerRequest,
  dependencies: RecordQuestionAnswerDependencies,
): Promise<QuestionServiceResult<RecordedQuestionAnswer>> {
  try {
    if (!validScope(scope) || isProxy(request)) return fail("MALFORMED_INPUT");
    const session = await dependencies.repository.getSession(scope, request.sessionRef);
    if (!session) return fail("NOT_FOUND");
    const understanding = await dependencies.understanding.getVersion(
      scope,
      session.understandingVersionId,
    );
    if (!understanding) return fail("NOT_FOUND");

    const knownQuestion = session.session.questions.find(
      (question) => question.questionRef === request.questionRef
        && question.uncertaintyId === request.uncertaintyId,
    );
    if (!knownQuestion) return fail("MALFORMED_INPUT");

    const history = await dependencies.repository.listAnswers(
      scope,
      session.tenantRef,
      request.sessionRef,
      session.understandingVersionId,
    );
    const recorded = recordQuestionAnswer({
      version: 1,
      answerId: request.answerId,
      tenantRef: session.tenantRef,
      sessionRef: session.sessionRef,
      understandingVersionId: session.understandingVersionId,
      questionRef: request.questionRef,
      uncertaintyId: request.uncertaintyId,
      questionIdentity: request.questionIdentity,
      decisionKey: request.decisionKey,
      disposition: request.disposition,
      answerText: request.answerText ?? null,
      evidenceRefs: request.evidenceRefs ?? [],
      recordedAt: (dependencies.clock?.now() ?? new Date().toISOString()),
      supersedesAnswerId: request.supersedesAnswerId ?? null,
    }, history);
    if (!recorded.ok) return fail("MALFORMED_INPUT");

    const persisted = await dependencies.repository.appendAnswer(
      scope,
      recorded.answer,
      recorded.claimUpdateProposal,
    );
    if (persisted !== "appended") return fail("PERSISTENCE_CONFLICT");
    return Object.freeze({
      ok: true,
      code: "ANSWER_RECORDED",
      value: Object.freeze({
        answer: recorded.answer,
        claimUpdateProposal: recorded.claimUpdateProposal,
      }),
    });
  } catch {
    return fail("MALFORMED_INPUT");
  }
}

export async function listQuestionSessionAnswers(
  scope: UnderstandingScope,
  sessionRef: string,
  repository: QuestionRepository,
): Promise<QuestionServiceResult<readonly QuestionAnswerRecord[]>> {
  if (!validScope(scope) || typeof sessionRef !== "string" || !REF.test(sessionRef)) {
    return fail("MALFORMED_INPUT");
  }
  const session = await repository.getSession(scope, sessionRef);
  if (!session) return fail("NOT_FOUND");
  const answers = await repository.listAnswers(
    scope,
    session.tenantRef,
    session.sessionRef,
    session.understandingVersionId,
  );
  return Object.freeze({ ok: true, code: "ANSWER_HISTORY_LISTED", value: answers });
}

export async function getQuestionSession(
  scope: UnderstandingScope,
  sessionRef: string,
  repository: QuestionRepository,
): Promise<QuestionServiceResult<StoredQuestionSession>> {
  if (!validScope(scope) || typeof sessionRef !== "string" || !REF.test(sessionRef)) {
    return fail("MALFORMED_INPUT");
  }
  const session = await repository.getSession(scope, sessionRef);
  if (!session) return fail("NOT_FOUND");
  return Object.freeze({ ok: true, code: "QUESTION_SESSION_LISTED", value: session });
}
