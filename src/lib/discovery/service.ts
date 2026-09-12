import { isProxy } from "node:util/types";

import {
  buildDiscoveryPlan,
  type DiscoveryPlan,
  type DiscoveryPlanFailureCode,
} from "./discovery-plan";
import {
  appendDiscoveryObservationBatch,
  createDiscoveryRun,
  transitionDiscoveryRun,
  type DiscoveryRun,
  type DiscoveryRunFailureCode,
} from "./discovery-run";
import type { DiscoveryPlanRow, DiscoveryRepository, DiscoveryRunRow } from "./repository";

export type DiscoveryServiceErrorCode =
  | "DISCOVERY_INPUT_INVALID"
  | "DISCOVERY_NOT_FOUND"
  | "DISCOVERY_STALE"
  | "DISCOVERY_CONFLICT"
  | "PLAY_AUTHORITY_UNAVAILABLE"
  | `PLAN_${DiscoveryPlanFailureCode}`
  | `RUN_${DiscoveryRunFailureCode}`;

export class DiscoveryServiceError extends Error {
  readonly code: DiscoveryServiceErrorCode;

  constructor(code: DiscoveryServiceErrorCode, message: string) {
    super(message);
    this.name = "DiscoveryServiceError";
    this.code = code;
  }
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const PLAN_ID = /^discovery-plan:[0-9a-f]{64}$/u;
const RUN_ID = /^discovery-run:[0-9a-f]{64}$/u;
const PLAY_VERSION = /^lead-play-version:[0-9a-f]{64}$/u;
const MAX_LIST = 200;

type PlainRecord = Record<string, unknown>;

function isPlainRecord(value: unknown): value is PlainRecord {
  if (!value || typeof value !== "object" || Array.isArray(value) || isProxy(value)) return false;
  try {
    const prototype = Object.getPrototypeOf(value);
    return prototype === Object.prototype || prototype === null;
  } catch {
    return false;
  }
}

function invalid(message: string): DiscoveryServiceError {
  return new DiscoveryServiceError("DISCOVERY_INPUT_INVALID", message);
}

function uuid(value: unknown, field: string): string {
  if (typeof value !== "string" || !UUID.test(value)) throw invalid(`${field} must be a UUID`);
  return value;
}

function scopeWorkspaceId(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  return uuid(value, "workspaceId");
}

function planIdOf(value: unknown): string {
  if (typeof value !== "string" || !PLAN_ID.test(value)) throw invalid("planId is malformed");
  return value;
}

function runIdOf(value: unknown): string {
  if (typeof value !== "string" || !RUN_ID.test(value)) throw invalid("runId is malformed");
  return value;
}

function planFailure(code: DiscoveryPlanFailureCode): DiscoveryServiceError {
  return new DiscoveryServiceError(`PLAN_${code}`, `The discovery plan was rejected (${code}).`);
}

function runFailure(code: DiscoveryRunFailureCode): DiscoveryServiceError {
  return new DiscoveryServiceError(`RUN_${code}`, `The discovery run was rejected (${code}).`);
}

/**
 * Port to the L-04 strategy lane. Discovery plans must be built only from a
 * durable, approved play activation; this port supplies the three authority
 * documents the plan engine re-verifies (activation state, review snapshot,
 * and the original proposal input). When the strategy lane's persistence is
 * unavailable the port returns null and plan creation fails closed.
 */
export interface PlayAuthorityPort {
  loadPlayAuthority(selector: Readonly<{
    tenantId: string;
    workspaceId: string | null;
    playVersionId: string;
  }>): Promise<Readonly<{
    activationState: unknown;
    playReview: unknown;
    playSource: unknown;
  }> | null>;
}

export interface DiscoveryServiceDeps {
  readonly repository: DiscoveryRepository;
  readonly playAuthority: PlayAuthorityPort;
  readonly clock?: () => Date;
}

function nowIso(clock: (() => Date) | undefined): string {
  const observed = clock ? clock() : new Date();
  if (!(observed instanceof Date) || !Number.isFinite(observed.getTime())) {
    throw invalid("A valid clock is required");
  }
  return observed.toISOString();
}

export type CreateDiscoveryPlanInput = Readonly<{
  tenantId: string;
  workspaceId: string | null;
  playVersionId: string;
  sourceKeys: readonly string[];
  limits: Readonly<{ maxAccounts: number; maxProviderRequests: number; maxSpendCents: number }>;
}>;

export type CreateDiscoveryPlanResult = Readonly<{
  kind: "created" | "replayed";
  plan: DiscoveryPlan;
}>;

export async function createDiscoveryPlanService(
  deps: DiscoveryServiceDeps,
  rawInput: unknown,
): Promise<CreateDiscoveryPlanResult> {
  if (!isPlainRecord(rawInput)) throw invalid("Expected a plain object");
  const tenantId = uuid(rawInput.tenantId, "tenantId");
  const workspaceId = scopeWorkspaceId(rawInput.workspaceId);
  const playVersionId = typeof rawInput.playVersionId === "string" && PLAY_VERSION.test(rawInput.playVersionId)
    ? rawInput.playVersionId : (() => { throw invalid("playVersionId is malformed"); })();
  if (!Array.isArray(rawInput.sourceKeys) || rawInput.sourceKeys.length === 0) {
    throw invalid("sourceKeys must be a non-empty array");
  }
  if (!isPlainRecord(rawInput.limits)) throw invalid("limits are required");

  const authority = await deps.playAuthority.loadPlayAuthority({ tenantId, workspaceId, playVersionId });
  if (!authority) {
    throw new DiscoveryServiceError("PLAY_AUTHORITY_UNAVAILABLE",
      "The approved play activation could not be loaded.");
  }
  const built = buildDiscoveryPlan({
    version: 1,
    tenantId,
    workspaceId,
    activationState: authority.activationState,
    playReview: authority.playReview,
    playSource: authority.playSource,
    sourceKeys: rawInput.sourceKeys,
    limits: rawInput.limits,
  });
  if (!built.ok) throw planFailure(built.code);
  const kind = await deps.repository.insertPlan(built.plan);
  return Object.freeze({ kind, plan: built.plan });
}

export type CreateDiscoveryRunInput = Readonly<{
  tenantId: string;
  workspaceId: string | null;
  planId: string;
  createdAt?: string;
}>;

export async function createDiscoveryRunService(
  deps: Omit<DiscoveryServiceDeps, "playAuthority">,
  rawInput: unknown,
): Promise<Readonly<{ kind: "created" | "replayed"; run: DiscoveryRun }>> {
  if (!isPlainRecord(rawInput)) throw invalid("Expected a plain object");
  const tenantId = uuid(rawInput.tenantId, "tenantId");
  const workspaceId = scopeWorkspaceId(rawInput.workspaceId);
  const planId = planIdOf(rawInput.planId);
  const createdAt = rawInput.createdAt === undefined ? nowIso(deps.clock) : rawInput.createdAt;
  if (typeof createdAt !== "string") throw invalid("createdAt is malformed");

  const planRow = await deps.repository.getPlan(tenantId, workspaceId, planId);
  if (!planRow) throw new DiscoveryServiceError("DISCOVERY_NOT_FOUND", "The discovery plan was not found.");
  const created = createDiscoveryRun({
    version: 1, tenantId, workspaceId, plan: planRow.payload, createdAt,
  });
  if (!created.ok) throw runFailure(created.code);
  const kind = await deps.repository.insertRun(created.run);
  return Object.freeze({ kind, run: created.run });
}

export type TransitionDiscoveryRunInput = Readonly<{
  tenantId: string;
  workspaceId: string | null;
  runId: string;
  expectedRunHash: string;
  action: "start" | "complete" | "fail" | "cancel";
  at?: string;
  reason: string;
}>;

export async function transitionDiscoveryRunService(
  deps: Omit<DiscoveryServiceDeps, "playAuthority">,
  rawInput: unknown,
): Promise<Readonly<{ run: DiscoveryRun }>> {
  if (!isPlainRecord(rawInput)) throw invalid("Expected a plain object");
  const tenantId = uuid(rawInput.tenantId, "tenantId");
  const workspaceId = scopeWorkspaceId(rawInput.workspaceId);
  const runId = runIdOf(rawInput.runId);
  const at = rawInput.at === undefined ? nowIso(deps.clock) : rawInput.at;
  if (typeof at !== "string") throw invalid("at is malformed");

  const runRow = await deps.repository.getRun(tenantId, workspaceId, runId);
  if (!runRow) throw new DiscoveryServiceError("DISCOVERY_NOT_FOUND", "The discovery run was not found.");
  const transitioned = transitionDiscoveryRun({
    version: 1, tenantId, workspaceId, current: runRow.payload,
    expectedRunHash: rawInput.expectedRunHash, action: rawInput.action, at, reason: rawInput.reason,
  });
  if (!transitioned.ok) throw runFailure(transitioned.code);
  try {
    await deps.repository.updateRun(runRow.payload.runHash as string, transitioned.run);
  } catch {
    throw new DiscoveryServiceError("DISCOVERY_STALE", "The discovery run changed concurrently.");
  }
  return Object.freeze({ run: transitioned.run });
}

export type AppendObservationBatchInput = Readonly<{
  tenantId: string;
  workspaceId: string | null;
  runId: string;
  expectedRunHash: string;
  batch: unknown;
}>;

export async function appendDiscoveryBatchService(
  deps: Omit<DiscoveryServiceDeps, "playAuthority">,
  rawInput: unknown,
): Promise<Readonly<{ run: DiscoveryRun; code:
  | "DISCOVERY_RUN_CREATED"
  | "DISCOVERY_RUN_STARTED"
  | "DISCOVERY_BATCH_APPENDED"
  | "DISCOVERY_BATCH_REPLAYED"
  | "DISCOVERY_RUN_COMPLETED"
  | "DISCOVERY_RUN_FAILED"
  | "DISCOVERY_RUN_CANCELLED" }>> {
  if (!isPlainRecord(rawInput)) throw invalid("Expected a plain object");
  const tenantId = uuid(rawInput.tenantId, "tenantId");
  const workspaceId = scopeWorkspaceId(rawInput.workspaceId);
  const runId = runIdOf(rawInput.runId);
  const runRow = await deps.repository.getRun(tenantId, workspaceId, runId);
  if (!runRow) throw new DiscoveryServiceError("DISCOVERY_NOT_FOUND", "The discovery run was not found.");
  const appended = appendDiscoveryObservationBatch({
    version: 1, tenantId, workspaceId, current: runRow.payload,
    expectedRunHash: rawInput.expectedRunHash, batch: rawInput.batch,
  });
  if (!appended.ok) throw runFailure(appended.code);
  if (appended.code === "DISCOVERY_BATCH_APPENDED") {
    try {
      await deps.repository.updateRun(runRow.payload.runHash as string, appended.run);
    } catch {
      throw new DiscoveryServiceError("DISCOVERY_STALE", "The discovery run changed concurrently.");
    }
  }
  return Object.freeze({ run: appended.run, code: appended.code });
}

/* ---------- query projections consumed by the L-07 panels ---------- */

export type DiscoveryPlanView = Readonly<{
  planId: string;
  status: "plan_only";
  reviewStatus: "approved";
  playStableKey: string;
  playVersionId: string;
  playRevision: number;
  sourceKeys: readonly string[];
  taskCount: number;
  limits: Readonly<{ maxAccounts: number; maxProviderRequests: number; maxSpendCents: number }>;
  createdAt: string;
  allowedActions: readonly ["create_run"];
}>;

export type DiscoveryRunView = Readonly<{
  runId: string;
  planId: string;
  playVersionId: string;
  status: DiscoveryRun["status"];
  budget: Readonly<{
    accounts: number; providerRequests: number; spendCents: number;
    maxAccounts: number; maxProviderRequests: number; maxSpendCents: number;
  }>;
  completedTasks: number;
  totalTasks: number;
  recoveryNeeded: boolean;
  allowedActions: readonly string[];
  updatedAt: string;
}>;

function planView(row: DiscoveryPlanRow): DiscoveryPlanView {
  const tasks = Array.isArray(row.payload.tasks) ? row.payload.tasks : [];
  const limits = row.payload.limits as { maxAccounts: number; maxProviderRequests: number; maxSpendCents: number };
  return Object.freeze({
    planId: row.planId,
    status: "plan_only",
    reviewStatus: "approved",
    playStableKey: row.playStableKey,
    playVersionId: row.playVersionId,
    playRevision: row.playRevision,
    sourceKeys: row.sourceKeys,
    taskCount: tasks.length,
    limits: Object.freeze({
      maxAccounts: limits.maxAccounts, maxProviderRequests: limits.maxProviderRequests,
      maxSpendCents: limits.maxSpendCents,
    }),
    createdAt: row.createdAt,
    allowedActions: Object.freeze(["create_run"] as const),
  });
}

function runView(row: DiscoveryRunRow): DiscoveryRunView {
  const payload = row.payload;
  const tasks = Array.isArray(payload.tasks) ? payload.tasks as PlainRecord[] : [];
  const totals = isPlainRecord(payload.totals) ? payload.totals : {};
  const plan = isPlainRecord(payload.plan) ? payload.plan : {};
  const limits = isPlainRecord(plan.limits) ? plan.limits : {};
  const planPlay = isPlainRecord(plan.play) ? plan.play : {};
  const completedTasks = tasks.filter((task) => task.complete === true).length;
  const allowed: string[] = [];
  if (row.status === "planned") allowed.push("start", "cancel");
  if (row.status === "running") allowed.push("append_batch", "complete", "fail", "cancel");
  return Object.freeze({
    runId: row.runId,
    planId: row.planId,
    playVersionId: typeof planPlay.versionId === "string" ? planPlay.versionId : "",
    status: row.status,
    budget: Object.freeze({
      accounts: typeof totals.accounts === "number" ? totals.accounts : 0,
      providerRequests: typeof totals.providerRequests === "number" ? totals.providerRequests : 0,
      spendCents: typeof totals.spendCents === "number" ? totals.spendCents : 0,
      maxAccounts: typeof limits.maxAccounts === "number" ? limits.maxAccounts : 0,
      maxProviderRequests: typeof limits.maxProviderRequests === "number" ? limits.maxProviderRequests : 0,
      maxSpendCents: typeof limits.maxSpendCents === "number" ? limits.maxSpendCents : 0,
    }),
    completedTasks,
    totalTasks: tasks.length,
    recoveryNeeded: row.status === "running",
    allowedActions: Object.freeze(allowed),
    updatedAt: row.updatedAt,
  });
}

export async function listDiscoveryPlanViews(
  repository: DiscoveryRepository,
  scope: Readonly<{ tenantId: string; workspaceId: string | null }>,
): Promise<readonly DiscoveryPlanView[]> {
  const rows = await repository.listPlans(uuid(scope.tenantId, "tenantId"), scopeWorkspaceId(scope.workspaceId));
  return Object.freeze(rows.slice(0, MAX_LIST).map(planView));
}

export async function listDiscoveryRunViews(
  repository: DiscoveryRepository,
  scope: Readonly<{ tenantId: string; workspaceId: string | null }>,
): Promise<readonly DiscoveryRunView[]> {
  const rows = await repository.listRuns(uuid(scope.tenantId, "tenantId"), scopeWorkspaceId(scope.workspaceId));
  return Object.freeze(rows.slice(0, MAX_LIST).map(runView));
}

export async function getDiscoveryRunView(
  repository: DiscoveryRepository,
  scope: Readonly<{ tenantId: string; workspaceId: string | null }>,
  runId: string,
): Promise<DiscoveryRunView | null> {
  const row = await repository.getRun(
    uuid(scope.tenantId, "tenantId"), scopeWorkspaceId(scope.workspaceId), runIdOf(runId));
  return row ? runView(row) : null;
}
