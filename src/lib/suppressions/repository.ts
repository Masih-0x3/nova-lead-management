import { isProxy } from "node:util/types";

import type { DbClient } from "@/lib/db";
import {
  parseSuppressionRecord,
  type SuppressionRecord,
} from "@/lib/suppressions/suppression-record";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const SAFE_REF = /^[A-Za-z0-9][A-Za-z0-9:._/-]{0,254}$/u;

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value) || isProxy(value)) return false;
  try {
    const prototype = Object.getPrototypeOf(value);
    return prototype === Object.prototype || prototype === null;
  } catch {
    return false;
  }
}

export class SuppressionRepositoryError extends Error {
  readonly code: "SUPPRESSION_PERSISTENCE_INVALID";

  constructor(message: string) {
    super(message);
    this.name = "SuppressionRepositoryError";
    this.code = "SUPPRESSION_PERSISTENCE_INVALID";
  }
}

function invalid(message: string): SuppressionRepositoryError {
  return new SuppressionRepositoryError(message);
}

export interface StoredSuppressionRow {
  readonly tenantId: string;
  readonly workspaceId: string;
  readonly record: SuppressionRecord;
}

export interface SuppressionRepository {
  insertRecord(record: SuppressionRecord): Promise<"created" | "replayed">;
  listRecords(
    tenantId: string,
    workspaceId: string,
    filter?: Readonly<{
      accountId?: string;
      contactStableKey?: string;
      includeTenantScoped?: boolean;
    }>,
  ): Promise<readonly StoredSuppressionRow[]>;
  getRecord(
    tenantId: string,
    workspaceId: string,
    recordId: string,
  ): Promise<StoredSuppressionRow | null>;
}

function iso(value: unknown): string {
  return value instanceof Date ? value.toISOString()
    : typeof value === "string" ? value : (() => { throw invalid("bad timestamp"); })();
}

function rowToStored(row: Record<string, unknown>): StoredSuppressionRow {
  if (!isPlainRecord(row)) throw invalid("suppression_records row is malformed");
  const tenantId = typeof row.tenant_id === "string" && UUID.test(row.tenant_id)
    ? row.tenant_id : null;
  const workspaceId = typeof row.workspace_id === "string" && UUID.test(row.workspace_id)
    ? row.workspace_id : null;
  const accountId = row.account_id === null || row.account_id === undefined ? null
    : typeof row.account_id === "string" && UUID.test(row.account_id) ? row.account_id : undefined;
  const contactStableKey = row.contact_stable_key === null || row.contact_stable_key === undefined
    ? null
    : typeof row.contact_stable_key === "string" && SAFE_REF.test(row.contact_stable_key)
      ? row.contact_stable_key : undefined;
  const payload = typeof row.payload === "string" ? JSON.parse(row.payload) : row.payload;
  if (!tenantId || !workspaceId || accountId === undefined || contactStableKey === undefined
    || !isPlainRecord(payload)) {
    throw invalid("suppression_records row carries a malformed scope or payload");
  }
  const record = parseSuppressionRecord(payload);
  if (!record
    || record.recordId !== row.record_id
    || record.tenantId !== tenantId
    || record.workspaceId !== workspaceId
    || record.accountId !== accountId
    || record.contactStableKey !== contactStableKey
    || record.disposition !== row.disposition
    || record.reason !== row.reason
    || record.source.kind !== row.source_kind
    || record.source.outcomeVersionId !== (row.outcome_version_id ?? null)
    || record.actor.actorId !== row.actor_id
    || record.occurredAt !== iso(row.occurred_at)
    || record.recordedAt !== iso(row.recorded_at)
    || record.recordHash !== `sha256:${row.record_sha256}`) {
    throw invalid("suppression_records payload is inconsistent with its relational columns");
  }
  return Object.freeze({ tenantId, workspaceId, record });
}

export function createPostgresSuppressionRepository(db: DbClient): SuppressionRepository {
  if (!db || typeof db.prepare !== "function") throw new TypeError("A database client is required");
  const repository: SuppressionRepository = {
    async insertRecord(record) {
      const inserted = await db.prepare(
        `INSERT INTO public.suppression_records
          (record_id, tenant_id, workspace_id, account_id, contact_stable_key,
           disposition, reason, source_kind, outcome_version_id, actor_id,
           occurred_at, recorded_at, payload, record_sha256)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?::jsonb, ?)
         ON CONFLICT (record_id) DO NOTHING RETURNING record_id`,
      ).all(
        record.recordId, record.tenantId, record.workspaceId, record.accountId,
        record.contactStableKey, record.disposition, record.reason, record.source.kind,
        record.source.outcomeVersionId, record.actor.actorId, record.occurredAt,
        record.recordedAt, JSON.stringify(record), record.recordHash.slice("sha256:".length),
      );
      if (!Array.isArray(inserted) || isProxy(inserted)) {
        throw invalid("suppression_records insert returned an invalid result");
      }
      return inserted.length === 1 ? "created" : "replayed";
    },

    async listRecords(tenantId, workspaceId, filter) {
      const accountId = filter?.accountId;
      const contactStableKey = filter?.contactStableKey;
      if (accountId !== undefined && !UUID.test(accountId)) {
        throw invalid("accountId filter must be a UUID");
      }
      if (contactStableKey !== undefined && !SAFE_REF.test(contactStableKey)) {
        throw invalid("contactStableKey filter is malformed");
      }
      const includeTenantScoped = filter?.includeTenantScoped === true;
      const conditions = ["tenant_id = ?", "workspace_id = ?"];
      const values: unknown[] = [tenantId, workspaceId];
      if (accountId !== undefined) {
        values.push(accountId);
        conditions.push(includeTenantScoped
          ? "(account_id = ? OR account_id IS NULL)"
          : "account_id = ?");
      } else if (!includeTenantScoped) {
        conditions.push("account_id IS NOT NULL");
      }
      if (contactStableKey !== undefined) {
        values.push(contactStableKey);
        conditions.push("contact_stable_key = ?");
      }
      const rows = await db.prepare(
        `SELECT * FROM public.suppression_records
         WHERE ${conditions.join(" AND ")}
         ORDER BY occurred_at ASC, record_id ASC LIMIT 1000`,
      ).all(...values);
      if (!Array.isArray(rows) || isProxy(rows)) throw invalid("bad suppression list result");
      return Object.freeze(rows.map(rowToStored));
    },

    async getRecord(tenantId, workspaceId, recordId) {
      const row = await db.prepare(
        `SELECT * FROM public.suppression_records
         WHERE tenant_id = ? AND workspace_id = ? AND record_id = ?`,
      ).get(tenantId, workspaceId, recordId);
      if (row === undefined) return null;
      return rowToStored(row);
    },
  };
  return Object.freeze(repository);
}
