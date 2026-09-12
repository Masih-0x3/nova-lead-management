import { createHash } from "node:crypto";

import { describe, expect, it, vi } from "vitest";

import type {
  OutcomeRepository,
  StoredOutcomeVersion,
} from "@/lib/outcomes/repository";
import type { OutcomeRecord } from "@/lib/outcomes/outcome-record";
import {
  buildAttributionReportView,
  listOutcomeVersionViews,
  recordOutcome,
} from "@/lib/outcomes/service";
import type { SuppressionRepository } from "@/lib/suppressions/repository";

const TENANT = "10000000-0000-4000-8000-000000000001";
const WORKSPACE = "20000000-0000-4000-8000-000000000001";
const ACCOUNT = "30000000-0000-4000-8000-000000000001";
const MEMBER = "40000000-0000-4000-8000-000000000001";
const PLAY_VERSION = `lead-play-version:${"a".repeat(64)}`;

function sha256(value: unknown): string {
  return `sha256:${createHash("sha256")
    .update(typeof value === "string" ? value : JSON.stringify(value)).digest("hex")}`;
}

function fakeRepository(): OutcomeRepository & { rows: Map<string, StoredOutcomeVersion> } {
  const rows = new Map<string, StoredOutcomeVersion>();
  const store = (record: OutcomeRecord) => Object.freeze({
    tenantId: record.tenantId,
    workspaceId: record.workspaceId,
    accountId: record.accountId,
    playVersionId: record.playVersionId,
    stableKey: record.stableKey,
    revision: record.revision,
    draftVersionId: record.outreachDraftVersionRef?.versionId ?? null,
    record,
    createdAt: record.recordedAt,
  });
  return {
    rows,
    insertVersion: vi.fn(async (record: OutcomeRecord) => {
      if (rows.has(record.versionId)) return "replayed" as const;
      rows.set(record.versionId, store(record));
      return "created" as const;
    }),
    getVersion: vi.fn(async (tenantId, workspaceId, accountId, versionId) => {
      const row = rows.get(versionId);
      return row && row.tenantId === tenantId && row.workspaceId === workspaceId
        && row.accountId === accountId ? row : null;
    }),
    getLatestVersion: vi.fn(async (tenantId, workspaceId, accountId, playVersionId, stableKey) =>
      [...rows.values()]
        .filter((row) => row.tenantId === tenantId && row.workspaceId === workspaceId
          && row.accountId === accountId && row.playVersionId === playVersionId
          && row.stableKey === stableKey)
        .sort((a, b) => b.revision - a.revision)[0] ?? null),
    listVersions: vi.fn(async (tenantId, workspaceId, filter) =>
      [...rows.values()].filter((row) =>
        row.tenantId === tenantId && row.workspaceId === workspaceId
        && (filter?.accountId === undefined || row.accountId === filter.accountId)
        && (filter?.playVersionId === undefined || row.playVersionId === filter.playVersionId)
        && (filter?.stableKey === undefined || row.stableKey === filter.stableKey))
        .slice(0, filter?.limit ?? 10_000)),
  };
}

function fakeSuppressions(): SuppressionRepository & { records: Map<string, unknown> } {
  const records = new Map<string, unknown>();
  return {
    records,
    insertRecord: vi.fn(async (record) => {
      if (records.has(record.recordId)) return "replayed" as const;
      records.set(record.recordId, record);
      return "created" as const;
    }),
    listRecords: vi.fn(async () => []),
    getRecord: vi.fn(async () => null),
  };
}

function input(overrides: Record<string, unknown> = {}) {
  return {
    tenantId: TENANT,
    workspaceId: WORKSPACE,
    accountId: ACCOUNT,
    playVersionId: PLAY_VERSION,
    stableKey: "outcome:synthetic-thread",
    outcome: "replied",
    channel: "email",
    occurredAt: "2026-09-15T12:00:00.000Z",
    notes: "The synthetic contact replied requesting a call.",
    source: {
      kind: "member_observation",
      sourceId: "member:inbox-observation",
      sourceVersionId: "observation:v1",
      sourceContentHash: sha256("synthetic inbox observation"),
      sourceReceiptHash: sha256("synthetic observation receipt"),
      observedAt: "2026-09-15T12:05:00.000Z",
    },
    recordedBy: MEMBER,
    ...overrides,
  };
}

function tickClock(start = "2026-09-16T00:00:00.000Z") {
  let at = Date.parse(start);
  return () => new Date(at += 60_000);
}

describe("l06 outcome service", () => {
  it("records a v1 outcome with source binding and human actor", async () => {
    const repository = fakeRepository();
    const deps = { outcomes: repository, clock: () => new Date("2026-09-16T00:00:00.000Z") };
    const result = await recordOutcome(deps, input());
    expect(result.created).toBe(true);
    expect(result.corrected).toBe(false);
    expect(result.record.versionId).toMatch(/^outcome-version:[0-9a-f]{64}$/u);
    expect(result.record.recordedBy).toEqual({ kind: "human", actorId: MEMBER });
    expect(result.record.revision).toBe(1);
    expect(result.record.audit.length).toBeGreaterThan(0);
  });

  it("accepts the disqualified taxonomy value", async () => {
    const repository = fakeRepository();
    const deps = { outcomes: repository, clock: () => new Date("2026-09-16T00:00:00.000Z") };
    const result = await recordOutcome(deps, input({ outcome: "disqualified" }));
    expect(result.record.outcome).toBe("disqualified");
  });

  it("rejects malformed input and non-launch outcomes fail-closed", async () => {
    const repository = fakeRepository();
    const deps = { outcomes: repository, clock: () => new Date("2026-09-16T00:00:00.000Z") };
    await expect(recordOutcome(deps, { tenantId: "nope" }))
      .rejects.toMatchObject({ code: "OUTCOME_INPUT_INVALID" });
    await expect(recordOutcome(deps, input({ outcome: "converted" })))
      .rejects.toMatchObject({ code: "OUTCOME_INPUT_INVALID" });
    await expect(recordOutcome(deps, input({ occurredAt: "2027-01-01T00:00:00.000Z" })))
      .rejects.toMatchObject({ code: "OUTCOME_INPUT_INVALID" });
    expect(repository.insertVersion).not.toHaveBeenCalled();
  });

  it("appends a correction revision with predecessor linkage and audit history", async () => {
    const repository = fakeRepository();
    const deps = { outcomes: repository, clock: tickClock() };
    const first = await recordOutcome(deps, input({ outcome: "replied" }));
    const corrected = await recordOutcome(deps, input({
      outcome: "meeting_set",
      notes: "Correction: the reply produced a confirmed meeting.",
      correctionReason: "The member confirmed the meeting was booked.",
    }));
    expect(corrected.corrected).toBe(true);
    expect(corrected.record.revision).toBe(2);
    expect(corrected.record.supersedesVersionId).toBe(first.record.versionId);
    expect(corrected.record.audit.length).toBeGreaterThan(first.record.audit.length);
  });

  it("requires a correction reason for chain revisions", async () => {
    const repository = fakeRepository();
    const deps = { outcomes: repository, clock: tickClock() };
    await recordOutcome(deps, input());
    await expect(recordOutcome(deps, input({ outcome: "won" })))
      .rejects.toMatchObject({ code: "OUTCOME_HUMAN_CORRECTION_REQUIRED" });
  });

  it("enforces optimistic concurrency on the chain head", async () => {
    const repository = fakeRepository();
    const deps = { outcomes: repository, clock: tickClock() };
    await recordOutcome(deps, input());
    await expect(recordOutcome(deps, input({
      outcome: "lost",
      correctionReason: "Revising.",
      expectedPredecessorVersionId: `outcome-version:${"f".repeat(64)}`,
    }))).rejects.toMatchObject({ code: "OUTCOME_VERSION_CONFLICT" });
  });

  it("derives a protective suppression only when explicitly requested", async () => {
    const repository = fakeRepository();
    const suppressions = fakeSuppressions();
    const deps = {
      outcomes: repository,
      suppressions,
      clock: () => new Date("2026-09-16T00:00:00.000Z"),
    };
    const result = await recordOutcome(deps, input({
      outcome: "opted_out",
      notes: "The synthetic contact opted out.",
      suppress: { contactStableKey: "contact:synthetic-buyer" },
    }));
    expect(result.suppressionRecordId).toMatch(/^suppression-record:[0-9a-f]{64}$/u);
    const record = suppressions.records.get(result.suppressionRecordId ?? "") as
      { disposition: string; source: { kind: string; outcomeVersionId: string | null } } | undefined;
    expect(record?.disposition).toBe("opt_out");
    expect(record?.source.kind).toBe("outcome_derived");
    expect(record?.source.outcomeVersionId).toBe(result.record.versionId);
  });

  it("refuses implicit suppression for non-protective outcomes", async () => {
    const repository = fakeRepository();
    const suppressions = fakeSuppressions();
    const deps = {
      outcomes: repository,
      suppressions,
      clock: () => new Date("2026-09-16T00:00:00.000Z"),
    };
    await expect(recordOutcome(deps, input({
      outcome: "replied",
      suppress: { contactStableKey: "contact:synthetic-buyer" },
    }))).rejects.toMatchObject({ code: "OUTCOME_SUPPRESSION_NOT_APPLICABLE" });
  });

  it("builds a deterministic attribution report over corrected chains", async () => {
    const repository = fakeRepository();
    const deps = { outcomes: repository, clock: tickClock() };
    await recordOutcome(deps, input({ outcome: "replied" }));
    await recordOutcome(deps, input({
      outcome: "won",
      notes: "Correction: closed won.",
      correctionReason: "The member confirmed the deal closed.",
    }));

    const report = await buildAttributionReportView(deps, {
      tenantId: TENANT,
      workspaceId: WORKSPACE,
      reportKey: "report:synthetic-window",
      from: "2026-09-01T00:00:00.000Z",
      to: "2026-09-17T00:00:00.000Z",
      asOf: "2026-09-17T00:00:00.000Z",
    });
    expect(report.reportKey).toBe("report:synthetic-window");
    // The corrected chain resolves to its latest revision (won), not the v1 reply.
    const refs = report.groups.flatMap((group) => group.sourceOutcomeRefs);
    expect(refs).toHaveLength(1);
    expect(refs[0]?.outcome).toBe("won");
    expect(report.summary.total).toBe(1);
  });

  it("lists outcome views scoped to tenant and account", async () => {
    const repository = fakeRepository();
    const deps = { outcomes: repository, clock: () => new Date("2026-09-16T00:00:00.000Z") };
    await recordOutcome(deps, input());
    const views = await listOutcomeVersionViews(deps, {
      tenantId: TENANT, workspaceId: WORKSPACE, accountId: ACCOUNT,
    });
    expect(views).toHaveLength(1);
    expect(views[0]?.outcome).toBe("replied");
    expect(views[0]?.recordedBy).toBe(MEMBER);
  });
});
