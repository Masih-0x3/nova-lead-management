import { createHash } from "node:crypto";

import { describe, expect, it, vi } from "vitest";

import type {
  LearningRepository,
  StoredLearningProposal,
} from "@/lib/learning/repository";
import {
  listLearningProposalViews,
  proposeLearning,
  transitionLearningReview,
} from "@/lib/learning/service";
import type { LearningProposal } from "@/lib/outcomes/learning-proposal";
import type {
  OutcomeRepository,
  StoredOutcomeVersion,
} from "@/lib/outcomes/repository";
import { recordOutcome } from "@/lib/outcomes/service";
import type { StoredLeadPlayVersion, StrategyRepository } from "@/lib/strategy/service";

const TENANT = "10000000-0000-4000-8000-000000000001";
const WORKSPACE = "20000000-0000-4000-8000-000000000001";
const ACCOUNT = "30000000-0000-4000-8000-000000000001";
const MEMBER = "40000000-0000-4000-8000-000000000001";
const PLAY_VERSION = `lead-play-version:${"a".repeat(64)}`;
const PLAY_HASH = `sha256:${"c".repeat(64)}`;

function sha256(value: unknown): string {
  return `sha256:${createHash("sha256")
    .update(typeof value === "string" ? value : JSON.stringify(value)).digest("hex")}`;
}

function fakeOutcomes(): OutcomeRepository & { rows: Map<string, StoredOutcomeVersion> } {
  const rows = new Map<string, StoredOutcomeVersion>();
  return {
    rows,
    insertVersion: vi.fn(async (record) => {
      if (rows.has(record.versionId)) return "replayed" as const;
      rows.set(record.versionId, Object.freeze({
        tenantId: record.tenantId,
        workspaceId: record.workspaceId,
        accountId: record.accountId,
        playVersionId: record.playVersionId,
        stableKey: record.stableKey,
        revision: record.revision,
        draftVersionId: null,
        record,
        createdAt: record.recordedAt,
      }));
      return "created" as const;
    }),
    getVersion: vi.fn(async (tenantId, workspaceId, accountId, versionId) => {
      const row = rows.get(versionId);
      return row && row.tenantId === tenantId && row.workspaceId === workspaceId
        && row.accountId === accountId ? row : null;
    }),
    getLatestVersion: vi.fn(async () => null),
    listVersions: vi.fn(async () => [...rows.values()]),
  };
}

function fakeLearning(): LearningRepository & { rows: Map<string, StoredLearningProposal> } {
  const rows = new Map<string, StoredLearningProposal>();
  const store = (proposal: LearningProposal) => Object.freeze({
    tenantId: proposal.tenantId,
    workspaceId: proposal.workspaceId,
    accountId: proposal.accountId,
    playVersionId: proposal.playVersionId,
    stableKey: proposal.stableKey,
    revision: proposal.revision,
    proposal,
    createdAt: proposal.createdAt,
  });
  return {
    rows,
    insertVersion: vi.fn(async (proposal: LearningProposal) => {
      if (rows.has(proposal.versionId)) return "replayed" as const;
      rows.set(proposal.versionId, store(proposal));
      return "created" as const;
    }),
    getVersion: vi.fn(async (tenantId, workspaceId, accountId, versionId) => {
      const row = rows.get(versionId);
      return row && row.tenantId === tenantId && row.workspaceId === workspaceId
        && row.accountId === accountId ? row : null;
    }),
    getLatestVersion: vi.fn(async (tenantId, workspaceId, accountId, playVersionId, stableKey) =>
      [...rows.values()]
        .filter((row) => row.tenantId === tenantId && row.workspaceId === workspaceId
          && row.accountId === accountId && row.playVersionId === playVersionId
          && row.stableKey === stableKey)
        .sort((a, b) => b.revision - a.revision)[0] ?? null),
    listVersions: vi.fn(async (tenantId, workspaceId, filter) =>
      [...rows.values()].filter((row) =>
        row.tenantId === tenantId && row.workspaceId === workspaceId
        && (filter?.accountId === undefined || row.accountId === filter.accountId)
        && (filter?.playVersionId === undefined || row.playVersionId === filter.playVersionId)
        && (filter?.stableKey === undefined || row.stableKey === filter.stableKey))),
    updateReview: vi.fn(async (_expected, proposal) => {
      rows.set(proposal.versionId, store(proposal));
    }),
  };
}

function fakeStrategy(): Pick<StrategyRepository, "getLeadPlayVersion"> {
  const play = Object.freeze({
    tenantId: TENANT,
    workspaceId: WORKSPACE,
    versionId: PLAY_VERSION,
    stableKey: "lead-play:formulation-change",
    revision: 1,
    supersedesVersionId: null,
    contentHash: PLAY_HASH,
    icpVersionId: `icp-version:${"d".repeat(64)}`,
    understandingVersionId: `understanding-version:${"e".repeat(64)}`,
    source: null,
    review: null,
    createdAt: "2026-09-10T00:00:00.000Z",
    updatedAt: "2026-09-10T00:00:00.000Z",
  }) as unknown as StoredLeadPlayVersion;
  return { getLeadPlayVersion: vi.fn(async () => play) };
}

function tickClock(start = "2026-09-16T00:00:00.000Z") {
  let at = Date.parse(start);
  return () => new Date(at += 60_000);
}

async function seedOutcome(
  outcomes: OutcomeRepository,
  stableKey: string,
  outcome: string,
  overrides: Record<string, unknown> = {},
) {
  const result = await recordOutcome({ outcomes, clock: tickClock() }, {
    tenantId: TENANT,
    workspaceId: WORKSPACE,
    accountId: ACCOUNT,
    playVersionId: PLAY_VERSION,
    stableKey,
    outcome,
    channel: "email",
    occurredAt: "2026-09-15T12:00:00.000Z",
    notes: `Synthetic ${outcome} observation.`,
    source: {
      kind: "member_observation",
      sourceId: "member:inbox",
      sourceVersionId: `observation:${stableKey}`,
      sourceContentHash: sha256(`content:${stableKey}`),
      sourceReceiptHash: sha256(`receipt:${stableKey}`),
      observedAt: "2026-09-15T12:05:00.000Z",
    },
    recordedBy: MEMBER,
    ...overrides,
  });
  return result.record;
}

function input(outcomeVersionIds: readonly string[], overrides: Record<string, unknown> = {}) {
  return {
    tenantId: TENANT,
    workspaceId: WORKSPACE,
    accountId: ACCOUNT,
    playVersionId: PLAY_VERSION,
    stableKey: "learning:reply-rate-v1",
    outcomeVersionIds,
    cohort: {
      cohortId: "cohort:september-outreach",
      windowStart: "2026-09-01T00:00:00.000Z",
      windowEnd: "2026-09-16T00:00:00.000Z",
    },
    metric: { metricKey: "reply_rate", formulaVersion: "d013:v1" },
    change: {
      kind: "qualification_threshold_basis_points",
      targetKey: "qualification.min_confidence",
      currentValue: 6_000,
      proposedValue: 7_500,
      rationale: "Low-confidence accounts produced zero replies in the cohort.",
    },
    uncertainties: [{
      uncertaintyId: "uncertainty:small-sample",
      statement: "The cohort contains a small synthetic sample.",
      impact: "Treat the estimate as directional until the cohort grows.",
      severity: 2,
    }],
    expectedImpact: {
      direction: "increase",
      estimateBasisPoints: 1_500,
      lowerBoundBasisPoints: 500,
      upperBoundBasisPoints: 3_000,
      horizonDays: 30,
      rationale: "Tightening the threshold concentrates outreach on cited accounts.",
    },
    rollback: {
      triggerMetricKey: "reply_rate",
      triggerThresholdBasisPoints: 500,
      reason: "Roll back if the reply rate collapses below the prior baseline.",
    },
    ...overrides,
  };
}

describe("l06 learning service", () => {
  it("proposes a versioned reversible change bound to the current play hash", async () => {
    const outcomes = fakeOutcomes();
    const learning = fakeLearning();
    const deps = {
      learning, outcomes, strategy: fakeStrategy(),
      clock: () => new Date("2026-09-16T01:00:00.000Z"),
    };
    const replied = await seedOutcome(outcomes, "outcome:a", "replied");
    const bounced = await seedOutcome(outcomes, "outcome:b", "bounced", {
      bounceClassification: "hard_bounce",
    });

    const result = await proposeLearning(deps, input([replied.versionId, bounced.versionId]));
    expect(result.created).toBe(true);
    const proposal = result.proposal;
    expect(proposal.versionId).toMatch(/^learning-proposal-version:[0-9a-f]{64}$/u);
    expect(proposal.review.status).toBe("draft");
    expect(proposal.metric.metricKey).toBe("reply_rate");
    expect(proposal.metric.numerator).toBe(1);
    expect(proposal.metric.denominator).toBe(2);
    expect(proposal.metric.valueBasisPoints).toBe(5_000);
    expect(proposal.rollback.restorePlayVersionId).toBe(PLAY_VERSION);
    expect(proposal.rollback.restorePolicyHash).toBe(PLAY_HASH);
    expect(proposal.target.currentPolicyHash).toBe(PLAY_HASH);
  });

  it("rejects outcome refs outside the proposal scope", async () => {
    const outcomes = fakeOutcomes();
    const learning = fakeLearning();
    const deps = {
      learning, outcomes, strategy: fakeStrategy(),
      clock: () => new Date("2026-09-16T01:00:00.000Z"),
    };
    const foreign = await recordOutcome(
      { outcomes, clock: () => new Date("2026-09-16T00:00:00.000Z") },
      {
        tenantId: TENANT,
        workspaceId: WORKSPACE,
        accountId: ACCOUNT,
        playVersionId: `lead-play-version:${"b".repeat(64)}`,
        stableKey: "outcome:foreign",
        outcome: "replied",
        channel: "email",
        occurredAt: "2026-09-15T12:00:00.000Z",
        notes: "Foreign play outcome.",
        source: {
          kind: "member_observation",
          sourceId: "member:inbox",
          sourceVersionId: "observation:foreign",
          sourceContentHash: sha256("foreign"),
          sourceReceiptHash: sha256("foreign-receipt"),
          observedAt: "2026-09-15T12:05:00.000Z",
        },
        recordedBy: MEMBER,
      },
    );
    await expect(proposeLearning(deps, input([foreign.record.versionId])))
      .rejects.toMatchObject({ code: "LEARNING_OUTCOME_SCOPE" });
    expect(learning.insertVersion).not.toHaveBeenCalled();
  });

  it("walks draft -> in_review -> approved with human actors only", async () => {
    const outcomes = fakeOutcomes();
    const learning = fakeLearning();
    const deps = {
      learning, outcomes, strategy: fakeStrategy(),
      clock: tickClock("2026-09-16T01:00:00.000Z"),
    };
    const outcome = await seedOutcome(outcomes, "outcome:a", "replied");
    const { proposal } = await proposeLearning(deps, input([outcome.versionId]));

    const inReview = await transitionLearningReview(deps, {
      tenantId: TENANT, workspaceId: WORKSPACE, accountId: ACCOUNT,
      playVersionId: PLAY_VERSION, versionId: proposal.versionId,
      to: "in_review", actorId: MEMBER, reason: "Queue for review.",
    });
    expect(inReview.review.status).toBe("in_review");

    await expect(transitionLearningReview(deps, {
      tenantId: TENANT, workspaceId: WORKSPACE, accountId: ACCOUNT,
      playVersionId: PLAY_VERSION, versionId: proposal.versionId,
      to: "approved", actorId: MEMBER, reason: "Stale review hash.",
      expectedReviewHash: proposal.review.reviewHash,
    })).rejects.toThrow();

    const approved = await transitionLearningReview(deps, {
      tenantId: TENANT, workspaceId: WORKSPACE, accountId: ACCOUNT,
      playVersionId: PLAY_VERSION, versionId: proposal.versionId,
      to: "approved", actorId: MEMBER, reason: "Approve the bounded change.",
    });
    expect(approved.review.status).toBe("approved");
  });

  it("lists proposal views scoped to the account", async () => {
    const outcomes = fakeOutcomes();
    const learning = fakeLearning();
    const deps = {
      learning, outcomes, strategy: fakeStrategy(),
      clock: () => new Date("2026-09-16T01:00:00.000Z"),
    };
    const outcome = await seedOutcome(outcomes, "outcome:a", "replied");
    await proposeLearning(deps, input([outcome.versionId]));

    const views = await listLearningProposalViews(deps, {
      tenantId: TENANT, workspaceId: WORKSPACE, accountId: ACCOUNT,
    });
    expect(views).toHaveLength(1);
    expect(views[0]?.stableKey).toBe("learning:reply-rate-v1");
  });
});
