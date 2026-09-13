"use server";

import { randomUUID } from "node:crypto";
import { z } from "zod";

import type { TenantSession } from "@/lib/auth";
import { withTenantDbContext } from "@/lib/db";
import { isTransientDbError } from "@/lib/db/index";
import {
  requireTenantPermission,
  TenantAuthorizationError,
} from "@/lib/tenancy/authorize";
import { runWithTenantContext } from "@/lib/tenancy/context";

import {
  initiateAuthenticatedDocumentIntake,
} from "./authenticated-intake-service";
import { DocumentIntakeError } from "./errors";
import { createLocalDocumentStore } from "./local-storage-adapter";
import {
  cancelDocumentExtraction,
  requestDocumentExtraction,
  submitDocumentDeletionRequest,
} from "./pipeline-service";
import { createPostgresDocumentPipelineRepository } from "./postgres-pipeline-repository";
import { createPostgresDocumentUrlIntakeRepository } from "./postgres-url-intake-repository";
import { intakeDocumentFromUrl } from "./url-intake-service";

const STORE_ROOT_ENV = "NOVA_DOCUMENT_STORE_ROOT";
const SIGNING_SECRET_ENV = "NOVA_DOCUMENT_SIGNING_SECRET";
const UPLOAD_ORIGIN_ENV = "NOVA_DOCUMENT_UPLOAD_ORIGIN";
const SCANNER_POLICY_ENV = "NOVA_SCANNER_POLICY_VERSION";
const DEFAULT_SCANNER_POLICY_VERSION = "launch-v1";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const IDEMPOTENCY_KEY = /^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/u;
const POLICY_VERSION = /^[A-Za-z0-9][A-Za-z0-9._:-]{1,63}$/u;

const scopeSchema = z.object({
  tenantId: z.string().regex(UUID),
  workspaceId: z.string().regex(UUID),
});

const uploadSchema = scopeSchema.extend({
  fileName: z.string().min(1).max(1024),
  declaredMediaType: z.string().min(3).max(255),
  declaredByteSize: z.number().int().positive().max(50 * 1024 * 1024),
  idempotencyKey: z.string().regex(IDEMPOTENCY_KEY).optional(),
});

const urlIntakeSchema = scopeSchema.extend({
  url: z.string().min(1).max(2048),
  requestedName: z.string().min(1).max(1024),
  idempotencyKey: z.string().regex(IDEMPOTENCY_KEY).optional(),
});

const extractionRequestSchema = scopeSchema.extend({
  documentId: z.string().regex(UUID),
  versionId: z.string().regex(UUID),
  checksum: z.string().regex(/^[0-9a-f]{64}$/u),
  format: z.enum(["pdf", "docx", "xlsx", "csv", "txt", "markdown"]),
  mediaType: z.string().min(3).max(255),
  idempotencyKey: z.string().regex(IDEMPOTENCY_KEY).optional(),
});

const extractionCancelSchema = scopeSchema.extend({
  jobId: z.string().regex(UUID),
});

const deletionRequestSchema = scopeSchema.extend({
  documentId: z.string().regex(UUID),
  versionId: z.string().regex(UUID),
});

export type DocumentActionResult =
  | Readonly<{ ok: true; [key: string]: unknown }>
  | Readonly<{ ok: false; code: string }>;

function failure(code: string): DocumentActionResult {
  return Object.freeze({ ok: false as const, code });
}

function mapFailure(error: unknown): DocumentActionResult {
  if (error instanceof TenantAuthorizationError) return failure("NOT_AUTHORIZED");
  if (error instanceof DocumentIntakeError) {
    const code = error.code;
    if (code === "idempotency_conflict") return failure("IDEMPOTENCY_CONFLICT");
    if (code === "unsupported_type" || code === "type_mismatch") return failure("INVALID_INPUT");
    if (code === "size_limit_exceeded" || code === "size_mismatch") return failure("INVALID_INPUT");
    if (code === "illegal_transition" || code === "stale_version" || code === "stale_checksum") {
      return failure("NOT_ELIGIBLE");
    }
    if (code === "incident_hold_active") return failure("HOLD_ACTIVE");
    return failure("UNAVAILABLE");
  }
  if (isTransientDbError(error)) return failure("UNAVAILABLE");
  return failure("UNAVAILABLE");
}

function localStore() {
  return createLocalDocumentStore({
    rootDir: process.env[STORE_ROOT_ENV]?.trim() || ".data/document-objects",
    signingSecret: process.env[SIGNING_SECRET_ENV]?.trim() ?? "",
    uploadOrigin: process.env[UPLOAD_ORIGIN_ENV]?.trim() || undefined,
  });
}

function scannerPolicyVersion(): string {
  const configured = process.env[SCANNER_POLICY_ENV]?.trim() ?? "";
  return POLICY_VERSION.test(configured) ? configured : DEFAULT_SCANNER_POLICY_VERSION;
}

function assertScope(session: TenantSession, tenantId: string, workspaceId: string): void {
  if (session.tenantId !== tenantId || session.workspaceId !== workspaceId) {
    throw new TenantAuthorizationError(403, "TENANT_SCOPE_MISMATCH");
  }
}

/**
 * Reserves a private upload for one document version. The member only declares
 * intent; the signed capability, canonical object key, and generated document
 * and version ids are minted server-side.
 */
export async function initiateDocumentUploadAction(
  input: unknown,
): Promise<DocumentActionResult> {
  try {
    const parsed = uploadSchema.safeParse(input);
    if (!parsed.success) return failure("INVALID_INPUT");
    const documentId = randomUUID();
    const versionId = randomUUID();
    const result = await initiateAuthenticatedDocumentIntake({
      tenantId: parsed.data.tenantId,
      workspaceId: parsed.data.workspaceId,
      documentId,
      versionId,
      idempotencyKey: parsed.data.idempotencyKey ?? `upload.${randomUUID()}`,
      fileName: parsed.data.fileName,
      declaredMediaType: parsed.data.declaredMediaType,
      declaredByteSize: parsed.data.declaredByteSize,
      scannerPolicyVersion: scannerPolicyVersion(),
    }, {
      correlationId: `document-upload:${documentId}`,
      storage: localStore(),
    });
    return Object.freeze({
      ok: true as const,
      kind: result.kind,
      documentId: result.record.documentId,
      versionId: result.record.versionId,
      objectKey: result.upload.objectKey,
      uploadUrl: result.upload.uploadUrl,
      expiresAt: result.upload.expiresAt,
      scannerPolicyVersion: result.record.scannerPolicyVersion,
    });
  } catch (error) {
    return mapFailure(error);
  }
}

/**
 * Authorized URL intake: the request is recorded durably, then the service
 * fetches through the SSRF guard, stores the verified bytes privately, and
 * quarantines the version for the scan worker.
 */
export async function intakeDocumentFromUrlAction(
  input: unknown,
): Promise<DocumentActionResult> {
  try {
    const parsed = urlIntakeSchema.safeParse(input);
    if (!parsed.success) return failure("INVALID_INPUT");
    const session = await requireTenantPermission(
      { tenantId: parsed.data.tenantId, workspaceId: parsed.data.workspaceId },
      "knowledge:upload",
      { action: "document:url_intake" },
    );
    assertScope(session, parsed.data.tenantId, parsed.data.workspaceId);
    const documentId = randomUUID();
    const requestId = randomUUID();
    const result = await runWithTenantContext(
      session,
      `document-url-intake:${requestId}`,
      () => withTenantDbContext((db) => intakeDocumentFromUrl({
        tenantId: parsed.data.tenantId,
        workspaceId: parsed.data.workspaceId,
        documentId,
        requestId,
        idempotencyKey: parsed.data.idempotencyKey ?? `url-intake.${requestId}`,
        url: parsed.data.url,
        requestedName: parsed.data.requestedName,
        scannerPolicyVersion: scannerPolicyVersion(),
      }, {
        repository: createPostgresDocumentUrlIntakeRepository(db),
        writer: localStore(),
      })),
    );
    return Object.freeze({ ok: true as const, ...result });
  } catch (error) {
    return mapFailure(error);
  }
}

/** Queues a clean document version for extraction under the launch parser. */
export async function requestDocumentExtractionAction(
  input: unknown,
): Promise<DocumentActionResult> {
  try {
    const parsed = extractionRequestSchema.safeParse(input);
    if (!parsed.success) return failure("INVALID_INPUT");
    const session = await requireTenantPermission(
      { tenantId: parsed.data.tenantId, workspaceId: parsed.data.workspaceId },
      "knowledge:manage",
      { action: "document:extract" },
    );
    assertScope(session, parsed.data.tenantId, parsed.data.workspaceId);
    const jobId = randomUUID();
    const result = await runWithTenantContext(
      session,
      `document-extraction:${jobId}`,
      () => withTenantDbContext((db) => requestDocumentExtraction({
        tenantId: parsed.data.tenantId,
        workspaceId: parsed.data.workspaceId,
        documentId: parsed.data.documentId,
        versionId: parsed.data.versionId,
        jobId,
        idempotencyKey: parsed.data.idempotencyKey ?? `extraction.${jobId}`,
        checksum: parsed.data.checksum,
        scannerPolicyVersion: scannerPolicyVersion(),
        format: parsed.data.format,
        mediaType: parsed.data.mediaType,
      }, {
        repository: createPostgresDocumentPipelineRepository(db),
      })),
    );
    return Object.freeze({ ok: true as const, ...result });
  } catch (error) {
    return mapFailure(error);
  }
}

/** Requests cancellation of a queued or running extraction job. */
export async function cancelDocumentExtractionAction(
  input: unknown,
): Promise<DocumentActionResult> {
  try {
    const parsed = extractionCancelSchema.safeParse(input);
    if (!parsed.success) return failure("INVALID_INPUT");
    const session = await requireTenantPermission(
      { tenantId: parsed.data.tenantId, workspaceId: parsed.data.workspaceId },
      "knowledge:manage",
      { action: "document:extract_cancel" },
    );
    assertScope(session, parsed.data.tenantId, parsed.data.workspaceId);
    const result = await runWithTenantContext(
      session,
      `document-extraction-cancel:${parsed.data.jobId}`,
      () => withTenantDbContext((db) => cancelDocumentExtraction({
        tenantId: parsed.data.tenantId,
        workspaceId: parsed.data.workspaceId,
        jobId: parsed.data.jobId,
      }, {
        repository: createPostgresDocumentPipelineRepository(db),
      })),
    );
    return Object.freeze({ ok: true as const, ...result });
  } catch (error) {
    return mapFailure(error);
  }
}

/**
 * Stages a durable member-requested deletion for one document version. The
 * retention-delete worker applies it after any hold evaluation.
 */
export async function requestDocumentDeletionAction(
  input: unknown,
): Promise<DocumentActionResult> {
  try {
    const parsed = deletionRequestSchema.safeParse(input);
    if (!parsed.success) return failure("INVALID_INPUT");
    const session = await requireTenantPermission(
      { tenantId: parsed.data.tenantId, workspaceId: parsed.data.workspaceId },
      "knowledge:delete",
      { action: "document:delete" },
    );
    assertScope(session, parsed.data.tenantId, parsed.data.workspaceId);
    const requestId = randomUUID();
    const result = await runWithTenantContext(
      session,
      `document-deletion:${requestId}`,
      () => withTenantDbContext((db) => submitDocumentDeletionRequest({
        tenantId: parsed.data.tenantId,
        workspaceId: parsed.data.workspaceId,
        documentId: parsed.data.documentId,
        versionId: parsed.data.versionId,
        requestId,
        reasonCode: "member_requested",
      }, {
        repository: createPostgresDocumentPipelineRepository(db),
      })),
    );
    return Object.freeze({ ok: true as const, ...result });
  } catch (error) {
    return mapFailure(error);
  }
}
