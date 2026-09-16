import { isProxy } from "node:util/types";

import {
  buildSuppressionRecord,
  isSuppressionDisposition,
  resolveEffectiveSuppression,
  suppressionAppliesTo,
  type SuppressionDisposition,
  type SuppressionRecord,
} from "@/lib/suppressions/suppression-record";
import type { SuppressionRepository } from "@/lib/suppressions/repository";

export type SuppressionServiceErrorCode =
  | "SUPPRESSION_INPUT_INVALID"
  | "SUPPRESSION_CONFLICT";

export class SuppressionServiceError extends Error {
  readonly code: SuppressionServiceErrorCode;

  constructor(code: SuppressionServiceErrorCode, message: string) {
    super(message);
    this.name = "SuppressionServiceError";
    this.code = code;
  }
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const SAFE_REF = /^[A-Za-z0-9][A-Za-z0-9:._/-]{0,254}$/u;

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

function invalid(message: string): SuppressionServiceError {
  return new SuppressionServiceError("SUPPRESSION_INPUT_INVALID", message);
}

function uuid(value: unknown, field: string): string {
  if (typeof value !== "string" || !UUID.test(value)) throw invalid(`${field} must be a UUID`);
  return value;
}

function nowIso(clock: (() => Date) | undefined): string {
  const observed = clock ? clock() : new Date();
  if (!(observed instanceof Date) || !Number.isFinite(observed.getTime())) {
    throw invalid("A valid clock is required");
  }
  return observed.toISOString();
}

export interface SuppressionAuditSink {
  record(event: Readonly<{
    action: string;
    entityType: string;
    entityId: string;
    metadata: Readonly<Record<string, unknown>>;
  }>): Promise<void>;
}

export interface SuppressionServiceDeps {
  readonly repository: SuppressionRepository;
  readonly audit?: SuppressionAuditSink;
  readonly clock?: () => Date;
}

export type RecordSuppressionInput = Readonly<{
  tenantId: string;
  workspaceId: string;
  accountId?: string | null;
  contactStableKey?: string | null;
  disposition: string;
  reason: string;
  source?: Readonly<{ kind?: string; outcomeVersionId?: string | null }>;
  actorId: string;
  occurredAt?: string;
  recordedAt?: string;
}>;

/**
 * Appends one protective suppression record. The record identity is content-
 * addressed so a repeated append of the same event replays idempotently.
 */
export async function recordSuppression(
  deps: SuppressionServiceDeps,
  rawInput: unknown,
): Promise<Readonly<{ record: SuppressionRecord; persisted: "created" | "replayed" }>> {
  if (!isPlainRecord(rawInput)) throw invalid("Expected a plain object");
  const tenantId = uuid(rawInput.tenantId, "tenantId");
  const workspaceId = uuid(rawInput.workspaceId, "workspaceId");
  const actorId = uuid(rawInput.actorId, "actorId");
  const accountId = rawInput.accountId === undefined || rawInput.accountId === null
    ? null : uuid(rawInput.accountId, "accountId");
  const contactStableKey = rawInput.contactStableKey === undefined || rawInput.contactStableKey === null
    ? null
    : typeof rawInput.contactStableKey === "string" && SAFE_REF.test(rawInput.contactStableKey)
      ? rawInput.contactStableKey : (() => { throw invalid("contactStableKey is malformed"); })();
  if (accountId === null && contactStableKey !== null) {
    throw invalid("contactStableKey requires an accountId scope");
  }
  const built = buildSuppressionRecord({
    version: 1,
    tenantId,
    workspaceId,
    accountId,
    contactStableKey,
    disposition: rawInput.disposition,
    reason: rawInput.reason,
    source: rawInput.source ?? { kind: "member_recorded", outcomeVersionId: null },
    actor: { kind: "human", actorId },
    occurredAt: rawInput.occurredAt ?? nowIso(deps.clock),
    recordedAt: rawInput.recordedAt ?? nowIso(deps.clock),
  });
  if (!built.ok) {
    throw new SuppressionServiceError(
      "SUPPRESSION_INPUT_INVALID", `The suppression record was rejected (${built.code}).`);
  }
  const persisted = await deps.repository.insertRecord(built.record);
  await deps.audit?.record({
    action: "suppression.recorded",
    entityType: "suppression_record",
    entityId: built.record.recordId,
    metadata: {
      accountId: built.record.accountId,
      contactStableKey: built.record.contactStableKey,
      disposition: built.record.disposition,
      sourceKind: built.record.source.kind,
    },
  });
  return Object.freeze({ record: built.record, persisted });
}

export type EffectiveSuppression = Readonly<{
  effectiveDisposition: SuppressionDisposition;
  blocking: boolean;
  dominantRecord: SuppressionRecord | null;
  recordCount: number;
}>;

/**
 * Resolves the effective suppression for a contact-use scope. The contact's
 * stored disposition merges with every applicable protective record under
 * D-012 most-restrictive precedence; `clear` never wins over a record.
 */
export async function resolveSuppression(
  deps: SuppressionServiceDeps,
  scope: Readonly<{
    tenantId: string;
    workspaceId: string;
    accountId: string;
    contactStableKey?: string | null;
    contactDisposition?: string;
  }>,
): Promise<EffectiveSuppression> {
  const tenantId = uuid(scope.tenantId, "tenantId");
  const workspaceId = uuid(scope.workspaceId, "workspaceId");
  const accountId = uuid(scope.accountId, "accountId");
  const contactStableKey = scope.contactStableKey === undefined || scope.contactStableKey === null
    ? null
    : typeof scope.contactStableKey === "string" && SAFE_REF.test(scope.contactStableKey)
      ? scope.contactStableKey : (() => { throw invalid("contactStableKey is malformed"); })();
  const base = scope.contactDisposition === undefined
    ? "clear" as const
    : isSuppressionDisposition(scope.contactDisposition)
      ? scope.contactDisposition
      : (() => { throw invalid("contactDisposition is malformed"); })();
  const rows = await deps.repository.listRecords(tenantId, workspaceId, {
    accountId,
    includeTenantScoped: true,
  });
  const applicable = rows.filter((row) =>
    suppressionAppliesTo(row.record, { accountId, contactStableKey }));
  const effective = resolveEffectiveSuppression(base, applicable.map((row) => row.record));
  const dominant = applicable.find((row) => row.record.disposition === effective)?.record ?? null;
  return Object.freeze({
    effectiveDisposition: effective,
    blocking: effective !== "clear",
    dominantRecord: dominant,
    recordCount: applicable.length,
  });
}

export type SuppressionView = Readonly<{
  recordId: string;
  accountId: string | null;
  contactStableKey: string | null;
  disposition: SuppressionDisposition;
  reason: string;
  sourceKind: string;
  outcomeVersionId: string | null;
  actorId: string;
  occurredAt: string;
  recordedAt: string;
}>;

export async function listSuppressionViews(
  deps: SuppressionServiceDeps,
  scope: Readonly<{
    tenantId: string;
    workspaceId: string;
    accountId?: string;
    contactStableKey?: string;
  }>,
): Promise<readonly SuppressionView[]> {
  const tenantId = uuid(scope.tenantId, "tenantId");
  const workspaceId = uuid(scope.workspaceId, "workspaceId");
  const accountId = scope.accountId === undefined ? undefined : uuid(scope.accountId, "accountId");
  const contactStableKey = scope.contactStableKey === undefined
    ? undefined
    : typeof scope.contactStableKey === "string" && SAFE_REF.test(scope.contactStableKey)
      ? scope.contactStableKey : (() => { throw invalid("contactStableKey is malformed"); })();
  const rows = await deps.repository.listRecords(tenantId, workspaceId, {
    accountId, contactStableKey, includeTenantScoped: accountId === undefined,
  });
  return Object.freeze(rows.map((row): SuppressionView => Object.freeze({
    recordId: row.record.recordId,
    accountId: row.record.accountId,
    contactStableKey: row.record.contactStableKey,
    disposition: row.record.disposition,
    reason: row.record.reason,
    sourceKind: row.record.source.kind,
    outcomeVersionId: row.record.source.outcomeVersionId,
    actorId: row.record.actor.actorId,
    occurredAt: row.record.occurredAt,
    recordedAt: row.record.recordedAt,
  })));
}
