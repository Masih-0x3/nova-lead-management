import { describe, expect, it, vi } from "vitest";

import type { AccountQualification } from "@/lib/qualification/account-qualification";
import type {
  QualificationRepository,
  QualificationRow,
} from "@/lib/qualification/repository";
import {
  evaluateQualification,
  reviewQualification,
} from "@/lib/qualification/service";

const TENANT = "10000000-0000-4000-8000-000000000001";
const WORKSPACE = "20000000-0000-4000-8000-000000000001";
const ACCOUNT = "30000000-0000-4000-8000-000000000001";
const REVIEWER = "40000000-0000-4000-8000-000000000001";
const hash = (character: string) => `sha256:${character.repeat(64)}`;
const PLAY_VERSION = `lead-play-version:${"a".repeat(64)}`;

function observation(index: number) {
  return {
    observationId: `observation:catalog-${index}`,
    tenantId: TENANT,
    workspaceId: WORKSPACE,
    accountId: ACCOUNT,
    observedAt: `2026-08-30T15:0${index}:00.000Z`,
    payloadHash: hash(String(index)),
    provenanceHash: hash(String(index + 2)),
  };
}

function evaluateInput(overrides: Record<string, unknown> = {}) {
  return {
    tenantId: TENANT,
    workspaceId: WORKSPACE,
    accountId: ACCOUNT,
    playVersionId: PLAY_VERSION,
    playContentHash: hash("a"),
    evaluatedAt: "2026-08-30T15:10:00.000Z",
    policy: {
      policyVersion: 1,
      policyId: "qualification-policy:industrial-fit-v1",
      qualifiedThreshold: 80,
      reviewThreshold: 50,
      factors: [
        { factorId: "factor:fit", weight: 60 },
        { factorId: "factor:readiness", weight: 40 },
      ],
    },
    observations: [observation(1), observation(2)],
    factors: [
      {
        factorId: "factor:fit",
        score: 90,
        reason: "The catalog explicitly matches the play's target market.",
        evidenceObservationIds: ["observation:catalog-1"],
        uncertainty: { level: "none", reason: null },
      },
      {
        factorId: "factor:readiness",
        score: 70,
        reason: "A current catalog supports a moderate readiness assessment.",
        evidenceObservationIds: ["observation:catalog-2"],
        uncertainty: { level: "none", reason: null },
      },
    ],
    ...overrides,
  };
}

function rowOf(record: AccountQualification): QualificationRow {
  return Object.freeze({
    versionId: record.versionId,
    tenantId: record.tenantId,
    workspaceId: record.workspaceId,
    accountId: record.accountId,
    playVersionId: record.playVersionId,
    playContentSha256: record.playContentHash.slice("sha256:".length),
    policySha256: record.policyHash.slice("sha256:".length),
    qualificationSha256: record.qualificationHash.slice("sha256:".length),
    weightedScore: record.weightedScore,
    automatedDecision: record.automatedDecision,
    decision: record.decision,
    reviewStatus: record.reviewStatus,
    evaluatedAt: record.evaluatedAt,
    payload: record as unknown as Record<string, unknown>,
    createdAt: record.evaluatedAt,
  });
}

function fakeRepository(overrides: Partial<QualificationRepository> = {}) {
  const rows = new Map<string, QualificationRow>();
  const repository: QualificationRepository = {
    insertQualification: vi.fn(async (record) => {
      const versionId = record.versionId as string;
      if (rows.has(versionId)) return "replayed";
      rows.set(versionId, rowOf(record as unknown as AccountQualification));
      return "created";
    }),
    getQualification: vi.fn(async (_t, _w, _a, versionId) => rows.get(versionId) ?? null),
    listQualifications: vi.fn(async () => [...rows.values()]),
    applyReview: vi.fn(async (_expected, record) => {
      rows.set(record.versionId as string, rowOf(record as unknown as AccountQualification));
    }),
    ...overrides,
  };
  return { repository, rows };
}

describe("l05 qualification service", () => {
  it("evaluates a deterministic snapshot and persists it", async () => {
    const { repository } = fakeRepository();
    const first = await evaluateQualification({ repository }, evaluateInput());
    expect(first.persisted).toBe("created");
    expect(first.qualification.weightedScore).toBe(82);
    expect(first.qualification.automatedDecision).toBe("qualified");
    expect(first.qualification.decision).toBe("qualified");
    expect(first.qualification.versionId).toMatch(/^account-qualification:[0-9a-f]{64}$/u);

    const replay = await evaluateQualification({ repository }, evaluateInput());
    expect(replay.persisted).toBe("replayed");
    expect(replay.qualification.qualificationHash)
      .toBe(first.qualification.qualificationHash);
  });

  it("enqueues a needs_review decision into the review queue port", async () => {
    const { repository } = fakeRepository();
    const reviewQueue = { enqueueQualificationReview: vi.fn(async () => undefined) };
    const result = await evaluateQualification({ repository, reviewQueue }, evaluateInput({
      factors: [{
        factorId: "factor:fit",
        score: 55,
        reason: "Partial fit against the play target market.",
        evidenceObservationIds: ["observation:catalog-1"],
        uncertainty: { level: "high", reason: "Source coverage is incomplete." },
      }, {
        factorId: "factor:readiness",
        score: 55,
        reason: "Limited readiness signal.",
        evidenceObservationIds: ["observation:catalog-2"],
        uncertainty: { level: "high", reason: "Sparse observations." },
      }],
    }));
    expect(result.qualification.automatedDecision).toBe("needs_review");
    expect(reviewQueue.enqueueQualificationReview).toHaveBeenCalledTimes(1);
    expect(reviewQueue.enqueueQualificationReview).toHaveBeenCalledWith(
      expect.objectContaining({
        tenantId: TENANT,
        workspaceId: WORKSPACE,
        versionId: result.qualification.versionId,
      }),
    );
  });

  it("does not enqueue when the decision is qualified", async () => {
    const { repository } = fakeRepository();
    const reviewQueue = { enqueueQualificationReview: vi.fn(async () => undefined) };
    await evaluateQualification({ repository, reviewQueue }, evaluateInput());
    expect(reviewQueue.enqueueQualificationReview).not.toHaveBeenCalled();
  });

  it("confirms an automated decision and then overrides with a reason", async () => {
    const { repository } = fakeRepository();
    const deps = { repository };
    const { qualification } = await evaluateQualification(deps, evaluateInput());

    const confirmed = await reviewQualification(deps, {
      tenantId: TENANT, workspaceId: WORKSPACE, accountId: ACCOUNT,
      versionId: qualification.versionId,
      expectedQualificationHash: qualification.qualificationHash,
      action: "confirm", actorId: REVIEWER,
      at: "2026-08-30T15:11:00.000Z",
      reason: "The evidence supports the automated qualification.",
    });
    expect(confirmed.qualification.versionId).not.toBe(qualification.versionId);
    expect(confirmed.qualification.reviewStatus).toBe("confirmed");
    expect(confirmed.qualification.decision).toBe("qualified");
    expect(confirmed.qualification.reviewEvents.at(-1)?.fromQualificationHash)
      .toBe(qualification.qualificationHash);

    const overridden = await reviewQualification(deps, {
      tenantId: TENANT, workspaceId: WORKSPACE, accountId: ACCOUNT,
      versionId: confirmed.qualification.versionId,
      expectedQualificationHash: confirmed.qualification.qualificationHash,
      action: "override", decision: "unqualified", actorId: REVIEWER,
      at: "2026-08-30T15:12:00.000Z",
      reason: "Human review found a material constraint outside the automated factors.",
    });
    expect(overridden.qualification.reviewStatus).toBe("overridden");
    expect(overridden.qualification.decision).toBe("unqualified");
    expect(overridden.qualification.automatedDecision).toBe("qualified");
  });

  it("rejects a stale expected hash and invalid actions", async () => {
    const { repository } = fakeRepository();
    const deps = { repository };
    const { qualification } = await evaluateQualification(deps, evaluateInput());

    await expect(reviewQualification(deps, {
      tenantId: TENANT, workspaceId: WORKSPACE, accountId: ACCOUNT,
      versionId: qualification.versionId,
      expectedQualificationHash: hash("f"),
      action: "confirm", actorId: REVIEWER,
      at: "2026-08-30T15:11:00.000Z",
      reason: "Review against a stale qualification hash.",
    })).rejects.toMatchObject({ code: "QUALIFICATION_STALE" });
    expect(repository.applyReview).not.toHaveBeenCalled();

    await expect(reviewQualification(deps, {
      tenantId: TENANT, workspaceId: WORKSPACE, accountId: ACCOUNT,
      versionId: qualification.versionId,
      expectedQualificationHash: qualification.qualificationHash,
      action: "bogus", actorId: REVIEWER,
      reason: "Invalid action.",
    })).rejects.toMatchObject({ code: "QUALIFICATION_INPUT_INVALID" });
  });

  it("maps a concurrent applyReview failure to QUALIFICATION_STALE", async () => {
    const store = fakeRepository();
    const { qualification } = await evaluateQualification(
      { repository: store.repository }, evaluateInput());
    store.repository.applyReview = vi.fn(async () => {
      throw new Error("hash moved");
    });
    await expect(reviewQualification({ repository: store.repository }, {
      tenantId: TENANT, workspaceId: WORKSPACE, accountId: ACCOUNT,
      versionId: qualification.versionId,
      expectedQualificationHash: qualification.qualificationHash,
      action: "confirm", actorId: REVIEWER,
      at: "2026-08-30T15:11:00.000Z",
      reason: "Lose the write race.",
    })).rejects.toMatchObject({ code: "QUALIFICATION_STALE" });
  });
});
