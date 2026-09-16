import { createHash } from "node:crypto";

import { describe, expect, it, vi } from "vitest";

import type { BuyingCenter } from "@/lib/contacts/buying-center";
import type { ContactRecord } from "@/lib/contacts/contact-record";
import type {
  BuyingCenterRow,
  ContactRepository,
  ContactVersionRow,
} from "@/lib/contacts/repository";
import {
  registerBuyingCenter,
  registerContactRecord,
  supersedeContactRecord,
  transitionBuyingCenterReviewService,
  transitionContactReview,
} from "@/lib/contacts/service";

const TENANT = "10000000-0000-4000-8000-000000000001";
const WORKSPACE = "20000000-0000-4000-8000-000000000001";
const ACCOUNT = "30000000-0000-4000-8000-000000000001";
const REVIEWER = "40000000-0000-4000-8000-000000000001";
const PLAY_VERSION = `lead-play-version:${"a".repeat(64)}`;

function sha256(value: unknown): string {
  return `sha256:${createHash("sha256")
    .update(typeof value === "string" ? value : JSON.stringify(value)).digest("hex")}`;
}

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
      purpose: "qualification",
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

function evidenceRef() {
  const payload = {
    evidenceRefVersion: 1,
    tenantId: TENANT,
    workspaceId: WORKSPACE,
    accountId: ACCOUNT,
    playVersionId: PLAY_VERSION,
    evidenceId: "evidence:synthetic-procurement-role",
    evidenceVersionId: "evidence-version:synthetic-v1",
    evidenceContentHash: sha256("synthetic procurement evidence"),
    sourceReceiptHash: sha256("synthetic source receipt"),
    observedAt: "2026-08-30T12:00:00.000Z",
  };
  return { ...payload, evidenceRefHash: sha256(payload) };
}

function centerInput(overrides: Record<string, unknown> = {}) {
  return {
    tenantId: TENANT,
    workspaceId: WORKSPACE,
    accountId: ACCOUNT,
    playVersionId: PLAY_VERSION,
    stableKey: "buying-center:synthetic-account",
    hypotheses: [{
      status: "hypothesis",
      hypothesisKey: "role:procurement",
      roleKind: "standard",
      roleKey: "procurement",
      roleLabel: "Procurement",
      responsibility: "Evaluates commercial terms and supplier onboarding.",
      influence: "high",
      priority: 1,
      confidenceBasisPoints: 7_500,
      uncertainty: "The final approval authority is not yet established.",
      evidenceRefs: [evidenceRef()],
      contactVersionRef: null,
    }],
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

function centerRow(center: BuyingCenter): BuyingCenterRow {
  return Object.freeze({
    versionId: center.versionId,
    tenantId: center.tenantId,
    workspaceId: center.workspaceId,
    accountId: center.accountId,
    playVersionId: center.playVersionId,
    stableKey: center.stableKey,
    revision: center.revision,
    supersedesVersionId: center.supersedesVersionId,
    reviewStatus: center.review.status,
    hypothesisCount: center.hypotheses.length,
    verifiedContactCount: 0,
    contentSha256: center.contentHash.slice("sha256:".length),
    versionSha256: center.versionHash.slice("sha256:".length),
    reviewSha256: center.review.reviewHash.slice("sha256:".length),
    payload: center as unknown as Record<string, unknown>,
    createdAt: center.createdAt,
  });
}

function fakeRepository(overrides: Partial<ContactRepository> = {}): ContactRepository {
  const contacts = new Map<string, ContactVersionRow>();
  const centers = new Map<string, BuyingCenterRow>();
  return {
    insertContact: vi.fn(async (record) => {
      const versionId = record.versionId as string;
      if (contacts.has(versionId)) return "replayed";
      contacts.set(versionId, contactRow(record as unknown as ContactRecord));
      return "created";
    }),
    getContact: vi.fn(async (tenantId, workspaceId, versionId) =>
      contacts.get(versionId) ?? null),
    listContacts: vi.fn(async () => [...contacts.values()]),
    listAccountContacts: vi.fn(async () => [...contacts.values()]),
    updateContactReview: vi.fn(async (_expected, record) => {
      contacts.set(record.versionId as string, contactRow(record as unknown as ContactRecord));
    }),
    insertCenter: vi.fn(async (record) => {
      const versionId = record.versionId as string;
      if (centers.has(versionId)) return "replayed";
      centers.set(versionId, centerRow(record as unknown as BuyingCenter));
      return "created";
    }),
    getCenter: vi.fn(async (tenantId, workspaceId, versionId) => centers.get(versionId) ?? null),
    listCenters: vi.fn(async () => [...centers.values()]),
    listAccountCenters: vi.fn(async () => [...centers.values()]),
    updateCenterReview: vi.fn(async (_expected, record) => {
      centers.set(record.versionId as string, centerRow(record as unknown as BuyingCenter));
    }),
    ...overrides,
  };
}

describe("l05 contact service", () => {
  it("registers a v1 contact record and replays an identical insert", async () => {
    const repository = fakeRepository();
    const deps = { repository };
    const first = await registerContactRecord(deps, contactInput());
    expect(first.persisted).toBe("created");
    expect(first.record.versionId).toMatch(/^contact-version:[0-9a-f]{64}$/u);
    expect(first.record.review.status).toBe("draft");

    const replay = await registerContactRecord(deps, contactInput());
    expect(replay.persisted).toBe("replayed");
    expect(replay.record.versionId).toBe(first.record.versionId);
    expect(repository.insertContact).toHaveBeenCalledTimes(2);
  });

  it("rejects malformed service input before touching persistence", async () => {
    const repository = fakeRepository();
    await expect(registerContactRecord({ repository }, { tenantId: "not-a-uuid" }))
      .rejects.toMatchObject({ code: "CONTACT_INPUT_INVALID" });
    await expect(registerContactRecord({ repository }, "junk"))
      .rejects.toMatchObject({ code: "CONTACT_INPUT_INVALID" });
    expect(repository.insertContact).not.toHaveBeenCalled();
  });

  it("applies a draft -> in_review -> approved review chain on the same version", async () => {
    const repository = fakeRepository();
    const deps = { repository };
    const { record } = await registerContactRecord(deps, contactInput());

    const inReview = await transitionContactReview(deps, {
      tenantId: TENANT, workspaceId: WORKSPACE, accountId: ACCOUNT,
      versionId: record.versionId,
      expectedVersionId: record.versionId,
      expectedContentHash: record.contentHash,
      expectedReviewHash: record.review.reviewHash,
      to: "in_review", actorId: REVIEWER, at: "2026-08-30T13:01:00.000Z",
      reason: "Send the synthetic contact to human review.",
    });
    expect(inReview.record.versionId).toBe(record.versionId);
    expect(inReview.record.review.status).toBe("in_review");

    const approved = await transitionContactReview(deps, {
      tenantId: TENANT, workspaceId: WORKSPACE, accountId: ACCOUNT,
      versionId: inReview.record.versionId,
      expectedVersionId: inReview.record.versionId,
      expectedContentHash: inReview.record.contentHash,
      expectedReviewHash: inReview.record.review.reviewHash,
      to: "approved", actorId: REVIEWER, at: "2026-08-30T13:02:00.000Z",
      reason: "Approve the reviewed synthetic contact.",
    });
    expect(approved.record.review.status).toBe("approved");
    expect(repository.updateContactReview).toHaveBeenCalledTimes(2);
  });

  it("rejects a stale review hash without mutating the row", async () => {
    const repository = fakeRepository();
    const deps = { repository };
    const { record } = await registerContactRecord(deps, contactInput());

    await expect(transitionContactReview(deps, {
      tenantId: TENANT, workspaceId: WORKSPACE, accountId: ACCOUNT,
      versionId: record.versionId,
      expectedVersionId: record.versionId,
      expectedContentHash: record.contentHash,
      expectedReviewHash: `sha256:${"f".repeat(64)}`,
      to: "in_review", actorId: REVIEWER, at: "2026-08-30T13:01:00.000Z",
      reason: "Attempt a transition against a stale review hash.",
    })).rejects.toMatchObject({ code: "CONTACT_STALE" });
    expect(repository.updateContactReview).not.toHaveBeenCalled();
  });

  it("maps a concurrent update failure to CONTACT_STALE", async () => {
    const repository = fakeRepository({
      updateContactReview: vi.fn(async () => {
        throw new Error("row changed");
      }),
    });
    const writer = fakeRepository();
    const { record } = await registerContactRecord({ repository: writer }, contactInput());
    repository.getContact = vi.fn(async () => contactRow(record));

    await expect(transitionContactReview({ repository }, {
      tenantId: TENANT, workspaceId: WORKSPACE, accountId: ACCOUNT,
      versionId: record.versionId,
      expectedVersionId: record.versionId,
      expectedContentHash: record.contentHash,
      expectedReviewHash: record.review.reviewHash,
      to: "in_review", actorId: REVIEWER, at: "2026-08-30T13:01:00.000Z",
      reason: "Transition that loses the update race.",
    })).rejects.toMatchObject({ code: "CONTACT_STALE" });
  });

  it("rejects review against a record the scope cannot see", async () => {
    const repository = fakeRepository();
    const deps = { repository };
    const { record } = await registerContactRecord(deps, contactInput());
    const otherAccount = "30000000-0000-4000-8000-000000000099";

    await expect(transitionContactReview(deps, {
      tenantId: TENANT, workspaceId: WORKSPACE, accountId: otherAccount,
      versionId: record.versionId,
      expectedVersionId: record.versionId,
      expectedContentHash: record.contentHash,
      expectedReviewHash: record.review.reviewHash,
      to: "in_review", actorId: REVIEWER, at: "2026-08-30T13:01:00.000Z",
      reason: "Attempt to review a contact under a different account.",
    })).rejects.toMatchObject({ code: "CONTACT_NOT_FOUND" });
  });

  it("supersedes an approved record into revision n+1 on the same stable key", async () => {
    const repository = fakeRepository();
    const deps = { repository };
    const { record } = await registerContactRecord(deps, contactInput());
    const inReview = await transitionContactReview(deps, {
      tenantId: TENANT, workspaceId: WORKSPACE, accountId: ACCOUNT,
      versionId: record.versionId, expectedVersionId: record.versionId,
      expectedContentHash: record.contentHash,
      expectedReviewHash: record.review.reviewHash,
      to: "in_review", actorId: REVIEWER, at: "2026-08-30T13:01:00.000Z",
      reason: "Send to review.",
    });
    await transitionContactReview(deps, {
      tenantId: TENANT, workspaceId: WORKSPACE, accountId: ACCOUNT,
      versionId: record.versionId, expectedVersionId: record.versionId,
      expectedContentHash: inReview.record.contentHash,
      expectedReviewHash: inReview.record.review.reviewHash,
      to: "approved", actorId: REVIEWER, at: "2026-08-30T13:02:00.000Z",
      reason: "Approve.",
    });

    const next = await supersedeContactRecord(deps, contactInput({
      predecessorVersionId: record.versionId,
      createdAt: "2026-08-30T14:00:00.000Z",
    }));
    expect(next.persisted).toBe("created");
    expect(next.record.revision).toBe(2);
    expect(next.record.stableKey).toBe(record.stableKey);
    expect(next.record.supersedesVersionId).toBe(record.versionId);
  });

  it("registers a buying-center hypothesis record and reviews it in place", async () => {
    const repository = fakeRepository();
    const deps = { repository };
    const { center } = await registerBuyingCenter(deps, centerInput());
    expect(center.versionId).toMatch(/^buying-center-version:[0-9a-f]{64}$/u);
    expect(center.hypotheses[0]?.contactVersionRef).toBeNull();

    const reviewed = await transitionBuyingCenterReviewService(deps, {
      tenantId: TENANT, workspaceId: WORKSPACE, accountId: ACCOUNT,
      versionId: center.versionId,
      expectedVersionId: center.versionId,
      expectedContentHash: center.contentHash,
      expectedReviewHash: center.review.reviewHash,
      to: "in_review", actorId: REVIEWER, at: "2026-08-30T13:05:00.000Z",
      reason: "Send the buying-center hypothesis map to review.",
    });
    expect(reviewed.center.versionId).toBe(center.versionId);
    expect(reviewed.center.review.status).toBe("in_review");
  });
});
