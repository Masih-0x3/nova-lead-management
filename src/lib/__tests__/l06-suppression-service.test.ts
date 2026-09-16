import { describe, expect, it, vi } from "vitest";

import type {
  StoredSuppressionRow,
  SuppressionRepository,
} from "@/lib/suppressions/repository";
import type { SuppressionRecord } from "@/lib/suppressions/suppression-record";
import {
  listSuppressionViews,
  recordSuppression,
  resolveSuppression,
} from "@/lib/suppressions/service";

const TENANT = "10000000-0000-4000-8000-000000000001";
const TENANT_B = "10000000-0000-4000-8000-000000000002";
const WORKSPACE = "20000000-0000-4000-8000-000000000001";
const ACCOUNT = "30000000-0000-4000-8000-000000000001";
const ACCOUNT_B = "30000000-0000-4000-8000-000000000002";
const MEMBER = "40000000-0000-4000-8000-000000000001";
const CONTACT_KEY = "contact:synthetic-buyer";

function fakeRepository(): SuppressionRepository & { rows: Map<string, StoredSuppressionRow> } {
  const rows = new Map<string, StoredSuppressionRow>();
  return {
    rows,
    insertRecord: vi.fn(async (record: SuppressionRecord) => {
      if (rows.has(record.recordId)) return "replayed" as const;
      rows.set(record.recordId, Object.freeze({
        tenantId: record.tenantId, workspaceId: record.workspaceId, record,
      }));
      return "created" as const;
    }),
    listRecords: vi.fn(async (tenantId, workspaceId, filter) =>
      [...rows.values()].filter((row) =>
        row.tenantId === tenantId && row.workspaceId === workspaceId
        && (filter?.accountId === undefined
          ? (filter?.includeTenantScoped ? row.record.accountId !== null || true : true)
          : row.record.accountId === filter.accountId
            || (filter?.includeTenantScoped === true && row.record.accountId === null))
        && (filter?.contactStableKey === undefined
          || row.record.contactStableKey === filter.contactStableKey))),
    getRecord: vi.fn(async (tenantId, workspaceId, recordId) => {
      const row = rows.get(recordId);
      return row && row.tenantId === tenantId && row.workspaceId === workspaceId ? row : null;
    }),
  };
}

function input(overrides: Record<string, unknown> = {}) {
  return {
    tenantId: TENANT,
    workspaceId: WORKSPACE,
    accountId: ACCOUNT,
    contactStableKey: CONTACT_KEY,
    disposition: "opt_out",
    reason: "The synthetic contact asked not to be contacted.",
    actorId: MEMBER,
    occurredAt: "2026-09-16T12:00:00.000Z",
    recordedAt: "2026-09-16T12:01:00.000Z",
    ...overrides,
  };
}

describe("l06 suppression service", () => {
  it("records a content-addressed suppression and replays an identical append", async () => {
    const repository = fakeRepository();
    const deps = { repository };
    const first = await recordSuppression(deps, input());
    expect(first.persisted).toBe("created");
    expect(first.record.recordId).toMatch(/^suppression-record:[0-9a-f]{64}$/u);
    expect(first.record.disposition).toBe("opt_out");

    const replay = await recordSuppression(deps, input());
    expect(replay.persisted).toBe("replayed");
    expect(replay.record.recordId).toBe(first.record.recordId);
  });

  it("rejects malformed input before touching persistence", async () => {
    const repository = fakeRepository();
    await expect(recordSuppression({ repository }, { tenantId: "nope" }))
      .rejects.toMatchObject({ code: "SUPPRESSION_INPUT_INVALID" });
    await expect(recordSuppression({ repository }, input({ disposition: "clear" })))
      .rejects.toMatchObject({ code: "SUPPRESSION_INPUT_INVALID" });
    await expect(recordSuppression({ repository }, input({ accountId: null })))
      .rejects.toMatchObject({ code: "SUPPRESSION_INPUT_INVALID" });
    expect(repository.insertRecord).not.toHaveBeenCalled();
  });

  it("blocks a contact under an applicable record and stays clear without one", async () => {
    const repository = fakeRepository();
    const deps = { repository };
    await recordSuppression(deps, input());

    const blocked = await resolveSuppression(deps, {
      tenantId: TENANT, workspaceId: WORKSPACE, accountId: ACCOUNT,
      contactStableKey: CONTACT_KEY, contactDisposition: "clear",
    });
    expect(blocked.blocking).toBe(true);
    expect(blocked.effectiveDisposition).toBe("opt_out");
    expect(blocked.dominantRecord?.contactStableKey).toBe(CONTACT_KEY);

    const clear = await resolveSuppression(deps, {
      tenantId: TENANT, workspaceId: WORKSPACE, accountId: ACCOUNT,
      contactStableKey: "contact:someone-else", contactDisposition: "clear",
    });
    expect(clear.blocking).toBe(false);
    expect(clear.effectiveDisposition).toBe("clear");
  });

  it("applies D-012 precedence — the most restrictive applicable record wins", async () => {
    const repository = fakeRepository();
    const deps = { repository };
    await recordSuppression(deps, input({ disposition: "opt_out" }));
    await recordSuppression(deps, input({
      disposition: "do_not_contact",
      reason: "The synthetic account asked for no outreach at all.",
      contactStableKey: null,
    }));

    const resolved = await resolveSuppression(deps, {
      tenantId: TENANT, workspaceId: WORKSPACE, accountId: ACCOUNT,
      contactStableKey: CONTACT_KEY, contactDisposition: "clear",
    });
    expect(resolved.effectiveDisposition).toBe("do_not_contact");
    expect(resolved.dominantRecord?.accountId).toBe(ACCOUNT);
    expect(resolved.dominantRecord?.contactStableKey).toBeNull();
  });

  it("merges the contact's stored disposition with applicable records", async () => {
    const repository = fakeRepository();
    const deps = { repository };
    await recordSuppression(deps, input({ disposition: "soft_bounce" }));

    const resolved = await resolveSuppression(deps, {
      tenantId: TENANT, workspaceId: WORKSPACE, accountId: ACCOUNT,
      contactStableKey: CONTACT_KEY, contactDisposition: "complaint",
    });
    expect(resolved.effectiveDisposition).toBe("complaint");
  });

  it("applies tenant-scoped records across accounts", async () => {
    const repository = fakeRepository();
    const deps = { repository };
    await recordSuppression(deps, input({
      accountId: null, contactStableKey: null, disposition: "do_not_contact",
      reason: "Tenant-wide legal suppression.",
    }));

    const resolved = await resolveSuppression(deps, {
      tenantId: TENANT, workspaceId: WORKSPACE, accountId: ACCOUNT_B,
      contactStableKey: "contact:any", contactDisposition: "clear",
    });
    expect(resolved.effectiveDisposition).toBe("do_not_contact");
  });

  it("isolates suppression views per tenant", async () => {
    const repository = fakeRepository();
    const deps = { repository };
    await recordSuppression(deps, input());
    await recordSuppression(deps, input({ tenantId: TENANT_B }));

    const views = await listSuppressionViews(deps, {
      tenantId: TENANT, workspaceId: WORKSPACE, accountId: ACCOUNT,
    });
    expect(views).toHaveLength(1);
    expect(views[0]?.disposition).toBe("opt_out");
  });
});
