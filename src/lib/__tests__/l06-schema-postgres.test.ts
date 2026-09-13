import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import postgres, { type Sql } from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const RUN = process.env.L06_SCHEMA_RUN_DISPOSABLE_TESTS === "1";
const POSTGRES_16 = "postgres@sha256:33f923b05f64ca54ac4401c01126a6b92afe839a0aa0a52bc5aeb5cc958e5f20";
const DATABASE = "l06_schema_rehearsal";
const TENANT = "00000000-0000-4000-8000-000000000061";
const TENANT_B = "00000000-0000-4000-8000-000000000062";
const WORKSPACE_A = "10000000-0000-4000-8000-000000000061";
const WORKSPACE_B = "10000000-0000-4000-8000-000000000062";
const ACCOUNT_A = "20000000-0000-4000-8000-000000000061";
const ACTOR = "30000000-0000-4000-8000-000000000061";
const T0 = "2026-09-15T12:00:00.000Z";
const T1 = "2026-09-15T12:00:01.000Z";
const SKIPPED = new Set([
  "20260514161714_supabase_ai_verification_cron.sql",
  "20260514163203_scheduler_v2_sales_ready_pipeline.sql",
]);

const DRAFT_V1 = `outreach-draft-version:${"a".repeat(64)}`;
const DRAFT_V2 = `outreach-draft-version:${"b".repeat(64)}`;
const DRAFT_V3 = `outreach-draft-version:${"c".repeat(64)}`;
const OUTCOME_V1 = `outcome-version:${"d".repeat(64)}`;
const OUTCOME_V2 = `outcome-version:${"e".repeat(64)}`;
const OUTCOME_V3 = `outcome-version:${"f".repeat(64)}`;
const PROPOSAL_V1 = `learning-proposal-version:${"0".repeat(63)}1`;
const PLAY_V1 = `lead-play-version:${"1".repeat(64)}`;
const CONTACT_V1 = `contact-version:${"2".repeat(64)}`;
const SUPPRESSION_R1 = `suppression-record:${"3".repeat(64)}`;

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
    if (docker(["exec", name, "psql", "-X", "-v", "ON_ERROR_STOP=1", "-U", "postgres",
      "-d", DATABASE, "-Atc", "SELECT 1"], true) === "1") return;
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
    .toEqual({ discovered: 89, applied: 87, skipped: 2 });
}

function hash(ch: string): string {
  return ch.repeat(64);
}

async function seedFoundation(client: Sql): Promise<void> {
  await client.unsafe(`
    INSERT INTO public.tenants (id, slug, name, status) VALUES
      ('${TENANT}', 'l06', 'L06 Rehearsal', 'active'),
      ('${TENANT_B}', 'l06b', 'L06 Other Tenant', 'active');
    INSERT INTO public.workspaces (id, tenant_id, slug, name, status) VALUES
      ('${WORKSPACE_A}', '${TENANT}', 'l06-a', 'L06 A', 'active'),
      ('${WORKSPACE_B}', '${TENANT}', 'l06-b', 'L06 B', 'active');
    INSERT INTO public.canonical_accounts(
      account_id,tenant_id,workspace_id,version,status,profile_sha256,created_at,updated_at
    ) VALUES ('${ACCOUNT_A}','${TENANT}','${WORKSPACE_A}',1,'active','${hash("a")}','${T0}','${T0}');
    INSERT INTO public.business_understanding_versions(
      version_id,tenant_id,workspace_id,proposal_ref,revision,content_hash,claim_set_hash,
      review_hash,status,source,review,created_at,updated_at
    ) VALUES ('understanding-version:${hash("4")}','${TENANT}','${WORKSPACE_A}',
      'understanding.synthetic',1,'sha256:${hash("4")}','sha256:${hash("5")}',
      'sha256:${hash("6")}','approved','{}','{}','${T0}','${T0}');
    INSERT INTO public.icp_versions(
      version_id,tenant_id,workspace_id,stable_key,revision,content_hash,
      understanding_version_id,review_hash,status,source,review,created_at,updated_at
    ) VALUES ('icp-version:${hash("7")}','${TENANT}','${WORKSPACE_A}','icp.synthetic',1,
      'sha256:${hash("7")}','understanding-version:${hash("4")}','sha256:${hash("8")}',
      'approved','{}','{}','${T0}','${T0}');
    INSERT INTO public.lead_play_versions(
      version_id,tenant_id,workspace_id,stable_key,revision,icp_version_id,
      understanding_version_id,content_hash,review_hash,status,source,review,created_at,updated_at
    ) VALUES ('${PLAY_V1}','${TENANT}','${WORKSPACE_A}','play.synthetic',1,
      'icp-version:${hash("7")}','understanding-version:${hash("4")}','sha256:${hash("9")}',
      'sha256:${hash("a")}','approved','{}','{}','${T0}','${T0}');
    INSERT INTO public.contact_record_versions(
      version_id,tenant_id,workspace_id,account_id,stable_key,revision,review_status,
      suppression_disposition,freshness_state,contact_point_class,connector_key,
      content_sha256,version_sha256,review_sha256,payload,created_at
    ) VALUES ('${CONTACT_V1}','${TENANT}','${WORKSPACE_A}','${ACCOUNT_A}','contact.synthetic',1,
      'approved','clear','KNOWN','work_email','customer_list_csv_upload',
      '${hash("1")}','${hash("2")}','${hash("3")}',
      '${JSON.stringify({
    versionId: CONTACT_V1, tenantId: TENANT, workspaceId: WORKSPACE_A, accountId: ACCOUNT_A,
    stableKey: "contact.synthetic", revision: 1, supersedesVersionId: null,
    review: { status: "approved", reviewHash: `sha256:${hash("3")}` },
    suppressionDisposition: "clear", freshness: { state: "KNOWN" },
    identity: { contactPointClass: "work_email" },
    sourceReceipt: { connectorKey: "customer_list_csv_upload" },
    contentHash: `sha256:${hash("1")}`, versionHash: `sha256:${hash("2")}`, createdAt: T0,
  })}'::jsonb,'${T0}');
    INSERT INTO public.agent_prompt_versions(
      prompt_key,version,instructions_ref,instructions_sha256
    ) VALUES ('nova.outreach.drafting',1,'fixture://prompt','${hash("b")}');
    INSERT INTO public.agent_policy_versions(
      policy_key,version,provider,model,state,policy_sha256
    ) VALUES ('nova.fixture.default',1,'fixture','openai-responses-stub','fixture','${hash("c")}');
    INSERT INTO public.agent_runs(
      id,tenant_id,workspace_id,idempotency_key,input_hash,agent_role,agent_version,
      prompt_key,prompt_version,policy_key,policy_version,status,budget_usd,max_attempts,
      attempt_count,result_ref,started_at,ended_at,created_at,updated_at
    ) VALUES ('run-l06-1','${TENANT}','${WORKSPACE_A}','idem-l06-1','${hash("d")}',
      'outreach_drafting',1,'nova.outreach.drafting',1,'nova.fixture.default',1,
      'complete',0.05,1,1,'result://run-l06-1','${T0}','${T0}','${T0}','${T0}');
  `);
}

function draftPayload(versionId: string, revision: number, supersedes: string | null, review: {
  status: string; reviewHash: string;
}): string {
  return JSON.stringify({
    versionId, tenantId: TENANT, workspaceId: WORKSPACE_A, accountId: ACCOUNT_A,
    stableKey: "draft.synthetic", revision, supersedesVersionId: supersedes,
    draftKind: "initial", review,
    contentHash: `sha256:${hash("1")}`, validationHash: `sha256:${hash("2")}`,
    evidenceDigest: `sha256:${hash("3")}`, versionHash: `sha256:${hash("4")}`,
    createdAt: T0,
  });
}

function insertDraft(versionId: string, revision: number, supersedes: string | null,
  reviewStatus = "draft", reviewHash = `sha256:${hash("5")}`): string {
  return `INSERT INTO public.outreach_draft_versions(
    version_id,tenant_id,workspace_id,account_id,stable_key,revision,supersedes_version_id,
    draft_kind,play_version_id,contact_version_id,agent_run_id,created_by,review_status,
    content_sha256,validation_sha256,evidence_sha256,version_sha256,review_sha256,
    payload,evidence_payload,created_at
  ) VALUES ('${versionId}','${TENANT}','${WORKSPACE_A}','${ACCOUNT_A}','draft.synthetic',
    ${revision},${supersedes ? `'${supersedes}'` : "NULL"},'initial','${PLAY_V1}',
    '${CONTACT_V1}','run-l06-1','${ACTOR}','${reviewStatus}',
    '${hash("1")}','${hash("2")}','${hash("3")}','${hash("4")}',
    '${reviewHash.slice("sha256:".length)}',
    '${draftPayload(versionId, revision, supersedes, { status: reviewStatus, reviewHash })}'::jsonb,
    '{"pack":"synthetic"}'::jsonb,'${T0}')`;
}

function outcomePayload(versionId: string, revision: number, supersedes: string | null): string {
  return JSON.stringify({
    versionId, tenantId: TENANT, workspaceId: WORKSPACE_A, accountId: ACCOUNT_A,
    playVersionId: PLAY_V1, stableKey: "outcome.synthetic", revision,
    supersedesVersionId: supersedes, outcome: "replied", channel: "email",
    bounceClassification: null, outreachDraftVersionRef: null,
    source: { kind: "member_observation" }, recordedBy: { actorId: ACTOR },
    occurredAt: T0, recordedAt: T0,
    contentHash: `sha256:${hash("1")}`, versionHash: `sha256:${hash("2")}`,
  });
}

function insertOutcome(versionId: string, revision: number, supersedes: string | null,
  overrides: { occurredAt?: string; recordedAt?: string; outcome?: string } = {}): string {
  const occurredAt = overrides.occurredAt ?? T0;
  const recordedAt = overrides.recordedAt ?? T0;
  const outcome = overrides.outcome ?? "replied";
  return `INSERT INTO public.outcome_record_versions(
    version_id,tenant_id,workspace_id,account_id,play_version_id,stable_key,revision,
    supersedes_version_id,outcome,channel,source_kind,recorded_by,occurred_at,recorded_at,
    content_sha256,version_sha256,payload,created_at
  ) VALUES ('${versionId}','${TENANT}','${WORKSPACE_A}','${ACCOUNT_A}','${PLAY_V1}',
    'outcome.synthetic',${revision},${supersedes ? `'${supersedes}'` : "NULL"},
    '${outcome}','email','member_observation','${ACTOR}','${occurredAt}','${recordedAt}',
    '${hash("1")}','${hash("2")}','${outcomePayload(versionId, revision, supersedes)
      .replace(`"occurredAt":"${T0}"`, `"occurredAt":"${occurredAt}"`)
      .replace(`"recordedAt":"${T0}"`, `"recordedAt":"${recordedAt}"`)
      .replace(`"outcome":"replied"`, `"outcome":"${outcome}"`)}'::jsonb,'${T0}')`;
}

function proposalPayload(versionId: string, revision: number, supersedes: string | null,
  reviewStatus = "draft", reviewHash = `sha256:${hash("5")}`): string {
  return JSON.stringify({
    versionId, tenantId: TENANT, workspaceId: WORKSPACE_A, accountId: ACCOUNT_A,
    playVersionId: PLAY_V1, stableKey: "learning.synthetic", revision,
    supersedesVersionId: supersedes,
    review: { status: reviewStatus, reviewHash },
    metric: { metricKey: "reply_rate" },
    contentHash: `sha256:${hash("1")}`, versionHash: `sha256:${hash("2")}`, createdAt: T0,
  });
}

async function expectDenied(promise: Promise<unknown>, message: string): Promise<void> {
  try {
    await promise;
  } catch (error) {
    const text = error instanceof Error ? error.message : String(error);
    expect(text, `expected rejection containing ${message}, got: ${text}`)
      .toContain(message);
    return;
  }
  throw new Error(`expected rejection containing ${message}, but the statement succeeded`);
}

describe.skipIf(!RUN)("L-06 outreach/outcomes/learning schema on PostgreSQL 16", () => {
  beforeAll(async () => {
    container = `novatrade-l06-${randomUUID()}`;
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

  it("enforces payload-column consistency on draft versions", async () => {
    const client = sql!;
    await client.unsafe(insertDraft(DRAFT_V1, 1, null));
    // Payload stableKey disagrees with the column projection.
    await expectDenied(client.unsafe(`INSERT INTO public.outreach_draft_versions(
      version_id,tenant_id,workspace_id,account_id,stable_key,revision,
      draft_kind,play_version_id,created_by,review_status,
      content_sha256,validation_sha256,evidence_sha256,version_sha256,review_sha256,
      payload,evidence_payload,created_at
    ) VALUES ('${DRAFT_V3}','${TENANT}','${WORKSPACE_A}','${ACCOUNT_A}','draft.other',1,
      'initial','${PLAY_V1}','${ACTOR}','draft',
      '${hash("1")}','${hash("2")}','${hash("3")}','${hash("4")}','${hash("5")}',
      '${draftPayload(DRAFT_V3, 1, null, { status: "draft", reviewHash: `sha256:${hash("5")}` })}'::jsonb,
      '{}'::jsonb,'${T0}')`), "outreach_draft_versions_payload_chk");
    // Revision > 1 without a supersedes pointer violates the revision check.
    await expectDenied(client.unsafe(
      insertDraft(`outreach-draft-version:${"9".repeat(64)}`, 2, null)),
      "outreach_draft_versions_revision_chk");
    // A non-send action cannot appear anywhere: draft kinds are closed.
    await expectDenied(client.unsafe(
      insertDraft(DRAFT_V3, 1, null).replace("'initial'", "'send'")),
      "outreach_draft_versions_kind_chk");
  });

  it("enforces the draft revision chain and the review transition guard", async () => {
    const client = sql!;
    // DRAFT_V2 supersedes DRAFT_V1 in the same scope.
    await client.unsafe(insertDraft(DRAFT_V2, 2, DRAFT_V1));
    // DRAFT_V3 claims revision 3 but points at revision 1 — chain guard fires.
    await expectDenied(client.unsafe(insertDraft(DRAFT_V3, 3, DRAFT_V1)),
      "L06_DRAFT_CHAIN_MISMATCH");
    // Review update draft -> in_review with a fresh review hash is allowed.
    await client.unsafe(`UPDATE public.outreach_draft_versions SET
      review_status='in_review', review_sha256='${hash("6")}',
      payload=jsonb_set(payload,'{review}','{"status":"in_review","reviewHash":"sha256:${hash("6")}"}'::jsonb)
      WHERE version_id='${DRAFT_V1}'`);
    // in_review -> draft is not a permitted transition.
    await expectDenied(client.unsafe(`UPDATE public.outreach_draft_versions SET
      review_status='draft', review_sha256='${hash("7")}',
      payload=jsonb_set(payload,'{review}','{"status":"draft","reviewHash":"sha256:${hash("7")}"}'::jsonb)
      WHERE version_id='${DRAFT_V1}'`), "L06_REVIEW_INVALID_TRANSITION");
    // Version rows are immutable.
    await expectDenied(client.unsafe(
      `DELETE FROM public.outreach_draft_versions WHERE version_id='${DRAFT_V1}'`),
      "L06_RECORD_IMMUTABLE");
  });

  it("enforces the current-state binding guard", async () => {
    const client = sql!;
    const payload = JSON.stringify({
      tenantId: TENANT, workspaceId: WORKSPACE_A, accountId: ACCOUNT_A,
      stableKey: "draft.synthetic", stateHash: `sha256:${hash("a")}`,
      current: { versionId: DRAFT_V2, revision: 2, status: "approved", eligibleActions: ["copy", "export"] },
    });
    await client.unsafe(`INSERT INTO public.outreach_draft_current(
      tenant_id,workspace_id,account_id,stable_key,state_sha256,payload,updated_at
    ) VALUES ('${TENANT}','${WORKSPACE_A}','${ACCOUNT_A}','draft.synthetic',
      '${hash("a")}','${payload}'::jsonb,'${T1}')`);
    // Re-writing the same hash is a stale update.
    await expectDenied(client.unsafe(`UPDATE public.outreach_draft_current SET
      updated_at='2026-09-15T12:00:02.000Z'
      WHERE tenant_id='${TENANT}' AND workspace_id='${WORKSPACE_A}'
        AND account_id='${ACCOUNT_A}' AND stable_key='draft.synthetic'`),
      "L06_CURRENT_STALE_UPDATE");
    // Identity columns are immutable.
    await expectDenied(client.unsafe(`UPDATE public.outreach_draft_current SET
      stable_key='draft.renamed' WHERE tenant_id='${TENANT}'`), "L06_CURRENT_IDENTITY_IMMUTABLE");
    // A strictly newer hash and later timestamp supersedes cleanly.
    const next = JSON.parse(payload) as { stateHash: string };
    next.stateHash = `sha256:${hash("b")}`;
    await client.unsafe(`UPDATE public.outreach_draft_current SET
      state_sha256='${hash("b")}', payload='${JSON.stringify(next)}'::jsonb,
      updated_at='2026-09-15T12:00:02.000Z'
      WHERE tenant_id='${TENANT}' AND stable_key='draft.synthetic'`);
    await expectDenied(client.unsafe(
      `DELETE FROM public.outreach_draft_current WHERE stable_key='draft.synthetic'`),
      "L06_RECORD_IMMUTABLE");
  });

  it("admits copy/export handoff attempts only, with immutable receipts", async () => {
    const client = sql!;
    // Blocked attempt: block code required, no completed_at.
    await client.unsafe(`INSERT INTO public.outreach_handoff_attempts(
      attempt_id,tenant_id,workspace_id,account_id,stable_key,draft_version_id,action,status,
      block_code,contact_version_id,contact_stable_key,idempotency_key,input_sha256,actor_id,
      decided_at,planned_at,payload
    ) VALUES ('attempt:${hash("1")}','${TENANT}','${WORKSPACE_A}','${ACCOUNT_A}',
      'draft.synthetic','${DRAFT_V1}','copy','blocked','OUTREACH_SCHEDULE_BLOCKED',
      '${CONTACT_V1}','contact.synthetic','idem-h-1','${hash("d")}','${ACTOR}',
      '${T0}','${T0}',
      '{"status":"blocked","blockCode":"OUTREACH_SCHEDULE_BLOCKED","receipt":null}'::jsonb)`);
    // A 'send' action is rejected outright.
    await expectDenied(client.unsafe(`INSERT INTO public.outreach_handoff_attempts(
      attempt_id,tenant_id,workspace_id,account_id,stable_key,draft_version_id,action,status,
      block_code,idempotency_key,input_sha256,actor_id,decided_at,planned_at,payload
    ) VALUES ('attempt:${hash("2")}','${TENANT}','${WORKSPACE_A}','${ACCOUNT_A}',
      'draft.synthetic','${DRAFT_V1}','send','blocked','X','idem-h-2','${hash("d")}','${ACTOR}',
      '${T0}','${T0}','{"status":"blocked","blockCode":"X","receipt":null}'::jsonb)`),
      "outreach_handoff_attempts_action_chk");
    // Released attempts require the receipt payload binding.
    await expectDenied(client.unsafe(`INSERT INTO public.outreach_handoff_attempts(
      attempt_id,tenant_id,workspace_id,account_id,stable_key,draft_version_id,action,status,
      idempotency_key,input_sha256,actor_id,decided_at,completed_at,planned_at,payload
    ) VALUES ('outreach-export-receipt:${hash("3")}','${TENANT}','${WORKSPACE_A}','${ACCOUNT_A}',
      'draft.synthetic','${DRAFT_V1}','export','released','idem-h-3','${hash("d")}','${ACTOR}',
      '${T0}','${T0}','${T0}','{"status":"released","receipt":null}'::jsonb)`),
      "outreach_handoff_attempts_payload_chk");
    // Valid released attempt carrying the receipt binding.
    await client.unsafe(`INSERT INTO public.outreach_handoff_attempts(
      attempt_id,tenant_id,workspace_id,account_id,stable_key,draft_version_id,action,status,
      contact_version_id,contact_stable_key,idempotency_key,input_sha256,actor_id,
      decided_at,completed_at,planned_at,recipient_local_day,payload
    ) VALUES ('outreach-export-receipt:${hash("4")}','${TENANT}','${WORKSPACE_A}','${ACCOUNT_A}',
      'draft.synthetic','${DRAFT_V1}','export','released','${CONTACT_V1}','contact.synthetic',
      'idem-h-4','${hash("d")}','${ACTOR}','${T0}','${T0}','${T0}','2026-09-15',
      '{"status":"released","receipt":{"receiptId":"outreach-export-receipt:${hash("4")}",
      "action":"export","idempotencyKey":"idem-h-4"},"decision":{"result":"allow"}}'::jsonb)`);
    // Idempotency keys are unique per scope.
    await expectDenied(client.unsafe(`INSERT INTO public.outreach_handoff_attempts(
      attempt_id,tenant_id,workspace_id,account_id,stable_key,draft_version_id,action,status,
      block_code,idempotency_key,input_sha256,actor_id,decided_at,planned_at,payload
    ) VALUES ('attempt:${hash("5")}','${TENANT}','${WORKSPACE_A}','${ACCOUNT_A}',
      'draft.synthetic','${DRAFT_V1}','copy','blocked','X','idem-h-1','${hash("e")}','${ACTOR}',
      '${T0}','${T0}','{"status":"blocked","blockCode":"X","receipt":null}'::jsonb)`),
      "outreach_handoff_attempts_idempotency_unique");
    // Attempts are append-only.
    await expectDenied(client.unsafe(
      `DELETE FROM public.outreach_handoff_attempts WHERE attempt_id='attempt:${hash("1")}'`),
      "L06_RECORD_IMMUTABLE");
  });

  it("enforces outcome chronology, taxonomy, chains, and immutability", async () => {
    const client = sql!;
    await client.unsafe(insertOutcome(OUTCOME_V1, 1, null));
    // occurred_at must not exceed recorded_at.
    await expectDenied(client.unsafe(
      insertOutcome(OUTCOME_V2, 1, null, { occurredAt: T1, recordedAt: T0 })),
      "outcome_record_versions_chronology_chk");
    // Taxonomy is closed — 'delivered' is not an outcome.
    await expectDenied(client.unsafe(
      insertOutcome(OUTCOME_V3, 1, null, { outcome: "delivered" })),
      "outcome_record_versions_outcome_chk");
    // Correction chain: revision 2 must point at revision 1 of the same key.
    await client.unsafe(insertOutcome(OUTCOME_V2, 2, OUTCOME_V1));
    await expectDenied(client.unsafe(insertOutcome(OUTCOME_V3, 3, OUTCOME_V1)),
      "L06_OUTCOME_CHAIN_MISMATCH");
    await expectDenied(client.unsafe(
      `UPDATE public.outcome_record_versions SET outcome='won' WHERE version_id='${OUTCOME_V1}'`),
      "L06_RECORD_IMMUTABLE");
  });

  it("couples suppression records to their outcome sources", async () => {
    const client = sql!;
    const suppressionPayload = (source: { kind: string; outcomeVersionId: string | null }) =>
      JSON.stringify({
        recordId: SUPPRESSION_R1, tenantId: TENANT, workspaceId: WORKSPACE_A,
        accountId: ACCOUNT_A, contactStableKey: "contact.synthetic",
        disposition: "opt_out", reason: "Synthetic suppression.",
        source, actor: { actorId: ACTOR }, occurredAt: T0, recordedAt: T0,
        recordHash: `sha256:${hash("3")}`,
      });
    // member_recorded records must not carry an outcome link.
    await expectDenied(client.unsafe(`INSERT INTO public.suppression_records(
      record_id,tenant_id,workspace_id,account_id,contact_stable_key,disposition,reason,
      source_kind,outcome_version_id,actor_id,occurred_at,recorded_at,payload,record_sha256
    ) VALUES ('${SUPPRESSION_R1}','${TENANT}','${WORKSPACE_A}','${ACCOUNT_A}',
      'contact.synthetic','opt_out','Synthetic suppression.','member_recorded',
      '${OUTCOME_V1}','${ACTOR}','${T0}','${T0}',
      '${suppressionPayload({ kind: "member_recorded", outcomeVersionId: OUTCOME_V1 })}'::jsonb,
      '${hash("3")}')`), "suppression_records_source_chk");
    // outcome_derived records must carry the outcome link.
    await expectDenied(client.unsafe(`INSERT INTO public.suppression_records(
      record_id,tenant_id,workspace_id,account_id,contact_stable_key,disposition,reason,
      source_kind,actor_id,occurred_at,recorded_at,payload,record_sha256
    ) VALUES ('${SUPPRESSION_R1}','${TENANT}','${WORKSPACE_A}','${ACCOUNT_A}',
      'contact.synthetic','opt_out','Synthetic suppression.','outcome_derived','${ACTOR}',
      '${T0}','${T0}',
      '${suppressionPayload({ kind: "outcome_derived", outcomeVersionId: null })}'::jsonb,
      '${hash("3")}')`), "suppression_records_source_chk");
    // A consistent outcome-derived record persists.
    const payload = JSON.stringify({
      recordId: SUPPRESSION_R1, tenantId: TENANT, workspaceId: WORKSPACE_A,
      accountId: ACCOUNT_A, contactStableKey: "contact.synthetic",
      disposition: "opt_out", reason: "Derived from the opted_out outcome.",
      source: { kind: "outcome_derived", outcomeVersionId: OUTCOME_V1 },
      actor: { actorId: ACTOR }, occurredAt: T0, recordedAt: T0,
      recordHash: `sha256:${hash("3")}`,
    });
    await client.unsafe(`INSERT INTO public.suppression_records(
      record_id,tenant_id,workspace_id,account_id,contact_stable_key,disposition,reason,
      source_kind,outcome_version_id,actor_id,occurred_at,recorded_at,payload,record_sha256
    ) VALUES ('${SUPPRESSION_R1}','${TENANT}','${WORKSPACE_A}','${ACCOUNT_A}',
      'contact.synthetic','opt_out','Derived from the opted_out outcome.','outcome_derived',
      '${OUTCOME_V1}','${ACTOR}','${T0}','${T0}','${payload}'::jsonb,'${hash("3")}')`);
    await expectDenied(client.unsafe(
      `UPDATE public.suppression_records SET disposition='complaint' WHERE record_id='${SUPPRESSION_R1}'`),
      "L06_RECORD_IMMUTABLE");
  });

  it("enforces learning proposal metrics, chains, and review guards", async () => {
    const client = sql!;
    await client.unsafe(`INSERT INTO public.learning_proposal_versions(
      version_id,tenant_id,workspace_id,account_id,play_version_id,stable_key,revision,
      review_status,metric_key,content_sha256,version_sha256,review_sha256,payload,created_at
    ) VALUES ('${PROPOSAL_V1}','${TENANT}','${WORKSPACE_A}','${ACCOUNT_A}','${PLAY_V1}',
      'learning.synthetic',1,'draft','reply_rate','${hash("1")}','${hash("2")}','${hash("5")}',
      '${proposalPayload(PROPOSAL_V1, 1, null)}'::jsonb,'${T0}')`);
    // Metric keys are closed to the D-013 set.
    await expectDenied(client.unsafe(`INSERT INTO public.learning_proposal_versions(
      version_id,tenant_id,workspace_id,account_id,play_version_id,stable_key,revision,
      review_status,metric_key,content_sha256,version_sha256,review_sha256,payload,created_at
    ) VALUES ('learning-proposal-version:${"8".repeat(64)}','${TENANT}','${WORKSPACE_A}',
      '${ACCOUNT_A}','${PLAY_V1}','learning.synthetic',1,'draft','send_rate',
      '${hash("1")}','${hash("2")}','${hash("5")}','{}'::jsonb,'${T0}')`),
      "learning_proposal_versions_metric_chk");
    // Review transitions follow the same guarded path as drafts.
    await client.unsafe(`UPDATE public.learning_proposal_versions SET
      review_status='in_review', review_sha256='${hash("6")}',
      payload=jsonb_set(payload,'{review}','{"status":"in_review","reviewHash":"sha256:${hash("6")}"}'::jsonb)
      WHERE version_id='${PROPOSAL_V1}'`);
    await expectDenied(client.unsafe(`UPDATE public.learning_proposal_versions SET
      review_status='draft', review_sha256='${hash("7")}',
      payload=jsonb_set(payload,'{review}','{"status":"draft","reviewHash":"sha256:${hash("7")}"}'::jsonb)
      WHERE version_id='${PROPOSAL_V1}'`), "L06_REVIEW_INVALID_TRANSITION");
  });

  it("rejects rows whose account or workspace escapes the tenant scope", async () => {
    const client = sql!;
    // Account belongs to WORKSPACE_A; a row scoped to WORKSPACE_B breaks the composite FK.
    await expectDenied(client.unsafe(`INSERT INTO public.outreach_draft_versions(
      version_id,tenant_id,workspace_id,account_id,stable_key,revision,
      draft_kind,play_version_id,created_by,review_status,
      content_sha256,validation_sha256,evidence_sha256,version_sha256,review_sha256,
      payload,evidence_payload,created_at
    ) VALUES ('${DRAFT_V3}','${TENANT}','${WORKSPACE_B}','${ACCOUNT_A}','draft.synthetic',1,
      'initial','${PLAY_V1}','${ACTOR}','draft',
      '${hash("1")}','${hash("2")}','${hash("3")}','${hash("4")}','${hash("5")}',
      '${draftPayload(DRAFT_V3, 1, null, { status: "draft", reviewHash: `sha256:${hash("5")}` })
        .replace(WORKSPACE_A, WORKSPACE_B)}'::jsonb,'{}'::jsonb,'${T0}')`),
      "outreach_draft_versions_account_scope_fkey");
    // The other tenant cannot attach rows to this tenant's workspace.
    await expectDenied(client.unsafe(`INSERT INTO public.suppression_records(
      record_id,tenant_id,workspace_id,disposition,reason,source_kind,actor_id,
      occurred_at,recorded_at,payload,record_sha256
    ) VALUES ('suppression-record:${"9".repeat(64)}','${TENANT_B}','${WORKSPACE_B}',
      'opt_out','Cross-tenant probe.','member_recorded','${ACTOR}','${T0}','${T0}',
      '{}'::jsonb,'${hash("9")}')`), "_fkey");
  });
});
