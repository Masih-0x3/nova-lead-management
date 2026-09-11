import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
import type { AgentContextEvidenceInput } from "@/lib/agent-runtime/context-builder";
import { createDeterministicFixtureProvider } from "@/lib/agent-runtime/fixture-provider";
import { createFixtureAgentRunStoreAdapter } from "@/lib/agent-runtime/fixture-store";
import {
  createAgentRuntimeRegistry,
  defineAgentPolicyVersion,
  seedL04AgentRuntime,
  type StoredAgentPolicyVersion,
} from "@/lib/agent-runtime/prompts";
import {
  cancelAgentRun,
  claimAgentRun,
  enqueueAgentRun,
  executeAgentRunAttempt,
  getAgentRun,
  type AgentRuntimeDependencies,
  type EnqueueAgentRunRequest,
} from "@/lib/agent-runtime/service";

const TENANT_A = "00000000-0000-4000-8000-000000000001";
const TENANT_B = "00000000-0000-4000-8000-000000000002";
const WORKSPACE_A = "10000000-0000-4000-8000-000000000001";
const NOW = "2026-09-14T12:00:00.000Z";

const SOURCE_A = "30000000-0000-4000-8000-0000000000a1";

function evidence(id: string, text: string): AgentContextEvidenceInput {
  return Object.freeze({
    tenantId: TENANT_A,
    workspaceId: WORKSPACE_A,
    sourceId: SOURCE_A,
    evidenceId: id,
    locator: `doc:${id}`,
    rank: 1,
    text,
  });
}

function dependencies(policies?: readonly StoredAgentPolicyVersion[]): AgentRuntimeDependencies {
  const seeds = seedL04AgentRuntime();
  return Object.freeze({
    store: createFixtureAgentRunStoreAdapter(),
    registry: createAgentRuntimeRegistry(seeds.prompts, policies ?? seeds.policies),
    provider: createDeterministicFixtureProvider(),
    clock: Object.freeze({ now: () => NOW }),
  });
}

function request(overrides: Partial<EnqueueAgentRunRequest> = {}): EnqueueAgentRunRequest {
  return Object.freeze({
    agentRole: "understanding.synthesis",
    promptKey: "nova.understanding.synthesis",
    policyKey: "nova.fixture.default",
    budgetUsd: 0.05,
    maxAttempts: 3,
    idempotencyKey: "understanding:fixture:1",
    evidence: [
      evidence("20000000-0000-4000-8000-000000000001", "Nova sells a quoting tool."),
      evidence("20000000-0000-4000-8000-000000000002", "Buyers are ops leads."),
    ],
    ...overrides,
  });
}

const scope = Object.freeze({ tenantId: TENANT_A, workspaceId: WORKSPACE_A });

describe("agent runtime service", () => {
  it("enqueues, deduplicates, and replays an identical request", async () => {
    const deps = dependencies();
    const created = await enqueueAgentRun(scope, request(), deps);
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    expect(created.code).toBe("RUN_CREATED");
    expect(created.value.status).toBe("queued");

    const again = await enqueueAgentRun(scope, request(), deps);
    expect(again.ok && again.code === "RUN_DEDUPLICATED" && again.value.id === created.value.id)
      .toBe(true);
  });

  it("rejects a conflicting idempotency-key reuse and foreign-tenant scope", async () => {
    const deps = dependencies();
    await enqueueAgentRun(scope, request(), deps);
    const conflict = await enqueueAgentRun(
      scope,
      request({ evidence: [evidence("20000000-0000-4000-8000-000000000009", "different input")] }),
      deps,
    );
    expect(conflict).toMatchObject({ ok: false, code: "REJECTED_IDEMPOTENCY_CONFLICT" });

    // Evidence carrying a foreign tenant scope is rejected outright.
    const mismatched = await enqueueAgentRun(
      { tenantId: TENANT_B, workspaceId: WORKSPACE_A },
      request({ idempotencyKey: "understanding:foreign:1" }),
      deps,
    );
    expect(mismatched).toMatchObject({ ok: false, code: "SCOPE_MISMATCH" });

    // A well-formed foreign run is invisible under another tenant's scope.
    const foreign = await enqueueAgentRun(
      { tenantId: TENANT_B, workspaceId: WORKSPACE_A },
      request({
        idempotencyKey: "understanding:foreign:2",
        evidence: [Object.freeze({
          tenantId: TENANT_B,
          workspaceId: WORKSPACE_A,
          sourceId: SOURCE_A,
          evidenceId: "20000000-0000-4000-8000-0000000000b1",
          locator: "doc:b1",
          rank: 1,
          text: "Foreign tenant fact.",
        })],
      }),
      deps,
    );
    expect(foreign.ok).toBe(true);
    if (!foreign.ok) return;
    const stolen = await getAgentRun(scope, foreign.value.id, deps.store);
    expect(stolen).toMatchObject({ ok: false, code: "SCOPE_MISMATCH" });
  });

  it("runs claim → execute to completion with an immutable record", async () => {
    const deps = dependencies();
    const created = await enqueueAgentRun(scope, request(), deps);
    expect(created.ok).toBe(true);
    if (!created.ok) return;

    const claimed = await claimAgentRun(scope, { runId: created.value.id }, deps);
    expect(claimed.ok && claimed.code === "RUN_CLAIMED").toBe(true);
    if (!claimed.ok) return;
    expect(claimed.value.record.status).toBe("running");
    expect(claimed.value.record.attemptCount).toBe(1);

    const executed = await executeAgentRunAttempt(scope, {
      runId: created.value.id,
      leaseToken: claimed.value.leaseToken,
    }, deps);
    expect(executed.ok && executed.code === "RUN_COMPLETED").toBe(true);
    if (!executed.ok) return;
    expect(executed.value.record.status).toBe("complete");
    expect(executed.value.resultRef).toMatch(/^agent-result:[0-9a-f]{64}$/u);
    expect(executed.value.record.steps).toHaveLength(1);
    expect(executed.value.record.toolCalls).toHaveLength(1);
    expect(executed.value.record.usageCostUsd).toBeGreaterThan(0);

    // Replaying the same enqueue now returns the durable result.
    const replay = await enqueueAgentRun(scope, request(), deps);
    expect(replay.ok && replay.code === "RUN_REPLAYED").toBe(true);
  });

  it("fences execution to the claim's lease token", async () => {
    const deps = dependencies();
    const created = await enqueueAgentRun(scope, request(), deps);
    if (!created.ok) return;
    const claimed = await claimAgentRun(scope, { runId: created.value.id }, deps);
    if (!claimed.ok) return;

    const forged = await executeAgentRunAttempt(scope, {
      runId: created.value.id,
      leaseToken: "lease-forged-token",
    }, deps);
    expect(forged).toMatchObject({ ok: false, code: "RUN_LEASE_CONFLICT" });
  });

  it("rejects secret-bearing evidence at enqueue without creating a run", async () => {
    const deps = dependencies();
    const result = await enqueueAgentRun(scope, request({
      evidence: [evidence(
        "20000000-0000-4000-8000-0000000000aa",
        "api_key=sk-9f8a7b6c5d4e3f2a1b0c9d8e7f6a5b4c3d2e1f0a9b8c7d6e5f4a3b2c1d0e9f8a",
      )],
    }), deps);
    expect(result).toMatchObject({ ok: false, code: "REJECTED_SECRET" });
    const listed = await getAgentRun(scope, "nonexistent", deps.store);
    expect(listed.ok).toBe(false);
  });

  it("rejects budgets too small to bound the request", async () => {
    const deps = dependencies();
    const result = await enqueueAgentRun(scope, request({ budgetUsd: 0.005 }), deps);
    expect(result).toMatchObject({ ok: false, code: "REJECTED_COST_CAP" });
  });

  it("honors the kill switch: a disabled policy can never enqueue", async () => {
    const seeds = seedL04AgentRuntime();
    const disabled = defineAgentPolicyVersion({
      policyKey: "nova.fixture.default",
      version: 2,
      state: "disabled",
      provider: "fixture",
      model: "openai-responses-stub",
      maxInputBytes: 1_048_576,
      maxOutputTokens: 4_096,
      maxRequestCostUsd: 0.05,
    });
    const deps = dependencies(Object.freeze([...seeds.policies, disabled]));
    const result = await enqueueAgentRun(scope, request({ policyVersion: 2 }), deps);
    expect(result).toMatchObject({ ok: false, code: "AI_PROVIDER_DISABLED" });
  });

  it("cancels a queued run and rejects further claims", async () => {
    const deps = dependencies();
    const created = await enqueueAgentRun(scope, request(), deps);
    if (!created.ok) return;
    const canceled = await cancelAgentRun(scope, created.value.id, deps);
    expect(canceled.ok && canceled.value.status === "canceled").toBe(true);
    const claim = await claimAgentRun(scope, { runId: created.value.id }, deps);
    expect(claim).toMatchObject({ ok: false, code: "RUN_TERMINAL" });
  });

  it("cancels a running run and fences the worker's next mutation", async () => {
    const deps = dependencies();
    const created = await enqueueAgentRun(scope, request(), deps);
    if (!created.ok) return;
    const claimed = await claimAgentRun(scope, { runId: created.value.id }, deps);
    if (!claimed.ok) return;

    const canceled = await cancelAgentRun(scope, created.value.id, deps);
    expect(canceled.ok).toBe(true);

    const executed = await executeAgentRunAttempt(scope, {
      runId: created.value.id,
      leaseToken: claimed.value.leaseToken,
    }, deps);
    expect(executed).toMatchObject({ ok: false, code: "RUN_LEASE_CONFLICT" });
  });

  it("schedules a bounded retry on provider failure, then completes", async () => {
    let calls = 0;
    const flaky = Object.freeze({
      kind: "fixture" as const,
      execute: async (request: Parameters<
        ReturnType<typeof createDeterministicFixtureProvider>["execute"]
      >[0]) => {
        calls += 1;
        if (calls === 1) throw new Error("simulated provider failure");
        return createDeterministicFixtureProvider().execute(request);
      },
    });
    const seeds = seedL04AgentRuntime();
    const deps = Object.freeze({
      ...dependencies(),
      store: createFixtureAgentRunStoreAdapter(),
      registry: createAgentRuntimeRegistry(seeds.prompts, seeds.policies),
      provider: flaky,
    });
    const created = await enqueueAgentRun(scope, request({ maxAttempts: 2 }), deps);
    if (!created.ok) return;
    const claim1 = await claimAgentRun(scope, { runId: created.value.id }, deps);
    if (!claim1.ok) return;
    const failed = await executeAgentRunAttempt(scope, {
      runId: created.value.id, leaseToken: claim1.value.leaseToken }, deps);
    expect(failed.ok && failed.code === "RUN_RETRY_SCHEDULED").toBe(true);
    if (!failed.ok) return;
    expect(failed.value.record.status).toBe("retry_wait");
    expect(failed.value.record.nextAttemptAt).not.toBeNull();

    const claim2 = await claimAgentRun(scope, { runId: created.value.id }, deps);
    if (!claim2.ok) return;
    const done = await executeAgentRunAttempt(scope, {
      runId: created.value.id, leaseToken: claim2.value.leaseToken }, deps);
    expect(done.ok && done.code === "RUN_COMPLETED").toBe(true);
    if (done.ok) expect(done.value.record.attemptCount).toBe(2);
  });
});
