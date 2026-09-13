import { isProxy } from "node:util/types";

import type { DbClient } from "@/lib/db";
import { DocumentIntakeError } from "@/lib/documents/errors";

import type {
  KnowledgeClaimReviewRequest,
  KnowledgeQueryRepository,
  TenantKnowledgeScope,
} from "./knowledge-service";

const LIST_ROW_FIELDS = [
  "document_id", "version_id", "source_kind", "original_name", "format", "media_type",
  "declared_byte_size", "checksum", "scanner_policy_version", "state", "scan_state",
  "extraction_state", "extraction_job_id", "evidence_count", "claim_count",
  "created_at", "updated_at",
] as const;

const KNOWLEDGE_ROW_FIELDS = [
  "evidence_id", "document_id", "version_id", "block_ordinal", "source_locator",
  "quote", "quote_hash", "citation_id", "claim_id", "claim_version_id", "claim_class",
  "subject", "predicate", "value", "unit", "polarity", "material", "review_state",
  "review_reason",
] as const;

const CITATION_ROW_FIELDS = [
  "citation_id", "evidence_id", "document_id", "version_id", "quote", "quote_hash",
  "source_locator", "version_state",
] as const;

const REVIEW_ROW_FIELDS = [
  "kind", "claim_id", "claim_version_id", "outcome_claim_version_id", "review_state",
] as const;

function persistenceError(): DocumentIntakeError {
  return new DocumentIntakeError(
    "persistence_boundary_error",
    "The knowledge state could not be persisted safely.",
  );
}

function exactRow(value: unknown, fields: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== "object" || isProxy(value) || Array.isArray(value)) throw persistenceError();
  try {
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) throw persistenceError();
    const descriptors = Object.getOwnPropertyDescriptors(value);
    const keys = Reflect.ownKeys(descriptors);
    if (keys.length !== fields.length || keys.some((key) =>
      typeof key !== "string" || !fields.includes(key))) {
      throw persistenceError();
    }
    const row: Record<string, unknown> = {};
    for (const field of fields) {
      const descriptor = descriptors[field];
      if (!descriptor || !("value" in descriptor) || !descriptor.enumerable) throw persistenceError();
      row[field] = descriptor.value;
    }
    return row;
  } catch (error) {
    if (error instanceof DocumentIntakeError) throw error;
    throw persistenceError();
  }
}

async function callFunction(
  db: DbClient,
  select: string,
  fn: string,
  params: readonly unknown[],
): Promise<readonly Record<string, unknown>[]> {
  let rows: unknown;
  try {
    rows = await db.prepare(`SELECT ${select} FROM public.${fn}`).all(...params);
  } catch {
    throw persistenceError();
  }
  if (!Array.isArray(rows) || isProxy(rows)) throw persistenceError();
  return rows as readonly Record<string, unknown>[];
}

export function createPostgresKnowledgeQueryRepository(
  db: DbClient,
): KnowledgeQueryRepository {
  return Object.freeze({
    async listKnowledgeDocuments(
      scope: TenantKnowledgeScope,
    ): Promise<readonly Record<string, unknown>[]> {
      const rows = await callFunction(db,
        `document_id,version_id,source_kind,original_name,format,media_type,
        declared_byte_size,checksum,scanner_policy_version,state,scan_state,
        extraction_state,extraction_job_id,evidence_count,claim_count,created_at,updated_at`,
        "novatrade_list_knowledge_documents(?,?)",
        [scope.tenantId, scope.workspaceId]);
      if (rows.length > 500) throw persistenceError();
      return rows.map((row) => exactRow(row, LIST_ROW_FIELDS));
    },

    async getDocumentKnowledge(
      scope: TenantKnowledgeScope & Readonly<{ documentId: string; versionId: string }>,
    ): Promise<readonly Record<string, unknown>[]> {
      const rows = await callFunction(db,
        `evidence_id,document_id,version_id,block_ordinal,source_locator,quote,quote_hash,
        citation_id,claim_id,claim_version_id,claim_class,subject,predicate,value,unit,
        polarity,material,review_state,review_reason`,
        "novatrade_get_document_knowledge(?,?,?,?)",
        [scope.tenantId, scope.workspaceId, scope.documentId, scope.versionId]);
      if (rows.length > 2000) throw persistenceError();
      return rows.map((row) => exactRow(row, KNOWLEDGE_ROW_FIELDS));
    },

    async resolveCitation(
      scope: TenantKnowledgeScope & Readonly<{ citationId: string }>,
    ): Promise<Record<string, unknown> | undefined> {
      const rows = await callFunction(db,
        "citation_id,evidence_id,document_id,version_id,quote,quote_hash,source_locator,version_state",
        "novatrade_resolve_knowledge_citation(?,?,?)",
        [scope.tenantId, scope.workspaceId, scope.citationId]);
      if (rows.length === 0) return undefined;
      if (rows.length !== 1) throw persistenceError();
      return exactRow(rows[0], CITATION_ROW_FIELDS);
    },

    async reviewClaim(
      request: KnowledgeClaimReviewRequest,
    ): Promise<Record<string, unknown> | undefined> {
      const rows = await callFunction(db,
        "kind,claim_id,claim_version_id,outcome_claim_version_id,review_state",
        "novatrade_review_knowledge_claim(?,?,?,?,?,?,?,?::pg_catalog.jsonb)",
        [
          request.tenantId,
          request.workspaceId,
          request.claimId,
          request.claimVersionId,
          request.decisionId,
          request.action,
          request.reasonCode,
          request.outcome === null ? null : JSON.stringify(request.outcome),
        ]);
      if (rows.length === 0) return undefined;
      if (rows.length !== 1) throw persistenceError();
      return exactRow(rows[0], REVIEW_ROW_FIELDS);
    },
  });
}
