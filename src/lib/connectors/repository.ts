import { isProxy } from "node:util/types";

import type { DbClient } from "@/lib/db";

import type {
  ConnectorAccountReference,
  ConnectorRegistryVersionRecord,
  ConnectorSourcePolicyDecision,
} from "./source-policy-registry";
import { evaluateConnectorSourcePolicy } from "./source-policy-registry";
import type {
  ConnectorCurrentSourcePolicyActivationRecord,
  ConnectorSourcePolicyAuthorityRecord,
  ConnectorSourceRunAuthorityRecord,
  ConnectorSourceRunAuthoritySelector,
  ConnectorSourceRunAuthoritySnapshot,
  ConnectorSourceRunUnitAuthorityRecord,
} from "./source-run-authority";

export class ConnectorPersistenceError extends Error {
  readonly code = "CONNECTOR_PERSISTENCE" as const;

  constructor() {
    super("The connector authority state could not be loaded or persisted safely.");
    this.name = "ConnectorPersistenceError";
  }
}

function fail(): never {
  throw new ConnectorPersistenceError();
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const RUN_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/u;
const SHA256 = /^[0-9a-f]{64}$/u;
const TOKEN = /^[a-z0-9][a-z0-9._:-]{0,159}$/u;
const ACCOUNT_STATUSES = new Set(["disabled", "fixture_only", "ready", "suspended", "revoked"]);
const POLICY_STATES = new Set(["draft", "active", "superseded", "revoked"]);
const TERMS_STATES = new Set(["approved", "pending", "missing", "expired", "revoked"]);
const RUN_STATUSES = new Set([
  "queued", "running", "paused", "retry_wait", "completed", "failed", "cancelled", "blocked", "killed",
]);
const UNIT_STATUSES = new Set([
  "queued", "running", "paused", "retry_wait", "page_complete", "completed", "cancelled", "blocked", "failed",
]);

function row(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || isProxy(value) || Array.isArray(value)) fail();
  try {
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) fail();
    const descriptors = Object.getOwnPropertyDescriptors(value);
    const out: Record<string, unknown> = {};
    for (const key of Reflect.ownKeys(descriptors)) {
      if (typeof key !== "string") fail();
      const descriptor = descriptors[key];
      if (!descriptor || !("value" in descriptor) || !descriptor.enumerable) fail();
      out[key] = descriptor.value;
    }
    return out;
  } catch {
    fail();
  }
}

function uuid(value: unknown): string {
  if (typeof value !== "string" || !UUID.test(value)) fail();
  return value;
}

function nullableUuid(value: unknown): string | null {
  if (value === null) return null;
  return uuid(value);
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

function nullableSha(value: unknown): string | null {
  if (value === null) return null;
  return sha(value);
}

function intValue(value: unknown): number {
  const normalized = typeof value === "string" && /^[0-9]+$/u.test(value) ? Number(value) : value;
  if (typeof normalized !== "number" || !Number.isSafeInteger(normalized) || normalized < 0) fail();
  return normalized;
}

function unitsValue(value: unknown): number {
  const normalized = typeof value === "string" && /^[0-9]+(\.[0-9]+)?$/u.test(value) ? Number(value) : value;
  if (typeof normalized !== "number" || !Number.isFinite(normalized) || normalized < 0) fail();
  return normalized;
}

function boolValue(value: unknown): boolean {
  if (value === true || value === false) return value;
  if (value === 0 || value === 1) return value === 1;
  fail();
}

function timestamp(value: unknown): string {
  if (value instanceof Date) {
    const iso = value.toISOString();
    if (Number.isFinite(value.getTime())) return iso;
    fail();
  }
  if (typeof value !== "string") fail();
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) fail();
  return new Date(parsed).toISOString();
}

function nullableTimestamp(value: unknown): string | null {
  if (value === null) return null;
  return timestamp(value);
}

function stringList(value: unknown): readonly string[] {
  if (!Array.isArray(value) || isProxy(value)) fail();
  const out: string[] = [];
  for (const item of value) {
    if (typeof item !== "string" || item.length === 0 || item.length > 300) fail();
    out.push(item);
  }
  return Object.freeze(out);
}

function parseRegistryVersion(value: unknown): ConnectorRegistryVersionRecord {
  const r = row(value);
  const executionMode = r.execution_mode;
  const transport = r.transport;
  if (executionMode !== "fixture" && executionMode !== "live") fail();
  if (transport !== "none" && transport !== "network") fail();
  return Object.freeze({
    sourceCardId: token(r.source_card_id),
    version: intValue(r.version),
    executionMode,
    transport,
    operations: stringList(r.operations),
    outputFields: stringList(r.output_fields),
    adapterSha256: sha(r.adapter_sha256),
  });
}

function parseAccount(value: unknown): ConnectorAccountReference {
  const r = row(value);
  const status = r.status;
  if (typeof status !== "string" || !ACCOUNT_STATUSES.has(status)) fail();
  return Object.freeze({
    id: runId(r.id),
    tenantId: uuid(r.tenant_id),
    workspaceId: nullableUuid(r.workspace_id),
    sourceCardId: token(r.source_card_id),
    connectorVersion: intValue(r.connector_version),
    status: status as ConnectorAccountReference["status"],
    credentialRefHash: nullableSha(r.credential_ref_hash),
  });
}

function parsePolicy(value: unknown): ConnectorSourcePolicyAuthorityRecord {
  const r = row(value);
  const state = r.state;
  const termsState = r.terms_state;
  const executionMode = r.execution_mode;
  if (typeof state !== "string" || !POLICY_STATES.has(state)) fail();
  if (typeof termsState !== "string" || !TERMS_STATES.has(termsState)) fail();
  if (executionMode !== "fixture" && executionMode !== "live") fail();
  return Object.freeze({
    id: runId(r.id),
    tenantId: uuid(r.tenant_id),
    workspaceId: nullableUuid(r.workspace_id),
    sourceCardId: token(r.source_card_id),
    connectorVersion: intValue(r.connector_version),
    connectorAccountId: runId(r.connector_account_id),
    version: intValue(r.version),
    state: state as ConnectorSourcePolicyAuthorityRecord["state"],
    executionMode,
    termsState: termsState as ConnectorSourcePolicyAuthorityRecord["termsState"],
    allowedOperations: stringList(r.allowed_operations),
    allowedFields: stringList(r.allowed_fields),
    hardCapUnits: unitsValue(r.hard_cap_units),
    attestationExpiresAt: nullableTimestamp(r.attestation_expires_at),
    attestationRevoked: boolValue(r.attestation_revoked),
    policySha256: sha(r.policy_sha256),
    policyKey: token(r.policy_key),
  });
}

function parseActivation(value: unknown): ConnectorCurrentSourcePolicyActivationRecord {
  const r = row(value);
  return Object.freeze({
    id: runId(r.id),
    tenantId: uuid(r.tenant_id),
    workspaceId: nullableUuid(r.workspace_id),
    policyKey: token(r.policy_key),
    policyVersion: intValue(r.policy_version),
    sourcePolicyId: runId(r.source_policy_id),
    activatedAt: timestamp(r.activated_at),
    revokedAt: nullableTimestamp(r.revoked_at),
  });
}

function parseRun(value: unknown): ConnectorSourceRunAuthorityRecord {
  const r = row(value);
  const status = r.status;
  if (typeof status !== "string" || !RUN_STATUSES.has(status)) fail();
  return Object.freeze({
    id: runId(r.id),
    tenantId: uuid(r.tenant_id),
    workspaceId: nullableUuid(r.workspace_id),
    sourceCardId: token(r.source_card_id),
    connectorVersion: intValue(r.connector_version),
    connectorAccountId: runId(r.connector_account_id),
    sourcePolicyId: runId(r.source_policy_id),
    inputHash: sha(r.input_hash),
    operation: runId(r.operation),
    status: status as ConnectorSourceRunAuthorityRecord["status"],
    hardCapUnits: unitsValue(r.hard_cap_units),
    maxAttempts: intValue(r.max_attempts),
    cancelRequestedAt: nullableTimestamp(r.cancel_requested_at),
  });
}

function parseUnit(value: unknown): ConnectorSourceRunUnitAuthorityRecord {
  const r = row(value);
  const status = r.status;
  if (typeof status !== "string" || !UNIT_STATUSES.has(status)) fail();
  const cursor = r.cursor;
  if (cursor !== null && (typeof cursor !== "string" || cursor.length === 0 || cursor.length > 4096)) fail();
  return Object.freeze({
    id: runId(r.id),
    tenantId: uuid(r.tenant_id),
    workspaceId: nullableUuid(r.workspace_id),
    runId: runId(r.run_id),
    checkpointKey: typeof r.checkpoint_key === "string" && r.checkpoint_key.length >= 1
      && r.checkpoint_key.length <= 512 ? r.checkpoint_key : fail(),
    inputHash: sha(r.input_hash),
    cursor,
    sequence: intValue(r.sequence),
    status: status as ConnectorSourceRunUnitAuthorityRecord["status"],
    attemptCount: intValue(r.attempt_count),
    maxAttempts: intValue(r.max_attempts),
    reservedUnits: unitsValue(r.reserved_units),
    leaseGeneration: intValue(r.lease_generation),
    leaseTokenHash: nullableSha(r.lease_token_hash),
    leaseWorkerHash: nullableSha(r.lease_worker_hash),
    leaseExpiresAt: nullableTimestamp(r.lease_expires_at),
  });
}

export interface ConnectorAuthorityRepository {
  loadRunAuthority(
    selector: ConnectorSourceRunAuthoritySelector,
  ): Promise<ConnectorSourceRunAuthoritySnapshot | null>;
  listRegistryVersions(): Promise<readonly ConnectorRegistryVersionRecord[]>;
  listAccounts(
    tenantId: string,
    workspaceId: string | null,
  ): Promise<readonly ConnectorAccountReference[]>;
  listPolicies(
    tenantId: string,
    workspaceId: string | null,
  ): Promise<readonly ConnectorSourcePolicyAuthorityRecord[]>;
  listActivations(
    tenantId: string,
    workspaceId: string | null,
  ): Promise<readonly ConnectorCurrentSourcePolicyActivationRecord[]>;
  listRuns(
    tenantId: string,
    workspaceId: string | null,
  ): Promise<readonly ConnectorSourceRunAuthorityRecord[]>;
  listUnits(
    tenantId: string,
    workspaceId: string | null,
    runId: string,
  ): Promise<readonly ConnectorSourceRunUnitAuthorityRecord[]>;
  listRunnableUnits(
    tenantId: string,
    workspaceId: string | null,
    at: string,
  ): Promise<readonly Readonly<{ runId: string; unitId: string }>[]>;
  runCommittedUnits(
    tenantId: string,
    workspaceId: string | null,
    runId: string,
  ): Promise<number>;
  evaluateRunDecision(
    selector: ConnectorSourceRunAuthoritySelector,
    input: Readonly<{ operation: string; fields: readonly string[]; requestedUnits: number; now: string }>,
  ): Promise<ConnectorSourcePolicyDecision | null>;
}

const AUTHORITY_QUERY = `SELECT
  rv.source_card_id AS rv_source_card_id, rv.version AS rv_version,
  rv.execution_mode AS rv_execution_mode, rv.transport AS rv_transport,
  rv.operations AS rv_operations, rv.output_fields AS rv_output_fields,
  rv.adapter_sha256 AS rv_adapter_sha256,
  a.id AS a_id, a.tenant_id AS a_tenant_id, a.workspace_id AS a_workspace_id,
  a.source_card_id AS a_source_card_id, a.connector_version AS a_connector_version,
  a.status AS a_status, a.credential_ref_hash AS a_credential_ref_hash,
  p.id AS p_id, p.tenant_id AS p_tenant_id, p.workspace_id AS p_workspace_id,
  p.source_card_id AS p_source_card_id, p.connector_version AS p_connector_version,
  p.connector_account_id AS p_connector_account_id, p.version AS p_version,
  p.state AS p_state, p.execution_mode AS p_execution_mode, p.terms_state AS p_terms_state,
  p.allowed_operations AS p_allowed_operations, p.allowed_fields AS p_allowed_fields,
  p.hard_cap_units AS p_hard_cap_units, p.attestation_expires_at AS p_attestation_expires_at,
  p.attestation_revoked AS p_attestation_revoked, p.policy_sha256 AS p_policy_sha256,
  p.policy_key AS p_policy_key,
  act.id AS act_id, act.tenant_id AS act_tenant_id, act.workspace_id AS act_workspace_id,
  act.policy_key AS act_policy_key, act.policy_version AS act_policy_version,
  act.source_policy_id AS act_source_policy_id, act.activated_at AS act_activated_at,
  act.revoked_at AS act_revoked_at,
  r.id AS r_id, r.tenant_id AS r_tenant_id, r.workspace_id AS r_workspace_id,
  r.source_card_id AS r_source_card_id, r.connector_version AS r_connector_version,
  r.connector_account_id AS r_connector_account_id, r.source_policy_id AS r_source_policy_id,
  r.input_hash AS r_input_hash, r.operation AS r_operation, r.status AS r_status,
  r.hard_cap_units AS r_hard_cap_units, r.max_attempts AS r_max_attempts,
  r.cancel_requested_at AS r_cancel_requested_at,
  u.id AS u_id, u.tenant_id AS u_tenant_id, u.workspace_id AS u_workspace_id,
  u.run_id AS u_run_id, u.checkpoint_key AS u_checkpoint_key, u.input_hash AS u_input_hash,
  u.cursor AS u_cursor, u.sequence AS u_sequence, u.status AS u_status,
  u.attempt_count AS u_attempt_count,
  u.max_attempts AS u_max_attempts, u.reserved_units AS u_reserved_units,
  u.lease_generation AS u_lease_generation, u.lease_token_hash AS u_lease_token_hash,
  u.lease_worker_hash AS u_lease_worker_hash, u.lease_expires_at AS u_lease_expires_at
  FROM public.source_runs r
  JOIN public.source_run_units u
    ON u.run_id = r.id AND u.id = ? AND u.tenant_id = r.tenant_id
    AND (u.workspace_id IS NOT DISTINCT FROM r.workspace_id)
  JOIN public.connector_accounts a ON a.id = r.connector_account_id
  JOIN public.source_policy_versions p ON p.id = r.source_policy_id
  JOIN public.connector_versions rv
    ON rv.source_card_id = r.source_card_id AND rv.version = r.connector_version
  JOIN public.current_source_policy_activations act
    ON act.tenant_id = p.tenant_id
    AND (act.workspace_id IS NOT DISTINCT FROM p.workspace_id)
    AND act.policy_key = p.policy_key AND act.policy_version = p.version
    AND act.source_policy_id = p.id
  WHERE r.id = ? AND r.tenant_id = ?
    AND (r.workspace_id IS NOT DISTINCT FROM ?)
  LIMIT 1`;

function prefixed(value: Record<string, unknown>, prefix: string): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) {
    if (key.startsWith(prefix)) out[key.slice(prefix.length)] = item;
  }
  return out;
}

export function createPostgresConnectorAuthorityRepository(db: DbClient): ConnectorAuthorityRepository {
  if (!db || typeof db.prepare !== "function") throw new TypeError("A database client is required");
  const repository: ConnectorAuthorityRepository = {
    async loadRunAuthority(selector) {
      const rows = await db.prepare(AUTHORITY_QUERY).all(
        selector.unitId, selector.runId, selector.authorizedTenantId, selector.authorizedWorkspaceId,
      );
      if (!Array.isArray(rows) || isProxy(rows)) fail();
      if (rows.length === 0) return null;
      if (rows.length !== 1) fail();
      const combined = row(rows[0]);
      return Object.freeze({
        registryVersion: parseRegistryVersion(prefixed(combined, "rv_")),
        account: parseAccount(prefixed(combined, "a_")),
        policy: parsePolicy(prefixed(combined, "p_")),
        activation: parseActivation(prefixed(combined, "act_")),
        run: parseRun(prefixed(combined, "r_")),
        unit: parseUnit(prefixed(combined, "u_")),
      });
    },
    async listRegistryVersions() {
      const rows = await db.prepare(
        `SELECT source_card_id, version, execution_mode, transport, operations, output_fields,
          adapter_sha256 FROM public.connector_versions ORDER BY source_card_id, version DESC`,
      ).all();
      if (!Array.isArray(rows) || isProxy(rows)) fail();
      return Object.freeze(rows.map((entry) => parseRegistryVersion(entry)));
    },
    async listAccounts(tenantId, workspaceId) {
      const rows = await db.prepare(
        `SELECT id, tenant_id, workspace_id, source_card_id, connector_version, status,
          credential_ref_hash FROM public.connector_accounts
          WHERE tenant_id = ? AND (workspace_id IS NOT DISTINCT FROM ?)
          ORDER BY source_card_id, connector_version`,
      ).all(tenantId, workspaceId);
      if (!Array.isArray(rows) || isProxy(rows)) fail();
      return Object.freeze(rows.map((entry) => parseAccount(entry)));
    },
    async listPolicies(tenantId, workspaceId) {
      const rows = await db.prepare(
        `SELECT id, tenant_id, workspace_id, source_card_id, connector_version,
          connector_account_id, version, state, execution_mode, terms_state,
          allowed_operations, allowed_fields, hard_cap_units, attestation_expires_at,
          attestation_revoked, policy_sha256, policy_key
          FROM public.source_policy_versions
          WHERE tenant_id = ? AND (workspace_id IS NOT DISTINCT FROM ?)
          ORDER BY source_card_id, policy_key, version DESC`,
      ).all(tenantId, workspaceId);
      if (!Array.isArray(rows) || isProxy(rows)) fail();
      return Object.freeze(rows.map((entry) => parsePolicy(entry)));
    },
    async listActivations(tenantId, workspaceId) {
      const rows = await db.prepare(
        `SELECT id, tenant_id, workspace_id, policy_key, policy_version, source_policy_id,
          activated_at, revoked_at FROM public.current_source_policy_activations
          WHERE tenant_id = ? AND (workspace_id IS NOT DISTINCT FROM ?)
          ORDER BY policy_key, policy_version DESC`,
      ).all(tenantId, workspaceId);
      if (!Array.isArray(rows) || isProxy(rows)) fail();
      return Object.freeze(rows.map((entry) => parseActivation(entry)));
    },
    async listRuns(tenantId, workspaceId) {
      const rows = await db.prepare(
        `SELECT id, tenant_id, workspace_id, source_card_id, connector_version,
          connector_account_id, source_policy_id, input_hash, operation, status,
          hard_cap_units, max_attempts, cancel_requested_at
          FROM public.source_runs
          WHERE tenant_id = ? AND (workspace_id IS NOT DISTINCT FROM ?)
          ORDER BY created_at DESC, id LIMIT 200`,
      ).all(tenantId, workspaceId);
      if (!Array.isArray(rows) || isProxy(rows)) fail();
      return Object.freeze(rows.map((entry) => parseRun(entry)));
    },
    async listUnits(tenantId, workspaceId, requestedRunId) {
      const rows = await db.prepare(
        `SELECT id, tenant_id, workspace_id, run_id, checkpoint_key, input_hash, cursor, sequence,
          status, attempt_count, max_attempts, reserved_units, lease_generation, lease_token_hash,
          lease_worker_hash, lease_expires_at
          FROM public.source_run_units
          WHERE tenant_id = ? AND (workspace_id IS NOT DISTINCT FROM ?) AND run_id = ?
          ORDER BY sequence`,
      ).all(tenantId, workspaceId, requestedRunId);
      if (!Array.isArray(rows) || isProxy(rows)) fail();
      return Object.freeze(rows.map((entry) => parseUnit(entry)));
    },
    async listRunnableUnits(tenantId, workspaceId, at) {
      const rows = await db.prepare(
        `SELECT u.run_id, u.id
          FROM public.source_run_units u
          JOIN public.source_runs r
            ON r.id = u.run_id AND r.tenant_id = u.tenant_id
            AND (r.workspace_id IS NOT DISTINCT FROM u.workspace_id)
          WHERE u.tenant_id = ? AND (u.workspace_id IS NOT DISTINCT FROM ?)
            AND r.cancel_requested_at IS NULL
            AND r.status IN ('queued', 'running', 'paused', 'retry_wait')
            AND (u.status = 'queued'
              OR (u.status = 'retry_wait' AND u.next_attempt_at <= ?)
              OR (u.status = 'running' AND u.lease_expires_at < ?))
          ORDER BY u.run_id, u.sequence
          LIMIT 1`,
      ).all(tenantId, workspaceId, at, at);
      if (!Array.isArray(rows) || isProxy(rows)) fail();
      return Object.freeze(rows.map((entry) => {
        const record = row(entry);
        return Object.freeze({ runId: token(record.run_id), unitId: token(record.id) });
      }));
    },
    async runCommittedUnits(tenantId, workspaceId, requestedRunId) {
      const found = await db.prepare(
        `SELECT COALESCE(pg_catalog.sum(
            CASE WHEN s.id IS NULL THEN r.reserved_units ELSE s.actual_units END
          ), 0::numeric) AS committed
          FROM public.source_usage_reservations r
          LEFT JOIN public.source_usage_settlements s ON s.reservation_id = r.id
          WHERE r.run_id = ? AND r.tenant_id = ?
            AND (r.workspace_id IS NOT DISTINCT FROM ?)`,
      ).get(requestedRunId, tenantId, workspaceId);
      if (found === undefined || isProxy(found)) fail();
      return unitsValue(row(found).committed);
    },
    async evaluateRunDecision(selector, input) {
      const snapshot = await this.loadRunAuthority(selector);
      if (!snapshot) return null;
      return evaluateConnectorSourcePolicy({
        tenantId: snapshot.run.tenantId,
        workspaceId: snapshot.run.workspaceId,
        authorizedTenantId: selector.authorizedTenantId,
        authorizedWorkspaceId: selector.authorizedWorkspaceId,
        sourceCardId: snapshot.run.sourceCardId,
        connectorVersion: snapshot.run.connectorVersion,
        connectorAccountId: snapshot.run.connectorAccountId,
        sourcePolicyId: snapshot.run.sourcePolicyId,
        executionMode: snapshot.policy.executionMode,
        operation: input.operation,
        fields: input.fields,
        requestedUnits: input.requestedUnits,
        now: input.now,
        registryVersion: snapshot.registryVersion,
        account: snapshot.account,
        policy: snapshot.policy,
      });
    },
  };
  return Object.freeze(repository);
}
