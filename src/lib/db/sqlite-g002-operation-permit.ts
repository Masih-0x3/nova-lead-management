import { isProxy } from "node:util/types";

import {
  discardSqliteCompatibilityScopeAnchor,
  mintSqliteCompatibilityScopeAnchor,
  requireFreshSqliteCompatibilityScope,
  requireSqliteCompatibilityScope,
  type SqliteCompatibilityScopeAnchor,
  type SqliteCompatibilityBinding,
} from "./sqlite-compatibility-scope";

export type SqliteG002StorageLifecycle = "fresh" | "upgraded";

export type SqliteG002StorageOperation =
  | "user_market_access"
  | "crawl_runs"
  | "crawl_units";

export type SqliteG002StorageOperationPermitErrorCode =
  | "G006C2A_INPUT_REJECTED"
  | "G006C2A_STORAGE_SCOPE_MISMATCH"
  | "G006C2A_PERMIT_REQUIRED"
  | "G006C2A_PERMIT_MISMATCH";

export class SqliteG002StorageOperationPermitError extends Error {
  public readonly code: SqliteG002StorageOperationPermitErrorCode;
  public readonly detail: string;

  public constructor(code: SqliteG002StorageOperationPermitErrorCode, detail?: string) {
    super(detail ? `${code}: ${detail}` : code);
    this.name = "SqliteG002StorageOperationPermitError";
    this.code = code;
    this.detail = detail ?? "";
  }
}

declare const sqliteG002StorageOperationPermitBrand: unique symbol;

/**
 * Fieldless, one-shot proof of exact SQLite storage-operation scope.
 * It grants no actor, request, worker, scheduler, or provider authority.
 */
export interface SqliteG002StorageOperationPermit {
  readonly [sqliteG002StorageOperationPermitBrand]: "sqlite-g002-storage-operation-permit";
}

export interface SqliteG002StorageOperationPermitInput {
  readonly lifecycle: SqliteG002StorageLifecycle;
  readonly binding: SqliteCompatibilityBinding;
  readonly databasePath: string;
  readonly tenantId: string;
  readonly storageWorkspaceId: string;
  readonly operationWorkspaceId: string | null;
  readonly operation: SqliteG002StorageOperation;
}

export interface SqliteG002StorageOperationExpectation {
  readonly lifecycle: SqliteG002StorageLifecycle;
  readonly databasePath: string;
  readonly tenantId: string;
  readonly storageWorkspaceId: string;
  readonly operationWorkspaceId: string | null;
  readonly operation: SqliteG002StorageOperation;
}

export interface SqliteG002StorageOperationEvidence {
  readonly backend: "sqlite";
  readonly lifecycle: SqliteG002StorageLifecycle;
  readonly databasePath: string;
  readonly tenantId: string;
  readonly storageWorkspaceId: string;
  readonly operationWorkspaceId: string | null;
  readonly operation: SqliteG002StorageOperation;
  readonly authority: "storage-operation-scope-only";
  readonly grantsAuthentication: false;
  readonly grantsAuthorization: false;
  readonly grantsWorkerExecution: false;
  readonly grantsProviderExecution: false;
}

/** Deep-only C2A-to-C2B handoff. The anchor has no observable state. */
export interface SqliteG002StorageOperationWriterTransfer {
  readonly evidence: SqliteG002StorageOperationEvidence;
  readonly anchor: SqliteCompatibilityScopeAnchor;
}

type DataRecord = Readonly<Record<string, unknown>>;

interface PermitState {
  readonly evidence: SqliteG002StorageOperationEvidence;
  readonly anchor: SqliteCompatibilityScopeAnchor;
}

const permitStates = new WeakMap<object, PermitState>();

const INPUT_KEYS = Object.freeze([
  "lifecycle",
  "binding",
  "databasePath",
  "tenantId",
  "storageWorkspaceId",
  "operationWorkspaceId",
  "operation",
]);

const EXPECTATION_KEYS = Object.freeze([
  "lifecycle",
  "databasePath",
  "tenantId",
  "storageWorkspaceId",
  "operationWorkspaceId",
  "operation",
]);

function rejectInput(detail: string): never {
  throw new SqliteG002StorageOperationPermitError("G006C2A_INPUT_REJECTED", detail);
}

function readPlainDataRecord(value: unknown, label: string): DataRecord {
  if (value === null || typeof value !== "object" || isProxy(value)) {
    return rejectInput(`${label} must be a non-proxy plain record`);
  }
  if (Object.getPrototypeOf(value) !== Object.prototype) {
    return rejectInput(`${label} must have the plain object prototype`);
  }
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const record: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
  for (const key of Reflect.ownKeys(descriptors)) {
    if (typeof key !== "string") return rejectInput(`${label} contains a symbol key`);
    const descriptor = descriptors[key];
    if (!("value" in descriptor)) return rejectInput(`${label}.${key} must be a data property`);
    record[key] = descriptor.value;
  }
  return Object.freeze(record);
}

function requireExactKeys(record: DataRecord, expected: readonly string[], label: string): void {
  const actual = Object.keys(record).sort();
  const wanted = [...expected].sort();
  if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) {
    rejectInput(`${label} keys`);
  }
}

function requireString(record: DataRecord, key: string, label: string): string {
  const value = record[key];
  if (typeof value !== "string" || value.length === 0) rejectInput(`${label}.${key}`);
  return value;
}

function requireLifecycle(record: DataRecord, label: string): SqliteG002StorageLifecycle {
  const value = record.lifecycle;
  if (value !== "fresh" && value !== "upgraded") rejectInput(`${label}.lifecycle`);
  return value;
}

function requireOperation(record: DataRecord, label: string): SqliteG002StorageOperation {
  const value = record.operation;
  if (value !== "user_market_access" && value !== "crawl_runs" && value !== "crawl_units") {
    rejectInput(`${label}.operation`);
  }
  return value;
}

function requireOperationWorkspaceId(record: DataRecord, label: string): string | null {
  const value = record.operationWorkspaceId;
  if (value === null) return null;
  if (typeof value !== "string" || value.length === 0) {
    rejectInput(`${label}.operationWorkspaceId`);
  }
  return value;
}

function snapshotSelectors(
  record: DataRecord,
  label: string,
): SqliteG002StorageOperationExpectation {
  const lifecycle = requireLifecycle(record, label);
  const databasePath = requireString(record, "databasePath", label);
  const tenantId = requireString(record, "tenantId", label);
  const storageWorkspaceId = requireString(record, "storageWorkspaceId", label);
  const operationWorkspaceId = requireOperationWorkspaceId(record, label);
  const operation = requireOperation(record, label);
  if (operationWorkspaceId !== null && operationWorkspaceId !== storageWorkspaceId) {
    throw new SqliteG002StorageOperationPermitError(
      "G006C2A_STORAGE_SCOPE_MISMATCH",
      `${label}.operationWorkspaceId must equal ${label}.storageWorkspaceId when non-null`,
    );
  }
  return Object.freeze({
    lifecycle,
    databasePath,
    tenantId,
    storageWorkspaceId,
    operationWorkspaceId,
    operation,
  });
}

function storageEvidence(
  selectors: SqliteG002StorageOperationExpectation,
): SqliteG002StorageOperationEvidence {
  return Object.freeze({
    backend: "sqlite",
    lifecycle: selectors.lifecycle,
    databasePath: selectors.databasePath,
    tenantId: selectors.tenantId,
    storageWorkspaceId: selectors.storageWorkspaceId,
    operationWorkspaceId: selectors.operationWorkspaceId,
    operation: selectors.operation,
    authority: "storage-operation-scope-only",
    grantsAuthentication: false,
    grantsAuthorization: false,
    grantsWorkerExecution: false,
    grantsProviderExecution: false,
  });
}

/**
 * Narrows a genuine, previously verified lifecycle-corresponding C0/C1 binding
 * to one exact G002 storage operation. It does not reopen or read the database,
 * recheck current canonical file identity, schema, foundation or rows, hold a
 * lease, or prove current state or row existence at creation or consumption.
 * C2B/C must freshly open the exact bound database and atomically revalidate
 * canonical path/file identity as applicable, schema/foundation/tenant/workspace
 * facts, the exact run parent, and persisted location-mode/reference integrity
 * with exact SQL predicates before mutation. This permit remains non-authority,
 * never replaces G009/G010/G013 scope, and neither authorizes nor performs a
 * write.
 */
export function createSqliteG002StorageOperationPermit(
  inputValue: SqliteG002StorageOperationPermitInput,
): SqliteG002StorageOperationPermit {
  const input = readPlainDataRecord(inputValue, "input");
  requireExactKeys(input, INPUT_KEYS, "input");
  const selectors = snapshotSelectors(input, "input");

  let anchor: SqliteCompatibilityScopeAnchor | undefined;
  try {
    const expectation = {
      databasePath: selectors.databasePath,
      tenantId: selectors.tenantId,
      workspaceId: selectors.storageWorkspaceId,
    };
    if (selectors.lifecycle === "fresh") {
      requireFreshSqliteCompatibilityScope(input.binding as SqliteCompatibilityBinding, expectation);
    } else {
      requireSqliteCompatibilityScope(input.binding as SqliteCompatibilityBinding, expectation);
    }
    anchor = mintSqliteCompatibilityScopeAnchor(input.binding as SqliteCompatibilityBinding, expectation);
  } catch {
    if (anchor) discardSqliteCompatibilityScopeAnchor(anchor);
    throw new SqliteG002StorageOperationPermitError("G006C2A_STORAGE_SCOPE_MISMATCH");
  }
  if (!anchor) throw new SqliteG002StorageOperationPermitError("G006C2A_STORAGE_SCOPE_MISMATCH");

  const permit = Object.freeze(Object.create(null)) as SqliteG002StorageOperationPermit;
  try {
    permitStates.set(permit as object, Object.freeze({ evidence: storageEvidence(selectors), anchor }));
  } catch (error) {
    discardSqliteCompatibilityScopeAnchor(anchor);
    throw error;
  }
  return permit;
}

/**
 * Consumes a permit exactly once. Private state is deleted before expectation
 * validation, so success and every expectation failure are terminal outcomes.
 */
export function requireSqliteG002StorageOperationPermit(
  permit: SqliteG002StorageOperationPermit,
  expectationValue: SqliteG002StorageOperationExpectation,
): SqliteG002StorageOperationEvidence {
  if (permit === null || typeof permit !== "object" || isProxy(permit)) {
    throw new SqliteG002StorageOperationPermitError("G006C2A_PERMIT_REQUIRED");
  }
  const state = permitStates.get(permit as object);
  if (!state) throw new SqliteG002StorageOperationPermitError("G006C2A_PERMIT_REQUIRED");
  permitStates.delete(permit as object);
  try {
    assertExactPermitExpectation(state.evidence, expectationValue);
    return state.evidence;
  } finally {
    discardSqliteCompatibilityScopeAnchor(state.anchor);
  }
}

function assertExactPermitExpectation(
  evidence: SqliteG002StorageOperationEvidence,
  expectationValue: SqliteG002StorageOperationExpectation,
): void {
  const expectation = readPlainDataRecord(expectationValue, "expectation");
  requireExactKeys(expectation, EXPECTATION_KEYS, "expectation");
  const selectors = snapshotSelectors(expectation, "expectation");
  if (selectors.lifecycle !== evidence.lifecycle
      || selectors.databasePath !== evidence.databasePath
      || selectors.tenantId !== evidence.tenantId
      || selectors.storageWorkspaceId !== evidence.storageWorkspaceId
      || selectors.operationWorkspaceId !== evidence.operationWorkspaceId
      || selectors.operation !== evidence.operation) {
    throw new SqliteG002StorageOperationPermitError("G006C2A_PERMIT_MISMATCH");
  }
}

/**
 * Burns a permit before expectation parsing and transfers the opaque C0 anchor
 * only on an exact selector match. C2B owns terminal consume/discard in finally.
 */
export function transferSqliteG002StorageOperationPermitToWriter(
  permit: SqliteG002StorageOperationPermit,
  expectationValue: SqliteG002StorageOperationExpectation,
): SqliteG002StorageOperationWriterTransfer {
  if (permit === null || typeof permit !== "object" || isProxy(permit)) {
    throw new SqliteG002StorageOperationPermitError("G006C2A_PERMIT_REQUIRED");
  }
  const state = permitStates.get(permit as object);
  if (!state) throw new SqliteG002StorageOperationPermitError("G006C2A_PERMIT_REQUIRED");
  permitStates.delete(permit as object);
  try {
    assertExactPermitExpectation(state.evidence, expectationValue);
    return Object.freeze({ evidence: state.evidence, anchor: state.anchor });
  } catch (error) {
    discardSqliteCompatibilityScopeAnchor(state.anchor);
    throw error;
  }
}
