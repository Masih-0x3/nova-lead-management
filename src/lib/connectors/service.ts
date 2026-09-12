import { createHash, randomUUID } from "node:crypto";
import { isProxy } from "node:util/types";

import type {
  ConnectorSourcePolicyDecision,
} from "./source-policy-registry";
import type {
  ConnectorSourceRunAuthoritySelector,
  ConnectorSourceRunAuthoritySnapshot,
} from "./source-run-authority";
import { createAuthorizedFixtureConnectorRunner } from "./source-run-authority";
import type { ConnectorFixturePageExecutor, ConnectorRunnerResult } from "./runner";
import type { ConnectorAuthorityRepository } from "./repository";
import { ConnectorPersistenceError } from "./repository";
import type { ConnectorCommandRepository } from "./command-repository";
import {
  describeConnectorRegistry,
  type ConnectorRegistryEntryView,
} from "./registry-manifest";

export type ConnectorServiceErrorCode =
  | "CONNECTOR_INPUT_INVALID"
  | "CONNECTOR_SCOPE_MISMATCH"
  | "CONNECTOR_NOT_FOUND"
  | "CONNECTOR_NOT_IMPLEMENTED"
  | "CONNECTOR_ACCOUNT_STATE"
  | "CONNECTOR_POLICY_STATE"
  | "CONNECTOR_IDEMPOTENCY_CONFLICT"
  | "CONNECTOR_RUN_STATE"
  | "CONNECTOR_STALE_STATE"
  | "CONNECTOR_PERSISTENCE";

export class ConnectorServiceError extends Error {
  readonly code: ConnectorServiceErrorCode;

  constructor(code: ConnectorServiceErrorCode, message: string) {
    super(message);
    this.name = "ConnectorServiceError";
    this.code = code;
  }
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const RUN_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/u;
const SHA256 = /^[0-9a-f]{64}$/u;
const TOKEN = /^[a-z0-9][a-z0-9._:-]{0,159}$/u;
const IDEMPOTENCY_KEY = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,511}$/u;
const OPERATION = /^[a-z0-9][a-z0-9._:-]{0,159}$/u;
const MAX_LEASE_MS = 30 * 60 * 1_000;

export type ConnectorAuditEvent = Readonly<{
  action: string;
  entityType: string;
  entityId: string;
  metadata: Readonly<Record<string, unknown>>;
}>;

export interface ConnectorAuditSink {
  record(event: ConnectorAuditEvent): Promise<void>;
}

export interface ConnectorServiceDeps {
  readonly authority: ConnectorAuthorityRepository;
  readonly commands: ConnectorCommandRepository;
  readonly audit: ConnectorAuditSink;
  readonly clock?: () => Date;
  readonly runner?: Parameters<typeof createAuthorizedFixtureConnectorRunner>[0]["runner"];
}

type PlainRecord = Record<string, unknown>;

function nowIso(clock: (() => Date) | undefined): string {
  const observed = clock ? clock() : new Date();
  if (!(observed instanceof Date) || !Number.isFinite(observed.getTime())) {
    throw new ConnectorServiceError("CONNECTOR_INPUT_INVALID", "A valid clock is required.");
  }
  return observed.toISOString();
}

function invalid(message: string): ConnectorServiceError {
  return new ConnectorServiceError("CONNECTOR_INPUT_INVALID", message);
}

function uuid(value: unknown, field: string): string {
  if (typeof value !== "string" || !UUID.test(value)) throw invalid(`${field} must be a UUID`);
  return value;
}

function nullableUuid(value: unknown, field: string): string | null {
  if (value === null || value === undefined) return null;
  return uuid(value, field);
}

function runId(value: unknown, field: string): string {
  if (typeof value !== "string" || !RUN_ID.test(value)) throw invalid(`${field} is malformed`);
  return value;
}

function token(value: unknown, field: string): string {
  if (typeof value !== "string" || !TOKEN.test(value)) throw invalid(`${field} is malformed`);
  return value;
}

function sha(value: unknown, field: string): string {
  if (typeof value !== "string" || !SHA256.test(value)) throw invalid(`${field} is malformed`);
  return value;
}

function plainRecord(value: unknown): PlainRecord {
  if (!value || typeof value !== "object" || Array.isArray(value) || isProxy(value)
    || (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null)) {
    throw invalid("Expected a plain object");
  }
  return value as PlainRecord;
}

function sha256Text(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((item) => canonicalJson(item)).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(",")}}`;
}

export interface ConnectorGovernanceView {
  readonly authority: ConnectorSourceRunAuthoritySnapshot;
  readonly decision: ConnectorSourcePolicyDecision;
  readonly asOf: string;
}

export async function describeConnectorRegistryState(
  authority: ConnectorAuthorityRepository,
): Promise<readonly ConnectorRegistryEntryView[]> {
  return describeConnectorRegistry(await authority.listRegistryVersions());
}

export async function getConnectorGovernanceView(
  deps: ConnectorServiceDeps,
  input: Readonly<{
    authorizedTenantId: string;
    authorizedWorkspaceId: string | null;
    runId: string;
    unitId: string;
  }>,
): Promise<ConnectorGovernanceView | null> {
  const selector = selectorFrom(input);
  const snapshot = await deps.authority.loadRunAuthority(selector);
  if (!snapshot) return null;
  const decision = await deps.authority.evaluateRunDecision(selector, {
    operation: snapshot.run.operation,
    fields: Object.freeze([]),
    requestedUnits: snapshot.unit.reservedUnits,
    now: nowIso(deps.clock),
  });
  if (!decision) return null;
  return Object.freeze({ authority: snapshot, decision, asOf: nowIso(deps.clock) });
}

function selectorFrom(input: Readonly<{
  authorizedTenantId: string;
  authorizedWorkspaceId: string | null;
  runId: string;
  unitId: string;
}>): ConnectorSourceRunAuthoritySelector {
  return Object.freeze({
    authorizedTenantId: uuid(input.authorizedTenantId, "authorizedTenantId"),
    authorizedWorkspaceId: nullableUuid(input.authorizedWorkspaceId, "authorizedWorkspaceId"),
    runId: runId(input.runId, "runId"),
    unitId: runId(input.unitId, "unitId"),
  });
}

export type CreateSourceRunInput = Readonly<{
  tenantId: string;
  workspaceId: string | null;
  sourceCardId: string;
  connectorVersion: number;
  connectorAccountId: string;
  sourcePolicyId: string;
  idempotencyKey: string;
  operation: string;
  inputHash: string;
  hardCapUnits: number;
  maxAttempts: number;
  checkpointKey: string;
  reservedUnits: number;
}>;

export type CreateSourceRunResult = Readonly<{
  kind: "created" | "replayed" | "conflict";
  runId: string;
  unitId: string;
}>;

/**
 * Creates a queued source run with its first page unit and budget reservation.
 * The run may only start once the worker claims the unit lease; every mutation
 * lands inside the caller's tenant transaction.
 */
export async function createSourceRun(
  deps: ConnectorServiceDeps,
  rawInput: unknown,
): Promise<CreateSourceRunResult> {
  const input = plainRecord(rawInput) as unknown as CreateSourceRunInput;
  const tenantId = uuid(input.tenantId, "tenantId");
  const workspaceId = nullableUuid(input.workspaceId, "workspaceId");
  const sourceCardId = token(input.sourceCardId, "sourceCardId");
  const connectorVersion = positiveIntField(input.connectorVersion, "connectorVersion");
  const connectorAccountId = runId(input.connectorAccountId, "connectorAccountId");
  const sourcePolicyId = runId(input.sourcePolicyId, "sourcePolicyId");
  const idemKey = typeof input.idempotencyKey === "string" && IDEMPOTENCY_KEY.test(input.idempotencyKey)
    ? input.idempotencyKey : (() => { throw invalid("idempotencyKey is malformed"); })();
  const operationValue = typeof input.operation === "string" && OPERATION.test(input.operation)
    ? input.operation : (() => { throw invalid("operation is malformed"); })();
  const inputHash = sha(input.inputHash, "inputHash");
  const hardCapUnits = unitsField(input.hardCapUnits, "hardCapUnits");
  const maxAttempts = positiveIntField(input.maxAttempts, "maxAttempts");
  const reservedUnits = unitsField(input.reservedUnits, "reservedUnits");
  if (reservedUnits > hardCapUnits) throw invalid("reservedUnits exceeds hardCapUnits");
  if (typeof input.checkpointKey !== "string" || input.checkpointKey.length < 1
    || input.checkpointKey.length > 512) throw invalid("checkpointKey is malformed");

  const existingRunId = await deps.commands.findRunIdByIdempotencyKey(tenantId, workspaceId, idemKey);
  if (existingRunId !== null) {
    return Object.freeze({ kind: "replayed", runId: existingRunId, unitId: "" });
  }

  const runIdValue = `source-run:${sha256Text(`${tenantId}|${workspaceId ?? ""}|${idemKey}`).slice(0, 48)}`;
  const unitIdValue = `source-run-unit:${sha256Text(`${runIdValue}|1`).slice(0, 48)}`;
  const reservationId = `source-reservation:${sha256Text(`${unitIdValue}|reservation`).slice(0, 48)}`;
  const at = nowIso(deps.clock);

  const runResult = await deps.commands.insertRun({
    id: runIdValue, tenantId, workspaceId, sourceCardId, connectorVersion,
    connectorAccountId, sourcePolicyId, idempotencyKey: idemKey, inputHash,
    operation: operationValue, hardCapUnits, maxAttempts,
  });
  if (runResult === "conflict") {
    throw new ConnectorServiceError("CONNECTOR_IDEMPOTENCY_CONFLICT",
      "The idempotency key is already bound to a different run.");
  }
  if (runResult === "replayed") {
    return Object.freeze({ kind: "replayed", runId: runIdValue, unitId: unitIdValue });
  }
  await deps.commands.insertUnit({
    id: unitIdValue, tenantId, workspaceId, runId: runIdValue, predecessorUnitId: null,
    sequence: 1, checkpointKey: input.checkpointKey, inputHash, cursor: null,
    maxAttempts, reservedUnits,
  });
  await deps.commands.insertReservation({
    id: reservationId, tenantId, workspaceId, runId: runIdValue, unitId: unitIdValue,
    idempotencyKey: `${idemKey}:reservation`, inputHash, reservedUnits, createdAt: at,
  });
  await deps.audit.record({
    action: "connector.source_run.created",
    entityType: "source_run",
    entityId: runIdValue,
    metadata: { sourceCardId, operation: operationValue, hardCapUnits },
  });
  return Object.freeze({ kind: "created", runId: runIdValue, unitId: unitIdValue });
}

function positiveIntField(value: unknown, field: string): number {
  const normalized = typeof value === "string" && /^[0-9]+$/u.test(value) ? Number(value) : value;
  if (typeof normalized !== "number" || !Number.isSafeInteger(normalized) || normalized <= 0) {
    throw invalid(`${field} must be a positive integer`);
  }
  return normalized;
}

function unitsField(value: unknown, field: string): number {
  const normalized = typeof value === "string" && /^[0-9]+(\.[0-9]+)?$/u.test(value) ? Number(value) : value;
  if (typeof normalized !== "number" || !Number.isFinite(normalized) || normalized < 0) {
    throw invalid(`${field} must be a non-negative number`);
  }
  return normalized;
}

export type ClaimSourceRunUnitInput = Readonly<{
  authorizedTenantId: string;
  authorizedWorkspaceId: string | null;
  runId: string;
  unitId: string;
  workerId: string;
  leaseMs: number;
}>;

/**
 * Acquires the unit lease so a worker may execute the page. The update is
 * conditional on the unit being claimable; the DB trigger re-verifies the
 * lease transition.
 */
export async function claimSourceRunUnit(
  deps: ConnectorServiceDeps,
  rawInput: unknown,
): Promise<void> {
  const input = plainRecord(rawInput) as unknown as ClaimSourceRunUnitInput;
  const tenantId = uuid(input.authorizedTenantId, "authorizedTenantId");
  const workspaceId = nullableUuid(input.authorizedWorkspaceId, "authorizedWorkspaceId");
  const runIdValue = runId(input.runId, "runId");
  const unitId = runId(input.unitId, "unitId");
  const workerId = runId(input.workerId, "workerId");
  const leaseMs = unitsField(input.leaseMs, "leaseMs");
  if (leaseMs <= 0 || leaseMs > MAX_LEASE_MS) throw invalid("leaseMs out of bounds");

  const units = await deps.authority.listUnits(tenantId, workspaceId, runIdValue);
  const unit = units.find((candidate) => candidate.id === unitId);
  if (!unit) throw new ConnectorServiceError("CONNECTOR_NOT_FOUND", "The source run unit was not found.");
  const acquired = nowIso(deps.clock);
  const expiresAt = new Date(Date.parse(acquired) + leaseMs).toISOString();
  const attemptSeed = `${unitId}|${unit.leaseGeneration + 1}|${workerId}`;
  try {
    await deps.commands.claimUnitLease({
      unitId, runId: runIdValue, tenantId, workspaceId,
      leaseGeneration: unit.leaseGeneration + 1,
      leaseTokenHash: sha256Text(`lease-token|${attemptSeed}`),
      leaseWorkerHash: sha256Text(`lease-worker|${workerId}`),
      acquiredAt: acquired,
      expiresAt,
    });
  } catch (error) {
    if (error instanceof ConnectorPersistenceError) {
      throw new ConnectorServiceError(
        "CONNECTOR_RUN_STATE", "The source run unit is not claimable.");
    }
    throw error;
  }
  await deps.commands.transitionRunStatus({
    runId: runIdValue, tenantId, workspaceId, status: "running",
    errorCode: null, resultRef: null, at: acquired,
  });
  await deps.audit.record({
    action: "connector.source_unit.claimed",
    entityType: "source_run_unit",
    entityId: unitId,
    metadata: { runId: runIdValue, leaseGeneration: unit.leaseGeneration + 1 },
  });
}

export type RunFixturePageInput = Readonly<{
  authorizedTenantId: string;
  authorizedWorkspaceId: string | null;
  runId: string;
  unitId: string;
  fields: readonly string[];
  execute: ConnectorFixturePageExecutor;
}>;

/** Executes one fixture page inside the loaded policy + budget envelope. */
export async function runAuthorizedFixturePage(
  deps: ConnectorServiceDeps,
  rawInput: unknown,
): Promise<ConnectorRunnerResult> {
  const input = plainRecord(rawInput) as unknown as RunFixturePageInput;
  if (typeof input.execute !== "function") throw invalid("execute must be a function");
  const runner = createAuthorizedFixtureConnectorRunner({
    loadAuthority: (selector) => deps.authority.loadRunAuthority(selector),
    ...(deps.clock ? { clock: deps.clock } : {}),
    ...(deps.runner ? { runner: deps.runner } : {}),
  });
  const fields = Array.isArray(input.fields) ? input.fields.filter((f) => typeof f === "string") : null;
  if (!fields) throw invalid("fields must be an array");
  return runner.runPage({
    authorizedTenantId: uuid(input.authorizedTenantId, "authorizedTenantId"),
    authorizedWorkspaceId: nullableUuid(input.authorizedWorkspaceId, "authorizedWorkspaceId"),
    runId: runId(input.runId, "runId"),
    unitId: runId(input.unitId, "unitId"),
    fields: Object.freeze(fields),
    execute: input.execute,
  });
}

const SETTLE_STATUSES = new Set([
  "page_complete", "completed", "retry_wait", "failed", "cancelled", "blocked",
]);
const IGNORED_STATUSES = new Set(["paused", "busy", "replay"]);
const TERMINAL_UNIT_STATUSES = new Set([
  "page_complete", "completed", "cancelled", "blocked", "failed",
]);
const RETRY_REASONS = new Set(["timeout", "rate_limited", "transport", "provider_5xx"]);

export type SettleSourceRunUnitInput = Readonly<{
  authorizedTenantId: string;
  authorizedWorkspaceId: string | null;
  runId: string;
  unitId: string;
  result: ConnectorRunnerResult;
  redactionFlags?: readonly string[];
}>;

export type SettleSourceRunUnitResult = Readonly<{
  kind: "settled" | "ignored" | "replayed";
  runStatus: string;
  observationId?: string;
  continuationUnitId?: string;
}>;

function checkpointField(checkpoint: PlainRecord | null, field: string): unknown {
  return checkpoint === null ? undefined : checkpoint[field];
}

/**
 * Durably settles one executed page: completes the unit lease outcome, writes
 * the provenance-bound observation (after the unit reaches a settled status,
 * which the observation guard requires), reconciles the budget reservation,
 * and inserts the continuation unit + reservation when the page reported more
 * work. Finally derives and applies the run status. Every write is scoped and
 * idempotent; a stale or foreign checkpoint fails closed.
 */
export async function settleSourceRunUnit(
  deps: ConnectorServiceDeps,
  rawInput: unknown,
): Promise<SettleSourceRunUnitResult> {
  const input = plainRecord(rawInput) as unknown as SettleSourceRunUnitInput;
  const tenantId = uuid(input.authorizedTenantId, "authorizedTenantId");
  const workspaceId = nullableUuid(input.authorizedWorkspaceId, "authorizedWorkspaceId");
  const runIdValue = runId(input.runId, "runId");
  const unitId = runId(input.unitId, "unitId");
  const result = plainRecord(input.result);
  const status = typeof result.status === "string" ? result.status : "";
  if (!SETTLE_STATUSES.has(status) && !IGNORED_STATUSES.has(status)) {
    throw invalid("result.status is malformed");
  }
  const checkpoint = result.checkpoint === undefined || result.checkpoint === null
    ? null : plainRecord(result.checkpoint);
  const redactionFlags = input.redactionFlags === undefined ? [] as readonly string[]
    : (Array.isArray(input.redactionFlags)
      && input.redactionFlags.every((flag) => typeof flag === "string" && flag.length > 0)
      ? Object.freeze([...input.redactionFlags]) : (() => { throw invalid("redactionFlags malformed"); })());

  const units = await deps.authority.listUnits(tenantId, workspaceId, runIdValue);
  const unit = units.find((candidate) => candidate.id === unitId);
  if (!unit) {
    throw new ConnectorServiceError("CONNECTOR_NOT_FOUND", "The source run unit was not found.");
  }
  const runs = await deps.authority.listRuns(tenantId, workspaceId);
  const run = runs.find((candidate) => candidate.id === runIdValue);
  if (!run) {
    throw new ConnectorServiceError("CONNECTOR_NOT_FOUND", "The source run was not found.");
  }
  if (IGNORED_STATUSES.has(status)) {
    return Object.freeze({ kind: "ignored" as const, runStatus: run.status });
  }
  if (checkpoint !== null) {
    if (checkpointField(checkpoint, "runId") !== runIdValue
      || checkpointField(checkpoint, "unitId") !== unitId
      || checkpointField(checkpoint, "tenantId") !== tenantId
      || checkpointField(checkpoint, "checkpointKey") !== unit.checkpointKey
      || checkpointField(checkpoint, "inputHash") !== unit.inputHash) {
      throw new ConnectorServiceError(
        "CONNECTOR_SCOPE_MISMATCH", "The checkpoint does not belong to this unit.");
    }
  } else if (status === "page_complete" || status === "completed" || status === "retry_wait") {
    throw invalid("result.checkpoint is required for this status");
  }
  if (TERMINAL_UNIT_STATUSES.has(unit.status)) {
    return Object.freeze({ kind: "replayed" as const, runStatus: run.status });
  }
  if (unit.status !== "running") {
    throw new ConnectorServiceError(
      "CONNECTOR_STALE_STATE", "The source run unit is not under an active lease.");
  }

  const at = nowIso(deps.clock);
  const actualUnitsValue = checkpointField(checkpoint, "actualUnits");
  const actualUnits = actualUnitsValue === undefined || actualUnitsValue === null ? null
    : unitsField(actualUnitsValue, "result.checkpoint.actualUnits");
  if (actualUnits !== null && actualUnits > unit.reservedUnits) {
    throw invalid("result.checkpoint.actualUnits exceeds reserved units");
  }
  const nextCursorValue = checkpointField(checkpoint, "nextCursor");
  const nextCursor = nextCursorValue === undefined || nextCursorValue === null ? null
    : (typeof nextCursorValue === "string" && nextCursorValue.length > 0 ? nextCursorValue
      : (() => { throw invalid("result.checkpoint.nextCursor is malformed"); })());
  const code = typeof result.code === "string" ? result.code : "D015_MALFORMED";

  // The unit row's state-facts check enforces a distinct field shape per status.
  type OutcomeStatus = "page_complete" | "completed" | "cancelled" | "blocked" | "failed"
    | "retry_wait";
  let outcomeStatus: OutcomeStatus;
  let unitActualUnits: number | null = null;
  let unitNextCursor: string | null = null;
  let unitComplete = false;
  let retryReason: "timeout" | "rate_limited" | "transport" | "provider_5xx" | null = null;
  let nextAttemptAt: string | null = null;
  let errorCode: string | null = null;
  if (status === "page_complete") {
    if (actualUnits === null || nextCursor === null) {
      throw invalid("page_complete requires actualUnits and nextCursor");
    }
    outcomeStatus = "page_complete";
    unitActualUnits = actualUnits;
    unitNextCursor = nextCursor;
  } else if (status === "completed") {
    if (actualUnits === null) throw invalid("completed requires actualUnits");
    outcomeStatus = "completed";
    unitActualUnits = actualUnits;
    unitComplete = true;
  } else if (status === "cancelled" || status === "blocked" || status === "failed") {
    outcomeStatus = status;
    unitActualUnits = actualUnits;
    errorCode = code;
  } else {
    outcomeStatus = "retry_wait";
    const retryReasonValue = checkpointField(checkpoint, "retryReason");
    if (typeof retryReasonValue !== "string" || !RETRY_REASONS.has(retryReasonValue)) {
      throw invalid("result.checkpoint.retryReason is malformed");
    }
    retryReason = retryReasonValue as "timeout" | "rate_limited" | "transport" | "provider_5xx";
    const retryAfterMs = unitsField(
      checkpointField(checkpoint, "retryAfterMs") ?? 0, "result.checkpoint.retryAfterMs");
    if (retryAfterMs <= 0) throw invalid("result.checkpoint.retryAfterMs must be positive");
    nextAttemptAt = new Date(Date.parse(at) + retryAfterMs).toISOString();
    errorCode = code;
  }

  try {
    await deps.commands.completeUnit({
      unitId, runId: runIdValue, tenantId, workspaceId,
      status: outcomeStatus, actualUnits: unitActualUnits, nextCursor: unitNextCursor,
      complete: unitComplete, retryReason, nextAttemptAt, errorCode, endedAt: at,
    });
  } catch (error) {
    if (error instanceof ConnectorPersistenceError) {
      throw new ConnectorServiceError(
        "CONNECTOR_STALE_STATE", "The source run unit is not under an active lease.");
    }
    throw error;
  }

  let observationId: string | undefined;
  const observationValue = checkpointField(checkpoint, "observation");
  if (observationValue !== undefined && observationValue !== null
    && (outcomeStatus === "page_complete" || outcomeStatus === "completed")) {
    const observation = plainRecord(observationValue);
    if (observation.tenantId !== tenantId || observation.runId !== runIdValue
      || observation.sourceCardId !== run.sourceCardId
      || observation.operation !== run.operation
      || typeof observation.observedAt !== "string") {
      throw new ConnectorServiceError(
        "CONNECTOR_SCOPE_MISMATCH", "The observation does not belong to this run.");
    }
    const fields = observation.fields === undefined ? {} : plainRecord(observation.fields);
    const payloadSha256 = sha256Text(canonicalJson(fields));
    const provenanceSha256 = sha256Text(canonicalJson({
      sourceCardId: run.sourceCardId, runId: runIdValue, unitId,
      checkpointKey: unit.checkpointKey, observedAt: observation.observedAt,
    }));
    observationId = `source-observation:${sha256Text(
      `${unitId}|${unit.checkpointKey}|${payloadSha256}`).slice(0, 48)}`;
    await deps.commands.insertObservation({
      id: observationId, tenantId, workspaceId, runId: runIdValue, unitId,
      sourceCardId: run.sourceCardId, operation: run.operation,
      observedAt: observation.observedAt,
      payloadRef: `obs-payload:${payloadSha256}`,
      payloadSha256, fieldNames: Object.freeze(Object.keys(fields).sort()),
      provenanceSha256,
      dedupeKeyHash: sha256Text(`${run.sourceCardId}|${run.operation}|${payloadSha256}`),
      redactionFlags,
    });
  }

  if (outcomeStatus !== "retry_wait") {
    const reservationId = `source-reservation:${sha256Text(`${unitId}|reservation`).slice(0, 48)}`;
    await deps.commands.insertSettlement({
      id: `source-settlement:${sha256Text(`${reservationId}|settlement`).slice(0, 48)}`,
      tenantId, workspaceId, runId: runIdValue, unitId, reservationId,
      actualUnits: actualUnits ?? 0, createdAt: at,
    });
  }

  let continuationUnitId: string | undefined;
  let budgetBlocked = false;
  if (outcomeStatus === "page_complete") {
    const nextSequence = unit.sequence + 1;
    continuationUnitId = `source-run-unit:${sha256Text(`${runIdValue}|${nextSequence}`).slice(0, 48)}`;
    const continuationReservationId = `source-reservation:${
      sha256Text(`${continuationUnitId}|reservation`).slice(0, 48)}`;
    // Mirror novatrade_source_budget_reservation_guard: unsettled reservations
    // count at reserved units, settled at actual. This query runs after the
    // current unit's settlement, so the committed figure is already exact.
    const alreadyCommitted = await deps.authority.runCommittedUnits(
      tenantId, workspaceId, runIdValue);
    if (alreadyCommitted + unit.reservedUnits > run.hardCapUnits) {
      continuationUnitId = undefined;
      budgetBlocked = true;
    } else if (!units.some((candidate) => candidate.id === continuationUnitId)) {
      await deps.commands.insertUnit({
        id: continuationUnitId, tenantId, workspaceId, runId: runIdValue,
        predecessorUnitId: unitId, sequence: nextSequence,
        checkpointKey: `checkpoint:${sha256Text(`${runIdValue}|${nextSequence}`).slice(0, 48)}`,
        inputHash: unit.inputHash, cursor: nextCursor,
        maxAttempts: unit.maxAttempts, reservedUnits: unit.reservedUnits,
      });
      await deps.commands.insertReservation({
        id: continuationReservationId, tenantId, workspaceId,
        runId: runIdValue, unitId: continuationUnitId,
        idempotencyKey: `reservation:${continuationUnitId}`,
        inputHash: unit.inputHash, reservedUnits: unit.reservedUnits, createdAt: at,
      });
    }
  }

  type RunTarget = "running" | "paused" | "retry_wait" | "completed" | "failed"
    | "cancelled" | "blocked" | "killed";
  const settledUnits = units.map((candidate) => candidate.id === unitId
    ? { status: outcomeStatus as string }
    : { status: candidate.status as string });
  if (continuationUnitId !== undefined) settledUnits.push({ status: "queued" });
  const anyActive = settledUnits.some((candidate) =>
    candidate.status === "queued" || candidate.status === "running"
    || candidate.status === "paused" || candidate.status === "retry_wait");
  let target: RunTarget;
  if (budgetBlocked) target = "blocked";
  else if (outcomeStatus === "failed") target = "failed";
  else if (outcomeStatus === "cancelled") target = "cancelled";
  else if (outcomeStatus === "blocked") target = "blocked";
  else if (!anyActive) target = "completed";
  else if (outcomeStatus === "retry_wait") target = "retry_wait";
  else target = "running";

  const TERMINAL_RUN_STATUSES = new Set(["completed", "failed", "cancelled", "blocked", "killed"]);
  const directTransitions: Readonly<Record<string, readonly RunTarget[]>> = {
    queued: ["running", "paused", "cancelled", "blocked", "killed"],
    running: ["running", "paused", "retry_wait", "completed", "failed", "cancelled", "blocked", "killed"],
    paused: ["running", "cancelled", "killed"],
    retry_wait: ["running", "cancelled", "killed"],
  };
  if (target !== run.status && !TERMINAL_RUN_STATUSES.has(run.status)) {
    const allowed = directTransitions[run.status] ?? [];
    if (!allowed.includes(target)) {
      await deps.commands.transitionRunStatus({
        runId: runIdValue, tenantId, workspaceId, status: "running",
        errorCode: null, resultRef: null, at,
      });
    }
    await deps.commands.transitionRunStatus({
      runId: runIdValue, tenantId, workspaceId, status: target,
      errorCode: budgetBlocked ? "D015_COST_FAIL" : errorCode, resultRef: null, at,
    });
  }

  await deps.audit.record({
    action: "connector.source_unit.settled",
    entityType: "source_run_unit",
    entityId: unitId,
    metadata: {
      runId: runIdValue, status: outcomeStatus, runStatus: target,
      ...(observationId !== undefined ? { observationId } : {}),
      ...(continuationUnitId !== undefined ? { continuationUnitId } : {}),
    },
  });
  return Object.freeze({
    kind: "settled" as const, runStatus: target,
    ...(observationId !== undefined ? { observationId } : {}),
    ...(continuationUnitId !== undefined ? { continuationUnitId } : {}),
  });
}

export type ExecuteNextSourceUnitInput = Readonly<{
  authorizedTenantId: string;
  authorizedWorkspaceId: string | null;
  workerId: string;
  leaseMs: number;
  execute: ConnectorFixturePageExecutor;
}>;

export type ExecuteNextSourceUnitResult = Readonly<{
  status: "idle" | "executed";
  runId?: string;
  unitId?: string;
  settle?: SettleSourceRunUnitResult;
}>;

/**
 * One dispatcher tick: picks the next runnable unit in the scope, acquires its
 * lease, executes the fixture page under policy, and durably settles the
 * outcome. A scheduler worker route calls this per tick; claim conflicts with
 * concurrent workers propagate as CONNECTOR_RUN_STATE so the caller idles.
 */
export async function executeNextSourceUnit(
  deps: ConnectorServiceDeps,
  rawInput: unknown,
): Promise<ExecuteNextSourceUnitResult> {
  const input = plainRecord(rawInput) as unknown as ExecuteNextSourceUnitInput;
  const tenantId = uuid(input.authorizedTenantId, "authorizedTenantId");
  const workspaceId = nullableUuid(input.authorizedWorkspaceId, "authorizedWorkspaceId");
  const workerId = runId(input.workerId, "workerId");
  const leaseMs = unitsField(input.leaseMs, "leaseMs");
  if (leaseMs <= 0 || leaseMs > MAX_LEASE_MS) throw invalid("leaseMs out of bounds");
  if (typeof input.execute !== "function") throw invalid("execute must be a function");

  const candidates = await deps.authority.listRunnableUnits(
    tenantId, workspaceId, nowIso(deps.clock));
  const next = candidates[0];
  if (!next) return Object.freeze({ status: "idle" as const });

  const snapshot = await deps.authority.loadRunAuthority({
    authorizedTenantId: tenantId, authorizedWorkspaceId: workspaceId,
    runId: next.runId, unitId: next.unitId,
  });
  if (!snapshot) {
    throw new ConnectorServiceError("CONNECTOR_NOT_FOUND", "The source run unit was not found.");
  }

  await claimSourceRunUnit(deps, {
    authorizedTenantId: tenantId, authorizedWorkspaceId: workspaceId,
    runId: next.runId, unitId: next.unitId, workerId, leaseMs,
  });
  let result: ConnectorRunnerResult;
  try {
    result = await runAuthorizedFixturePage(deps, {
      authorizedTenantId: tenantId, authorizedWorkspaceId: workspaceId,
      runId: next.runId, unitId: next.unitId,
      fields: snapshot.policy.allowedFields, execute: input.execute,
    });
  } catch (error) {
    // Best-effort salvage: a leased unit left running is stranded forever, so
    // try to record a terminal failure before propagating the original error.
    try {
      await settleSourceRunUnit(deps, {
        authorizedTenantId: tenantId, authorizedWorkspaceId: workspaceId,
        runId: next.runId, unitId: next.unitId,
        result: { status: "failed", code: "D015_MALFORMED" },
      });
    } catch { /* the original error wins */ }
    throw error;
  }
  const settle = await settleSourceRunUnit(deps, {
    authorizedTenantId: tenantId, authorizedWorkspaceId: workspaceId,
    runId: next.runId, unitId: next.unitId, result,
  });
  return Object.freeze({
    status: "executed" as const, runId: next.runId, unitId: next.unitId, settle,
  });
}

export type KillSwitchInput = Readonly<{
  tenantId: string;
  workspaceId: string | null;
  runId: string;
  reason: string;
}>;

/**
 * Cooperative cancel: sets cancel_requested_at so running units stop at the
 * next checkpoint, and finalizes the run to cancelled when no unit holds a
 * lease. The authorized runner surfaces D015_CANCELLED on the next page.
 */
export async function requestSourceRunCancellation(
  deps: ConnectorServiceDeps,
  rawInput: unknown,
): Promise<Readonly<{ kind: "cancel_requested" | "cancelled" }>> {
  const input = plainRecord(rawInput) as unknown as KillSwitchInput;
  const tenantId = uuid(input.tenantId, "tenantId");
  const workspaceId = nullableUuid(input.workspaceId, "workspaceId");
  const runIdValue = runId(input.runId, "runId");
  reason(input.reason);
  const at = nowIso(deps.clock);
  await deps.commands.requestRunCancellation({ runId: runIdValue, tenantId, workspaceId, at });
  const units = await deps.authority.listUnits(tenantId, workspaceId, runIdValue);
  const leased = units.some((unit) => unit.status === "running" && unit.leaseExpiresAt !== null
    && Date.parse(unit.leaseExpiresAt) > Date.parse(at));
  if (!leased) {
    await deps.commands.transitionRunStatus({
      runId: runIdValue, tenantId, workspaceId, status: "cancelled",
      errorCode: null, resultRef: null, at,
    });
  }
  await deps.audit.record({
    action: "connector.source_run.cancelled",
    entityType: "source_run",
    entityId: runIdValue,
    metadata: { reason: input.reason, finalized: !leased },
  });
  return Object.freeze({ kind: leased ? "cancel_requested" : "cancelled" });
}

/** Immediate kill switch: terminal kill regardless of unit progress. */
export async function killSourceRun(
  deps: ConnectorServiceDeps,
  rawInput: unknown,
): Promise<void> {
  const input = plainRecord(rawInput) as unknown as KillSwitchInput;
  const tenantId = uuid(input.tenantId, "tenantId");
  const workspaceId = nullableUuid(input.workspaceId, "workspaceId");
  const runIdValue = runId(input.runId, "runId");
  reason(input.reason);
  await deps.commands.transitionRunStatus({
    runId: runIdValue, tenantId, workspaceId, status: "killed",
    errorCode: "D015_KILLED", resultRef: null, at: nowIso(deps.clock),
  });
  await deps.audit.record({
    action: "connector.source_run.killed",
    entityType: "source_run",
    entityId: runIdValue,
    metadata: { reason: input.reason },
  });
}

function reason(value: unknown): string {
  if (typeof value !== "string" || value.length < 1 || value.length > 2000
    || value !== value.trim() || /[\u0000-\u001f\u007f]/u.test(value)) {
    throw invalid("reason is malformed");
  }
  return value;
}

export type RegisterFixtureAccountInput = Readonly<{
  tenantId: string;
  workspaceId: string | null;
  sourceCardId: string;
  connectorVersion: number;
  accountKey: string;
}>;

export async function registerFixtureConnectorAccount(
  deps: ConnectorServiceDeps,
  rawInput: unknown,
): Promise<Readonly<{ kind: "created" | "replayed"; accountId: string }>> {
  const input = plainRecord(rawInput) as unknown as RegisterFixtureAccountInput;
  const tenantId = uuid(input.tenantId, "tenantId");
  const workspaceId = nullableUuid(input.workspaceId, "workspaceId");
  const sourceCardId = token(input.sourceCardId, "sourceCardId");
  const connectorVersion = positiveIntField(input.connectorVersion, "connectorVersion");
  const accountKey = token(input.accountKey, "accountKey");
  const accountId = `connector-account:${sha256Text(`${tenantId}|${workspaceId ?? ""}|${sourceCardId}|${accountKey}`).slice(0, 48)}`;
  const kind = await deps.commands.insertAccount({
    id: accountId, tenantId, workspaceId, sourceCardId, connectorVersion,
    accountKey, status: "fixture_only", credentialRefHash: null,
  });
  if (kind === "created") {
    await deps.audit.record({
      action: "connector.account.registered",
      entityType: "connector_account",
      entityId: accountId,
      metadata: { sourceCardId, connectorVersion, status: "fixture_only" },
    });
  }
  return Object.freeze({ kind, accountId });
}

export function generateConnectorId(prefix: string): string {
  return `${prefix}:${randomUUID()}`;
}
