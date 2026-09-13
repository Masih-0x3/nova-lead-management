"use server";

import { z } from "zod";

import type { TenantSession } from "@/lib/auth";
import { withTenantDbContext } from "@/lib/db";
import { isTransientDbError } from "@/lib/db/index";
import { DocumentIntakeError } from "@/lib/documents/errors";
import {
  requireTenantPermission,
  TenantAuthorizationError,
} from "@/lib/tenancy/authorize";
import { runWithTenantContext } from "@/lib/tenancy/context";

import {
  getDocumentKnowledge,
  listKnowledgeDocuments,
  resolveKnowledgeCitation,
  reviewKnowledgeClaim,
  type KnowledgeClaimReviewAction,
} from "./knowledge-service";
import { createPostgresKnowledgeQueryRepository } from "./postgres-knowledge-repository";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const CLAIM_ID = /^claim:[0-9a-f]{64}$/u;
const CLAIM_VERSION_ID = /^claim-version:[0-9a-f]{64}$/u;
const CITATION_ID = /^citation:[0-9a-f]{64}$/u;
const IDEMPOTENCY_KEY = /^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/u;
const REASON_CODE = /^[^\u0000-\u001f\u007f]{1,128}$/u;

const scopeSchema = z.object({
  tenantId: z.string().regex(UUID),
  workspaceId: z.string().regex(UUID),
});

const documentKnowledgeSchema = scopeSchema.extend({
  documentId: z.string().regex(UUID),
  versionId: z.string().regex(UUID),
});

const citationSchema = scopeSchema.extend({
  citationId: z.string().regex(CITATION_ID),
});

const reviewSchema = scopeSchema.extend({
  claimId: z.string().regex(CLAIM_ID),
  claimVersionId: z.string().regex(CLAIM_VERSION_ID),
  action: z.enum(["approve", "edit", "reject"]),
  reasonCode: z.string().regex(REASON_CODE).max(128),
  idempotencyKey: z.string().regex(IDEMPOTENCY_KEY),
  outcome: z.object({
    value: z.string().min(1).max(2048).optional(),
    unit: z.string().min(1).max(64).nullable().optional(),
    uncertainty: z.string().min(1).max(1000).nullable().optional(),
    confidenceBasisPoints: z.number().int().min(0).max(10_000).optional(),
  }).strict().optional(),
});

export type KnowledgeActionResult =
  | Readonly<{ ok: true; [key: string]: unknown }>
  | Readonly<{ ok: false; code: string }>;

function failure(code: string): KnowledgeActionResult {
  return Object.freeze({ ok: false as const, code });
}

function mapFailure(error: unknown): KnowledgeActionResult {
  if (error instanceof TenantAuthorizationError) return failure("NOT_AUTHORIZED");
  if (error instanceof DocumentIntakeError) {
    if (error.code === "intake_boundary_error") return failure("INVALID_INPUT");
    if (error.code === "illegal_transition") return failure("NOT_ELIGIBLE");
    return failure("UNAVAILABLE");
  }
  if (isTransientDbError(error)) return failure("UNAVAILABLE");
  return failure("UNAVAILABLE");
}

function assertScope(session: TenantSession, tenantId: string, workspaceId: string): void {
  if (session.tenantId !== tenantId || session.workspaceId !== workspaceId) {
    throw new TenantAuthorizationError(403, "TENANT_SCOPE_MISMATCH");
  }
}

/** Lists the tenant's documents for the knowledge surface (L-07 UI seam). */
export async function listKnowledgeDocumentsAction(
  input: unknown,
): Promise<KnowledgeActionResult> {
  try {
    const parsed = scopeSchema.safeParse(input);
    if (!parsed.success) return failure("INVALID_INPUT");
    const session = await requireTenantPermission(
      { tenantId: parsed.data.tenantId, workspaceId: parsed.data.workspaceId },
      "knowledge:read",
      { action: "knowledge:list" },
    );
    assertScope(session, parsed.data.tenantId, parsed.data.workspaceId);
    const documents = await runWithTenantContext(
      session,
      `knowledge-list:${parsed.data.tenantId}`,
      () => withTenantDbContext((db) => listKnowledgeDocuments({
        tenantId: parsed.data.tenantId,
        workspaceId: parsed.data.workspaceId,
      }, {
        repository: createPostgresKnowledgeQueryRepository(db),
      })),
    );
    return Object.freeze({ ok: true as const, documents });
  } catch (error) {
    return mapFailure(error);
  }
}

/** Returns one document's evidence and claims projection for review. */
export async function getDocumentKnowledgeAction(
  input: unknown,
): Promise<KnowledgeActionResult> {
  try {
    const parsed = documentKnowledgeSchema.safeParse(input);
    if (!parsed.success) return failure("INVALID_INPUT");
    const session = await requireTenantPermission(
      { tenantId: parsed.data.tenantId, workspaceId: parsed.data.workspaceId },
      "knowledge:read",
      { action: "knowledge:read_document" },
    );
    assertScope(session, parsed.data.tenantId, parsed.data.workspaceId);
    const projection = await runWithTenantContext(
      session,
      `knowledge-document:${parsed.data.documentId}`,
      () => withTenantDbContext((db) => getDocumentKnowledge({
        tenantId: parsed.data.tenantId,
        workspaceId: parsed.data.workspaceId,
        documentId: parsed.data.documentId,
        versionId: parsed.data.versionId,
      }, {
        repository: createPostgresKnowledgeQueryRepository(db),
      })),
    );
    if (projection === undefined) return failure("NOT_FOUND");
    return Object.freeze({ ok: true as const, projection });
  } catch (error) {
    return mapFailure(error);
  }
}

/** Resolves one render-safe citation under the member's tenant permissions. */
export async function resolveKnowledgeCitationAction(
  input: unknown,
): Promise<KnowledgeActionResult> {
  try {
    const parsed = citationSchema.safeParse(input);
    if (!parsed.success) return failure("INVALID_INPUT");
    const session = await requireTenantPermission(
      { tenantId: parsed.data.tenantId, workspaceId: parsed.data.workspaceId },
      "knowledge:read",
      { action: "knowledge:resolve_citation" },
    );
    assertScope(session, parsed.data.tenantId, parsed.data.workspaceId);
    const citation = await runWithTenantContext(
      session,
      `knowledge-citation:${parsed.data.citationId}`,
      () => withTenantDbContext((db) => resolveKnowledgeCitation({
        tenantId: parsed.data.tenantId,
        workspaceId: parsed.data.workspaceId,
        citationId: parsed.data.citationId,
      }, {
        repository: createPostgresKnowledgeQueryRepository(db),
      })),
    );
    if (citation === undefined) return failure("NOT_FOUND");
    return Object.freeze({ ok: true as const, citation });
  } catch (error) {
    return mapFailure(error);
  }
}

/**
 * Applies a reviewer decision (approve/edit/reject) to a proposed claim. The
 * decision id is derived from the idempotency key so retries replay safely.
 */
export async function reviewKnowledgeClaimAction(
  input: unknown,
): Promise<KnowledgeActionResult> {
  try {
    const parsed = reviewSchema.safeParse(input);
    if (!parsed.success) return failure("INVALID_INPUT");
    if (parsed.data.action !== "edit" && parsed.data.outcome !== undefined) {
      return failure("INVALID_INPUT");
    }
    const session = await requireTenantPermission(
      { tenantId: parsed.data.tenantId, workspaceId: parsed.data.workspaceId },
      "knowledge:review",
      { action: "knowledge:review_claim" },
    );
    assertScope(session, parsed.data.tenantId, parsed.data.workspaceId);
    const result = await runWithTenantContext(
      session,
      `knowledge-review:${parsed.data.claimId}:${parsed.data.idempotencyKey}`,
      () => withTenantDbContext((db) => reviewKnowledgeClaim({
        tenantId: parsed.data.tenantId,
        workspaceId: parsed.data.workspaceId,
        claimId: parsed.data.claimId,
        claimVersionId: parsed.data.claimVersionId,
        action: parsed.data.action as KnowledgeClaimReviewAction,
        reasonCode: parsed.data.reasonCode,
        idempotencyKey: parsed.data.idempotencyKey,
        ...(parsed.data.outcome ? { outcome: parsed.data.outcome } : {}),
      }, {
        repository: createPostgresKnowledgeQueryRepository(db),
      })),
    );
    if (result.kind === "unavailable") return failure("NOT_FOUND");
    return Object.freeze({ ok: true as const, ...result });
  } catch (error) {
    return mapFailure(error);
  }
}
