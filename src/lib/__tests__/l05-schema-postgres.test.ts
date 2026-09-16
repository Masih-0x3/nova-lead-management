import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import postgres, { type Sql } from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { DbClient } from "@/lib/db";
import { createPostgresPlayAuthorityPort } from "@/lib/discovery/play-authority-port";

const RUN = process.env.L05_SCHEMA_RUN_DISPOSABLE_TESTS === "1";
const POSTGRES_16 = "postgres@sha256:33f923b05f64ca54ac4401c01126a6b92afe839a0aa0a52bc5aeb5cc958e5f20";
const DATABASE = "l05_schema_rehearsal";
const TENANT = "00000000-0000-4000-8000-000000000091";
const WORKSPACE_A = "10000000-0000-4000-8000-000000000091";
const WORKSPACE_B = "10000000-0000-4000-8000-000000000092";
const ACCOUNT_A = "20000000-0000-4000-8000-000000000091";
const ACCOUNT_B = "20000000-0000-4000-8000-000000000092";
const ACCOUNT_C = "20000000-0000-4000-8000-000000000093";
const ACTOR = "30000000-0000-4000-8000-000000000091";
const T0 = "2026-09-15T12:00:00.000Z";
const T1 = "2026-09-15T12:00:01.000Z";
const T2 = "2026-09-15T12:00:02.000Z";
const T3 = "2026-09-15T12:00:03.000Z";
const SKIPPED = new Set([
  "20260514161714_supabase_ai_verification_cron.sql",
  "20260514163203_scheduler_v2_sales_ready_pipeline.sql",
]);

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
    if (docker(["exec", name, "pg_isready", "-h", "127.0.0.1", "-U", "postgres"], true).includes("accepting")) return;
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 250);
  }
  throw new Error(`PostgreSQL did not become ready: ${docker(["logs", name], true)}`);
}

async function replayAllMigrations(client: Sql): Promise<void> {
  await client.unsafe("CREATE SCHEMA IF NOT EXISTS auth");
  await client.unsafe("CREATE TABLE IF NOT EXISTS auth.users (id uuid PRIMARY KEY)");
  await client.unsafe(`DO $$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='anon') THEN CREATE ROLE anon NOLOGIN; END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='authenticated') THEN CREATE ROLE authenticated NOLOGIN; END IF;
  END $$`);
  await client.unsafe(`CREATE TABLE IF NOT EXISTS public.worker_runs (
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
    await client.unsafe(readFileSync(join("supabase", "migrations", file), "utf8"));
    applied += 1;
    if (file === "202605110001_full_schema.sql") {
      await client.unsafe(`ALTER TABLE public.settings
        ADD COLUMN IF NOT EXISTS scheduler_ai_verification_enabled integer NOT NULL DEFAULT 1,
        ADD COLUMN IF NOT EXISTS scheduler_crawl_enabled integer NOT NULL DEFAULT 1,
        ADD COLUMN IF NOT EXISTS scheduler_enrichment_enabled integer NOT NULL DEFAULT 1,
        ADD COLUMN IF NOT EXISTS scheduler_artifact_enabled integer NOT NULL DEFAULT 1,
        ADD COLUMN IF NOT EXISTS scheduler_score_recompute_enabled integer NOT NULL DEFAULT 1`);
      await client.unsafe(`ALTER TABLE public.leads
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

async function seedFoundation(client: Sql): Promise<void> {
  await client.unsafe(`
    INSERT INTO public.tenants (id, slug, name, status) VALUES ('${TENANT}', 'l05', 'L05 Rehearsal', 'active');
    INSERT INTO public.workspaces (id, tenant_id, slug, name, status) VALUES
      ('${WORKSPACE_A}', '${TENANT}', 'l05-a', 'L05 A', 'active'),
      ('${WORKSPACE_B}', '${TENANT}', 'l05-b', 'L05 B', 'active');
  `);
}

function hash(ch: string): string {
  return ch.repeat(64);
}

async function insertAccount(client: Sql, accountId: string, workspaceId: string): Promise<void> {
  await client.unsafe(`INSERT INTO public.canonical_accounts(
    account_id,tenant_id,workspace_id,version,status,profile_sha256,created_at,updated_at
  ) VALUES ('${accountId}','${TENANT}','${workspaceId}',1,'active','${hash("a")}','${T0}','${T0}')`);
}

function planPayload(planId: string, planHash: string): string {
  return JSON.stringify({
    planId, tenantId: TENANT, workspaceId: WORKSPACE_A,
    planHash: `sha256:${planHash}`, status: "plan_only",
    play: { stableKey: "play.discovery", versionId: `lead-play-version:${hash("e")}`, revision: 1 },
    tasks: [{ sourceKey: "google_places_legacy" }],
    limits: { maxAccounts: 10, maxProviderRequests: 10, maxSpendCents: 0 },
    createdAt: T0,
  });
}

async function insertPlan(client: Sql, planId: string): Promise<void> {
  const planHash = hash("f");
  await client.unsafe(`INSERT INTO public.discovery_plans(
    plan_id,tenant_id,workspace_id,plan_sha256,status,play_stable_key,play_version_id,
    play_revision,source_keys,limits,payload,created_at
  ) VALUES ('${planId}','${TENANT}','${WORKSPACE_A}','${planHash}','plan_only',
    'play.discovery','lead-play-version:${hash("e")}',1,'["google_places_legacy"]',
    '{"maxAccounts":10,"maxProviderRequests":10,"maxSpendCents":0}',
    '${planPayload(planId, planHash)}'::jsonb,'${T0}')`);
}

function runPayload(runId: string, planId: string, runHash: string, status: string, at: string): string {
  return JSON.stringify({
    runId, tenantId: TENANT, workspaceId: WORKSPACE_A,
    plan: { planId }, runHash: `sha256:${runHash}`, status, createdAt: T0, updatedAt: at,
  });
}

function contactPayload(versionId: string, revision: number, supersedes: string | null, review: {
  status: string; reviewHash: string;
}, contentHash: string, versionHash: string): string {
  return JSON.stringify({
    versionId, tenantId: TENANT, workspaceId: WORKSPACE_A, accountId: ACCOUNT_A,
    stableKey: "contact.example", revision, supersedesVersionId: supersedes,
    review, suppressionDisposition: "clear", freshness: { state: "KNOWN" },
    identity: { contactPointClass: "work_email" },
    sourceReceipt: { connectorKey: "customer_list_csv_upload" },
    contentHash: `sha256:${contentHash}`, versionHash: `sha256:${versionHash}`, createdAt: T0,
  });
}

async function insertContact(client: Sql, versionId: string, revision: number, supersedes: string | null): Promise<void> {
  const contentHash = hash("1"), versionHash = hash("2"), reviewHash = hash("3");
  await client.unsafe(`INSERT INTO public.contact_record_versions(
    version_id,tenant_id,workspace_id,account_id,stable_key,revision,supersedes_version_id,
    review_status,suppression_disposition,freshness_state,contact_point_class,connector_key,
    content_sha256,version_sha256,review_sha256,payload,created_at
  ) VALUES ('${versionId}','${TENANT}','${WORKSPACE_A}','${ACCOUNT_A}','contact.example',${revision},
    ${supersedes ? `'${supersedes}'` : "NULL"},'draft','clear','KNOWN','work_email',
    'customer_list_csv_upload','${contentHash}','${versionHash}','${reviewHash}',
    '${contactPayload(versionId, revision, supersedes, { status: "draft", reviewHash: `sha256:${reviewHash}` }, contentHash, versionHash)}'::jsonb,
    '${T0}')`);
}

function qualificationPayload(versionId: string, qualHash: string, reviewStatus: string, decision: string, reviewEvents: unknown[]): string {
  return JSON.stringify({
    versionId, tenantId: TENANT, workspaceId: WORKSPACE_A, accountId: ACCOUNT_A,
    playVersionId: `lead-play-version:${hash("e")}`,
    playContentHash: `sha256:${hash("4")}`, policyHash: `sha256:${hash("5")}`,
    qualificationHash: `sha256:${qualHash}`, weightedScore: 7200,
    automatedDecision: "needs_review", decision, reviewStatus,
    evaluatedAt: T0, reviewEvents,
  });
}

async function insertQualification(client: Sql, versionId: string, qualHash: string, reviewStatus: string, decision: string, reviewEvents: unknown[]): Promise<void> {
  await client.unsafe(`INSERT INTO public.account_qualification_snapshots(
    version_id,tenant_id,workspace_id,account_id,play_version_id,play_content_sha256,
    policy_sha256,qualification_sha256,weighted_score,automated_decision,decision,
    review_status,evaluated_at,payload
  ) VALUES ('${versionId}','${TENANT}','${WORKSPACE_A}','${ACCOUNT_A}',
    'lead-play-version:${hash("e")}','${hash("4")}','${hash("5")}','${qualHash}',
    7200,'needs_review','${decision}','${reviewStatus}','${T0}',
    '${qualificationPayload(versionId, qualHash, reviewStatus, decision, reviewEvents)}'::jsonb)`);
}

async function expectDenied(promise: Promise<unknown>, message: string): Promise<void> {
  await expect(promise).rejects.toMatchObject({ message: expect.stringContaining(message) });
}

function dbClient(client: Sql): DbClient {
  return {
    prepare(query: string) {
      let parameter = 0;
      const pgQuery = query.replaceAll("?", () => `$${++parameter}`);
      const execute = async (params: unknown[]) => client.unsafe(pgQuery, params as never[]);
      return {
        get: async <T = Record<string, unknown>>(...params: unknown[]) => {
          const rows = await execute(params);
          return rows[0] as T | undefined;
        },
        all: async <T = Record<string, unknown>>(...params: unknown[]) => {
          const rows = await execute(params);
          return rows as unknown as T[];
        },
        run: async (...params: unknown[]) => {
          const rows = await execute(params);
          return { changes: rows.count ?? 0 };
        },
      };
    },
    exec: async (query: string) => {
      await client.unsafe(query);
    },
  };
}

/**
 * Contract-pinned subset of L-04's real migration
 * `20260914000100_add_l04_understanding_strategy_foundation.sql`: the full
 * column/check shape of the two tables the play-authority port reads plus the
 * FK parents needed to insert them. `IF NOT EXISTS` keeps this a no-op once
 * the real L-04 migration is replayed — inserts below satisfy the real
 * constraints either way.
 */
const L04_CONTRACT_DDL = `
CREATE TABLE IF NOT EXISTS public.business_understanding_versions (
  version_id pg_catalog.text CONSTRAINT business_understanding_versions_pkey PRIMARY KEY
    CONSTRAINT business_understanding_versions_id_chk
    CHECK (version_id ~ '^understanding-version:[a-f0-9]{64}$'),
  tenant_id pg_catalog.uuid NOT NULL,
  workspace_id pg_catalog.uuid,
  proposal_ref pg_catalog.text NOT NULL
    CONSTRAINT business_understanding_versions_proposal_ref_chk
    CHECK (proposal_ref ~ '^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,255}$'),
  revision pg_catalog.int4 NOT NULL
    CONSTRAINT business_understanding_versions_revision_chk CHECK (revision BETWEEN 1 AND 1000000),
  supersedes_proposal_ref pg_catalog.text,
  supersedes_version_id pg_catalog.text,
  content_hash pg_catalog.text NOT NULL
    CONSTRAINT business_understanding_versions_content_hash_chk CHECK (content_hash ~ '^sha256:[a-f0-9]{64}$'),
  claim_set_hash pg_catalog.text NOT NULL
    CONSTRAINT business_understanding_versions_claim_set_hash_chk CHECK (claim_set_hash ~ '^sha256:[a-f0-9]{64}$'),
  review_hash pg_catalog.text NOT NULL
    CONSTRAINT business_understanding_versions_review_hash_chk CHECK (review_hash ~ '^sha256:[a-f0-9]{64}$'),
  status pg_catalog.text NOT NULL
    CONSTRAINT business_understanding_versions_status_chk
    CHECK (status IN ('draft','in_review','approved','rejected','superseded')),
  source pg_catalog.jsonb NOT NULL,
  review pg_catalog.jsonb NOT NULL,
  created_at pg_catalog.timestamptz(3) NOT NULL,
  updated_at pg_catalog.timestamptz(3) NOT NULL,
  CONSTRAINT business_understanding_versions_tenant_fkey
    FOREIGN KEY (tenant_id) REFERENCES public.tenants(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT business_understanding_versions_workspace_fkey
    FOREIGN KEY (tenant_id,workspace_id) REFERENCES public.workspaces(tenant_id,id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT business_understanding_versions_supersedes_fkey
    FOREIGN KEY (supersedes_version_id) REFERENCES public.business_understanding_versions(version_id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT business_understanding_versions_supersede_chk CHECK (
    (revision=1 AND supersedes_proposal_ref IS NULL AND supersedes_version_id IS NULL)
    OR (revision>1 AND supersedes_proposal_ref IS NOT NULL AND supersedes_version_id IS NOT NULL)
  ),
  CONSTRAINT business_understanding_versions_time_chk CHECK (updated_at >= created_at)
);
CREATE TABLE IF NOT EXISTS public.icp_versions (
  version_id pg_catalog.text CONSTRAINT icp_versions_pkey PRIMARY KEY
    CONSTRAINT icp_versions_id_chk CHECK (version_id ~ '^icp-version:[a-f0-9]{64}$'),
  tenant_id pg_catalog.uuid NOT NULL,
  workspace_id pg_catalog.uuid,
  stable_key pg_catalog.text NOT NULL
    CONSTRAINT icp_versions_stable_key_chk CHECK (stable_key ~ '^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,255}$'),
  revision pg_catalog.int4 NOT NULL
    CONSTRAINT icp_versions_revision_chk CHECK (revision BETWEEN 1 AND 1000000),
  supersedes_version_id pg_catalog.text,
  content_hash pg_catalog.text NOT NULL
    CONSTRAINT icp_versions_content_hash_chk CHECK (content_hash ~ '^sha256:[a-f0-9]{64}$'),
  understanding_version_id pg_catalog.text NOT NULL,
  review_hash pg_catalog.text NOT NULL
    CONSTRAINT icp_versions_review_hash_chk CHECK (review_hash ~ '^sha256:[a-f0-9]{64}$'),
  status pg_catalog.text NOT NULL
    CONSTRAINT icp_versions_status_chk
    CHECK (status IN ('draft','in_review','approved','rejected','superseded')),
  source pg_catalog.jsonb NOT NULL,
  review pg_catalog.jsonb NOT NULL,
  created_at pg_catalog.timestamptz(3) NOT NULL,
  updated_at pg_catalog.timestamptz(3) NOT NULL,
  CONSTRAINT icp_versions_tenant_fkey
    FOREIGN KEY (tenant_id) REFERENCES public.tenants(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT icp_versions_workspace_fkey
    FOREIGN KEY (tenant_id,workspace_id) REFERENCES public.workspaces(tenant_id,id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT icp_versions_supersedes_fkey
    FOREIGN KEY (supersedes_version_id) REFERENCES public.icp_versions(version_id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT icp_versions_understanding_fkey
    FOREIGN KEY (understanding_version_id) REFERENCES public.business_understanding_versions(version_id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT icp_versions_supersede_chk CHECK (
    (revision=1 AND supersedes_version_id IS NULL)
    OR (revision>1 AND supersedes_version_id IS NOT NULL)
  ),
  CONSTRAINT icp_versions_time_chk CHECK (updated_at >= created_at)
);
CREATE TABLE IF NOT EXISTS public.lead_play_versions (
  version_id pg_catalog.text CONSTRAINT lead_play_versions_pkey PRIMARY KEY
    CONSTRAINT lead_play_versions_id_chk CHECK (version_id ~ '^lead-play-version:[a-f0-9]{64}$'),
  tenant_id pg_catalog.uuid NOT NULL,
  workspace_id pg_catalog.uuid,
  stable_key pg_catalog.text NOT NULL
    CONSTRAINT lead_play_versions_stable_key_chk CHECK (stable_key ~ '^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,255}$'),
  revision pg_catalog.int4 NOT NULL
    CONSTRAINT lead_play_versions_revision_chk CHECK (revision BETWEEN 1 AND 1000000),
  supersedes_version_id pg_catalog.text,
  icp_version_id pg_catalog.text NOT NULL,
  understanding_version_id pg_catalog.text NOT NULL,
  content_hash pg_catalog.text NOT NULL
    CONSTRAINT lead_play_versions_content_hash_chk CHECK (content_hash ~ '^sha256:[a-f0-9]{64}$'),
  review_hash pg_catalog.text NOT NULL
    CONSTRAINT lead_play_versions_review_hash_chk CHECK (review_hash ~ '^sha256:[a-f0-9]{64}$'),
  status pg_catalog.text NOT NULL
    CONSTRAINT lead_play_versions_status_chk
    CHECK (status IN ('draft','in_review','approved','rejected','superseded')),
  source pg_catalog.jsonb NOT NULL,
  review pg_catalog.jsonb NOT NULL,
  created_at pg_catalog.timestamptz(3) NOT NULL,
  updated_at pg_catalog.timestamptz(3) NOT NULL,
  CONSTRAINT lead_play_versions_tenant_fkey
    FOREIGN KEY (tenant_id) REFERENCES public.tenants(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT lead_play_versions_workspace_fkey
    FOREIGN KEY (tenant_id,workspace_id) REFERENCES public.workspaces(tenant_id,id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT lead_play_versions_supersedes_fkey
    FOREIGN KEY (supersedes_version_id) REFERENCES public.lead_play_versions(version_id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT lead_play_versions_icp_fkey
    FOREIGN KEY (icp_version_id) REFERENCES public.icp_versions(version_id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT lead_play_versions_understanding_fkey
    FOREIGN KEY (understanding_version_id) REFERENCES public.business_understanding_versions(version_id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT lead_play_versions_supersede_chk CHECK (
    (revision=1 AND supersedes_version_id IS NULL)
    OR (revision>1 AND supersedes_version_id IS NOT NULL)
  ),
  CONSTRAINT lead_play_versions_time_chk CHECK (updated_at >= created_at)
);
CREATE TABLE IF NOT EXISTS public.lead_play_activation_states (
  id bigint GENERATED ALWAYS AS IDENTITY CONSTRAINT lead_play_activation_states_pkey PRIMARY KEY,
  tenant_id pg_catalog.uuid NOT NULL,
  workspace_id pg_catalog.uuid,
  stable_key pg_catalog.text NOT NULL
    CONSTRAINT lead_play_activation_states_key_chk CHECK (stable_key ~ '^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,255}$'),
  state_hash pg_catalog.text NOT NULL
    CONSTRAINT lead_play_activation_states_hash_chk CHECK (state_hash ~ '^sha256:[a-f0-9]{64}$'),
  state pg_catalog.jsonb NOT NULL,
  created_at pg_catalog.timestamptz(3) NOT NULL,
  updated_at pg_catalog.timestamptz(3) NOT NULL,
  CONSTRAINT lead_play_activation_states_tenant_fkey
    FOREIGN KEY (tenant_id) REFERENCES public.tenants(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT lead_play_activation_states_workspace_fkey
    FOREIGN KEY (tenant_id,workspace_id) REFERENCES public.workspaces(tenant_id,id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT lead_play_activation_states_time_chk CHECK (updated_at >= created_at)
);`;

describe.skipIf(!RUN)("L-05 discovery/accounts/contacts/qualification schema on PostgreSQL 16", () => {
  beforeAll(async () => {
    container = `novatrade-l05-${randomUUID()}`;
    docker(["run", "--detach", "--rm", "--name", container, "--publish", "127.0.0.1::5432",
      "--env", "POSTGRES_PASSWORD=postgres", "--env", `POSTGRES_DB=${DATABASE}`, POSTGRES_16]);
    waitForPostgres(container);
    const port = docker(["port", container, "5432/tcp"]).split(":").pop();
    sql = postgres(`postgres://postgres:postgres@127.0.0.1:${port}/${DATABASE}`,
      { max: 1, prepare: false, ssl: false, onnotice: () => undefined });
    await replayAllMigrations(sql);
    await seedFoundation(sql);
  }, 120_000);

  afterAll(async () => {
    await sql?.end({ timeout: 1 });
    if (container) docker(["rm", "--force", container], true);
  });

  it("guards canonical accounts against stale updates and cross-scope redirects", async () => {
    if (!sql) throw new Error("database unavailable");
    await insertAccount(sql, ACCOUNT_A, WORKSPACE_A);
    await insertAccount(sql, ACCOUNT_B, WORKSPACE_B);
    await insertAccount(sql, ACCOUNT_C, WORKSPACE_A);

    await expectDenied(
      sql.unsafe(`UPDATE public.canonical_accounts SET created_at='${T1}' WHERE account_id='${ACCOUNT_A}'`),
      "L05_ACCOUNT_IDENTITY_IMMUTABLE",
    );
    await expectDenied(
      sql.unsafe(`UPDATE public.canonical_accounts SET version=0 WHERE account_id='${ACCOUNT_A}'`),
      "L05_ACCOUNT_STALE_UPDATE",
    );
    await expectDenied(
      sql.unsafe(`UPDATE public.canonical_accounts SET status='merged', redirect_to_account_id='${ACCOUNT_B}',
        version=2, updated_at='${T1}' WHERE account_id='${ACCOUNT_A}'`),
      "L05_ACCOUNT_REDIRECT_SCOPE_MISMATCH",
    );
    await sql.unsafe(`UPDATE public.canonical_accounts SET status='merged',
      redirect_to_account_id='${ACCOUNT_C}', version=2, updated_at='${T1}' WHERE account_id='${ACCOUNT_A}'`);
    const merged = await sql.unsafe(
      `SELECT status, redirect_to_account_id AS redirect FROM public.canonical_accounts WHERE account_id='${ACCOUNT_A}'`);
    expect(merged[0]).toMatchObject({ status: "merged", redirect: ACCOUNT_C });
  });

  it("keeps observations and merge ledger events append-only", async () => {
    if (!sql) throw new Error("database unavailable");
    await sql.unsafe(`INSERT INTO public.account_source_observations(
      observation_id,tenant_id,workspace_id,account_id,source_key,namespace,external_id,
      observed_at,payload_sha256,provenance_sha256
    ) VALUES ('obs-1','${TENANT}','${WORKSPACE_A}','${ACCOUNT_C}','google_places_legacy',
      'places','ext-1','${T0}','${hash("6")}','${hash("7")}')`);
    await expectDenied(
      sql.unsafe(`UPDATE public.account_source_observations SET external_id='ext-2' WHERE observation_id='obs-1'`),
      "L05_RECORD_IMMUTABLE",
    );
    await expectDenied(
      sql.unsafe(`DELETE FROM public.account_source_observations WHERE observation_id='obs-1'`),
      "L05_RECORD_IMMUTABLE",
    );

    await sql.unsafe(`INSERT INTO public.account_merge_events(
      event_id,tenant_id,workspace_id,action,survivor_account_id,retired_account_id,
      evidence_observation_ids,actor,at,reason
    ) VALUES ('account-merge-event:${hash("8")}','${TENANT}','${WORKSPACE_A}','merge',
      '${ACCOUNT_C}','${ACCOUNT_A}','["obs-1"]','{"kind":"human","actorId":"${ACTOR}"}',
      '${T0}','duplicate account')`);
    await expectDenied(
      sql.unsafe(`DELETE FROM public.account_merge_events WHERE event_id='account-merge-event:${hash("8")}'`),
      "L05_RECORD_IMMUTABLE",
    );
  });

  it("enforces run plan scope and only legal run transitions", async () => {
    if (!sql) throw new Error("database unavailable");
    const planId = `discovery-plan:${hash("9")}`;
    const runId = `discovery-run:${hash("0")}`;
    await insertPlan(sql, planId);

    await expectDenied(
      sql.unsafe(`INSERT INTO public.discovery_runs(
        run_id,tenant_id,workspace_id,plan_id,status,run_sha256,payload,created_at,updated_at
      ) VALUES ('${runId}','${TENANT}','${WORKSPACE_B}','${planId}','planned','${hash("b")}',
        '${runPayload(runId, planId, hash("b"), "planned", T0)}'::jsonb,'${T0}','${T0}')`),
      "L05_RUN_PLAN_SCOPE_MISMATCH",
    );

    await sql.unsafe(`INSERT INTO public.discovery_runs(
      run_id,tenant_id,workspace_id,plan_id,status,run_sha256,payload,created_at,updated_at
    ) VALUES ('${runId}','${TENANT}','${WORKSPACE_A}','${planId}','planned','${hash("b")}',
      '${runPayload(runId, planId, hash("b"), "planned", T0)}'::jsonb,'${T0}','${T0}')`);
    await expectDenied(
      sql.unsafe(`UPDATE public.discovery_runs SET status='completed', run_sha256='${hash("c")}',
        updated_at='${T1}', payload='${runPayload(runId, planId, hash("c"), "completed", T1)}'::jsonb
        WHERE run_id='${runId}'`),
      "L05_RUN_INVALID_TRANSITION",
    );
    await sql.unsafe(`UPDATE public.discovery_runs SET status='running', run_sha256='${hash("c")}',
      updated_at='${T1}', payload='${runPayload(runId, planId, hash("c"), "running", T1)}'::jsonb
      WHERE run_id='${runId}'`);
    await sql.unsafe(`UPDATE public.discovery_runs SET status='completed', run_sha256='${hash("d")}',
      updated_at='${T2}', payload='${runPayload(runId, planId, hash("d"), "completed", T2)}'::jsonb
      WHERE run_id='${runId}'`);
    await expectDenied(
      sql.unsafe(`UPDATE public.discovery_runs SET run_sha256='${hash("e")}', updated_at='${T3}' WHERE run_id='${runId}'`),
      "L05_RUN_TERMINAL",
    );
    await expectDenied(
      sql.unsafe(`DELETE FROM public.discovery_plans WHERE plan_id='${planId}'`),
      "L05_RECORD_IMMUTABLE",
    );
  });

  it("chains contact versions in scope and orders review transitions", async () => {
    if (!sql) throw new Error("database unavailable");
    const v1 = `contact-version:${hash("a")}`;
    const v2 = `contact-version:${hash("b")}`;
    const v3 = `contact-version:${hash("c")}`;
    await insertContact(sql, v1, 1, null);
    await insertContact(sql, v2, 2, v1);
    await expectDenied(insertContact(sql, v3, 3, `contact-version:${hash("d")}`), "L05_CONTACT_CHAIN_MISMATCH");

    await expectDenied(
      sql.unsafe(`UPDATE public.contact_record_versions SET review_status='approved',
        review_sha256='${hash("4")}' WHERE version_id='${v1}'`),
      "L05_REVIEW_INVALID_TRANSITION",
    );
    await expectDenied(
      sql.unsafe(`UPDATE public.contact_record_versions SET review_status='in_review',
        review_sha256='${hash("3")}' WHERE version_id='${v1}'`),
      "L05_REVIEW_STALE_UPDATE",
    );
    await sql.unsafe(`UPDATE public.contact_record_versions SET review_status='in_review',
      review_sha256='${hash("5")}',
      payload='${contactPayload(v1, 1, null, { status: "in_review", reviewHash: `sha256:${hash("5")}` }, hash("1"), hash("2"))}'::jsonb
      WHERE version_id='${v1}'`);
    await expectDenied(
      sql.unsafe(`DELETE FROM public.contact_record_versions WHERE version_id='${v1}'`),
      "L05_RECORD_IMMUTABLE",
    );
  });

  it("enforces the append-only qualification chain and fork prevention", async () => {
    if (!sql) throw new Error("database unavailable");
    const parentHash = hash("6");
    const parent = `account-qualification:${parentHash}`;
    await insertQualification(sql, parent, parentHash, "unreviewed", "needs_review", []);

    await expectDenied(
      insertQualification(sql, `account-qualification:${hash("7")}`, hash("7"), "unreviewed", "qualified", []),
      "L05_QUALIFICATION_UNREVIEWED_MALFORMED",
    );
    await expectDenied(
      insertQualification(sql, `account-qualification:${hash("8")}`, hash("8"), "confirmed", "needs_review", [
        { fromQualificationHash: `sha256:${hash("f")}` },
      ]),
      "L05_QUALIFICATION_PARENT_MISSING",
    );

    const child = `account-qualification:${hash("9")}`;
    await insertQualification(sql, child, hash("9"), "confirmed", "needs_review", [
      { fromQualificationHash: `sha256:${parentHash}` },
    ]);
    await expect(
      insertQualification(sql, `account-qualification:${hash("0")}`, hash("0"), "confirmed", "needs_review", [
        { fromQualificationHash: `sha256:${parentHash}` },
      ]),
    ).rejects.toMatchObject({ code: "23505" });
    await expectDenied(
      sql.unsafe(`UPDATE public.account_qualification_snapshots SET weighted_score=0 WHERE version_id='${parent}'`),
      "L05_RECORD_IMMUTABLE",
    );
  });

  it("guards review queue item transitions and keeps events append-only", async () => {
    if (!sql) throw new Error("database unavailable");
    const queueId = `review-queue:${hash("a")}`;
    const itemId = `review-item:${hash("b")}`;
    await sql.unsafe(`INSERT INTO public.review_queue_documents(
      queue_id,tenant_id,workspace_id,queue_sha256,payload,created_at,updated_at
    ) VALUES ('${queueId}','${TENANT}','${WORKSPACE_A}','${hash("c")}',
      '${JSON.stringify({ queueId, tenantId: TENANT, workspaceId: WORKSPACE_A, queueHash: `sha256:${hash("c")}` })}'::jsonb,
      '${T0}','${T0}')`);
    await expectDenied(
      sql.unsafe(`UPDATE public.review_queue_documents SET queue_sha256='${hash("c")}', updated_at='${T1}' WHERE queue_id='${queueId}'`),
      "L05_QUEUE_STALE_UPDATE",
    );

    await sql.unsafe(`INSERT INTO public.review_queue_items(
      item_id,queue_id,tenant_id,workspace_id,kind,subject,priority,reason,uncertainty_ids,
      status,enqueued_at,updated_at
    ) VALUES ('${itemId}','${queueId}','${TENANT}','${WORKSPACE_A}','qualification_review',
      '${JSON.stringify({ subjectId: ACCOUNT_A, versionId: "v-1", contentHash: `sha256:${hash("d")}` })}'::jsonb,
      'normal','needs review','[]','queued','${T0}','${T0}')`);
    await sql.unsafe(`INSERT INTO public.review_queue_events(
      queue_id,sequence,tenant_id,workspace_id,item_id,action,at,reason,payload
    ) VALUES ('${queueId}',1,'${TENANT}','${WORKSPACE_A}','${itemId}','enqueue','${T0}','queued','{}')`);

    await expectDenied(
      sql.unsafe(`UPDATE public.review_queue_items SET status='resolved', claimed_by='${ACTOR}',
        resolution='{}', updated_at='${T1}' WHERE queue_id='${queueId}' AND item_id='${itemId}'`),
      "L05_QUEUE_ITEM_INVALID_TRANSITION",
    );
    await sql.unsafe(`UPDATE public.review_queue_items SET status='claimed', claimed_by='${ACTOR}',
      lease_expires_at='${T3}', updated_at='${T1}' WHERE queue_id='${queueId}' AND item_id='${itemId}'`);
    await sql.unsafe(`UPDATE public.review_queue_items SET status='resolved',
      resolution='{"outcome":"confirmed"}', updated_at='${T2}' WHERE queue_id='${queueId}' AND item_id='${itemId}'`);
    await expectDenied(
      sql.unsafe(`UPDATE public.review_queue_items SET status='queued', updated_at='${T3}'
        WHERE queue_id='${queueId}' AND item_id='${itemId}'`),
      "L05_QUEUE_ITEM_TERMINAL",
    );
    await expectDenied(
      sql.unsafe(`DELETE FROM public.review_queue_events WHERE queue_id='${queueId}' AND sequence=1`),
      "L05_RECORD_IMMUTABLE",
    );
    await expectDenied(
      sql.unsafe(`DELETE FROM public.review_queue_documents WHERE queue_id='${queueId}'`),
      "L05_RECORD_IMMUTABLE",
    );
  });

  it("resolves play authority through the real L-04 contract on Postgres", async () => {
    if (!sql) throw new Error("database unavailable");
    await sql.unsafe(L04_CONTRACT_DDL);
    const port = createPostgresPlayAuthorityPort(dbClient(sql));

    const understandingId = `understanding-version:${hash("d")}`;
    const icpId = `icp-version:${hash("e")}`;
    const wsPlay = `lead-play-version:${hash("a")}`;
    const tenantPlay = `lead-play-version:${hash("b")}`;
    await sql.unsafe(`INSERT INTO public.business_understanding_versions(
      version_id,tenant_id,workspace_id,proposal_ref,revision,content_hash,claim_set_hash,
      review_hash,status,source,review,created_at,updated_at
    ) VALUES ('${understandingId}','${TENANT}','${WORKSPACE_A}','prop.a',1,
      'sha256:${hash("d")}','sha256:${hash("e")}','sha256:${hash("f")}','approved',
      '{}','{}','${T0}','${T0}')`);
    await sql.unsafe(`INSERT INTO public.icp_versions(
      version_id,tenant_id,workspace_id,stable_key,revision,content_hash,
      understanding_version_id,review_hash,status,source,review,created_at,updated_at
    ) VALUES ('${icpId}','${TENANT}','${WORKSPACE_A}','icp.a',1,'sha256:${hash("a")}',
      '${understandingId}','sha256:${hash("b")}','approved','{}','{}','${T0}','${T0}')`);
    await sql.unsafe(`INSERT INTO public.lead_play_versions(
      version_id,tenant_id,workspace_id,stable_key,revision,icp_version_id,
      understanding_version_id,content_hash,review_hash,status,source,review,created_at,updated_at
    ) VALUES
      ('${wsPlay}','${TENANT}','${WORKSPACE_A}','play.ws',1,'${icpId}','${understandingId}',
        'sha256:${hash("a")}','sha256:${hash("b")}','approved',
        '{"proposalVersion":1,"scope":"ws"}','{"reviewVersion":1,"status":"approved"}','${T0}','${T0}'),
      ('${tenantPlay}','${TENANT}',NULL,'play.tenant',1,'${icpId}','${understandingId}',
        'sha256:${hash("c")}','sha256:${hash("d")}','approved',
        '{"proposalVersion":1,"scope":"tenant"}','{"reviewVersion":1,"status":"approved"}','${T0}','${T0}')`);
    await sql.unsafe(`INSERT INTO public.lead_play_activation_states(
      tenant_id,workspace_id,stable_key,state_hash,state,created_at,updated_at
    ) VALUES
      ('${TENANT}','${WORKSPACE_A}','play.ws','sha256:${hash("a")}',
        '{"stateVersion":1,"stableKey":"play.ws"}','${T0}','${T0}'),
      ('${TENANT}',NULL,'play.tenant','sha256:${hash("b")}',
        '{"stateVersion":1,"stableKey":"play.tenant"}','${T0}','${T0}')`);

    const wsAuthority = await port.loadPlayAuthority({
      tenantId: TENANT, workspaceId: WORKSPACE_A, playVersionId: wsPlay,
    });
    expect(wsAuthority).toEqual({
      activationState: { stateVersion: 1, stableKey: "play.ws" },
      playReview: { reviewVersion: 1, status: "approved" },
      playSource: { proposalVersion: 1, scope: "ws" },
    });

    const tenantAuthority = await port.loadPlayAuthority({
      tenantId: TENANT, workspaceId: null, playVersionId: tenantPlay,
    });
    expect(tenantAuthority?.playSource).toEqual({ proposalVersion: 1, scope: "tenant" });

    // A workspace-scoped selector must not see the tenant-scoped play.
    expect(await port.loadPlayAuthority({
      tenantId: TENANT, workspaceId: WORKSPACE_A, playVersionId: tenantPlay,
    })).toBeNull();
    // Unknown version → fail closed.
    expect(await port.loadPlayAuthority({
      tenantId: TENANT, workspaceId: WORKSPACE_A, playVersionId: `lead-play-version:${hash("f")}`,
    })).toBeNull();
    // Foreign tenant → fail closed.
    expect(await port.loadPlayAuthority({
      tenantId: "99999999-0000-4000-8000-000000000099", workspaceId: WORKSPACE_A, playVersionId: wsPlay,
    })).toBeNull();
  });
});
