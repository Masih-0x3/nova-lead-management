import { createHash } from "node:crypto";
import { isProxy } from "node:util/types";

export const SUPPRESSION_RECORD_SCHEMA_VERSION = 1 as const;

export type SuppressionDisposition =
  | "clear"
  | "opt_out"
  | "do_not_contact"
  | "complaint"
  | "hard_bounce"
  | "soft_bounce"
  | "deletion_pending"
  | "deleted_tombstone"
  | "source_prohibited"
  | "conflicted"
  | "unknown";

/** D-012 §7 most-restrictive ordering; only `clear` may pass a gate. */
export const SUPPRESSION_PRECEDENCE: readonly SuppressionDisposition[] = Object.freeze([
  "hard_bounce",
  "deleted_tombstone",
  "deletion_pending",
  "do_not_contact",
  "complaint",
  "opt_out",
  "source_prohibited",
  "conflicted",
  "unknown",
  "soft_bounce",
  "clear",
]);

const DISPOSITIONS = new Set<SuppressionDisposition>(SUPPRESSION_PRECEDENCE);
const PROTECTIVE_DISPOSITIONS = new Set<SuppressionDisposition>(
  SUPPRESSION_PRECEDENCE.filter((disposition) => disposition !== "clear"));

export type SuppressionScope = Readonly<{
  tenantId: string;
  workspaceId: string;
  accountId: string | null;
  contactStableKey: string | null;
}>;

export type SuppressionSource = Readonly<{
  kind: "member_recorded" | "outcome_derived";
  outcomeVersionId: string | null;
}>;

export type SuppressionRecord = SuppressionScope & Readonly<{
  recordVersion: typeof SUPPRESSION_RECORD_SCHEMA_VERSION;
  recordId: string;
  disposition: SuppressionDisposition;
  reason: string;
  source: SuppressionSource;
  actor: Readonly<{ kind: "human"; actorId: string }>;
  occurredAt: string;
  recordedAt: string;
  recordHash: string;
}>;

export type SuppressionFailureCode =
  | "MALFORMED_INPUT"
  | "SCOPE_MISMATCH"
  | "INVALID_CHRONOLOGY"
  | "HUMAN_ACTOR_REQUIRED";

export type SuppressionRecordResult = Readonly<
  | { ok: true; code: "SUPPRESSION_RECORDED"; record: SuppressionRecord }
  | { ok: false; code: SuppressionFailureCode }
>;

type PlainRecord = Record<string, unknown>;

const INPUT_FIELDS = [
  "version", "tenantId", "workspaceId", "accountId", "contactStableKey", "disposition",
  "reason", "source", "actor", "occurredAt", "recordedAt",
] as const;
const SOURCE_FIELDS = ["kind", "outcomeVersionId"] as const;
const ACTOR_FIELDS = ["kind", "actorId"] as const;
const RECORD_FIELDS = [
  "recordVersion", "recordId", "tenantId", "workspaceId", "accountId", "contactStableKey",
  "disposition", "reason", "source", "actor", "occurredAt", "recordedAt", "recordHash",
] as const;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const SAFE_REF = /^[A-Za-z0-9][A-Za-z0-9:._/-]{0,254}$/u;
const OUTCOME_VERSION = /^outcome-version:[0-9a-f]{64}$/u;

function inspectRecord(value: unknown): PlainRecord | null {
  if (typeof value !== "object" || value === null || Array.isArray(value) || isProxy(value)) return null;
  try {
    if (Object.getPrototypeOf(value) !== Object.prototype) return null;
    const output: PlainRecord = {};
    for (const key of Reflect.ownKeys(value)) {
      if (typeof key !== "string") return null;
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor || !("value" in descriptor) || !descriptor.enumerable) return null;
      output[key] = descriptor.value;
    }
    return output;
  } catch {
    return null;
  }
}

function exactRecord(value: unknown, fields: readonly string[]): PlainRecord | null {
  const record = inspectRecord(value);
  if (!record) return null;
  const keys = Object.keys(record);
  return keys.length === fields.length && keys.every((key) => fields.includes(key)) ? record : null;
}

function sha256(value: unknown): string {
  return `sha256:${createHash("sha256").update(JSON.stringify(value), "utf8").digest("hex")}`;
}

function timestamp(value: unknown): string | null {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(value)) return null;
  const epoch = Date.parse(value);
  return Number.isFinite(epoch) && new Date(epoch).toISOString() === value ? value : null;
}

function safeRef(value: unknown): string | null {
  return typeof value === "string" && SAFE_REF.test(value) && value === value.trim() ? value : null;
}

function boundedText(value: unknown, maximum: number): string | null {
  return typeof value === "string" && value.length > 0 && value.length <= maximum
    && value === value.trim()
    && !/[\u0000-\u001f\u007f-\u009f\p{Default_Ignorable_Code_Point}]/u.test(value) ? value : null;
}

function failure(code: SuppressionFailureCode): SuppressionRecordResult {
  return Object.freeze({ ok: false, code });
}

export function isSuppressionDisposition(value: unknown): value is SuppressionDisposition {
  return typeof value === "string" && DISPOSITIONS.has(value as SuppressionDisposition);
}

/** Protective records may never carry `clear`; protective state dominates. */
export function isProtectiveDisposition(value: unknown): value is SuppressionDisposition {
  return typeof value === "string" && PROTECTIVE_DISPOSITIONS.has(value as SuppressionDisposition);
}

export function suppressionRank(disposition: SuppressionDisposition): number {
  return SUPPRESSION_PRECEDENCE.indexOf(disposition);
}

/** Most-restrictive effective disposition across a base value plus records. */
export function resolveEffectiveSuppression(
  base: SuppressionDisposition,
  records: readonly Readonly<{ disposition: SuppressionDisposition }>[],
): SuppressionDisposition {
  let effective = base;
  for (const record of records) {
    if (suppressionRank(record.disposition) < suppressionRank(effective)) {
      effective = record.disposition;
    }
  }
  return effective;
}

/** True when the record applies to the requested contact resolution scope. */
export function suppressionAppliesTo(
  record: SuppressionScope,
  scope: Readonly<{ accountId: string; contactStableKey: string | null }>,
): boolean {
  if (record.accountId === null) return true;
  if (record.accountId !== scope.accountId) return false;
  return record.contactStableKey === null || record.contactStableKey === scope.contactStableKey;
}

export function parseSuppressionRecord(value: unknown): SuppressionRecord | null {
  const record = exactRecord(value, RECORD_FIELDS);
  if (!record || record.recordVersion !== SUPPRESSION_RECORD_SCHEMA_VERSION) return null;
  const tenantId = typeof record.tenantId === "string" && UUID.test(record.tenantId) ? record.tenantId : null;
  const workspaceId = typeof record.workspaceId === "string" && UUID.test(record.workspaceId)
    ? record.workspaceId : null;
  const accountId = record.accountId === null ? null
    : typeof record.accountId === "string" && UUID.test(record.accountId) ? record.accountId : undefined;
  const contactStableKey = record.contactStableKey === null ? null : safeRef(record.contactStableKey);
  const disposition = record.disposition;
  const reason = boundedText(record.reason, 2_000);
  const source = exactRecord(record.source, SOURCE_FIELDS);
  const actor = exactRecord(record.actor, ACTOR_FIELDS);
  const actorId = actor && typeof actor.actorId === "string" && UUID.test(actor.actorId)
    ? actor.actorId : null;
  const occurredAt = timestamp(record.occurredAt);
  const recordedAt = timestamp(record.recordedAt);
  if (!tenantId || !workspaceId || accountId === undefined || contactStableKey === undefined
    || !isProtectiveDisposition(disposition) || !reason || !source || !actor
    || actor.kind !== "human" || !actorId || !occurredAt || !recordedAt
    || Date.parse(occurredAt) > Date.parse(recordedAt)) return null;
  const outcomeVersionId = source.outcomeVersionId === null ? null
    : typeof source.outcomeVersionId === "string" && OUTCOME_VERSION.test(source.outcomeVersionId)
      ? source.outcomeVersionId : undefined;
  if (outcomeVersionId === undefined
    || (source.kind === "outcome_derived" && outcomeVersionId === null)
    || (source.kind === "member_recorded" && outcomeVersionId !== null)) return null;
  const payload = Object.freeze({
    recordVersion: SUPPRESSION_RECORD_SCHEMA_VERSION,
    tenantId,
    workspaceId,
    accountId,
    contactStableKey,
    disposition,
    reason,
    source: Object.freeze({ kind: source.kind as SuppressionSource["kind"], outcomeVersionId }),
    actor: Object.freeze({ kind: "human" as const, actorId }),
    occurredAt,
    recordedAt,
  });
  const recordHash = sha256(payload);
  const recordId = `suppression-record:${recordHash.slice("sha256:".length)}`;
  if (record.recordId !== recordId || record.recordHash !== recordHash) return null;
  return Object.freeze({ ...payload, recordId, recordHash });
}

/** Builds one append-only protective record; callers own scope auth and persistence. */
export function buildSuppressionRecord(input: unknown): SuppressionRecordResult {
  try {
    const record = exactRecord(input, INPUT_FIELDS);
    if (!record || record.version !== SUPPRESSION_RECORD_SCHEMA_VERSION) return failure("MALFORMED_INPUT");
    const tenantId = typeof record.tenantId === "string" && UUID.test(record.tenantId)
      ? record.tenantId : null;
    const workspaceId = typeof record.workspaceId === "string" && UUID.test(record.workspaceId)
      ? record.workspaceId : null;
    const accountId = record.accountId === null ? null
      : typeof record.accountId === "string" && UUID.test(record.accountId) ? record.accountId : undefined;
    const contactStableKey = record.contactStableKey === null || record.contactStableKey === undefined
      ? null : safeRef(record.contactStableKey);
    const disposition = record.disposition;
    const reason = boundedText(record.reason, 2_000);
    const source = exactRecord(record.source, SOURCE_FIELDS);
    const actor = exactRecord(record.actor, ACTOR_FIELDS);
    const actorId = actor && typeof actor.actorId === "string" && UUID.test(actor.actorId)
      ? actor.actorId : null;
    const occurredAt = timestamp(record.occurredAt);
    const recordedAt = timestamp(record.recordedAt);
    if (!tenantId || !workspaceId || accountId === undefined || contactStableKey === undefined
      || typeof disposition !== "string" || !reason || !source || !actor || !occurredAt || !recordedAt) {
      return failure("MALFORMED_INPUT");
    }
    if (actor.kind !== "human" || !actorId) return failure("HUMAN_ACTOR_REQUIRED");
    if (!isProtectiveDisposition(disposition)) return failure("MALFORMED_INPUT");
    const outcomeVersionId = source.outcomeVersionId === null || source.outcomeVersionId === undefined
      ? null : typeof source.outcomeVersionId === "string" && OUTCOME_VERSION.test(source.outcomeVersionId)
        ? source.outcomeVersionId : undefined;
    if (outcomeVersionId === undefined
      || (source.kind === "outcome_derived" && outcomeVersionId === null)
      || (source.kind === "member_recorded" && outcomeVersionId !== null)
      || (source.kind !== "outcome_derived" && source.kind !== "member_recorded")) {
      return failure("MALFORMED_INPUT");
    }
    if (accountId === null && contactStableKey !== null) return failure("SCOPE_MISMATCH");
    if (Date.parse(occurredAt) > Date.parse(recordedAt)) return failure("INVALID_CHRONOLOGY");
    const payload = Object.freeze({
      recordVersion: SUPPRESSION_RECORD_SCHEMA_VERSION,
      tenantId,
      workspaceId,
      accountId,
      contactStableKey,
      disposition: disposition as SuppressionDisposition,
      reason,
      source: Object.freeze({ kind: source.kind as SuppressionSource["kind"], outcomeVersionId }),
      actor: Object.freeze({ kind: "human" as const, actorId }),
      occurredAt,
      recordedAt,
    });
    const recordHash = sha256(payload);
    return Object.freeze({
      ok: true,
      code: "SUPPRESSION_RECORDED" as const,
      record: Object.freeze({
        ...payload,
        recordId: `suppression-record:${recordHash.slice("sha256:".length)}`,
        recordHash,
      }),
    });
  } catch {
    return failure("MALFORMED_INPUT");
  }
}
