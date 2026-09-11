import "server-only";

import { createHash, randomUUID } from "node:crypto";
import { isProxy } from "node:util/types";

import {
  buildAgentContext,
  type AgentContextEvidenceInput,
} from "@/lib/agent-runtime/context-builder";
import {
  createFixtureAgentExecutionBoundary,
  type AgentFixtureExecutionBoundary,
  type AgentFixtureModelProvider,
} from "@/lib/agent-runtime/execution";
import type {
  AgentRunRecord,
  AgentRunStatus,
  CreateAgentRunInput,
} from "@/lib/agent-runtime/records";
import {
  AgentRunRecordError,
} from "@/lib/agent-runtime/records";
import {
  agentPolicyRef,
  agentPromptRef,
  type AgentRuntimeRegistry,
} from "@/lib/agent-runtime/prompts";

/**
 * Bounded specialist-run orchestration (L-04 / 0X3-243).
 *
 * Every run is content-bound: `inputHash` commits to the exact serialized
 * evidence context, the prompt/policy versions, and the run id. Enqueue is
 * idempotent on (tenant, workspace, idempotencyKey); execution is fenced by
 * the run lease and budget-enforced on every recorded tool call. The model
 * call sits behind the fixture provider seam — no live paid API is wired.
 */

export type AgentRuntimeScope = Readonly<{ tenantId: string; workspaceId: string | null }>;

/** The persisted enqueue-time input a claimed attempt rehydrates. */
export interface StoredAgentRunInput {
  readonly agentRole: string;
  readonly promptKey: string;
  readonly promptVersion: number;
  readonly policyKey: string;
  readonly policyVersion: number;
  readonly correlationToken: string;
  readonly requestedOutputTokens: number;
  readonly estimatedCostUsd: number;
  readonly maxEvidenceCount: number;
  readonly maxUtf8Bytes: number;
  readonly evidence: readonly AgentContextEvidenceInput[];
}

export type AgentRunStoreOutcome =
  | Readonly<{ action: "created" | "deduplicated"; record: AgentRunRecord }>
  | Readonly<{ action: "replay"; record: AgentRunRecord; resultRef: string }>;

export interface AgentRunStorePort {
  createOrReplay(input: CreateAgentRunInput, runInput: StoredAgentRunInput): Promise<AgentRunStoreOutcome>;
  getRunInput(scope: AgentRuntimeScope, runId: string): Promise<StoredAgentRunInput | null>;
  get(scope: AgentRuntimeScope & Readonly<{ runId: string }>): Promise<AgentRunRecord>;
  lease(input: AgentRuntimeScope & Readonly<{
    runId: string; workerId: string; leaseToken: string; now: string; leaseDurationMs: number;
  }>): Promise<AgentRunRecord>;
  heartbeat(input: AgentRuntimeScope & Readonly<{
    runId: string; leaseToken: string; now: string; leaseDurationMs: number;
  }>): Promise<AgentRunRecord>;
  appendStep(input: AgentRuntimeScope & Readonly<{
    runId: string; leaseToken: string; stepId: string; status: "complete" | "failed" | "blocked";
    policyRef: string; resultRef: string | null; errorCode: string | null; recordedAt: string;
  }>): Promise<AgentRunRecord>;
  appendToolCall(input: AgentRuntimeScope & Readonly<{
    runId: string; leaseToken: string; stepId: string; toolCallId: string; toolName: string;
    toolVersion: string; permissionDecision: "allowed" | "denied";
    status: "complete" | "failed" | "denied"; inputHash: string; outputHash: string | null;
    sourceIds: readonly string[]; costUsd: number; latencyMs: number;
    errorCode: string | null; redactedSummary: string; recordedAt: string;
  }>): Promise<AgentRunRecord>;
  complete(input: AgentRuntimeScope & Readonly<{
    runId: string; leaseToken: string; resultRef: string; completedAt: string; usageCostUsd: number;
  }>): Promise<AgentRunRecord>;
  fail(input: AgentRuntimeScope & Readonly<{
    runId: string; leaseToken: string; errorCode: string; failedAt: string;
    usageCostUsd: number; retryAt: string | null;
  }>): Promise<AgentRunRecord>;
  cancel(input: AgentRuntimeScope & Readonly<{ runId: string; canceledAt: string }>): Promise<AgentRunRecord>;
}

export interface AgentRuntimeClock {
  now(): string;
}

export const systemAgentRuntimeClock: AgentRuntimeClock = Object.freeze({
  now: () => new Date().toISOString(),
});

export interface AgentRuntimeIds {
  runId(): string;
  leaseToken(): string;
  correlationToken(): string;
}

export const randomAgentRuntimeIds: AgentRuntimeIds = Object.freeze({
  runId: () => randomUUID(),
  leaseToken: () => `lease-${randomUUID()}`,
  correlationToken: () => `corr-${randomUUID().replaceAll("-", "")}`,
});

/** Optional tenant-budget seam; defaults to the run's own remaining budget. */
export interface TenantBudgetPort {
  remainingUsd(scope: AgentRuntimeScope): Promise<number>;
}

export interface AgentRuntimeDependencies {
  readonly store: AgentRunStorePort;
  readonly registry: AgentRuntimeRegistry;
  readonly provider: AgentFixtureModelProvider;
  readonly tenantBudget?: TenantBudgetPort;
  readonly clock?: AgentRuntimeClock;
  readonly ids?: AgentRuntimeIds;
  readonly maxLeaseDurationMs?: number;
  readonly maxDeadlineMs?: number;
}

export type AgentRuntimeCode =
  | "RUN_CREATED"
  | "RUN_DEDUPLICATED"
  | "RUN_REPLAYED"
  | "RUN_CLAIMED"
  | "RUN_COMPLETED"
  | "RUN_FAILED"
  | "RUN_RETRY_SCHEDULED"
  | "RUN_DEAD_LETTERED"
  | "RUN_CANCELED"
  | "RUN_READ"
  | "MALFORMED_INPUT"
  | "SCOPE_MISMATCH"
  | "REJECTED_IDEMPOTENCY_CONFLICT"
  | "REJECTED_MODEL_POLICY_GAP"
  | "REJECTED_COST_CAP"
  | "REJECTED_SECRET"
  | "REJECTED_INJECTION"
  | "AI_PROVIDER_DISABLED"
  | "RUN_NOT_FOUND"
  | "RUN_TERMINAL"
  | "RUN_LEASE_CONFLICT"
  | "RUN_EXECUTION_BLOCKED";

export type AgentRuntimeResult<T = undefined> =
  | Readonly<{ ok: true; code: AgentRuntimeCode; value: T }>
  | Readonly<{ ok: false; code: AgentRuntimeCode }>;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const REF = /^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,255}$/u;
const IDEMPOTENCY = /^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/u;
const RUN_REF = /^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,127}$/u;
const MAX_BUDGET_USD = 100;
const MAX_ATTEMPTS = 10;
const DEFAULT_LEASE_MS = 60_000;
const MAX_LEASE_MS = 300_000;
const MAX_EVIDENCE = 64;
const MAX_CONTEXT_BYTES = 1_048_576;
const MIN_REQUEST_COST_USD = 0.02;
const RETRYABLE_CODES = new Set(["PROVIDER_FAILED", "RUN_DEADLINE_EXCEEDED"]);

function usdMicrosExact(value: number): boolean {
  return Number.isFinite(value) && value >= 0
    && Math.abs(Math.round(value * 1_000_000) / 1_000_000 - value) < Number.EPSILON;
}

// DNS-namespace uuid v5 over the idempotent identity: the run id is hashed
// into inputHash, so it must be deterministic for replay/dedup to converge.
const RUN_ID_NAMESPACE = "6ba7b810-9dad-11d1-80b4-00c04fd430c8";

export function deterministicAgentRunId(
  scope: AgentRuntimeScope,
  idempotencyKey: string,
): string {
  const namespaceBytes = Buffer.from(RUN_ID_NAMESPACE.replaceAll("-", ""), "hex");
  const name = `${scope.tenantId} ${scope.workspaceId ?? ""} ${idempotencyKey}`;
  const bytes = createHash("sha1").update(namespaceBytes).update(name, "utf8").digest()
    .subarray(0, 16);
  bytes[6] = (bytes[6] & 0x0f) | 0x50;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function fail(code: AgentRuntimeCode): AgentRuntimeResult<never> {
  return Object.freeze({ ok: false, code });
}

function validScope(scope: AgentRuntimeScope): boolean {
  return typeof scope?.tenantId === "string" && UUID.test(scope.tenantId)
    && (scope.workspaceId === null
      || (typeof scope.workspaceId === "string" && UUID.test(scope.workspaceId)));
}

function sha256Prefixed(value: string): string {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

function mapStoreError(error: unknown): AgentRuntimeResult<never> {
  if (error instanceof AgentRunRecordError) {
    switch (error.code) {
      case "RUN_NOT_FOUND": return fail("RUN_NOT_FOUND");
      case "RUN_TERMINAL": return fail("RUN_TERMINAL");
      case "RUN_LEASE_CONFLICT":
      case "RUN_LEASE_EXPIRED":
      case "RUN_RETRY_NOT_READY":
      case "RUN_ATTEMPTS_EXHAUSTED": return fail("RUN_LEASE_CONFLICT");
      case "REJECTED_IDEMPOTENCY_CONFLICT": return fail("REJECTED_IDEMPOTENCY_CONFLICT");
      case "REJECTED_SCOPE_TENANT_MISMATCH": return fail("SCOPE_MISMATCH");
      case "RUN_ID_CONFLICT":
      case "INVALID_AGENT_RUN_RECORD":
      default: return fail("MALFORMED_INPUT");
    }
  }
  return fail("MALFORMED_INPUT");
}

export interface EnqueueAgentRunRequest {
  readonly agentRole: string;
  readonly promptKey: string;
  readonly promptVersion?: number;
  readonly policyKey: string;
  readonly policyVersion?: number;
  readonly budgetUsd: number;
  readonly maxAttempts: number;
  readonly idempotencyKey: string;
  readonly requestedOutputTokens?: number;
  readonly maxEvidenceCount?: number;
  readonly evidence: readonly AgentContextEvidenceInput[];
  readonly runId?: string;
}

function canonicalContentBlock(
  runId: string,
  scope: AgentRuntimeScope,
  serializedContext: string,
  outputSha256: string,
): Readonly<{
  runId: string;
  tenantId: string;
  workspaceId: string | null;
  sourceRef: string;
  classification: "tenant_business_materials";
  text: string;
}> {
  return Object.freeze({
    runId,
    tenantId: scope.tenantId,
    workspaceId: scope.workspaceId,
    sourceRef: `agent-context:${outputSha256.slice("sha256:".length)}`,
    classification: "tenant_business_materials" as const,
    text: serializedContext,
  });
}

/**
 * Idempotent enqueue. The canonical input hash commits to run id + scope +
 * the exact serialized evidence context; the exact same request replays, a
 * divergent reuse of the idempotency key conflicts, and the evidence input is
 * persisted for later attempts.
 */
export async function enqueueAgentRun(
  scope: AgentRuntimeScope,
  request: EnqueueAgentRunRequest,
  dependencies: AgentRuntimeDependencies,
): Promise<AgentRuntimeResult<AgentRunRecord>> {
  try {
    if (!validScope(scope) || isProxy(request)
      || typeof request.agentRole !== "string" || !REF.test(request.agentRole)
      || typeof request.promptKey !== "string" || request.promptKey.length === 0
      || typeof request.policyKey !== "string" || request.policyKey.length === 0
      || typeof request.idempotencyKey !== "string" || !IDEMPOTENCY.test(request.idempotencyKey)
      || !Array.isArray(request.evidence)
      || !Number.isFinite(request.budgetUsd) || request.budgetUsd <= 0
      || request.budgetUsd > MAX_BUDGET_USD || !usdMicrosExact(request.budgetUsd)
      || !Number.isSafeInteger(request.maxAttempts)
      || request.maxAttempts < 1 || request.maxAttempts > MAX_ATTEMPTS) {
      return fail("MALFORMED_INPUT");
    }

    const registry = dependencies.registry;
    const prompt = request.promptVersion === undefined
      ? registry.getLatestPrompt(request.promptKey)
      : registry.getPrompt(request.promptKey, request.promptVersion);
    const policy = request.policyVersion === undefined
      ? registry.getLatestPolicy(request.policyKey)
      : registry.getPolicy(request.policyKey, request.policyVersion);
    if (!prompt || !policy) return fail("REJECTED_MODEL_POLICY_GAP");
    if (policy.state === "disabled") return fail("AI_PROVIDER_DISABLED");
    if (policy.state !== "fixture" || policy.provider !== "fixture"
      || policy.model !== "openai-responses-stub") {
      return fail("REJECTED_MODEL_POLICY_GAP");
    }

    const ids = dependencies.ids ?? randomAgentRuntimeIds;
    const clock = dependencies.clock ?? systemAgentRuntimeClock;
    const runId = request.runId ?? deterministicAgentRunId(scope, request.idempotencyKey);
    if (typeof runId !== "string" || !UUID.test(runId)) return fail("MALFORMED_INPUT");

    const maxEvidenceCount = request.maxEvidenceCount ?? MAX_EVIDENCE;
    const maxUtf8Bytes = Math.min(policy.maxInputBytes, MAX_CONTEXT_BYTES);
    let context;
    try {
      context = buildAgentContext({
        version: 1,
        tenantId: scope.tenantId,
        workspaceId: scope.workspaceId,
        maxEvidenceCount,
        maxUtf8Bytes,
        evidence: request.evidence,
      });
    } catch (error) {
      if (error instanceof Error && "code" in error) {
        const code = (error as { code?: unknown }).code;
        if (code === "FORBIDDEN_SECRET") return fail("REJECTED_SECRET");
        if (code === "TENANT_SCOPE_MISMATCH") return fail("SCOPE_MISMATCH");
      }
      return fail("MALFORMED_INPUT");
    }

    const content = canonicalContentBlock(
      runId,
      scope,
      context.serializedContext,
      context.outputSha256,
    );
    const inputHash = sha256Prefixed(JSON.stringify({
      runId,
      tenantId: scope.tenantId,
      workspaceId: scope.workspaceId,
      content: [content],
    }));

    const requestedOutputTokens = Math.min(
      request.requestedOutputTokens ?? policy.maxOutputTokens,
      policy.maxOutputTokens,
    );
    // The preflight parses USD to integer micros, so estimates must be exact
    // micro multiples. The fixture provider's worst-case cost is bounded by
    // (maxInputBytes/8 + maxOutputTokens) * 1e-7 ~= $0.0135 for the seeded
    // policy; $0.02 covers every conforming response.
    const remaining = dependencies.tenantBudget
      ? await dependencies.tenantBudget.remainingUsd(scope)
      : request.budgetUsd;
    const estimatedCostUsd = Math.min(
      policy.maxRequestCostUsd,
      request.budgetUsd,
      Number.isFinite(remaining) ? remaining : 0,
    );
    if (estimatedCostUsd < MIN_REQUEST_COST_USD) {
      return fail("REJECTED_COST_CAP");
    }

    const outcome = await dependencies.store.createOrReplay(Object.freeze({
      id: runId,
      tenantId: scope.tenantId,
      workspaceId: scope.workspaceId,
      idempotencyKey: request.idempotencyKey,
      inputHash,
      agentRole: request.agentRole,
      agentVersion: 1,
      promptRef: agentPromptRef(prompt.promptKey, prompt.version),
      policyRef: agentPolicyRef(policy.policyKey, policy.version),
      budgetUsd: request.budgetUsd,
      maxAttempts: request.maxAttempts,
      createdAt: clock.now(),
    }), Object.freeze({
      agentRole: request.agentRole,
      promptKey: prompt.promptKey,
      promptVersion: prompt.version,
      policyKey: policy.policyKey,
      policyVersion: policy.version,
      correlationToken: ids.correlationToken(),
      requestedOutputTokens,
      estimatedCostUsd,
      maxEvidenceCount,
      maxUtf8Bytes,
      evidence: request.evidence,
    }));

    return Object.freeze({
      ok: true,
      code: outcome.action === "created" ? "RUN_CREATED"
        : outcome.action === "deduplicated" ? "RUN_DEDUPLICATED" : "RUN_REPLAYED",
      value: outcome.record,
    });
  } catch (error) {
    return mapStoreError(error);
  }
}

export async function getAgentRun(
  scope: AgentRuntimeScope,
  runId: string,
  store: AgentRunStorePort,
): Promise<AgentRuntimeResult<AgentRunRecord>> {
  if (!validScope(scope) || typeof runId !== "string" || !RUN_REF.test(runId)) {
    return fail("MALFORMED_INPUT");
  }
  try {
    const record = await store.get({ tenantId: scope.tenantId, workspaceId: scope.workspaceId, runId });
    return Object.freeze({ ok: true, code: "RUN_READ", value: record });
  } catch (error) {
    return mapStoreError(error);
  }
}

export async function cancelAgentRun(
  scope: AgentRuntimeScope,
  runId: string,
  dependencies: Pick<AgentRuntimeDependencies, "store" | "clock">,
): Promise<AgentRuntimeResult<AgentRunRecord>> {
  if (!validScope(scope) || typeof runId !== "string" || !RUN_REF.test(runId)) {
    return fail("MALFORMED_INPUT");
  }
  try {
    const record = await dependencies.store.cancel({
      tenantId: scope.tenantId,
      workspaceId: scope.workspaceId,
      runId,
      canceledAt: (dependencies.clock ?? systemAgentRuntimeClock).now(),
    });
    return Object.freeze({ ok: true, code: "RUN_CANCELED", value: record });
  } catch (error) {
    return mapStoreError(error);
  }
}

export interface ClaimAgentRunRequest {
  readonly runId: string;
  readonly workerId?: string;
  readonly leaseDurationMs?: number;
}

/** Claims one runnable attempt under a fresh lease. */
export async function claimAgentRun(
  scope: AgentRuntimeScope,
  request: ClaimAgentRunRequest,
  dependencies: AgentRuntimeDependencies,
): Promise<AgentRuntimeResult<Readonly<{ record: AgentRunRecord; leaseToken: string }>>> {
  if (!validScope(scope) || typeof request.runId !== "string" || !RUN_REF.test(request.runId)) {
    return fail("MALFORMED_INPUT");
  }
  const ids = dependencies.ids ?? randomAgentRuntimeIds;
  const clock = dependencies.clock ?? systemAgentRuntimeClock;
  const leaseToken = ids.leaseToken();
  const leaseDurationMs = Math.min(
    request.leaseDurationMs ?? DEFAULT_LEASE_MS,
    dependencies.maxLeaseDurationMs ?? MAX_LEASE_MS,
  );
  try {
    const record = await dependencies.store.lease({
      tenantId: scope.tenantId,
      workspaceId: scope.workspaceId,
      runId: request.runId,
      workerId: request.workerId ?? "fixture-worker",
      leaseToken,
      now: clock.now(),
      leaseDurationMs,
    });
    return Object.freeze({
      ok: true,
      code: "RUN_CLAIMED",
      value: Object.freeze({ record, leaseToken }),
    });
  } catch (error) {
    return mapStoreError(error);
  }
}

export interface ExecuteAttemptRequest {
  readonly runId: string;
  readonly leaseToken: string;
  readonly signal?: AbortSignal;
}

export interface ExecuteAttemptValue {
  readonly record: AgentRunRecord;
  readonly resultRef: string | null;
  readonly errorCode: string | null;
}

/**
 * Executes one claimed attempt: heartbeat, context rebuild + input-hash
 * verification, model preflight, deterministic fixture call, then immutable
 * step/tool-call records and a fenced finalize. Cancellation propagates from
 * the member cancel path (cancel_requested_at) and the abort signal.
 */
export async function executeAgentRunAttempt(
  scope: AgentRuntimeScope,
  request: ExecuteAttemptRequest,
  dependencies: AgentRuntimeDependencies,
): Promise<AgentRuntimeResult<ExecuteAttemptValue>> {
  if (!validScope(scope) || typeof request.runId !== "string" || !RUN_REF.test(request.runId)
    || typeof request.leaseToken !== "string" || request.leaseToken.length === 0) {
    return fail("MALFORMED_INPUT");
  }
  const store = dependencies.store;
  const clock = dependencies.clock ?? systemAgentRuntimeClock;
  const ref = { tenantId: scope.tenantId, workspaceId: scope.workspaceId, runId: request.runId };

  let record: AgentRunRecord;
  try {
    record = await store.heartbeat({
      ...ref,
      leaseToken: request.leaseToken,
      now: clock.now(),
      leaseDurationMs: dependencies.maxLeaseDurationMs ?? MAX_LEASE_MS,
    });
  } catch (error) {
    return mapStoreError(error);
  }
  if (record.cancelRequestedAt !== null) {
    try {
      const canceled = await store.cancel({ ...ref, canceledAt: clock.now() });
      return Object.freeze({
        ok: true,
        code: "RUN_CANCELED",
        value: Object.freeze({ record: canceled, resultRef: null, errorCode: "RUN_CANCELLED" }),
      });
    } catch (error) {
      return mapStoreError(error);
    }
  }

  const runInput = await store.getRunInput(scope, request.runId);
  if (!runInput) return fail("RUN_NOT_FOUND");
  const prompt = dependencies.registry.getPrompt(runInput.promptKey, runInput.promptVersion);
  const policy = dependencies.registry.getPolicy(runInput.policyKey, runInput.policyVersion);
  if (!prompt || !policy) {
    return finalizeFailure(store, ref, request.leaseToken, record, "REJECTED_MODEL_POLICY_GAP", clock);
  }

  let context;
  try {
    context = buildAgentContext({
      version: 1,
      tenantId: scope.tenantId,
      workspaceId: scope.workspaceId,
      maxEvidenceCount: runInput.maxEvidenceCount,
      maxUtf8Bytes: runInput.maxUtf8Bytes,
      evidence: runInput.evidence,
    });
  } catch {
    return finalizeFailure(store, ref, request.leaseToken, record, "REJECTED_MODEL_POLICY_GAP", clock);
  }
  const content = canonicalContentBlock(
    request.runId,
    scope,
    context.serializedContext,
    context.outputSha256,
  );
  const inputHash = sha256Prefixed(JSON.stringify({
    runId: request.runId,
    tenantId: scope.tenantId,
    workspaceId: scope.workspaceId,
    content: [content],
  }));
  if (inputHash !== record.inputHash) {
    return finalizeFailure(store, ref, request.leaseToken, record, "REJECTED_MODEL_POLICY_GAP", clock);
  }

  const remaining = dependencies.tenantBudget
    ? await dependencies.tenantBudget.remainingUsd(scope)
    : record.budgetUsd - record.usageCostUsd;

  const leaseExpiresMs = Date.parse(record.lease?.expiresAt ?? "");
  const nowMs = Date.parse(clock.now());
  const leaseRemainingMs = Number.isFinite(leaseExpiresMs) && Number.isFinite(nowMs)
    ? leaseExpiresMs - nowMs
    : dependencies.maxDeadlineMs ?? MAX_LEASE_MS;
  const deadlineMs = Math.min(
    Math.max(1, leaseRemainingMs),
    dependencies.maxDeadlineMs ?? MAX_LEASE_MS,
  );
  const deadlineAt = new Date(nowMs + deadlineMs).toISOString();

  const boundary: AgentFixtureExecutionBoundary = createFixtureAgentExecutionBoundary({
    provider: dependencies.provider,
    clock: () => Date.parse(clock.now()),
    maxDeadlineMs: dependencies.maxDeadlineMs ?? MAX_LEASE_MS,
  });
  const started = Date.parse(clock.now());
  const result = await boundary.execute(Object.freeze({
    version: 1,
    executionMode: "fixture",
    deadlineAt,
    context: {
      version: 1,
      tenantId: scope.tenantId,
      workspaceId: scope.workspaceId,
      maxEvidenceCount: runInput.maxEvidenceCount,
      maxUtf8Bytes: runInput.maxUtf8Bytes,
      evidence: runInput.evidence,
    },
    modelAccess: {
      version: 1,
      run: {
        runId: request.runId,
        tenantId: scope.tenantId,
        workspaceId: scope.workspaceId,
        inputHash: record.inputHash,
        status: record.status,
        cancelRequestedAt: record.cancelRequestedAt,
        promptKey: runInput.promptKey,
        promptVersion: runInput.promptVersion,
        policyKey: runInput.policyKey,
        policyVersion: runInput.policyVersion,
        budgetUsd: record.budgetUsd,
        usageCostUsd: record.usageCostUsd,
      },
      prompt,
      modelPolicy: policy,
      request: {
        runId: request.runId,
        tenantId: scope.tenantId,
        workspaceId: scope.workspaceId,
        inputHash: record.inputHash,
        correlationToken: runInput.correlationToken,
        requestedTools: [],
        requestedOutputTokens: runInput.requestedOutputTokens,
        estimatedCostUsd: runInput.estimatedCostUsd,
        tenantRemainingBudgetUsd: remaining,
        content: [content],
      },
    },
  }), request.signal === undefined ? undefined : Object.freeze({ signal: request.signal }));
  const latencyMs = Math.max(0, Date.parse(clock.now()) - started);
  const recordedAt = clock.now();

  const stepId = `step:${record.attemptCount}:execute`;
  if (!result.ok) {
    if (result.code === "RUN_CANCELLED") {
      try {
        const canceled = await store.cancel({ ...ref, canceledAt: recordedAt });
        return Object.freeze({
          ok: true,
          code: "RUN_CANCELED",
          value: Object.freeze({ record: canceled, resultRef: null, errorCode: "RUN_CANCELLED" }),
        });
      } catch (error) {
        return mapStoreError(error);
      }
    }
    return finalizeFailure(
      store,
      ref,
      request.leaseToken,
      record,
      result.code,
      clock,
      stepId,
      result.usage.costUsd,
      latencyMs,
    );
  }

  const proposalJson = JSON.stringify(result.proposal);
  const outputHash = sha256Prefixed(proposalJson);
  const resultRef = `agent-result:${outputHash.slice("sha256:".length)}`;
  try {
    let current = await store.appendStep({
      ...ref,
      leaseToken: request.leaseToken,
      stepId,
      status: "complete",
      policyRef: record.policyRef,
      resultRef,
      errorCode: null,
      recordedAt,
    });
    current = await store.appendToolCall({
      ...ref,
      leaseToken: request.leaseToken,
      stepId,
      toolCallId: `toolcall:${record.attemptCount}:model`,
      toolName: "agent.model.invoke",
      toolVersion: "fixture@1",
      permissionDecision: "allowed",
      status: "complete",
      inputHash: record.inputHash,
      outputHash,
      sourceIds: runInput.evidence.map((item) => item.evidenceId).slice(0, 64),
      costUsd: result.usage.costUsd,
      latencyMs: Math.floor(latencyMs),
      errorCode: null,
      redactedSummary: `fixture model call: ${result.usage.totalTokens} tokens (redacted)`,
      recordedAt,
    });
    const completed = await store.complete({
      ...ref,
      leaseToken: request.leaseToken,
      resultRef,
      completedAt: recordedAt,
      usageCostUsd: current.usageCostUsd,
    });
    return Object.freeze({
      ok: true,
      code: "RUN_COMPLETED",
      value: Object.freeze({ record: completed, resultRef, errorCode: null }),
    });
  } catch (error) {
    return mapStoreError(error);
  }
}

async function finalizeFailure(
  store: AgentRunStorePort,
  ref: Readonly<{ tenantId: string; workspaceId: string | null; runId: string }>,
  leaseToken: string,
  record: AgentRunRecord,
  errorCode: string,
  clock: AgentRuntimeClock,
  stepId?: string,
  stepCostUsd?: number,
  latencyMs?: number,
): Promise<AgentRuntimeResult<ExecuteAttemptValue>> {
  const failedAt = clock.now();
  try {
    let current = record;
    if (stepId !== undefined) {
      current = await store.appendStep({
        ...ref,
        leaseToken,
        stepId,
        status: errorCode === "RUN_CANCELLED" ? "blocked" : "failed",
        policyRef: record.policyRef,
        resultRef: null,
        errorCode,
        recordedAt: failedAt,
      });
      if ((stepCostUsd ?? 0) > 0 || latencyMs !== undefined) {
        current = await store.appendToolCall({
          ...ref,
          leaseToken,
          stepId,
          toolCallId: `toolcall:${record.attemptCount}:model`,
          toolName: "agent.model.invoke",
          toolVersion: "fixture@1",
          permissionDecision: "allowed",
          status: "failed",
          inputHash: record.inputHash,
          outputHash: null,
          sourceIds: [],
          costUsd: stepCostUsd ?? 0,
          latencyMs: Math.max(0, Math.floor(latencyMs ?? 0)),
          errorCode,
          redactedSummary: "fixture model call failed (redacted)",
          recordedAt: failedAt,
        });
      }
    }
    const retryAt = RETRYABLE_CODES.has(errorCode)
      ? new Date(Date.parse(failedAt) + Math.min(60_000, 2 ** (record.attemptCount - 1) * 1_000))
        .toISOString()
      : null;
    const failed = await store.fail({
      ...ref,
      leaseToken,
      errorCode,
      failedAt,
      usageCostUsd: current.usageCostUsd,
      retryAt,
    });
    return Object.freeze({
      ok: true,
      code: failed.status === "dead_letter" ? "RUN_DEAD_LETTERED"
        : failed.status === "retry_wait" ? "RUN_RETRY_SCHEDULED" : "RUN_FAILED",
      value: Object.freeze({ record: failed, resultRef: null, errorCode }),
    });
  } catch (error) {
    return mapStoreError(error);
  }
}

export type { AgentRunStatus };
