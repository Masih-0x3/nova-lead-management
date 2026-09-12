import { createHash } from "node:crypto";

import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { createFixtureAgentRunStoreAdapter } from "@/lib/agent-runtime/fixture-store";
import { createDeterministicFixtureProvider } from "@/lib/agent-runtime/fixture-provider";
import { createAgentRuntimeRegistry, seedL04AgentRuntime } from "@/lib/agent-runtime/prompts";
import type { AgentRuntimeDependencies } from "@/lib/agent-runtime/service";
import type { ContactRecord } from "@/lib/contacts/contact-record";
import type {
  BuyingCenterRow,
  ContactRepository,
  ContactVersionRow,
} from "@/lib/contacts/repository";
import {
  registerContactRecord,
  transitionContactReview,
} from "@/lib/contacts/service";
import type { CanonicalAccountRow } from "@/lib/discovery/repository";
import {
  OUTREACH_DRAFTING_PROMPT,
} from "@/lib/outreach/agent-seeds";
import type {
  OutreachRepository,
  StoredOutreachCurrentState,
  StoredOutreachDraft,
  StoredOutreachHandoffAttempt,
} from "@/lib/outreach/repository";
import {
  generateOutreachDraft,
  listHandoffAttemptViews,
  requestOutreachHandoff,
  transitionOutreachDraftReviewRequest,
  type GeneratedOutreachDraft,
  type OutreachAccountPort,
  type OutreachServiceDeps,
} from "@/lib/outreach/service";
import type { ReviewQueue } from "@/lib/review/review-queue";
import type {
  ReviewQueueRow,
  ReviewRepository,
} from "@/lib/review/repository";
import {
  buildIcpProposal,
  transitionIcpReview,
  type IcpReviewSnapshot,
} from "@/lib/strategy/icp";
import {
  buildLeadPlayProposal,
  transitionLeadPlayReview,
  type LeadPlayReviewSnapshot,
} from "@/lib/strategy/lead-play";
import type { StoredLeadPlayVersion, StrategyRepository } from "@/lib/strategy/service";
import type { SuppressionRepository } from "@/lib/suppressions/repository";
import {
  buildBusinessUnderstandingProposal,
  transitionBusinessUnderstandingReview,
  type BusinessUnderstandingReviewSnapshot,
} from "@/lib/understanding/business-understanding";
import type { StoredUnderstandingVersion } from "@/lib/understanding/service";

const TENANT = "10000000-0000-4000-8000-000000000001";
const WORKSPACE = "20000000-0000-4000-8000-000000000001";
const ACCOUNT = "30000000-0000-4000-8000-000000000001";
const MEMBER = "40000000-0000-4000-8000-000000000001";
const APPROVER = "40000000-0000-4000-8000-000000000002";
const HASH_A = `sha256:${"a".repeat(64)}`;
const HASH_B = `sha256:${"b".repeat(64)}`;

function sha256(value: unknown): string {
  return `sha256:${createHash("sha256")
    .update(typeof value === "string" ? value : JSON.stringify(value)).digest("hex")}`;
}

/* ---------- approved understanding + play fixtures ---------- */

function understandingSource() {
  return {
    version: 1,
    tenantId: TENANT,
    workspaceId: WORKSPACE,
    proposalRef: "understanding:outreach-source",
    revision: 1,
    supersedesProposalRef: null,
    supersedesVersionId: null,
    createdAt: "2026-08-30T12:00:00.000Z",
    producer: {
      runRef: "agent-run:understanding-outreach-source",
      runInputHash: HASH_A,
      agentVersion: "understanding-synthesizer:v1",
      modelRef: "fixture:openai-responses-stub",
      promptRef: "business-understanding@1",
      promptHash: HASH_A,
      policyRef: "evidence-policy:v1",
      policyHash: HASH_B,
    },
    evidence: [{
      evidenceId: "evidence:catalog-1",
      tenantId: TENANT,
      workspaceId: WORKSPACE,
      sourceVersionRef: "document-version:catalog-1",
      locator: "page=2#segment",
      contentHash: HASH_A,
      grade: "direct_observation",
      freshness: "current",
    }],
    claims: [{
      claimId: "claim:industrial-buyers",
      claimVersion: 1,
      tenantId: TENANT,
      workspaceId: WORKSPACE,
      domain: "customer_types",
      claimClass: "identity",
      subject: "Industrial buyers",
      statement: "The catalog targets industrial formulators.",
      origin: "observed",
      status: "supported",
      confidenceBasisPoints: 9_000,
      material: true,
      evidenceIds: ["evidence:catalog-1"],
      uncertaintyReason: null,
    }],
  };
}

function approvedUnderstanding(): StoredUnderstandingVersion {
  const source = understandingSource();
  const created = buildBusinessUnderstandingProposal(source);
  if (!created.ok) throw new Error(`understanding fixture failed: ${created.code}`);
  const transition = (
    current: BusinessUnderstandingReviewSnapshot,
    to: "in_review" | "approved",
    at: string,
  ) => transitionBusinessUnderstandingReview({
    version: 1,
    tenantId: TENANT,
    workspaceId: WORKSPACE,
    current,
    expectedVersionId: current.versionId,
    expectedContentHash: current.contentHash,
    expectedReviewHash: current.reviewHash,
    to,
    actor: { kind: "human", actorId: APPROVER },
    at,
    reason: `Human understanding decision: ${to}.`,
    replacement: null,
  });
  const inReview = transition(created.proposal.review, "in_review", "2026-08-30T12:01:00.000Z");
  if (!inReview.ok) throw new Error(`understanding review failed: ${inReview.code}`);
  const approved = transition(inReview.review, "approved", "2026-08-30T12:02:00.000Z");
  if (!approved.ok) throw new Error(`understanding approval failed: ${approved.code}`);
  const proposal = created.proposal;
  return Object.freeze({
    tenantId: proposal.tenantId,
    workspaceId: proposal.workspaceId,
    versionId: proposal.versionId,
    proposalRef: proposal.proposalRef,
    revision: proposal.revision,
    supersedesProposalRef: proposal.supersedesProposalRef,
    supersedesVersionId: proposal.supersedesVersionId,
    contentHash: proposal.contentHash,
    claimSetHash: proposal.claimSetHash,
    source,
    review: approved.review,
    createdAt: proposal.createdAt,
    updatedAt: "2026-08-30T12:02:00.000Z",
  });
}

function icpSource(understanding: BusinessUnderstandingReviewSnapshot) {
  return {
    version: 1,
    tenantId: TENANT,
    workspaceId: WORKSPACE,
    stableKey: "icp:industrial-formulators",
    revision: 1,
    predecessor: null,
    createdAt: "2026-08-30T13:00:00.000Z",
    understanding: {
      tenantId: TENANT,
      workspaceId: WORKSPACE,
      versionId: understanding.versionId,
      contentHash: understanding.contentHash,
      claimSetHash: understanding.claimSetHash,
      reviewHash: understanding.reviewHash,
      snapshot: understanding,
      authority: {
        authorityVersion: 1,
        tenantId: TENANT,
        workspaceId: WORKSPACE,
        understandingVersionId: understanding.versionId,
        understandingContentHash: understanding.contentHash,
        understandingClaimSetHash: understanding.claimSetHash,
        understandingReviewHash: understanding.reviewHash,
        source: understandingSource(),
      },
    },
    title: "Industrial formulators in an active product-change cycle",
    segment: "Industrial formulators evaluating formulation changes",
    useCase: "Prioritize evidence-backed reformulation opportunities",
    positiveCriteria: [{
      criterionId: "criterion:buying-trigger",
      ruleKey: "buying-trigger:formulation-change",
      domain: "buying_trigger",
      rule: "A formulation change creates an active need.",
      rationale: "The approved understanding identifies supported industrial buyers.",
      confidenceBasisPoints: 8_500,
      rationaleRefs: [{ claimId: "claim:industrial-buyers", evidenceId: "evidence:catalog-1" }],
    }],
    exclusions: [{
      criterionId: "exclusion:consumer-only",
      ruleKey: "disqualifier:consumer-only",
      domain: "disqualifier",
      rule: "Exclude consumer-only organizations.",
      rationale: "The cited evidence supports an industrial buyer profile.",
      confidenceBasisPoints: 8_000,
      rationaleRefs: [{ claimId: "claim:industrial-buyers", evidenceId: "evidence:catalog-1" }],
    }],
    uncertainties: [],
  };
}

function approvedIcp(
  understanding: BusinessUnderstandingReviewSnapshot,
): Readonly<{ source: ReturnType<typeof icpSource>; review: IcpReviewSnapshot }> {
  const source = icpSource(understanding);
  const created = buildIcpProposal(source);
  if (!created.ok) throw new Error(`ICP fixture failed: ${created.code}`);
  const transition = (current: IcpReviewSnapshot, to: "in_review" | "approved", at: string) =>
    transitionIcpReview({
      version: 1,
      tenantId: TENANT,
      workspaceId: WORKSPACE,
      current,
      expectedVersionId: current.versionId,
      expectedContentHash: current.contentHash,
      expectedReviewHash: current.reviewHash,
      to,
      actor: { kind: "human", actorId: APPROVER },
      at,
      reason: `Human ICP decision: ${to}.`,
      replacement: null,
    });
  const inReview = transition(created.proposal.review, "in_review", "2026-08-30T13:01:00.000Z");
  if (!inReview.ok) throw new Error(`ICP review failed: ${inReview.code}`);
  const approved = transition(inReview.review, "approved", "2026-08-30T13:02:00.000Z");
  if (!approved.ok) throw new Error(`ICP approval failed: ${approved.code}`);
  return Object.freeze({ source, review: approved.review });
}

function approvedPlay(understanding: BusinessUnderstandingReviewSnapshot): StoredLeadPlayVersion {
  const icp = approvedIcp(understanding);
  const snapshot = icp.review;
  const source = {
    version: 1,
    tenantId: TENANT,
    workspaceId: WORKSPACE,
    stableKey: "lead-play:formulation-change",
    revision: 1,
    predecessor: null,
    createdAt: "2026-08-30T14:00:00.000Z",
    icp: {
      tenantId: snapshot.tenantId,
      workspaceId: snapshot.workspaceId,
      stableKey: snapshot.stableKey,
      revision: snapshot.revision,
      supersedesVersionId: snapshot.supersedesVersionId,
      versionId: snapshot.versionId,
      contentHash: snapshot.contentHash,
      reviewHash: snapshot.reviewHash,
      understandingVersionId: snapshot.understandingVersionId,
      understandingContentHash: snapshot.understandingContentHash,
      understandingReviewHash: snapshot.understandingReviewHash,
      snapshot,
      source: icp.source,
    },
    title: "Formulation-change discovery",
    objective: "Find evidence-backed industrial formulation-change opportunities for human review.",
    motion: "Discover and qualify accounts with current formulation-change signals.",
    searchHypotheses: [{
      hypothesisId: "hypothesis:formulation-change",
      queryFamily: "industrial-formulators-with-active-product-change",
      statement: "Organizations announcing formulation changes may have an active replacement need.",
      rationale: "The approved ICP identifies formulation change as a buying trigger.",
      rationaleRefs: [{ claimId: "claim:industrial-buyers", evidenceId: "evidence:catalog-1" }],
    }],
    sourceAllowlist: ["google-places", "customer-approved-url"],
    bounds: { maxAccounts: 100, maxProviderRequests: 25, maxSpendCents: 2_500 },
    outreachMode: "draft_only",
    rationaleRefs: [{ claimId: "claim:industrial-buyers", evidenceId: "evidence:catalog-1" }],
    uncertainties: [{
      uncertaintyId: "uncertainty:change-timing",
      statement: "The timing of each formulation change is not yet known.",
      impact: "Keep accounts in human review until current timing evidence is available.",
      relatedClaimIds: ["claim:industrial-buyers"],
    }],
  };
  const created = buildLeadPlayProposal(source);
  if (!created.ok) throw new Error(`lead-play fixture failed: ${created.code}`);
  const transition = (
    current: LeadPlayReviewSnapshot,
    to: "in_review" | "approved",
    at: string,
  ) => transitionLeadPlayReview({
    version: 1,
    tenantId: TENANT,
    workspaceId: WORKSPACE,
    current,
    expectedVersionId: current.versionId,
    expectedContentHash: current.contentHash,
    expectedReviewHash: current.reviewHash,
    to,
    actor: { kind: "human", actorId: APPROVER },
    at,
    reason: `Human lead-play decision: ${to}.`,
    replacement: null,
  });
  const inReview = transition(created.proposal.review, "in_review", "2026-08-30T14:01:00.000Z");
  if (!inReview.ok) throw new Error(`lead-play review failed: ${inReview.code}`);
  const approved = transition(inReview.review, "approved", "2026-08-30T14:02:00.000Z");
  if (!approved.ok) throw new Error(`lead-play approval failed: ${approved.code}`);
  const proposal = created.proposal;
  return Object.freeze({
    tenantId: proposal.tenantId,
    workspaceId: proposal.workspaceId,
    versionId: proposal.versionId,
    stableKey: proposal.stableKey,
    revision: proposal.revision,
    supersedesVersionId: proposal.supersedesVersionId,
    contentHash: proposal.contentHash,
    icpVersionId: snapshot.versionId,
    understandingVersionId: snapshot.understandingVersionId,
    source,
    review: approved.review,
    createdAt: proposal.createdAt,
    updatedAt: "2026-08-30T14:02:00.000Z",
  });
}

/* ---------- approved contact fixture ---------- */

function receipt() {
  const payload = {
    receiptVersion: 1,
    tenantId: TENANT,
    workspaceId: WORKSPACE,
    accountId: ACCOUNT,
    sourceId: "customer-list:fixture",
    sourceVersionId: "customer-list-version:fixture-v1",
    sourceContentHash: sha256("synthetic customer list v1"),
    connectorKey: "customer-list",
    locator: "row=1",
    observedAt: "2026-08-30T12:01:00.000Z",
  };
  return { ...payload, receiptHash: sha256(payload) };
}

function contactInput(overrides: Record<string, unknown> = {}) {
  const sourceReceipt = receipt();
  return {
    tenantId: TENANT,
    workspaceId: WORKSPACE,
    accountId: ACCOUNT,
    stableKey: "contact:synthetic-procurement",
    identity: {
      kind: "person_candidate",
      displayName: "Synthetic Buyer",
      contactPointClass: "named_business_email",
      contactPoint: "buyer@example.test",
      verification: "source_observed",
    },
    roleHypothesis: {
      status: "hypothesis",
      roleKey: "procurement",
      statement: "The source labels this synthetic contact as procurement.",
      confidenceBasisPoints: 7_500,
      evidenceReceiptHash: sourceReceipt.receiptHash,
    },
    sourceReceipt,
    freshness: {
      state: "KNOWN",
      observedAt: sourceReceipt.observedAt,
      expiresAt: "2027-08-30T12:01:00.000Z",
    },
    permittedUse: {
      policyVersion: "d012_v2026_07_27_02",
      purpose: "outreach",
      sourcePolicy: "KNOWN",
      jurisdiction: "KNOWN",
      attestation: "KNOWN",
      identity: "KNOWN",
      channelAuthorization: "KNOWN",
      legalBasis: "KNOWN",
      consentSignal: "KNOWN",
    },
    suppressionDisposition: "clear",
    createdAt: "2026-08-30T13:00:00.000Z",
    ...overrides,
  };
}

function contactRow(record: ContactRecord): ContactVersionRow {
  return Object.freeze({
    versionId: record.versionId,
    tenantId: record.tenantId,
    workspaceId: record.workspaceId,
    accountId: record.accountId,
    stableKey: record.stableKey,
    revision: record.revision,
    supersedesVersionId: record.supersedesVersionId,
    reviewStatus: record.review.status,
    suppressionDisposition: record.suppressionDisposition,
    freshnessState: record.freshness.state,
    contactPointClass: record.identity.contactPointClass,
    connectorKey: record.sourceReceipt.connectorKey,
    contentSha256: record.contentHash.slice("sha256:".length),
    versionSha256: record.versionHash.slice("sha256:".length),
    reviewSha256: record.review.reviewHash.slice("sha256:".length),
    payload: record as unknown as Record<string, unknown>,
    createdAt: record.createdAt,
  });
}

function fakeContacts(): ContactRepository & { contacts: Map<string, ContactVersionRow> } {
  const contacts = new Map<string, ContactVersionRow>();
  const centers = new Map<string, BuyingCenterRow>();
  return {
    contacts,
    insertContact: vi.fn(async (record) => {
      const versionId = record.versionId as string;
      if (contacts.has(versionId)) return "replayed" as const;
      contacts.set(versionId, contactRow(record as unknown as ContactRecord));
      return "created" as const;
    }),
    getContact: vi.fn(async (_t, _w, versionId) => contacts.get(versionId) ?? null),
    listContacts: vi.fn(async () => [...contacts.values()]),
    listAccountContacts: vi.fn(async (_t, _w, accountId) =>
      [...contacts.values()].filter((row) => row.accountId === accountId)),
    updateContactReview: vi.fn(async (_expected, record) => {
      contacts.set(record.versionId as string, contactRow(record as unknown as ContactRecord));
    }),
    insertCenter: vi.fn(async () => "created" as const),
    getCenter: vi.fn(async () => centers.get("") ?? null),
    listCenters: vi.fn(async () => []),
    listAccountCenters: vi.fn(async () => []),
    updateCenterReview: vi.fn(async () => undefined),
  };
}

async function seedApprovedContact(contacts: ContactRepository): Promise<ContactVersionRow> {
  const deps = { repository: contacts };
  const { record } = await registerContactRecord(deps, contactInput());
  const inReview = await transitionContactReview(deps, {
    tenantId: TENANT, workspaceId: WORKSPACE, accountId: ACCOUNT,
    versionId: record.versionId,
    expectedVersionId: record.versionId,
    expectedContentHash: record.contentHash,
    expectedReviewHash: record.review.reviewHash,
    to: "in_review", actorId: APPROVER, at: "2026-08-30T13:01:00.000Z",
    reason: "Queue the synthetic contact for review.",
  });
  const approved = await transitionContactReview(deps, {
    tenantId: TENANT, workspaceId: WORKSPACE, accountId: ACCOUNT,
    versionId: record.versionId,
    expectedVersionId: record.versionId,
    expectedContentHash: record.contentHash,
    expectedReviewHash: inReview.record.review.reviewHash,
    to: "approved", actorId: APPROVER, at: "2026-08-30T13:02:00.000Z",
    reason: "Approve the synthetic contact for permitted outreach use.",
  });
  const row = await contacts.getContact(TENANT, WORKSPACE, record.versionId);
  if (!row || approved.record.review.status !== "approved") {
    throw new Error("contact fixture failed");
  }
  return row;
}

/* ---------- fake repositories ---------- */

function fakeOutreach(): OutreachRepository & {
  drafts: Map<string, StoredOutreachDraft>;
  states: Map<string, StoredOutreachCurrentState>;
  attempts: Map<string, Readonly<{ attempt: StoredOutreachHandoffAttempt; inputHash: string }>>;
} {
  const drafts = new Map<string, StoredOutreachDraft>();
  const states = new Map<string, StoredOutreachCurrentState>();
  const attempts = new Map<string, { attempt: StoredOutreachHandoffAttempt; inputHash: string }>();
  return {
    drafts, states, attempts,
    insertDraftVersion: vi.fn(async (record) => {
      if (drafts.has(record.draft.versionId)) return "replayed" as const;
      drafts.set(record.draft.versionId, record);
      return "created" as const;
    }),
    getDraftVersion: vi.fn(async (_t, _w, _a, versionId) => drafts.get(versionId) ?? null),
    getLatestDraftVersion: vi.fn(async (_t, _w, accountId, stableKey) =>
      [...drafts.values()]
        .filter((row) => row.accountId === accountId && row.stableKey === stableKey)
        .sort((a, b) => b.revision - a.revision)[0] ?? null),
    listDraftVersions: vi.fn(async (tenantId, workspaceId, filter) =>
      [...drafts.values()].filter((row) =>
        row.tenantId === tenantId && row.workspaceId === workspaceId
        && (filter?.accountId === undefined || row.accountId === filter.accountId))),
    updateDraftReview: vi.fn(async (_expected, record) => {
      drafts.set(record.draft.versionId, record);
    }),
    insertCurrentState: vi.fn(async (record) => {
      const key = `${record.accountId}:${record.stableKey}`;
      if (states.has(key)) return "replayed" as const;
      states.set(key, record);
      return "created" as const;
    }),
    getCurrentState: vi.fn(async (_t, _w, accountId, stableKey) =>
      states.get(`${accountId}:${stableKey}`) ?? null),
    updateCurrentState: vi.fn(async (_expected, record) => {
      states.set(`${record.accountId}:${record.stableKey}`, record);
    }),
    insertHandoffAttempt: vi.fn(async (record, inputHash) => {
      const key = `${record.tenantId}:${record.workspaceId}:${record.accountId}:${record.idempotencyKey}`;
      if (attempts.has(key)) return "replayed" as const;
      attempts.set(key, { attempt: record, inputHash });
      return "created" as const;
    }),
    getHandoffAttemptByIdempotency: vi.fn(async (tenantId, workspaceId, accountId, key) =>
      attempts.get(`${tenantId}:${workspaceId}:${accountId}:${key}`) ?? null),
    listHandoffAttempts: vi.fn(async (tenantId, workspaceId, filter) =>
      [...attempts.values()].map((entry) => entry.attempt).filter((row) =>
        row.tenantId === tenantId && row.workspaceId === workspaceId
        && (filter?.accountId === undefined || row.accountId === filter.accountId)
        && (filter?.stableKey === undefined || row.stableKey === filter.stableKey)
        && (filter?.contactStableKey === undefined || row.contactStableKey === filter.contactStableKey))),
    countContactDayReleasedAttempts: vi.fn(async (tenantId, workspaceId, accountId, contactStableKey, day) =>
      [...attempts.values()].map((entry) => entry.attempt).filter((row) =>
        row.tenantId === tenantId && row.workspaceId === workspaceId
        && row.accountId === accountId && row.status === "released"
        && row.contactStableKey === contactStableKey && row.recipientLocalDay === day).length),
  };
}

function fakeSuppressions(): SuppressionRepository {
  const rows = new Map<string, { record: { tenantId: string; workspaceId: string; accountId: string | null; contactStableKey: string | null } }>();
  return {
    insertRecord: vi.fn(async (record) => {
      if (rows.has(record.recordId)) return "replayed" as const;
      rows.set(record.recordId, { record });
      return "created" as const;
    }),
    listRecords: vi.fn(async (tenantId, workspaceId, filter) =>
      [...rows.values()]
        .filter((entry) => entry.record.tenantId === tenantId
          && entry.record.workspaceId === workspaceId
          && (entry.record.accountId === null || entry.record.accountId === filter?.accountId))
        .map((entry) => Object.freeze({
          tenantId: entry.record.tenantId,
          workspaceId: entry.record.workspaceId,
          record: entry.record,
        })) as never),
    getRecord: vi.fn(async () => null),
  };
}

function fakeAccounts(): OutreachAccountPort {
  const account: CanonicalAccountRow = Object.freeze({
    accountId: ACCOUNT,
    tenantId: TENANT,
    workspaceId: WORKSPACE,
    version: 3,
    status: "active",
    redirectToAccountId: null,
    displayName: "Synthetic Formulators Inc.",
    profile: { industry: "industrial coatings", employees: 240 },
    profileSha256: sha256("synthetic profile").slice("sha256:".length),
    exactKeys: [],
    observationRefs: [],
    createdAt: "2026-08-30T10:00:00.000Z",
    updatedAt: "2026-08-30T10:00:00.000Z",
  });
  return { getAccount: vi.fn(async () => account) };
}

function fakeReview(): { repository: ReviewRepository; queues: Map<string, ReviewQueueRow> } {
  const queues = new Map<string, ReviewQueueRow>();
  return {
    queues,
    repository: {
      insertQueue: vi.fn(async (queue) => {
        const record = queue as unknown as ReviewQueue;
        const key = `${record.tenantId}:${record.workspaceId}`;
        if (queues.has(key)) return "replayed" as const;
        queues.set(key, Object.freeze({
          queueId: record.queueId,
          tenantId: record.tenantId,
          workspaceId: record.workspaceId,
          queueSha256: record.queueHash.slice("sha256:".length),
          payload: queue as Record<string, unknown>,
          createdAt: record.createdAt,
          updatedAt: record.createdAt,
        }));
        return "created" as const;
      }),
      getQueue: vi.fn(async (tenantId, workspaceId) =>
        queues.get(`${tenantId}:${workspaceId}`) ?? null),
      updateQueue: vi.fn(async (_expected, queue, updatedAt) => {
        const record = queue as unknown as ReviewQueue;
        const key = `${record.tenantId}:${record.workspaceId}`;
        const existing = queues.get(key);
        queues.set(key, Object.freeze({
          queueId: record.queueId,
          tenantId: record.tenantId,
          workspaceId: record.workspaceId,
          queueSha256: record.queueHash.slice("sha256:".length),
          payload: queue as Record<string, unknown>,
          createdAt: existing?.createdAt ?? record.createdAt,
          updatedAt,
        }));
      }),
      insertItem: vi.fn(async () => undefined),
      updateItem: vi.fn(async () => undefined),
      insertEvent: vi.fn(async () => undefined),
      listItems: vi.fn(async () => []),
      listEvents: vi.fn(async () => []),
    },
  };
}

function runtimeDeps(): AgentRuntimeDependencies {
  return {
    store: createFixtureAgentRunStoreAdapter(),
    registry: createAgentRuntimeRegistry(
      [OUTREACH_DRAFTING_PROMPT],
      seedL04AgentRuntime().policies,
    ),
    provider: createDeterministicFixtureProvider(),
  };
}

async function fixtureDeps(): Promise<OutreachServiceDeps & {
  play: StoredLeadPlayVersion;
  contact: ContactVersionRow;
  outreach: ReturnType<typeof fakeOutreach>;
  suppressions: SuppressionRepository;
}> {
  const understanding = approvedUnderstanding();
  const play = approvedPlay(understanding.review);
  const contacts = fakeContacts();
  const contact = await seedApprovedContact(contacts);
  const outreach = fakeOutreach();
  const suppressions = fakeSuppressions();
  const deps: OutreachServiceDeps = {
    outreach,
    suppressions,
    contacts,
    accounts: fakeAccounts(),
    understanding: {
      getVersion: vi.fn(async () => null),
      getLatestVersionByProposalRef: vi.fn(async () => null),
      listVersions: vi.fn(async () => [understanding]),
      appendVersion: vi.fn(async () => "created" as const),
      applyReviewTransition: vi.fn(async () => "updated" as const),
    },
    strategy: {
      getLeadPlayVersion: vi.fn<StrategyRepository["getLeadPlayVersion"]>(
        async (_scope, versionId) => versionId === play.versionId ? play : null),
      getLatestLeadPlayVersionByStableKey: vi.fn<
        StrategyRepository["getLatestLeadPlayVersionByStableKey"]
      >(async (_scope, stableKey) => stableKey === play.stableKey ? play : null),
    },
    review: fakeReview(),
    runtime: runtimeDeps(),
    members: { countActiveMembers: vi.fn(async () => 2) },
    clock: () => new Date("2026-09-16T15:00:00.000Z"),
  };
  return Object.freeze({ ...deps, play, contact, outreach, suppressions });
}

function generateInput(
  fixture: Readonly<{ play: StoredLeadPlayVersion; contact: ContactVersionRow }>,
  overrides: Record<string, unknown> = {},
) {
  return {
    tenantId: TENANT,
    workspaceId: WORKSPACE,
    accountId: ACCOUNT,
    draftKind: "initial",
    playVersionId: fixture.play.versionId,
    contactVersionId: fixture.contact.versionId,
    optOutText: "To opt out, reply STOP.",
    actorId: MEMBER,
    ...overrides,
  };
}

function requireDraft(result: GeneratedOutreachDraft) {
  if (result.draft === null) throw new Error("expected a persisted draft");
  return result.draft;
}

async function generateApprovedDraft(
  deps: OutreachServiceDeps & Readonly<{ play: StoredLeadPlayVersion; contact: ContactVersionRow }>,
) {
  const generated = await generateOutreachDraft(deps, generateInput(deps));
  const draft = requireDraft(generated);
  const inReview = await transitionOutreachDraftReviewRequest(deps, {
    tenantId: TENANT, workspaceId: WORKSPACE, accountId: ACCOUNT,
    versionId: draft.versionId,
    expectedReviewHash: draft.review.reviewHash,
    to: "in_review", actorId: MEMBER,
    at: "2026-09-16T14:01:00.000Z",
    reason: "Queue the draft for human review.",
  });
  const approved = await transitionOutreachDraftReviewRequest(deps, {
    tenantId: TENANT, workspaceId: WORKSPACE, accountId: ACCOUNT,
    versionId: draft.versionId,
    expectedReviewHash: inReview.review.reviewHash,
    to: "approved", actorId: APPROVER,
    at: "2026-09-16T14:02:00.000Z",
    reason: "Approve recipient, channel, claims, opt-out, and CTA.",
  });
  return { generated, review: approved.review };
}

function handoffInput(
  fixture: Readonly<{ contact: ContactVersionRow }>,
  stableKey: string,
  overrides: Record<string, unknown> = {},
) {
  return {
    tenantId: TENANT,
    workspaceId: WORKSPACE,
    accountId: ACCOUNT,
    stableKey,
    action: "export",
    actorId: MEMBER,
    idempotencyKey: `handoff:${stableKey}:1`,
    recipientTimezone: "UTC",
    plannedAt: "2026-09-16T15:00:00.000Z",
    contactVersionId: fixture.contact.versionId,
    ...overrides,
  };
}

describe("l06 outreach service", () => {
  it("generates a cited draft through the bounded fixture run", async () => {
    const deps = await fixtureDeps();
    const result = await generateOutreachDraft(deps, generateInput(deps));
    expect(result.persisted).toBe("created");
    const draft = requireDraft(result);
    expect(draft.versionId).toMatch(/^outreach-draft-version:[0-9a-f]{64}$/u);
    expect(draft.review.status).toBe("draft");
    expect(draft.body).toContain("To opt out, reply STOP.");
    expect(draft.validationHash).toMatch(/^sha256:[0-9a-f]{64}$/u);
    expect(deps.outreach.drafts.get(draft.versionId)?.evidencePayload.citations.length)
      .toBeGreaterThan(0);
    expect(result.agentRunId).toBeTruthy();
  });

  it("replays an identical generation request without a duplicate revision", async () => {
    const deps = await fixtureDeps();
    const first = await generateOutreachDraft(deps, generateInput(deps));
    const replay = await generateOutreachDraft(deps, generateInput(deps));
    expect(replay.persisted).toBe("replayed");
    expect(replay.draft?.versionId).toBe(first.draft?.versionId);
    expect(replay.stableKey).toBe(first.stableKey);
    expect(deps.outreach.drafts.size).toBe(1);
  });

  it("blocks generation when the contact scope is suppressed", async () => {
    const deps = await fixtureDeps();
    const suppressionRepo = deps.suppressions as unknown as {
      insertRecord: (record: unknown) => Promise<"created" | "replayed">;
    };
    await suppressionRepo.insertRecord({
      recordId: `suppression-record:${"f".repeat(64)}`,
      schemaVersion: 1,
      tenantId: TENANT,
      workspaceId: WORKSPACE,
      accountId: ACCOUNT,
      contactStableKey: "contact:synthetic-procurement",
      disposition: "opt_out",
      reason: "The synthetic contact opted out.",
      source: { kind: "member_recorded", outcomeVersionId: null },
      actor: { kind: "human", actorId: MEMBER },
      occurredAt: "2026-09-16T00:00:00.000Z",
      recordedAt: "2026-09-16T00:00:00.000Z",
    });
    await expect(generateOutreachDraft(deps, generateInput(deps)))
      .rejects.toMatchObject({ code: "OUTREACH_SUPPRESSION_BLOCKED" });
  });

  it("rejects a non-draft-only or unapproved play fail-closed", async () => {
    const deps = await fixtureDeps();
    await expect(generateOutreachDraft(deps, generateInput(deps, {
      playVersionId: `lead-play-version:${"9".repeat(64)}`,
    }))).rejects.toMatchObject({ code: "OUTREACH_NOT_FOUND" });
  });

  it("enforces separation of duty on approval", async () => {
    const deps = await fixtureDeps();
    const generated = await generateOutreachDraft(deps, generateInput(deps));
    const draft = requireDraft(generated);
    const inReview = await transitionOutreachDraftReviewRequest(deps, {
      tenantId: TENANT, workspaceId: WORKSPACE, accountId: ACCOUNT,
      versionId: draft.versionId,
      expectedReviewHash: draft.review.reviewHash,
      to: "in_review", actorId: MEMBER,
      at: "2026-09-16T14:01:00.000Z", reason: "Queue for review.",
    });
    await expect(transitionOutreachDraftReviewRequest(deps, {
      tenantId: TENANT, workspaceId: WORKSPACE, accountId: ACCOUNT,
      versionId: draft.versionId,
      expectedReviewHash: inReview.review.reviewHash,
      to: "approved", actorId: MEMBER, reason: "Self-approval attempt.",
    })).rejects.toMatchObject({ code: "OUTREACH_SEPARATION_OF_DUTY" });
  });

  it("approves, binds current state, and releases a copy/export handoff", async () => {
    const deps = await fixtureDeps();
    const { generated } = await generateApprovedDraft(deps);

    const result = await requestOutreachHandoff(deps, handoffInput(deps, generated.stableKey));
    expect(result.status).toBe("released");
    if (result.status !== "released") throw new Error("expected release");
    expect(result.receipt.action).toBe("export");
    expect(result.receipt.draft.versionId).toBe(requireDraft(generated).versionId);
    expect(result.attempt.status).toBe("released");
    expect(result.attempt.receipt?.receiptId).toBe(result.receipt.receiptId);
  });

  it("rejects any action other than copy/export — no send path exists", async () => {
    const deps = await fixtureDeps();
    const { generated } = await generateApprovedDraft(deps);
    await expect(requestOutreachHandoff(deps, handoffInput(deps, generated.stableKey, {
      action: "send",
    }))).rejects.toMatchObject({ code: "OUTREACH_INPUT_INVALID" });
    expect(deps.outreach.attempts.size).toBe(0);
  });

  it("replays an identical handoff request through the idempotency key", async () => {
    const deps = await fixtureDeps();
    const { generated } = await generateApprovedDraft(deps);
    const first = await requestOutreachHandoff(deps, handoffInput(deps, generated.stableKey));
    const replay = await requestOutreachHandoff(deps, handoffInput(deps, generated.stableKey));
    expect(first.status).toBe("released");
    expect(replay.status).toBe("released");
    expect(replay.attempt.attemptId).toBe(first.attempt.attemptId);
    expect(deps.outreach.attempts.size).toBe(1);
  });

  it("conflicts when an idempotency key is reused with different inputs", async () => {
    const deps = await fixtureDeps();
    const { generated } = await generateApprovedDraft(deps);
    await requestOutreachHandoff(deps, handoffInput(deps, generated.stableKey));
    await expect(requestOutreachHandoff(deps, handoffInput(deps, generated.stableKey, {
      action: "copy",
    }))).rejects.toMatchObject({ code: "OUTREACH_IDEMPOTENCY_CONFLICT" });
  });

  it("records a blocked attempt during recipient-local quiet hours", async () => {
    const deps = await fixtureDeps();
    const { generated } = await generateApprovedDraft(deps);
    const result = await requestOutreachHandoff(deps, handoffInput(deps, generated.stableKey, {
      plannedAt: "2026-09-16T23:30:00.000Z", // 23:30 UTC — inside 21:00-08:00 quiet hours
      idempotencyKey: `handoff:${generated.stableKey}:quiet`,
    }));
    expect(result.status).toBe("blocked");
    if (result.status !== "blocked") throw new Error("expected blocked");
    expect(result.blockCode).toBe("OUTREACH_SCHEDULE_BLOCKED");
    expect(result.attempt.receipt).toBeNull();
  });

  it("records a blocked attempt when suppression lands after approval", async () => {
    const deps = await fixtureDeps();
    const { generated } = await generateApprovedDraft(deps);
    const suppressionRepo = deps.suppressions as unknown as {
      insertRecord: (record: unknown) => Promise<"created" | "replayed">;
    };
    await suppressionRepo.insertRecord({
      recordId: `suppression-record:${"e".repeat(64)}`,
      schemaVersion: 1,
      tenantId: TENANT,
      workspaceId: WORKSPACE,
      accountId: ACCOUNT,
      contactStableKey: "contact:synthetic-procurement",
      disposition: "do_not_contact",
      reason: "The synthetic account opted out post-approval.",
      source: { kind: "member_recorded", outcomeVersionId: null },
      actor: { kind: "human", actorId: MEMBER },
      occurredAt: "2026-09-16T13:00:00.000Z",
      recordedAt: "2026-09-16T13:00:00.000Z",
    });
    const result = await requestOutreachHandoff(deps, handoffInput(deps, generated.stableKey));
    expect(result.status).toBe("blocked");
    if (result.status !== "blocked") throw new Error("expected blocked");
    expect(result.blockCode).toBe("OUTREACH_SUPPRESSION_BLOCKED");
  });

  it("blocks handoff when the request targets a different recipient", async () => {
    const deps = await fixtureDeps();
    const { generated } = await generateApprovedDraft(deps);
    const result = await requestOutreachHandoff(deps, handoffInput(deps, generated.stableKey, {
      contactVersionId: `contact-version:${"0".repeat(64)}`,
    }));
    expect(result.status).toBe("blocked");
    if (result.status !== "blocked") throw new Error("expected blocked");
    expect(result.blockCode).toBe("OUTREACH_RECIPIENT_BLOCKED");
  });

  it("requires an approved current draft before any handoff", async () => {
    const deps = await fixtureDeps();
    const generated = await generateOutreachDraft(deps, generateInput(deps));
    await expect(requestOutreachHandoff(deps, handoffInput(deps, generated.stableKey)))
      .rejects.toMatchObject({ code: "OUTREACH_NOT_FOUND" });
  });

  it("lists handoff attempt views for audit", async () => {
    const deps = await fixtureDeps();
    const { generated } = await generateApprovedDraft(deps);
    await requestOutreachHandoff(deps, handoffInput(deps, generated.stableKey));
    const views = await listHandoffAttemptViews(deps, {
      tenantId: TENANT, workspaceId: WORKSPACE,
    }, { accountId: ACCOUNT });
    expect(views.length).toBeGreaterThan(0);
    expect(views[0]?.status).toBe("released");
  });
});
