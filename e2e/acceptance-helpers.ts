import { expect, type APIRequestContext, type Page } from "@playwright/test";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import postgres from "postgres";

import { BASE_URL } from "./auth-fixtures";
import ACCEPTANCE_IDS from "./acceptance-ids.json";

/**
 * L-08 acceptance helpers. Drive the real API surfaces over the browser
 * context's authenticated cookies after a UI login. The acceptance tenant is
 * provisioned by scripts/seed-acceptance-tenant.mjs; these constants mirror
 * the deterministic ids it writes so no database read is needed.
 */
export const ACCEPTANCE = Object.freeze({
  tenantId: ACCEPTANCE_IDS.tenantId,
  workspaceId: ACCEPTANCE_IDS.workspaceId,
  admin: Object.freeze({
    email: (process.env.ACCEPTANCE_ADMIN_EMAIL ?? "acceptance-admin@nova.local").trim().toLowerCase(),
    password: process.env.ACCEPTANCE_ADMIN_PASSWORD ?? "acceptance-admin-local",
    identityId: ACCEPTANCE_IDS.adminIdentityId,
    role: "owner",
  }),
  approver: Object.freeze({
    email: (process.env.ACCEPTANCE_APPROVER_EMAIL ?? "acceptance-approver@nova.local").trim().toLowerCase(),
    password: process.env.ACCEPTANCE_APPROVER_PASSWORD ?? "acceptance-approver-local",
    identityId: ACCEPTANCE_IDS.approverIdentityId,
    role: "admin",
  }),
});

/** The pre-existing local-demo tenant — the "foreign" tenant for isolation attempts. */
export const FOREIGN_TENANT_ID = "10000000-0000-4000-8000-000000000001";

/** Per-run suffix so each acceptance run creates fresh chains and reruns never collide. */
export const RUN_NONCE =
  (process.env.E2E_ACCEPTANCE_RUN_NONCE ?? `${Date.now().toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}`)
    .replace(/[^a-z0-9]/gi, "")
    .toLowerCase();

export function sha256Hex(value: unknown): string {
  return `sha256:${createHash("sha256").update(JSON.stringify(value), "utf8").digest("hex")}`;
}

export function scope(): { tenantId: string; workspaceId: string } {
  return { tenantId: ACCEPTANCE.tenantId, workspaceId: ACCEPTANCE.workspaceId };
}

export async function loginAs(page: Page, who: "admin" | "approver"): Promise<void> {
  const identity = ACCEPTANCE[who];
  await page.goto(`${BASE_URL}/login`, { waitUntil: "networkidle", timeout: 30000 });
  await page.getByLabel("Email").fill(identity.email);
  await page.getByLabel("Password").fill(identity.password);
  await page.getByRole("button", { name: "Sign in" }).click();
  await page.waitForURL(/\/queue/, { timeout: 15000 });
}

export interface ApiResult {
  readonly status: number;
  readonly body: unknown;
}

async function parseBody(response: Awaited<ReturnType<APIRequestContext["post"]>>): Promise<unknown> {
  const text = await response.text();
  try {
    return JSON.parse(text);
  } catch {
    return { raw: text };
  }
}

export async function apiPost(page: Page, path: string, body: Record<string, unknown>): Promise<ApiResult> {
  const response = await page.request.post(`${BASE_URL}${path}`, { data: body });
  return { status: response.status(), body: await parseBody(response) };
}

export async function apiGet(page: Page, path: string, params: Record<string, string> = {}): Promise<ApiResult> {
  const query = new URLSearchParams(params).toString();
  const response = await page.request.get(`${BASE_URL}${path}${query ? `?${query}` : ""}`);
  return { status: response.status(), body: await parseBody(response) };
}

/** Asserts a 2xx and returns the parsed body. The error text is surfaced on failure. */
export async function apiOk(result: ApiResult, step: string): Promise<Record<string, unknown>> {
  expect(
    result.status,
    `${step} failed with HTTP ${result.status}: ${JSON.stringify(result.body)}`,
  ).toBeGreaterThanOrEqual(200);
  expect(result.status, `${step} failed with HTTP ${result.status}: ${JSON.stringify(result.body)}`)
    .toBeLessThan(300);
  return result.body as Record<string, unknown>;
}

/** Fields every service sees: the tenant/workspace selector travels in the body. */
export function scoped(body: Record<string, unknown>): Record<string, unknown> {
  return { ...body, ...scope() };
}

export function humanActor(identityId: string): { kind: "human"; actorId: string } {
  return { kind: "human", actorId: identityId };
}

/** A business-hours timestamp so the quiet-hours gate (21:00–08:00 local) never blocks. */
export function businessHoursTimestamp(offsetDays = 0): string {
  const date = new Date(Date.now() + offsetDays * 86_400_000);
  date.setUTCHours(10, 0, 0, 0);
  return date.toISOString().replace(/\.\d{3}Z$/, ".000Z");
}

const WORKER_LEASE_ACQUIRE_SQL =
  "SELECT * FROM public.novatrade_acquire_tenant_worker_lease($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)";
const WORKER_LEASE_CANCEL_SQL =
  "SELECT kind FROM public.novatrade_cancel_tenant_worker_lease($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)";

export function acceptanceDbUrl(): string {
  const url = process.env.DATABASE_URL?.trim();
  if (!url) {
    throw new Error("DATABASE_URL is required for the acceptance suite.");
  }
  return url;
}

function issuerDbUrl(): string {
  const url = process.env.TENANT_WORKER_LEASE_ISSUER_DATABASE_URL?.trim();
  if (!url) {
    throw new Error("TENANT_WORKER_LEASE_ISSUER_DATABASE_URL is required to drive the agent runtime worker.");
  }
  return url;
}

function workerCronSecret(): string {
  const cronSecret = process.env.WORKER_CRON_SECRET?.trim();
  if (!cronSecret) {
    throw new Error("WORKER_CRON_SECRET is required to drive the agent runtime worker.");
  }
  return cronSecret;
}

/** A minted tenant worker dispatch lease, ready to present to a worker route. */
export interface WorkerLease {
  readonly selector: string;
  readonly selectorHash: string;
  readonly tenantId: string;
  readonly workspaceId: string;
  readonly jobId: string;
  readonly runId: string;
  readonly leaseId: string;
  readonly leaseGeneration: string;
  readonly workerName: string;
  readonly action: string;
  readonly notBefore: string;
  readonly expiresAt: string;
  readonly correlationId: string;
}

/** Mints a dispatch lease through the restricted issuer role, like the local dispatcher. */
export async function acquireWorkerLease(
  workerName: string,
  action: string,
  runId: string,
): Promise<WorkerLease> {
  const selector = randomBytes(32).toString("base64url");
  const selectorHash = createHash("sha256").update(selector, "utf8").digest("hex");
  const now = Date.now();
  const params = [
    selectorHash,
    ACCEPTANCE.tenantId,
    ACCEPTANCE.workspaceId,
    randomUUID(),
    runId,
    randomUUID(),
    "1",
    workerName,
    action,
    new Date(now - 5_000).toISOString(),
    new Date(now + 60_000).toISOString(),
    `l08-acceptance:${RUN_NONCE}`,
  ];
  const sql = postgres(issuerDbUrl(), { max: 1, prepare: false, onnotice: () => undefined });
  try {
    const [row] = await sql.unsafe(WORKER_LEASE_ACQUIRE_SQL, params);
    if (!row || row.kind !== "created") {
      throw new Error(`The ${workerName} worker lease was not created: ${JSON.stringify(row ?? null)}`);
    }
    return {
      selector,
      selectorHash,
      tenantId: String(row.tenant_id),
      workspaceId: String(row.workspace_id),
      jobId: String(row.job_id),
      runId: String(row.run_id),
      leaseId: String(row.lease_id),
      leaseGeneration: String(row.lease_generation),
      workerName,
      action,
      notBefore: new Date(row.not_before).toISOString(),
      expiresAt: new Date(row.expires_at).toISOString(),
      correlationId: String(row.correlation_id),
    };
  } finally {
    await sql.end({ timeout: 1 });
  }
}

/** Revokes a minted dispatch lease through the restricted issuer role. */
export async function cancelWorkerLease(lease: WorkerLease): Promise<void> {
  const sql = postgres(issuerDbUrl(), { max: 1, prepare: false, onnotice: () => undefined });
  try {
    await sql.unsafe(WORKER_LEASE_CANCEL_SQL, [
      lease.selectorHash,
      lease.tenantId,
      lease.workspaceId,
      lease.jobId,
      lease.runId,
      lease.leaseId,
      lease.leaseGeneration,
      lease.workerName,
      lease.action,
      lease.notBefore,
      lease.expiresAt,
      lease.correlationId,
    ]);
  } finally {
    await sql.end({ timeout: 1 });
  }
}

/** Invokes a tenant worker route with the lease selector + cron secret. */
export async function invokeWorkerRoute(
  page: Page,
  path: string,
  selector: string,
): Promise<ApiResult> {
  const response = await page.request.post(`${BASE_URL}${path}`, {
    headers: {
      "x-internal-worker-selector": selector,
      authorization: `Bearer ${workerCronSecret()}`,
    },
    data: {},
  });
  return { status: response.status(), body: await parseBody(response) };
}

/**
 * Drives the agent_runtime worker the way the local dispatcher does: mint a
 * dispatch lease bound to the agent run through the restricted issuer role,
 * invoke the worker route with the selector + cron secret, then cancel the
 * lease. The run stays tenant/workspace scoped through the lease record.
 */
export async function driveAgentRuntimeWorker(page: Page, runId: string): Promise<ApiResult> {
  const lease = await acquireWorkerLease("agent_runtime", "agent_runtime:execute", runId);
  try {
    return await invokeWorkerRoute(page, "/api/agent-runtime/process-next", lease.selector);
  } finally {
    await cancelWorkerLease(lease);
  }
}

/**
 * Simulates a worker that claimed an agent run and crashed before executing:
 * mints a real dispatch lease, installs the exact worker GUCs the route's
 * tenant context would, and calls the claim RPC with a short lease so the run
 * is left "running" and claimable again once it expires.
 */
export async function simulateCrashedWorkerClaim(
  runId: string,
  leaseMs = 1_000,
): Promise<{ kind: string; lease: WorkerLease }> {
  const lease = await acquireWorkerLease("agent_runtime", "agent_runtime:execute", runId);
  const sql = postgres(acceptanceDbUrl(), { max: 1, prepare: false, onnotice: () => undefined });
  try {
    const gucs: Record<string, string> = {
      "app.tenant_id": lease.tenantId,
      "app.workspace_id": lease.workspaceId,
      "app.job_id": lease.jobId,
      "app.run_id": lease.runId,
      "app.lease_id": lease.leaseId,
      "app.lease_generation": lease.leaseGeneration,
      "app.worker_name": lease.workerName,
      "app.worker_action": lease.action,
      "app.worker_principal_kind": "cron",
      "app.correlation_id": lease.correlationId,
      "app.actor_id": "",
      "app.membership_id": "",
      "app.role": "",
      "app.role_binding_id": "",
      "app.support_grant_id": "",
    };
    for (const [key, value] of Object.entries(gucs)) {
      await sql.unsafe("SELECT pg_catalog.set_config($1, $2, false)", [key, value]);
    }
    const [row] = await sql.unsafe(
      "SELECT kind FROM public.novatrade_l04_claim_agent_run($1,$2,$3,$4,$5,$6,$7)",
      [
        lease.tenantId,
        lease.workspaceId,
        runId,
        `crashed-${randomBytes(16).toString("hex")}`,
        `crashed-worker-${RUN_NONCE}`,
        new Date().toISOString(),
        String(leaseMs),
      ],
    );
    return { kind: String(row?.kind ?? "none"), lease };
  } finally {
    await sql.end({ timeout: 1 });
  }
}
