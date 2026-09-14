// Disposable PostgreSQL 16 rehearsal for the novatrade-pg-recovery contract.
// Runs ONLY when PG_RECOVERY_RUN_DISPOSABLE_TESTS=1 — it self-provisions a
// uniquely named container, replays every portable migration, seeds
// representative L-02..L-06 rows through the real trigger/constraint
// machinery, then proves backup -> offline verify -> guarded atomic restore ->
// post-restore equivalence plus the destructive-path refusal cases.
//   PG_RECOVERY_RUN_DISPOSABLE_TESTS=1 vitest run src/lib/__tests__/postgres-recovery-rehearsal.test.ts
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import postgres, { type Sql } from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  PG_RECOVERY_MANIFEST_FILE,
  PG_RECOVERY_CHECKSUMS_FILE,
  PG_RECOVERY_DUMP_FILE,
  PG_RECOVERY_TABLE_NAMES,
  serializeManifest,
  sha256Buffer,
  validatePostgresRecoveryArchive,
} from "../../../scripts/postgres-recovery-contract.mjs";
import {
  backupPostgresRecovery,
  buildRestoreGuardSql,
  restorePostgresRecovery,
  verifyRestoredDatabase,
} from "../../../scripts/postgres-recovery.mjs";

const RUN = process.env.PG_RECOVERY_RUN_DISPOSABLE_TESTS === "1";
const POSTGRES_16 = "postgres@sha256:33f923b05f64ca54ac4401c01126a6b92afe839a0aa0a52bc5aeb5cc958e5f20";
const SRC_DB = "pgrcv_src";
const SKIPPED = new Set([
  "20260514161714_supabase_ai_verification_cron.sql",
  "20260514163203_scheduler_v2_sales_ready_pipeline.sql",
]);

const T = "00000000-0000-4000-8000-000000000041";
const W = "10000000-0000-4000-8000-000000000041";
const A1 = "30000000-0000-4000-8000-000000000041";
const A3 = "30000000-0000-4000-8000-000000000043";
const M1 = "40000000-0000-4000-8000-000000000041";
const M2 = "40000000-0000-4000-8000-000000000042";
const RB1 = "50000000-0000-4000-8000-000000000041";
const DOC = "60000000-0000-4000-8000-000000000041";
const DOC2 = "60000000-0000-4000-8000-000000000042";
const VER = "70000000-0000-4000-8000-000000000041";
const VER2 = "70000000-0000-4000-8000-000000000042";
const SCAN = "80000000-0000-4000-8000-000000000041";
const XJOB = "90000000-0000-4000-8000-000000000041";
const INV = "a1000000-0000-4000-8000-000000000041";
const ACCT_A = "c0000000-0000-4000-8000-000000000041";
const ACCT_B = "c0000000-0000-4000-8000-000000000042";
const TS = "2026-08-29T12:00:00Z";
const TS1 = "2026-08-29T12:01:00Z";
const TS2 = "2026-08-29T12:02:00Z";
const OBJ = `tenants/${T}/documents/${DOC}/versions/${VER}/original`;
const H = (n: string) => n.repeat(64).slice(0, 64);
const uuid = (suffix: string) => `f0000000-0000-4000-8000-${suffix}`;

let container = "";
let hostPort = "";
let admin: Sql | undefined;
let workdir = "";
let archiveDir = "";
let tools: { pgDump: string[]; pgRestore: string[]; psql: string[] };

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
      "-d", "postgres", "-Atc", "SELECT 1"], true) === "1") return;
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 250);
  }
  throw new Error(`PostgreSQL did not become ready: ${docker(["logs", name], true)}`);
}

function hostUrl(db: string): string {
  return `postgresql://postgres:postgres@127.0.0.1:${hostPort}/${db}`;
}

function toolUrl(db: string): string {
  return `postgresql://postgres@localhost:5432/${db}`;
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

// Representative rows across every recovery family. Inserts drive the real
// INSERT triggers (scope guards, pristine-state guards, chain guards); the
// document pipeline is walked through its state machine the same way the F-05
// schema rehearsal does.
const SEED_STATEMENTS: string[] = [
  `INSERT INTO auth.users(id) VALUES ('${A1}'),('${A3}')`,
  `INSERT INTO public.tenants(id,slug,name,status,created_at,updated_at) VALUES
    ('${T}','rcvr-tenant','Recovery Tenant','active','${TS}','${TS}')`,
  `INSERT INTO public.workspaces(id,tenant_id,slug,name,status,created_at,updated_at) VALUES
    ('${W}','${T}','rcvr-ws','Recovery WS','active','${TS}','${TS}')`,
  `INSERT INTO public.tenant_memberships(id,tenant_id,auth_identity_id,pending_identity_ref_hash,workspace_id,status,created_at,updated_at) VALUES
    ('${M1}','${T}','${A1}',NULL,'${W}','active','${TS}','${TS}'),
    ('${M2}','${T}',NULL,'${H("03")}','${W}','pending','${TS}','${TS}')`,
  `INSERT INTO public.tenant_role_bindings(id,tenant_id,membership_id,role,reason_code,created_at,valid_from) VALUES
    ('${RB1}','${T}','${M1}','owner','initial_provisioning','${TS}','${TS}')`,
  `INSERT INTO public.tenant_policies(tenant_id) VALUES ('${T}')`,
  `INSERT INTO public.tenant_membership_mutation_journal(idempotency_key_hash,input_hash,tenant_id,actor_membership_id,actor_role_binding_id,operation,target_membership_id,status,result_json,created_at,completed_at) VALUES
    ('${H("a1")}','${H("a2")}','${T}','${M1}','${RB1}','assign_role','${M1}','completed','{"ok":true}','${TS}','${TS}')`,
  `INSERT INTO public.tenant_provisioning_journal(idempotency_key_hash,input_hash,request_id,status,result_json,created_at,completed_at) VALUES
    ('${H("a3")}','${H("a4")}','${uuid("000000000041")}','completed','{"tenant":"${T}"}','${TS}','${TS}')`,
  `INSERT INTO public.tenant_invitations(id,tenant_id,membership_id,kind,role,workspace_id,expected_identity_ref_hash,policy_version,generation,content_hash,issued_at,expires_at,correlation_id,audit_event_id,created_at,updated_at) VALUES
    ('${INV}','${T}','${M2}','member','reviewer','${W}','${H("a5")}','v1.0',1,'${H("a6")}','${TS}','2026-09-05T12:00:00Z','corr-rcvr-001','${uuid("000000000042")}','${TS}','${TS}')`,
  `INSERT INTO public.tenant_invitation_journal(idempotency_key_hash,input_hash,operation,tenant_id,invitation_id,status,result_json,created_at,completed_at) VALUES
    ('${H("a7")}','${H("a8")}','issue','${T}','${INV}','completed','{"ok":true}','${TS}','${TS}')`,
  `INSERT INTO public.platform_support_principals(reference,auth_identity_id,status,created_at) VALUES
    ('support:rcvr','${A3}','active','${TS}')`,
  `INSERT INTO public.support_access_journal(idempotency_key_hash,input_hash,operation,tenant_id,actor_namespace,status,result_json,created_at,completed_at) VALUES
    ('${H("a9")}','${H("aa")}','check','${T}','platform.support','completed','{"decision":"deny"}','${TS}','${TS}')`,
  `INSERT INTO public.support_access_events(event_id,operation,tenant_id,workspace_id,actor_layer,actor_id,permission,data_classes_json,decision_code,reason_code,correlation_id,attempt_id,input_hash,created_at) VALUES
    ('${uuid("000000000043")}','check','${T}','${W}','support','${A3}','tenant:read','["contact_pii"]','SUPPORT_GRANT_REQUIRED','support_grant_required','corr-rcvr-002','${uuid("000000000044")}','${H("ab")}','${TS}')`,
  `INSERT INTO public.tenant_limit_buckets(bucket_key,used,reset_at_ms,updated_at) VALUES
    ('tenant:${T}:membership_invite',3,1757000000000,'${TS}')`,
  `INSERT INTO public.tenant_limit_configuration(tenant_id,action,policy_cap,action_kill,updated_at) VALUES
    ('${T}','membership_invite',10,false,'${TS}')`,
  `INSERT INTO public.platform_limit_configuration(id,configuration_version,global_kill,action_kills_json,updated_at) VALUES
    ('platform',1,false,'{}','${TS}')`,
  `INSERT INTO public.tenant_limit_idempotency(idempotency_key,request_hash,tenant_id,action,created_at) VALUES
    ('${H("ac")}','${H("ad")}','${T}','membership_invite','${TS}')`,
  `INSERT INTO public.tenant_limit_events(event_id,event_type,tenant_id,action,payload_json,created_at) VALUES
    ('${uuid("000000000045")}','tenant_limit_configuration_changed','${T}','membership_invite','{"cap":10}','${TS}')`,
  // --- legacy portable rows ---
  `UPDATE public.settings SET openai_api_key_encrypted='ciphertext-fixture',google_places_api_key_encrypted='ciphertext-fixture-2' WHERE id=1`,
  `INSERT INTO public.worker_runs(id,worker_name,status,trigger_source,result_json,started_at,completed_at,created_at) VALUES
    ('wrun-1','ai_verification','completed','cron','{"processed":2}','${TS}','${TS1}','${TS}')`,
  // --- agent runtime ---
  `INSERT INTO public.agent_prompt_versions(id,prompt_key,version,instructions_ref,instructions_sha256,allowed_tools,allowed_classifications,created_at) VALUES
    ('${uuid("000000000046")}','lead-research',1,'ref://prompts/lead-research/v1','${H("b1")}','["web_search"]','["public"]','${TS}')`,
  `INSERT INTO public.agent_policy_versions(id,policy_key,version,provider,model,state,policy_sha256,allowed_tools,allowed_classifications,created_at) VALUES
    ('${uuid("000000000047")}','lead-research',1,'fixture','fixture-model','fixture','${H("b2")}','["web_search"]','["public"]','${TS}')`,
  `INSERT INTO public.agent_runs(id,tenant_id,workspace_id,idempotency_key,input_hash,agent_role,agent_version,prompt_key,prompt_version,policy_key,policy_version,status,budget_usd,usage_cost_usd,attempt_count,max_attempts,lease_generation,started_at,ended_at,result_ref,created_at,updated_at) VALUES
    ('arun-1','${T}','${W}','idem-arun-1','${H("b3")}','lead_research',1,'lead-research',1,'lead-research',1,'complete',10,1.25,1,3,1,'${TS}','${TS1}','result://arun-1','${TS}','${TS1}')`,
  `INSERT INTO public.agent_run_inputs(run_id,tenant_id,workspace_id,input,created_at) VALUES
    ('arun-1','${T}','${W}','{"account":"acme"}','${TS}')`,
  `INSERT INTO public.agent_run_steps(id,tenant_id,workspace_id,run_id,sequence,status,policy_key,policy_version,result_ref,recorded_at) VALUES
    ('astep-1','${T}','${W}','arun-1',1,'complete','lead-research',1,'result://astep-1','${TS}')`,
  `INSERT INTO public.agent_tool_calls(id,tenant_id,workspace_id,run_id,step_id,tool_name,tool_version,permission_decision,status,input_hash,output_hash,source_ids,cost_usd,latency_ms,redacted_summary,recorded_at) VALUES
    ('atc-1','${T}','${W}','arun-1','astep-1','web_search','1.0','allowed','complete','${H("b4")}','${H("b5")}','["obs-1"]',0.05,120,'searched web','${TS}')`,
  `INSERT INTO public.agent_usage_reservations(id,tenant_id,workspace_id,run_id,idempotency_key,input_hash,reserved_cost_usd,reserved_input_tokens,reserved_output_tokens,created_at) VALUES
    ('arsv-1','${T}','${W}','arun-1','idem-arsv-1','${H("b6")}',2,1000,500,'${TS}')`,
  `INSERT INTO public.agent_usage_settlements(id,tenant_id,workspace_id,run_id,reservation_id,status,actual_cost_usd,input_tokens,output_tokens,provider_request_ref_hash,settled_at) VALUES
    ('aset-1','${T}','${W}','arun-1','arsv-1','settled',1.25,800,400,'${H("b7")}','${TS1}')`,
  `INSERT INTO public.agent_run_lease_history(tenant_id,workspace_id,run_id,lease_generation,lease_token_hash,lease_worker_hash,acquired_at,heartbeat_at,expires_at,released_at,release_reason) VALUES
    ('${T}','${W}','arun-1',1,'${H("b8")}','${H("b9")}','${TS}','${TS}','${TS1}','${TS1}','completed')`,
  // --- connector / source runtime ---
  `INSERT INTO public.connector_versions(id,source_card_id,version,execution_mode,transport,operations,output_fields,adapter_sha256,created_at) VALUES
    ('${uuid("000000000048")}','places',1,'fixture','none','["search"]','["name"]','${H("c1")}','${TS}')`,
  `INSERT INTO public.connector_accounts(id,tenant_id,workspace_id,source_card_id,connector_version,account_key,status,created_at,updated_at) VALUES
    ('acct-1','${T}','${W}','places',1,'acct-key-1','ready','${TS}','${TS}')`,
  `INSERT INTO public.source_policy_versions(id,tenant_id,workspace_id,source_card_id,connector_version,connector_account_id,policy_key,version,state,execution_mode,terms_state,allowed_operations,allowed_fields,hard_cap_units,attestation_expires_at,attestation_revoked,policy_sha256,created_at) VALUES
    ('pol-1','${T}','${W}','places',1,'acct-1','places-policy',1,'active','fixture','approved','["search"]','["name"]',100,'2030-01-01T00:00:00Z',false,'${H("c2")}','${TS}')`,
  `INSERT INTO public.current_source_policy_activations(id,tenant_id,workspace_id,policy_key,policy_version,source_policy_id,activated_by_hash,activation_reason) VALUES
    ('act-1','${T}','${W}','places-policy',1,'pol-1','${H("cb")}','rehearsal activation')`,
  `INSERT INTO public.source_runs(id,tenant_id,workspace_id,source_card_id,connector_version,connector_account_id,source_policy_id,idempotency_key,input_hash,operation,status,hard_cap_units,max_attempts,started_at,ended_at,result_ref,created_at,updated_at) VALUES
    ('srun-1','${T}','${W}','places',1,'acct-1','pol-1','idem-srun-1','${H("c3")}','search','completed',100,3,'${TS}','${TS1}','result://srun-1','${TS}','${TS1}')`,
  `INSERT INTO public.source_run_units(id,tenant_id,workspace_id,run_id,sequence,checkpoint_key,input_hash,status,attempt_count,max_attempts,reserved_units,actual_units,complete,started_at,ended_at,created_at,updated_at) VALUES
    ('unit-1','${T}','${W}','srun-1',1,'ckpt-1','${H("c4")}','completed',1,3,10,10,true,'${TS}','${TS1}','${TS}','${TS1}')`,
  `INSERT INTO public.source_run_lease_history(tenant_id,workspace_id,run_id,unit_id,lease_generation,lease_token_hash,lease_worker_hash,acquired_at,heartbeat_at,expires_at,released_at,release_reason) VALUES
    ('${T}','${W}','srun-1','unit-1',1,'${H("c5")}','${H("c6")}','${TS}','${TS}','${TS1}','${TS1}','completed')`,
  `INSERT INTO public.source_observations(id,tenant_id,workspace_id,run_id,unit_id,source_card_id,operation,observed_at,payload_ref,payload_sha256,field_names,provenance_sha256,dedupe_key_hash,redaction_flags,created_at) VALUES
    ('obs-1','${T}','${W}','srun-1','unit-1','places','search','${TS}','payload://obs-1','${H("c7")}','["name","phone"]','${H("c8")}','${H("c9")}','[]','${TS}')`,
  `INSERT INTO public.source_usage_reservations(id,tenant_id,workspace_id,run_id,unit_id,idempotency_key,input_hash,reserved_units,created_at) VALUES
    ('srsv-1','${T}','${W}','srun-1','unit-1','idem-srsv-1','${H("c4")}',10,'${TS}')`,
  `INSERT INTO public.source_usage_settlements(id,tenant_id,workspace_id,run_id,unit_id,reservation_id,status,actual_units,settled_at) VALUES
    ('sset-1','${T}','${W}','srun-1','unit-1','srsv-1','settled',10,'${TS1}')`,
  // --- document intake pipeline (F-04/F-05 state machine) ---
  `INSERT INTO public.documents(id,tenant_id,workspace_id,source_kind,source_identity,created_at) VALUES
    ('${DOC}','${T}','${W}','tenant_upload','tenant_upload:${DOC}','${TS}')`,
  `INSERT INTO public.document_versions(id,tenant_id,workspace_id,document_id,original_name,format,media_type,declared_byte_size,max_bytes,scanner_policy_version,object_key,created_at,updated_at) VALUES
    ('${VER}','${T}','${W}','${DOC}','notes.txt','txt','text/plain',5,52428800,'launch-v1','${OBJ}','${TS}','${TS}')`,
  `UPDATE public.document_versions SET status='quarantined',checksum='${H("d1")}',verified_byte_size=5,verified_media_type='text/plain',finalized_at='${TS1}',updated_at='${TS1}' WHERE id='${VER}'`,
  `INSERT INTO public.document_version_finalizations(tenant_id,workspace_id,document_id,source_identity,version_id,processing_version_id,checksum,checksum_algorithm,verified_byte_size,verified_media_type,scanner_policy_version,dedupe_decision,finalized_at) VALUES
    ('${T}','${W}','${DOC}','tenant_upload:${DOC}','${VER}','${VER}','${H("d1")}','sha256',5,'text/plain','launch-v1','canonical','${TS1}')`,
  `INSERT INTO public.document_scan_jobs(id,tenant_id,workspace_id,document_id,version_id,object_key,checksum,policy_version,max_attempts,created_at,updated_at) VALUES
    ('${SCAN}','${T}','${W}','${DOC}','${VER}','${OBJ}','${H("d1")}','launch-v1',3,'${TS1}','${TS1}')`,
  `UPDATE public.document_versions SET status='scanning',updated_at='${TS1}' WHERE id='${VER}'`,
  `UPDATE public.document_scan_jobs SET status='running',attempt_count=1,lease_generation=1,
    lease_token_hash='${H("d2")}',lease_worker_hash='${H("d3")}',
    lease_acquired_at=pg_catalog.statement_timestamp(),lease_heartbeat_at=pg_catalog.statement_timestamp(),
    lease_expires_at=pg_catalog.statement_timestamp()+interval '1 minute',updated_at=pg_catalog.statement_timestamp()
    WHERE id='${SCAN}'`,
  `UPDATE public.document_scan_jobs SET status='clean',lease_token_hash=NULL,lease_worker_hash=NULL,
    lease_acquired_at=NULL,lease_heartbeat_at=NULL,lease_expires_at=NULL,verdict='clean',
    scanner_adapter_id='fixture-scanner',scanner_version='1.0.0',scanned_checksum='${H("d1")}',
    scanned_at=pg_catalog.statement_timestamp(),result_policy_version='launch-v1',result_retryable=false,
    updated_at=pg_catalog.statement_timestamp() WHERE id='${SCAN}'`,
  `UPDATE public.document_versions SET status='clean',updated_at=pg_catalog.statement_timestamp() WHERE id='${VER}'`,
  `INSERT INTO public.document_scan_outbox(dispatch_key,tenant_id,workspace_id,document_id,version_id,scan_job_id,object_key,checksum,policy_version,created_at,updated_at) VALUES
    ('scan:${T}:${VER}:${H("d1")}:launch-v1','${T}','${W}','${DOC}','${VER}','${SCAN}','${OBJ}','${H("d1")}','launch-v1','${TS1}','${TS1}')`,
  `INSERT INTO public.document_upload_reservations(id,tenant_id,workspace_id,document_id,version_id,idempotency_key,request_fingerprint,object_key,created_at) VALUES
    ('${uuid("000000000049")}','${T}','${W}','${DOC}','${VER}','idem-upload-1','${H("d4")}','${OBJ}','${TS}')`,
  `INSERT INTO public.document_extraction_jobs(id,tenant_id,workspace_id,document_id,version_id,canonical_finalization_id,scan_job_id,checksum,scanner_policy_version,parser_id,parser_version,idempotency_key,input_hash,max_attempts,created_at,updated_at)
    SELECT '${XJOB}','${T}','${W}','${DOC}','${VER}',f.id,'${SCAN}','${H("d1")}','launch-v1','launch-text-lines','1.0.0','extract-${XJOB}','${H("d5")}',3,'${TS2}','${TS2}'
    FROM public.document_version_finalizations f WHERE f.version_id='${VER}'`,
  `UPDATE public.document_extraction_jobs SET status='running',attempt_count=1,lease_generation=1,
    lease_token_hash='${H("d6")}',lease_worker_hash='${H("d7")}',
    lease_acquired_at=pg_catalog.statement_timestamp(),lease_heartbeat_at=pg_catalog.statement_timestamp(),
    lease_expires_at=pg_catalog.statement_timestamp()+interval '1 minute',updated_at=pg_catalog.statement_timestamp()
    WHERE id='${XJOB}'`,
  `UPDATE public.document_extraction_jobs SET status='complete',lease_token_hash=NULL,lease_worker_hash=NULL,
    lease_acquired_at=NULL,lease_heartbeat_at=NULL,lease_expires_at=NULL,
    result_lease_generation=1,result_lease_token_hash='${H("d6")}',event_at=pg_catalog.statement_timestamp(),
    output_sha256='${H("d8")}',output_block_count=2,output_chunk_count=1,quality_score=1,review_required=false,
    warnings='[]'::jsonb,updated_at=pg_catalog.statement_timestamp() WHERE id='${XJOB}'`,
  `INSERT INTO public.document_extraction_outputs(job_id,tenant_id,workspace_id,document_id,version_id,checksum,scanner_policy_version,parser_id,parser_version,input_hash,output_sha256,artifact,block_count,chunk_count,created_at) VALUES
    ('${XJOB}','${T}','${W}','${DOC}','${VER}','${H("d1")}','launch-v1','launch-text-lines','1.0.0','${H("d5")}','${H("d8")}','{"blocks":[{"text":"Acme operates"},{"text":"in Munich"}]}',2,1,'${TS2}')`,
  `INSERT INTO public.tenant_worker_dispatch_leases(lease_id,tenant_id,workspace_id,job_id,run_id,selector_hash,lease_generation,worker_name,action,not_before,expires_at,revoked_at,revocation_reason,record_version,integrity_version,correlation_id,created_at,updated_at) VALUES
    ('${uuid("00000000004a")}','${T}','${W}','${XJOB}','${uuid("00000000004b")}','${H("d9")}',1,'agent_runtime','agent_runtime:execute','${TS}','2026-08-29T13:00:00Z','${TS2}','superseded',1,'internal-worker-lease-v1','corr-rcvr-003','${TS}','${TS2}')`,
  // --- L-03 URL intake, lifecycle, deletion, retention, knowledge ---
  `INSERT INTO public.documents(id,tenant_id,workspace_id,source_kind,source_identity,created_at) VALUES
    ('${DOC2}','${T}','${W}','authorized_url','authorized_url:${DOC2}','${TS}')`,
  `INSERT INTO public.document_versions(id,tenant_id,workspace_id,document_id,original_name,format,media_type,declared_byte_size,max_bytes,scanner_policy_version,object_key,created_at,updated_at) VALUES
    ('${VER2}','${T}','${W}','${DOC2}','web.pdf','pdf','application/pdf',10,52428800,'launch-v1','tenants/${T}/documents/${DOC2}/versions/${VER2}/original','${TS}','${TS}')`,
  `INSERT INTO public.document_url_sources(tenant_id,workspace_id,document_id,url_sha256,normalized_url,created_at) VALUES
    ('${T}','${W}','${DOC2}','${H("e1")}','https://example.com/web.pdf','${TS}')`,
  `INSERT INTO public.document_url_intake_requests(id,tenant_id,workspace_id,document_id,idempotency_key,url_sha256,normalized_url,requested_name,state,reason_code,created_at,updated_at) VALUES
    ('${uuid("00000000004c")}','${T}','${W}','${DOC2}','idem-url-1','${H("e1")}','https://example.com/web.pdf','web.pdf','failed','fetch_timeout','${TS}','${TS}')`,
  `INSERT INTO public.document_lifecycle_events(tenant_id,workspace_id,document_id,version_id,actor_kind,actor_membership_id,from_state,to_state,reason_code,correlation_id,created_at) VALUES
    ('${T}','${W}','${DOC}','${VER}','member','${M1}','quarantined','clean','scan_clean','corr-rcvr-004','${TS2}')`,
  `INSERT INTO public.document_deletion_requests(id,tenant_id,workspace_id,document_id,version_id,requested_by,reason_code,state,resolved_at,created_at) VALUES
    ('${uuid("00000000004d")}','${T}','${W}','${DOC2}','${VER2}','${A1}','member_requested','denied','${TS2}','${TS2}')`,
  `INSERT INTO public.document_retention_evaluations(tenant_id,workspace_id,document_id,version_id,input_sha256,disposition,reason,policy_version,retention_expires_at,evaluated_at,correlation_id,created_at) VALUES
    ('${T}','${W}','${DOC}','${VER}','sha256:${H("e2")}','retain','current_version','retention-v1','2026-11-27T12:00:00Z','${TS2}','corr-rcvr-005','${TS2}')`,
  `INSERT INTO public.knowledge_evidence_items(tenant_id,workspace_id,document_id,version_id,evidence_id,checksum,scanner_policy_version,extraction_input_hash,parser_id,parser_version,evidence_grade,origin,block_ordinal,block_content_hash,source_locator,quote_start,quote_end,quote,quote_hash,extraction_job_id,created_at) VALUES
    ('${T}','${W}','${DOC}','${VER}','evidence:${H("e3")}','${H("d1")}','launch-v1','sha256:${H("d5")}','launch-text-lines','1.0.0','extracted','parser_output',0,'sha256:${H("e4")}','{"block":0}',0,13,'Acme operates','sha256:${H("e5")}','${XJOB}','${TS2}')`,
  `INSERT INTO public.knowledge_citations(tenant_id,workspace_id,citation_id,evidence_id,document_id,version_id,quote,quote_hash,source_locator,extraction_job_id,created_at) VALUES
    ('${T}','${W}','citation:${H("e6")}','evidence:${H("e3")}','${DOC}','${VER}','Acme operates','sha256:${H("e5")}','{"block":0}','${XJOB}','${TS2}')`,
  `INSERT INTO public.knowledge_claims(tenant_id,workspace_id,claim_id,document_id,version_id,claim_class,subject,predicate,current_version_id,extraction_job_id,created_at,updated_at) VALUES
    ('${T}','${W}','claim:${H("e7")}','${DOC}','${VER}','identity','Acme','legal_name','claim-version:${H("e8")}','${XJOB}','${TS2}','${TS2}')`,
  `INSERT INTO public.knowledge_claim_versions(tenant_id,workspace_id,claim_version_id,claim_id,document_id,version_id,claim_version,claim_class,subject,predicate,value,polarity,material,confidence_basis_points,claim_status,review_state,citation_ids,evidence_ids,extraction_job_id,created_at) VALUES
    ('${T}','${W}','claim-version:${H("e8")}','claim:${H("e7")}','${DOC}','${VER}',1,'identity','Acme','legal_name','Acme Corp','positive',true,9000,'proposed','proposed','["citation:${H("e6")}"]','["evidence:${H("e3")}"]','${XJOB}','${TS2}')`,
  `INSERT INTO public.knowledge_claim_evidence_edges(tenant_id,workspace_id,claim_version_id,citation_id,evidence_id,edge_ordinal,created_at) VALUES
    ('${T}','${W}','claim-version:${H("e8")}','citation:${H("e6")}','evidence:${H("e3")}',0,'${TS2}')`,
  `INSERT INTO public.knowledge_claim_review_decisions(tenant_id,workspace_id,decision_id,claim_id,claim_version_id,outcome_claim_version_id,action,reason_code,reviewer_membership_id,created_at) VALUES
    ('${T}','${W}','decision:${H("e9")}','claim:${H("e7")}','claim-version:${H("e8")}','claim-version:${H("e8")}','approve','accurate','${M1}','${TS2}')`,
  // --- L-04 understanding/strategy ---
  `INSERT INTO public.business_understanding_versions(version_id,tenant_id,workspace_id,proposal_ref,revision,content_hash,claim_set_hash,review_hash,status,source,review,created_at,updated_at) VALUES
    ('understanding-version:${H("f1")}','${T}','${W}','proposal:rcvr-1',1,'sha256:${H("f2")}','sha256:${H("f3")}','sha256:${H("f4")}','draft','{"kind":"member_authored"}','{"status":"draft","reviewHash":"sha256:${H("f4")}"}','${TS}','${TS}')`,
  `INSERT INTO public.business_understanding_review_events(tenant_id,workspace_id,version_id,sequence,from_status,to_status,actor,at,reason,event,created_at) VALUES
    ('${T}','${W}','understanding-version:${H("f1")}',1,'draft','in_review','{"kind":"human","actorId":"${A1}"}','${TS1}','submit','{"note":"submitted"}','${TS1}')`,
  `INSERT INTO public.adaptive_question_sessions(tenant_id,workspace_id,session_ref,tenant_ref,understanding_version_id,session,session_hash,created_at) VALUES
    ('${T}','${W}','session:rcvr-1','tenant:${T}','understanding-version:${H("f1")}','{"questions":[]}','sha256:${H("f5")}','${TS}')`,
  `INSERT INTO public.adaptive_question_answers(tenant_id,workspace_id,session_ref,tenant_ref,understanding_version_id,answer_id,question_ref,uncertainty_id,disposition,answer,claim_update,recorded_at) VALUES
    ('${T}','${W}','session:rcvr-1','tenant:${T}','understanding-version:${H("f1")}','answer:1','question:1','uncertainty:1','answered','{"text":"we sell to dental labs"}',NULL,'${TS1}')`,
  `INSERT INTO public.icp_versions(version_id,tenant_id,workspace_id,stable_key,revision,content_hash,understanding_version_id,review_hash,status,source,review,created_at,updated_at) VALUES
    ('icp-version:${H("f6")}','${T}','${W}','icp:rcvr',1,'sha256:${H("f7")}','understanding-version:${H("f1")}','sha256:${H("f8")}','approved','{"kind":"member_authored"}','{"status":"approved","reviewHash":"sha256:${H("f8")}"}','${TS}','${TS}')`,
  `INSERT INTO public.icp_review_events(tenant_id,workspace_id,version_id,sequence,from_status,to_status,actor,at,reason,event,created_at) VALUES
    ('${T}','${W}','icp-version:${H("f6")}',1,'draft','in_review','{"kind":"human","actorId":"${A1}"}','${TS1}','submit','{"note":"submitted"}','${TS1}')`,
  `INSERT INTO public.lead_play_versions(version_id,tenant_id,workspace_id,stable_key,revision,icp_version_id,understanding_version_id,content_hash,review_hash,status,source,review,created_at,updated_at) VALUES
    ('lead-play-version:${H("f9")}','${T}','${W}','play:rcvr',1,'icp-version:${H("f6")}','understanding-version:${H("f1")}','sha256:${H("fa")}','sha256:${H("fb")}','approved','{"kind":"member_authored"}','{"status":"approved","reviewHash":"sha256:${H("fb")}"}','${TS}','${TS}')`,
  `INSERT INTO public.lead_play_review_events(tenant_id,workspace_id,version_id,sequence,from_status,to_status,actor,at,reason,event,created_at) VALUES
    ('${T}','${W}','lead-play-version:${H("f9")}',1,'draft','in_review','{"kind":"human","actorId":"${A1}"}','${TS1}','submit','{"note":"submitted"}','${TS1}')`,
  `INSERT INTO public.lead_play_simulations(simulation_id,tenant_id,workspace_id,play_version_id,play_review_hash,simulation_hash,input,simulation,created_at) VALUES
    ('lead-play-simulation:${H("fc")}','${T}','${W}','lead-play-version:${H("f9")}','sha256:${H("fb")}','sha256:${H("fd")}','{"sample":true}','{"verdict":"ok"}','${TS1}')`,
  `INSERT INTO public.lead_play_simulation_reviews(tenant_id,workspace_id,play_version_id,simulation_id,eligibility_hash,decision,review,created_at) VALUES
    ('${T}','${W}','lead-play-version:${H("f9")}','lead-play-simulation:${H("fc")}','sha256:${H("fe")}','eligible','{"note":"eligible"}','${TS1}')`,
  `INSERT INTO public.lead_play_activation_states(tenant_id,workspace_id,stable_key,state_hash,state,created_at,updated_at) VALUES
    ('${T}','${W}','play:rcvr','sha256:${H("ff")}','{"state":"activation_review","policyVersion":1,"reviewIdempotencyKey":"idem-act-1","requestedByHash":"${H("b7")}","policyReceiptId":"${uuid("000000000050")}","activationRequestId":"${uuid("000000000051")}"}','${TS}','${TS}')`,
  // --- L-05 discovery / canonical accounts / contacts / review queue ---
  `INSERT INTO public.discovery_plans(plan_id,tenant_id,workspace_id,plan_sha256,status,play_stable_key,play_version_id,play_revision,source_keys,limits,payload,created_at) VALUES
    ('discovery-plan:${H("01")}','${T}','${W}','${H("02")}','plan_only','play:rcvr','lead-play-version:${H("f9")}',1,'["places"]',
    '{"maxAccounts":5,"maxProviderRequests":10,"maxSpendCents":0}',
    jsonb_build_object(
      'planId','discovery-plan:${H("01")}','tenantId','${T}','workspaceId','${W}',
      'planHash','sha256:${H("02")}','status','plan_only',
      'play',jsonb_build_object('stableKey','play:rcvr','versionId','lead-play-version:${H("f9")}','revision',1),
      'tasks','[]'::jsonb,'limits','{"maxAccounts":5,"maxProviderRequests":10,"maxSpendCents":0}'::jsonb,
      'createdAt','2026-08-29T12:00:00.000Z'),
    '${TS}')`,
  `INSERT INTO public.discovery_runs(run_id,tenant_id,workspace_id,plan_id,status,run_sha256,payload,created_at,updated_at) VALUES
    ('discovery-run:${H("04")}','${T}','${W}','discovery-plan:${H("01")}','completed','${H("05")}',
    jsonb_build_object(
      'runId','discovery-run:${H("04")}','tenantId','${T}','workspaceId','${W}',
      'plan',jsonb_build_object('planId','discovery-plan:${H("01")}'),
      'runHash','sha256:${H("05")}','status','completed',
      'createdAt','2026-08-29T12:00:00.000Z','updatedAt','2026-08-29T12:01:00.000Z'),
    '${TS}','${TS1}')`,
  `INSERT INTO public.canonical_accounts(account_id,tenant_id,workspace_id,version,status,display_name,profile,profile_sha256,exact_keys,observation_refs,created_at,updated_at) VALUES
    ('${ACCT_A}','${T}','${W}',1,'active','Acme Corp','{"name":"Acme Corp"}','${H("06")}','["domain:acme.test"]','[]','${TS}','${TS}'),
    ('${ACCT_B}','${T}','${W}',1,'active','Beta Inc','{"name":"Beta Inc"}','${H("07")}','[]','[]','${TS}','${TS}')`,
  `INSERT INTO public.account_source_observations(observation_id,tenant_id,workspace_id,account_id,source_key,namespace,external_id,observed_at,payload_sha256,provenance_sha256,discovery_run_id,created_at) VALUES
    ('aobs-1','${T}','${W}','${ACCT_A}','places','places','ext-1','${TS}','${H("08")}','${H("09")}','discovery-run:${H("04")}','${TS}')`,
  `INSERT INTO public.account_resolutions(resolution_id,tenant_id,workspace_id,state,rule_id,target_account_id,candidate_account_ids,observations,resolution_sha256,created_at) VALUES
    ('account-resolution:${H("0a")}','${T}','${W}','auto_resolved','EXACT_SOURCE_ID_SAME_TENANT_NAMESPACE','${ACCT_A}','[]','["aobs-1"]','${H("0b")}','${TS}')`,
  `INSERT INTO public.account_merge_events(event_id,tenant_id,workspace_id,action,survivor_account_id,retired_account_id,evidence_observation_ids,actor,at,reason,created_at) VALUES
    ('account-merge-event:${H("0c")}','${T}','${W}','merge','${ACCT_A}','${ACCT_B}','["aobs-1"]','{"kind":"human","actorId":"${A1}"}','${TS1}','duplicate account','${TS1}')`,
  `UPDATE public.canonical_accounts SET status='merged',redirect_to_account_id='${ACCT_A}',updated_at='${TS1}' WHERE account_id='${ACCT_B}'`,
  `INSERT INTO public.account_merge_snapshots(tenant_id,workspace_id,members,state_sha256,updated_at) VALUES
    ('${T}','${W}','[{"accountId":"${ACCT_A}","members":["${ACCT_B}"]}]','${H("0d")}','${TS1}')`,
  `INSERT INTO public.contact_record_versions(version_id,tenant_id,workspace_id,account_id,stable_key,revision,review_status,suppression_disposition,freshness_state,contact_point_class,connector_key,content_sha256,version_sha256,review_sha256,payload,created_at) VALUES
    ('contact-version:${H("0e")}','${T}','${W}','${ACCT_A}','contact:rcvr-1',1,'approved','clear','KNOWN','email','places',
    '${H("0f")}','${H("10")}','${H("11")}',
    jsonb_build_object(
      'versionId','contact-version:${H("0e")}','tenantId','${T}','workspaceId','${W}','accountId','${ACCT_A}',
      'stableKey','contact:rcvr-1','revision',1,
      'review',jsonb_build_object('status','approved','reviewHash','sha256:${H("11")}'),
      'suppressionDisposition','clear','freshness',jsonb_build_object('state','KNOWN'),
      'identity',jsonb_build_object('contactPointClass','email'),
      'sourceReceipt',jsonb_build_object('connectorKey','places'),
      'contentHash','sha256:${H("0f")}','versionHash','sha256:${H("10")}',
      'createdAt','2026-08-29T12:00:00.000Z'),
    '${TS}')`,
  `INSERT INTO public.buying_center_versions(version_id,tenant_id,workspace_id,account_id,play_version_id,stable_key,revision,review_status,hypothesis_count,verified_contact_count,content_sha256,version_sha256,review_sha256,payload,created_at) VALUES
    ('buying-center-version:${H("12")}','${T}','${W}','${ACCT_A}','lead-play-version:${H("f9")}','center:rcvr-1',1,'draft',1,1,
    '${H("13")}','${H("14")}','${H("15")}',
    jsonb_build_object(
      'versionId','buying-center-version:${H("12")}','tenantId','${T}','workspaceId','${W}','accountId','${ACCT_A}',
      'playVersionId','lead-play-version:${H("f9")}','stableKey','center:rcvr-1','revision',1,
      'review',jsonb_build_object('status','draft','reviewHash','sha256:${H("15")}'),
      'hypotheses','[{"role":"champion"}]'::jsonb,
      'contentHash','sha256:${H("13")}','versionHash','sha256:${H("14")}',
      'createdAt','2026-08-29T12:00:00.000Z'),
    '${TS}')`,
  `INSERT INTO public.account_qualification_snapshots(version_id,tenant_id,workspace_id,account_id,play_version_id,play_content_sha256,policy_sha256,qualification_sha256,weighted_score,automated_decision,decision,review_status,evaluated_at,payload,created_at) VALUES
    ('account-qualification:${H("16")}','${T}','${W}','${ACCT_A}','lead-play-version:${H("f9")}','${H("fa")}','${H("17")}','${H("18")}',
    0.75,'qualified','qualified','unreviewed','${TS1}',
    jsonb_build_object(
      'versionId','account-qualification:${H("16")}','tenantId','${T}','workspaceId','${W}','accountId','${ACCT_A}',
      'playVersionId','lead-play-version:${H("f9")}','playContentHash','sha256:${H("fa")}',
      'policyHash','sha256:${H("17")}','qualificationHash','sha256:${H("18")}',
      'weightedScore',0.75,'automatedDecision','qualified','decision','qualified','reviewStatus','unreviewed',
      'reviewEvents','[]'::jsonb,'evaluatedAt','2026-08-29T12:01:00.000Z'),
    '${TS1}')`,
  `INSERT INTO public.review_queue_documents(queue_id,tenant_id,workspace_id,queue_sha256,payload,created_at,updated_at) VALUES
    ('review-queue:${H("19")}','${T}','${W}','${H("1a")}',
    jsonb_build_object('queueId','review-queue:${H("19")}','tenantId','${T}','workspaceId','${W}','queueHash','sha256:${H("1a")}'),
    '${TS}','${TS}')`,
  `INSERT INTO public.review_queue_items(item_id,queue_id,tenant_id,workspace_id,kind,subject,priority,reason,uncertainty_ids,status,enqueued_at,updated_at) VALUES
    ('review-item:${H("1b")}','review-queue:${H("19")}','${T}','${W}','qualification_review',
    '{"subjectId":"${ACCT_A}","versionId":"account-qualification:${H("16")}","contentHash":"sha256:${H("18")}"}',
    'normal','rehearsal review','[]','queued','${TS}','${TS}')`,
  `INSERT INTO public.review_queue_events(queue_id,sequence,tenant_id,workspace_id,item_id,action,actor_id,at,reason,payload,created_at) VALUES
    ('review-queue:${H("19")}',1,'${T}','${W}','review-item:${H("1b")}','enqueue',NULL,'${TS}','auto enqueue','{"auto":true}','${TS}')`,
  // --- L-06 outreach drafts / handoffs / outcomes / suppression / learning ---
  `INSERT INTO public.outreach_draft_versions(version_id,tenant_id,workspace_id,account_id,stable_key,revision,draft_kind,play_version_id,contact_version_id,created_by,review_status,content_sha256,validation_sha256,evidence_sha256,version_sha256,review_sha256,payload,evidence_payload,created_at) VALUES
    ('outreach-draft-version:${H("1c")}','${T}','${W}','${ACCT_A}','play:rcvr',1,'initial','lead-play-version:${H("f9")}','contact-version:${H("0e")}','${A1}','approved',
    '${H("1d")}','${H("1e")}','${H("1f")}','${H("20")}','${H("21")}',
    jsonb_build_object(
      'versionId','outreach-draft-version:${H("1c")}','tenantId','${T}','workspaceId','${W}','accountId','${ACCT_A}',
      'stableKey','play:rcvr','revision',1,
      'review',jsonb_build_object('status','approved','reviewHash','sha256:${H("21")}'),
      'contentHash','sha256:${H("1d")}','validationHash','sha256:${H("1e")}','evidenceDigest','sha256:${H("1f")}',
      'versionHash','sha256:${H("20")}','createdAt','2026-08-29T12:00:00.000Z'),
    '{"evidence":[]}','${TS}')`,
  `INSERT INTO public.outreach_draft_current(tenant_id,workspace_id,account_id,stable_key,state_sha256,payload,updated_at) VALUES
    ('${T}','${W}','${ACCT_A}','play:rcvr','${H("22")}',
    jsonb_build_object('tenantId','${T}','workspaceId','${W}','accountId','${ACCT_A}','stableKey','play:rcvr','stateHash','sha256:${H("22")}'),
    '${TS1}')`,
  `INSERT INTO public.outreach_handoff_attempts(attempt_id,tenant_id,workspace_id,account_id,stable_key,draft_version_id,action,status,contact_version_id,contact_stable_key,idempotency_key,input_sha256,actor_id,decided_at,completed_at,planned_at,payload) VALUES
    ('attempt:${H("23")}','${T}','${W}','${ACCT_A}','play:rcvr','outreach-draft-version:${H("1c")}','copy','released',
    'contact-version:${H("0e")}','contact:rcvr-1','idem-handoff-1','${H("24")}','${A1}','${TS}','${TS1}','${TS}',
    jsonb_build_object('status','released',
      'receipt',jsonb_build_object('receiptId','attempt:${H("23")}','action','copy','idempotencyKey','idem-handoff-1'),
      'decision',jsonb_build_object('result','allow')))`,
  `INSERT INTO public.outcome_record_versions(version_id,tenant_id,workspace_id,account_id,play_version_id,stable_key,revision,outcome,channel,draft_version_id,source_kind,recorded_by,occurred_at,recorded_at,content_sha256,version_sha256,payload,created_at) VALUES
    ('outcome-version:${H("25")}','${T}','${W}','${ACCT_A}','lead-play-version:${H("f9")}','play:rcvr',1,'replied','email','outreach-draft-version:${H("1c")}','member_observation','${A1}','${TS}','${TS}',
    '${H("26")}','${H("27")}',
    jsonb_build_object(
      'versionId','outcome-version:${H("25")}','tenantId','${T}','workspaceId','${W}','accountId','${ACCT_A}',
      'playVersionId','lead-play-version:${H("f9")}','stableKey','play:rcvr','revision',1,
      'outcome','replied','channel','email',
      'outreachDraftVersionRef',jsonb_build_object('versionId','outreach-draft-version:${H("1c")}'),
      'source',jsonb_build_object('kind','member_observation'),
      'recordedBy',jsonb_build_object('actorId','${A1}'),
      'occurredAt','2026-08-29T12:00:00.000Z','recordedAt','2026-08-29T12:00:00.000Z',
      'contentHash','sha256:${H("26")}','versionHash','sha256:${H("27")}'),
    '${TS}')`,
  `INSERT INTO public.suppression_records(record_id,tenant_id,workspace_id,account_id,contact_stable_key,disposition,reason,source_kind,actor_id,occurred_at,recorded_at,payload,record_sha256) VALUES
    ('suppression-record:${H("28")}','${T}','${W}','${ACCT_A}','contact:rcvr-1','opt_out','user request','member_recorded','${A1}','${TS}','${TS}',
    jsonb_build_object(
      'recordId','suppression-record:${H("28")}','tenantId','${T}','workspaceId','${W}','accountId','${ACCT_A}',
      'contactStableKey','contact:rcvr-1','disposition','opt_out','reason','user request',
      'source',jsonb_build_object('kind','member_recorded'),
      'actor',jsonb_build_object('actorId','${A1}'),
      'occurredAt','2026-08-29T12:00:00.000Z','recordedAt','2026-08-29T12:00:00.000Z',
      'recordHash','sha256:${H("29")}'),
    '${H("29")}')`,
  `INSERT INTO public.learning_proposal_versions(version_id,tenant_id,workspace_id,account_id,play_version_id,stable_key,revision,review_status,metric_key,content_sha256,version_sha256,review_sha256,payload,created_at) VALUES
    ('learning-proposal-version:${H("2a")}','${T}','${W}','${ACCT_A}','lead-play-version:${H("f9")}','play:rcvr',1,'draft','reply_rate',
    '${H("2b")}','${H("2c")}','${H("2d")}',
    jsonb_build_object(
      'versionId','learning-proposal-version:${H("2a")}','tenantId','${T}','workspaceId','${W}','accountId','${ACCT_A}',
      'playVersionId','lead-play-version:${H("f9")}','stableKey','play:rcvr','revision',1,
      'review',jsonb_build_object('status','draft','reviewHash','sha256:${H("2d")}'),
      'metric',jsonb_build_object('metricKey','reply_rate'),
      'contentHash','sha256:${H("2b")}','versionHash','sha256:${H("2c")}',
      'createdAt','2026-08-29T12:00:00.000Z'),
    '${TS}')`,
];

describe.skipIf(!RUN)("postgres recovery disposable rehearsal", () => {
  beforeAll(async () => {
    container = `novatrade-pgrcv-${randomUUID()}`;
    workdir = mkdtempSync(join(tmpdir(), "novatrade-pgrcv-"));
    docker(["run", "--detach", "--rm", "--name", container, "--publish", "127.0.0.1::5432",
      "--env", "POSTGRES_PASSWORD=postgres", POSTGRES_16]);
    waitForPostgres(container);
    hostPort = docker(["port", container, "5432/tcp"]).split(":").at(-1) ?? "";
    if (!hostPort) throw new Error("Disposable PostgreSQL port was not published");
    admin = postgres(hostUrl("postgres"), { max: 2, prepare: false, ssl: false, onnotice: () => undefined });
    await admin.unsafe(`CREATE DATABASE ${SRC_DB}`);
    const src = postgres(hostUrl(SRC_DB), { max: 1, prepare: false, ssl: false, onnotice: () => undefined });
    try {
      await replayAllMigrations(src);
      for (let index = 0; index < SEED_STATEMENTS.length; index += 1) {
        try {
          await src.unsafe(SEED_STATEMENTS[index]);
        } catch (error) {
          const failure = error as { message?: string };
          throw new Error(`seed #${index} failed: ${failure.message ?? "unknown"}\n${SEED_STATEMENTS[index]}`);
        }
      }
    } finally {
      await src.end({ timeout: 5 });
    }
    tools = {
      pgDump: ["docker", "exec", "-e", "PGPASSWORD=postgres", "-i", container, "pg_dump"],
      pgRestore: ["docker", "exec", "-e", "PGPASSWORD=postgres", "-i", container, "pg_restore"],
      psql: ["docker", "exec", "-e", "PGPASSWORD=postgres", "-i", container, "psql"],
    };
    archiveDir = join(workdir, "archive");
    await backupPostgresRecovery({
      url: hostUrl(SRC_DB),
      outDir: archiveDir,
      tools,
      toolUrl: toolUrl(SRC_DB),
      timeoutMs: 120_000,
    });
  }, 300_000);

  afterAll(async () => {
    await admin?.end({ timeout: 1 });
    if (container) docker(["rm", "--force", container], true);
    if (workdir) rmSync(workdir, { recursive: true, force: true });
  }, 60_000);

  async function createPreparedDest(name: string): Promise<string> {
    if (!admin) throw new Error("no admin connection");
    await admin.unsafe(`CREATE DATABASE ${name}`);
    const dst = postgres(hostUrl(name), { max: 1, prepare: false, ssl: false, onnotice: () => undefined });
    try {
      await dst.unsafe("CREATE SCHEMA auth");
      await dst.unsafe("CREATE TABLE auth.users (id uuid PRIMARY KEY)");
      await dst.unsafe("CREATE SCHEMA extensions");
      await dst.unsafe("CREATE EXTENSION IF NOT EXISTS pgcrypto WITH SCHEMA extensions");
    } finally {
      await dst.end({ timeout: 5 });
    }
    return name;
  }

  it("archives all 120 contract tables with roles/extensions metadata", async () => {
    const validated = validatePostgresRecoveryArchive(archiveDir);
    const { manifest } = validated;
    expect(manifest.format).toBe("novatrade-pg-recovery");
    expect(manifest.schemaVersion).toBe(1);
    expect(Object.keys(manifest.tables)).toHaveLength(PG_RECOVERY_TABLE_NAMES.length);
    expect(manifest.tables.tenants.rows).toBe(1);
    expect(manifest.tables.document_extraction_jobs.rows).toBe(1);
    expect(manifest.tables.document_extraction_jobs.triggers.map((t: { name: string }) => t.name))
      .toContain("trg_document_extraction_job_guard");
    expect(manifest.tables.tenants.rlsEnabled).toBe(true);
    expect(manifest.archive.secretBearing).toBe(true);
    expect(manifest.archive.requiredRoles).toEqual(expect.arrayContaining([
      "novatrade_agent_runtime_definer",
      "novatrade_document_pipeline_definer",
      "novatrade_l04_strategy_definer",
      "novatrade_worker_dispatch_definer",
    ]));
    expect(manifest.source.extensions.map((e: { name: string }) => e.name)).toContain("pgcrypto");
    expect(manifest.archive.dumpTableData).toHaveLength(PG_RECOVERY_TABLE_NAMES.length);
  });

  it("restores atomically into a prepared destination and verifies rows/digests/RLS/triggers", async () => {
    const dst = await createPreparedDest("pgrcv_dst");
    const manifest = validatePostgresRecoveryArchive(archiveDir).manifest;
    const result = await restorePostgresRecovery({
      dir: archiveDir,
      url: hostUrl(dst),
      database: dst,
      tools,
      toolUrl: toolUrl(dst),
      timeoutMs: 180_000,
    });
    expect(result.tables).toBe(PG_RECOVERY_TABLE_NAMES.length);
    // verifyRestoredDatabase already ran inside restore; re-run for an explicit check.
    await expect(verifyRestoredDatabase({ url: hostUrl(dst), manifest }))
      .resolves.toEqual({ tables: PG_RECOVERY_TABLE_NAMES.length });
    // Spot-check the deepest reference graph survives intact.
    const probe = postgres(hostUrl(dst), { max: 1, prepare: false, ssl: false });
    try {
      const rows = await probe.unsafe(`
        SELECT j.id job, o.output_sha256, c.claim_id, e.evidence_id, cv.claim_version_id, edge.edge_ordinal
          FROM public.document_extraction_jobs j
          JOIN public.document_extraction_outputs o ON o.job_id = j.id
          JOIN public.knowledge_claims c ON c.extraction_job_id = j.id
          JOIN public.knowledge_claim_versions cv ON cv.claim_version_id = c.current_version_id
          JOIN public.knowledge_claim_evidence_edges edge ON edge.claim_version_id = cv.claim_version_id
          JOIN public.knowledge_evidence_items e ON e.evidence_id = edge.evidence_id
         WHERE j.id = '${XJOB}'`);
      expect(rows).toHaveLength(1);
      expect(String(rows[0].claim_version_id)).toBe(`claim-version:${H("e8")}`);
      const triggers = await probe.unsafe(
        `SELECT count(*)::int n FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid
          JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND NOT t.tgisinternal`);
      expect(triggers[0].n).toBe(163);
      const rls = await probe.unsafe(
        `SELECT count(*) FILTER (WHERE relrowsecurity)::int enabled,
                count(*) FILTER (WHERE relforcerowsecurity)::int forced
           FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
          WHERE n.nspname='public' AND c.relkind='r'`);
      expect(rls[0].enabled).toBe(115);
      expect(rls[0].forced).toBe(87);
    } finally {
      await probe.end({ timeout: 5 });
    }
  }, 240_000);

  it("keeps a write committed after snapshot export out of the archive", async () => {
    const second = postgres(hostUrl(SRC_DB), { max: 1, prepare: false, ssl: false });
    const dir2 = join(workdir, "archive-snapshot");
    const marker = "70000000-0000-4000-8000-0000000000ff";
    try {
      const manifest = await backupPostgresRecovery({
        url: hostUrl(SRC_DB),
        outDir: dir2,
        tools,
        toolUrl: toolUrl(SRC_DB),
        timeoutMs: 120_000,
        afterSnapshotExport: async () => {
          // Committed mid-capture on a second connection: the exported
          // REPEATABLE READ snapshot must exclude it from dump and digests.
          await second.unsafe(`INSERT INTO public.tenants(id,slug,name,status) VALUES
            ('${marker}','rcvr-late','Late Tenant','active')`);
        },
      });
      expect(manifest.tables.tenants.rows).toBe(1);
      const dst = await createPreparedDest("pgrcv_dst_snapshot");
      await restorePostgresRecovery({
        dir: dir2, url: hostUrl(dst), database: dst, tools, toolUrl: toolUrl(dst), timeoutMs: 180_000,
      });
      const probe = postgres(hostUrl(dst), { max: 1, prepare: false, ssl: false });
      try {
        const rows = await probe.unsafe(`SELECT id FROM public.tenants WHERE id='${marker}'`);
        expect(rows).toHaveLength(0);
      } finally {
        await probe.end({ timeout: 5 });
      }
    } finally {
      await second.end({ timeout: 5 });
    }
  }, 240_000);

  it("refuses a corrupted or tampered archive offline", async () => {
    const corruptDir = join(workdir, "archive-corrupt");
    mkdirSync(corruptDir, { recursive: true });
    for (const file of [PG_RECOVERY_MANIFEST_FILE, PG_RECOVERY_CHECKSUMS_FILE, PG_RECOVERY_DUMP_FILE]) {
      writeFileSync(join(corruptDir, file), readFileSync(join(archiveDir, file)));
    }
    const dumpPath = join(corruptDir, PG_RECOVERY_DUMP_FILE);
    const bytes = readFileSync(dumpPath);
    bytes[bytes.length - 1] = bytes[bytes.length - 1] ^ 0xff;
    writeFileSync(dumpPath, bytes);
    expect(() => validatePostgresRecoveryArchive(corruptDir)).toThrow(/SHA256SUMS|corrupted|tampered/i);

    const tamperedDir = join(workdir, "archive-tampered");
    mkdirSync(tamperedDir, { recursive: true });
    for (const file of [PG_RECOVERY_MANIFEST_FILE, PG_RECOVERY_CHECKSUMS_FILE, PG_RECOVERY_DUMP_FILE]) {
      writeFileSync(join(tamperedDir, file), readFileSync(join(archiveDir, file)));
    }
    const manifest = JSON.parse(readFileSync(join(tamperedDir, PG_RECOVERY_MANIFEST_FILE), "utf8"));
    delete manifest.tables.tenants;
    writeFileSync(join(tamperedDir, PG_RECOVERY_MANIFEST_FILE), serializeManifest(manifest));
    expect(() => validatePostgresRecoveryArchive(tamperedDir)).toThrow(/SHA256SUMS|corrupted|tampered/i);
  });

  it("refuses a manifest that claims a role the cluster lacks", async () => {
    const dir = join(workdir, "archive-role");
    mkdirSync(dir, { recursive: true });
    for (const file of [PG_RECOVERY_MANIFEST_FILE, PG_RECOVERY_DUMP_FILE]) {
      writeFileSync(join(dir, file), readFileSync(join(archiveDir, file)));
    }
    const manifest = JSON.parse(readFileSync(join(dir, PG_RECOVERY_MANIFEST_FILE), "utf8"));
    manifest.archive.requiredRoles = [...manifest.archive.requiredRoles, "novatrade_role_that_does_not_exist"];
    writeFileSync(join(dir, PG_RECOVERY_MANIFEST_FILE), serializeManifest(manifest));
    const sums = [
      `${sha256Buffer(readFileSync(join(dir, PG_RECOVERY_MANIFEST_FILE)))}  ${PG_RECOVERY_MANIFEST_FILE}`,
      `${manifest.archive.sha256}  ${PG_RECOVERY_DUMP_FILE}`,
    ].join("\n") + "\n";
    writeFileSync(join(dir, PG_RECOVERY_CHECKSUMS_FILE), sums);
    expect(() => validatePostgresRecoveryArchive(dir)).not.toThrow();
    const dst = await createPreparedDest("pgrcv_dst_role");
    await expect(restorePostgresRecovery({
      dir, url: hostUrl(dst), database: dst, tools, toolUrl: toolUrl(dst), timeoutMs: 60_000,
    })).rejects.toThrow(/missing required roles/i);
    // Preflight refused before any mutation: the destination is still a fresh empty database.
    const probe = postgres(hostUrl(dst), { max: 1, prepare: false, ssl: false });
    try {
      const rows = await probe.unsafe(`SELECT count(*)::int n FROM pg_class c
        JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relkind='r'`);
      expect(rows[0].n).toBe(0);
    } finally {
      await probe.end({ timeout: 5 });
    }
  }, 120_000);

  it("refuses tool-url/database/remote/non-empty destinations before mutation", async () => {
    const dst = await createPreparedDest("pgrcv_dst_guard");
    // tool-url bound to a different database name: refuse before connecting.
    await expect(restorePostgresRecovery({
      dir: archiveDir, url: hostUrl(dst), database: dst, tools,
      toolUrl: toolUrl(SRC_DB), timeoutMs: 30_000,
    })).rejects.toThrow(/tool-url database/i);
    // --database must equal the URL database.
    await expect(restorePostgresRecovery({
      dir: archiveDir, url: hostUrl(dst), database: SRC_DB, tools,
      toolUrl: toolUrl(dst), timeoutMs: 30_000,
    })).rejects.toThrow(/destination mismatch/i);
    // Non-loopback destination refused without the explicit acknowledgement.
    await expect(restorePostgresRecovery({
      dir: archiveDir,
      url: `postgresql://postgres:postgres@db.internal:5432/${dst}`,
      database: dst, tools, timeoutMs: 30_000,
    })).rejects.toThrow(/loopback/i);
    // Restore once so the destination becomes non-empty, then prove a second
    // restore is refused before mutation.
    await restorePostgresRecovery({
      dir: archiveDir, url: hostUrl(dst), database: dst, tools, toolUrl: toolUrl(dst), timeoutMs: 180_000,
    });
    await expect(restorePostgresRecovery({
      dir: archiveDir, url: hostUrl(dst), database: dst, tools, toolUrl: toolUrl(dst), timeoutMs: 30_000,
    })).rejects.toThrow(/not empty/i);
  }, 300_000);

  it("rechecks destination emptiness inside the restore transaction (RESTRICT)", async () => {
    const dst = await createPreparedDest("pgrcv_dst_race");
    // Simulates a concurrent write landing between preflight and the
    // destructive transaction: the in-transaction guard must refuse and the
    // surprise table must survive untouched.
    const injector = postgres(hostUrl(dst), { max: 1, prepare: false, ssl: false });
    try {
      const debugFile = join(workdir, "restrict-race-stderr.log");
      process.env.PG_RECOVERY_TOOL_STDERR_FILE = debugFile;
      try {
        // Raw stderr is withheld from the thrown error; the guard's reason
        // lands only in the opt-in private file.
        await expect(restorePostgresRecovery({
          dir: archiveDir, url: hostUrl(dst), database: dst, tools, toolUrl: toolUrl(dst),
          timeoutMs: 120_000,
          beforeRestore: async () => {
            await injector.unsafe(`CREATE TABLE public.concurrent_probe (id int PRIMARY KEY)`);
          },
        })).rejects.toThrow(/psql restore failed/);
        expect(readFileSync(debugFile, "utf8")).toMatch(/not empty/i);
      } finally {
        delete process.env.PG_RECOVERY_TOOL_STDERR_FILE;
      }
      const rows = await injector.unsafe("SELECT count(*)::int n FROM public.concurrent_probe");
      expect(rows[0].n).toBe(0);
      const stillThere = await injector.unsafe(`SELECT to_regclass('public.concurrent_probe') r`);
      expect(stillThere[0].r).toBe("concurrent_probe");
      const tableCount = await injector.unsafe(`SELECT count(*)::int n FROM pg_class c
        JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relkind='r'`);
      expect(tableCount[0].n).toBe(1); // only the probe table — no partial restore
    } finally {
      await injector.end({ timeout: 5 });
    }
  }, 180_000);

  it("refuses to reuse an existing output directory", async () => {
    await expect(backupPostgresRecovery({
      url: hostUrl(SRC_DB), outDir: archiveDir, tools, toolUrl: toolUrl(SRC_DB), timeoutMs: 30_000,
    })).rejects.toThrow(/already exists/i);
    // The original archive is untouched and still validates.
    expect(() => validatePostgresRecoveryArchive(archiveDir)).not.toThrow();
  }, 120_000);

  it("detects post-restore content drift via digests", async () => {
    const dst = await createPreparedDest("pgrcv_dst_drift");
    const manifest = validatePostgresRecoveryArchive(archiveDir).manifest;
    await restorePostgresRecovery({
      dir: archiveDir, url: hostUrl(dst), database: dst, tools, toolUrl: toolUrl(dst), timeoutMs: 180_000,
    });
    const probe = postgres(hostUrl(dst), { max: 1, prepare: false, ssl: false });
    try {
      await probe.unsafe(`INSERT INTO public.tenants(id,slug,name,status) VALUES
        ('70000000-0000-4000-8000-0000000000ee','drift','Drift Tenant','active')`);
      await expect(verifyRestoredDatabase({ url: hostUrl(dst), manifest }))
        .rejects.toThrow(/tenants.*digest|verification failed/i);
    } finally {
      await probe.end({ timeout: 5 });
    }
  }, 240_000);

  it("re-verifies cluster system_identifier inside the restore transaction", async () => {
    const dst = await createPreparedDest("pgrcv_dst_sysid");
    const real = await admin!.unsafe("SELECT system_identifier::text AS s FROM pg_control_system()");
    const foreign = String(BigInt(String(real[0].s)) + BigInt(1));
    // Preflight identity is correct except the captured cluster id is foreign:
    // the in-transaction guard must abort before DROP SCHEMA runs.
    const guard = buildRestoreGuardSql({
      database: dst, user: "postgres", systemIdentifier: foreign,
      requiredRoles: [], requiredExtensions: [],
    });
    let failed = false;
    try {
      execFileSync("docker", ["exec", "-i", container, "psql", "-X", "-q",
        "-v", "ON_ERROR_STOP=1", "--single-transaction", "-U", "postgres", "-d", dst, "-f", "-"],
        { input: guard, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] });
    } catch (error) {
      failed = true;
      expect(String((error as { stderr?: string }).stderr ?? "")).toMatch(/system_identifier|target mismatch/i);
    }
    expect(failed).toBe(true);
    const probe = postgres(hostUrl(dst), { max: 1, prepare: false, ssl: false });
    try {
      const ns = await probe.unsafe(`SELECT count(*)::int AS n FROM pg_namespace WHERE nspname='public'`);
      expect(ns[0].n).toBe(1); // public schema survives — the guard aborted the transaction
    } finally {
      await probe.end({ timeout: 5 });
    }
  }, 120_000);

  it("binds the backup tool path to the same cluster before pg_dump", async () => {
    const outDir = join(workdir, "tool-mismatch-backup");
    // Fake psql reports a foreign cluster/database/user identity; the binding
    // probe must refuse before pg_dump runs and leave no partial archive.
    const fakePsql = ["node", "-e", "process.stdout.write('other_db|other_user|1\\n')", "--"];
    await expect(backupPostgresRecovery({
      url: hostUrl(SRC_DB), outDir, tools: { ...tools, psql: fakePsql },
      toolUrl: toolUrl(SRC_DB), timeoutMs: 30_000,
    })).rejects.toThrow(/tool target mismatch|different cluster/i);
    expect(existsSync(outDir)).toBe(false);
    // And the real archive is untouched.
    expect(() => validatePostgresRecoveryArchive(archiveDir)).not.toThrow();
  }, 120_000);

  it("withholds raw tool stderr (secrets) from thrown errors", async () => {
    const secret = "rcvr-synthetic-secret-4c5d6e";
    const dst = await createPreparedDest("pgrcv_dst_stderr");
    const real = await admin!.unsafe("SELECT system_identifier::text AS s FROM pg_control_system()");
    // Fake psql: answers the identity probe truthfully, then fails the
    // restore (-f) with an ERROR line embedding a synthetic secret plus a
    // multiline continuation — none of it may reach the thrown error.
    const fakePsql = ["node", "-e", `
      const a = process.argv.slice(1);
      if (a.includes("-f")) {
        process.stderr.write("ERROR: invalid input \\"${secret}\\"\\nunprefixed continuation ${secret}\\n");
        process.exit(1);
      }
      process.stdout.write("${dst}|postgres|${String(real[0].s)}\\n");
    `, "--"];
    const attempt = () => restorePostgresRecovery({
      dir: archiveDir, url: hostUrl(dst), database: dst,
      tools: { ...tools, psql: fakePsql }, toolUrl: toolUrl(dst), timeoutMs: 60_000,
    });
    let thrown: Error | undefined;
    try { await attempt(); } catch (error) { thrown = error as Error; }
    expect(thrown).toBeDefined();
    expect(thrown!.message).toMatch(/psql restore failed \(exit 1\)/);
    expect(thrown!.message).not.toContain(secret);
    // Opt-in debug file: raw stderr lands in a private 0600 file, still not
    // in the thrown error.
    const debugFile = join(workdir, "tool-stderr-debug.log");
    process.env.PG_RECOVERY_TOOL_STDERR_FILE = debugFile;
    try {
      let second: Error | undefined;
      try { await attempt(); } catch (error) { second = error as Error; }
      expect(second!.message).not.toContain(secret);
      expect(readFileSync(debugFile, "utf8")).toContain(secret);
      expect(statSync(debugFile).mode & 0o777).toBe(0o600);
    } finally {
      delete process.env.PG_RECOVERY_TOOL_STDERR_FILE;
    }
  }, 240_000);
});
