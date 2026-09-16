import "server-only";

import { createHash } from "node:crypto";
import { isProxy } from "node:util/types";

import type { AgentRuntimeDependencies } from "@/lib/agent-runtime/service";
import {
  claimAgentRun,
  enqueueAgentRun,
  executeAgentRunAttempt,
} from "@/lib/agent-runtime/service";
import type { ContactRepository, ContactVersionRow } from "@/lib/contacts/repository";
import type { CanonicalAccountRow } from "@/lib/discovery/repository";
import { enqueueItem, type ReviewServiceDeps } from "@/lib/review/service";
import type { StrategyRepository, StoredLeadPlayVersion } from "@/lib/strategy/service";
import { buildLeadPlayProposal } from "@/lib/strategy/lead-play";
import type { UnderstandingRepository } from "@/lib/understanding/service";
import {
  hydrateUnderstandingVersion,
  verifyUnderstandingReviewIntegrity,
} from "@/lib/understanding/service";
import type { UnderstandingFact } from "@/lib/understanding/business-understanding";
import type { SuppressionRepository } from "@/lib/suppressions/repository";
import { resolveSuppression } from "@/lib/suppressions/service";

import {
  buildOutreachDraft,
  createOutreachDraftCurrentVersionState,
  supersedeOutreachDraftCurrentVersion,
  transitionOutreachDraftReview,
  type OutreachDraft,
  type OutreachDraftReviewSnapshot,
} from "@/lib/outreach/draft-review";
import { evaluateOutreachPolicyGate } from "@/lib/outreach/policy-gate";
import {
  createOutreachExportReceipt,
  type OutreachExportReceipt,
} from "@/lib/outreach/export-receipt";
import {
  buildEvidencePack,
  materializeClaimBinding,
  selectEvidenceSources,
} from "@/lib/outreach/evidence-pack";
import {
  composeOutreachDraft,
  OUTREACH_DRAFT_KINDS,
  type ComposedDraft,
  type OutreachDraftKind,
} from "@/lib/outreach/draft-composer";
import {
  D012_ALLOWED_HANDOFF_HOURS_PER_DAY,
  D012_MAX_HANDOFFS_PER_CONTACT_PER_DAY,
  D012_QUIET_HOURS,
  evaluateHandoffSchedule,
  recipientLocalDayKey,
} from "@/lib/outreach/handoff-schedule";
import {
  OUTREACH_DRAFTING_POLICY_KEY,
  OUTREACH_DRAFTING_PROMPT_KEY,
} from "@/lib/outreach/agent-seeds";
import type {
  OutreachEvidencePayload,
  OutreachRepository,
  OutreachSourceBinding,
  StoredOutreachDraft,
  StoredOutreachHandoffAttempt,
} from "@/lib/outreach/repository";

/**
 * L-06 outreach service. Orchestrates the only permitted lifecycle:
 *   generate (bounded fixture run + deterministic cited composition)
 *   → human review (shared qualification queue) → current-version binding
 *   → fail-closed handoff gate → caller-attested copy/export receipt.
 * No send, delivery, provider, mailbox, transport, or follow-up path exists
 * in this module or anywhere it calls.
 */

export type OutreachServiceErrorCode =
  | "OUTREACH_INPUT_INVALID"
  | "OUTREACH_NOT_FOUND"
  | "OUTREACH_SCOPE_MISMATCH"
  | "OUTREACH_SEPARATION_OF_DUTY"
  | "OUTREACH_HUMAN_REVIEW_REQUIRED"
  | "OUTREACH_STALE_VERSION"
  | "OUTREACH_VERSION_CONFLICT"
  | "OUTREACH_INVALID_TRANSITION"
  | "OUTREACH_POLICY_BLOCKED"
  | "OUTREACH_RECIPIENT_BLOCKED"
  | "OUTREACH_SUPPRESSION_BLOCKED"
  | "OUTREACH_PERSONAL_CONTACT_BLOCKED"
  | "OUTREACH_SCHEDULE_BLOCKED"
  | "OUTREACH_IDEMPOTENCY_CONFLICT"
  | "OUTREACH_GENERATION_FAILED"
  | "OUTREACH_EVIDENCE_STALE"
  | "OUTREACH_INTEGRITY_VIOLATION";

export class OutreachServiceError extends Error {
  readonly code: OutreachServiceErrorCode;

  constructor(code: OutreachServiceErrorCode, message: string) {
    super(message);
    this.name = "OutreachServiceError";
    this.code = code;
  }
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const SAFE_REF = /^[A-Za-z0-9][A-Za-z0-9:._/-]{0,254}$/u;
const HASH = /^sha256:[0-9a-f]{64}$/u;
const VERSION_ID = /^outreach-draft-version:[0-9a-f]{64}$/u;
const CONTACT_VERSION = /^contact-version:[0-9a-f]{64}$/u;
const PLAY_VERSION = /^lead-play-version:[0-9a-f]{64}$/u;
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u;
const IDEMPOTENCY = /^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/u;
const BLOCKED_POINT_CLASSES = new Set(["personal_email", "personal_mobile", "unknown"]);

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

function sha256(value: unknown): string {
  return `sha256:${createHash("sha256").update(JSON.stringify(value), "utf8").digest("hex")}`;
}

/** Raw-text hash — the citation validator hashes claim spans without JSON quoting. */
function sha256Text(value: string): string {
  return `sha256:${createHash("sha256").update(value, "utf8").digest("hex")}`;
}

function invalid(message: string): OutreachServiceError {
  return new OutreachServiceError("OUTREACH_INPUT_INVALID", message);
}

function uuid(value: unknown, field: string): string {
  if (typeof value !== "string" || !UUID.test(value)) throw invalid(`${field} must be a UUID`);
  return value;
}

function safeRef(value: unknown, field: string): string {
  if (typeof value !== "string" || !SAFE_REF.test(value)) throw invalid(`${field} is malformed`);
  return value;
}

function boundedText(value: unknown, field: string, maximum: number): string {
  if (typeof value !== "string" || value.length === 0 || value.length > maximum
    || /[\x00-\x1f\x7f-\x9f\p{Default_Ignorable_Code_Point}]/u.test(value)) {
    throw invalid(`${field} is malformed`);
  }
  return value;
}

function nowIso(clock: (() => Date) | undefined): string {
  const observed = clock ? clock() : new Date();
  if (!(observed instanceof Date) || !Number.isFinite(observed.getTime())) {
    throw invalid("A valid clock is required");
  }
  return observed.toISOString();
}

/* ---------- dependency ports ---------- */

export interface OutreachAccountPort {
  getAccount(
    tenantId: string, workspaceId: string, accountId: string,
  ): Promise<CanonicalAccountRow | null>;
}

export interface OutreachMemberPort {
  /** Active human members in the tenant; backs the single-member approval exception. */
  countActiveMembers(tenantId: string): Promise<number>;
}

export interface OutreachAuditSink {
  record(event: Readonly<{
    action: string;
    entityType: string;
    entityId: string;
    metadata: Readonly<Record<string, unknown>>;
  }>): Promise<void>;
}

export interface OutreachServiceDeps {
  readonly outreach: OutreachRepository;
  readonly suppressions: SuppressionRepository;
  readonly contacts: ContactRepository;
  readonly accounts: OutreachAccountPort;
  readonly understanding: UnderstandingRepository;
  readonly strategy: Pick<
    StrategyRepository, "getLeadPlayVersion" | "getLatestLeadPlayVersionByStableKey"
  >;
  /** Shared L-05 review queue seam; outreach approval reuses qualification_review. */
  readonly review?: ReviewServiceDeps;
  /** Bounded fixture runtime; the route attests seeds before handing deps in. */
  readonly runtime: AgentRuntimeDependencies;
  readonly members?: OutreachMemberPort;
  readonly audit?: OutreachAuditSink;
  readonly clock?: () => Date;
}

type Scope = Readonly<{ tenantId: string; workspaceId: string; accountId: string }>;

function parseScope(raw: PlainRecord): Scope {
  return Object.freeze({
    tenantId: uuid(raw.tenantId, "tenantId"),
    workspaceId: uuid(raw.workspaceId, "workspaceId"),
    accountId: uuid(raw.accountId, "accountId"),
  });
}

/* ---------- domain helpers ---------- */

async function loadAccount(
  deps: OutreachServiceDeps, scope: Scope,
): Promise<CanonicalAccountRow> {
  const account = await deps.accounts.getAccount(
    scope.tenantId, scope.workspaceId, scope.accountId);
  if (!account || account.status !== "active") {
    throw new OutreachServiceError("OUTREACH_NOT_FOUND", "The account is not available.");
  }
  return account;
}

async function loadApprovedPlay(
  deps: OutreachServiceDeps,
  scope: Scope,
  raw: PlainRecord,
): Promise<StoredLeadPlayVersion> {
  const strategyScope = Object.freeze({ tenantId: scope.tenantId, workspaceId: scope.workspaceId });
  let stored: StoredLeadPlayVersion | null = null;
  if (raw.playVersionId !== undefined && raw.playVersionId !== null) {
    if (typeof raw.playVersionId !== "string" || !PLAY_VERSION.test(raw.playVersionId)) {
      throw invalid("playVersionId is malformed");
    }
    stored = await deps.strategy.getLeadPlayVersion(strategyScope, raw.playVersionId);
  } else if (raw.playStableKey !== undefined && raw.playStableKey !== null) {
    stored = await deps.strategy.getLatestLeadPlayVersionByStableKey(
      strategyScope, safeRef(raw.playStableKey, "playStableKey"));
  } else {
    throw invalid("A playVersionId or playStableKey is required");
  }
  if (!stored || stored.tenantId !== scope.tenantId || stored.workspaceId !== scope.workspaceId) {
    throw new OutreachServiceError("OUTREACH_NOT_FOUND", "The lead play is not available.");
  }
  const rebuilt = buildLeadPlayProposal(stored.source);
  if (!rebuilt.ok || rebuilt.proposal.versionId !== stored.versionId
    || rebuilt.proposal.contentHash !== stored.contentHash
    || rebuilt.proposal.outreachMode !== "draft_only"
    || stored.review.versionId !== stored.versionId
    || stored.review.status !== "approved") {
    throw new OutreachServiceError(
      "OUTREACH_POLICY_BLOCKED", "The lead play is not an approved draft-only play.");
  }
  return stored;
}

function contactRecordOf(row: ContactVersionRow): PlainRecord {
  if (!isPlainRecord(row.payload)) {
    throw new OutreachServiceError(
      "OUTREACH_INTEGRITY_VIOLATION", "The stored contact payload is malformed.");
  }
  return row.payload;
}

async function loadEligibleContact(
  deps: OutreachServiceDeps, scope: Scope, contactVersionId: string,
): Promise<ContactVersionRow> {
  const row = await deps.contacts.getContact(scope.tenantId, scope.workspaceId, contactVersionId);
  if (!row || row.accountId !== scope.accountId) {
    throw new OutreachServiceError("OUTREACH_NOT_FOUND", "The contact is not available.");
  }
  const record = contactRecordOf(row);
  const identity = isPlainRecord(record.identity) ? record.identity : {};
  if (BLOCKED_POINT_CLASSES.has(String(identity.contactPointClass))) {
    throw new OutreachServiceError(
      "OUTREACH_PERSONAL_CONTACT_BLOCKED",
      "The contact point class cannot be used for outreach.");
  }
  return row;
}

async function assertNotSuppressed(
  deps: OutreachServiceDeps,
  scope: Scope,
  contactStableKey: string | null,
  contactDisposition: string,
): Promise<void> {
  const resolved = await resolveSuppression(
    { repository: deps.suppressions, clock: deps.clock },
    {
      tenantId: scope.tenantId,
      workspaceId: scope.workspaceId,
      accountId: scope.accountId,
      contactStableKey,
      contactDisposition,
    },
  );
  if (resolved.blocking) {
    throw new OutreachServiceError(
      "OUTREACH_SUPPRESSION_BLOCKED",
      `Suppression ${resolved.effectiveDisposition} blocks outreach for this scope.`);
  }
}

/** Contact eligibility for generation: approved, fresh, unsuppressed, usable. */
function assertContactGeneratable(row: ContactVersionRow, now: string): void {
  const record = contactRecordOf(row);
  const freshness = isPlainRecord(record.freshness) ? record.freshness : {};
  const review = isPlainRecord(record.review) ? record.review : {};
  const eligibility = isPlainRecord(review.eligibility) ? review.eligibility : {};
  if (row.reviewStatus !== "approved") {
    throw new OutreachServiceError(
      "OUTREACH_POLICY_BLOCKED", "The contact has not completed human review.");
  }
  if (freshness.state !== "KNOWN" || typeof freshness.expiresAt !== "string"
    || Date.parse(freshness.expiresAt) <= Date.parse(now)) {
    throw new OutreachServiceError(
      "OUTREACH_POLICY_BLOCKED", "The contact freshness has expired.");
  }
  if (eligibility.contactUse !== "allowed") {
    throw new OutreachServiceError(
      "OUTREACH_POLICY_BLOCKED", "The contact-use eligibility is blocked.");
  }
}

async function loadApprovedFacts(
  deps: OutreachServiceDeps,
  scope: Scope,
): Promise<Readonly<{ facts: readonly UnderstandingFact[]; versionId: string | null }>> {
  const stored = await deps.understanding.listVersions({
    tenantId: scope.tenantId, workspaceId: scope.workspaceId,
  });
  const approved = stored
    .filter((view) => view.review.status === "approved")
    .map((view) => ({ view, hydrated: hydrateUnderstandingVersion(view) }))
    .filter((entry) => entry.hydrated.ok
      && verifyUnderstandingReviewIntegrity(entry.view.review))
    .sort((left, right) => {
      const leftAt = left.view.review.events.at(-1)?.at ?? left.view.createdAt;
      const rightAt = right.view.review.events.at(-1)?.at ?? right.view.createdAt;
      return rightAt.localeCompare(leftAt) || right.view.versionId.localeCompare(left.view.versionId);
    });
  const latest = approved[0];
  if (!latest || !latest.hydrated.ok) {
    return Object.freeze({ facts: Object.freeze([]), versionId: null });
  }
  const proposal = latest.hydrated.value.proposal;
  const facts = proposal.domains.flatMap((domain) => domain.facts);
  return Object.freeze({ facts: Object.freeze(facts), versionId: proposal.versionId });
}

/* ---------- generation ---------- */

export type GenerateOutreachDraftInput = Readonly<{
  tenantId: string;
  workspaceId: string;
  accountId: string;
  draftKind: OutreachDraftKind;
  playVersionId?: string;
  playStableKey?: string;
  contactVersionId?: string;
  /** Present for revisions: the existing draft chain's stable key. */
  stableKey?: string;
  /** Tenant-approved opt-out boilerplate appended verbatim to the body. */
  optOutText: string;
  actorId: string;
}>;

export type GeneratedOutreachDraft =
  | Readonly<{
    draft: OutreachDraft;
    persisted: "created" | "replayed";
    agentRunId: string;
    agentResultRef: string;
    stableKey: string;
    revision: number;
  }>
  | Readonly<{
    draft: null;
    persisted: "queued";
    agentRunId: string;
    agentResultRef: null;
    stableKey: string;
    revision: number;
  }>;

export async function generateOutreachDraft(
  deps: OutreachServiceDeps,
  rawInput: unknown,
): Promise<GeneratedOutreachDraft> {
  if (!isPlainRecord(rawInput)) throw invalid("Expected a plain object");
  const scope = parseScope(rawInput);
  const actorId = uuid(rawInput.actorId, "actorId");
  const draftKind = typeof rawInput.draftKind === "string"
    && OUTREACH_DRAFT_KINDS.includes(rawInput.draftKind as OutreachDraftKind)
    ? rawInput.draftKind as OutreachDraftKind
    : (() => { throw invalid("draftKind is malformed"); })();
  const optOutText = boundedText(rawInput.optOutText, "optOutText", 2_000);
  const now = nowIso(deps.clock);

  const account = await loadAccount(deps, scope);
  const play = await loadApprovedPlay(deps, scope, rawInput);

  let contact: ContactVersionRow | null = null;
  if (rawInput.contactVersionId !== undefined && rawInput.contactVersionId !== null) {
    if (typeof rawInput.contactVersionId !== "string" || !CONTACT_VERSION.test(rawInput.contactVersionId)) {
      throw invalid("contactVersionId is malformed");
    }
    contact = await loadEligibleContact(deps, scope, rawInput.contactVersionId);
    assertContactGeneratable(contact, now);
  }

  // Suppression records override generation for the whole applicable scope.
  await assertNotSuppressed(
    deps, scope, contact?.stableKey ?? null, contact?.suppressionDisposition ?? "clear");

  const { facts, versionId: understandingVersionId } = await loadApprovedFacts(deps, scope);
  const selected = selectEvidenceSources(facts);
  const contactRecord = contact ? contactRecordOf(contact) : null;
  const roleHypothesis = contactRecord && isPlainRecord(contactRecord.roleHypothesis)
    ? contactRecord.roleHypothesis : null;
  const pack = buildEvidencePack({
    tenantId: scope.tenantId,
    workspaceId: scope.workspaceId,
    accountId: scope.accountId,
    facts: selected,
    understandingVersionId,
    account: {
      accountId: account.accountId,
      accountVersion: account.version,
      displayName: account.displayName ?? account.accountId,
      profileContent: account.profile,
    },
    contact: contact && roleHypothesis && typeof roleHypothesis.statement === "string"
      ? {
        versionId: contact.versionId,
        stableKey: contact.stableKey,
        contentHash: `sha256:${contact.contentSha256}`,
        roleStatement: roleHypothesis.statement,
        displayName: typeof contactRecord?.identity === "object"
            && contactRecord.identity !== null
            && typeof (contactRecord.identity as PlainRecord).displayName === "string"
          ? (contactRecord.identity as PlainRecord).displayName as string
          : null,
      }
      : null,
  });
  if (pack.sources.length === 0) {
    throw new OutreachServiceError(
      "OUTREACH_POLICY_BLOCKED", "No approved evidence is available for citation.");
  }

  // Revisions bind the current latest review of the same stable key.
  let stableKey: string | null = null;
  let revision = 1;
  let predecessor: OutreachDraftReviewSnapshot | null = null;
  let latest: StoredOutreachDraft | null = null;
  if (rawInput.stableKey !== undefined && rawInput.stableKey !== null) {
    stableKey = safeRef(rawInput.stableKey, "stableKey");
    latest = await deps.outreach.getLatestDraftVersion(
      scope.tenantId, scope.workspaceId, scope.accountId, stableKey);
    if (!latest) {
      throw new OutreachServiceError("OUTREACH_NOT_FOUND", "The draft chain is not available.");
    }
    revision = latest.draft.revision + 1;
    predecessor = latest.draft.review;
  }

  // Bounded fixture generation. The idempotency key commits to the exact
  // generation inputs so an identical request replays the same run — and the
  // same persisted draft version — instead of duplicating work.
  const runKeySeed = {
    accountId: scope.accountId,
    draftKind,
    playVersionId: play.versionId,
    contactVersionId: contact?.versionId ?? null,
    stableKey: rawInput.stableKey ?? null,
    sourceKeys: pack.sources.map((source) => source.key + ":" + source.sourceVersionId),
    optOutTextHash: sha256(optOutText),
  };
  const idempotencyKey = `l06-draft:${sha256(runKeySeed).slice("sha256:".length, 32)}`;
  const enqueue = await enqueueAgentRun(
    { tenantId: scope.tenantId, workspaceId: scope.workspaceId },
    {
      agentRole: "outreach_drafting",
      promptKey: OUTREACH_DRAFTING_PROMPT_KEY,
      policyKey: OUTREACH_DRAFTING_POLICY_KEY,
      budgetUsd: 0.05,
      maxAttempts: 1,
      idempotencyKey,
      evidence: pack.runtimeEvidence,
    },
    deps.runtime,
  );
  if (!enqueue.ok) {
    throw new OutreachServiceError(
      "OUTREACH_GENERATION_FAILED", `The drafting run was rejected (${enqueue.code}).`);
  }
  let run = enqueue.value;
  let resultRef = run.resultRef;
  if (run.status !== "complete" || resultRef === null) {
    const claimed = await claimAgentRun(
      { tenantId: scope.tenantId, workspaceId: scope.workspaceId },
      { runId: run.id },
      deps.runtime,
    );
    if (!claimed.ok) {
      if (claimed.code === "RUN_LEASE_CONFLICT") {
        // Claim/execute are worker-lease gated; a member context cannot hold
        // the dispatch lease. Returning "queued" (not throwing) commits the
        // run so the agent_runtime worker route can claim it; a retry of this
        // request deduplicates to the finished run and persists the draft.
        return Object.freeze({
          draft: null,
          persisted: "queued" as const,
          agentRunId: run.id,
          agentResultRef: null,
          stableKey: stableKey ?? `draft:${run.id}`,
          revision,
        });
      }
      throw new OutreachServiceError(
        "OUTREACH_GENERATION_FAILED", `The drafting run could not be claimed (${claimed.code}).`);
    }
    const executed = await executeAgentRunAttempt(
      { tenantId: scope.tenantId, workspaceId: scope.workspaceId },
      { runId: run.id, leaseToken: claimed.value.leaseToken },
      deps.runtime,
    );
    if (!executed.ok || executed.value.resultRef === null) {
      throw new OutreachServiceError(
        "OUTREACH_GENERATION_FAILED",
        `The drafting run did not complete (${executed.ok ? executed.value.errorCode : executed.code}).`);
    }
    run = executed.value.record;
    resultRef = executed.value.resultRef;
  }

  // Generation identity is the run id: a retried request deduplicates to the
  // same run and must return the already-persisted draft, never a duplicate
  // revision or a second stable-key chain.
  if (latest && latest.agentRunId === run.id) {
    return Object.freeze({
      draft: latest.draft,
      persisted: "replayed" as const,
      agentRunId: run.id,
      agentResultRef: resultRef,
      stableKey: latest.stableKey,
      revision: latest.draft.revision,
    });
  }
  if (!latest) {
    const existing = await deps.outreach.getLatestDraftVersion(
      scope.tenantId, scope.workspaceId, scope.accountId, `draft:${run.id}`);
    if (existing) {
      return Object.freeze({
        draft: existing.draft,
        persisted: "replayed" as const,
        agentRunId: run.id,
        agentResultRef: resultRef,
        stableKey: existing.stableKey,
        revision: existing.draft.revision,
      });
    }
  }

  const greetingName = contactRecord && isPlainRecord(contactRecord.identity)
    && typeof contactRecord.identity.displayName === "string"
    ? contactRecord.identity.displayName : null;
  const composed: ComposedDraft = composeOutreachDraft({
    kind: draftKind,
    optOutText,
    greetingName,
    sources: pack.sources,
  });

  const citations: unknown[] = [];
  const evidence: unknown[] = [];
  const bindings: OutreachSourceBinding[] = [];
  const validatorClaims = composed.claims.map((claim) => {
    const source = pack.sources.find((candidate) => candidate.key === claim.sourceKey);
    if (!source) {
      throw new OutreachServiceError(
        "OUTREACH_INTEGRITY_VIOLATION", "A composed claim lost its evidence source.");
    }
    const binding = materializeClaimBinding({
      tenantId: scope.tenantId,
      workspaceId: scope.workspaceId,
      claimId: claim.claimId,
      claimText: claim.text,
      source,
      index: 0,
    });
    citations.push(binding.citation);
    evidence.push(binding.evidence);
    bindings.push(Object.freeze({
      claimId: claim.claimId,
      sourceKey: source.key,
      sourceKind: source.sourceKind,
      sourceVersionId: source.sourceVersionId,
      locator: source.locator,
      statement: source.statement,
      resolution: source.resolution,
    }));
    return Object.freeze({
      claimId: claim.claimId,
      field: claim.field,
      start: claim.start,
      end: claim.end,
      text: claim.text,
      textHash: sha256Text(claim.text),
      claimClass: claim.claimClass,
      material: claim.material,
      citationIds: Object.freeze([binding.citation.citationId]),
      uncertainty: claim.uncertainty,
    });
  });

  const createdAt = run.endedAt ?? run.updatedAt;
  if (!ISO.test(createdAt)) {
    throw new OutreachServiceError(
      "OUTREACH_GENERATION_FAILED", "The drafting run did not produce a valid timestamp.");
  }
  const built = buildOutreachDraft({
    version: 1,
    tenantId: scope.tenantId,
    workspaceId: scope.workspaceId,
    accountId: scope.accountId,
    stableKey: stableKey ?? `draft:${run.id}`,
    revision,
    predecessor,
    createdAt,
    subject: composed.subject,
    body: composed.body,
    claims: validatorClaims,
    citations,
    evidence,
  });
  if (!built.ok) {
    throw new OutreachServiceError(
      built.code === "VERSION_CONFLICT" ? "OUTREACH_VERSION_CONFLICT" : "OUTREACH_POLICY_BLOCKED",
      `The draft could not be built (${built.code}).`);
  }
  const evidencePayload: OutreachEvidencePayload = Object.freeze({
    citations: Object.freeze(citations),
    evidence: Object.freeze(evidence),
    bindings: Object.freeze(bindings),
  });
  const persisted = await deps.outreach.insertDraftVersion({
    tenantId: scope.tenantId,
    workspaceId: scope.workspaceId,
    accountId: scope.accountId,
    stableKey: built.draft.stableKey,
    revision: built.draft.revision,
    draftKind,
    playVersionId: play.versionId,
    contactVersionId: contact?.versionId ?? null,
    agentRunId: run.id,
    agentResultRef: resultRef,
    createdBy: actorId,
    draft: built.draft,
    evidencePayload,
    createdAt,
  });
  await deps.audit?.record({
    action: "outreach.draft_generated",
    entityType: "outreach_draft",
    entityId: built.draft.versionId,
    metadata: {
      stableKey: built.draft.stableKey,
      revision: built.draft.revision,
      draftKind,
      playVersionId: play.versionId,
      agentRunId: run.id,
      persisted,
    },
  });
  return Object.freeze({
    draft: built.draft,
    persisted,
    agentRunId: run.id,
    agentResultRef: resultRef,
    stableKey: built.draft.stableKey,
    revision: built.draft.revision,
  });
}

/* ---------- human review ---------- */

export type TransitionDraftReviewInput = Readonly<{
  tenantId: string;
  workspaceId: string;
  accountId: string;
  versionId: string;
  expectedContentHash?: string;
  expectedValidationHash?: string;
  expectedReviewHash: string;
  to: "in_review" | "approved" | "rejected";
  actorId: string;
  actorRole?: string;
  reason: string;
  /** Single-member-tenant escape hatch; requires an owner/admin role. */
  selfApproveConfirmed?: boolean;
  at?: string;
}>;

export type TransitionedDraftReview = Readonly<{
  review: OutreachDraftReviewSnapshot;
  reviewQueueItemId: string | null;
  currentStateBound: boolean;
}>;

const SELF_APPROVE_ROLES = new Set(["owner", "admin"]);

export async function transitionOutreachDraftReviewRequest(
  deps: OutreachServiceDeps,
  rawInput: unknown,
): Promise<TransitionedDraftReview> {
  if (!isPlainRecord(rawInput)) throw invalid("Expected a plain object");
  const scope = parseScope(rawInput);
  const versionId = typeof rawInput.versionId === "string" && VERSION_ID.test(rawInput.versionId)
    ? rawInput.versionId : (() => { throw invalid("versionId is malformed"); })();
  const actorId = uuid(rawInput.actorId, "actorId");
  const to = rawInput.to === "in_review" || rawInput.to === "approved" || rawInput.to === "rejected"
    ? rawInput.to : (() => { throw invalid("to is malformed"); })();
  const expectedReviewHash = typeof rawInput.expectedReviewHash === "string"
    && HASH.test(rawInput.expectedReviewHash)
    ? rawInput.expectedReviewHash
    : (() => { throw invalid("expectedReviewHash is malformed"); })();
  const reason = boundedText(rawInput.reason, "reason", 2_000);
  const at = rawInput.at === undefined ? nowIso(deps.clock)
    : typeof rawInput.at === "string" && ISO.test(rawInput.at) ? rawInput.at
      : (() => { throw invalid("at is malformed"); })();

  const stored = await deps.outreach.getDraftVersion(
    scope.tenantId, scope.workspaceId, scope.accountId, versionId);
  if (!stored) {
    throw new OutreachServiceError("OUTREACH_NOT_FOUND", "The draft version is not available.");
  }
  const current = stored.draft.review;

  // Separation of duty: the approver may not be the draft creator unless the
  // tenant has exactly one active member and the actor holds owner/admin.
  if (to === "approved" && actorId === stored.createdBy) {
    const role = typeof rawInput.actorRole === "string" ? rawInput.actorRole : "";
    const members = deps.members
      ? await deps.members.countActiveMembers(scope.tenantId) : Number.POSITIVE_INFINITY;
    const excepted = rawInput.selfApproveConfirmed === true
      && SELF_APPROVE_ROLES.has(role) && members === 1;
    if (!excepted) {
      throw new OutreachServiceError(
        "OUTREACH_SEPARATION_OF_DUTY",
        "The draft creator cannot approve their own draft.");
    }
  }

  const transitioned = transitionOutreachDraftReview({
    version: 1,
    tenantId: scope.tenantId,
    workspaceId: scope.workspaceId,
    accountId: scope.accountId,
    current,
    expectedVersionId: versionId,
    expectedContentHash: typeof rawInput.expectedContentHash === "string"
      ? rawInput.expectedContentHash : current.contentHash,
    expectedValidationHash: typeof rawInput.expectedValidationHash === "string"
      ? rawInput.expectedValidationHash : current.validationHash,
    expectedReviewHash,
    to,
    actor: { kind: "human", actorId },
    at,
    reason,
  });
  if (!transitioned.ok) {
    const code = transitioned.code === "STALE_VERSION" ? "OUTREACH_STALE_VERSION"
      : transitioned.code === "INVALID_TRANSITION" ? "OUTREACH_INVALID_TRANSITION"
        : transitioned.code === "SCOPE_MISMATCH" ? "OUTREACH_SCOPE_MISMATCH"
          : transitioned.code === "HUMAN_REVIEW_REQUIRED" ? "OUTREACH_HUMAN_REVIEW_REQUIRED"
            : "OUTREACH_INPUT_INVALID";
    throw new OutreachServiceError(code, `The review transition was rejected (${transitioned.code}).`);
  }
  const review = transitioned.review;

  await deps.outreach.updateDraftReview(expectedReviewHash, {
    ...stored,
    draft: { ...stored.draft, review },
  });

  let reviewQueueItemId: string | null = null;
  let currentStateBound = false;

  if (to === "in_review" && deps.review) {
    const enqueued = await enqueueItem(deps.review, {
      tenantId: scope.tenantId,
      workspaceId: scope.workspaceId,
      kind: "qualification_review",
      subject: {
        subjectId: stored.draft.stableKey,
        versionId: stored.draft.versionId,
        contentHash: stored.draft.contentHash,
      },
      priority: "normal",
      reason,
      at,
    });
    reviewQueueItemId = enqueued.itemId || null;
  }

  if (to === "approved") {
    const currentState = await deps.outreach.getCurrentState(
      scope.tenantId, scope.workspaceId, scope.accountId, stored.draft.stableKey);
    // The bind event must strictly follow both the review event and any prior
    // state event; a same-millisecond clock would otherwise fail closed.
    const lastReviewAt = review.events.at(-1)?.at ?? review.createdAt;
    const bindAt = (minimum: string) => new Date(
      Math.max(Date.parse(at), Date.parse(lastReviewAt), Date.parse(minimum)) + 1,
    ).toISOString();
    if (review.revision === 1 && !currentState) {
      const boundAt = bindAt(at);
      const created = createOutreachDraftCurrentVersionState({
        version: 1,
        tenantId: scope.tenantId,
        workspaceId: scope.workspaceId,
        accountId: scope.accountId,
        review,
        actor: { kind: "human", actorId },
        at: boundAt,
        reason: "Bind the first approved draft version as the current version.",
      });
      if (!created.ok) {
        throw new OutreachServiceError(
          "OUTREACH_INVALID_TRANSITION",
          `The current-version binding was rejected (${created.code}).`);
      }
      await deps.outreach.insertCurrentState({
        tenantId: scope.tenantId,
        workspaceId: scope.workspaceId,
        accountId: scope.accountId,
        stableKey: stored.draft.stableKey,
        state: created.state,
        updatedAt: boundAt,
      });
      currentStateBound = true;
    } else if (currentState) {
      if (review.revision !== currentState.state.current.revision + 1
        || review.supersedesVersionId !== currentState.state.current.versionId) {
        // Approval of a non-successor revision is valid but cannot bind
        // current state; the draft stays ineligible for handoff.
        currentStateBound = false;
      } else {
        const boundAt = bindAt(
          currentState.state.events.at(-1)?.at ?? currentState.updatedAt);
        const superseded = supersedeOutreachDraftCurrentVersion({
          version: 1,
          tenantId: scope.tenantId,
          workspaceId: scope.workspaceId,
          accountId: scope.accountId,
          current: currentState.state,
          expectedStateHash: currentState.state.stateHash,
          predecessorReview: currentState.state.current.review,
          replacementReview: review,
          actor: { kind: "human", actorId },
          at: boundAt,
          reason: "Bind the newly approved draft revision as the current version.",
        });
        if (!superseded.ok) {
          throw new OutreachServiceError(
            "OUTREACH_INVALID_TRANSITION",
            `The current-version supersession was rejected (${superseded.code}).`);
        }
        await deps.outreach.updateCurrentState(currentState.state.stateHash, {
          tenantId: scope.tenantId,
          workspaceId: scope.workspaceId,
          accountId: scope.accountId,
          stableKey: stored.draft.stableKey,
          state: superseded.state,
          updatedAt: boundAt,
        });
        currentStateBound = true;
      }
    }
  }

  await deps.audit?.record({
    action: `outreach.review_${to}`,
    entityType: "outreach_draft",
    entityId: stored.draft.versionId,
    metadata: {
      stableKey: stored.draft.stableKey,
      revision: stored.draft.revision,
      reviewQueueItemId,
      currentStateBound,
    },
  });
  return Object.freeze({ review, reviewQueueItemId, currentStateBound });
}

/* ---------- handoff (copy/export only) ---------- */

export type RequestHandoffInput = Readonly<{
  tenantId: string;
  workspaceId: string;
  accountId: string;
  stableKey: string;
  action: "copy" | "export";
  actorId: string;
  idempotencyKey: string;
  /** IANA timezone of the recipient; required — quiet hours are recipient-local. */
  recipientTimezone: string;
  plannedAt?: string;
  contactVersionId: string;
  expectedDraftStateHash?: string;
  expectedDraftVersionId?: string;
  expectedDraftReviewHash?: string;
  expectedContactContentHash?: string;
  expectedContactReviewHash?: string;
}>;

export type HandoffResult = Readonly<
  | { status: "released"; attempt: StoredOutreachHandoffAttempt; receipt: OutreachExportReceipt }
  | { status: "blocked"; attempt: StoredOutreachHandoffAttempt; blockCode: string }
>;

function blockedAttemptId(input: PlainRecord): string {
  return `attempt:${sha256(input).slice("sha256:".length)}`;
}

async function recordBlockedAttempt(
  deps: OutreachServiceDeps,
  scope: Scope,
  input: Readonly<{
    stableKey: string;
    draftVersionId: string;
    action: "copy" | "export";
    contactVersionId: string | null;
    contactStableKey: string | null;
    actorId: string;
    idempotencyKey: string;
    decidedAt: string;
    plannedAt: string;
    recipientLocalDay: string | null;
    blockCode: string;
    decision: StoredOutreachHandoffAttempt["decision"];
    inputHash: string;
  }>,
): Promise<StoredOutreachHandoffAttempt> {
  const attempt: StoredOutreachHandoffAttempt = Object.freeze({
    tenantId: scope.tenantId,
    workspaceId: scope.workspaceId,
    accountId: scope.accountId,
    stableKey: input.stableKey,
    attemptId: blockedAttemptId({
      scope, stableKey: input.stableKey, draftVersionId: input.draftVersionId,
      action: input.action, contactVersionId: input.contactVersionId,
      actorId: input.actorId, decidedAt: input.decidedAt, blockCode: input.blockCode,
      idempotencyKey: input.idempotencyKey,
    }),
    action: input.action,
    status: "blocked",
    blockCode: input.blockCode,
    decision: input.decision,
    receipt: null,
    draftVersionId: input.draftVersionId,
    contactVersionId: input.contactVersionId,
    contactStableKey: input.contactStableKey,
    actorId: input.actorId,
    decidedAt: input.decidedAt,
    completedAt: null,
    plannedAt: input.plannedAt,
    recipientLocalDay: input.recipientLocalDay,
    idempotencyKey: input.idempotencyKey,
  });
  await deps.outreach.insertHandoffAttempt(attempt, input.inputHash);
  await deps.audit?.record({
    action: "outreach.handoff_blocked",
    entityType: "outreach_handoff_attempt",
    entityId: attempt.attemptId,
    metadata: { stableKey: input.stableKey, action: input.action, blockCode: input.blockCode },
  });
  return attempt;
}

/**
 * Revalidates every evidence binding the draft's claims were built on against
 * live sources. Any drift — a superseded understanding version, a merged
 * account, a revised contact — makes the evidence stale and the handoff
 * fails closed before the policy gate ever runs.
 */
async function assertEvidenceCurrent(
  deps: OutreachServiceDeps,
  scope: Scope,
  stored: StoredOutreachDraft,
): Promise<void> {
  const bindings = stored.evidencePayload.bindings;
  let understanding:
    | Readonly<{ facts: readonly UnderstandingFact[]; versionId: string | null }> | null = null;
  const loadUnderstanding = async () => {
    understanding ??= await loadApprovedFacts(deps, scope);
    return understanding;
  };
  for (const binding of bindings) {
    const resolution = binding.resolution;
    if (resolution.kind === "understanding_fact") {
      const current = await loadUnderstanding();
      const fact = current.facts.find((candidate) => candidate.claimId === resolution.factClaimId);
      const citation = fact?.citations.find((candidate) =>
        candidate.evidenceId === resolution.factEvidenceId);
      if (!fact || fact.claimStatus !== "supported" || !citation
        || citation.freshness !== "current") {
        throw new OutreachServiceError(
          "OUTREACH_EVIDENCE_STALE",
          `The fact backing claim ${binding.claimId} is no longer approved and current.`);
      }
    } else if (resolution.kind === "account_profile") {
      const account = await deps.accounts.getAccount(
        scope.tenantId, scope.workspaceId, scope.accountId);
      if (!account || account.status !== "active" || account.version !== resolution.accountVersion) {
        throw new OutreachServiceError(
          "OUTREACH_EVIDENCE_STALE", "The canonical account version changed since generation.");
      }
    } else if (resolution.kind === "contact_role") {
      if (typeof resolution.contactVersionId !== "string"
        || typeof resolution.contactStableKey !== "string") {
        throw new OutreachServiceError(
          "OUTREACH_INTEGRITY_VIOLATION", "A contact-role binding is incomplete.");
      }
      const bound = await deps.contacts.getContact(
        scope.tenantId, scope.workspaceId, resolution.contactVersionId);
      if (!bound || bound.stableKey !== resolution.contactStableKey) {
        throw new OutreachServiceError(
          "OUTREACH_EVIDENCE_STALE", "The bound contact version is unavailable.");
      }
      const revisions = (await deps.contacts.listAccountContacts(
        scope.tenantId, scope.workspaceId, scope.accountId))
        .filter((row) => row.stableKey === resolution.contactStableKey);
      const latest = revisions.reduce((a, b) => (a.revision >= b.revision ? a : b), bound);
      if (latest.versionId !== bound.versionId) {
        throw new OutreachServiceError(
          "OUTREACH_EVIDENCE_STALE", "The bound contact version was superseded.");
      }
    }
  }
}

export async function requestOutreachHandoff(
  deps: OutreachServiceDeps,
  rawInput: unknown,
): Promise<HandoffResult> {
  if (!isPlainRecord(rawInput)) throw invalid("Expected a plain object");
  const scope = parseScope(rawInput);
  const stableKey = safeRef(rawInput.stableKey, "stableKey");
  const action = rawInput.action === "copy" || rawInput.action === "export" ? rawInput.action
    : (() => { throw invalid("action must be copy or export"); })();
  const actorId = uuid(rawInput.actorId, "actorId");
  const idempotencyKey = typeof rawInput.idempotencyKey === "string"
    && IDEMPOTENCY.test(rawInput.idempotencyKey)
    ? rawInput.idempotencyKey : (() => { throw invalid("idempotencyKey is malformed"); })();
  const recipientTimezone = typeof rawInput.recipientTimezone === "string"
    && rawInput.recipientTimezone.length > 0 && rawInput.recipientTimezone.length <= 100
    ? rawInput.recipientTimezone
    : (() => { throw invalid("recipientTimezone is required"); })();
  const contactVersionId = typeof rawInput.contactVersionId === "string"
    && CONTACT_VERSION.test(rawInput.contactVersionId)
    ? rawInput.contactVersionId : (() => { throw invalid("contactVersionId is malformed"); })();
  const decidedAt = nowIso(deps.clock);
  const plannedAt = rawInput.plannedAt === undefined ? decidedAt
    : typeof rawInput.plannedAt === "string" && ISO.test(rawInput.plannedAt) ? rawInput.plannedAt
      : (() => { throw invalid("plannedAt is malformed"); })();

  const inputHash = sha256({
    scope, stableKey, action, contactVersionId, actorId, idempotencyKey, plannedAt,
    recipientTimezone,
  });
  const replay = await deps.outreach.getHandoffAttemptByIdempotency(
    scope.tenantId, scope.workspaceId, scope.accountId, idempotencyKey);
  if (replay) {
    if (replay.inputHash !== inputHash) {
      throw new OutreachServiceError(
        "OUTREACH_IDEMPOTENCY_CONFLICT",
        "The idempotency key was already used with different inputs.");
    }
    const existing = replay.attempt;
    return existing.status === "released" && existing.receipt
      ? Object.freeze({ status: "released" as const, attempt: existing, receipt: existing.receipt })
      : Object.freeze({
        status: "blocked" as const, attempt: existing, blockCode: existing.blockCode ?? "UNKNOWN" });
  }

  const currentState = await deps.outreach.getCurrentState(
    scope.tenantId, scope.workspaceId, scope.accountId, stableKey);
  if (!currentState) {
    throw new OutreachServiceError(
      "OUTREACH_NOT_FOUND", "No approved current draft exists for this stable key.");
  }
  const state = currentState.state;

  const stored = await deps.outreach.getDraftVersion(
    scope.tenantId, scope.workspaceId, scope.accountId, state.current.versionId);
  if (!stored || stored.stableKey !== stableKey) {
    throw new OutreachServiceError(
      "OUTREACH_INTEGRITY_VIOLATION", "The current draft version cannot be loaded.");
  }

  const block = (
    blockCode: string,
    decision: StoredOutreachHandoffAttempt["decision"],
    contactStableKey: string | null,
    recipientLocalDay: string | null,
  ) => recordBlockedAttempt(deps, scope, {
    stableKey,
    draftVersionId: state.current.versionId,
    action,
    contactVersionId: stored.contactVersionId,
    contactStableKey,
    actorId,
    idempotencyKey,
    decidedAt,
    plannedAt,
    recipientLocalDay,
    blockCode,
    decision,
    inputHash,
  });

  // The recipient is bound at generation; the request cannot substitute one.
  if (stored.contactVersionId === null || stored.contactVersionId !== contactVersionId) {
    const attempt = await block("OUTREACH_RECIPIENT_BLOCKED", null, null, null);
    return Object.freeze({ status: "blocked" as const, attempt, blockCode: "OUTREACH_RECIPIENT_BLOCKED" });
  }

  const contact = await deps.contacts.getContact(
    scope.tenantId, scope.workspaceId, contactVersionId);
  if (!contact || contact.accountId !== scope.accountId) {
    throw new OutreachServiceError("OUTREACH_NOT_FOUND", "The contact is not available.");
  }
  const record = contactRecordOf(contact);
  const identity = isPlainRecord(record.identity) ? record.identity : {};
  const dayKey = recipientLocalDayKey(plannedAt, recipientTimezone);

  // Pre-gate blocks, recorded as attempts: suppression, contact-point class,
  // schedule, and evidence staleness all override release before the gate.
  if (BLOCKED_POINT_CLASSES.has(String(identity.contactPointClass))) {
    const attempt = await block(
      "OUTREACH_PERSONAL_CONTACT_BLOCKED", null, contact.stableKey, dayKey);
    return Object.freeze({
      status: "blocked" as const, attempt, blockCode: "OUTREACH_PERSONAL_CONTACT_BLOCKED" });
  }
  const suppression = await resolveSuppression(
    { repository: deps.suppressions, clock: deps.clock },
    {
      tenantId: scope.tenantId,
      workspaceId: scope.workspaceId,
      accountId: scope.accountId,
      contactStableKey: contact.stableKey,
      contactDisposition: contact.suppressionDisposition,
    },
  );
  if (suppression.blocking) {
    const attempt = await block(
      "OUTREACH_SUPPRESSION_BLOCKED", null, contact.stableKey, dayKey);
    return Object.freeze({
      status: "blocked" as const, attempt, blockCode: "OUTREACH_SUPPRESSION_BLOCKED" });
  }
  if (dayKey === null) {
    const attempt = await block("OUTREACH_SCHEDULE_BLOCKED", null, contact.stableKey, null);
    return Object.freeze({
      status: "blocked" as const, attempt, blockCode: "OUTREACH_SCHEDULE_BLOCKED" });
  }
  const priorAttemptsToday = await deps.outreach.countContactDayReleasedAttempts(
    scope.tenantId, scope.workspaceId, scope.accountId, contact.stableKey, dayKey);
  const schedule = evaluateHandoffSchedule({
    plannedAt,
    timeZone: recipientTimezone,
    priorAttemptsToday,
    quietHours: D012_QUIET_HOURS,
    maxPerDay: D012_MAX_HANDOFFS_PER_CONTACT_PER_DAY,
    allowedHoursPerDay: D012_ALLOWED_HANDOFF_HOURS_PER_DAY,
  });
  if (!schedule.ok) {
    const attempt = await block("OUTREACH_SCHEDULE_BLOCKED", null, contact.stableKey, dayKey);
    return Object.freeze({
      status: "blocked" as const, attempt, blockCode: "OUTREACH_SCHEDULE_BLOCKED" });
  }
  try {
    await assertEvidenceCurrent(deps, scope, stored);
  } catch (error) {
    if (error instanceof OutreachServiceError && error.code === "OUTREACH_EVIDENCE_STALE") {
      const attempt = await block("OUTREACH_EVIDENCE_STALE", null, contact.stableKey, dayKey);
      return Object.freeze({
        status: "blocked" as const, attempt, blockCode: "OUTREACH_EVIDENCE_STALE" });
    }
    throw error;
  }

  const expectedDraftStateHash = typeof rawInput.expectedDraftStateHash === "string"
    ? rawInput.expectedDraftStateHash : state.stateHash;
  const expectedDraftVersionId = typeof rawInput.expectedDraftVersionId === "string"
    ? rawInput.expectedDraftVersionId : state.current.versionId;
  const expectedDraftReviewHash = typeof rawInput.expectedDraftReviewHash === "string"
    ? rawInput.expectedDraftReviewHash : state.current.reviewHash;
  const permittedUse = isPlainRecord(record.permittedUse) ? record.permittedUse : {};
  const decisionResult = evaluateOutreachPolicyGate({
    version: 1,
    tenantId: scope.tenantId,
    workspaceId: scope.workspaceId,
    accountId: scope.accountId,
    action,
    currentDraftState: state,
    expectedDraftStateHash,
    expectedDraftVersionId,
    expectedDraftReviewHash,
    contact: record,
    expectedContactVersionId: contactVersionId,
    expectedContactContentHash: typeof rawInput.expectedContactContentHash === "string"
      ? rawInput.expectedContactContentHash : `sha256:${contact.contentSha256}`,
    expectedContactReviewHash: typeof rawInput.expectedContactReviewHash === "string"
      ? rawInput.expectedContactReviewHash : `sha256:${contact.reviewSha256}`,
    policy: {
      policyVersion: typeof permittedUse.policyVersion === "string" ? permittedUse.policyVersion : "",
      purpose: typeof permittedUse.purpose === "string" ? permittedUse.purpose : "",
      allowedActions: ["copy", "export"],
    },
    actor: { kind: "human", actorId },
    decidedAt,
  });
  if (!decisionResult.ok) {
    const code = decisionResult.code === "STALE_BINDING" ? "OUTREACH_STALE_VERSION"
      : decisionResult.code === "SCOPE_MISMATCH" ? "OUTREACH_SCOPE_MISMATCH"
        : decisionResult.code === "INVALID_CHRONOLOGY" ? "OUTREACH_VERSION_CONFLICT"
          : decisionResult.code === "HUMAN_ACTOR_REQUIRED" ? "OUTREACH_HUMAN_REVIEW_REQUIRED"
            : "OUTREACH_INPUT_INVALID";
    throw new OutreachServiceError(
      code, `The policy decision could not be evaluated (${decisionResult.code}).`);
  }
  const decision = decisionResult.decision;
  if (decision.result === "deny") {
    const blockCode = `OUTREACH_POLICY_DENIED:${decision.reasons[0] ?? "UNKNOWN"}`;
    const attempt = await block(blockCode, decision, contact.stableKey, dayKey);
    return Object.freeze({ status: "blocked" as const, attempt, blockCode });
  }

  const completedAt = new Date(Date.parse(decidedAt) + 1).toISOString();
  const receiptResult = createOutreachExportReceipt({
    version: 1,
    tenantId: scope.tenantId,
    workspaceId: scope.workspaceId,
    accountId: scope.accountId,
    action,
    decision,
    currentDraftState: state,
    expectedDecisionHash: decision.decisionHash,
    expectedDraftStateHash: state.stateHash,
    expectedDraftVersionId: state.current.versionId,
    expectedDraftReviewHash: state.current.reviewHash,
    actor: { kind: "human", actorId },
    idempotencyKey,
    completedAt,
  });
  if (!receiptResult.ok) {
    throw new OutreachServiceError(
      receiptResult.code === "STALE_BINDING" ? "OUTREACH_STALE_VERSION" : "OUTREACH_POLICY_BLOCKED",
      `The export receipt could not be created (${receiptResult.code}).`);
  }
  const receipt = receiptResult.receipt;
  const attempt: StoredOutreachHandoffAttempt = Object.freeze({
    tenantId: scope.tenantId,
    workspaceId: scope.workspaceId,
    accountId: scope.accountId,
    stableKey,
    attemptId: receipt.receiptId,
    action,
    status: "released",
    blockCode: null,
    decision,
    receipt,
    draftVersionId: state.current.versionId,
    contactVersionId,
    contactStableKey: contact.stableKey,
    actorId,
    decidedAt,
    completedAt,
    plannedAt,
    recipientLocalDay: dayKey,
    idempotencyKey,
  });
  await deps.outreach.insertHandoffAttempt(attempt, inputHash);
  await deps.audit?.record({
    action: "outreach.handoff_released",
    entityType: "outreach_handoff_attempt",
    entityId: attempt.attemptId,
    metadata: {
      stableKey,
      action,
      draftVersionId: state.current.versionId,
      receiptId: receipt.receiptId,
    },
  });
  return Object.freeze({ status: "released" as const, attempt, receipt });
}

/* ---------- query views ---------- */

export type OutreachDraftView = Readonly<{
  versionId: string;
  stableKey: string;
  revision: number;
  draftKind: string;
  playVersionId: string | null;
  contactVersionId: string | null;
  agentRunId: string | null;
  reviewStatus: string;
  subject: string;
  body: string;
  claims: number;
  createdAt: string;
}>;

export async function getOutreachDraftView(
  deps: Pick<OutreachServiceDeps, "outreach">,
  scope: Scope,
  versionId: string,
): Promise<OutreachDraftView> {
  const stored = await deps.outreach.getDraftVersion(
    scope.tenantId, scope.workspaceId, scope.accountId, versionId);
  if (!stored) {
    throw new OutreachServiceError("OUTREACH_NOT_FOUND", "The draft version is not available.");
  }
  return draftView(stored);
}

function draftView(stored: StoredOutreachDraft): OutreachDraftView {
  return Object.freeze({
    versionId: stored.draft.versionId,
    stableKey: stored.draft.stableKey,
    revision: stored.draft.revision,
    draftKind: stored.draftKind,
    playVersionId: stored.playVersionId,
    contactVersionId: stored.contactVersionId,
    agentRunId: stored.agentRunId,
    reviewStatus: stored.draft.review.status,
    subject: stored.draft.subject,
    body: stored.draft.body,
    claims: stored.draft.validation.claims.length,
    createdAt: stored.createdAt,
  });
}

export async function listOutreachDraftViews(
  deps: Pick<OutreachServiceDeps, "outreach">,
  scope: Readonly<{ tenantId: string; workspaceId: string }>,
  filter?: Readonly<{ accountId?: string }>,
): Promise<readonly OutreachDraftView[]> {
  const rows = await deps.outreach.listDraftVersions(
    scope.tenantId, scope.workspaceId, filter);
  return Object.freeze(rows.map(draftView));
}

export async function listHandoffAttemptViews(
  deps: Pick<OutreachServiceDeps, "outreach">,
  scope: Readonly<{ tenantId: string; workspaceId: string }>,
  filter?: Readonly<{ accountId?: string; stableKey?: string; contactStableKey?: string }>,
): Promise<readonly StoredOutreachHandoffAttempt[]> {
  return deps.outreach.listHandoffAttempts(scope.tenantId, scope.workspaceId, filter);
}

export type OutreachCurrentDraftView = Readonly<{
  stableKey: string;
  versionId: string;
  revision: number;
  reviewStatus: string;
  eligibleActions: readonly string[];
  stateHash: string;
}>;

export async function getCurrentDraftView(
  deps: Pick<OutreachServiceDeps, "outreach">,
  scope: Scope & Readonly<{ stableKey: string }>,
): Promise<OutreachCurrentDraftView | null> {
  const stored = await deps.outreach.getCurrentState(
    scope.tenantId, scope.workspaceId, scope.accountId, scope.stableKey);
  if (!stored) return null;
  return Object.freeze({
    stableKey: stored.stableKey,
    versionId: stored.state.current.versionId,
    revision: stored.state.current.revision,
    reviewStatus: stored.state.current.status,
    eligibleActions: stored.state.current.eligibleActions,
    stateHash: stored.state.stateHash,
  });
}
