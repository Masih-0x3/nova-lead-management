import { isProxy } from "node:util/types";

import type { DbClient } from "@/lib/db";

import { ConnectorPersistenceError } from "./repository";

function fail(): never {
  throw new ConnectorPersistenceError();
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const RUN_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/u;
const SHA256 = /^[0-9a-f]{64}$/u;
const TOKEN = /^[a-z0-9][a-z0-9._:-]{0,159}$/u;
const IDEMPOTENCY_KEY = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,511}$/u;
const OPERATION = /^[a-z0-9][a-z0-9._:-]{0,159}$/u;
const CURSOR = /^.{1,4096}$/u;
const ACCOUNT_STATUSES = new Set(["disabled", "fixture_only", "ready", "suspended", "revoked"]);

function uuid(value: unknown): string {
  if (typeof value !== "string" || !UUID.test(value)) fail();
  return value;
}

function runId(value: unknown): string {
  if (typeof value !== "string" || !RUN_ID.test(value)) fail();
  return value;
}

function token(value: unknown): string {
  if (typeof value !== "string" || !TOKEN.test(value)) fail();
  return value;
}

function sha(value: unknown): string {
  if (typeof value !== "string" || !SHA256.test(value)) fail();
  return value;
}

function operation(value: unknown): string {
  if (typeof value !== "string" || !OPERATION.test(value)) fail();
  return value;
}

function idempotencyKey(value: unknown): string {
  if (typeof value !== "string" || !IDEMPOTENCY_KEY.test(value)) fail();
  return value;
}

function unitsValue(value: unknown): number {
  const normalized = typeof value === "string" && /^[0-9]+(\.[0-9]+)?$/u.test(value) ? Number(value) : value;
  if (typeof normalized !== "number" || !Number.isFinite(normalized) || normalized < 0) fail();
  return normalized;
}

function positiveInt(value: unknown): number {
  const normalized = typeof value === "string" && /^[0-9]+$/u.test(value) ? Number(value) : value;
  if (typeof normalized !== "number" || !Number.isSafeInteger(normalized) || normalized <= 0) fail();
  return normalized;
}

function nonNegativeInt(value: unknown): number {
  const normalized = typeof value === "string" && /^[0-9]+$/u.test(value) ? Number(value) : value;
  if (typeof normalized !== "number" || !Number.isSafeInteger(normalized) || normalized < 0) fail();
  return normalized;
}

function timestamp(value: unknown): string {
  if (value instanceof Date) {
    if (Number.isFinite(value.getTime())) return value.toISOString();
    fail();
  }
  if (typeof value !== "string") fail();
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) fail();
  return new Date(parsed).toISOString();
}

function nullableTimestamp(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  return timestamp(value);
}

function jsonValue(value: unknown): string {
  if (!Array.isArray(value) && (typeof value !== "object" || value === null)) fail();
  try {
    return JSON.stringify(value);
  } catch {
    fail();
  }
}

function stringListJson(value: unknown): string {
  if (!Array.isArray(value) || isProxy(value)) fail();
  for (const item of value) {
    if (typeof item !== "string" || item.length === 0 || item.length > 300) fail();
  }
  return JSON.stringify(value);
}

function expectChanges(result: { changes: number } | null | undefined, expected = 1): void {
  if (!result || typeof result.changes !== "number" || result.changes !== expected) fail();
}

export type ConnectorAccountInsert = Readonly<{
  id: string;
  tenantId: string;
  workspaceId: string | null;
  sourceCardId: string;
  connectorVersion: number;
  accountKey: string;
  status: "disabled" | "fixture_only" | "ready";
  credentialRefHash: string | null;
}>;

export type ConnectorPolicyInsert = Readonly<{
  id: string;
  tenantId: string;
  workspaceId: string | null;
  sourceCardId: string;
  connectorVersion: number;
  connectorAccountId: string;
  policyKey: string;
  version: number;
  executionMode: "fixture";
  termsState: "approved" | "pending" | "missing" | "expired" | "revoked";
  allowedOperations: readonly string[];
  allowedFields: readonly string[];
  hardCapUnits: number;
  attestationExpiresAt: string | null;
  attestationRevoked: boolean;
  policySha256: string;
}>;

export type ConnectorActivationInsert = Readonly<{
  id: string;
  tenantId: string;
  workspaceId: string | null;
  policyKey: string;
  policyVersion: number;
  sourcePolicyId: string;
  activatedByHash: string;
  activationReason: string;
}>;

export type ConnectorRunInsert = Readonly<{
  id: string;
  tenantId: string;
  workspaceId: string | null;
  sourceCardId: string;
  connectorVersion: number;
  connectorAccountId: string;
  sourcePolicyId: string;
  idempotencyKey: string;
  inputHash: string;
  operation: string;
  hardCapUnits: number;
  maxAttempts: number;
}>;

export type ConnectorUnitInsert = Readonly<{
  id: string;
  tenantId: string;
  workspaceId: string | null;
  runId: string;
  predecessorUnitId: string | null;
  sequence: number;
  checkpointKey: string;
  inputHash: string;
  cursor: string | null;
  maxAttempts: number;
  reservedUnits: number;
}>;

export type ConnectorLeaseClaim = Readonly<{
  unitId: string;
  runId: string;
  tenantId: string;
  workspaceId: string | null;
  leaseGeneration: number;
  leaseTokenHash: string;
  leaseWorkerHash: string;
  acquiredAt: string;
  expiresAt: string;
}>;

export type ConnectorUnitOutcome = Readonly<{
  unitId: string;
  runId: string;
  tenantId: string;
  workspaceId: string | null;
  status: "page_complete" | "completed" | "cancelled" | "blocked" | "failed" | "retry_wait";
  actualUnits: number | null;
  nextCursor: string | null;
  complete: boolean;
  retryReason: "timeout" | "rate_limited" | "transport" | "provider_5xx" | null;
  nextAttemptAt: string | null;
  errorCode: string | null;
  endedAt: string;
}>;

export type ConnectorObservationInsert = Readonly<{
  id: string;
  tenantId: string;
  workspaceId: string | null;
  runId: string;
  unitId: string;
  sourceCardId: string;
  operation: string;
  observedAt: string;
  payloadRef: string;
  payloadSha256: string;
  fieldNames: readonly string[];
  provenanceSha256: string;
  dedupeKeyHash: string;
  redactionFlags: readonly string[];
}>;

export type ConnectorReservationInsert = Readonly<{
  id: string;
  tenantId: string;
  workspaceId: string | null;
  runId: string;
  unitId: string;
  idempotencyKey: string;
  inputHash: string;
  reservedUnits: number;
  createdAt: string;
}>;

export type ConnectorSettlementInsert = Readonly<{
  id: string;
  tenantId: string;
  workspaceId: string | null;
  runId: string;
  unitId: string;
  reservationId: string;
  actualUnits: number;
  createdAt: string;
}>;

export interface ConnectorCommandRepository {
  insertRegistryVersion(record: Readonly<{
    sourceCardId: string;
    version: number;
    executionMode: "fixture";
    transport: "none";
    operations: readonly string[];
    outputFields: readonly string[];
    adapterSha256: string;
  }>): Promise<void>;
  insertAccount(record: ConnectorAccountInsert): Promise<"created" | "replayed">;
  updateAccountStatus(input: Readonly<{
    accountId: string; tenantId: string; workspaceId: string | null;
    status: "disabled" | "fixture_only" | "ready" | "suspended" | "revoked";
  }>): Promise<void>;
  insertPolicyVersion(record: ConnectorPolicyInsert): Promise<"created" | "replayed">;
  updatePolicyState(input: Readonly<{
    policyId: string; tenantId: string; workspaceId: string | null;
    state: "active" | "superseded" | "revoked";
  }>): Promise<void>;
  insertActivation(record: ConnectorActivationInsert): Promise<"created" | "replayed">;
  revokeActivation(input: Readonly<{
    activationId: string; tenantId: string; workspaceId: string | null;
    revokedByHash: string; revocationReason: string;
  }>): Promise<void>;
  insertRun(record: ConnectorRunInsert): Promise<"created" | "replayed" | "conflict">;
  insertUnit(record: ConnectorUnitInsert): Promise<void>;
  insertReservation(record: ConnectorReservationInsert): Promise<"created" | "replayed">;
  claimUnitLease(claim: ConnectorLeaseClaim): Promise<void>;
  completeUnit(outcome: ConnectorUnitOutcome): Promise<void>;
  insertObservation(record: ConnectorObservationInsert): Promise<"created" | "replayed">;
  insertSettlement(record: ConnectorSettlementInsert): Promise<"created" | "replayed">;
  transitionRunStatus(input: Readonly<{
    runId: string; tenantId: string; workspaceId: string | null;
    status: "running" | "paused" | "retry_wait" | "completed" | "failed" | "cancelled" | "blocked" | "killed";
    errorCode: string | null; resultRef: string | null; at: string;
  }>): Promise<void>;
  requestRunCancellation(input: Readonly<{
    runId: string; tenantId: string; workspaceId: string | null; at: string;
  }>): Promise<void>;
  findRunIdByIdempotencyKey(
    tenantId: string, workspaceId: string | null, key: string,
  ): Promise<string | null>;
}

export function createPostgresConnectorCommandRepository(db: DbClient): ConnectorCommandRepository {
  if (!db || typeof db.prepare !== "function") throw new TypeError("A database client is required");

  async function runExpect(sql: string, params: readonly unknown[], expected = 1): Promise<void> {
    expectChanges(await db.prepare(sql).run(...params), expected);
  }

  const repository: ConnectorCommandRepository = {
    async insertRegistryVersion(record) {
      token(record.sourceCardId);
      positiveInt(record.version);
      sha(record.adapterSha256);
      const result = await db.prepare(
        `INSERT INTO public.connector_versions
          (source_card_id, version, execution_mode, transport, operations, output_fields, adapter_sha256)
          VALUES (?, ?, 'fixture', 'none', ?::jsonb, ?::jsonb, ?)
          ON CONFLICT (source_card_id, version) DO NOTHING`,
      ).run(record.sourceCardId, record.version, stringListJson(record.operations),
        stringListJson(record.outputFields), record.adapterSha256);
      if (!result || (result.changes !== 0 && result.changes !== 1)) fail();
    },
    async insertAccount(record) {
      uuid(record.tenantId);
      if (record.workspaceId !== null) uuid(record.workspaceId);
      runId(record.id);
      token(record.sourceCardId);
      positiveInt(record.connectorVersion);
      token(record.accountKey);
      if (!ACCOUNT_STATUSES.has(record.status)) fail();
      if (record.credentialRefHash !== null) sha(record.credentialRefHash);
      if (record.status === "fixture_only" && record.credentialRefHash !== null) fail();
      const inserted = await db.prepare(
        `INSERT INTO public.connector_accounts
          (id, tenant_id, workspace_id, source_card_id, connector_version, account_key, status, credential_ref_hash)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT (id) DO NOTHING RETURNING id`,
      ).all(
        record.id, record.tenantId, record.workspaceId, record.sourceCardId,
        record.connectorVersion, record.accountKey, record.status, record.credentialRefHash,
      );
      if (!Array.isArray(inserted) || isProxy(inserted)) fail();
      return inserted.length === 1 ? "created" : "replayed";
    },
    async updateAccountStatus(input) {
      runId(input.accountId);
      uuid(input.tenantId);
      if (input.workspaceId !== null) uuid(input.workspaceId);
      if (!ACCOUNT_STATUSES.has(input.status)) fail();
      await runExpect(
        `UPDATE public.connector_accounts SET status = ?, updated_at = pg_catalog.statement_timestamp()
          WHERE id = ? AND tenant_id = ? AND (workspace_id IS NOT DISTINCT FROM ?)`,
        [input.status, input.accountId, input.tenantId, input.workspaceId],
      );
    },
    async insertPolicyVersion(record) {
      runId(record.id);
      uuid(record.tenantId);
      if (record.workspaceId !== null) uuid(record.workspaceId);
      token(record.sourceCardId);
      positiveInt(record.connectorVersion);
      runId(record.connectorAccountId);
      token(record.policyKey);
      positiveInt(record.version);
      unitsValue(record.hardCapUnits);
      sha(record.policySha256);
      nullableTimestamp(record.attestationExpiresAt);
      const inserted = await db.prepare(
        `INSERT INTO public.source_policy_versions
          (id, tenant_id, workspace_id, source_card_id, connector_version, connector_account_id,
           policy_key, version, state, execution_mode, terms_state, allowed_operations,
           allowed_fields, hard_cap_units, attestation_expires_at, attestation_revoked, policy_sha256)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'draft', 'fixture', ?, ?::jsonb, ?::jsonb, ?, ?, ?, ?)
          ON CONFLICT (id) DO NOTHING RETURNING id`,
      ).all(
        record.id, record.tenantId, record.workspaceId, record.sourceCardId, record.connectorVersion,
        record.connectorAccountId, record.policyKey, record.version, record.termsState,
        stringListJson(record.allowedOperations), stringListJson(record.allowedFields),
        record.hardCapUnits, record.attestationExpiresAt, record.attestationRevoked,
        record.policySha256,
      );
      if (!Array.isArray(inserted) || isProxy(inserted)) fail();
      return inserted.length === 1 ? "created" : "replayed";
    },
    async updatePolicyState(input) {
      runId(input.policyId);
      uuid(input.tenantId);
      if (input.workspaceId !== null) uuid(input.workspaceId);
      if (input.state !== "active" && input.state !== "superseded" && input.state !== "revoked") fail();
      await runExpect(
        `UPDATE public.source_policy_versions SET state = ?
          WHERE id = ? AND tenant_id = ? AND (workspace_id IS NOT DISTINCT FROM ?)`,
        [input.state, input.policyId, input.tenantId, input.workspaceId],
      );
    },
    async insertActivation(record) {
      runId(record.id);
      uuid(record.tenantId);
      if (record.workspaceId !== null) uuid(record.workspaceId);
      token(record.policyKey);
      positiveInt(record.policyVersion);
      runId(record.sourcePolicyId);
      sha(record.activatedByHash);
      if (typeof record.activationReason !== "string"
        || record.activationReason.length < 1 || record.activationReason.length > 2000) fail();
      const inserted = await db.prepare(
        `INSERT INTO public.current_source_policy_activations
          (id, tenant_id, workspace_id, policy_key, policy_version, source_policy_id,
           activated_by_hash, activation_reason)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT (id) DO NOTHING RETURNING id`,
      ).all(
        record.id, record.tenantId, record.workspaceId, record.policyKey, record.policyVersion,
        record.sourcePolicyId, record.activatedByHash, record.activationReason,
      );
      if (!Array.isArray(inserted) || isProxy(inserted)) fail();
      return inserted.length === 1 ? "created" : "replayed";
    },
    async revokeActivation(input) {
      runId(input.activationId);
      uuid(input.tenantId);
      if (input.workspaceId !== null) uuid(input.workspaceId);
      sha(input.revokedByHash);
      if (typeof input.revocationReason !== "string"
        || input.revocationReason.length < 1 || input.revocationReason.length > 2000) fail();
      await runExpect(
        `UPDATE public.current_source_policy_activations
          SET revoked_at = pg_catalog.statement_timestamp(), revoked_by_hash = ?, revocation_reason = ?
          WHERE id = ? AND tenant_id = ? AND (workspace_id IS NOT DISTINCT FROM ?)
            AND revoked_at IS NULL`,
        [input.revokedByHash, input.revocationReason, input.activationId,
          input.tenantId, input.workspaceId],
      );
    },
    async insertRun(record) {
      runId(record.id);
      uuid(record.tenantId);
      if (record.workspaceId !== null) uuid(record.workspaceId);
      token(record.sourceCardId);
      positiveInt(record.connectorVersion);
      runId(record.connectorAccountId);
      runId(record.sourcePolicyId);
      idempotencyKey(record.idempotencyKey);
      sha(record.inputHash);
      operation(record.operation);
      unitsValue(record.hardCapUnits);
      positiveInt(record.maxAttempts);
      const existing = await db.prepare(
        `SELECT id FROM public.source_runs
          WHERE tenant_id = ? AND (workspace_id IS NOT DISTINCT FROM ?) AND idempotency_key = ?`,
      ).get(record.tenantId, record.workspaceId, record.idempotencyKey);
      if (existing !== undefined) {
        const existingRow = existing as Record<string, unknown>;
        return existingRow.id === record.id ? "replayed" : "conflict";
      }
      const inserted = await db.prepare(
        `INSERT INTO public.source_runs
          (id, tenant_id, workspace_id, source_card_id, connector_version, connector_account_id,
           source_policy_id, idempotency_key, input_hash, operation, status, hard_cap_units, max_attempts)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'queued', ?, ?)
          ON CONFLICT (id) DO NOTHING RETURNING id`,
      ).all(
        record.id, record.tenantId, record.workspaceId, record.sourceCardId, record.connectorVersion,
        record.connectorAccountId, record.sourcePolicyId, record.idempotencyKey, record.inputHash,
        record.operation, record.hardCapUnits, record.maxAttempts,
      );
      if (!Array.isArray(inserted) || isProxy(inserted)) fail();
      return inserted.length === 1 ? "created" : "replayed";
    },
    async insertUnit(record) {
      runId(record.id);
      uuid(record.tenantId);
      if (record.workspaceId !== null) uuid(record.workspaceId);
      runId(record.runId);
      if (record.predecessorUnitId !== null) runId(record.predecessorUnitId);
      positiveInt(record.sequence);
      if (typeof record.checkpointKey !== "string"
        || record.checkpointKey.length < 1 || record.checkpointKey.length > 512) fail();
      sha(record.inputHash);
      if (record.cursor !== null && (typeof record.cursor !== "string" || !CURSOR.test(record.cursor))) fail();
      positiveInt(record.maxAttempts);
      unitsValue(record.reservedUnits);
      await runExpect(
        `INSERT INTO public.source_run_units
          (id, tenant_id, workspace_id, run_id, predecessor_unit_id, sequence, checkpoint_key,
           input_hash, cursor, status, attempt_count, max_attempts, reserved_units, complete)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'queued', 0, ?, ?, false)`,
        [record.id, record.tenantId, record.workspaceId, record.runId, record.predecessorUnitId,
          record.sequence, record.checkpointKey, record.inputHash, record.cursor,
          record.maxAttempts, record.reservedUnits],
      );
    },
    async insertReservation(record) {
      runId(record.id);
      uuid(record.tenantId);
      if (record.workspaceId !== null) uuid(record.workspaceId);
      runId(record.runId);
      runId(record.unitId);
      idempotencyKey(record.idempotencyKey);
      sha(record.inputHash);
      unitsValue(record.reservedUnits);
      timestamp(record.createdAt);
      const inserted = await db.prepare(
        `INSERT INTO public.source_usage_reservations
          (id, tenant_id, workspace_id, run_id, unit_id, idempotency_key, input_hash, reserved_units, created_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT (run_id, idempotency_key) DO NOTHING RETURNING id`,
      ).all(
        record.id, record.tenantId, record.workspaceId, record.runId, record.unitId,
        record.idempotencyKey, record.inputHash, record.reservedUnits, record.createdAt,
      );
      if (!Array.isArray(inserted) || isProxy(inserted)) fail();
      return inserted.length === 1 ? "created" : "replayed";
    },
    async claimUnitLease(claim) {
      runId(claim.unitId);
      runId(claim.runId);
      uuid(claim.tenantId);
      if (claim.workspaceId !== null) uuid(claim.workspaceId);
      nonNegativeInt(claim.leaseGeneration);
      sha(claim.leaseTokenHash);
      sha(claim.leaseWorkerHash);
      timestamp(claim.acquiredAt);
      timestamp(claim.expiresAt);
      await runExpect(
        `UPDATE public.source_run_units SET
          status = 'running', attempt_count = attempt_count + 1,
          lease_generation = lease_generation + 1, lease_token_hash = ?, lease_worker_hash = ?,
          lease_acquired_at = ?, lease_heartbeat_at = ?, lease_expires_at = ?,
          started_at = ?, updated_at = pg_catalog.statement_timestamp()
          WHERE id = ? AND run_id = ? AND tenant_id = ?
            AND (workspace_id IS NOT DISTINCT FROM ?)
            AND (status IN ('queued', 'retry_wait')
              OR (status = 'running' AND lease_expires_at < ?))
            AND attempt_count < max_attempts
            AND lease_generation + 1 = ?`,
        [claim.leaseTokenHash, claim.leaseWorkerHash, claim.acquiredAt, claim.acquiredAt,
          claim.expiresAt, claim.acquiredAt, claim.unitId, claim.runId, claim.tenantId,
          claim.workspaceId, claim.acquiredAt, claim.leaseGeneration],
      );
    },
    async completeUnit(outcome) {
      runId(outcome.unitId);
      runId(outcome.runId);
      uuid(outcome.tenantId);
      if (outcome.workspaceId !== null) uuid(outcome.workspaceId);
      timestamp(outcome.endedAt);
      if (outcome.actualUnits !== null) unitsValue(outcome.actualUnits);
      if (outcome.nextCursor !== null
        && (typeof outcome.nextCursor !== "string" || !CURSOR.test(outcome.nextCursor))) fail();
      const terminal = outcome.status === "page_complete" || outcome.status === "completed"
        || outcome.status === "cancelled" || outcome.status === "blocked" || outcome.status === "failed";
      const retryWait = outcome.status === "retry_wait";
      if (!terminal && !retryWait) fail();
      if (retryWait && (outcome.retryReason === null || outcome.nextAttemptAt === null)) fail();
      if (retryWait) nullableTimestamp(outcome.nextAttemptAt);
      await runExpect(
        `UPDATE public.source_run_units SET
          status = ?, actual_units = ?, next_cursor = ?, complete = ?,
          retry_reason = ?, next_attempt_at = ?, error_code = ?,
          lease_token_hash = NULL, lease_worker_hash = NULL, lease_acquired_at = NULL,
          lease_heartbeat_at = NULL, lease_expires_at = NULL,
          ended_at = CASE WHEN ? IN ('page_complete','completed','cancelled','blocked','failed')
            THEN ?::pg_catalog.timestamptz ELSE NULL END,
          updated_at = pg_catalog.statement_timestamp()
          WHERE id = ? AND run_id = ? AND tenant_id = ?
            AND (workspace_id IS NOT DISTINCT FROM ?)
            AND status = 'running'`,
        [outcome.status, outcome.actualUnits, outcome.nextCursor, outcome.complete,
          outcome.retryReason, outcome.nextAttemptAt, outcome.errorCode,
          outcome.status, outcome.endedAt, outcome.unitId, outcome.runId,
          outcome.tenantId, outcome.workspaceId],
      );
    },
    async insertObservation(record) {
      runId(record.id);
      uuid(record.tenantId);
      if (record.workspaceId !== null) uuid(record.workspaceId);
      runId(record.runId);
      runId(record.unitId);
      token(record.sourceCardId);
      operation(record.operation);
      timestamp(record.observedAt);
      if (typeof record.payloadRef !== "string"
        || record.payloadRef.length < 1 || record.payloadRef.length > 1024) fail();
      sha(record.payloadSha256);
      sha(record.provenanceSha256);
      sha(record.dedupeKeyHash);
      const inserted = await db.prepare(
        `INSERT INTO public.source_observations
          (id, tenant_id, workspace_id, run_id, unit_id, source_card_id, operation,
           observed_at, payload_ref, payload_sha256, field_names, provenance_sha256,
           dedupe_key_hash, redaction_flags)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?::jsonb, ?, ?, ?::jsonb)
          ON CONFLICT (id) DO NOTHING RETURNING id`,
      ).all(
        record.id, record.tenantId, record.workspaceId, record.runId, record.unitId,
        record.sourceCardId, record.operation, record.observedAt, record.payloadRef,
        record.payloadSha256, stringListJson(record.fieldNames), record.provenanceSha256,
        record.dedupeKeyHash, jsonValue(record.redactionFlags),
      );
      if (!Array.isArray(inserted) || isProxy(inserted)) fail();
      return inserted.length === 1 ? "created" : "replayed";
    },
    async insertSettlement(record) {
      runId(record.id);
      uuid(record.tenantId);
      if (record.workspaceId !== null) uuid(record.workspaceId);
      runId(record.runId);
      runId(record.unitId);
      runId(record.reservationId);
      unitsValue(record.actualUnits);
      timestamp(record.createdAt);
      const inserted = await db.prepare(
        `INSERT INTO public.source_usage_settlements
          (id, tenant_id, workspace_id, run_id, unit_id, reservation_id, status, actual_units, settled_at)
          VALUES (?, ?, ?, ?, ?, ?, 'settled', ?, ?)
          ON CONFLICT (id) DO NOTHING RETURNING id`,
      ).all(
        record.id, record.tenantId, record.workspaceId, record.runId, record.unitId,
        record.reservationId, record.actualUnits, record.createdAt,
      );
      if (!Array.isArray(inserted) || isProxy(inserted)) fail();
      return inserted.length === 1 ? "created" : "replayed";
    },
    async transitionRunStatus(input) {
      runId(input.runId);
      uuid(input.tenantId);
      if (input.workspaceId !== null) uuid(input.workspaceId);
      timestamp(input.at);
      await runExpect(
        `UPDATE public.source_runs SET
          status = ?,
          started_at = CASE WHEN started_at IS NULL THEN ? ELSE started_at END,
          ended_at = CASE WHEN ? IN ('completed','failed','cancelled','blocked','killed')
            THEN ?::pg_catalog.timestamptz ELSE NULL END,
          error_code = ?, result_ref = ?,
          cancel_requested_at = CASE WHEN ? = 'cancelled' AND cancel_requested_at IS NULL
            THEN ? ELSE cancel_requested_at END,
          updated_at = pg_catalog.statement_timestamp()
          WHERE id = ? AND tenant_id = ? AND (workspace_id IS NOT DISTINCT FROM ?)`,
        [input.status, input.at, input.status, input.at, input.errorCode,
          input.resultRef, input.status, input.at,
          input.runId, input.tenantId, input.workspaceId],
      );
    },
    async requestRunCancellation(input) {
      runId(input.runId);
      uuid(input.tenantId);
      if (input.workspaceId !== null) uuid(input.workspaceId);
      timestamp(input.at);
      await runExpect(
        `UPDATE public.source_runs
          SET cancel_requested_at = ?, updated_at = pg_catalog.statement_timestamp()
          WHERE id = ? AND tenant_id = ? AND (workspace_id IS NOT DISTINCT FROM ?)
            AND status IN ('queued', 'running', 'paused', 'retry_wait')
            AND cancel_requested_at IS NULL`,
        [input.at, input.runId, input.tenantId, input.workspaceId],
      );
    },
    async findRunIdByIdempotencyKey(tenantId, workspaceId, key) {
      uuid(tenantId);
      if (workspaceId !== null) uuid(workspaceId);
      idempotencyKey(key);
      const found = await db.prepare(
        `SELECT id FROM public.source_runs
          WHERE tenant_id = ? AND (workspace_id IS NOT DISTINCT FROM ?) AND idempotency_key = ?`,
      ).get(tenantId, workspaceId, key);
      if (found === undefined) return null;
      const foundRow = found as Record<string, unknown>;
      return runId(foundRow.id);
    },
  };
  return Object.freeze(repository);
}
