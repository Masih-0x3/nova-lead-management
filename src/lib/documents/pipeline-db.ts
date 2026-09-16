import { isProxy } from "node:util/types";

import { getDb, withDbTransaction, type DbClient } from "@/lib/db";

import { DocumentIntakeError } from "./errors";

/**
 * Document-pipeline worker authority is the fenced job lease itself: the
 * transaction-local GUC set below is the only thing the L-03 SECURITY DEFINER
 * RPCs check. Scheduler worker leases and member session authority are not
 * accepted here. A scope without tenantId/workspaceId is the discovery mode
 * used by claim-style acquisition; result persistence always requires the
 * fully bound scope the claim returned.
 */
export type DocumentPipelineWorkerScope = Readonly<{
  tenantId: string | null;
  workspaceId: string | null;
  jobId: string;
  runId: string;
  leaseId: string;
  leaseGeneration: number;
  action:
    | "document_scan:process"
    | "document_scan:recover"
    | "document_extraction:process"
    | "document_extraction:recover"
    | "document_retention:evaluate"
    | "document_retention:delete";
  principalKind: "cron" | "session";
  correlationId: string;
}>;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const CORRELATION = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/u;
const ACTIONS = new Set([
  "document_scan:process",
  "document_scan:recover",
  "document_extraction:process",
  "document_extraction:recover",
  "document_retention:evaluate",
  "document_retention:delete",
]);

interface TransactionContextInstaller {
  installTransactionLocalContext(entries: readonly (readonly [string, string])[]): Promise<void>;
}

function workerContextError(): DocumentIntakeError {
  return new DocumentIntakeError(
    "persistence_boundary_error",
    "The document pipeline worker context could not be installed.",
  );
}

export function assertDocumentPipelineWorkerScope(
  scope: DocumentPipelineWorkerScope,
): DocumentPipelineWorkerScope {
  if (!scope || typeof scope !== "object" || isProxy(scope)) throw workerContextError();
  if (!UUID.test(scope.jobId) || !UUID.test(scope.runId) || !UUID.test(scope.leaseId)
    || !Number.isSafeInteger(scope.leaseGeneration) || scope.leaseGeneration < 1
    || scope.leaseGeneration > 999999 || !ACTIONS.has(scope.action)
    || (scope.principalKind !== "cron" && scope.principalKind !== "session")
    || !CORRELATION.test(scope.correlationId)) {
    throw workerContextError();
  }
  if (scope.tenantId !== null && (!UUID.test(scope.tenantId) || scope.workspaceId === null
    || !UUID.test(scope.workspaceId))) {
    throw workerContextError();
  }
  return scope;
}

export async function runDocumentPipelineDb<T>(
  scope: DocumentPipelineWorkerScope,
  fn: (db: DbClient) => Promise<T>,
): Promise<T> {
  const checked = assertDocumentPipelineWorkerScope(scope);
  return withDbTransaction(async () => {
    const db = await getDb();
    const installer = db as DbClient & Partial<TransactionContextInstaller>;
    if (typeof installer.installTransactionLocalContext !== "function") {
      throw workerContextError();
    }
    const entries: [string, string][] = [
      ["app.job_id", checked.jobId],
      ["app.run_id", checked.runId],
      ["app.lease_id", checked.leaseId],
      ["app.lease_generation", String(checked.leaseGeneration)],
      ["app.worker_name", "document_pipeline"],
      ["app.worker_action", checked.action],
      ["app.worker_principal_kind", checked.principalKind],
      ["app.correlation_id", checked.correlationId],
    ];
    if (checked.tenantId !== null && checked.workspaceId !== null) {
      entries.push(["app.tenant_id", checked.tenantId], ["app.workspace_id", checked.workspaceId]);
    }
    await installer.installTransactionLocalContext(entries);
    return fn(db);
  });
}
