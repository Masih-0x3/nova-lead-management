vi.mock("server-only", () => ({}));

import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import postgres, { type Sql } from "postgres";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { getDb, withDbTransaction, type DbClient } from "@/lib/db";
import {
  runDocumentPipelineDb,
  type DocumentPipelineWorkerScope,
} from "@/lib/documents/pipeline-db";
import { createLocalDocumentScanner } from "@/lib/documents/local-scanner-adapter";
import {
  createLocalDocumentStore,
  readLocalDocumentObject,
} from "@/lib/documents/local-storage-adapter";
import { createPostgresDocumentIntakeRepository } from "@/lib/documents/postgres-intake-repository";
import { createPostgresDocumentPipelineRepository } from "@/lib/documents/postgres-pipeline-repository";
import { createPostgresDocumentUrlIntakeRepository } from "@/lib/documents/postgres-url-intake-repository";
import {
  intakeDocumentFromUrl,
  lookupDocumentUrlSource,
} from "@/lib/documents/url-intake-service";
import { createPostgresKnowledgeQueryRepository } from "@/lib/knowledge/postgres-knowledge-repository";
import {
  claimDocumentScanJob,
  completeDocumentUpload,
  executeDocumentScan,
  initiateDocumentIntake,
  persistDocumentScanResult,
  type ClaimedDocumentScanLease,
  type PersistDocumentScanResultRequest,
  type ScanOutboxMessage,
} from "@/lib/documents/intake-service";
import {
  applyDocumentDeletion,
  claimDocumentExtractionJob,
  discoverDocumentDeletionRequests,
  discoverDocumentRetentionSubjects,
  evaluateDocumentRetention,
  executeDocumentExtraction,
  finalizeDocumentExtraction,
  requestDocumentExtraction,
  submitDocumentDeletionRequest,
  type ClaimedExtractionLease,
} from "@/lib/documents/pipeline-service";
import type { KnowledgeClaimProposal } from "@/lib/knowledge/claims";
import {
  getDocumentKnowledge,
  listKnowledgeDocuments,
  resolveKnowledgeCitation,
  reviewKnowledgeClaim,
} from "@/lib/knowledge/knowledge-service";

const RUN = process.env.L03_PIPELINE_RUN_DISPOSABLE_TESTS === "1";
const POSTGRES_16 = "postgres@sha256:33f923b05f64ca54ac4401c01126a6b92afe839a0aa0a52bc5aeb5cc958e5f20";
const DATABASE = "l03_pipeline_rehearsal";
const SKIPPED = new Set([
  "20260514161714_supabase_ai_verification_cron.sql",
  "20260514163203_scheduler_v2_sales_ready_pipeline.sql",
]);

const TENANT = "11111111-1111-4111-8111-1111111111a1";
const WORKSPACE = "22222222-2222-4222-8222-2222222222a1";
const ACTOR = "33333333-3333-4333-8333-3333333333a1";
const MEMBERSHIP = "44444444-4444-4444-8444-4444444444a1";
const BINDING = "55555555-5555-4555-8555-5555555555a1";
const TENANT_B = "11111111-1111-4111-8111-1111111111b1";
const WORKSPACE_B = "22222222-2222-4222-8222-2222222222b1";
const MEMBERSHIP_B = "44444444-4444-4444-8444-4444444444b1";
const BINDING_B = "55555555-5555-4555-8555-5555555555b1";
const DOCUMENT = "66666666-6666-4666-8666-6666666666a1";
const VERSION = "77777777-7777-4777-8777-7777777777a1";
const EXTRACTION_JOB = "88888888-8888-4888-8888-8888888888a1";
const DELETION_REQUEST = "99999999-9999-4999-8999-9999999999a1";
const URL_DOCUMENT = "66666666-6666-4666-8666-6666666666b1";
const URL_VERSION = "77777777-7777-4777-8777-7777777777b1";
const URL_VERSION_2 = "77777777-7777-4777-8777-7777777777b2";
const URL_DOCUMENT_3 = "66666666-6666-4666-8666-6666666666b3";

const POLICY_VERSION = "launch-v1";
const SIGNING_SECRET = "l03-rehearsal-signing-secret-0123456789abcdef";
const UPLOAD_ORIGIN = "https://uploads.rehearsal.test";

const CSV_TEXT = "name,role\nAda Lovelace,founder\nGrace Hopper,advisor\n";
const CSV_BYTES = new TextEncoder().encode(CSV_TEXT);
const CSV_CHECKSUM = createHash("sha256").update(CSV_BYTES).digest("hex");

let container = "";
let admin: Sql | undefined;
let rootDir = "";

interface TransactionContextInstaller {
  installTransactionLocalContext(entries: readonly (readonly [string, string])[]): Promise<void>;
}

function docker(args: string[], allowFailure = false): string {
  try {
    return execFileSync("docker", args, {
      encoding: "utf8",
      stdio: ["ignore", "pipe", allowFailure ? "ignore" : "pipe"],
    }).trim();
  } catch (error) {
    if (allowFailure) return "";
    throw error;
  }
}

function waitForPostgres(name: string): void {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    if (docker(["exec", name, "pg_isready", "-h", "127.0.0.1", "-U", "postgres"], true).includes("accepting")) return;
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 250);
  }
  throw new Error(`PostgreSQL did not become ready: ${docker(["logs", name], true)}`);
}

async function replayAllMigrations(sql: Sql): Promise<void> {
  await sql.unsafe("CREATE SCHEMA IF NOT EXISTS auth");
  await sql.unsafe("CREATE TABLE IF NOT EXISTS auth.users (id uuid PRIMARY KEY)");
  await sql.unsafe(`DO $$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='anon') THEN CREATE ROLE anon NOLOGIN; END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='authenticated') THEN CREATE ROLE authenticated NOLOGIN; END IF;
  END $$`);
  await sql.unsafe(`CREATE TABLE IF NOT EXISTS public.worker_runs (
    id text PRIMARY KEY, worker_name text NOT NULL, status text NOT NULL DEFAULT 'running',
    trigger_source text NOT NULL DEFAULT 'unknown', http_status integer,
    result_json jsonb NOT NULL DEFAULT '{}'::jsonb, error text,
    started_at timestamptz NOT NULL DEFAULT now(), completed_at timestamptz,
    created_at timestamptz NOT NULL DEFAULT now()
  )`);
  const migrations = readdirSync(resolve("supabase/migrations"))
    .filter((file) => file.endsWith(".sql")).sort();
  let applied = 0;
  for (const file of migrations) {
    if (SKIPPED.has(file)) continue;
    try {
      await sql.unsafe(readFileSync(join("supabase", "migrations", file), "utf8"));
    } catch (error) {
      const failure = error as { message?: string; position?: string };
      throw new Error(`${file}:${failure.position ?? "unknown"}:${failure.message ?? "migration failed"}`);
    }
    applied += 1;
    if (file === "202605110001_full_schema.sql") {
      await sql.unsafe(`ALTER TABLE public.settings
        ADD COLUMN IF NOT EXISTS scheduler_ai_verification_enabled integer NOT NULL DEFAULT 1,
        ADD COLUMN IF NOT EXISTS scheduler_crawl_enabled integer NOT NULL DEFAULT 1,
        ADD COLUMN IF NOT EXISTS scheduler_enrichment_enabled integer NOT NULL DEFAULT 1,
        ADD COLUMN IF NOT EXISTS scheduler_artifact_enabled integer NOT NULL DEFAULT 1,
        ADD COLUMN IF NOT EXISTS scheduler_score_recompute_enabled integer NOT NULL DEFAULT 1`);
      await sql.unsafe(`ALTER TABLE public.leads
        ADD COLUMN IF NOT EXISTS ai_website_feedback_status text,
        ADD COLUMN IF NOT EXISTS ai_corrected_website_url text,
        ADD COLUMN IF NOT EXISTS ai_false_positive_reason text,
        ADD COLUMN IF NOT EXISTS ai_reviewer_notes text,
        ADD COLUMN IF NOT EXISTS ai_feedback_at timestamptz`);
    }
  }
  expect({ discovered: migrations.length, applied, skipped: SKIPPED.size })
    .toEqual({ discovered: 91, applied: 89, skipped: 2 });
}

function memberEntries(
  tenantId: string,
  workspaceId: string,
  membershipId: string,
  bindingId: string,
): [string, string][] {
  return [
    ["app.tenant_id", tenantId],
    ["app.workspace_id", workspaceId],
    ["app.actor_id", ACTOR],
    ["app.membership_id", membershipId],
    ["app.role", "admin"],
    ["app.role_binding_id", bindingId],
    ["app.correlation_id", `rehearsal-member-${randomUUID()}`],
  ];
}

const MEMBER_A = () => memberEntries(TENANT, WORKSPACE, MEMBERSHIP, BINDING);
const MEMBER_B = () => memberEntries(TENANT_B, WORKSPACE_B, MEMBERSHIP_B, BINDING_B);

async function memberTx<T>(
  entries: [string, string][],
  fn: (db: DbClient) => Promise<T>,
): Promise<T> {
  return withDbTransaction(async () => {
    const db = await getDb();
    const installer = db as DbClient & Partial<TransactionContextInstaller>;
    if (typeof installer.installTransactionLocalContext !== "function") {
      throw new Error("database client cannot install transaction-local context");
    }
    await installer.installTransactionLocalContext(entries);
    return fn(db);
  });
}

function workerScope(
  action: DocumentPipelineWorkerScope["action"],
  overrides: Partial<DocumentPipelineWorkerScope> = {},
): DocumentPipelineWorkerScope {
  return {
    tenantId: null,
    workspaceId: null,
    jobId: randomUUID(),
    runId: randomUUID(),
    leaseId: randomUUID(),
    leaseGeneration: 1,
    action,
    principalKind: "cron",
    correlationId: `rehearsal-worker-${randomUUID()}`,
    ...overrides,
  };
}

const store = () => createLocalDocumentStore({
  rootDir,
  signingSecret: SIGNING_SECRET,
  uploadOrigin: UPLOAD_ORIGIN,
});

const scanner = () => createLocalDocumentScanner({ rootDir });

describe.skipIf(!RUN)("L-03 document pipeline PostgreSQL rehearsal", () => {
  beforeAll(async () => {
    container = `novatrade-l03-${randomUUID()}`;
    docker(["run", "--detach", "--rm", "--name", container, "--publish", "127.0.0.1::5432",
      "--env", "POSTGRES_PASSWORD=postgres", "--env", `POSTGRES_DB=${DATABASE}`, POSTGRES_16]);
    waitForPostgres(container);
    const port = docker(["port", container, "5432/tcp"]).split(":").at(-1);
    if (!port) throw new Error("Disposable PostgreSQL port was not published");
    const url = `postgres://postgres:postgres@127.0.0.1:${port}/${DATABASE}`;
    admin = postgres(url, { max: 1, prepare: false, ssl: false, onnotice: () => undefined });
    const [{ version }] = await admin.unsafe<Array<{ version: string }>>(
      "SELECT current_setting('server_version_num') version");
    expect(version.startsWith("16")).toBe(true);
    await replayAllMigrations(admin);
    await admin.unsafe(`INSERT INTO public.tenants(id,slug,name,status) VALUES
      ('${TENANT}','l03-a','L03 Tenant A','active'),('${TENANT_B}','l03-b','L03 Tenant B','active');
      INSERT INTO public.workspaces(id,tenant_id,slug,name,status) VALUES
      ('${WORKSPACE}','${TENANT}','l03-wa','L03 Workspace A','active'),
      ('${WORKSPACE_B}','${TENANT_B}','l03-wb','L03 Workspace B','active');
      INSERT INTO public.tenant_memberships(id,tenant_id,auth_identity_id,workspace_id,status) VALUES
      ('${MEMBERSHIP}','${TENANT}','${ACTOR}',NULL,'active'),
      ('${MEMBERSHIP_B}','${TENANT_B}','${ACTOR}',NULL,'active');
      INSERT INTO public.tenant_role_bindings(id,tenant_id,membership_id,role,valid_from) VALUES
      ('${BINDING}','${TENANT}','${MEMBERSHIP}','admin',pg_catalog.now()),
      ('${BINDING_B}','${TENANT_B}','${MEMBERSHIP_B}','admin',pg_catalog.now());
      INSERT INTO public.tenant_policies(tenant_id) VALUES ('${TENANT}'),('${TENANT_B}')`);
    rootDir = mkdtempSync(join(tmpdir(), "l03-store-"));
    process.env.DATABASE_URL = url;
    process.env.DATABASE_SSL = "disable";
  }, 180_000);

  afterAll(async () => {
    await admin?.end({ timeout: 1 });
    if (container) docker(["rm", "--force", container], true);
    if (rootDir) rmSync(rootDir, { recursive: true, force: true });
  });

  it("drives intake, scan, extraction, knowledge, retention, and deletion end-to-end", async () => {
    // -- Member: reserve a private upload reservation (0X3-238) --------------
    const initiated = await memberTx(MEMBER_A(), (db) =>
      initiateDocumentIntake({
        tenantId: TENANT,
        workspaceId: WORKSPACE,
        documentId: DOCUMENT,
        versionId: VERSION,
        idempotencyKey: "l03-upload-1",
        fileName: "roster.csv",
        declaredMediaType: "text/csv",
        declaredByteSize: CSV_BYTES.byteLength,
        scannerPolicyVersion: POLICY_VERSION,
      }, {
        repository: createPostgresDocumentIntakeRepository(db),
        storage: store(),
      }));
    expect(initiated.kind).toBe("created");
    expect(initiated.record.state).toBe("upload_reserved");
    expect(initiated.record.objectKey)
      .toBe(`tenants/${TENANT}/documents/${DOCUMENT}/versions/${VERSION}/original`);
    expect(initiated.upload.visibility).toBe("private");

    // -- Signed upload lands in the private store -----------------------------
    const query = Object.fromEntries(new URL(initiated.upload.uploadUrl).searchParams);
    const capability = store().verifyUploadCapability(query);
    const accepted = await store().acceptSignedUpload({
      capability,
      bytes: CSV_BYTES,
      contentType: "text/csv",
    });
    expect(accepted.objectKey).toBe(initiated.record.objectKey);

    // -- Member: complete upload; version quarantines + scan job is staged ----
    const dispatched: ScanOutboxMessage[] = [];
    const completed = await memberTx(MEMBER_A(), (db) =>
      completeDocumentUpload({
        tenantId: TENANT,
        workspaceId: WORKSPACE,
        documentId: DOCUMENT,
        versionId: VERSION,
        idempotencyKey: "l03-upload-1",
      }, {
        repository: createPostgresDocumentIntakeRepository(db),
        reader: store(),
        outbox: {
          async dispatch(message) {
            dispatched.push(message);
            return { dispatchKey: message.dispatchKey, status: "accepted" };
          },
        },
      }));
    expect(completed.kind).toBe("quarantined");
    expect(completed.record.state).toBe("quarantined");
    expect(completed.record.checksum).toBe(CSV_CHECKSUM);
    expect(dispatched).toHaveLength(1);
    const scanJobId = dispatched[0].jobId;

    // -- Worker: discovery claim picks up the quarantine scan (0X3-239) -------
    const scanClaim = await runDocumentPipelineDb(
      workerScope("document_scan:process"),
      (db) => claimDocumentScanJob({ jobId: null }, {
        repository: createPostgresDocumentIntakeRepository(db),
      }),
    );
    if (scanClaim.kind !== "leased") throw new Error(`scan claim failed: ${scanClaim.kind}`);
    const scanLease: ClaimedDocumentScanLease = scanClaim.lease;
    expect(scanLease.jobId).toBe(scanJobId);
    expect(scanLease.tenantId).toBe(TENANT);
    expect(scanLease.state).toBe("quarantined");

    const scanRequest: PersistDocumentScanResultRequest = await executeDocumentScan(scanLease, {
      scanner: scanner(),
    });
    expect(scanRequest.state).toBe("clean");

    // A scope carrying a different lease generation must be fenced out.
    await expect(runDocumentPipelineDb(
      workerScope("document_scan:process", {
        tenantId: TENANT,
        workspaceId: WORKSPACE,
        jobId: scanLease.jobId,
        leaseGeneration: scanLease.leaseGeneration + 1,
      }),
      (db) => persistDocumentScanResult(scanRequest, {
        repository: createPostgresDocumentIntakeRepository(db),
      }),
    )).rejects.toMatchObject({ name: "DocumentIntakeError" });

    const persistedScan = await runDocumentPipelineDb(
      workerScope("document_scan:process", {
        tenantId: scanLease.tenantId,
        workspaceId: scanLease.workspaceId,
        jobId: scanLease.jobId,
        leaseGeneration: scanLease.leaseGeneration,
      }),
      (db) => persistDocumentScanResult(scanRequest, {
        repository: createPostgresDocumentIntakeRepository(db),
      }),
    );
    expect(persistedScan.state).toBe("clean");
    expect(persistedScan.retryScheduled).toBe(false);

    // -- Member: request extraction of the clean version (0X3-240) ------------
    const extractionRequest = await memberTx(MEMBER_A(), (db) =>
      requestDocumentExtraction({
        tenantId: TENANT,
        workspaceId: WORKSPACE,
        documentId: DOCUMENT,
        versionId: VERSION,
        jobId: EXTRACTION_JOB,
        idempotencyKey: "l03-extract-1",
        checksum: CSV_CHECKSUM,
        scannerPolicyVersion: POLICY_VERSION,
        format: "csv",
        mediaType: "text/csv",
      }, {
        repository: createPostgresDocumentPipelineRepository(db),
      }));
    expect(extractionRequest.kind).toBe("queued");
    expect(extractionRequest.jobId).toBe(EXTRACTION_JOB);

    // -- Worker: discovery claim, deterministic parse, fenced finalize --------
    const extractionClaim = await runDocumentPipelineDb(
      workerScope("document_extraction:process"),
      (db) => claimDocumentExtractionJob({ jobId: null }, {
        repository: createPostgresDocumentPipelineRepository(db),
      }),
    );
    if (extractionClaim.kind !== "leased") {
      throw new Error(`extraction claim failed: ${extractionClaim.kind}`);
    }
    const extractionLease: ClaimedExtractionLease = extractionClaim.lease;
    expect(extractionLease.jobId).toBe(EXTRACTION_JOB);
    expect(extractionLease.parserId).toBe("launch-csv-records");

    const finalizeRequest = await executeDocumentExtraction(extractionLease, {
      reader: store(),
      proposeClaims: ({ citations }) => {
        if (citations.length === 0) return [];
        const proposals: KnowledgeClaimProposal[] = [{
          claimClass: "customer_provided_strategic_fact",
          subject: "Nova Trade",
          predicate: "employs",
          value: "Ada Lovelace",
          unit: null,
          polarity: "positive",
          material: true,
          confidenceBasisPoints: 9000,
          uncertainty: null,
          citationIds: [citations[0].citationId],
        }];
        return proposals;
      },
    });
    expect(finalizeRequest.outcome === "complete" || finalizeRequest.outcome === "review_required")
      .toBe(true);
    expect(finalizeRequest.output).not.toBeNull();
    expect(finalizeRequest.output?.evidence?.length ?? 0).toBeGreaterThan(0);
    expect(finalizeRequest.output?.claims?.length ?? 0).toBe(1);

    const finalized = await runDocumentPipelineDb(
      workerScope("document_extraction:process", {
        tenantId: extractionLease.tenantId,
        workspaceId: extractionLease.workspaceId,
        jobId: extractionLease.jobId,
        leaseGeneration: extractionLease.leaseGeneration,
      }),
      (db) => finalizeDocumentExtraction(finalizeRequest, {
        repository: createPostgresDocumentPipelineRepository(db),
      }),
    );
    expect(finalized.kind === "persisted" || finalized.kind === "already_persisted").toBe(true);

    // -- Member: knowledge query + review surface (0X3-241) --------------------
    const summaries = await memberTx(MEMBER_A(), (db) =>
      listKnowledgeDocuments({ tenantId: TENANT, workspaceId: WORKSPACE }, {
        repository: createPostgresKnowledgeQueryRepository(db),
      }));
    const summary = summaries.find((row) => row.documentId === DOCUMENT);
    expect(summary).toBeDefined();
    expect(summary?.evidenceCount).toBeGreaterThan(0);
    expect(summary?.claimCount).toBe(1);

    const knowledge = await memberTx(MEMBER_A(), (db) =>
      getDocumentKnowledge({
        tenantId: TENANT,
        workspaceId: WORKSPACE,
        documentId: DOCUMENT,
        versionId: VERSION,
      }, {
        repository: createPostgresKnowledgeQueryRepository(db),
      }));
    expect(knowledge.evidence.length).toBeGreaterThan(0);
    expect(knowledge.claims).toHaveLength(1);
    const claim = knowledge.claims[0];
    expect(claim.reviewState).toBe("proposed");
    const citationId = knowledge.evidence.find((row) => row.citationId !== null)?.citationId;
    expect(citationId).toBeDefined();

    const resolved = await memberTx(MEMBER_A(), (db) =>
      resolveKnowledgeCitation({ tenantId: TENANT, workspaceId: WORKSPACE, citationId: citationId as string }, {
        repository: createPostgresKnowledgeQueryRepository(db),
      }));
    expect(resolved?.citationId).toBe(citationId);
    expect(resolved?.quote.length ?? 0).toBeGreaterThan(0);

    // A different tenant cannot resolve the citation (0X3-242 tenant isolation).
    const foreign = await memberTx(MEMBER_B(), (db) =>
      resolveKnowledgeCitation({ tenantId: TENANT_B, workspaceId: WORKSPACE_B, citationId: citationId as string }, {
        repository: createPostgresKnowledgeQueryRepository(db),
      }));
    expect(foreign).toBeUndefined();

    const reviewed = await memberTx(MEMBER_A(), (db) =>
      reviewKnowledgeClaim({
        tenantId: TENANT,
        workspaceId: WORKSPACE,
        claimId: claim.claimId,
        claimVersionId: claim.claimVersionId,
        action: "approve",
        reasonCode: "verified_against_source",
        idempotencyKey: "l03-review-1",
      }, {
        repository: createPostgresKnowledgeQueryRepository(db),
      }));
    expect(reviewed.kind).toBe("applied");
    if (reviewed.kind === "applied") expect(reviewed.reviewState).toBe("accepted");

    // -- Worker: retention sweep sees the live version but defers (0X3-242) ---
    const retentionSubjects = await runDocumentPipelineDb(
      workerScope("document_retention:evaluate"),
      (db) => discoverDocumentRetentionSubjects({ limit: 10 }, {
        repository: createPostgresDocumentPipelineRepository(db),
      }),
    );
    expect(Array.isArray(retentionSubjects)).toBe(true);

    const retention = await runDocumentPipelineDb(
      workerScope("document_retention:evaluate", {
        tenantId: TENANT,
        workspaceId: WORKSPACE,
        jobId: randomUUID(),
      }),
      (db) => evaluateDocumentRetention({
        tenantId: TENANT,
        workspaceId: WORKSPACE,
        documentId: DOCUMENT,
        versionId: VERSION,
      }, {
        repository: createPostgresDocumentPipelineRepository(db),
      }),
    );
    expect(retention.kind === "deferred" || retention.kind === "recorded").toBe(true);
    if (retention.kind === "deferred") expect(retention.disposition).toBe("retain");

    // -- Member requests deletion; worker applies it under the request fence --
    const deletion = await memberTx(MEMBER_A(), (db) =>
      submitDocumentDeletionRequest({
        tenantId: TENANT,
        workspaceId: WORKSPACE,
        documentId: DOCUMENT,
        versionId: VERSION,
        requestId: DELETION_REQUEST,
        reasonCode: "member_requested",
      }, {
        repository: createPostgresDocumentPipelineRepository(db),
      }));
    expect(deletion.kind).toBe("requested");

    const pendingDeletes = await runDocumentPipelineDb(
      workerScope("document_retention:delete"),
      (db) => discoverDocumentDeletionRequests({ limit: 10 }, {
        repository: createPostgresDocumentPipelineRepository(db),
      }),
    );
    expect(pendingDeletes.some((row) => row.requestId === DELETION_REQUEST)).toBe(true);

    const applied = await runDocumentPipelineDb(
      workerScope("document_retention:delete", {
        tenantId: TENANT,
        workspaceId: WORKSPACE,
        jobId: DELETION_REQUEST,
      }),
      (db) => applyDocumentDeletion({ requestId: DELETION_REQUEST }, {
        repository: createPostgresDocumentPipelineRepository(db),
        remover: store(),
      }),
    );
    expect(applied.kind).toBe("applied");
    if (applied.kind === "applied" || applied.kind === "replay") {
      expect(applied.versionState).toBe("deleted");
    }
    expect(await readLocalDocumentObject(rootDir, initiated.record.objectKey)).toBeNull();

    // Deleted versions stop resolving citations for members.
    const gone = await memberTx(MEMBER_A(), (db) =>
      resolveKnowledgeCitation({ tenantId: TENANT, workspaceId: WORKSPACE, citationId: citationId as string }, {
        repository: createPostgresKnowledgeQueryRepository(db),
      }));
    expect(gone).toBeUndefined();
  });

  it("rehearses SSRF-guarded URL intake with normal and adversarial fixtures", async () => {
    const lookupFor =
      (records: Record<string, string>) =>
      async (hostname: string): Promise<readonly { address: string; family: number }[]> => {
        const address = records[hostname];
        return address ? [{ address, family: 4 }] : [];
      };
    const csvResponse = () =>
      new Response(CSV_BYTES.slice(), {
        status: 200,
        headers: {
          "content-type": "text/csv",
          "content-length": String(CSV_BYTES.byteLength),
        },
      });
    const publicHost = { "docs.rehearsal-cdn.example": "93.184.216.34" };

    // -- Member: fetch a supported document through the SSRF guard (0X3-239) --
    const url = "https://docs.rehearsal-cdn.example/team/roster.csv";
    const urlSha = createHash("sha256").update(new URL(url).toString()).digest("hex");
    const ingested = await memberTx(MEMBER_A(), (db) =>
      intakeDocumentFromUrl({
        tenantId: TENANT,
        workspaceId: WORKSPACE,
        documentId: URL_DOCUMENT,
        requestId: randomUUID(),
        idempotencyKey: "l03-url-1",
        url,
        requestedName: "roster.csv",
        scannerPolicyVersion: POLICY_VERSION,
      }, {
        repository: createPostgresDocumentUrlIntakeRepository(db),
        writer: store(),
        lookupImpl: lookupFor(publicHost),
        fetchImpl: async () => csvResponse(),
        createVersionId: () => URL_VERSION,
      }));
    expect(ingested.kind).toBe("quarantined");
    if (ingested.kind !== "quarantined") throw new Error("URL intake did not quarantine");
    expect(ingested.versionId).toBe(URL_VERSION);
    expect(ingested.checksum).toBe(CSV_CHECKSUM);
    expect(ingested.processingVersionId).toBe(URL_VERSION);
    expect(ingested.scanJobId).toMatch(/^[0-9a-f-]{36}$/u);
    expect(ingested.dispatchKey).toContain(URL_VERSION);

    // The URL source is durably recorded and resolvable under tenant scope.
    const source = await memberTx(MEMBER_A(), (db) =>
      lookupDocumentUrlSource({ tenantId: TENANT, workspaceId: WORKSPACE, urlSha256: urlSha }, {
        repository: createPostgresDocumentUrlIntakeRepository(db),
      }));
    expect(source?.documentId).toBe(URL_DOCUMENT);
    expect(source?.normalizedUrl).toBe(url);

    // -- Worker: the URL-ingested version scans against the stored bytes -----
    const urlScanClaim = await runDocumentPipelineDb(
      workerScope("document_scan:process"),
      (db) => claimDocumentScanJob({ jobId: null }, {
        repository: createPostgresDocumentIntakeRepository(db),
      }),
    );
    if (urlScanClaim.kind !== "leased") {
      throw new Error(`URL scan claim failed: ${urlScanClaim.kind}`);
    }
    expect(urlScanClaim.lease.versionId).toBe(URL_VERSION);
    expect(urlScanClaim.lease.objectKey)
      .toBe(`tenants/${TENANT}/documents/${URL_DOCUMENT}/versions/${URL_VERSION}/original`);
    expect(urlScanClaim.lease.checksum).toBe(CSV_CHECKSUM);

    const urlScanRequest = await executeDocumentScan(urlScanClaim.lease, {
      scanner: scanner(),
    });
    expect(urlScanRequest.state).toBe("clean");
    const urlScanPersisted = await runDocumentPipelineDb(
      workerScope("document_scan:process", {
        tenantId: TENANT,
        workspaceId: WORKSPACE,
        jobId: urlScanClaim.lease.jobId,
        leaseGeneration: urlScanClaim.lease.leaseGeneration,
      }),
      (db) => persistDocumentScanResult(urlScanRequest, {
        repository: createPostgresDocumentIntakeRepository(db),
      }),
    );
    expect(urlScanPersisted.state).toBe("clean");
    const stored = await readLocalDocumentObject(rootDir, urlScanClaim.lease.objectKey);
    expect(stored).toEqual(CSV_BYTES);

    // -- Duplicate: same URL + same bytes dedupes to the canonical version ---
    const duplicate = await memberTx(MEMBER_A(), (db) =>
      intakeDocumentFromUrl({
        tenantId: TENANT,
        workspaceId: WORKSPACE,
        documentId: URL_DOCUMENT,
        requestId: randomUUID(),
        idempotencyKey: "l03-url-2",
        url,
        requestedName: "roster.csv",
        scannerPolicyVersion: POLICY_VERSION,
      }, {
        repository: createPostgresDocumentUrlIntakeRepository(db),
        writer: store(),
        lookupImpl: lookupFor(publicHost),
        fetchImpl: async () => csvResponse(),
        createVersionId: () => URL_VERSION_2,
      }));
    expect(duplicate.kind).toBe("duplicate");
    if (duplicate.kind === "duplicate") {
      expect(duplicate.versionId).toBe(URL_VERSION_2);
      expect(duplicate.processingVersionId).toBe(URL_VERSION);
    }

    // -- Conflict: a different document cannot claim the same URL source ------
    await expect(memberTx(MEMBER_A(), (db) =>
      intakeDocumentFromUrl({
        tenantId: TENANT,
        workspaceId: WORKSPACE,
        documentId: URL_DOCUMENT_3,
        requestId: randomUUID(),
        idempotencyKey: "l03-url-3",
        url,
        requestedName: "roster.csv",
        scannerPolicyVersion: POLICY_VERSION,
      }, {
        repository: createPostgresDocumentUrlIntakeRepository(db),
        writer: store(),
        lookupImpl: lookupFor(publicHost),
        fetchImpl: async () => csvResponse(),
      }))).rejects.toMatchObject({ name: "DocumentIntakeError", code: "idempotency_conflict" });

    // -- SSRF: literal private/link-local IP is blocked before any fetch -----
    const metadataUrl = "http://169.254.169.254/latest/meta-data";
    const metadataInput = {
      tenantId: TENANT,
      workspaceId: WORKSPACE,
      documentId: randomUUID(),
      requestId: randomUUID(),
      idempotencyKey: "l03-url-blocked-1",
      url: metadataUrl,
      requestedName: "meta.csv",
      scannerPolicyVersion: POLICY_VERSION,
    };
    let metadataFetched = false;
    const blocked = await memberTx(MEMBER_A(), (db) =>
      intakeDocumentFromUrl(metadataInput, {
        repository: createPostgresDocumentUrlIntakeRepository(db),
        writer: store(),
        fetchImpl: async () => {
          metadataFetched = true;
          return csvResponse();
        },
      }));
    expect(metadataFetched).toBe(false);
    expect(blocked).toMatchObject({
      kind: "failed",
      state: "blocked_security",
      reasonCode: "unsafe_outbound_url",
    });

    // The durable request landed in a terminal blocked state; replay is a no-op
    // and never touches the network again.
    let replayFetched = false;
    const blockedReplay = await memberTx(MEMBER_A(), (db) =>
      intakeDocumentFromUrl(metadataInput, {
        repository: createPostgresDocumentUrlIntakeRepository(db),
        writer: store(),
        fetchImpl: async () => {
          replayFetched = true;
          return csvResponse();
        },
      }));
    expect(blockedReplay).toMatchObject({ kind: "replay", state: "blocked_security" });
    expect(replayFetched).toBe(false);

    // DNS-resolved private address is blocked the same way.
    const dnsBlocked = await memberTx(MEMBER_A(), (db) =>
      intakeDocumentFromUrl({
        ...metadataInput,
        documentId: randomUUID(),
        requestId: randomUUID(),
        idempotencyKey: "l03-url-blocked-2",
        url: "https://attacker-internal.example/x.csv",
      }, {
        repository: createPostgresDocumentUrlIntakeRepository(db),
        writer: store(),
        lookupImpl: lookupFor({ "attacker-internal.example": "10.0.0.9" }),
        fetchImpl: async () => csvResponse(),
      }));
    expect(dnsBlocked).toMatchObject({ kind: "failed", state: "blocked_security" });

    // A redirect target is re-resolved: redirecting to a loopback IP is blocked.
    const redirectBlocked = await memberTx(MEMBER_A(), (db) =>
      intakeDocumentFromUrl({
        ...metadataInput,
        documentId: randomUUID(),
        requestId: randomUUID(),
        idempotencyKey: "l03-url-blocked-3",
        url: "https://docs.rehearsal-cdn.example/redirect",
      }, {
        repository: createPostgresDocumentUrlIntakeRepository(db),
        writer: store(),
        lookupImpl: lookupFor(publicHost),
        fetchImpl: async () => new Response(null, {
          status: 302,
          headers: { location: "http://127.0.0.1:8080/internal" },
        }),
      }));
    expect(redirectBlocked).toMatchObject({ kind: "failed", state: "blocked_security" });

    // More redirects than the policy allows terminate as blocked.
    const loopBlocked = await memberTx(MEMBER_A(), (db) =>
      intakeDocumentFromUrl({
        ...metadataInput,
        documentId: randomUUID(),
        requestId: randomUUID(),
        idempotencyKey: "l03-url-blocked-4",
        url: "https://docs.rehearsal-cdn.example/loop",
      }, {
        repository: createPostgresDocumentUrlIntakeRepository(db),
        writer: store(),
        lookupImpl: lookupFor(publicHost),
        fetchImpl: async (input) => new Response(null, {
          status: 302,
          headers: { location: new URL("/loop", input.toString()).toString() },
        }),
      }));
    expect(loopBlocked).toMatchObject({ kind: "failed", state: "blocked_security" });

    // -- Rejected: unsupported media type lands the request in `rejected` ----
    const rejectedInput = {
      ...metadataInput,
      documentId: randomUUID(),
      requestId: randomUUID(),
      idempotencyKey: "l03-url-rejected-1",
      url: "https://docs.rehearsal-cdn.example/blob.bin",
    };
    const mediaRejected = await memberTx(MEMBER_A(), (db) =>
      intakeDocumentFromUrl(rejectedInput, {
        repository: createPostgresDocumentUrlIntakeRepository(db),
        writer: store(),
        lookupImpl: lookupFor(publicHost),
        fetchImpl: async () => new Response(new Uint8Array([1, 2, 3]), {
          status: 200,
          headers: { "content-type": "application/octet-stream" },
        }),
      }));
    expect(mediaRejected).toMatchObject({
      kind: "failed",
      state: "rejected",
      reasonCode: "unsupported_media_type",
    });
    const rejectedReplay = await memberTx(MEMBER_A(), (db) =>
      intakeDocumentFromUrl(rejectedInput, {
        repository: createPostgresDocumentUrlIntakeRepository(db),
        writer: store(),
        fetchImpl: async () => csvResponse(),
      }));
    expect(rejectedReplay).toMatchObject({ kind: "replay", state: "rejected" });

    // A non-200 response is rejected rather than stored.
    const missingRejected = await memberTx(MEMBER_A(), (db) =>
      intakeDocumentFromUrl({
        ...rejectedInput,
        documentId: randomUUID(),
        requestId: randomUUID(),
        idempotencyKey: "l03-url-rejected-2",
        url: "https://docs.rehearsal-cdn.example/missing.csv",
      }, {
        repository: createPostgresDocumentUrlIntakeRepository(db),
        writer: store(),
        lookupImpl: lookupFor(publicHost),
        fetchImpl: async () => new Response("not found", { status: 404 }),
      }));
    expect(missingRejected).toMatchObject({
      kind: "failed",
      state: "rejected",
      reasonCode: "fetch_rejected",
    });

    // A declared length over the document cap is rejected without reading.
    const oversizedRejected = await memberTx(MEMBER_A(), (db) =>
      intakeDocumentFromUrl({
        ...rejectedInput,
        documentId: randomUUID(),
        requestId: randomUUID(),
        idempotencyKey: "l03-url-rejected-3",
        url: "https://docs.rehearsal-cdn.example/huge.csv",
      }, {
        repository: createPostgresDocumentUrlIntakeRepository(db),
        writer: store(),
        lookupImpl: lookupFor(publicHost),
        fetchImpl: async () => new Response(CSV_BYTES.slice(), {
          status: 200,
          headers: {
            "content-type": "text/csv",
            "content-length": String(52_428_801),
          },
        }),
      }));
    expect(oversizedRejected).toMatchObject({
      kind: "failed",
      state: "rejected",
      reasonCode: "content_too_large",
    });

    // -- Isolation: tenant B cannot see tenant A's URL source -----------------
    const foreignSource = await memberTx(MEMBER_B(), (db) =>
      lookupDocumentUrlSource({ tenantId: TENANT_B, workspaceId: WORKSPACE_B, urlSha256: urlSha }, {
        repository: createPostgresDocumentUrlIntakeRepository(db),
      }));
    expect(foreignSource).toBeUndefined();
  });
});
