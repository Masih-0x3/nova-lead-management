import "server-only";

import { isProxy } from "node:util/types";

import type { DbClient } from "@/lib/db";
import type {
  AgentRunRecord,
  AgentStepRecord,
  AgentToolCallRecord,
  CreateAgentRunInput,
} from "@/lib/agent-runtime/records";
import { AgentRunRecordError } from "@/lib/agent-runtime/records";
import type {
  AgentRuntimeScope,
  AgentRunStoreOutcome,
  AgentRunStorePort,
  StoredAgentRunInput,
} from "@/lib/agent-runtime/service";

/**
 * Postgres `AgentRunStorePort` (L-04 / 0X3-243).
 *
 * All mutations go through the `novatrade_l04_*` SECURITY DEFINER
 * capabilities — member-gated enqueue/cancel and dispatch-lease-gated,
 * lease-token-fenced worker operations. Reads use plain SELECT under the
 * caller's installed tenant GUCs (member read policies or the agent_runtime
 * worker read policies). The port throws `AgentRunRecordError` codes so the
 * orchestration service stays store-agnostic.
 */

const ENQUEUE_SQL =
  "SELECT kind FROM public.novatrade_l04_enqueue_agent_run(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)";
const CANCEL_SQL =
  "SELECT kind FROM public.novatrade_l04_cancel_agent_run(?,?,?,?)";
const CLAIM_SQL =
  "SELECT kind FROM public.novatrade_l04_claim_agent_run(?,?,?,?,?,?,?)";
const HEARTBEAT_SQL =
  "SELECT kind FROM public.novatrade_l04_heartbeat_agent_run(?,?,?,?,?,?)";
const STEP_SQL =
  "SELECT kind FROM public.novatrade_l04_append_agent_run_step(?,?,?,?,?,?,?,?,?,?,?)";
const TOOL_SQL =
  "SELECT kind FROM public.novatrade_l04_append_agent_tool_call(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)";
const FINALIZE_SQL =
  "SELECT kind FROM public.novatrade_l04_finalize_agent_run(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)";

const RUN_SELECT = `SELECT id,tenant_id::text AS tenant_id,workspace_id::text AS workspace_id,
  idempotency_key,input_hash,agent_role,agent_version::text AS agent_version,
  prompt_key,prompt_version::text AS prompt_version,policy_key,policy_version::text AS policy_version,
  status,budget_usd::text AS budget_usd,usage_cost_usd::text AS usage_cost_usd,
  attempt_count::text AS attempt_count,max_attempts::text AS max_attempts,
  lease_generation::text AS lease_generation,lease_acquired_at,lease_heartbeat_at,
  lease_expires_at,next_attempt_at,result_ref,error_code,cancel_requested_at,
  started_at,ended_at,created_at,updated_at
  FROM public.agent_runs WHERE id=? AND tenant_id=? AND workspace_id IS NOT DISTINCT FROM ?`;

const STEP_SELECT = `SELECT id,sequence::text AS sequence,status,policy_key,
  policy_version::text AS policy_version,result_ref,error_code,recorded_at
  FROM public.agent_run_steps WHERE run_id=? ORDER BY sequence`;

const TOOL_SELECT = `SELECT id,step_id,tool_name,tool_version,permission_decision,status,
  input_hash,output_hash,source_ids,cost_usd::text AS cost_usd,latency_ms::text AS latency_ms,
  error_code,redacted_summary,recorded_at
  FROM public.agent_tool_calls WHERE run_id=? ORDER BY recorded_at,id`;

interface RunRow {
  readonly id: string;
  readonly tenant_id: string;
  readonly workspace_id: string | null;
  readonly idempotency_key: string;
  readonly input_hash: string;
  readonly agent_role: string;
  readonly agent_version: string;
  readonly prompt_key: string;
  readonly prompt_version: string;
  readonly policy_key: string;
  readonly policy_version: string;
  readonly status: AgentRunRecord["status"];
  readonly budget_usd: string;
  readonly usage_cost_usd: string;
  readonly attempt_count: string;
  readonly max_attempts: string;
  readonly lease_generation: string;
  readonly lease_acquired_at: string | null;
  readonly lease_heartbeat_at: string | null;
  readonly lease_expires_at: string | null;
  readonly next_attempt_at: string | null;
  readonly result_ref: string | null;
  readonly error_code: string | null;
  readonly cancel_requested_at: string | null;
  readonly started_at: string | null;
  readonly ended_at: string | null;
  readonly created_at: string;
  readonly updated_at: string;
}

interface StepRow {
  readonly id: string;
  readonly sequence: string;
  readonly status: AgentStepRecord["status"];
  readonly policy_key: string;
  readonly policy_version: string;
  readonly result_ref: string | null;
  readonly error_code: string | null;
  readonly recorded_at: string;
}

interface ToolRow {
  readonly id: string;
  readonly step_id: string;
  readonly tool_name: string;
  readonly tool_version: string;
  readonly permission_decision: AgentToolCallRecord["permissionDecision"];
  readonly status: AgentToolCallRecord["status"];
  readonly input_hash: string;
  readonly output_hash: string | null;
  readonly source_ids: unknown;
  readonly cost_usd: string;
  readonly latency_ms: string;
  readonly error_code: string | null;
  readonly redacted_summary: string;
  readonly recorded_at: string;
}

function iso(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (value instanceof Date) return value.toISOString();
  const text = String(value);
  const parsed = Date.parse(text);
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : text;
}

function isoOrThrow(value: unknown): string {
  const result = iso(value);
  if (result === null) throw new AgentRunRecordError("INVALID_AGENT_RUN_RECORD");
  return result;
}

function numeric(value: unknown): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) throw new AgentRunRecordError("INVALID_AGENT_RUN_RECORD");
  return parsed;
}

function int(value: unknown): number {
  const parsed = numeric(value);
  if (!Number.isSafeInteger(parsed)) throw new AgentRunRecordError("INVALID_AGENT_RUN_RECORD");
  return parsed;
}

function parseRef(ref: string): { key: string; version: number } {
  const at = ref.lastIndexOf("@");
  if (at <= 0) throw new AgentRunRecordError("INVALID_AGENT_RUN_RECORD");
  const version = int(ref.slice(at + 1));
  return { key: ref.slice(0, at), version };
}

function mapRun(row: RunRow, steps: StepRow[], toolCalls: ToolRow[]): AgentRunRecord {
  const prompt = `${row.prompt_key}@${row.prompt_version}`;
  const policy = `${row.policy_key}@${row.policy_version}`;
  return Object.freeze({
    id: row.id,
    tenantId: row.tenant_id,
    workspaceId: row.workspace_id,
    idempotencyKey: row.idempotency_key,
    inputHash: row.input_hash,
    agentRole: row.agent_role,
    agentVersion: int(row.agent_version),
    promptRef: prompt,
    policyRef: policy,
    status: row.status,
    budgetUsd: numeric(row.budget_usd),
    usageCostUsd: numeric(row.usage_cost_usd),
    attemptCount: int(row.attempt_count),
    maxAttempts: int(row.max_attempts),
    lease: row.status === "running" ? Object.freeze({
      workerId: `worker:${row.lease_generation}`,
      token: "",
      acquiredAt: isoOrThrow(row.lease_acquired_at),
      heartbeatAt: isoOrThrow(row.lease_heartbeat_at),
      expiresAt: isoOrThrow(row.lease_expires_at),
    }) : null,
    nextAttemptAt: iso(row.next_attempt_at),
    resultRef: row.result_ref,
    errorCode: row.error_code,
    cancelRequestedAt: iso(row.cancel_requested_at),
    startedAt: iso(row.started_at),
    endedAt: iso(row.ended_at),
    createdAt: isoOrThrow(row.created_at),
    updatedAt: isoOrThrow(row.updated_at),
    steps: Object.freeze(steps.map((step) => Object.freeze({
      id: step.id,
      runId: row.id,
      sequence: int(step.sequence),
      status: step.status,
      policyRef: `${step.policy_key}@${step.policy_version}`,
      resultRef: step.result_ref,
      errorCode: step.error_code,
      recordedAt: isoOrThrow(step.recorded_at),
    } satisfies AgentStepRecord))),
    toolCalls: Object.freeze(toolCalls.map((call) => Object.freeze({
      id: call.id,
      runId: row.id,
      stepId: call.step_id,
      toolName: call.tool_name,
      toolVersion: call.tool_version,
      permissionDecision: call.permission_decision,
      status: call.status,
      inputHash: call.input_hash,
      outputHash: call.output_hash,
      sourceIds: Object.freeze(
        Array.isArray(call.source_ids) ? call.source_ids.map(String) : [],
      ),
      costUsd: numeric(call.cost_usd),
      latencyMs: int(call.latency_ms),
      errorCode: call.error_code,
      redactedSummary: call.redacted_summary,
      recordedAt: isoOrThrow(call.recorded_at),
    } satisfies AgentToolCallRecord))),
  });
}

export class PostgresAgentRunStore implements AgentRunStorePort {
  constructor(private readonly db: DbClient) {
    if (isProxy(db)) throw new AgentRunRecordError("INVALID_AGENT_RUN_RECORD");
  }

  async #kind(sql: string, params: readonly unknown[]): Promise<string> {
    const row = await this.db.prepare(sql).get<{ kind?: unknown }>(...params);
    const kind = row?.kind;
    return typeof kind === "string" ? kind : "";
  }

  async #record(scope: AgentRuntimeScope & { readonly runId: string }): Promise<AgentRunRecord> {
    const run = await this.db.prepare(RUN_SELECT).get<RunRow>(
      scope.runId, scope.tenantId, scope.workspaceId);
    if (!run) throw new AgentRunRecordError("RUN_NOT_FOUND");
    const steps = await this.db.prepare(STEP_SELECT).all<StepRow>(scope.runId);
    const toolCalls = await this.db.prepare(TOOL_SELECT).all<ToolRow>(scope.runId);
    return mapRun(run, steps, toolCalls);
  }

  async createOrReplay(
    input: CreateAgentRunInput,
    runInput: StoredAgentRunInput,
  ): Promise<AgentRunStoreOutcome> {
    const prompt = parseRef(input.promptRef);
    const policy = parseRef(input.policyRef);
    const kind = await this.#kind(ENQUEUE_SQL, [
      input.tenantId,
      input.workspaceId,
      input.id,
      input.idempotencyKey,
      input.inputHash,
      input.agentRole,
      String(input.agentVersion),
      prompt.key,
      String(prompt.version),
      policy.key,
      String(policy.version),
      String(input.budgetUsd),
      String(input.maxAttempts),
      input.createdAt,
      JSON.stringify(runInput),
    ]);
    if (kind === "conflict") {
      throw new AgentRunRecordError("REJECTED_IDEMPOTENCY_CONFLICT");
    }
    if (kind !== "created" && kind !== "deduplicated" && kind !== "replay") {
      throw new AgentRunRecordError("INVALID_AGENT_RUN_RECORD");
    }
    const record = await this.#record({
      tenantId: input.tenantId, workspaceId: input.workspaceId, runId: input.id });
    if (kind === "replay") {
      return Object.freeze({ action: "replay", record, resultRef: record.resultRef ?? "" });
    }
    return Object.freeze({ action: kind === "created" ? "created" : "deduplicated", record });
  }

  async getRunInput(
    scope: AgentRuntimeScope,
    runId: string,
  ): Promise<StoredAgentRunInput | null> {
    const row = await this.db.prepare(
      "SELECT input FROM public.agent_run_inputs WHERE run_id=? AND tenant_id=? AND workspace_id IS NOT DISTINCT FROM ?",
    ).get<{ input?: unknown }>(runId, scope.tenantId, scope.workspaceId);
    if (!row || isProxy(row.input)) return null;
    const raw = typeof row.input === "string" ? JSON.parse(row.input) : row.input;
    if (!raw || typeof raw !== "object" || !Array.isArray((raw as { evidence?: unknown }).evidence)) {
      throw new AgentRunRecordError("INVALID_AGENT_RUN_RECORD");
    }
    return Object.freeze({ ...(raw as StoredAgentRunInput) });
  }

  async get(scope: AgentRuntimeScope & { readonly runId: string }): Promise<AgentRunRecord> {
    return this.#record(scope);
  }

  async lease(input: AgentRuntimeScope & Readonly<{
    runId: string; workerId: string; leaseToken: string; now: string; leaseDurationMs: number;
  }>): Promise<AgentRunRecord> {
    const kind = await this.#kind(CLAIM_SQL, [
      input.tenantId, input.workspaceId, input.runId, input.leaseToken,
      input.workerId, input.now, String(input.leaseDurationMs),
    ]);
    switch (kind) {
      case "claimed": break;
      case "not_found": throw new AgentRunRecordError("RUN_NOT_FOUND");
      case "not_ready": throw new AgentRunRecordError("RUN_RETRY_NOT_READY");
      case "terminal": throw new AgentRunRecordError("RUN_TERMINAL");
      case "exhausted": throw new AgentRunRecordError("RUN_ATTEMPTS_EXHAUSTED");
      case "conflict": throw new AgentRunRecordError("RUN_LEASE_CONFLICT");
      default: throw new AgentRunRecordError("RUN_LEASE_CONFLICT");
    }
    return this.#record(input);
  }

  async heartbeat(input: AgentRuntimeScope & Readonly<{
    runId: string; leaseToken: string; now: string; leaseDurationMs: number;
  }>): Promise<AgentRunRecord> {
    const kind = await this.#kind(HEARTBEAT_SQL, [
      input.tenantId, input.workspaceId, input.runId, input.leaseToken,
      input.now, String(input.leaseDurationMs),
    ]);
    switch (kind) {
      case "updated": break;
      case "not_found": throw new AgentRunRecordError("RUN_NOT_FOUND");
      case "expired": throw new AgentRunRecordError("RUN_LEASE_EXPIRED");
      default: throw new AgentRunRecordError("RUN_LEASE_CONFLICT");
    }
    return this.#record(input);
  }

  async appendStep(input: AgentRuntimeScope & Readonly<{
    runId: string; leaseToken: string; stepId: string; status: AgentStepRecord["status"];
    policyRef: string; resultRef: string | null; errorCode: string | null; recordedAt: string;
  }>): Promise<AgentRunRecord> {
    const policy = parseRef(input.policyRef);
    const kind = await this.#kind(STEP_SQL, [
      input.tenantId, input.workspaceId, input.runId, input.leaseToken,
      input.stepId, input.status, policy.key, String(policy.version),
      input.resultRef, input.errorCode, input.recordedAt,
    ]);
    switch (kind) {
      case "appended": break;
      case "conflict": throw new AgentRunRecordError("RUN_LEASE_CONFLICT");
      default: throw new AgentRunRecordError("RUN_LEASE_CONFLICT");
    }
    return this.#record(input);
  }

  async appendToolCall(input: AgentRuntimeScope & Readonly<{
    runId: string; leaseToken: string; stepId: string; toolCallId: string; toolName: string;
    toolVersion: string; permissionDecision: AgentToolCallRecord["permissionDecision"];
    status: AgentToolCallRecord["status"]; inputHash: string; outputHash: string | null;
    sourceIds: readonly string[]; costUsd: number; latencyMs: number;
    errorCode: string | null; redactedSummary: string; recordedAt: string;
  }>): Promise<AgentRunRecord> {
    const kind = await this.#kind(TOOL_SQL, [
      input.tenantId, input.workspaceId, input.runId, input.leaseToken,
      input.stepId, input.toolCallId, input.toolName, input.toolVersion,
      input.permissionDecision, input.status, input.inputHash, input.outputHash,
      JSON.stringify(input.sourceIds), String(input.costUsd), String(input.latencyMs),
      input.errorCode, input.redactedSummary, input.recordedAt,
    ]);
    switch (kind) {
      case "appended": break;
      case "budget_exceeded": throw new AgentRunRecordError("INVALID_AGENT_RUN_RECORD");
      default: throw new AgentRunRecordError("RUN_LEASE_CONFLICT");
    }
    return this.#record(input);
  }

  async complete(input: AgentRuntimeScope & Readonly<{
    runId: string; leaseToken: string; resultRef: string; completedAt: string; usageCostUsd: number;
  }>): Promise<AgentRunRecord> {
    const before = await this.#record(input);
    const kind = await this.#kind(FINALIZE_SQL, [
      input.tenantId, input.workspaceId, input.runId, input.leaseToken,
      "complete", input.resultRef, null, String(input.usageCostUsd), null,
      input.completedAt, `${input.runId}:settlement:${before.attemptCount}`,
      String(Math.max(0, input.usageCostUsd - before.usageCostUsd)),
      "0", "0", null,
    ]);
    switch (kind) {
      case "finalized": break;
      case "expired": throw new AgentRunRecordError("RUN_LEASE_EXPIRED");
      default: throw new AgentRunRecordError("RUN_LEASE_CONFLICT");
    }
    return this.#record(input);
  }

  async fail(input: AgentRuntimeScope & Readonly<{
    runId: string; leaseToken: string; errorCode: string; failedAt: string;
    usageCostUsd: number; retryAt: string | null;
  }>): Promise<AgentRunRecord> {
    const before = await this.#record(input);
    const outcome = input.retryAt !== null && before.attemptCount < before.maxAttempts
      ? "retry_wait" : input.retryAt !== null ? "dead_letter" : "failed";
    const kind = await this.#kind(FINALIZE_SQL, [
      input.tenantId, input.workspaceId, input.runId, input.leaseToken,
      outcome, null, input.errorCode, String(input.usageCostUsd), input.retryAt,
      input.failedAt, `${input.runId}:settlement:${before.attemptCount}`,
      String(Math.max(0, input.usageCostUsd - before.usageCostUsd)),
      "0", "0", null,
    ]);
    switch (kind) {
      case "finalized": break;
      case "expired": throw new AgentRunRecordError("RUN_LEASE_EXPIRED");
      default: throw new AgentRunRecordError("RUN_LEASE_CONFLICT");
    }
    return this.#record(input);
  }

  async cancel(input: AgentRuntimeScope & Readonly<{
    runId: string; canceledAt: string;
  }>): Promise<AgentRunRecord> {
    const kind = await this.#kind(CANCEL_SQL, [
      input.tenantId, input.workspaceId, input.runId, input.canceledAt,
    ]);
    switch (kind) {
      case "canceled": break;
      case "not_found": throw new AgentRunRecordError("RUN_NOT_FOUND");
      case "terminal": throw new AgentRunRecordError("RUN_TERMINAL");
      default: throw new AgentRunRecordError("RUN_TERMINAL");
    }
    return this.#record(input);
  }
}

export function createPostgresAgentRunStore(db: DbClient): PostgresAgentRunStore {
  return new PostgresAgentRunStore(db);
}
