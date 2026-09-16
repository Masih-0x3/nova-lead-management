import { describe, expect, it, vi } from "vitest";

import type {
  AccountObservationRow,
  AccountRepository,
  AccountResolutionRow,
  CanonicalAccountRow,
  MergeEventRow,
  MergeSnapshotRow,
} from "@/lib/discovery/repository";
import {
  applyAccountMergeTransition,
  registerCanonicalAccount,
  resolveAccountObservationsService,
} from "@/lib/discovery/account-service";

const TENANT = "10000000-0000-4000-8000-000000000001";
const WORKSPACE = "20000000-0000-4000-8000-000000000001";
const REVIEWER = "30000000-0000-4000-8000-000000000001";
const HASH_A = `sha256:${"a".repeat(64)}`;
const HASH_B = `sha256:${"b".repeat(64)}`;

function observation(externalId: string, id = `observation:${externalId}`) {
  return {
    observationId: id,
    tenantId: TENANT,
    workspaceId: WORKSPACE,
    sourceKey: "google-places",
    namespace: "us:place-id",
    externalId,
    observedAt: "2026-08-30T16:00:00.000Z",
    payloadHash: HASH_A,
    provenanceHash: HASH_B,
  };
}

interface FakeAccountStore {
  repository: AccountRepository;
  accounts: Map<string, CanonicalAccountRow>;
  observations: AccountObservationRow[];
  resolutions: AccountResolutionRow[];
  mergeSnapshot: MergeSnapshotRow | null;
  mergeEvents: MergeEventRow[];
}

function accountRow(record: {
  accountId: string; tenantId: string; workspaceId: string; version: number;
  status: "active" | "merged"; redirectToAccountId: string | null; displayName: string | null;
  profile: Record<string, unknown>; profileSha256: string; exactKeys: readonly unknown[];
  observationRefs: readonly string[]; createdAt: string; updatedAt: string;
}): CanonicalAccountRow {
  return Object.freeze({
    accountId: record.accountId, tenantId: record.tenantId, workspaceId: record.workspaceId,
    version: record.version, status: record.status, redirectToAccountId: record.redirectToAccountId,
    displayName: record.displayName, profile: record.profile, profileSha256: record.profileSha256,
    exactKeys: Object.freeze([...record.exactKeys]),
    observationRefs: Object.freeze([...record.observationRefs]),
    createdAt: record.createdAt, updatedAt: record.updatedAt,
  });
}

function fakeAccountStore(): FakeAccountStore {
  const accounts = new Map<string, CanonicalAccountRow>();
  const observations: AccountObservationRow[] = [];
  const resolutions: AccountResolutionRow[] = [];
  const mergeEvents: MergeEventRow[] = [];
  const store: FakeAccountStore = {
    accounts, observations, resolutions, mergeEvents, mergeSnapshot: null,
    repository: {
      insertAccount: vi.fn(async (record) => {
        const key = `${record.tenantId}/${record.workspaceId}/${record.accountId}`;
        if (accounts.has(key)) return "replayed";
        accounts.set(key, accountRow(record));
        return "created";
      }),
      getAccount: vi.fn(async (tenantId, workspaceId, accountId) =>
        accounts.get(`${tenantId}/${workspaceId}/${accountId}`) ?? null),
      listAccounts: vi.fn(async (tenantId, workspaceId) =>
        [...accounts.values()].filter((row) =>
          row.tenantId === tenantId && row.workspaceId === workspaceId)),
      updateAccountProjection: vi.fn(async (record) => {
        const key = `${record.tenantId}/${record.workspaceId}/${record.accountId}`;
        const current = accounts.get(key);
        if (!current || current.version !== record.expectedVersion) {
          throw new Error("stale account version");
        }
        accounts.set(key, accountRow({ ...record, createdAt: current.createdAt }));
      }),
      insertObservationBinding: vi.fn(async (record) => {
        if (observations.some((row) => row.observationId === record.observationId)) {
          return "replayed";
        }
        observations.push(Object.freeze({
          ...record,
          sourceKey: record.sourceKey,
          createdAt: record.observedAt,
        }));
        return "created";
      }),
      listAccountObservations: vi.fn(async (tenantId, workspaceId, accountId) =>
        observations.filter((row) =>
          row.tenantId === tenantId && row.workspaceId === workspaceId
          && row.accountId === accountId)),
      listScopedObservations: vi.fn(async (tenantId, workspaceId) =>
        observations.filter((row) =>
          row.tenantId === tenantId && row.workspaceId === workspaceId)),
      insertResolution: vi.fn(async (record) => {
        if (resolutions.some((row) => row.resolutionId === record.resolutionId)) {
          return "replayed";
        }
        resolutions.push(Object.freeze({
          ...record,
          state: record.state as AccountResolutionRow["state"],
          observations: Object.freeze([...record.observations]),
          candidateAccountIds: Object.freeze([...record.candidateAccountIds]),
        }));
        return "created";
      }),
      listResolutions: vi.fn(async () => [...resolutions]),
      getMergeSnapshot: vi.fn(async () => store.mergeSnapshot),
      upsertMergeSnapshot: vi.fn(async (record, expected) => {
        if (store.mergeSnapshot === null) {
          if (expected !== null) throw new Error("missing merge snapshot");
        } else if (store.mergeSnapshot.stateSha256 !== expected) {
          throw new Error("stale merge snapshot");
        }
        store.mergeSnapshot = Object.freeze({
          tenantId: record.tenantId, workspaceId: record.workspaceId,
          members: Object.freeze([...record.members]),
          stateSha256: record.stateSha256, updatedAt: record.updatedAt,
        });
      }),
      insertMergeEvent: vi.fn(async (event) => {
        if (mergeEvents.some((row) => row.eventId === event.eventId)) return "replayed";
        mergeEvents.push(Object.freeze({
          ...event,
          evidenceObservationIds: Object.freeze([...event.evidenceObservationIds]),
          actor: event.actor,
        } as MergeEventRow));
        return "created";
      }),
      listMergeEvents: vi.fn(async () => [...mergeEvents]),
    },
  };
  return store;
}

const CLOCK = () => new Date("2026-08-30T17:00:00.000Z");

describe("l05 account service", () => {
  it("registers canonical accounts and materializes the merge ledger at two members", async () => {
    const store = fakeAccountStore();
    const deps = { repository: store.repository, clock: CLOCK };
    const first = await registerCanonicalAccount(deps, {
      tenantId: TENANT, workspaceId: WORKSPACE, displayName: "Acme Industrial",
      exactKeys: [{ sourceKey: "google-places", namespace: "us:place-id", externalId: "ChIJ-a" }],
    });
    const second = await registerCanonicalAccount(deps, {
      tenantId: TENANT, workspaceId: WORKSPACE, displayName: "Beta Formulators",
      exactKeys: [{ sourceKey: "google-places", namespace: "us:place-id", externalId: "ChIJ-b" }],
    });
    expect(first.accountId).not.toBe(second.accountId);
    expect(store.accounts.size).toBe(2);
    // Second registration materializes the scope merge ledger.
    expect(store.mergeSnapshot).not.toBeNull();
    expect(store.mergeSnapshot?.members).toHaveLength(2);
  });

  it("auto-resolves an exact-key observation onto the matched account", async () => {
    const store = fakeAccountStore();
    const deps = { repository: store.repository, clock: CLOCK };
    const { accountId } = await registerCanonicalAccount(deps, {
      tenantId: TENANT, workspaceId: WORKSPACE,
      exactKeys: [{ sourceKey: "google-places", namespace: "us:place-id", externalId: "ChIJ-one" }],
      observationRefs: ["observation:historic"],
    });
    const result = await resolveAccountObservationsService(deps, {
      tenantId: TENANT, workspaceId: WORKSPACE,
      observations: [observation("ChIJ-one")],
    });
    expect(result.applied).toBe("auto_resolved");
    expect(result.accountId).toBe(accountId);
    expect(result.resolution.ruleId).toBe("EXACT_SOURCE_ID_SAME_TENANT_NAMESPACE");
    expect(store.observations).toHaveLength(1);
    const updated = store.accounts.get(`${TENANT}/${WORKSPACE}/${accountId}`);
    expect(updated?.version).toBe(2);
    expect(updated?.observationRefs).toContain("observation:ChIJ-one");
  });

  it("promotes an unmatched observation set to a canonical candidate account", async () => {
    const store = fakeAccountStore();
    const deps = { repository: store.repository, clock: CLOCK };
    const result = await resolveAccountObservationsService(deps, {
      tenantId: TENANT, workspaceId: WORKSPACE,
      observations: [observation("ChIJ-new", "observation:new-1")],
    });
    expect(result.applied).toBe("canonical_candidate");
    expect(result.accountId).not.toBeNull();
    const promoted = store.accounts.get(`${TENANT}/${WORKSPACE}/${result.accountId}`);
    expect(promoted?.status).toBe("active");
    expect(promoted?.observationRefs).toContain("observation:new-1");
  });

  it("routes conflicting exact-key candidates to the review queue", async () => {
    const store = fakeAccountStore();
    const deps = { repository: store.repository, clock: CLOCK };
    for (let index = 0; index < 2; index += 1) {
      await registerCanonicalAccount(deps, {
        tenantId: TENANT, workspaceId: WORKSPACE,
        exactKeys: [{ sourceKey: "google-places", namespace: "us:place-id", externalId: "ChIJ-dup" }],
      });
    }
    const reviewQueue = { enqueueResolutionReview: vi.fn(async () => undefined) };
    const result = await resolveAccountObservationsService(
      { repository: store.repository, clock: CLOCK, reviewQueue }, {
        tenantId: TENANT, workspaceId: WORKSPACE,
        observations: [observation("ChIJ-dup", "observation:dup-1")],
      });
    expect(result.applied).toBe("human_review");
    expect(result.accountId).toBeNull();
    expect(reviewQueue.enqueueResolutionReview).toHaveBeenCalledWith(
      expect.objectContaining({ tenantId: TENANT, workspaceId: WORKSPACE }));
    expect(store.observations).toHaveLength(0);
  });

  it("applies a reversible merge and restores the retired account on unmerge", async () => {
    const store = fakeAccountStore();
    const deps = { repository: store.repository, clock: CLOCK };
    const survivor = await registerCanonicalAccount(deps, {
      tenantId: TENANT, workspaceId: WORKSPACE, displayName: "Survivor",
      observationRefs: ["observation:one"],
    });
    const retired = await registerCanonicalAccount(deps, {
      tenantId: TENANT, workspaceId: WORKSPACE, displayName: "Retired",
      observationRefs: ["observation:two"],
    });
    const ledgerHash = `sha256:${store.mergeSnapshot?.stateSha256}`;
    const merged = await applyAccountMergeTransition(deps, {
      tenantId: TENANT, workspaceId: WORKSPACE, action: "merge",
      survivorAccountId: survivor.accountId, retiredAccountId: retired.accountId,
      evidenceObservationIds: ["observation:one", "observation:two"],
      actorId: REVIEWER, expectedStateHash: ledgerHash,
      at: "2026-08-30T18:00:00.000Z",
      reason: "Duplicate accounts confirmed by human review.",
    });
    expect(merged.eventId).toMatch(/^account-merge-event:/u);
    const retiredRow = store.accounts.get(`${TENANT}/${WORKSPACE}/${retired.accountId}`);
    expect(retiredRow?.status).toBe("merged");
    expect(retiredRow?.redirectToAccountId).toBe(survivor.accountId);
    const survivorRow = store.accounts.get(`${TENANT}/${WORKSPACE}/${survivor.accountId}`);
    // The retired account keeps its provenance; the survivor version bumps.
    expect(survivorRow?.observationRefs).toContain("observation:one");
    expect(survivorRow?.version).toBe(2);
    expect(retiredRow?.observationRefs).toContain("observation:two");
    expect(store.mergeEvents).toHaveLength(1);

    const unmerged = await applyAccountMergeTransition(deps, {
      tenantId: TENANT, workspaceId: WORKSPACE, action: "unmerge",
      survivorAccountId: survivor.accountId, retiredAccountId: retired.accountId,
      evidenceObservationIds: ["observation:one", "observation:two"],
      actorId: REVIEWER, expectedStateHash: merged.snapshot.stateHash,
      at: "2026-08-30T18:30:00.000Z",
      reason: "Reverse the erroneous merge and restore the account.",
    });
    const restored = store.accounts.get(`${TENANT}/${WORKSPACE}/${retired.accountId}`);
    expect(restored?.status).toBe("active");
    expect(restored?.redirectToAccountId).toBeNull();
    expect(unmerged.snapshot.events).toHaveLength(2);
  });

  it("rejects a merge with a stale ledger hash", async () => {
    const store = fakeAccountStore();
    const deps = { repository: store.repository, clock: CLOCK };
    const survivor = await registerCanonicalAccount(deps, {
      tenantId: TENANT, workspaceId: WORKSPACE, displayName: "Survivor" });
    const retired = await registerCanonicalAccount(deps, {
      tenantId: TENANT, workspaceId: WORKSPACE, displayName: "Retired" });
    await expect(applyAccountMergeTransition(deps, {
      tenantId: TENANT, workspaceId: WORKSPACE, action: "merge",
      survivorAccountId: survivor.accountId, retiredAccountId: retired.accountId,
      evidenceObservationIds: ["observation:x"],
      actorId: REVIEWER, expectedStateHash: `sha256:${"f".repeat(64)}`,
      at: "2026-08-30T18:00:00.000Z", reason: "Attempt a merge with a stale ledger hash.",
    })).rejects.toMatchObject({ code: "RESOLUTION_STALE_STATE" });
  });
});
