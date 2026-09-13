import "server-only";

import { randomUUID } from "node:crypto";
import { isProxy } from "node:util/types";
import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";

import { ForbiddenError, UnauthorizedError } from "@/lib/auth";
import type { DbClient } from "@/lib/db";
import { isDbStatementTimeoutError } from "@/lib/db/index";
import { applyNoStoreHeaders } from "@/lib/http-cache";
import { authorizeInternalWorkerRequest } from "@/lib/internal-worker-auth";

import { DocumentIntakeError } from "./errors";
import {
  runDocumentPipelineDb,
  type DocumentPipelineWorkerScope,
} from "./pipeline-db";

const CORRELATION_HEADER = "x-correlation-id";
const CORRELATION = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/u;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const WORKER_FAILED_MESSAGE = "Worker failed.";
const WORKER_AUTHENTICATION_REQUIRED_MESSAGE = "Authentication required";
const WORKER_FORBIDDEN_MESSAGE = "You do not have permission to perform this action";

export type DocumentPipelineWorkerAction = DocumentPipelineWorkerScope["action"];

export type DocumentPipelineScopeFields = Readonly<
  Pick<
    DocumentPipelineWorkerScope,
    "tenantId" | "workspaceId" | "jobId" | "runId" | "leaseId" | "leaseGeneration"
  >
>;

export type DocumentPipelineWorkerContext = Readonly<{
  principalKind: "cron" | "session";
  correlationId: string;
  run<T>(
    scope: DocumentPipelineScopeFields,
    fn: (db: DbClient) => Promise<T>,
  ): Promise<T>;
}>;

/** Null-tenant sweep scope: discovery RPCs still require a full job/run/lease identity. */
export function documentPipelineDiscoveryScope(): DocumentPipelineScopeFields {
  return Object.freeze({
    tenantId: null,
    workspaceId: null,
    jobId: randomUUID(),
    runId: randomUUID(),
    leaseId: randomUUID(),
    leaseGeneration: 1,
  });
}

/** Fully bound scope for one claimed/discovered row inside a sweep. */
export function documentPipelineBoundScope(fields: Readonly<{
  tenantId: string;
  workspaceId: string;
  jobId: string;
  leaseGeneration?: number;
}>): DocumentPipelineScopeFields {
  return Object.freeze({
    tenantId: fields.tenantId,
    workspaceId: fields.workspaceId,
    jobId: fields.jobId,
    runId: randomUUID(),
    leaseId: randomUUID(),
    leaseGeneration: fields.leaseGeneration ?? 1,
  });
}

/**
 * Optional JSON body reader for worker routes: a request body is consumed at
 * most once, and only a plain object is returned.
 */
export async function documentPipelineWorkerBody(
  request: NextRequest,
): Promise<Readonly<Record<string, unknown>>> {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return Object.freeze({});
  }
  if (!body || typeof body !== "object" || Array.isArray(body) || isProxy(body)) {
    return Object.freeze({});
  }
  return body as Record<string, unknown>;
}

export function workerBodyUuid(
  body: Readonly<Record<string, unknown>>,
  field: string,
): string | null {
  const value = body[field];
  if (value === undefined || value === null) return null;
  if (typeof value !== "string" || !UUID.test(value)) return null;
  return value.toLowerCase();
}

export function workerBodyLimit(
  body: Readonly<Record<string, unknown>>,
  fallback: number,
): number {
  const value = body.limit;
  if (!Number.isSafeInteger(value)) return fallback;
  return Math.min(Math.max(value as number, 1), 100);
}

function workerJsonResponse(body: unknown, init?: ResponseInit): NextResponse {
  return applyNoStoreHeaders(NextResponse.json(body, init));
}

function normalizeTaskResult(result: unknown): Record<string, unknown> {
  if (result && typeof result === "object" && !Array.isArray(result)) {
    return result as Record<string, unknown>;
  }
  return { status: "processed", result };
}

function safeWorkerErrorMessage(error: unknown): string {
  if (isDbStatementTimeoutError(error)) {
    return "Worker database operation timed out.";
  }
  return WORKER_FAILED_MESSAGE;
}

/**
 * Shared runner for document-pipeline worker routes. Authentication is the
 * internal-worker boundary (cron secret or an admin session); the fenced job
 * lease installed per `run` call is the only tenant authority the RPCs accept.
 */
export async function runDocumentPipelineWorkerRoute(
  request: NextRequest,
  action: DocumentPipelineWorkerAction,
  task: (
    context: DocumentPipelineWorkerContext,
    signal?: AbortSignal,
  ) => Promise<unknown>,
): Promise<NextResponse> {
  try {
    const auth = await authorizeInternalWorkerRequest(request, "settings:manage");
    const header = request.headers.get(CORRELATION_HEADER);
    const correlationId = header !== null && CORRELATION.test(header)
      ? header : randomUUID();
    const context: DocumentPipelineWorkerContext = Object.freeze({
      principalKind: auth.source,
      correlationId,
      run: (scope, fn) => runDocumentPipelineDb(
        { ...scope, action, principalKind: auth.source, correlationId },
        fn,
      ),
    });
    const result = await task(context, request.signal);
    return workerJsonResponse(normalizeTaskResult(result));
  } catch (error) {
    if (error instanceof UnauthorizedError) {
      return workerJsonResponse(
        { status: "error", error: WORKER_AUTHENTICATION_REQUIRED_MESSAGE },
        { status: 401 },
      );
    }
    if (error instanceof ForbiddenError) {
      return workerJsonResponse(
        { status: "error", error: WORKER_FORBIDDEN_MESSAGE },
        { status: 403 },
      );
    }
    const body: Record<string, unknown> = {
      status: "error",
      error: safeWorkerErrorMessage(error),
    };
    if (error instanceof DocumentIntakeError) body.code = error.code;
    return workerJsonResponse(body, {
      status: isDbStatementTimeoutError(error) ? 504 : 500,
    });
  }
}
