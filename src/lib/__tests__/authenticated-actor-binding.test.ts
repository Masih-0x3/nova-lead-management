import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import type { TenantSession } from "@/lib/auth";
import type { DbClient } from "@/lib/db";
import type { StrategyRepository } from "@/lib/strategy/service";
import type { UnderstandingRepository } from "@/lib/understanding/service";

const strategyRepository = vi.hoisted(() => ({
  current: null as StrategyRepository | null,
}));
const understandingRepository = vi.hoisted(() => ({
  current: null as UnderstandingRepository | null,
}));
const dbBoundary = vi.hoisted(() =>
  vi.fn(async (callback: (client: DbClient) => Promise<unknown>) =>
    callback({ prepare: vi.fn(), exec: vi.fn() } as unknown as DbClient)));

vi.mock("@/lib/db", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/db")>();
  return { ...actual, withTenantDbContext: dbBoundary };
});
vi.mock("@/lib/strategy/repository", () => ({
  createPostgresStrategyRepository: () => strategyRepository.current,
}));
vi.mock("@/lib/understanding/repository", () => ({
  createPostgresUnderstandingRepository: () => understandingRepository.current,
  createPostgresQuestionRepository: () => ({}),
}));

import {
  transitionAuthenticatedUnderstandingReview,
} from "@/lib/understanding/authenticated-service";
import {
  transitionAuthenticatedLeadPlayActivation,
} from "@/lib/strategy/authenticated-service";
import {
  buildBusinessUnderstandingProposal,
  transitionBusinessUnderstandingReview,
} from "@/lib/understanding/business-understanding";

const TENANT = "10000000-0000-4000-8000-0000000000b1";
const WORKSPACE = "20000000-0000-4000-8000-0000000000b1";
const SESSION_USER = "30000000-0000-4000-8000-0000000000b1";
const FORGED_USER = "40000000-0000-4000-8000-0000000000b1";
const MEMBERSHIP = "50000000-0000-4000-8000-0000000000b1";
const BINDING = "60000000-0000-4000-8000-0000000000b1";
const HASH_A = `sha256:${"a".repeat(64)}`;
const HASH_B = `sha256:${"b".repeat(64)}`;

const scope = Object.freeze({ tenantId: TENANT, workspaceId: WORKSPACE });

function session(overrides: Partial<TenantSession> = {}): TenantSession {
  return {
    userId: SESSION_USER,
    email: "owner@example.test",
    displayName: "Owner",
    tenantId: TENANT,
    workspaceId: WORKSPACE,
    membershipId: MEMBERSHIP,
    role: "owner",
    roleBindingId: BINDING,
    ...overrides,
  };
}

const dependencies = Object.freeze({
  correlationId: "actor-binding-test",
  sessionBoundary: async () => session(),
});

function understandingInReview() {
  const source = {
    version: 1,
    tenantId: TENANT,
    workspaceId: WORKSPACE,
    proposalRef: "understanding:actor-binding",
    revision: 1,
    supersedesProposalRef: null,
    supersedesVersionId: null,
    createdAt: "2026-08-30T12:00:00.000Z",
    producer: {
      runRef: "agent-run:actor-binding",
      runInputHash: HASH_A,
      agentVersion: "understanding-synthesizer:v1",
      modelRef: "fixture:deterministic",
      promptRef: "business-understanding@1",
      promptHash: HASH_A,
      policyRef: "evidence-policy:v1",
      policyHash: HASH_B,
    },
    evidence: [{
      evidenceId: "evidence:catalog",
      tenantId: TENANT,
      workspaceId: WORKSPACE,
      sourceVersionRef: "document-version:catalog",
      locator: "page=2#buyers",
      contentHash: HASH_A,
      grade: "direct_observation",
      freshness: "current",
    }],
    claims: [{
      claimId: "claim:buyers",
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
      evidenceIds: ["evidence:catalog"],
      uncertaintyReason: null,
    }],
  };
  const built = buildBusinessUnderstandingProposal(source);
  if (!built.ok) throw new Error(built.code);
  const reviewing = transitionBusinessUnderstandingReview({
    version: 1,
    tenantId: TENANT,
    workspaceId: WORKSPACE,
    current: built.proposal.review,
    expectedVersionId: built.proposal.review.versionId,
    expectedContentHash: built.proposal.review.contentHash,
    expectedReviewHash: built.proposal.review.reviewHash,
    to: "in_review",
    actor: { kind: "human", actorId: SESSION_USER },
    at: "2026-08-30T12:01:00.000Z",
    reason: "Submitting for human review.",
    replacement: null,
  });
  if (!reviewing.ok) throw new Error(reviewing.code);
  return { source, review: reviewing.review };
}

describe("authenticated adapters bind the actor to the resolved session", () => {
  it("rejects a forged actor on the understanding review boundary", async () => {
    const { source, review } = understandingInReview();
    const applied: unknown[] = [];
    understandingRepository.current = {
      getVersion: async () => ({
        tenantId: TENANT,
        workspaceId: WORKSPACE,
        versionId: review.versionId,
        proposalRef: review.proposalRef,
        revision: review.revision,
        supersedesProposalRef: null,
        supersedesVersionId: null,
        contentHash: review.contentHash,
        claimSetHash: review.claimSetHash,
        source: source as unknown,
        review,
        createdAt: "2026-08-30T12:00:00.000Z",
        updatedAt: "2026-08-30T12:01:00.000Z",
      }),
      getLatestVersionByProposalRef: async () => null,
      listVersions: async () => [],
      appendVersion: async () => "conflict" as const,
      applyReviewTransition: async (_s, _v, _h, _r, event) => {
        applied.push(event);
        return "updated" as const;
      },
    };

    await expect(transitionAuthenticatedUnderstandingReview(scope, {
      versionId: review.versionId,
      expectedReviewHash: review.reviewHash,
      to: "approved",
      reason: "Human approval.",
      actor: { kind: "human", actorId: FORGED_USER },
    }, dependencies)).rejects.toMatchObject({
      name: "TenantAuthorizationError",
      status: 403,
      code: "PERMISSION_DENIED",
    });
    expect(applied).toHaveLength(0);
  });

  it("attributes the persisted review event to the session user", async () => {
    const { source, review } = understandingInReview();
    const applied: Array<{ actor?: { actorId?: string } }> = [];
    understandingRepository.current = {
      getVersion: async () => ({
        tenantId: TENANT,
        workspaceId: WORKSPACE,
        versionId: review.versionId,
        proposalRef: review.proposalRef,
        revision: review.revision,
        supersedesProposalRef: null,
        supersedesVersionId: null,
        contentHash: review.contentHash,
        claimSetHash: review.claimSetHash,
        source: source as unknown,
        review,
        createdAt: "2026-08-30T12:00:00.000Z",
        updatedAt: "2026-08-30T12:01:00.000Z",
      }),
      getLatestVersionByProposalRef: async () => null,
      listVersions: async () => [],
      appendVersion: async () => "conflict" as const,
      applyReviewTransition: async (_s, _v, _h, _r, event) => {
        applied.push(event);
        return "updated" as const;
      },
    };

    const result = await transitionAuthenticatedUnderstandingReview(scope, {
      versionId: review.versionId,
      expectedReviewHash: review.reviewHash,
      to: "approved",
      reason: "Human approval.",
      actor: { kind: "human", actorId: SESSION_USER },
    }, dependencies);

    expect(result).toMatchObject({ ok: true, code: "UNDERSTANDING_REVIEW_TRANSITIONED" });
    expect(applied).toHaveLength(1);
    expect(applied[0]?.actor?.actorId).toBe(SESSION_USER);
  });

  it("derives the session actor when the request omits it", async () => {
    const { source, review } = understandingInReview();
    const applied: Array<{ actor?: { actorId?: string } }> = [];
    understandingRepository.current = {
      getVersion: async () => ({
        tenantId: TENANT,
        workspaceId: WORKSPACE,
        versionId: review.versionId,
        proposalRef: review.proposalRef,
        revision: review.revision,
        supersedesProposalRef: null,
        supersedesVersionId: null,
        contentHash: review.contentHash,
        claimSetHash: review.claimSetHash,
        source: source as unknown,
        review,
        createdAt: "2026-08-30T12:00:00.000Z",
        updatedAt: "2026-08-30T12:01:00.000Z",
      }),
      getLatestVersionByProposalRef: async () => null,
      listVersions: async () => [],
      appendVersion: async () => "conflict" as const,
      applyReviewTransition: async (_s, _v, _h, _r, event) => {
        applied.push(event);
        return "updated" as const;
      },
    };

    const request = {
      versionId: review.versionId,
      expectedReviewHash: review.reviewHash,
      to: "approved" as const,
      reason: "Human approval.",
    };
    const result = await transitionAuthenticatedUnderstandingReview(
      scope,
      request as Parameters<typeof transitionAuthenticatedUnderstandingReview>[1],
      dependencies,
    );

    expect(result).toMatchObject({ ok: true, code: "UNDERSTANDING_REVIEW_TRANSITIONED" });
    expect(applied[0]?.actor?.actorId).toBe(SESSION_USER);
  });

  it("rejects a forged actor on the activation boundary before persistence", async () => {
    const calls: string[] = [];
    strategyRepository.current = {
      getActivationState: async () => {
        calls.push("getActivationState");
        return null;
      },
    } as unknown as StrategyRepository;

    await expect(transitionAuthenticatedLeadPlayActivation(scope, {
      stableKey: "lead-play:forged",
      playVersionId: "70000000-0000-4000-8000-0000000000b1",
      action: "activate",
      reason: "Attempt to activate under a forged reviewer.",
      actor: { kind: "human", actorId: FORGED_USER },
    }, dependencies)).rejects.toMatchObject({
      name: "TenantAuthorizationError",
      status: 403,
      code: "PERMISSION_DENIED",
    });
    expect(calls).toHaveLength(0);
  });

  it("rejects a non-human actor kind on the activation boundary", async () => {
    await expect(transitionAuthenticatedLeadPlayActivation(scope, {
      stableKey: "lead-play:forged",
      playVersionId: "70000000-0000-4000-8000-0000000000b1",
      action: "activate",
      reason: "Attempt to activate under a system actor.",
      actor: { kind: "system", actorId: SESSION_USER } as never,
    }, dependencies)).rejects.toMatchObject({
      status: 403,
      code: "PERMISSION_DENIED",
    });
  });
});
