import { describe, expect, it } from "vitest";

import type { ConnectorCommandRepository } from "@/lib/connectors/command-repository";
import type { ConnectorAuthorityRepository } from "@/lib/connectors/repository";
import type { ConnectorSourceRunAuthoritySnapshot } from "@/lib/connectors/source-run-authority";
import {
  executeNextSourceUnit,
  settleSourceRunUnit,
  type ConnectorServiceDeps,
} from "@/lib/connectors/service";
import type { ConnectorRunnerResult } from "@/lib/connectors/runner";

const TENANT = "10000000-0000-4000-8000-000000000001";
const WORKSPACE = "20000000-0000-4000-8000-000000000001";
const OTHER_TENANT = "30000000-0000-4000-8000-000000000001";
const WORKER = "worker-a";
const NOW = "2026-09-15T12:00:00.000Z";
const HASH_A = "a".repeat(64);
const HASH_B = "b".repeat(64);
const HASH_C = "c".repeat(64);

function runRecord(overrides: Record<string, unknown> = {}) {
  return Object.freeze({
    id: "run-a", tenantId: TENANT, workspaceId: WORKSPACE, sourceCardId: "google_places_legacy",
    connectorVersion: 1, connectorAccountId: "account-a", sourcePolicyId: "policy-a",
    inputHash: HASH_C, operation: "search_text", status: "running", hardCapUnits: 5,
    maxAttempts: 3, cancelRequestedAt: null, ...overrides,
  });
}

function unitRecord(overrides: Record<string, unknown> = {}) {
  return Object.freeze({
    id: "unit-a", tenantId: TENANT, workspaceId: WORKSPACE, runId: "run-a",
    checkpointKey: "run-a:unit-a:page-1", inputHash: HASH_C, cursor: null, sequence: 1,
    status: "running", attemptCount: 1, maxAttempts: 3, reservedUnits: 1,
    leaseGeneration: 1, leaseTokenHash: HASH_A, leaseWorkerHash: HASH_B,
    leaseExpiresAt: "2026-09-15T12:05:00.000Z", ...overrides,
  });
}

function checkpoint(overrides: Record<string, unknown> = {}) {
  return {
    checkpointKey: "run-a:unit-a:page-1", inputHash: HASH_C, runId: "run-a", unitId: "unit-a",
    tenantId: TENANT, sourceCardId: "google_places_legacy", operation: "search_text",
    cursor: null, nextCursor: "page-2", status: "page_complete", attempts: 1, maxAttempts: 3,
    hardCapUnits: 5, reservedUnits: 1, actualUnits: 1, complete: false,
    observation: {
      sourceCardId: "google_places_legacy", operation: "search_text", tenantId: TENANT,
      runId: "run-a", observedAt: NOW,
      fields: { place_id: "places/example", business_name: "Example Industrial" },
    },
    retryReason: null, retryAfterMs: null, code: "D015_PASS",
    ...overrides,
  };
}

function pageResult(overrides: Record<string, unknown> = {}): ConnectorRunnerResult {
  return {
    status: "page_complete", code: "D015_PASS", checkpoint: checkpoint(), ...overrides,
  } as ConnectorRunnerResult;
}

type Calls = {
  completed: unknown[]; observations: unknown[]; settlements: unknown[];
  units: unknown[]; reservations: unknown[]; transitions: unknown[]; claims: unknown[];
};

function harness(options: {
  units?: readonly ReturnType<typeof unitRecord>[];
  run?: ReturnType<typeof runRecord> | null;
  runnable?: readonly { runId: string; unitId: string }[];
  committed?: number;
  snapshot?: ConnectorSourceRunAuthoritySnapshot | null;
}) {
  const units = [...(options.units ?? [unitRecord()])];
  const run = options.run === undefined ? runRecord() : options.run;
  const calls: Calls = {
    completed: [], observations: [], settlements: [], units: [], reservations: [],
    transitions: [], claims: [],
  };
  const auditEvents: unknown[] = [];
  const inScope = (tenantId: string, workspaceId: string | null) =>
    tenantId === TENANT && workspaceId === WORKSPACE;
  const authority: ConnectorAuthorityRepository = {
    loadRunAuthority: async (selector) =>
      inScope(selector.authorizedTenantId, selector.authorizedWorkspaceId)
        ? options.snapshot ?? null : null,
    listRegistryVersions: async () => [],
    listAccounts: async () => [],
    listPolicies: async () => [],
    listActivations: async () => [],
    listRuns: async (tenantId, workspaceId) =>
      (inScope(tenantId, workspaceId) && run ? [run] : []) as never,
    listUnits: async (tenantId, workspaceId) =>
      (inScope(tenantId, workspaceId) ? units : []) as never,
    listRunnableUnits: async (tenantId, workspaceId) =>
      inScope(tenantId, workspaceId) ? options.runnable ?? [] : [],
    runCommittedUnits: async (tenantId, workspaceId) =>
      inScope(tenantId, workspaceId) ? options.committed ?? units.length : 0,
    evaluateRunDecision: async () => null,
  };
  const commands: ConnectorCommandRepository = {
    insertRegistryVersion: async () => undefined,
    insertAccount: async () => "created",
    updateAccountStatus: async () => undefined,
    insertPolicyVersion: async () => "created",
    insertActivation: async () => "created",
    revokeActivation: async () => undefined,
    insertRun: async () => "created",
    insertUnit: async (record) => { calls.units.push(record); },
    insertReservation: async (record) => { calls.reservations.push(record); return "created"; },
    claimUnitLease: async (claim) => { calls.claims.push(claim); },
    completeUnit: async (outcome) => { calls.completed.push(outcome); },
    insertObservation: async (record) => { calls.observations.push(record); return "created"; },
    insertSettlement: async (record) => { calls.settlements.push(record); return "created"; },
    transitionRunStatus: async (input) => { calls.transitions.push(input); },
    requestRunCancellation: async () => undefined,
    findRunIdByIdempotencyKey: async () => null,
  };
  const deps: ConnectorServiceDeps = {
    authority, commands,
    audit: { record: async (event) => { auditEvents.push(event); } },
    clock: () => new Date(NOW),
  };
  return { deps, calls, auditEvents };
}

const settleInput = (result: ConnectorRunnerResult) => ({
  authorizedTenantId: TENANT, authorizedWorkspaceId: WORKSPACE,
  runId: "run-a", unitId: "unit-a", result,
});

describe("settleSourceRunUnit", () => {
  it("settles a page_complete outcome: unit, observation, settlement, continuation", async () => {
    const { deps, calls, auditEvents } = harness({});

    const result = await settleSourceRunUnit(deps, settleInput(pageResult()));

    expect(result.kind).toBe("settled");
    expect(result.runStatus).toBe("running");
    expect(result.observationId).toMatch(/^source-observation:/u);
    expect(result.continuationUnitId).toMatch(/^source-run-unit:/u);

    const completed = calls.completed[0] as Record<string, unknown>;
    expect(completed).toMatchObject({
      unitId: "unit-a", status: "page_complete", actualUnits: 1,
      nextCursor: "page-2", complete: false,
    });

    const observation = calls.observations[0] as Record<string, unknown>;
    expect(observation).toMatchObject({
      runId: "run-a", unitId: "unit-a", sourceCardId: "google_places_legacy",
      operation: "search_text", observedAt: NOW,
    });
    expect((observation.fieldNames as string[])).toEqual(["business_name", "place_id"]);

    const settlement = calls.settlements[0] as Record<string, unknown>;
    expect(settlement).toMatchObject({ unitId: "unit-a", actualUnits: 1 });
    expect((settlement.reservationId as string)).toMatch(/^source-reservation:/u);

    const continuation = calls.units[0] as Record<string, unknown>;
    expect(continuation).toMatchObject({
      runId: "run-a", predecessorUnitId: "unit-a", sequence: 2, cursor: "page-2",
      inputHash: HASH_C, reservedUnits: 1,
    });
    const reservation = calls.reservations[0] as Record<string, unknown>;
    expect(reservation).toMatchObject({ unitId: result.continuationUnitId, reservedUnits: 1 });

    expect(calls.transitions).toEqual([]);
    expect(auditEvents).toEqual([
      expect.objectContaining({ action: "connector.source_unit.settled" }),
    ]);
  });

  it("settles a completed outcome and transitions the run to completed", async () => {
    const { deps, calls } = harness({});
    const result = pageResult({
      status: "completed",
      checkpoint: checkpoint({ nextCursor: null, complete: true, status: "completed" }),
    });

    const settled = await settleSourceRunUnit(deps, settleInput(result));

    expect(settled.runStatus).toBe("completed");
    expect(settled.continuationUnitId).toBeUndefined();
    const completed = calls.completed[0] as Record<string, unknown>;
    expect(completed).toMatchObject({ status: "completed", complete: true, nextCursor: null });
    expect(calls.observations).toHaveLength(1);
    expect(calls.units).toHaveLength(0);
    expect(calls.transitions).toEqual([
      expect.objectContaining({ status: "completed" }),
    ]);
  });

  it("records retry_wait without settlement and moves the run to retry_wait", async () => {
    const { deps, calls } = harness({});
    const result = pageResult({
      status: "retry_wait", code: "D015_RETRYABLE",
      checkpoint: checkpoint({
        status: "retry_wait", retryReason: "rate_limited", retryAfterMs: 30_000,
        nextCursor: null, actualUnits: null, code: "D015_RETRYABLE",
      }),
    });

    const settled = await settleSourceRunUnit(deps, settleInput(result));

    expect(settled.runStatus).toBe("retry_wait");
    const completed = calls.completed[0] as Record<string, unknown>;
    expect(completed).toMatchObject({
      status: "retry_wait", actualUnits: null, nextCursor: null, complete: false,
      retryReason: "rate_limited", errorCode: "D015_RETRYABLE",
    });
    expect(Date.parse(completed.nextAttemptAt as string)).toBe(Date.parse(NOW) + 30_000);
    expect(calls.settlements).toHaveLength(0);
    expect(calls.observations).toHaveLength(0);
    expect(calls.transitions).toEqual([expect.objectContaining({ status: "retry_wait" })]);
  });

  it("settles a terminal failure and moves the run to failed", async () => {
    const { deps, calls } = harness({});
    const result = pageResult({
      status: "failed", code: "D015_RETRY_EXHAUSTED",
      checkpoint: checkpoint({
        status: "failed", nextCursor: null, actualUnits: null, complete: false,
        code: "D015_RETRY_EXHAUSTED",
      }),
    });

    const settled = await settleSourceRunUnit(deps, settleInput(result));

    expect(settled.runStatus).toBe("failed");
    const completed = calls.completed[0] as Record<string, unknown>;
    expect(completed).toMatchObject({ status: "failed", errorCode: "D015_RETRY_EXHAUSTED" });
    expect(calls.settlements).toHaveLength(1);
    expect(calls.observations).toHaveLength(0);
  });

  it("settles a cancelled outcome and moves the run to cancelled", async () => {
    const { deps, calls } = harness({});
    const result = pageResult({
      status: "cancelled", code: "D015_CANCELLED",
      checkpoint: checkpoint({ status: "cancelled", nextCursor: null, code: "D015_CANCELLED" }),
    });

    const settled = await settleSourceRunUnit(deps, settleInput(result));

    expect(settled.runStatus).toBe("cancelled");
    expect(calls.transitions).toEqual([expect.objectContaining({ status: "cancelled" })]);
  });

  it("settles a policy-blocked outcome without a checkpoint", async () => {
    const { deps, calls } = harness({});
    const result = { status: "blocked", code: "D015_SOURCE_POLICY_FAIL" } as ConnectorRunnerResult;

    const settled = await settleSourceRunUnit(deps, settleInput(result));

    expect(settled.runStatus).toBe("blocked");
    const completed = calls.completed[0] as Record<string, unknown>;
    expect(completed).toMatchObject({ status: "blocked", errorCode: "D015_SOURCE_POLICY_FAIL" });
    expect(calls.observations).toHaveLength(0);
  });

  it("blocks the run instead of inserting a continuation past the hard cap", async () => {
    const { deps, calls } = harness({
      committed: 5,
      run: runRecord({ hardCapUnits: 5 }),
    });

    const settled = await settleSourceRunUnit(deps, settleInput(pageResult()));

    expect(settled.runStatus).toBe("blocked");
    expect(settled.continuationUnitId).toBeUndefined();
    expect(calls.units).toHaveLength(0);
    expect(calls.transitions).toEqual([
      expect.objectContaining({ status: "blocked", errorCode: "D015_COST_FAIL" }),
    ]);
  });

  it("ignores paused, busy, and replay results without writes", async () => {
    const { deps, calls } = harness({});
    for (const status of ["paused", "busy", "replay"] as const) {
      const result = pageResult({ status, checkpoint: checkpoint({ status }) });
      const settled = await settleSourceRunUnit(deps, settleInput(result));
      expect(settled.kind).toBe("ignored");
    }
    expect(calls.completed).toHaveLength(0);
    expect(calls.observations).toHaveLength(0);
    expect(calls.settlements).toHaveLength(0);
    expect(calls.transitions).toHaveLength(0);
  });

  it("replays settle for an already-terminal unit without rewriting", async () => {
    const { deps, calls } = harness({ units: [unitRecord({ status: "page_complete" })] });

    const settled = await settleSourceRunUnit(deps, settleInput(pageResult()));

    expect(settled.kind).toBe("replayed");
    expect(calls.completed).toHaveLength(0);
  });

  it("rejects a checkpoint that does not belong to the unit", async () => {
    const { deps } = harness({});
    const result = pageResult({ checkpoint: checkpoint({ runId: "run-foreign" }) });

    await expect(settleSourceRunUnit(deps, settleInput(result))).rejects.toMatchObject({
      code: "CONNECTOR_SCOPE_MISMATCH",
    });
  });

  it("rejects settling a unit that is not under an active lease", async () => {
    const { deps } = harness({ units: [unitRecord({ status: "queued" })] });

    await expect(settleSourceRunUnit(deps, settleInput(pageResult()))).rejects.toMatchObject({
      code: "CONNECTOR_STALE_STATE",
    });
  });

  it("requires a checkpoint for successful statuses", async () => {
    const { deps } = harness({});
    const result = { status: "completed", code: "D015_PASS" } as ConnectorRunnerResult;

    await expect(settleSourceRunUnit(deps, settleInput(result))).rejects.toMatchObject({
      code: "CONNECTOR_INPUT_INVALID",
    });
  });
});

function snapshotFixture(): ConnectorSourceRunAuthoritySnapshot {
  return {
    registryVersion: {
      sourceCardId: "google_places_legacy", version: 1, executionMode: "fixture",
      transport: "none", operations: ["search_text"],
      outputFields: ["place_id", "business_name"], adapterSha256: HASH_A,
    },
    account: {
      id: "account-a", tenantId: TENANT, workspaceId: WORKSPACE,
      sourceCardId: "google_places_legacy", connectorVersion: 1,
      status: "fixture_only", credentialRefHash: null,
    },
    policy: {
      id: "policy-a", tenantId: TENANT, workspaceId: WORKSPACE,
      sourceCardId: "google_places_legacy", connectorVersion: 1,
      connectorAccountId: "account-a", policyKey: "fixture-policy", version: 1,
      state: "active", executionMode: "fixture", termsState: "approved",
      allowedOperations: ["search_text"], allowedFields: ["place_id", "business_name"],
      hardCapUnits: 5, attestationExpiresAt: null, attestationRevoked: false,
      policySha256: HASH_B,
    },
    activation: {
      id: "activation-a", tenantId: TENANT, workspaceId: WORKSPACE,
      policyKey: "fixture-policy", policyVersion: 1, sourcePolicyId: "policy-a",
      activatedAt: "2026-09-15T11:00:00.000Z", revokedAt: null,
    },
    run: runRecord(),
    unit: unitRecord(),
  } as ConnectorSourceRunAuthoritySnapshot;
}

describe("executeNextSourceUnit", () => {
  it("returns idle when no unit is runnable", async () => {
    const { deps, calls } = harness({ runnable: [] });

    const result = await executeNextSourceUnit(deps, {
      authorizedTenantId: TENANT, authorizedWorkspaceId: WORKSPACE,
      workerId: WORKER, leaseMs: 60_000,
      execute: async () => ({
        observation: {
          sourceCardId: "google_places_legacy", operation: "search_text",
          tenantId: TENANT, runId: "run-a", observedAt: NOW,
          fields: { place_id: "places/example" },
        },
        nextCursor: null, complete: true, actualUnits: 1,
      }),
    });

    expect(result.status).toBe("idle");
    expect(calls.claims).toHaveLength(0);
  });

  it("claims, executes, and settles the next runnable unit", async () => {
    const { deps, calls } = harness({
      runnable: [{ runId: "run-a", unitId: "unit-a" }],
      units: [unitRecord({ status: "running" })],
      snapshot: snapshotFixture(),
    });

    const result = await executeNextSourceUnit(deps, {
      authorizedTenantId: TENANT, authorizedWorkspaceId: WORKSPACE,
      workerId: WORKER, leaseMs: 60_000,
      execute: async () => ({
        observation: {
          sourceCardId: "google_places_legacy", operation: "search_text",
          tenantId: TENANT, runId: "run-a", observedAt: NOW,
          fields: { place_id: "places/example" },
        },
        nextCursor: null, complete: true, actualUnits: 1,
      }),
    });

    expect(result.status).toBe("executed");
    expect(result.unitId).toBe("unit-a");
    expect(result.settle?.kind).toBe("settled");
    expect(calls.claims).toHaveLength(1);
    expect(calls.completed).toHaveLength(1);
    expect(calls.observations).toHaveLength(1);
    expect(calls.settlements).toHaveLength(1);
    expect(calls.transitions).toEqual([
      expect.objectContaining({ status: "running" }),
      expect.objectContaining({ status: "completed" }),
    ]);
  });

  it("fails closed when the authority vanishes between scan and claim", async () => {
    const { deps, calls } = harness({
      runnable: [{ runId: "run-a", unitId: "unit-a" }],
      units: [unitRecord({ status: "running" })],
      snapshot: null,
    });

    await expect(executeNextSourceUnit(deps, {
      authorizedTenantId: TENANT, authorizedWorkspaceId: WORKSPACE,
      workerId: WORKER, leaseMs: 60_000,
      execute: async () => ({ observation: null, nextCursor: null, complete: true, actualUnits: 1 }),
    })).rejects.toMatchObject({ code: "CONNECTOR_NOT_FOUND" });
    expect(calls.claims).toHaveLength(0);
    expect(calls.completed).toHaveLength(0);
  });

  it("idles for a foreign tenant scope without claiming or executing", async () => {
    const { deps, calls } = harness({
      runnable: [{ runId: "run-a", unitId: "unit-a" }],
      snapshot: snapshotFixture(),
    });
    let executorCalls = 0;

    const result = await executeNextSourceUnit(deps, {
      authorizedTenantId: OTHER_TENANT, authorizedWorkspaceId: WORKSPACE,
      workerId: WORKER, leaseMs: 60_000,
      execute: async () => {
        executorCalls += 1;
        return { observation: null, nextCursor: null, complete: true, actualUnits: 1 };
      },
    });

    expect(result.status).toBe("idle");
    expect(calls.claims).toHaveLength(0);
    expect(executorCalls).toBe(0);
  });
});
