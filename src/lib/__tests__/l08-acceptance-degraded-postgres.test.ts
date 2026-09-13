/**
 * L-08 acceptance: disposable-PostgreSQL degraded-path proofs.
 *
 * Covers the guarantees an HTTP lane cannot reach:
 *  - migration apply + rollback for both L-08 fix migrations, proven by
 *    capturing pre-migration function/constraint definitions and restoring
 *    them, then re-applying;
 *  - agent-run enqueue replay/idempotency and divergent-input conflict at the
 *    member-gated RPC;
 *  - worker stale-lease crash recovery and lease-token redaction at the
 *    worker-gated RPC;
 *  - connector provider-budget auto-pause at the service layer with an
 *    injected fixture executor (the HTTP fixture registry is intentionally
 *    empty, so the route can never demonstrate exhaustion);
 *  - suppression lifecycle dominance (deletion_pending blocks contact use)
 *    at the repository/service layer.
 *
 * Opt-in: requires Docker. Run with L08_ACCEPTANCE_RUN_DISPOSABLE_TESTS=1.
 */
import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";

import postgres, { type Sql } from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createPostgresConnectorCommandRepository } from "../connectors/command-repository";
import { createPostgresConnectorAuthorityRepository } from "../connectors/repository";
import {
  createSourceRun,
  executeNextSourceUnit,
  type ConnectorAuditSink,
  type ConnectorServiceDeps,
} from "../connectors/service";
import { createPostgresSuppressionRepository } from "../suppressions/repository";
import {
  recordSuppression,
  resolveSuppression,
  type SuppressionServiceDeps,
} from "../suppressions/service";
import { closeDb, getDb } from "../db/index";

const RUN = process.env.L08_ACCEPTANCE_RUN_DISPOSABLE_TESTS === "1";
const POSTGRES_16 =
  "postgres@sha256:33f923b05f64ca54ac4401c01126a6b92afe839a0aa0a52bc5aeb5cc958e5f20";
const DATABASE = "l08_acceptance_rehearsal";
const SKIPPED = new Set([
  "20260514161714_supabase_ai_verification_cron.sql",
  "20260514163203_scheduler_v2_sales_ready_pipeline.sql",
]);
// The L-08 fix migrations are replayed manually inside the apply/rollback
// proofs so each migration's before/after behaviour is observable.
const FIX_RUN_GUARD = "20260916000200_fix_l05_run_guard_running_selfloop.sql";
const FIX_AGENT_LEASE = "20260916000300_add_agent_runtime_worker_lease.sql";

const TENANT = "b0000000-0000-4000-8000-0000000000a1";
const WORKSPACE = "b1000000-0000-4000-8000-0000000000a1";
const ACTOR = "b2000000-0000-4000-8000-0000000000a1";
const MEMBERSHIP = "b3000000-0000-4000-8000-0000000000a1";
const BINDING = "b4000000-0000-4000-8000-0000000000a1";
const ACCOUNT = "b5000000-0000-4000-8000-0000000000a1";

const sha256hex = (value: string) =>
  createHash("sha256").update(value, "utf8").digest("hex");

let container = "";
let sql: Sql | undefined;

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
    if (docker([
      "exec", name, "psql", "-X", "-v", "ON_ERROR_STOP=1", "-U", "postgres",
      "-d", DATABASE, "-Atc", "SELECT 1",
    ], true) === "1") return;
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 250);
  }
  throw new Error(`PostgreSQL did not become ready: ${docker(["logs", name], true)}`);
}

async function replayBaseMigrations(db: Sql): Promise<void> {
  await db.unsafe("CREATE SCHEMA IF NOT EXISTS auth");
  await db.unsafe("CREATE TABLE IF NOT EXISTS auth.users (id uuid PRIMARY KEY)");
  await db.unsafe(`DO $$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='anon') THEN CREATE ROLE anon NOLOGIN; END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='authenticated') THEN CREATE ROLE authenticated NOLOGIN; END IF;
  END $$`);
  await db.unsafe(`CREATE TABLE IF NOT EXISTS public.worker_runs (
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
    if (SKIPPED.has(file) || file === FIX_RUN_GUARD || file === FIX_AGENT_LEASE) continue;
    await db.unsafe(readFileSync(join("supabase", "migrations", file), "utf8"));
    applied += 1;
    if (file === "202605110001_full_schema.sql") {
      await db.unsafe(`ALTER TABLE public.settings
        ADD COLUMN IF NOT EXISTS scheduler_ai_verification_enabled integer NOT NULL DEFAULT 1,
        ADD COLUMN IF NOT EXISTS scheduler_crawl_enabled integer NOT NULL DEFAULT 1,
        ADD COLUMN IF NOT EXISTS scheduler_enrichment_enabled integer NOT NULL DEFAULT 1,
        ADD COLUMN IF NOT EXISTS scheduler_artifact_enabled integer NOT NULL DEFAULT 1,
        ADD COLUMN IF NOT EXISTS scheduler_score_recompute_enabled integer NOT NULL DEFAULT 1`);
      await db.unsafe(`ALTER TABLE public.leads
        ADD COLUMN IF NOT EXISTS ai_website_feedback_status text,
        ADD COLUMN IF NOT EXISTS ai_corrected_website_url text,
        ADD COLUMN IF NOT EXISTS ai_false_positive_reason text,
        ADD COLUMN IF NOT EXISTS ai_reviewer_notes text,
        ADD COLUMN IF NOT EXISTS ai_feedback_at timestamptz`);
    }
  }
  expect(applied).toBe(migrations.length - SKIPPED.size - 2);
}

async function seedFoundation(db: Sql): Promise<void> {
  await db.unsafe(`INSERT INTO auth.users (id) VALUES ('${ACTOR}')`);
  await db.unsafe(`
    INSERT INTO public.tenants (id, slug, name, status) VALUES
      ('${TENANT}', 'l08-rehearsal', 'L08 Rehearsal', 'active');
    INSERT INTO public.workspaces (id, tenant_id, slug, name, status) VALUES
      ('${WORKSPACE}', '${TENANT}', 'main', 'L08 Workspace', 'active');
    INSERT INTO public.tenant_memberships
      (id, tenant_id, auth_identity_id, workspace_id, status) VALUES
      ('${MEMBERSHIP}', '${TENANT}', '${ACTOR}', NULL, 'active');
    INSERT INTO public.tenant_role_bindings
      (id, tenant_id, membership_id, role, created_at, valid_from, reason_code) VALUES
      ('${BINDING}', '${TENANT}', '${MEMBERSHIP}', 'owner',
       now() - interval '1 hour', now() - interval '1 hour', 'initial_provisioning');
    INSERT INTO public.agent_prompt_versions
      (prompt_key, version, instructions_ref, instructions_sha256, allowed_tools, allowed_classifications)
    VALUES ('business-understanding', 1, 'prompts/business-understanding/1',
      '${sha256hex("prompt")}', '["lookup"]', '["tenant_business_materials"]');
    INSERT INTO public.agent_policy_versions
      (policy_key, version, provider, model, state, policy_sha256, allowed_tools, allowed_classifications)
    VALUES ('fixture-policy', 1, 'fixture', 'openai-responses-stub', 'fixture',
      '${sha256hex("policy")}', '["lookup"]', '["tenant_business_materials"]');
    INSERT INTO public.canonical_accounts
      (account_id, tenant_id, workspace_id, version, status, display_name,
       profile, profile_sha256, exact_keys, observation_refs, created_at, updated_at)
    VALUES ('${ACCOUNT}', '${TENANT}', '${WORKSPACE}', 1, 'active', 'L08 Account',
      '{}'::jsonb, '${sha256hex("account")}', '[]'::jsonb, '[]'::jsonb, now(), now());
  `);
}

/** Session-persistent GUC envelope for a member-context call. */
async function memberContext(db: Sql, correlationId: string): Promise<void> {
  await db.unsafe(`SELECT
    pg_catalog.set_config('app.tenant_id', '${TENANT}', false),
    pg_catalog.set_config('app.workspace_id', '${WORKSPACE}', false),
    pg_catalog.set_config('app.actor_id', '${ACTOR}', false),
    pg_catalog.set_config('app.membership_id', '${MEMBERSHIP}', false),
    pg_catalog.set_config('app.role_binding_id', '${BINDING}', false),
    pg_catalog.set_config('app.role', 'owner', false),
    pg_catalog.set_config('app.correlation_id', '${correlationId}', false),
    pg_catalog.set_config('app.support_grant_id', '', false),
    pg_catalog.set_config('app.job_id', '', false),
    pg_catalog.set_config('app.run_id', '', false),
    pg_catalog.set_config('app.lease_id', '', false),
    pg_catalog.set_config('app.lease_generation', '', false),
    pg_catalog.set_config('app.worker_name', '', false),
    pg_catalog.set_config('app.worker_action', '', false),
    pg_catalog.set_config('app.worker_principal_kind', '', false)`);
}

interface DispatchLease {
  jobId: string;
  runId: string;
  leaseId: string;
  generation: number;
  correlationId: string;
}

/** Worker-context GUC envelope bound to one dispatch lease + agent run. */
async function workerContext(db: Sql, lease: DispatchLease): Promise<void> {
  await db.unsafe(`SELECT
    pg_catalog.set_config('app.tenant_id', '${TENANT}', false),
    pg_catalog.set_config('app.workspace_id', '${WORKSPACE}', false),
    pg_catalog.set_config('app.actor_id', '', false),
    pg_catalog.set_config('app.membership_id', '', false),
    pg_catalog.set_config('app.role_binding_id', '', false),
    pg_catalog.set_config('app.role', '', false),
    pg_catalog.set_config('app.support_grant_id', '', false),
    pg_catalog.set_config('app.job_id', '${lease.jobId}', false),
    pg_catalog.set_config('app.run_id', '${lease.runId}', false),
    pg_catalog.set_config('app.lease_id', '${lease.leaseId}', false),
    pg_catalog.set_config('app.lease_generation', '${lease.generation}', false),
    pg_catalog.set_config('app.worker_name', 'agent_runtime', false),
    pg_catalog.set_config('app.worker_action', 'agent_runtime:execute', false),
    pg_catalog.set_config('app.worker_principal_kind', 'cron', false),
    pg_catalog.set_config('app.correlation_id', '${lease.correlationId}', false)`);
}

async function clearContext(db: Sql): Promise<void> {
  await db.unsafe(`SELECT
    pg_catalog.set_config('app.tenant_id', '', false),
    pg_catalog.set_config('app.workspace_id', '', false),
    pg_catalog.set_config('app.actor_id', '', false),
    pg_catalog.set_config('app.membership_id', '', false),
    pg_catalog.set_config('app.role_binding_id', '', false),
    pg_catalog.set_config('app.role', '', false),
    pg_catalog.set_config('app.correlation_id', '', false),
    pg_catalog.set_config('app.support_grant_id', '', false),
    pg_catalog.set_config('app.job_id', '', false),
    pg_catalog.set_config('app.run_id', '', false),
    pg_catalog.set_config('app.lease_id', '', false),
    pg_catalog.set_config('app.lease_generation', '', false),
    pg_catalog.set_config('app.worker_name', '', false),
    pg_catalog.set_config('app.worker_action', '', false),
    pg_catalog.set_config('app.worker_principal_kind', '', false)`);
}

/** Returns the acquire kind ('created'/'replayed'/'conflict') or null when denied. */
async function tryAcquireLease(
  db: Sql,
  lease: DispatchLease,
  workerName = "agent_runtime",
  action = "agent_runtime:execute",
  ttlSeconds = 120,
): Promise<string | null> {
  const rows = await db.unsafe<Array<{ kind: string }>>(
    `SELECT kind FROM public.novatrade_acquire_tenant_worker_lease(
       $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
    [
      sha256hex(`selector:${lease.leaseId}`),
      TENANT,
      WORKSPACE,
      lease.jobId,
      lease.runId,
      lease.leaseId,
      String(lease.generation),
      workerName,
      action,
      new Date(Date.now() - 5_000).toISOString(),
      new Date(Date.now() + ttlSeconds * 1000).toISOString(),
      lease.correlationId,
    ],
  );
  return rows.length === 0 ? null : rows[0].kind;
}

async function enqueueRun(
  db: Sql,
  runId: string,
  idempotencyKey: string,
  inputHash: string,
): Promise<string | null> {
  const rows = await db.unsafe<Array<{ kind: string }>>(
    `SELECT kind FROM public.novatrade_l04_enqueue_agent_run(
       $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)`,
    [
      TENANT, WORKSPACE, runId, idempotencyKey, inputHash,
      "business-understanding", "1", "business-understanding", "1",
      "fixture-policy", "1", "0.25", "3",
      new Date().toISOString(), JSON.stringify({ mode: "acceptance" }),
    ],
  );
  return rows.length === 0 ? null : rows[0].kind;
}

async function claimRun(
  db: Sql,
  runId: string,
  leaseToken: string,
  leaseMs: number,
): Promise<string | null> {
  const rows = await db.unsafe<Array<{ kind: string }>>(
    `SELECT kind FROM public.novatrade_l04_claim_agent_run($1,$2,$3,$4,$5,$6,$7)`,
    [TENANT, WORKSPACE, runId, leaseToken, "worker:l08", new Date().toISOString(), String(leaseMs)],
  );
  return rows.length === 0 ? null : rows[0].kind;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, ms));
}

describe.skipIf(!RUN)("L-08 degraded-path disposable PostgreSQL proofs", () => {
  let adminUrl = "";

  beforeAll(async () => {
    container = `novatrade-l08-${randomUUID()}`;
    docker([
      "run", "--detach", "--rm", "--name", container, "--publish", "127.0.0.1::5432",
      "--env", "POSTGRES_PASSWORD=postgres", "--env", `POSTGRES_DB=${DATABASE}`, POSTGRES_16,
    ]);
    waitForPostgres(container);
    const port = docker(["port", container, "5432/tcp"]).split(":").at(-1);
    if (!port) throw new Error("Disposable PostgreSQL port was not published");
    adminUrl = `postgres://postgres:postgres@127.0.0.1:${port}/${DATABASE}`;
    sql = postgres(adminUrl, { max: 1, prepare: false, ssl: false, onnotice: () => undefined });
    const [{ version }] = await sql.unsafe<Array<{ version: string }>>(
      "SELECT current_setting('server_version_num') AS version",
    );
    expect(version.startsWith("16")).toBe(true);
    await replayBaseMigrations(sql);
    await seedFoundation(sql);
  }, 120_000);

  afterAll(async () => {
    await closeDb();
    await sql?.end();
    if (container) docker(["rm", "-f", container], true);
  });

  it("applies and rolls back the L-05 run-guard self-loop fix", async () => {
    const db = sql!;
    const planHash = sha256hex("l08-plan");
    const runHash = sha256hex("l08-run");
    const planId = `discovery-plan:${planHash}`;
    const runId = `discovery-run:${runHash}`;
    const created = "2026-09-16T12:00:00.000Z";
    const limits = { maxAccounts: 5, maxProviderRequests: 5, maxSpendCents: 0 };
    const playVersionId = `lead-play-version:${sha256hex("l08-play")}`;
    const planPayload = {
      planId, tenantId: TENANT, workspaceId: WORKSPACE,
      planHash: `sha256:${planHash}`, status: "plan_only",
      play: { stableKey: "play:l08", versionId: playVersionId, revision: 1 },
      tasks: [{ taskId: "task:1", kind: "source_run" }],
      limits, createdAt: created,
    };
    // jsonb parameters must bind as objects — a JSON string would be
    // double-encoded by the driver's jsonb serialization.
    await db.unsafe(
      `INSERT INTO public.discovery_plans
        (plan_id, tenant_id, workspace_id, plan_sha256, status, play_stable_key,
         play_version_id, play_revision, source_keys, limits, payload, created_at)
       VALUES ($1,$2,$3,$4,'plan_only',$5,$6,1,$7::jsonb,$8::jsonb,$9::jsonb,$10)`,
      [planId, TENANT, WORKSPACE, planHash, "play:l08", playVersionId,
        ["source:l08"], limits, planPayload, created],
    );
    const runPayload = (status: string, hash: string, updatedAt: string) => ({
      runId, tenantId: TENANT, workspaceId: WORKSPACE,
      plan: { planId }, runHash: `sha256:${hash}`, status,
      createdAt: created, updatedAt,
    });
    await db.unsafe(
      `INSERT INTO public.discovery_runs
        (run_id, tenant_id, workspace_id, plan_id, status, run_sha256, payload, created_at, updated_at)
       VALUES ($1,$2,$3,$4,'planned',$5,$6::jsonb,$7,$7)`,
      [runId, TENANT, WORKSPACE, planId, runHash,
        runPayload("planned", runHash, created), created],
    );

    const updateRun = async (status: string, updatedAt: string) => {
      const nextHash = sha256hex(`l08-run:${status}:${updatedAt}`);
      await db.unsafe(
        `UPDATE public.discovery_runs
           SET status=$1, run_sha256=$2, payload=$3::jsonb, updated_at=$4
         WHERE run_id=$5`,
        [status, nextHash, runPayload(status, nextHash, updatedAt),
          updatedAt, runId],
      );
    };

    // planned -> running is legal under both guard generations.
    await updateRun("running", "2026-09-16T12:00:01.000Z");
    // running -> running (observation-batch append) is denied pre-fix.
    await expect(updateRun("running", "2026-09-16T12:00:02.000Z"))
      .rejects.toThrow("L05_RUN_INVALID_TRANSITION");

    const [{ def: oldGuard }] = await db.unsafe<Array<{ def: string }>>(
      "SELECT pg_get_functiondef('public.novatrade_l05_run_guard()'::regprocedure) AS def",
    );

    await db.unsafe(readFileSync(join("supabase", "migrations", FIX_RUN_GUARD), "utf8"));
    await updateRun("running", "2026-09-16T12:00:03.000Z");

    // Rollback restores the pre-migration function body byte-for-byte.
    await db.unsafe(oldGuard);
    await expect(updateRun("running", "2026-09-16T12:00:04.000Z"))
      .rejects.toThrow("L05_RUN_INVALID_TRANSITION");

    await db.unsafe(readFileSync(join("supabase", "migrations", FIX_RUN_GUARD), "utf8"));
    await updateRun("running", "2026-09-16T12:00:05.000Z");
  });

  it("applies and rolls back agent_runtime worker-lease admission", async () => {
    const db = sql!;
    const lease: DispatchLease = {
      jobId: randomUUID(), runId: randomUUID(),
      leaseId: randomUUID(), generation: 1, correlationId: `corr:${randomUUID()}`,
    };

    // Pre-fix: the worker-name whitelist and table CHECK both reject it.
    expect(await tryAcquireLease(db, lease)).toBeNull();

    const functionDefs = await db.unsafe<Array<{ name: string; def: string }>>(
      `SELECT p.proname AS name, pg_get_functiondef(p.oid) AS def
         FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
        WHERE n.nspname = 'public' AND p.proname IN (
          'novatrade_acquire_tenant_worker_lease',
          'novatrade_validate_tenant_worker_lease',
          'novatrade_cancel_tenant_worker_lease')`,
    );
    const constraintDefs = await db.unsafe<Array<{ name: string; def: string }>>(
      `SELECT conname AS name, pg_get_constraintdef(oid) AS def
         FROM pg_constraint
        WHERE conrelid = 'public.tenant_worker_dispatch_leases'::regclass
          AND conname IN (
            'tenant_worker_dispatch_leases_worker_name_chk',
            'tenant_worker_dispatch_leases_action_chk')`,
    );
    expect(functionDefs).toHaveLength(3);
    expect(constraintDefs).toHaveLength(2);

    await db.unsafe(readFileSync(join("supabase", "migrations", FIX_AGENT_LEASE), "utf8"));
    expect(await tryAcquireLease(db, lease)).toBe("created");

    // Rollback: restore the captured function bodies and CHECK constraints.
    // The table CHECK validates existing rows, so the admitted lease rows must
    // be removed first (the dispatch guard fences UPDATE, not DELETE).
    for (const { def } of functionDefs) await db.unsafe(def);
    await db.unsafe(
      `DELETE FROM public.tenant_worker_dispatch_leases WHERE worker_name = 'agent_runtime'`,
    );
    for (const { name, def } of constraintDefs) {
      await db.unsafe(
        `ALTER TABLE public.tenant_worker_dispatch_leases DROP CONSTRAINT "${name}"`,
      );
      await db.unsafe(
        `ALTER TABLE public.tenant_worker_dispatch_leases ADD CONSTRAINT "${name}" ${def}`,
      );
    }
    const denied: DispatchLease = { ...lease, leaseId: randomUUID(), jobId: randomUUID() };
    expect(await tryAcquireLease(db, denied)).toBeNull();

    await db.unsafe(readFileSync(join("supabase", "migrations", FIX_AGENT_LEASE), "utf8"));
    const restored: DispatchLease = { ...lease, leaseId: randomUUID(), jobId: randomUUID() };
    expect(await tryAcquireLease(db, restored)).toBe("created");
  });

  it("replays identical enqueue requests and rejects divergent reuse", async () => {
    const db = sql!;
    await memberContext(db, `corr:${randomUUID()}`);
    const runId = randomUUID();
    const key = `l08-idem-${randomUUID()}`;
    const inputHash = `sha256:${sha256hex("input-a")}`;

    expect(await enqueueRun(db, runId, key, inputHash)).toBe("created");
    expect(await enqueueRun(db, randomUUID(), key, inputHash)).toBe("deduplicated");
    expect(await enqueueRun(db, randomUUID(), key, `sha256:${sha256hex("input-b")}`))
      .toBe("conflict");
    await clearContext(db);
  });

  it("recovers a stale run lease after a worker crash and stores only token hashes", async () => {
    const db = sql!;
    await memberContext(db, `corr:${randomUUID()}`);
    const runId = randomUUID();
    expect(await enqueueRun(db, runId, `l08-lease-${randomUUID()}`, `sha256:${sha256hex("in")}`))
      .toBe("created");

    const lease: DispatchLease = {
      jobId: randomUUID(), runId, leaseId: randomUUID(),
      generation: 1, correlationId: `corr:${randomUUID()}`,
    };
    expect(await tryAcquireLease(db, lease)).toBe("created");

    // Simulate a crash: claim the run under a 1s lease, then never heartbeat.
    await workerContext(db, lease);
    const crashToken = `token-${randomUUID()}`;
    expect(await claimRun(db, runId, crashToken, 1000)).toBe("claimed");
    // A concurrent claim while the lease is live is fenced out.
    expect(await claimRun(db, runId, `token-${randomUUID()}`, 1000)).toBe("conflict");

    await sleep(1300);
    const recoveryToken = `token-${randomUUID()}`;
    expect(await claimRun(db, runId, recoveryToken, 30_000)).toBe("claimed");

    const [run] = await db.unsafe<Array<{
      status: string; attempt_count: string; lease_generation: string;
      lease_token_hash: string; lease_worker_hash: string;
    }>>(
      `SELECT status, attempt_count::text, lease_generation::text,
              lease_token_hash, lease_worker_hash
         FROM public.agent_runs WHERE id='${runId}'`,
    );
    expect(run.status).toBe("running");
    expect(Number(run.attempt_count)).toBe(2);
    expect(Number(run.lease_generation)).toBe(2);
    // Redaction: persisted lease material is a hash of the presented token,
    // never the token itself.
    expect(run.lease_token_hash).toBe(sha256hex(recoveryToken));
    expect(run.lease_token_hash).not.toBe(recoveryToken);
    expect(run.lease_worker_hash).toBe(
      sha256hex(`worker:agent_runtime:${lease.leaseId}:worker:l08`),
    );
    const leaked = await db.unsafe<Array<{ n: number }>>(
      `SELECT count(*)::int AS n FROM public.agent_runs
        WHERE lease_token_hash = '${recoveryToken}' OR lease_worker_hash = 'worker:l08'`,
    );
    expect(leaked[0].n).toBe(0);
    await clearContext(db);
  });

  it("auto-pauses a connector run when the next page would exceed the unit cap", async () => {
    const db = sql!;
    process.env.DATABASE_URL = adminUrl;
    process.env.DATABASE_SSL = "disable";
    const client = await getDb();
    const auditEvents: string[] = [];
    const audit: ConnectorAuditSink = {
      record: async (event) => { auditEvents.push(event.action); },
    };
    const deps: ConnectorServiceDeps = {
      authority: createPostgresConnectorAuthorityRepository(client),
      commands: createPostgresConnectorCommandRepository(client),
      audit,
    };

    const accountId = `connector-account:${sha256hex("l08-account").slice(0, 48)}`;
    const policyId = `source-policy:${sha256hex("l08-policy").slice(0, 48)}`;
    const policyKey = "l08.fixture.budget";
    // Registry/policy versions are UPDATE-immutable; seed them with their final
    // state the same way the F-09 lifecycle rehearsal does.
    await db.unsafe(
      `INSERT INTO public.connector_versions
        (source_card_id, version, execution_mode, transport, operations, output_fields, adapter_sha256)
       VALUES ('google_places_legacy', 1, 'fixture', 'none', $1::jsonb, $2::jsonb, $3)`,
      [["search_text"], ["place_id", "business_name", "rating"], sha256hex("l08-adapter")],
    );
    await db.unsafe(
      `INSERT INTO public.connector_accounts
        (id, tenant_id, workspace_id, source_card_id, connector_version, account_key, status)
       VALUES ($1, $2, $3, 'google_places_legacy', 1, 'l08-account', 'fixture_only')`,
      [accountId, TENANT, WORKSPACE],
    );
    await db.unsafe(
      `INSERT INTO public.source_policy_versions
        (id, tenant_id, workspace_id, source_card_id, connector_version, connector_account_id,
         policy_key, version, state, execution_mode, terms_state, allowed_operations,
         allowed_fields, hard_cap_units, policy_sha256)
       VALUES ($1, $2, $3, 'google_places_legacy', 1, $4, $5, 1,
               'active', 'fixture', 'approved', $6::jsonb, $7::jsonb, 100, $8)`,
      [policyId, TENANT, WORKSPACE, accountId, policyKey,
        ["search_text"], ["place_id", "business_name", "rating"],
        sha256hex("l08-source-policy")],
    );
    await db.unsafe(
      `INSERT INTO public.current_source_policy_activations
        (id, tenant_id, workspace_id, policy_key, policy_version, source_policy_id,
         activated_by_hash, activation_reason)
       VALUES ($1, $2, $3, $4, 1, $5, $6, 'l08 rehearsal activation')`,
      [`source-policy-activation:${sha256hex("l08-act").slice(0, 40)}`,
        TENANT, WORKSPACE, policyKey, policyId, sha256hex("l08-activator")],
    );

    // Cap == first reservation, so one completed page exhausts the budget.
    const created = await createSourceRun(deps, {
      tenantId: TENANT, workspaceId: WORKSPACE,
      sourceCardId: "google_places_legacy", connectorVersion: 1,
      connectorAccountId: accountId, sourcePolicyId: policyId,
      idempotencyKey: `l08-budget-${randomUUID()}`,
      operation: "search_text", inputHash: sha256hex("l08-run-input"),
      hardCapUnits: 2, maxAttempts: 1,
      checkpointKey: `checkpoint:${sha256hex("l08-1").slice(0, 40)}`,
      reservedUnits: 2,
    });
    expect(created.kind).toBe("created");

    let executorCalls = 0;
    const executed = await executeNextSourceUnit(deps, {
      authorizedTenantId: TENANT, authorizedWorkspaceId: WORKSPACE,
      workerId: "worker:l08-budget", leaseMs: 5_000,
      execute: () => {
        executorCalls += 1;
        return {
          observation: {
            sourceCardId: "google_places_legacy", operation: "search_text",
            tenantId: TENANT, runId: created.runId,
            observedAt: new Date().toISOString(),
            fields: { place_id: "place-1", business_name: "Acme Corp", rating: 4.2 },
          },
          nextCursor: "cursor-2", complete: false, actualUnits: 2,
        };
      },
    });
    expect(executed.status).toBe("executed");
    if (executed.status !== "executed" || !executed.settle) {
      throw new Error("expected an executed unit with a settlement");
    }
    expect(executed.settle.kind).toBe("settled");
    expect(executed.settle.runStatus).toBe("blocked");

    const [run] = await db.unsafe<Array<{ status: string; error_code: string | null }>>(
      `SELECT status, error_code FROM public.source_runs WHERE id='${created.runId}'`,
    );
    expect(run.status).toBe("blocked");
    expect(run.error_code).toBe("D015_COST_FAIL");
    const [{ n: unitCount }] = await db.unsafe<Array<{ n: number }>>(
      `SELECT count(*)::int AS n FROM public.source_run_units WHERE run_id='${created.runId}'`,
    );
    const [{ n: reservationCount }] = await db.unsafe<Array<{ n: number }>>(
      `SELECT count(*)::int AS n FROM public.source_usage_reservations WHERE run_id='${created.runId}'`,
    );
    // No continuation unit or reservation is minted once the cap is hit.
    expect(unitCount).toBe(1);
    expect(reservationCount).toBe(1);
    expect(executorCalls).toBe(1);
    expect(auditEvents).toContain("connector.source_run.created");
  });

  it("treats a deletion_pending suppression as blocking and replays it idempotently", async () => {
    const client = await getDb();
    const deps: SuppressionServiceDeps = {
      repository: createPostgresSuppressionRepository(client),
    };
    const input = {
      tenantId: TENANT, workspaceId: WORKSPACE, actorId: ACTOR,
      accountId: ACCOUNT, contactStableKey: "contact:l08-lifecycle",
      disposition: "deletion_pending", reason: "data subject deletion request",
      occurredAt: "2026-09-16T12:00:00.000Z", recordedAt: "2026-09-16T12:00:00.000Z",
    };
    const first = await recordSuppression(deps, input);
    expect(first.persisted).toBe("created");
    const replay = await recordSuppression(deps, input);
    expect(replay.persisted).toBe("replayed");
    expect(replay.record.recordId).toBe(first.record.recordId);

    const effective = await resolveSuppression(deps, {
      tenantId: TENANT, workspaceId: WORKSPACE,
      accountId: ACCOUNT, contactStableKey: "contact:l08-lifecycle",
    });
    expect(effective.blocking).toBe(true);
    expect(effective.effectiveDisposition).toBe("deletion_pending");
    expect(effective.dominantRecord?.recordId).toBe(first.record.recordId);
  });
});
