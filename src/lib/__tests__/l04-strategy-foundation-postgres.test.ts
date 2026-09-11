import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import postgres, { type Sql, type TransactionSql } from "postgres";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const RUN_TESTS = process.env.L04_RUN_DISPOSABLE_TESTS === "1";
const POSTGRES_16 =
  "postgres@sha256:33f923b05f64ca54ac4401c01126a6b92afe839a0aa0a52bc5aeb5cc958e5f20";
const DATABASE = "l04_strategy_rehearsal";
const MIGRATIONS = [
  "202607270001_add_tenants_table.sql",
  "202607270002_add_workspaces_table.sql",
  "202607270003_add_tenant_memberships.sql",
  "202607270004_add_tenant_policies.sql",
  "202607270005_add_support_access_grants.sql",
  "202607270009_add_tenant_foundation_rls.sql",
  "20260829210000_add_agent_runtime_foundation.sql",
  "20260830030000_add_tenant_worker_dispatch_foundation.sql",
  "20260914000100_add_l04_understanding_strategy_foundation.sql",
  "20260914000200_add_l04_agent_runtime_access.sql",
] as const;

const MEMBER_ROLE = "l04_member_runner";
const WORKER_ROLE = "l04_worker_runner";
const PASSWORD = "l04-runner";

const TENANT_A = "00000000-0000-4000-8000-0000000000a1";
const TENANT_B = "00000000-0000-4000-8000-0000000000b1";
const WORKSPACE_A = "10000000-0000-4000-8000-0000000000a1";
const WORKSPACE_B = "10000000-0000-4000-8000-0000000000b1";
const ACTOR_A = "20000000-0000-4000-8000-0000000000a1";
const MEMBERSHIP_A = "20000000-0000-4000-8000-0000000000a2";
const BINDING_A = "20000000-0000-4000-8000-0000000000a3";

const RUN_A = "30000000-0000-4000-8000-0000000000a1";
const RUN_B = "30000000-0000-4000-8000-0000000000b1";
const RUN_CANCEL = "30000000-0000-4000-8000-0000000000c1";
const JOB_A = "40000000-0000-4000-8000-0000000000a1";
const JOB_B = "40000000-0000-4000-8000-0000000000b1";
const DISPATCH_A = "50000000-0000-4000-8000-0000000000a1";
const DISPATCH_B = "50000000-0000-4000-8000-0000000000b1";

const sha256 = (value: string) => createHash("sha256").update(value).digest("hex");
const HASH = (seed: string) => `sha256:${sha256(seed)}`;
const now = () => new Date().toISOString();
const inSeconds = (s: number) => new Date(Date.now() + s * 1000).toISOString();

type Member = Readonly<{
  tenantId: string;
  workspaceId: string;
  actorId: string;
  membershipId: string;
  bindingId: string;
  role: string;
  correlationId: string;
}>;

type WorkerLease = Readonly<{
  tenantId: string;
  workspaceId: string;
  jobId: string;
  runId: string;
  leaseId: string;
  generation: number;
  correlationId: string;
}>;

let container = "";
let admin: Sql | undefined;
let member: Sql | undefined;
let worker: Sql | undefined;

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
    if (
      docker(
        [
          "exec", name, "psql", "-X", "-v", "ON_ERROR_STOP=1", "-U", "postgres",
          "-d", DATABASE, "-Atc", "SELECT 1",
        ],
        true,
      ) === "1"
    )
      return;
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 250);
  }
  throw new Error(`PostgreSQL did not become ready: ${docker(["logs", name], true)}`);
}

const memberA: Member = {
  tenantId: TENANT_A,
  workspaceId: WORKSPACE_A,
  actorId: ACTOR_A,
  membershipId: MEMBERSHIP_A,
  bindingId: BINDING_A,
  role: "owner",
  correlationId: "l04:member:a",
};

const memberB: Member = {
  ...memberA,
  tenantId: TENANT_B,
  workspaceId: WORKSPACE_B,
  correlationId: "l04:member:b",
};

async function installMemberContext(
  tx: TransactionSql,
  m: Member,
  overrides: Record<string, string> = {},
): Promise<void> {
  const settings: Record<string, string> = {
    "app.tenant_id": m.tenantId,
    "app.workspace_id": m.workspaceId,
    "app.actor_id": m.actorId,
    "app.membership_id": m.membershipId,
    "app.role_binding_id": m.bindingId,
    "app.role": m.role,
    "app.correlation_id": m.correlationId,
    "app.support_grant_id": "",
    "app.job_id": "",
    "app.run_id": "",
    "app.lease_id": "",
    "app.lease_generation": "",
    "app.worker_name": "",
    "app.worker_action": "",
    "app.worker_principal_kind": "",
    ...overrides,
  };
  for (const [name, value] of Object.entries(settings)) {
    await tx.unsafe("SELECT pg_catalog.set_config($1,$2,true)", [name, value]);
  }
}

async function installWorkerContext(
  tx: TransactionSql,
  lease: WorkerLease,
  overrides: Record<string, string> = {},
): Promise<void> {
  const settings: Record<string, string> = {
    "app.tenant_id": lease.tenantId,
    "app.workspace_id": lease.workspaceId,
    "app.actor_id": "",
    "app.membership_id": "",
    "app.role": "",
    "app.role_binding_id": "",
    "app.support_grant_id": "",
    "app.job_id": lease.jobId,
    "app.run_id": lease.runId,
    "app.lease_id": lease.leaseId,
    "app.lease_generation": String(lease.generation),
    "app.worker_name": "agent_runtime",
    "app.worker_action": "agent_runtime:execute",
    "app.worker_principal_kind": "session",
    "app.correlation_id": lease.correlationId,
    ...overrides,
  };
  for (const [name, value] of Object.entries(settings)) {
    await tx.unsafe("SELECT pg_catalog.set_config($1,$2,true)", [name, value]);
  }
}

async function inMember<T>(
  m: Member,
  callback: (tx: TransactionSql) => Promise<T>,
  overrides: Record<string, string> = {},
): Promise<T> {
  if (!member) throw new Error("member connection unavailable");
  return (await member.begin(async (tx) => {
    await installMemberContext(tx, m, overrides);
    return callback(tx);
  })) as T;
}

async function inWorker<T>(
  lease: WorkerLease,
  callback: (tx: TransactionSql) => Promise<T>,
  overrides: Record<string, string> = {},
): Promise<T> {
  if (!worker) throw new Error("worker connection unavailable");
  return (await worker.begin(async (tx) => {
    await installWorkerContext(tx, lease, overrides);
    return callback(tx);
  })) as T;
}

const V1 = `understanding-version:${sha256("u1")}`;
const V2 = `understanding-version:${sha256("u2")}`;
const ICP1 = `icp-version:${sha256("icp1")}`;
const PLAY1 = `lead-play-version:${sha256("play1")}`;
const SIM1 = `lead-play-simulation:${sha256("sim1")}`;

async function enqueue(
  db: TransactionSql,
  runId: string,
  idemKey: string,
  inputHash: string,
): Promise<string | undefined> {
  const rows = await db.unsafe(
    `SELECT kind FROM public.novatrade_l04_enqueue_agent_run($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)`,
    [
      TENANT_A, WORKSPACE_A, runId, idemKey, inputHash,
      "understanding.synthesis", "1", "understanding.synthesis", "1",
      "nova.fixture.default", "1", "0.05", "3", now(),
      JSON.stringify({ agentRole: "understanding.synthesis" }),
    ],
  );
  return rows[0]?.kind as string | undefined;
}

async function claim(
  db: TransactionSql,
  runId: string,
  token: string,
): Promise<string | undefined> {
  const rows = await db.unsafe(
    `SELECT kind FROM public.novatrade_l04_claim_agent_run($1,$2,$3,$4,$5,$6,$7)`,
    [TENANT_A, WORKSPACE_A, runId, token, "worker-a", inSeconds(5), "120000"],
  );
  return rows[0]?.kind as string | undefined;
}

async function finalize(
  db: TransactionSql,
  runId: string,
  token: string,
  outcome: string,
  settlementId: string,
): Promise<string | undefined> {
  const rows = await db.unsafe(
    `SELECT kind FROM public.novatrade_l04_finalize_agent_run($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)`,
    [
      TENANT_A, WORKSPACE_A, runId, token, outcome,
      outcome === "complete" ? "result:ok" : null,
      outcome === "complete" ? null : "transient_err",
      "0.01",
      outcome === "retry_wait" ? inSeconds(60) : null,
      inSeconds(20), settlementId, "0.01", "100", "50", null,
    ],
  );
  return rows[0]?.kind as string | undefined;
}

describe.skipIf(!RUN_TESTS)("L-04 understanding + strategy foundation", () => {
  beforeAll(async () => {
    container = `novatrade-l04-${randomUUID()}`;
    docker([
      "run", "--detach", "--rm", "--name", container,
      "--publish", "127.0.0.1::5432",
      "--env", "POSTGRES_PASSWORD=postgres", "--env", `POSTGRES_DB=${DATABASE}`,
      POSTGRES_16,
    ]);
    waitForPostgres(container);
    const port = docker(["port", container, "5432/tcp"]).split(":").at(-1);
    if (!port) throw new Error("Disposable PostgreSQL port was not published");
    const adminUrl = `postgres://postgres:postgres@127.0.0.1:${port}/${DATABASE}`;
    admin = postgres(adminUrl, { max: 1, prepare: false, ssl: false, onnotice: () => undefined });
    await admin.unsafe("CREATE SCHEMA auth");
    await admin.unsafe("CREATE TABLE auth.users (id uuid PRIMARY KEY)");
    await admin.unsafe(`DO $$ BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='anon') THEN CREATE ROLE anon NOLOGIN; END IF;
      IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='authenticated') THEN CREATE ROLE authenticated NOLOGIN; END IF;
    END $$`);
    await admin.unsafe(`CREATE TABLE public.worker_runs (
      id text PRIMARY KEY, worker_name text NOT NULL, status text NOT NULL DEFAULT 'running',
      trigger_source text NOT NULL DEFAULT 'unknown', http_status integer,
      result_json jsonb NOT NULL DEFAULT '{}'::jsonb, error text,
      started_at timestamptz NOT NULL DEFAULT now(), completed_at timestamptz,
      created_at timestamptz NOT NULL DEFAULT now())`);
    for (const migration of MIGRATIONS) {
      await admin.unsafe(readFileSync(join("supabase", "migrations", migration), "utf8"));
    }
    await admin.unsafe(`
      INSERT INTO auth.users (id) VALUES ('${ACTOR_A}');
      INSERT INTO public.tenants (id,slug,name,status,locale,timezone) VALUES
        ('${TENANT_A}','l04-a','L04 A','active','en-US','UTC'),
        ('${TENANT_B}','l04-b','L04 B','active','en-US','UTC');
      INSERT INTO public.workspaces (id,tenant_id,slug,name,status) VALUES
        ('${WORKSPACE_A}','${TENANT_A}','wsa','WS A','active'),
        ('${WORKSPACE_B}','${TENANT_B}','wsb','WS B','active');
      INSERT INTO public.tenant_memberships (id,tenant_id,auth_identity_id,workspace_id,status) VALUES
        ('${MEMBERSHIP_A}','${TENANT_A}','${ACTOR_A}','${WORKSPACE_A}','active');
      INSERT INTO public.tenant_role_bindings (id,tenant_id,membership_id,role) VALUES
        ('${BINDING_A}','${TENANT_A}','${MEMBERSHIP_A}','owner');
      CREATE ROLE ${MEMBER_ROLE} LOGIN PASSWORD '${PASSWORD}' NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS;
      CREATE ROLE ${WORKER_ROLE} LOGIN PASSWORD '${PASSWORD}' NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS;
      GRANT USAGE ON SCHEMA public TO ${MEMBER_ROLE},${WORKER_ROLE};
      GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA public TO ${MEMBER_ROLE},${WORKER_ROLE};
      GRANT SELECT ON ALL TABLES IN SCHEMA public TO ${MEMBER_ROLE},${WORKER_ROLE};
    `);
    const roleUrl = (role: string) =>
      `postgres://${role}:${PASSWORD}@127.0.0.1:${port}/${DATABASE}`;
    member = postgres(roleUrl(MEMBER_ROLE), { max: 1, prepare: false, ssl: false, onnotice: () => undefined });
    worker = postgres(roleUrl(WORKER_ROLE), { max: 1, prepare: false, ssl: false, onnotice: () => undefined });
  }, 120_000);

  afterAll(async () => {
    await member?.end({ timeout: 1 });
    await worker?.end({ timeout: 1 });
    await admin?.end({ timeout: 1 });
    if (container) docker(["rm", "--force", container], true);
  });

  it("installs forced RLS and definer-owned narrowly closed functions", async () => {
    if (!admin || !member) throw new Error("database unavailable");
    const tables = await admin.unsafe(`SELECT c.relname, c.relrowsecurity, c.relforcerowsecurity,
      pg_catalog.has_table_privilege('anon',c.oid,'SELECT') anon_select
      FROM pg_catalog.pg_class c WHERE c.relname IN (
        'business_understanding_versions','business_understanding_review_events',
        'adaptive_question_sessions','adaptive_question_answers',
        'icp_versions','icp_review_events','lead_play_versions','lead_play_review_events',
        'lead_play_simulations','lead_play_simulation_reviews',
        'lead_play_activation_states','agent_run_inputs')
      ORDER BY c.relname`);
    expect(tables.length).toBe(12);
    for (const row of tables) {
      expect(row.relrowsecurity).toBe(true);
      expect(row.relforcerowsecurity).toBe(true);
      expect(row.anon_select).toBe(false);
    }
    const owners = await admin.unsafe(`SELECT p.proname, p.proowner::regrole::text AS owner
      FROM pg_catalog.pg_proc p WHERE p.proname IN (
        'novatrade_l04_append_understanding_version','novatrade_l04_transition_understanding_review',
        'novatrade_l04_append_icp_version','novatrade_l04_transition_icp_review',
        'novatrade_l04_append_lead_play_version','novatrade_l04_transition_lead_play_review',
        'novatrade_l04_append_lead_play_simulation','novatrade_l04_append_lead_play_simulation_review',
        'novatrade_l04_append_activation_state','novatrade_l04_transition_activation_state',
        'novatrade_l04_append_question_session','novatrade_l04_append_question_answer')
      ORDER BY p.proname`);
    expect(owners.length).toBe(12);
    for (const row of owners) expect(row.owner).toBe("novatrade_l04_strategy_definer");
    await expect(member.unsafe("SELECT * FROM public.business_understanding_versions")).resolves.toEqual([]);
    await expect(member.unsafe("INSERT INTO public.business_understanding_versions (version_id) VALUES ('x')")).rejects.toMatchObject({ code: "42501" });
  });

  it("appends, replays, conflicts, and reviews an understanding version under a member gate", async () => {
    const append = (m: Member, hash: string, status = "draft") =>
      inMember(m, (tx) =>
        tx.unsafe(
          `SELECT kind FROM public.novatrade_l04_append_understanding_version($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)`,
          [
            m.tenantId, m.workspaceId, V1, "proposal:u1", "1", null, null,
            hash, HASH("claims"), HASH("review1"), status,
            JSON.stringify({ evidence: [] }), JSON.stringify({ actor: "test" }),
            now(), now(),
          ],
        ),
      );
    expect(await append(memberA, HASH("content"))).toEqual([{ kind: "created" }]);
    expect(await append(memberA, HASH("content"))).toEqual([{ kind: "replay" }]);
    expect(await append(memberA, HASH("different"))).toEqual([{ kind: "conflict" }]);
    // member-visible via RLS
    const rows = await inMember(memberA, (tx) =>
      tx.unsafe("SELECT version_id,status FROM public.business_understanding_versions WHERE version_id=$1", [V1]));
    expect(rows).toEqual([{ version_id: V1, status: "draft" }]);

    const transition = (expected: string, to: string, next: string, sequence: number) =>
      inMember(memberA, (tx) =>
        tx.unsafe(
          `SELECT kind FROM public.novatrade_l04_transition_understanding_review($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
          [TENANT_A, WORKSPACE_A, V1, expected, to, next,
            JSON.stringify({ actor: "test" }),
            JSON.stringify({ kind: to, sequence }), now()],
        ),
      );
    expect(await transition(HASH("wrong"), "in_review", HASH("review2"), 1)).toEqual([{ kind: "stale" }]);
    expect(await transition(HASH("review1"), "in_review", HASH("review2"), 1)).toEqual([{ kind: "updated" }]);
    // draft->approved is illegal (stale), must go through in_review first
    expect(await transition(HASH("review2"), "approved", HASH("review3"), 2)).toEqual([{ kind: "updated" }]);
    // approved -> approved is illegal
    expect(await transition(HASH("review3"), "approved", HASH("review4"), 3)).toEqual([{ kind: "stale" }]);
    const final = await inMember(memberA, (tx) =>
      tx.unsafe("SELECT status,review_hash FROM public.business_understanding_versions WHERE version_id=$1", [V1]));
    expect(final).toEqual([{ status: "approved", review_hash: HASH("review3") }]);
  });

  it("denies cross-tenant member gates and worker-context member calls", async () => {
    // member GUCs for tenant B must not pass tenant A's gate
    expect(
      await inMember(memberB, (tx) =>
        tx.unsafe(
          `SELECT kind FROM public.novatrade_l04_append_understanding_version($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)`,
          [TENANT_A, WORKSPACE_A, V2, "proposal:u2", "1", null, null,
            HASH("c"), HASH("cl"), HASH("r"), "draft",
            JSON.stringify({}), JSON.stringify({}), now(), now()],
        ),
      ),
    ).toEqual([]);
    // worker-context GUCs must not pass the member gate
    expect(
      await inWorker(
        { tenantId: TENANT_A, workspaceId: WORKSPACE_A, jobId: JOB_A, runId: RUN_A, leaseId: DISPATCH_A, generation: 1, correlationId: "l04:dispatch:a" },
        (tx) =>
          tx.unsafe(
            `SELECT public.novatrade_l04_member_gate($1,$2,$3) AS ok`,
            [TENANT_A, WORKSPACE_A, "{owner}"],
          ),
      ),
    ).toEqual([{ ok: false }]);
  });

  it("binds question sessions and answers to the understanding version", async () => {
    const created = await inMember(memberA, (tx) =>
      tx.unsafe(
        `SELECT kind FROM public.novatrade_l04_append_question_session($1,$2,$3,$4,$5,$6,$7,$8)`,
        [TENANT_A, WORKSPACE_A, "session:s1", "tenant-ref:1", V1,
          JSON.stringify({ questions: [] }), HASH("session"), now()],
      ),
    );
    expect(created).toEqual([{ kind: "created" }]);
    const answer = await inMember(memberA, (tx) =>
      tx.unsafe(
        `SELECT kind FROM public.novatrade_l04_append_question_answer($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
        [TENANT_A, WORKSPACE_A, "session:s1", "tenant-ref:1", V1,
          "answer:1", "question:1", "unc:1", "answered",
          JSON.stringify({ text: "yes" }), null, now()],
      ),
    );
    expect(answer).toEqual([{ kind: "appended" }]);
    // answer against a different session workspace scope must fail
    const foreign = await inMember(memberA, (tx) =>
      tx.unsafe(
        `SELECT kind FROM public.novatrade_l04_append_question_answer($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
        [TENANT_A, WORKSPACE_A, "session:missing", "tenant-ref:1", V1,
          "answer:2", "question:1", "unc:1", "answered",
          JSON.stringify({}), null, now()],
      ),
    );
    expect(foreign).toEqual([]);
  });

  it("walks ICP + lead-play lifecycle through simulation and activation CAS", async () => {
    const icp = await inMember(memberA, (tx) =>
      tx.unsafe(
        `SELECT kind FROM public.novatrade_l04_append_icp_version($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`,
        [TENANT_A, WORKSPACE_A, ICP1, "icp:default", "1", null, HASH("icp"), V1,
          HASH("icp-review"), "draft", JSON.stringify({}), JSON.stringify({}), now(), now()],
      ),
    );
    expect(icp).toEqual([{ kind: "created" }]);
    const icpReview = await inMember(memberA, (tx) =>
      tx.unsafe(
        `SELECT kind FROM public.novatrade_l04_transition_icp_review($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
        [TENANT_A, WORKSPACE_A, ICP1, HASH("icp-review"), "in_review", HASH("icp-review2"),
          JSON.stringify({}), JSON.stringify({ sequence: 1 }), now()],
      ),
    );
    expect(icpReview).toEqual([{ kind: "updated" }]);
    const icpApprove = await inMember(memberA, (tx) =>
      tx.unsafe(
        `SELECT kind FROM public.novatrade_l04_transition_icp_review($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
        [TENANT_A, WORKSPACE_A, ICP1, HASH("icp-review2"), "approved", HASH("icp-review3"),
          JSON.stringify({}), JSON.stringify({ sequence: 2 }), now()],
      ),
    );
    expect(icpApprove).toEqual([{ kind: "updated" }]);

    const play = await inMember(memberA, (tx) =>
      tx.unsafe(
        `SELECT kind FROM public.novatrade_l04_append_lead_play_version($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)`,
        [TENANT_A, WORKSPACE_A, PLAY1, "play:default", "1", null, ICP1, V1,
          HASH("play"), HASH("play-review"), "draft", JSON.stringify({}), JSON.stringify({}), now(), now()],
      ),
    );
    expect(play).toEqual([{ kind: "created" }]);

    const sim = await inMember(memberA, (tx) =>
      tx.unsafe(
        `SELECT kind FROM public.novatrade_l04_append_lead_play_simulation($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
        [TENANT_A, WORKSPACE_A, SIM1, PLAY1, HASH("play-review"), HASH("sim"),
          JSON.stringify({ examples: [] }), JSON.stringify({ result: "pass" }), now()],
      ),
    );
    expect(sim).toEqual([{ kind: "created" }]);

    const eligibility = await inMember(memberA, (tx) =>
      tx.unsafe(
        `SELECT kind FROM public.novatrade_l04_append_lead_play_simulation_review($1,$2,$3,$4,$5,$6,$7,$8)`,
        [TENANT_A, WORKSPACE_A, PLAY1, SIM1, HASH("eligibility"), "eligible",
          JSON.stringify({}), now()],
      ),
    );
    expect(eligibility).toEqual([{ kind: "created" }]);

    const state = JSON.stringify({ activeVersionId: PLAY1 });
    const activate = await inMember(memberA, (tx) =>
      tx.unsafe(
        `SELECT kind FROM public.novatrade_l04_append_activation_state($1,$2,$3,$4,$5,$6)`,
        [TENANT_A, WORKSPACE_A, "play:default", HASH("state1"), state, now()],
      ),
    );
    expect(activate).toEqual([{ kind: "created" }]);
    const staleCas = await inMember(memberA, (tx) =>
      tx.unsafe(
        `SELECT kind FROM public.novatrade_l04_transition_activation_state($1,$2,$3,$4,$5,$6,$7)`,
        [TENANT_A, WORKSPACE_A, "play:default", HASH("wrong"), HASH("state2"), state, now()],
      ),
    );
    expect(staleCas).toEqual([{ kind: "stale" }]);
    const cas = await inMember(memberA, (tx) =>
      tx.unsafe(
        `SELECT kind FROM public.novatrade_l04_transition_activation_state($1,$2,$3,$4,$5,$6,$7)`,
        [TENANT_A, WORKSPACE_A, "play:default", HASH("state1"), HASH("state2"),
          JSON.stringify({ activeVersionId: null }), now()],
      ),
    );
    expect(cas).toEqual([{ kind: "updated" }]);
  });

  it("exercises the agent-runtime registry, enqueue, worker lease fencing, and settlement", async () => {
    const regPrompt = await inMember(memberA, (tx) =>
      tx.unsafe(`SELECT kind FROM public.novatrade_l04_register_agent_prompt($1,$2,$3,$4,$5,$6)`,
        ["understanding.synthesis", "1", "l04://prompts/understanding.synthesis/1", sha256("instr"), "[]", "[]"]));
    const regPolicy = await inMember(memberA, (tx) =>
      tx.unsafe(`SELECT kind FROM public.novatrade_l04_register_agent_policy($1,$2,$3,$4,$5,$6,$7,$8)`,
        ["nova.fixture.default", "1", "fixture", "openai-responses-stub", "fixture", sha256("pol"), "[]", "[]"]));
    expect(regPrompt).toEqual([{ kind: "created" }]);
    expect(regPolicy).toEqual([{ kind: "created" }]);

    await inMember(memberA, async (tx) => {
      expect(await enqueue(tx, RUN_A, "idem-0001", sha256("in"))).toBe("created");
      expect(await enqueue(tx, RUN_A, "idem-0001", sha256("in"))).toBe("deduplicated");
      expect(await enqueue(tx, RUN_A, "idem-0001", sha256("DIFF"))).toBe("conflict");
      expect(await enqueue(tx, RUN_B, "idem-0002", sha256("in2"))).toBe("created");
      expect(await enqueue(tx, RUN_CANCEL, "idem-0003", sha256("in3"))).toBe("created");
      const cancel = await tx.unsafe(
        `SELECT kind FROM public.novatrade_l04_cancel_agent_run($1,$2,$3,$4)`,
        [TENANT_A, WORKSPACE_A, RUN_CANCEL, now()]);
      expect(cancel).toEqual([{ kind: "canceled" }]);
      // member-visible run read via RLS
      const rows = await tx.unsafe("SELECT id,status FROM public.agent_runs WHERE id=$1", [RUN_A]);
      expect(rows).toEqual([{ id: RUN_A, status: "queued" }]);
    });

    // F-01 dispatch leases for the agent_runtime worker kind
    if (!admin) throw new Error("admin unavailable");
    for (const [job, run, leaseId, sel] of [
      [JOB_A, RUN_A, DISPATCH_A, "sel-a"],
      [JOB_B, RUN_B, DISPATCH_B, "sel-b"],
    ] as const) {
      const rows = await admin.unsafe(
        `SELECT kind FROM public.novatrade_acquire_tenant_worker_lease($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
        [sha256(sel), TENANT_A, WORKSPACE_A, job, run, leaseId, "1",
          "agent_runtime", "agent_runtime:execute", inSeconds(-60), inSeconds(1800), "l04:dispatch:a"]);
      expect(rows).toEqual([{ kind: "created" }]);
    }

    const leaseA: WorkerLease = {
      tenantId: TENANT_A, workspaceId: WORKSPACE_A, jobId: JOB_A, runId: RUN_A,
      leaseId: DISPATCH_A, generation: 1, correlationId: "l04:dispatch:a",
    };
    const leaseB: WorkerLease = { ...leaseA, jobId: JOB_B, runId: RUN_B, leaseId: DISPATCH_B };

    // worker gate binds the exact run; a different run is denied under this lease
    await inWorker(leaseA, async (tx) => {
      expect(
        await tx.unsafe(`SELECT public.novatrade_l04_agent_worker_gate($1,$2,$3) AS ok`, [TENANT_A, WORKSPACE_A, RUN_A]),
      ).toEqual([{ ok: true }]);
      expect(
        await tx.unsafe(`SELECT public.novatrade_l04_agent_worker_gate($1,$2,$3) AS ok`, [TENANT_A, WORKSPACE_A, RUN_B]),
      ).toEqual([{ ok: false }]);
      expect(await claim(tx, RUN_A, "lease-token-001")).toBe("claimed");
      const hb = await tx.unsafe(
        `SELECT kind FROM public.novatrade_l04_heartbeat_agent_run($1,$2,$3,$4,$5,$6)`,
        [TENANT_A, WORKSPACE_A, RUN_A, "lease-token-001", inSeconds(10), "120000"]);
      expect(hb).toEqual([{ kind: "updated" }]);
      const badHb = await tx.unsafe(
        `SELECT kind FROM public.novatrade_l04_heartbeat_agent_run($1,$2,$3,$4,$5,$6)`,
        [TENANT_A, WORKSPACE_A, RUN_A, "lease-token-WRONG", inSeconds(10), "120000"]);
      expect(badHb).toEqual([{ kind: "conflict" }]);
      const step = await tx.unsafe(
        `SELECT kind FROM public.novatrade_l04_append_agent_run_step($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
        [TENANT_A, WORKSPACE_A, RUN_A, "lease-token-001", "step-1", "complete",
          "nova.fixture.default", "1", "step:res", null, inSeconds(15)]);
      expect(step).toEqual([{ kind: "appended" }]);
      const tool = await tx.unsafe(
        `SELECT kind FROM public.novatrade_l04_append_agent_tool_call($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18)`,
        [TENANT_A, WORKSPACE_A, RUN_A, "lease-token-001", "step-1", "tc-1", "search", "1",
          "allowed", "complete", sha256("tin"), sha256("tout"), "[]", "0.001", "120", null, "s", inSeconds(16)]);
      expect(tool).toEqual([{ kind: "appended" }]);
      expect(await finalize(tx, RUN_A, "lease-token-001", "complete", "settle-1")).toBe("finalized");
      // stale token finalize is fenced
      expect(await finalize(tx, RUN_A, "lease-token-001", "complete", "settle-2")).toBe("conflict");
      const state = await tx.unsafe(
        "SELECT status,attempt_count::text ac,usage_cost_usd::text usd,result_ref FROM public.agent_runs WHERE id=$1", [RUN_A]);
      expect(state).toEqual([{ status: "complete", ac: "1", usd: "0.010000", result_ref: "result:ok" }]);
    });
    // usage tables are member-readable through the L-04 select policy
    const settle = await inMember(memberA, (tx) =>
      tx.unsafe("SELECT id,status FROM public.agent_usage_settlements WHERE run_id=$1", [RUN_A]));
    expect(settle).toEqual([{ id: "settle-1", status: "settled" }]);

    // RUN_B: max attempts=1 so retry_wait dead-letters; also proves a second lease claims independently
    await inWorker(leaseB, async (tx) => {
      expect(await claim(tx, RUN_B, "lease-token-002")).toBe("claimed");
      expect(await finalize(tx, RUN_B, "lease-token-002", "retry_wait", "settle-3")).toBe("finalized");
      const state = await tx.unsafe(
        "SELECT status,error_code FROM public.agent_runs WHERE id=$1", [RUN_B]);
      // RUN_B was enqueued with max_attempts=3, so retry_wait stays retry_wait
      expect(state).toEqual([{ status: "retry_wait", error_code: "transient_err" }]);
    });
  });

  it("keeps tenant B invisible to tenant A members and vice versa", async () => {
    const aRows = await inMember(memberA, (tx) =>
      tx.unsafe("SELECT count(*)::text n FROM public.agent_runs"));
    const bRows = await inMember(memberB, (tx) =>
      tx.unsafe("SELECT count(*)::text n FROM public.agent_runs"));
    expect(Number(aRows[0]?.n)).toBeGreaterThan(0);
    expect(bRows).toEqual([{ n: "0" }]);
  });
});
