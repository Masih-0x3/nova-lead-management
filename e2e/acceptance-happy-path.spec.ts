import { expect, test, type Page } from "@playwright/test";

import { BASE_URL } from "./auth-fixtures";
import { acceptanceStatePath } from "../scripts/e2e-safety.mjs";
import {
  ACCEPTANCE,
  apiGet,
  apiOk,
  apiPost,
  businessHoursTimestamp,
  driveAgentRuntimeWorker,
  humanActor,
  loginAs,
  RUN_NONCE,
  scoped,
  sha256Hex,
} from "./acceptance-helpers";

/**
 * L-08 automated local happy path (0X3-262): an invited member of the isolated
 * `acceptance-proof` tenant drives the full integrated flow through real UI
 * login + real API surfaces on the local Supabase-compatible stack:
 *
 *   login -> members surface -> evidence/understanding -> approve ->
 *   ICP create+approve -> play create+approve -> simulation + eligibility ->
 *   activation -> bounded discovery plan/run/batch -> account resolution ->
 *   contact register+approve -> qualification evaluate+review ->
 *   cited outreach draft -> review -> approve (separation of duty) ->
 *   copy/export handoff receipts -> outcome -> no-send assertion.
 *
 * Every step is a real HTTP call on the running app; nothing is mocked.
 * RUN_NONCE keeps stable keys unique per run so the suite is repeatable.
 */

test.describe.configure({ mode: "serial" });
test.setTimeout(240_000);

const T = ACCEPTANCE.tenantId;
const W = ACCEPTANCE.workspaceId;
const ADMIN = ACCEPTANCE.admin.identityId;
const APPROVER = ACCEPTANCE.approver.identityId;

// Discovery run state requires strictly-increasing timestamps: every event `at`,
// batch `appendedAt`, and observation `observedAt` must be > the run's current
// updatedAt. A monotonic counter avoids same-millisecond collisions.
let clockOffset = 0;
function nextTs(): string {
  clockOffset += 1;
  return new Date(Date.now() + clockOffset * 1_000).toISOString();
}

function evidenceItem(index: number, statement: string) {
  return {
    evidenceId: `evidence:l08-${RUN_NONCE}-${index}`,
    tenantId: T,
    workspaceId: W,
    sourceVersionRef: `document-version:l08-${RUN_NONCE}`,
    locator: `page=${index}#section=acceptance-evidence`,
    contentHash: sha256Hex({ statement, index, run: RUN_NONCE }),
    grade: "direct_observation",
    freshness: "current",
  };
}

function claimItem(index: number, overrides: Record<string, unknown>) {
  return {
    claimId: `claim:l08-${RUN_NONCE}-${index}`,
    claimVersion: 1,
    tenantId: T,
    workspaceId: W,
    origin: "observed",
    status: "supported",
    confidenceBasisPoints: 9_000,
    material: true,
    evidenceIds: [`evidence:l08-${RUN_NONCE}-${index}`],
    uncertaintyReason: null,
    ...overrides,
  };
}

async function reviewStep(
  page: Page,
  path: string,
  versionId: string,
  reviewHash: string,
  to: "in_review" | "approved",
  actorId: string,
) {
  const result = await apiPost(page, path, scoped({
    versionId,
    expectedReviewHash: reviewHash,
    to,
    reason: `L-08 acceptance ${to} transition`,
    actor: humanActor(actorId),
  }));
  const body = await apiOk(result, `${path} review->${to}`);
  expect(body.ok).toBe(true);
  const value = body.value as {
    stored?: { review?: { reviewHash?: string; status?: string } };
    review?: { reviewHash?: string; status?: string };
  };
  const next = value.stored?.review?.reviewHash ?? value.review?.reviewHash;
  expect(next, `${path} review->${to} returned no review hash`).toMatch(/^sha256:[a-f0-9]{64}$/);
  return next as string;
}

test("L-08 happy path: invite -> evidence -> ICP/play -> discovery -> qualify -> draft -> handoff -> outcome", async ({ page, browser }) => {
  const state: Record<string, string> = {};

  await test.step("invited member signs in through the real login UI", async () => {
    await loginAs(page, "admin");
    expect(page.url()).toContain("/queue");
  });

  await test.step("isolated tenant exposes both invited members on the real members surface", async () => {
    await page.goto(`${BASE_URL}/users`, { waitUntil: "networkidle" });
    await expect(page.getByRole("heading", { name: "Tenant-wide members", exact: true })).toBeVisible({ timeout: 15000 });
    // The members surface renders membership ids + roles; the two seeded
    // invited identities are the owner (admin) and the admin (approver).
    const ownerRow = page.getByRole("article", { name: "a3000000-0000-4000-8000-000000000001" });
    const approverRow = page.getByRole("article", { name: "a3000000-0000-4000-8000-000000000002" });
    await expect(ownerRow).toBeVisible();
    await expect(approverRow).toBeVisible();
    await expect(ownerRow.getByText("Owner", { exact: true })).toBeVisible();
    await expect(approverRow.getByText("Administrator", { exact: true })).toBeVisible();
  });

  await test.step("member is scoped to the acceptance tenant only", async () => {
    const own = await apiGet(page, "/api/accounts", { tenantId: T, workspaceId: W });
    expect(own.status, `own-tenant read failed: ${JSON.stringify(own.body)}`).toBe(200);
  });

  await test.step("approved evidence lands in an understanding version", async () => {
    const evidence = [
      evidenceItem(1, "Catalog lists epoxy resin systems for industrial formulators."),
      evidenceItem(2, "Formulators announce formulation changes in trade press."),
      evidenceItem(3, "Procurement contacts appear on customer-approved pages."),
    ];
    const claims = [
      claimItem(1, {
        domain: "products",
        claimClass: "product_technical_specification",
        subject: "Industrial product range",
        statement: "The catalog lists epoxy resin systems and metalworking-fluid components.",
      }),
      claimItem(2, {
        domain: "triggers",
        claimClass: "customer_provided_strategic_fact",
        subject: "Formulation-change trigger",
        statement: "A formulation change creates an active replacement need for formulators.",
      }),
      claimItem(3, {
        domain: "buying_process",
        claimClass: "contact_role",
        subject: "Procurement contact",
        statement: "Procurement buyers are the reachable contact role for these accounts.",
      }),
    ];
    const created = await apiPost(page, "/api/understanding/versions", scoped({
      proposalRef: `understanding:l08-${RUN_NONCE}`,
      producer: {
        runRef: `agent-run:l08-${RUN_NONCE}`,
        runInputHash: sha256Hex({ run: RUN_NONCE, kind: "understanding" }),
        agentVersion: "understanding-synthesizer:v1",
        modelRef: "fixture:local-acceptance",
        promptRef: "business-understanding@1",
        promptHash: sha256Hex("business-understanding@1"),
        policyRef: "evidence-policy:v1",
        policyHash: sha256Hex("evidence-policy:v1"),
      },
      evidence,
      claims,
    }));
    const body = await apiOk(created, "understanding create");
    expect(body.ok).toBe(true);
    const value = body.value as {
      stored: { versionId: string; review: { reviewHash: string; status: string } };
    };
    state.understandingVersionId = value.stored.versionId;
    state.understandingReviewHash = value.stored.review.reviewHash;
    expect(value.stored.review.status).toBe("draft");

    // draft -> in_review (admin submits) -> approved (approver approves).
    const inReview = await reviewStep(
      page, `/api/understanding/versions/${state.understandingVersionId}/review`,
      state.understandingVersionId, state.understandingReviewHash, "in_review", ADMIN);
    const approved = await reviewStep(
      page, `/api/understanding/versions/${state.understandingVersionId}/review`,
      state.understandingVersionId, inReview, "approved", APPROVER);
    state.understandingReviewHash = approved;
  });

  const approverPage = await (await browser.newContext()).newPage();
  await test.step("approver signs in through the real login UI", async () => {
    await loginAs(approverPage, "approver");
    expect(approverPage.url()).toContain("/queue");
  });

  await test.step("ICP created from approved understanding and approved", async () => {
    const rationaleRefs = [
      { claimId: `claim:l08-${RUN_NONCE}-2`, evidenceId: `evidence:l08-${RUN_NONCE}-2` },
    ];
    const created = await apiPost(page, "/api/strategy/icp/versions", scoped({
      stableKey: `icp:l08-${RUN_NONCE}`,
      understandingVersionId: state.understandingVersionId,
      title: "Industrial formulators in a formulation-change cycle",
      segment: "Industrial formulators evaluating formulation changes",
      useCase: "Prioritize evidence-backed reformulation opportunities",
      positiveCriteria: [{
        criterionId: `criterion:l08-${RUN_NONCE}-trigger`,
        ruleKey: "buying-trigger:formulation-change",
        domain: "buying_trigger",
        rule: "A formulation change creates an active need.",
        rationale: "The approved understanding identifies supported industrial buyers.",
        confidenceBasisPoints: 8_500,
        rationaleRefs,
      }],
      exclusions: [{
        criterionId: `exclusion:l08-${RUN_NONCE}-consumer`,
        ruleKey: "disqualifier:consumer-only",
        domain: "disqualifier",
        rule: "Exclude consumer-only organizations.",
        rationale: "The cited evidence supports an industrial buyer profile.",
        confidenceBasisPoints: 8_000,
        rationaleRefs,
      }],
      uncertainties: [],
    }));
    const body = await apiOk(created, "icp create");
    expect(body.ok).toBe(true);
    const value = body.value as {
      stored: { versionId: string; review: { reviewHash: string; status: string } };
    };
    state.icpVersionId = value.stored.versionId;
    expect(value.stored.review.status).toBe("draft");
    const inReview = await reviewStep(
      page, `/api/strategy/icp/versions/${state.icpVersionId}/review`,
      state.icpVersionId, value.stored.review.reviewHash, "in_review", ADMIN);
    await reviewStep(
      page, `/api/strategy/icp/versions/${state.icpVersionId}/review`,
      state.icpVersionId, inReview, "approved", APPROVER);
  });

  await test.step("play created from approved ICP and approved", async () => {
    const rationaleRefs = [
      { claimId: `claim:l08-${RUN_NONCE}-2`, evidenceId: `evidence:l08-${RUN_NONCE}-2` },
    ];
    const created = await apiPost(page, "/api/strategy/plays/versions", scoped({
      stableKey: `lead-play:l08-${RUN_NONCE}`,
      icpVersionId: state.icpVersionId,
      title: "Formulation-change discovery",
      objective: "Find evidence-backed formulation-change opportunities for human review.",
      motion: "Discover and qualify accounts with current formulation-change signals.",
      searchHypotheses: [{
        hypothesisId: `hypothesis:l08-${RUN_NONCE}`,
        queryFamily: "industrial-formulators-with-active-product-change",
        statement: "Organizations announcing formulation changes may have an active replacement need.",
        rationale: "The approved ICP identifies formulation change as a buying trigger.",
        rationaleRefs,
      }],
      sourceAllowlist: ["customer-approved-url"],
      bounds: { maxAccounts: 10, maxProviderRequests: 10, maxSpendCents: 500 },
      outreachMode: "draft_only",
      rationaleRefs,
      uncertainties: [{
        uncertaintyId: `uncertainty:l08-${RUN_NONCE}-timing`,
        statement: "The timing of each formulation change is not yet known.",
        impact: "Keep accounts in human review until current timing evidence is available.",
        relatedClaimIds: [`claim:l08-${RUN_NONCE}-2`],
      }],
    }));
    const body = await apiOk(created, "play create");
    expect(body.ok).toBe(true);
    const value = body.value as {
      stored: {
        versionId: string;
        stableKey: string;
        contentHash: string;
        review: { reviewHash: string; status: string };
      };
    };
    state.playVersionId = value.stored.versionId;
    state.playStableKey = value.stored.stableKey;
    state.playContentHash = value.stored.contentHash;
    expect(value.stored.review.status).toBe("draft");
    const inReview = await reviewStep(
      page, `/api/strategy/plays/versions/${state.playVersionId}/review`,
      state.playVersionId, value.stored.review.reviewHash, "in_review", ADMIN);
    await reviewStep(
      page, `/api/strategy/plays/versions/${state.playVersionId}/review`,
      state.playVersionId, inReview, "approved", APPROVER);
  });

  await test.step("simulation runs, eligibility approved, play activated", async () => {
    const simulated = await apiPost(
      page, `/api/strategy/plays/versions/${state.playVersionId}/simulations`, scoped({
        playVersionId: state.playVersionId,
        estimates: { providerRequests: 2, spendCents: 100 },
        accounts: [{
          accountId: `account:l08-${RUN_NONCE}-included`,
          observations: [{
            observationId: `observation:l08-${RUN_NONCE}-sim-1`,
            sourceKey: "customer-approved-url",
            hypothesisId: `hypothesis:l08-${RUN_NONCE}`,
            assessment: "supported",
            rationaleRefs: [{
              claimId: `claim:l08-${RUN_NONCE}-2`,
              evidenceId: `evidence:l08-${RUN_NONCE}-2`,
            }],
            uncertaintyIds: [],
          }],
        }],
      }));
    const simBody = await apiOk(simulated, "play simulation");
    expect(simBody.ok).toBe(true);
    const simulation = (simBody.value as { simulationId: string }).simulationId;

    const eligibility = await apiPost(
      page,
      `/api/strategy/plays/versions/${state.playVersionId}/simulations/${simulation}/eligibility`,
      scoped({
        decision: "eligible",
        reason: "Simulation bounds are within the approved play envelope.",
        actor: humanActor(APPROVER),
      }));
    const eligBody = await apiOk(eligibility, "simulation eligibility");
    expect(eligBody.ok).toBe(true);

    const activated = await apiPost(page, "/api/strategy/plays/activation", scoped({
      stableKey: state.playStableKey,
      playVersionId: state.playVersionId,
      action: "activate",
      reason: "L-08 acceptance activation",
      actor: humanActor(APPROVER),
    }));
    const actBody = await apiOk(activated, "play activation");
    expect(actBody.ok).toBe(true);
  });

  await test.step("bounded discovery plan runs one observation batch to completion", async () => {
    const plan = await apiPost(page, "/api/discovery/plans", scoped({
      playVersionId: state.playVersionId,
      sourceKeys: ["customer-approved-url"],
      limits: { maxAccounts: 10, maxProviderRequests: 10, maxSpendCents: 500 },
    }));
    const planBody = await apiOk(plan, "discovery plan");
    const planRow = planBody.plan as { planId: string; tasks: Array<{ taskId: string; sourceKey: string }> };
    state.planId = planRow.planId;
    expect(planRow.tasks.length).toBeGreaterThan(0);

    const run = await apiPost(page, "/api/discovery/runs", scoped({ planId: state.planId }));
    const runBody = await apiOk(run, "discovery run create");
    const runRow = runBody.run as { runId: string; runHash: string };
    state.runId = runRow.runId;
    let runHash = runRow.runHash;

    const started = await apiPost(page, `/api/discovery/runs/${state.runId}`, scoped({
      action: "start",
      expectedRunHash: runHash,
      at: nextTs(),
      reason: "L-08 acceptance run start",
    }));
    runHash = ((await apiOk(started, "discovery run start")).run as { runHash: string }).runHash;

    for (const task of planRow.tasks) {
      const observedAt = nextTs();
      const appended = await apiPost(page, `/api/discovery/runs/${state.runId}`, scoped({
        mode: "append_observations",
        expectedRunHash: runHash,
        batch: {
          batchVersion: 1,
          batchId: `batch:l08-${RUN_NONCE}-${task.taskId.slice(-8)}`,
          taskId: task.taskId,
          cursor: null,
          // A completing batch must close the cursor: complete requires
          // nextCursor === null (non-complete batches must advance it).
          nextCursor: null,
          complete: true,
          appendedAt: nextTs(),
          providerRequests: 1,
          spendCents: 25,
          observations: [{
            observationVersion: 1,
            observationId: `observation:l08-${RUN_NONCE}-run-1`,
            accountRef: `account-ref:l08-${RUN_NONCE}-acme`,
            sourceKey: task.sourceKey,
            observedAt,
            fields: {
              displayName: "Acme Formulators",
              namespace: "customer-approved-url",
              externalId: `acme-${RUN_NONCE}`,
            },
          }],
        },
      }));
      const appendBody = await apiOk(appended, "discovery batch append");
      runHash = (appendBody.run as { runHash: string }).runHash;
    }

    const completed = await apiPost(page, `/api/discovery/runs/${state.runId}`, scoped({
      action: "complete",
      expectedRunHash: runHash,
      at: nextTs(),
      reason: "L-08 acceptance run complete",
    }));
    const doneBody = await apiOk(completed, "discovery run complete");
    expect((doneBody.run as { status: string }).status).toBe("completed");
    state.runHash = (doneBody.run as { runHash: string }).runHash;
  });

  await test.step("account resolution materializes a canonical account", async () => {
    const resolved = await apiPost(page, "/api/accounts/resolutions", scoped({
      observations: [{
        observationId: `acct-obs:l08-${RUN_NONCE}-1`,
        tenantId: T,
        workspaceId: W,
        sourceKey: "customer-approved-url",
        namespace: "customer-approved-url",
        externalId: `acme-${RUN_NONCE}`,
        observedAt: new Date().toISOString(),
        payloadHash: sha256Hex({ run: RUN_NONCE, payload: "acme" }),
        provenanceHash: sha256Hex({ run: RUN_NONCE, provenance: "acme" }),
      }],
      bindings: {
        [`acct-obs:l08-${RUN_NONCE}-1`]: {
          discoveryRunId: state.runId,
          sourceObservationId: `observation:l08-${RUN_NONCE}-run-1`,
        },
      },
    }));
    const body = await apiOk(resolved, "account resolution");
    expect(body.applied).toBe("canonical_candidate");
    state.accountId = body.accountId as string;
  });

  await test.step("contact registered and approved", async () => {
    // receiptHash must equal sha256 of the canonical receipt payload (the exact
    // field set/order parseReceipt rebuilds); roleHypothesis binds to it, and
    // freshness.observedAt must equal the receipt's observedAt.
    const observedAt = new Date().toISOString();
    const receiptCore = {
      receiptVersion: 1,
      tenantId: T,
      workspaceId: W,
      accountId: state.accountId,
      sourceId: `source:l08-${RUN_NONCE}`,
      sourceVersionId: `source-version:l08-${RUN_NONCE}`,
      sourceContentHash: sha256Hex({ run: RUN_NONCE, content: "contact-source" }),
      connectorKey: "customer-approved-url",
      locator: `row=l08-${RUN_NONCE}`,
      observedAt,
    };
    const receiptHash = sha256Hex(receiptCore);
    const created = await apiPost(page, "/api/contacts", scoped({
      accountId: state.accountId,
      stableKey: `contact:l08-${RUN_NONCE}`,
      identity: {
        kind: "person_candidate",
        displayName: "Acceptance Buyer",
        contactPointClass: "named_business_email",
        contactPoint: "buyer@acme-formulators.test",
        verification: "source_observed",
      },
      sourceReceipt: { ...receiptCore, receiptHash },
      roleHypothesis: {
        status: "hypothesis",
        roleKey: "procurement",
        statement: "The source labels this contact as procurement.",
        confidenceBasisPoints: 7_500,
        evidenceReceiptHash: receiptHash,
      },
      freshness: {
        state: "KNOWN",
        observedAt,
        expiresAt: new Date(Date.now() + 90 * 86_400_000).toISOString(),
      },
      permittedUse: {
        policyVersion: "d012_v2026_07_27_02",
        purpose: "qualification",
        sourcePolicy: "KNOWN",
        jurisdiction: "KNOWN",
        attestation: "KNOWN",
        identity: "KNOWN",
        channelAuthorization: "KNOWN",
        legalBasis: "KNOWN",
        consentSignal: "KNOWN",
      },
      suppressionDisposition: "clear",
    }));
    const body = await apiOk(created, "contact register");
    const record = body.record as { versionId: string; contentHash: string; review: { reviewHash: string } };
    state.contactVersionId = record.versionId;
    const inReview = await apiPost(page, "/api/contacts/review", scoped({
      accountId: state.accountId,
      versionId: record.versionId,
      expectedVersionId: record.versionId,
      expectedContentHash: record.contentHash,
      expectedReviewHash: record.review.reviewHash,
      to: "in_review",
      actorId: ADMIN,
      reason: "L-08 contact in_review",
    }));
    const inReviewBody = await apiOk(inReview, "contact in_review");
    const reviewed = await apiPost(approverPage, "/api/contacts/review", scoped({
      accountId: state.accountId,
      versionId: record.versionId,
      expectedVersionId: record.versionId,
      expectedContentHash: record.contentHash,
      expectedReviewHash: (inReviewBody.record as { review: { reviewHash: string } }).review.reviewHash,
      to: "approved",
      actorId: APPROVER,
      reason: "L-08 contact approved",
    }));
    await apiOk(reviewed, "contact approved");
  });

  await test.step("qualification evaluated and human-reviewed", async () => {
    const evaluated = await apiPost(page, "/api/qualification", scoped({
      accountId: state.accountId,
      playVersionId: state.playVersionId,
      playContentHash: state.playContentHash,
      policy: {
        policyVersion: 1,
        policyId: `qualification-policy:l08-${RUN_NONCE}`,
        qualifiedThreshold: 70,
        reviewThreshold: 40,
        factors: [
          { factorId: "factor:icp-fit", weight: 60 },
          { factorId: "factor:evidence-freshness", weight: 40 },
        ],
      },
      observations: [{
        observationId: `acct-obs:l08-${RUN_NONCE}-1`,
        tenantId: T,
        workspaceId: W,
        accountId: state.accountId,
        observedAt: new Date(Date.now() - 60_000).toISOString(),
        payloadHash: sha256Hex({ run: RUN_NONCE, payload: "acme" }),
        provenanceHash: sha256Hex({ run: RUN_NONCE, provenance: "acme" }),
      }],
      factors: [
        {
          factorId: "factor:icp-fit",
          score: 65,
          reason: "Account matches the formulation-change ICP with one open uncertainty.",
          evidenceObservationIds: [`acct-obs:l08-${RUN_NONCE}-1`],
          uncertainty: { level: "high", reason: "Timing evidence is still missing." },
        },
        {
          factorId: "factor:evidence-freshness",
          score: 80,
          reason: "Source evidence is current.",
          evidenceObservationIds: [`acct-obs:l08-${RUN_NONCE}-1`],
          uncertainty: { level: "low", reason: "Observation freshness decays over time." },
        },
      ],
      contactContext: null,
    }));
    const body = await apiOk(evaluated, "qualification evaluate");
    const qualification = body.qualification as {
      versionId: string;
      qualificationHash: string;
      decision: string;
    };
    state.qualificationVersionId = qualification.versionId;
    // weighted = 65*60 + 80*40 = 7100/100 = 71 -> qualified threshold 70. To
    // exercise the review path deterministically regardless of thresholds the
    // reviewer confirms/overrides below.
    const reviewed = await apiPost(approverPage, "/api/qualification/review", scoped({
      accountId: state.accountId,
      versionId: qualification.versionId,
      expectedQualificationHash: qualification.qualificationHash,
      action: qualification.decision === "qualified" ? "confirm" : "override",
      decision: qualification.decision === "qualified" ? undefined : "qualified",
      actorId: APPROVER,
      reason: "L-08 qualification review confirms account is qualified.",
    }));
    const reviewedBody = await apiOk(reviewed, "qualification review");
    expect((reviewedBody.qualification as { decision: string }).decision).toBe("qualified");
  });

  await test.step("cited outreach draft generated, reviewed, and approved under separation of duty", async () => {
    const draftInput = scoped({
      accountId: state.accountId,
      draftKind: "initial",
      playVersionId: state.playVersionId,
      contactVersionId: state.contactVersionId,
      optOutText: "Reply STOP to opt out of further contact.",
    });
    const generated = await apiPost(page, "/api/outreach/drafts", draftInput);
    const body = await apiOk(generated, "draft generate");
    let draft = body.draft as {
      versionId: string;
      stableKey: string;
      contentHash: string;
      review: { reviewHash: string };
    } | null;
    if (body.persisted === "queued" && draft === null) {
      // Generation is a worker-gated agent run: the member request commits the
      // queued run, the agent_runtime worker claims and executes it under its
      // bound lease, and the retried request deduplicates to the finished run.
      const worker = await driveAgentRuntimeWorker(page, body.agentRunId as string);
      const workerBody = await apiOk(worker, "agent runtime worker");
      expect(workerBody.status).toBe("processed");
      const retried = await apiPost(page, "/api/outreach/drafts", draftInput);
      const retriedBody = await apiOk(retried, "draft generate retry");
      expect(retriedBody.persisted).toBe("created");
      draft = retriedBody.draft as typeof draft;
    }
    if (draft === null) throw new Error("draft generate did not produce a draft");
    state.draftVersionId = draft.versionId;
    state.draftStableKey = draft.stableKey;
    state.draftContentHash = draft.contentHash;
    state.draftReviewHash = draft.review.reviewHash;

    const inReview = await apiPost(page, "/api/outreach/drafts/review", scoped({
      accountId: state.accountId,
      versionId: draft.versionId,
      expectedReviewHash: draft.review.reviewHash,
      to: "in_review",
      reason: "L-08 draft submitted for review",
    }));
    const inReviewBody = await apiOk(inReview, "draft in_review");
    const reviewHash = (inReviewBody.review as { reviewHash: string }).reviewHash;

    // Approval must come from a different member (separation of duty).
    const approved = await apiPost(approverPage, "/api/outreach/drafts/review", scoped({
      accountId: state.accountId,
      versionId: draft.versionId,
      expectedReviewHash: reviewHash,
      to: "approved",
      reason: "L-08 draft approved: citations verified",
    }));
    const approvedBody = await apiOk(approved, "draft approved");
    expect((approvedBody.review as { status?: string }).status).toBe("approved");
    state.draftReviewHash = (approvedBody.review as { reviewHash: string }).reviewHash;
  });

  await test.step("copy/export handoff releases receipts; no send path exists", async () => {
    for (const action of ["copy", "export"] as const) {
      const handoff = await apiPost(page, "/api/outreach/handoffs", scoped({
        accountId: state.accountId,
        stableKey: state.draftStableKey,
        action,
        contactVersionId: state.contactVersionId,
        idempotencyKey: `l08-${RUN_NONCE}-handoff-${action}`,
        recipientTimezone: "UTC",
        plannedAt: businessHoursTimestamp(),
      }));
      const body = await apiOk(handoff, `handoff ${action}`);
      expect(body.status).toBe("released");
      expect((body.receipt as { action?: string }).action).toBe(action);
    }
    // No send path: the route rejects anything but copy|export before dispatch.
    const send = await apiPost(page, "/api/outreach/handoffs", scoped({
      accountId: state.accountId,
      stableKey: state.draftStableKey,
      action: "send",
      contactVersionId: state.contactVersionId,
      idempotencyKey: `l08-${RUN_NONCE}-handoff-send`,
      recipientTimezone: "UTC",
    }));
    expect(send.status).toBe(400);
  });

  await test.step("outcome recorded against the approved draft", async () => {
    const recorded = await apiPost(page, "/api/outcomes", scoped({
      accountId: state.accountId,
      playVersionId: state.playVersionId,
      stableKey: `outcome:l08-${RUN_NONCE}`,
      outcome: "replied",
      channel: "email",
      occurredAt: new Date().toISOString(),
      notes: "Prospect replied after the approved draft was handed off via copy.",
      source: {
        kind: "member_observation",
        sourceId: `member:${ADMIN}`,
        sourceVersionId: `member-observation:l08-${RUN_NONCE}`,
        sourceContentHash: sha256Hex({ run: RUN_NONCE, outcome: "replied" }),
        sourceReceiptHash: sha256Hex({ run: RUN_NONCE, receipt: "outcome" }),
        observedAt: new Date().toISOString(),
      },
      outreachDraftVersionId: state.draftVersionId,
      attribution: {
        kind: "direct",
        confidenceBasisPoints: 9_000,
        rationale: "The reply references the approved draft subject line.",
        evidenceRefs: [
          { kind: "play_version", refId: state.playVersionId,
            refHash: sha256Hex({ run: RUN_NONCE, attribution: state.playVersionId }) },
        ],
      },
    }));
    const body = await apiOk(recorded, "outcome record");
    expect(body.created).toBe(true);
    const outcomes = await apiGet(page, "/api/outcomes", {
      tenantId: T,
      workspaceId: W,
      accountId: state.accountId,
    });
    const listed = await apiOk(outcomes, "outcomes list");
    expect(JSON.stringify(listed)).toContain(state.draftVersionId);
  });

  await test.step("happy-path state is handed to the degraded-path spec", async () => {
    // The degraded spec proves a recorded suppression dominates handoff
    // eligibility; it needs this run's approved draft + contact identifiers.
    const { writeFileSync, mkdirSync } = await import("node:fs");
    const { dirname } = await import("node:path");
    const file = acceptanceStatePath();
    mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
    writeFileSync(file, JSON.stringify({
      runNonce: RUN_NONCE,
      accountId: state.accountId,
      contactVersionId: state.contactVersionId,
      contactStableKey: `contact:l08-${RUN_NONCE}`,
      draftStableKey: state.draftStableKey,
      draftVersionId: state.draftVersionId,
    }), { mode: 0o600 });
  });
});
