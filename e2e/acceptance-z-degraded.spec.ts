import { expect, test } from "@playwright/test";
import { readFileSync } from "node:fs";
import { acceptanceStatePath } from "../scripts/e2e-safety.mjs";
import { randomBytes, randomUUID } from "node:crypto";
import postgres from "postgres";

import {
  ACCEPTANCE,
  acceptanceDbUrl,
  acquireWorkerLease,
  apiGet,
  apiOk,
  apiPost,
  businessHoursTimestamp,
  cancelWorkerLease,
  driveAgentRuntimeWorker,
  FOREIGN_TENANT_ID,
  invokeWorkerRoute,
  loginAs,
  RUN_NONCE,
  scoped,
  simulateCrashedWorkerClaim,
} from "./acceptance-helpers";

/**
 * L-08 degraded-path proof (0X3-263), against the real local stack:
 *
 *   cross-tenant HTTP isolation -> worker lease denial (bogus + revoked
 *   selector) -> tenant-policy kill switches (outreach drafting, copy/export)
 *   -> connector scheduler kill switch -> agent-run enqueue + stale-lease
 *   crash recovery -> member cancel + claim gating -> enqueue/record
 *   idempotent replay -> suppression lifecycle dominance -> no-send route +
 *   database assertions -> structured-log redaction scan.
 *
 * Database access uses the restricted lease-issuer role for dispatch leases
 * and DATABASE_URL only for flag flips + readback assertions — the same
 * surfaces the local operators use.
 */

test.describe.configure({ mode: "serial" });
test.setTimeout(180_000);

const T = ACCEPTANCE.tenantId;
const W = ACCEPTANCE.workspaceId;

interface HappyState {
  runNonce: string;
  accountId: string;
  contactVersionId: string;
  contactStableKey: string;
  draftStableKey: string;
  draftVersionId: string;
}

function loadHappyState(): HappyState {
  const file = acceptanceStatePath();
  try {
    return JSON.parse(readFileSync(file, "utf8")) as HappyState;
  } catch {
    throw new Error(
      "Acceptance handoff state is missing — run e2e/acceptance-happy-path.spec.ts first.",
    );
  }
}

async function withDb<T>(fn: (sql: postgres.Sql) => Promise<T>): Promise<T> {
  const sql = postgres(acceptanceDbUrl(), { max: 1, prepare: false, onnotice: () => undefined });
  try {
    return await fn(sql);
  } finally {
    await sql.end({ timeout: 1 });
  }
}

test("L-08 degraded paths: isolation, lease gating, kill switches, recovery, idempotency, lifecycle, no-send", async ({ page }) => {
  const state: Record<string, string> = {};

  await test.step("invited member signs in through the real login UI", async () => {
    await loginAs(page, "admin");
    expect(page.url()).toContain("/queue");
  });

  await test.step("cross-tenant selectors are denied without leaking data", async () => {
    const foreignReads = [
      await apiGet(page, "/api/accounts", { tenantId: FOREIGN_TENANT_ID, workspaceId: W }),
      await apiGet(page, "/api/outreach/suppressions", { tenantId: FOREIGN_TENANT_ID, workspaceId: W }),
      await apiGet(page, `/api/agent-runtime/runs/${randomUUID()}`, {
        tenantId: FOREIGN_TENANT_ID,
        workspaceId: W,
      }),
      // A workspace the session does not hold inside a tenant it does hold.
      await apiGet(page, "/api/accounts", { tenantId: T, workspaceId: randomUUID() }),
    ];
    for (const result of foreignReads) {
      expect(result.status, `expected denial, got ${result.status}: ${JSON.stringify(result.body)}`)
        .toBeGreaterThanOrEqual(400);
      expect(result.status).toBeLessThan(500);
      // Denials carry a generic error only — no records or scope hints.
      expect(JSON.stringify(result.body)).not.toMatch(/"accounts"\s*:/);
      expect(JSON.stringify(result.body)).not.toMatch(/"suppressions"\s*:/);
    }

    const foreignWrite = await apiPost(page, "/api/outreach/drafts", {
      tenantId: FOREIGN_TENANT_ID,
      workspaceId: W,
      accountId: randomUUID(),
      draftKind: "initial",
      playVersionId: `play-version:${randomUUID()}`,
      contactVersionId: `contact-version:${randomUUID()}`,
      optOutText: "Reply STOP to opt out.",
    });
    expect(foreignWrite.status).toBeGreaterThanOrEqual(400);
    expect(foreignWrite.status).toBeLessThan(500);
  });

  await test.step("worker route denies bogus and revoked dispatch leases", async () => {
    const bogus = await invokeWorkerRoute(
      page, "/api/agent-runtime/process-next", randomBytes(32).toString("base64url"));
    expect(bogus.status).toBe(401);

    const lease = await acquireWorkerLease("agent_runtime", "agent_runtime:execute", randomUUID());
    await cancelWorkerLease(lease);
    const revoked = await invokeWorkerRoute(page, "/api/agent-runtime/process-next", lease.selector);
    expect(revoked.status).toBe(401);
  });

  await test.step("tenant-policy kill switches deny outreach surfaces and restore cleanly", async () => {
    // Read surfaces are A-rated (role only); the switch must gate the C-rated
    // write/draft surfaces without touching reads.
    const baseline = await apiGet(page, "/api/outreach/suppressions", { tenantId: T, workspaceId: W });
    expect(baseline.status).toBe(200);

    const draftProbe = () => apiPost(page, "/api/outreach/drafts", scoped({
      accountId: randomUUID(),
      draftKind: "initial",
      playVersionId: `play-version:${randomUUID()}`,
      contactVersionId: `contact-version:${randomUUID()}`,
      optOutText: "Reply STOP to opt out.",
    }));
    const suppressionProbe = () => apiPost(page, "/api/outreach/suppressions", scoped({
      disposition: "do_not_contact",
      reason: `L-08 kill-switch probe ${RUN_NONCE}`,
      accountId: randomUUID(),
    }));

    await withDb(async (sql) => {
      await sql.unsafe(
        "UPDATE public.tenant_policies SET outreach_drafting_enabled=false, version=version+1 WHERE tenant_id=$1",
        [T],
      );
    });
    try {
      const draft = await draftProbe();
      expect(draft.status, "drafting-disabled tenant still created a draft").toBe(403);
      const suppressed = await suppressionProbe();
      expect(suppressed.status, "drafting-disabled tenant still wrote a suppression").toBe(403);
      // Reads stay open: the switch is surgical, not a lockout.
      const listed = await apiGet(page, "/api/outreach/suppressions", { tenantId: T, workspaceId: W });
      expect(listed.status).toBe(200);
    } finally {
      await withDb(async (sql) => {
        await sql.unsafe(
          "UPDATE public.tenant_policies SET outreach_drafting_enabled=true, version=version+1 WHERE tenant_id=$1",
          [T],
        );
      });
    }
    const restored = await suppressionProbe();
    expect(restored.status, "policy restore did not re-open drafting-gated writes").not.toBe(403);

    // The copy/export switch gates the handoff route independently.
    await withDb(async (sql) => {
      await sql.unsafe(
        "UPDATE public.tenant_policies SET copy_export_enabled=false, version=version+1 WHERE tenant_id=$1",
        [T],
      );
    });
    try {
      const handoff = await apiPost(page, "/api/outreach/handoffs", scoped({
        accountId: randomUUID(),
        stableKey: `draft:l08-${RUN_NONCE}-killswitch`,
        action: "copy",
        contactVersionId: `contact-version:${randomUUID()}`,
        idempotencyKey: `l08-${RUN_NONCE}-killswitch`,
        recipientTimezone: "UTC",
        plannedAt: businessHoursTimestamp(),
      }));
      expect(handoff.status, "export-disabled tenant still released a handoff").toBe(403);
    } finally {
      await withDb(async (sql) => {
        await sql.unsafe(
          "UPDATE public.tenant_policies SET copy_export_enabled=true, version=version+1 WHERE tenant_id=$1",
          [T],
        );
      });
    }
    const afterRestore = await apiPost(page, "/api/outreach/handoffs", scoped({
      accountId: randomUUID(),
      stableKey: `draft:l08-${RUN_NONCE}-killswitch`,
      action: "copy",
      contactVersionId: `contact-version:${randomUUID()}`,
      idempotencyKey: `l08-${RUN_NONCE}-killswitch-2`,
      recipientTimezone: "UTC",
      plannedAt: businessHoursTimestamp(),
    }));
    // Past the policy gate it fails on the missing draft, not on permission.
    expect(afterRestore.status).not.toBe(403);
    expect(afterRestore.status).toBeGreaterThanOrEqual(400);
  });

  await test.step("connector scheduler kill switch disables the worker tick", async () => {
    await withDb(async (sql) => {
      await sql.unsafe("UPDATE public.settings SET scheduler_connector_execution_enabled=0 WHERE id=1");
    });
    try {
      const lease = await acquireWorkerLease(
        "connector_execution", "connector_execution:process", randomUUID());
      try {
        const disabled = await invokeWorkerRoute(page, "/api/connectors/process-next", lease.selector);
        const body = await apiOk(disabled, "connector process-next while disabled");
        expect(body.status).toBe("disabled");
      } finally {
        await cancelWorkerLease(lease);
      }
    } finally {
      await withDb(async (sql) => {
        await sql.unsafe("UPDATE public.settings SET scheduler_connector_execution_enabled=1 WHERE id=1");
      });
    }
    const lease = await acquireWorkerLease(
      "connector_execution", "connector_execution:process", randomUUID());
    try {
      const enabled = await invokeWorkerRoute(page, "/api/connectors/process-next", lease.selector);
      const body = await apiOk(enabled, "connector process-next after restore");
      expect(body.status).not.toBe("disabled");
    } finally {
      await cancelWorkerLease(lease);
    }
  });

  await test.step("agent run enqueues through the member route", async () => {
    const enqueued = await apiPost(page, "/api/agent-runtime/runs", scoped({
      agentRole: "understanding.synthesis",
      promptKey: "nova.understanding.synthesis",
      policyKey: "nova.fixture.default",
      budgetUsd: 0.05,
      maxAttempts: 2,
      idempotencyKey: `l08-degraded-stale-${RUN_NONCE}`,
      evidence: [],
    }));
    const body = await apiOk(enqueued, "agent run enqueue");
    expect(body.ok).toBe(true);
    expect(body.code).toBe("RUN_CREATED");
    state.staleRunId = (body.value as { id: string }).id;
    expect((body.value as { status: string }).status).toBe("queued");
  });

  await test.step("a crashed worker's stale lease expires and a fresh worker recovers the run", async () => {
    // Simulate the crash: a real dispatch lease + worker-gated claim with a
    // 1s run lease, then no execute — the run is left "running".
    const crashed = await simulateCrashedWorkerClaim(state.staleRunId, 1_000);
    expect(crashed.kind).toBe("claimed");

    // While the stale lease is live a second claim is rejected -> idle.
    const contested = await driveAgentRuntimeWorker(page, state.staleRunId);
    const contestedBody = await apiOk(contested, "worker tick under live lease");
    expect(contestedBody.status).toBe("idle");

    // Once it expires the next dispatcher tick claims and completes the run.
    await new Promise((resolve) => setTimeout(resolve, 1_500));
    const recovered = await driveAgentRuntimeWorker(page, state.staleRunId);
    const recoveredBody = await apiOk(recovered, "worker tick after lease expiry");
    expect(recoveredBody.status).toBe("processed");

    const read = await apiGet(page, `/api/agent-runtime/runs/${state.staleRunId}`, {
      tenantId: T,
      workspaceId: W,
    });
    const readBody = await apiOk(read, "agent run readback");
    expect((readBody.value as { status: string }).status).toBe("complete");
    await cancelWorkerLease(crashed.lease);
  });

  await test.step("member cancel terminates a queued run and the worker gate holds", async () => {
    const enqueued = await apiPost(page, "/api/agent-runtime/runs", scoped({
      agentRole: "understanding.synthesis",
      promptKey: "nova.understanding.synthesis",
      policyKey: "nova.fixture.default",
      budgetUsd: 0.05,
      maxAttempts: 2,
      idempotencyKey: `l08-degraded-cancel-${RUN_NONCE}`,
      evidence: [],
    }));
    const body = await apiOk(enqueued, "agent run enqueue for cancel");
    const runId = (body.value as { id: string }).id;

    const cancelled = await apiPost(
      page, `/api/agent-runtime/runs/${runId}/cancel?tenantId=${T}&workspaceId=${W}`, {});
    const cancelledBody = await apiOk(cancelled, "agent run cancel");
    expect(cancelledBody.ok).toBe(true);
    expect((cancelledBody.value as { status: string }).status).toBe("canceled");

    const worker = await driveAgentRuntimeWorker(page, runId);
    const workerBody = await apiOk(worker, "worker tick on cancelled run");
    expect(workerBody.status).toBe("idle");
  });

  await test.step("enqueue and suppression appends replay idempotently", async () => {
    const replayed = await apiPost(page, "/api/agent-runtime/runs", scoped({
      agentRole: "understanding.synthesis",
      promptKey: "nova.understanding.synthesis",
      policyKey: "nova.fixture.default",
      budgetUsd: 0.05,
      maxAttempts: 2,
      idempotencyKey: `l08-degraded-stale-${RUN_NONCE}`,
      evidence: [],
    }));
    const replayBody = await apiOk(replayed, "agent run enqueue replay");
    expect(["RUN_REPLAYED", "RUN_DEDUPLICATED"]).toContain(replayBody.code);
    expect((replayBody.value as { id: string }).id).toBe(state.staleRunId);

    // Same key + divergent evidence context is a hard conflict, not a silent
    // replay — the input hash commits to the serialized context.
    const conflict = await apiPost(page, "/api/agent-runtime/runs", scoped({
      agentRole: "understanding.synthesis",
      promptKey: "nova.understanding.synthesis",
      policyKey: "nova.fixture.default",
      budgetUsd: 0.05,
      maxAttempts: 2,
      idempotencyKey: `l08-degraded-stale-${RUN_NONCE}`,
      evidence: [{
        tenantId: T,
        workspaceId: W,
        sourceId: randomUUID(),
        evidenceId: randomUUID(),
        locator: "page/1/section/conflict",
        rank: 1,
        text: "A divergent evidence payload for the idempotency conflict probe.",
      }],
    }));
    expect(conflict.status).toBeGreaterThanOrEqual(400);
    expect(conflict.status).toBeLessThan(500);
    expect((conflict.body as { code?: string }).code).toBe("REJECTED_IDEMPOTENCY_CONFLICT");

    // Suppression records are content-addressed: the identical event (same
    // scope, disposition, timestamps) must replay to the same recordId.
    const suppressionInput = scoped({
      disposition: "do_not_contact",
      reason: `L-08 lifecycle suppression ${RUN_NONCE}`,
      accountId: loadHappyState().accountId,
      contactStableKey: loadHappyState().contactStableKey,
      occurredAt: new Date().toISOString(),
      recordedAt: new Date().toISOString(),
    });
    const first = await apiPost(page, "/api/outreach/suppressions", suppressionInput);
    const firstBody = await apiOk(first, "suppression record");
    expect(firstBody.persisted).toBe("created");
    const replay = await apiPost(page, "/api/outreach/suppressions", suppressionInput);
    const replaySuppression = await apiOk(replay, "suppression replay");
    expect(replaySuppression.persisted).toBe("replayed");
    expect((replaySuppression.record as { recordId: string }).recordId)
      .toBe((firstBody.record as { recordId: string }).recordId);
    state.suppressionRecordId = (firstBody.record as { recordId: string }).recordId;
  });

  await test.step("a recorded suppression dominates handoff eligibility (lifecycle cleanup)", async () => {
    const happy = loadHappyState();
    const handoff = await apiPost(page, "/api/outreach/handoffs", scoped({
      accountId: happy.accountId,
      stableKey: happy.draftStableKey,
      action: "copy",
      contactVersionId: happy.contactVersionId,
      idempotencyKey: `l08-${RUN_NONCE}-suppressed-handoff`,
      recipientTimezone: "UTC",
      plannedAt: businessHoursTimestamp(),
    }));
    const body = await apiOk(handoff, "suppressed handoff");
    expect(body.status).toBe("blocked");
    expect(body.blockCode).toBe("OUTREACH_SUPPRESSION_BLOCKED");

    const listed = await apiGet(page, "/api/outreach/suppressions", {
      tenantId: T,
      workspaceId: W,
      contactStableKey: happy.contactStableKey,
    });
    const listedBody = await apiOk(listed, "suppression list");
    expect(JSON.stringify(listedBody)).toContain(state.suppressionRecordId);
  });

  await test.step("no send path is reachable: route rejects send, CSV export is closed, the database refuses autonomous send", async () => {
    const send = await apiPost(page, "/api/outreach/handoffs", scoped({
      accountId: loadHappyState().accountId,
      stableKey: loadHappyState().draftStableKey,
      action: "send",
      contactVersionId: loadHappyState().contactVersionId,
      idempotencyKey: `l08-${RUN_NONCE}-send-probe`,
      recipientTimezone: "UTC",
      plannedAt: businessHoursTimestamp(),
    }));
    expect(send.status).toBe(400);

    const csv = await apiGet(page, "/api/export/csv", { tenantId: T, workspaceId: W });
    expect(csv.status).toBe(403);

    await expect(
      withDb(async (sql) => {
        await sql.unsafe(
          "UPDATE public.tenant_policies SET autonomous_send_enabled=true, version=version+1 WHERE tenant_id=$1",
          [T],
        );
      }),
    ).rejects.toThrow(/autonomous_send_enabled/);
  });

  await test.step("worker records and audit metadata carry no secrets", async () => {
    const cronSecret = process.env.WORKER_CRON_SECRET?.trim() ?? "";
    const secrets = [
      cronSecret,
      "acceptance-admin-local",
      "acceptance-approver-local",
      process.env.NOSITE_ENCRYPTION_SECRET?.trim() ?? "",
      process.env.DATABASE_URL?.trim() ?? "",
    ].filter((value) => value.length > 0);
    expect(secrets.length).toBeGreaterThan(0);

    const scanned = await withDb(async (sql) => {
      const runs = await sql.unsafe(
        `SELECT result_json::text AS j, coalesce(error,'') AS e FROM public.worker_runs
          WHERE worker_name IN ('agent_runtime','connector_execution')`,
      );
      const audit = await sql.unsafe(
        `SELECT metadata::text AS m FROM public.audit_logs WHERE tenant_id=$1`,
        [T],
      );
      const steps = await sql.unsafe(
        `SELECT result_ref AS o, coalesce(error_code,'') AS ec FROM public.agent_run_steps WHERE tenant_id=$1`,
        [T],
      );
      return JSON.stringify({ runs, audit, steps });
    });
    for (const secret of secrets) {
      expect(scanned, "a secret value leaked into worker/audit records").not.toContain(secret);
    }
    expect(scanned).not.toMatch(/bearer\s+[a-z0-9._-]+/i);
    expect(scanned).not.toMatch(/private key/i);
  });
});
