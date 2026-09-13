import { isProxy } from "node:util/types";

import type { DbClient } from "@/lib/db";

export class DiscoveryPersistenceError extends Error {
  readonly code = "DISCOVERY_PERSISTENCE" as const;

  constructor() {
    super("The discovery state could not be loaded or persisted safely.");
    this.name = "DiscoveryPersistenceError";
  }
}

function fail(): never {
  throw new DiscoveryPersistenceError();
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const SHA256 = /^[0-9a-f]{64}$/u;
const PLAN_ID = /^discovery-plan:[0-9a-f]{64}$/u;
const RUN_ID = /^discovery-run:[0-9a-f]{64}$/u;
const RESOLUTION_ID = /^account-resolution:[0-9a-f]{64}$/u;
const MERGE_EVENT_ID = /^account-merge-event:[0-9a-f]{64}$/u;
const REF = /^[A-Za-z0-9][A-Za-z0-9:._@/-]{0,299}$/u;
const RUN_STATUSES = new Set(["planned", "running", "completed", "failed", "cancelled"]);
const ACCOUNT_STATUSES = new Set(["active", "merged"]);
const RESOLUTION_STATES = new Set(["auto_resolved", "human_review", "canonical_candidate"]);
const RESOLUTION_RULES = new Set([
  "EXACT_SOURCE_ID_SAME_TENANT_NAMESPACE",
  "CONFLICTING_EXACT_IDENTITY",
  "NO_MATCH_OR_INSUFFICIENT_EVIDENCE",
]);

export function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value) || isProxy(value)) return false;
  try {
    const prototype = Object.getPrototypeOf(value);
    return prototype === Object.prototype || prototype === null;
  } catch {
    return false;
  }
}

function requiredRow(value: unknown): Record<string, unknown> {
  if (!isPlainRecord(value)) fail();
  return value;
}

function uuid(value: unknown): string {
  if (typeof value !== "string" || !UUID.test(value)) fail();
  return value;
}

function nullableUuid(value: unknown): string | null {
  if (value === null) return null;
  return uuid(value);
}

function sha(value: unknown): string {
  if (typeof value !== "string" || !SHA256.test(value)) fail();
  return value;
}

function refValue(value: unknown): string {
  if (typeof value !== "string" || !REF.test(value)) fail();
  return value;
}

function nullableRef(value: unknown): string | null {
  if (value === null) return null;
  return refValue(value);
}

function intValue(value: unknown): number {
  const normalized = typeof value === "string" && /^[0-9]+$/u.test(value) ? Number(value) : value;
  if (typeof normalized !== "number" || !Number.isSafeInteger(normalized) || normalized < 0) fail();
  return normalized;
}

function timestamp(value: unknown): string {
  if (value instanceof Date) {
    if (Number.isFinite(value.getTime())) return value.toISOString();
    fail();
  }
  if (typeof value !== "string") fail();
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) fail();
  return new Date(parsed).toISOString();
}

function payloadOf(record: Record<string, unknown>): Record<string, unknown> {
  const payload = record.payload;
  if (!isPlainRecord(payload)) fail();
  return payload;
}

function jsonText(value: unknown): string {
  try {
    const serialized = JSON.stringify(value);
    if (typeof serialized !== "string") fail();
    return serialized;
  } catch {
    fail();
  }
}

export type DiscoveryPlanRow = Readonly<{
  planId: string;
  tenantId: string;
  workspaceId: string | null;
  planSha256: string;
  status: string;
  playStableKey: string;
  playVersionId: string;
  playRevision: number;
  sourceKeys: readonly string[];
  limits: Record<string, unknown>;
  payload: Record<string, unknown>;
  createdAt: string;
}>;

export type DiscoveryRunRow = Readonly<{
  runId: string;
  tenantId: string;
  workspaceId: string | null;
  planId: string;
  status: "planned" | "running" | "completed" | "failed" | "cancelled";
  runSha256: string;
  payload: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}>;

export type CanonicalAccountRow = Readonly<{
  accountId: string;
  tenantId: string;
  workspaceId: string;
  version: number;
  status: "active" | "merged";
  redirectToAccountId: string | null;
  displayName: string | null;
  profile: Record<string, unknown>;
  profileSha256: string;
  exactKeys: readonly unknown[];
  observationRefs: readonly string[];
  createdAt: string;
  updatedAt: string;
}>;

export type AccountObservationRow = Readonly<{
  observationId: string;
  tenantId: string;
  workspaceId: string;
  accountId: string;
  sourceKey: string;
  namespace: string;
  externalId: string;
  observedAt: string;
  payloadSha256: string;
  provenanceSha256: string;
  resolutionId: string | null;
  discoveryRunId: string | null;
  sourceObservationId: string | null;
  createdAt: string;
}>;

export type AccountResolutionRow = Readonly<{
  resolutionId: string;
  tenantId: string;
  workspaceId: string;
  state: "auto_resolved" | "human_review" | "canonical_candidate";
  ruleId: string;
  targetAccountId: string | null;
  canonicalCandidateId: string | null;
  candidateAccountIds: readonly string[];
  observations: readonly unknown[];
  resolutionSha256: string;
  createdAt: string;
}>;

export type MergeSnapshotRow = Readonly<{
  tenantId: string;
  workspaceId: string;
  members: readonly unknown[];
  stateSha256: string;
  updatedAt: string;
}>;

export type MergeEventRow = Readonly<{
  eventId: string;
  tenantId: string;
  workspaceId: string;
  action: "merge" | "unmerge";
  survivorAccountId: string;
  retiredAccountId: string;
  evidenceObservationIds: readonly string[];
  actor: Record<string, unknown>;
  at: string;
  reason: string;
}>;

function stringArray(value: unknown): readonly string[] {
  if (!Array.isArray(value) || isProxy(value)) fail();
  const out: string[] = [];
  for (const item of value) {
    if (typeof item !== "string" || item.length === 0 || item.length > 300) fail();
    out.push(item);
  }
  return Object.freeze(out);
}

function objectArray(value: unknown): readonly unknown[] {
  if (!Array.isArray(value) || isProxy(value)) fail();
  return Object.freeze([...value]);
}

function parsePlanRow(value: unknown): DiscoveryPlanRow {
  const r = requiredRow(value);
  if (r.status !== "plan_only") fail();
  return Object.freeze({
    planId: typeof r.plan_id === "string" && PLAN_ID.test(r.plan_id) ? r.plan_id : fail(),
    tenantId: uuid(r.tenant_id),
    workspaceId: nullableUuid(r.workspace_id),
    planSha256: sha(r.plan_sha256),
    status: r.status,
    playStableKey: typeof r.play_stable_key === "string" && r.play_stable_key.length <= 300
      ? r.play_stable_key : fail(),
    playVersionId: typeof r.play_version_id === "string" ? r.play_version_id : fail(),
    playRevision: intValue(r.play_revision),
    sourceKeys: stringArray(r.source_keys),
    limits: isPlainRecord(r.limits) ? r.limits : fail(),
    payload: payloadOf(r),
    createdAt: timestamp(r.created_at),
  });
}

function parseRunRow(value: unknown): DiscoveryRunRow {
  const r = requiredRow(value);
  const status = r.status;
  if (typeof status !== "string" || !RUN_STATUSES.has(status)) fail();
  return Object.freeze({
    runId: typeof r.run_id === "string" && RUN_ID.test(r.run_id) ? r.run_id : fail(),
    tenantId: uuid(r.tenant_id),
    workspaceId: nullableUuid(r.workspace_id),
    planId: typeof r.plan_id === "string" && PLAN_ID.test(r.plan_id) ? r.plan_id : fail(),
    status: status as DiscoveryRunRow["status"],
    runSha256: sha(r.run_sha256),
    payload: payloadOf(r),
    createdAt: timestamp(r.created_at),
    updatedAt: timestamp(r.updated_at),
  });
}

function parseAccountRow(value: unknown): CanonicalAccountRow {
  const r = requiredRow(value);
  const status = r.status;
  if (typeof status !== "string" || !ACCOUNT_STATUSES.has(status)) fail();
  return Object.freeze({
    accountId: uuid(r.account_id),
    tenantId: uuid(r.tenant_id),
    workspaceId: uuid(r.workspace_id),
    version: intValue(r.version),
    status: status as CanonicalAccountRow["status"],
    redirectToAccountId: nullableUuid(r.redirect_to_account_id),
    displayName: r.display_name === null ? null
      : typeof r.display_name === "string" ? r.display_name : fail(),
    profile: isPlainRecord(r.profile) ? r.profile : fail(),
    profileSha256: sha(r.profile_sha256),
    exactKeys: objectArray(r.exact_keys),
    observationRefs: stringArray(r.observation_refs),
    createdAt: timestamp(r.created_at),
    updatedAt: timestamp(r.updated_at),
  });
}

function parseObservationRow(value: unknown): AccountObservationRow {
  const r = requiredRow(value);
  return Object.freeze({
    observationId: refValue(r.observation_id),
    tenantId: uuid(r.tenant_id),
    workspaceId: uuid(r.workspace_id),
    accountId: uuid(r.account_id),
    sourceKey: refValue(r.source_key),
    namespace: refValue(r.namespace),
    externalId: refValue(r.external_id),
    observedAt: timestamp(r.observed_at),
    payloadSha256: sha(r.payload_sha256),
    provenanceSha256: sha(r.provenance_sha256),
    resolutionId: r.resolution_id === null ? null
      : typeof r.resolution_id === "string" && RESOLUTION_ID.test(r.resolution_id) ? r.resolution_id : fail(),
    discoveryRunId: r.discovery_run_id === null ? null
      : typeof r.discovery_run_id === "string" && RUN_ID.test(r.discovery_run_id)
        ? r.discovery_run_id : fail(),
    sourceObservationId: nullableRef(r.source_observation_id),
    createdAt: timestamp(r.created_at),
  });
}

function parseResolutionRow(value: unknown): AccountResolutionRow {
  const r = requiredRow(value);
  const state = r.state;
  const ruleId = r.rule_id;
  if (typeof state !== "string" || !RESOLUTION_STATES.has(state)) fail();
  if (typeof ruleId !== "string" || !RESOLUTION_RULES.has(ruleId)) fail();
  return Object.freeze({
    resolutionId: typeof r.resolution_id === "string" && RESOLUTION_ID.test(r.resolution_id)
      ? r.resolution_id : fail(),
    tenantId: uuid(r.tenant_id),
    workspaceId: uuid(r.workspace_id),
    state: state as AccountResolutionRow["state"],
    ruleId,
    targetAccountId: nullableUuid(r.target_account_id),
    canonicalCandidateId: r.canonical_candidate_id === null ? null
      : typeof r.canonical_candidate_id === "string" ? r.canonical_candidate_id : fail(),
    candidateAccountIds: stringArray(r.candidate_account_ids),
    observations: objectArray(r.observations),
    resolutionSha256: sha(r.resolution_sha256),
    createdAt: timestamp(r.created_at),
  });
}

function parseMergeSnapshotRow(value: unknown): MergeSnapshotRow {
  const r = requiredRow(value);
  return Object.freeze({
    tenantId: uuid(r.tenant_id),
    workspaceId: uuid(r.workspace_id),
    members: objectArray(r.members),
    stateSha256: sha(r.state_sha256),
    updatedAt: timestamp(r.updated_at),
  });
}

function parseMergeEventRow(value: unknown): MergeEventRow {
  const r = requiredRow(value);
  const action = r.action;
  if (action !== "merge" && action !== "unmerge") fail();
  return Object.freeze({
    eventId: typeof r.event_id === "string" && MERGE_EVENT_ID.test(r.event_id) ? r.event_id : fail(),
    tenantId: uuid(r.tenant_id),
    workspaceId: uuid(r.workspace_id),
    action,
    survivorAccountId: uuid(r.survivor_account_id),
    retiredAccountId: uuid(r.retired_account_id),
    evidenceObservationIds: stringArray(r.evidence_observation_ids),
    actor: isPlainRecord(r.actor) ? r.actor : fail(),
    at: timestamp(r.at),
    reason: typeof r.reason === "string" ? r.reason : fail(),
  });
}

export interface DiscoveryRepository {
  insertPlan(plan: Readonly<Record<string, unknown>>): Promise<"created" | "replayed">;
  getPlan(tenantId: string, workspaceId: string | null, planId: string): Promise<DiscoveryPlanRow | null>;
  listPlans(tenantId: string, workspaceId: string | null): Promise<readonly DiscoveryPlanRow[]>;
  insertRun(run: Readonly<Record<string, unknown>>): Promise<"created" | "replayed">;
  getRun(tenantId: string, workspaceId: string | null, runId: string): Promise<DiscoveryRunRow | null>;
  listRuns(tenantId: string, workspaceId: string | null): Promise<readonly DiscoveryRunRow[]>;
  updateRun(expectedRunHash: string, run: Readonly<Record<string, unknown>>): Promise<void>;
}

export interface AccountRepository {
  insertAccount(record: Readonly<{
    accountId: string; tenantId: string; workspaceId: string; version: number;
    status: "active" | "merged"; redirectToAccountId: string | null; displayName: string | null;
    profile: Record<string, unknown>; profileSha256: string; exactKeys: readonly unknown[];
    observationRefs: readonly string[]; createdAt: string; updatedAt: string;
  }>): Promise<"created" | "replayed">;
  getAccount(tenantId: string, workspaceId: string, accountId: string): Promise<CanonicalAccountRow | null>;
  listAccounts(tenantId: string, workspaceId: string): Promise<readonly CanonicalAccountRow[]>;
  updateAccountProjection(record: Readonly<{
    accountId: string; tenantId: string; workspaceId: string; expectedVersion: number;
    version: number; status: "active" | "merged"; redirectToAccountId: string | null;
    displayName: string | null; profile: Record<string, unknown>; profileSha256: string;
    exactKeys: readonly unknown[]; observationRefs: readonly string[]; updatedAt: string;
  }>): Promise<void>;
  insertObservationBinding(record: Readonly<{
    observationId: string; tenantId: string; workspaceId: string; accountId: string;
    sourceKey: string; namespace: string; externalId: string; observedAt: string;
    payloadSha256: string; provenanceSha256: string; resolutionId: string | null;
    discoveryRunId: string | null; sourceObservationId: string | null;
  }>): Promise<"created" | "replayed">;
  listAccountObservations(tenantId: string, workspaceId: string, accountId: string): Promise<readonly AccountObservationRow[]>;
  listScopedObservations(tenantId: string, workspaceId: string): Promise<readonly AccountObservationRow[]>;
  insertResolution(record: Readonly<{
    resolutionId: string; tenantId: string; workspaceId: string; state: string; ruleId: string;
    targetAccountId: string | null; canonicalCandidateId: string | null;
    candidateAccountIds: readonly string[]; observations: readonly unknown[];
    resolutionSha256: string; createdAt: string;
  }>): Promise<"created" | "replayed">;
  listResolutions(tenantId: string, workspaceId: string): Promise<readonly AccountResolutionRow[]>;
  getMergeSnapshot(tenantId: string, workspaceId: string): Promise<MergeSnapshotRow | null>;
  upsertMergeSnapshot(record: Readonly<{
    tenantId: string; workspaceId: string; members: readonly unknown[];
    stateSha256: string; updatedAt: string;
  }>, expectedStateSha256: string | null): Promise<void>;
  insertMergeEvent(event: Readonly<{
    eventId: string; tenantId: string; workspaceId: string; action: "merge" | "unmerge";
    survivorAccountId: string; retiredAccountId: string;
    evidenceObservationIds: readonly string[]; actor: Record<string, unknown>;
    at: string; reason: string;
  }>): Promise<"created" | "replayed">;
  listMergeEvents(tenantId: string, workspaceId: string): Promise<readonly MergeEventRow[]>;
}

function expectChanges(result: { changes: number } | null | undefined): void {
  if (!result || typeof result.changes !== "number" || result.changes !== 1) fail();
}

function planColumns(plan: Readonly<Record<string, unknown>>): {
  planId: string; tenantId: string; workspaceId: string | null; planSha256: string;
  playStableKey: string; playVersionId: string; playRevision: number;
  sourceKeys: readonly string[]; limits: Record<string, unknown>; createdAt: string;
} {
  const play = isPlainRecord(plan.play) ? plan.play : fail();
  const limits = isPlainRecord(plan.limits) ? plan.limits : fail();
  const tasks = Array.isArray(plan.tasks) ? plan.tasks : fail();
  const sourceKeys = [...new Set(tasks.map((task) =>
    isPlainRecord(task) && typeof task.sourceKey === "string" ? task.sourceKey : fail()
  ))].sort();
  const createdAt = typeof plan.createdAt === "string" ? plan.createdAt : fail();
  const workspaceId = plan.workspaceId === null ? null
    : typeof plan.workspaceId === "string" && UUID.test(plan.workspaceId) ? plan.workspaceId : fail();
  return {
    planId: typeof plan.planId === "string" && PLAN_ID.test(plan.planId) ? plan.planId : fail(),
    tenantId: uuid(plan.tenantId),
    workspaceId,
    planSha256: typeof plan.planHash === "string" && plan.planHash.startsWith("sha256:")
      ? plan.planHash.slice("sha256:".length) : fail(),
    playStableKey: typeof play.stableKey === "string" ? play.stableKey : fail(),
    playVersionId: typeof play.versionId === "string" ? play.versionId : fail(),
    playRevision: intValue(play.revision),
    sourceKeys: Object.freeze(sourceKeys),
    limits,
    createdAt: timestamp(createdAt),
  };
}

function runColumns(run: Readonly<Record<string, unknown>>): {
  runId: string; tenantId: string; workspaceId: string | null; planId: string;
  status: string; runSha256: string; createdAt: string; updatedAt: string;
} {
  const plan = isPlainRecord(run.plan) ? run.plan : fail();
  const status = run.status;
  if (typeof status !== "string" || !RUN_STATUSES.has(status)) fail();
  const workspaceId = run.workspaceId === null ? null
    : typeof run.workspaceId === "string" && UUID.test(run.workspaceId) ? run.workspaceId : fail();
  return {
    runId: typeof run.runId === "string" && RUN_ID.test(run.runId) ? run.runId : fail(),
    tenantId: uuid(run.tenantId),
    workspaceId,
    planId: typeof plan.planId === "string" && PLAN_ID.test(plan.planId) ? plan.planId : fail(),
    status,
    runSha256: typeof run.runHash === "string" && run.runHash.startsWith("sha256:")
      ? run.runHash.slice("sha256:".length) : fail(),
    createdAt: timestamp(run.createdAt),
    updatedAt: timestamp(run.updatedAt),
  };
}

export function createPostgresDiscoveryRepository(db: DbClient): DiscoveryRepository & AccountRepository {
  if (!db || typeof db.prepare !== "function") throw new TypeError("A database client is required");

  const repository: DiscoveryRepository & AccountRepository = {
    async insertPlan(plan) {
      const columns = planColumns(plan);
      // createdAt is row metadata, not part of the hashed domain payload; the
      // stored doc must contain exactly the plan fields parsePlan re-verifies.
      const { createdAt: _rowCreatedAt, ...payload } = plan;
      void _rowCreatedAt;
      const inserted = await db.prepare(
        `INSERT INTO public.discovery_plans
          (plan_id, tenant_id, workspace_id, plan_sha256, status, play_stable_key,
           play_version_id, play_revision, source_keys, limits, payload, created_at)
          VALUES (?, ?, ?, ?, 'plan_only', ?, ?, ?, ?::jsonb, ?::jsonb, ?::jsonb, ?)
          ON CONFLICT (plan_id) DO NOTHING RETURNING plan_id`,
      ).all(
        columns.planId, columns.tenantId, columns.workspaceId, columns.planSha256,
        columns.playStableKey, columns.playVersionId, columns.playRevision,
        jsonText(columns.sourceKeys), jsonText(columns.limits), jsonText(payload), columns.createdAt,
      );
      if (!Array.isArray(inserted) || isProxy(inserted)) fail();
      return inserted.length === 1 ? "created" : "replayed";
    },
    async getPlan(tenantId, workspaceId, planId) {
      const found = await db.prepare(
        `SELECT plan_id, tenant_id, workspace_id, plan_sha256, status, play_stable_key,
          play_version_id, play_revision, source_keys, limits, payload, created_at
          FROM public.discovery_plans
          WHERE tenant_id = ? AND (workspace_id IS NOT DISTINCT FROM ?) AND plan_id = ?`,
      ).get(tenantId, workspaceId, planId);
      if (found === undefined) return null;
      return parsePlanRow(found);
    },
    async listPlans(tenantId, workspaceId) {
      const rows = await db.prepare(
        `SELECT plan_id, tenant_id, workspace_id, plan_sha256, status, play_stable_key,
          play_version_id, play_revision, source_keys, limits, payload, created_at
          FROM public.discovery_plans
          WHERE tenant_id = ? AND (workspace_id IS NOT DISTINCT FROM ?)
          ORDER BY created_at DESC, plan_id`,
      ).all(tenantId, workspaceId);
      if (!Array.isArray(rows) || isProxy(rows)) fail();
      return Object.freeze(rows.map((entry) => parsePlanRow(entry)));
    },
    async insertRun(run) {
      const columns = runColumns(run);
      const inserted = await db.prepare(
        `INSERT INTO public.discovery_runs
          (run_id, tenant_id, workspace_id, plan_id, status, run_sha256, payload, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?::jsonb, ?, ?)
          ON CONFLICT (run_id) DO NOTHING RETURNING run_id`,
      ).all(
        columns.runId, columns.tenantId, columns.workspaceId, columns.planId, columns.status,
        columns.runSha256, jsonText(run), columns.createdAt, columns.updatedAt,
      );
      if (!Array.isArray(inserted) || isProxy(inserted)) fail();
      return inserted.length === 1 ? "created" : "replayed";
    },
    async getRun(tenantId, workspaceId, runId) {
      const found = await db.prepare(
        `SELECT run_id, tenant_id, workspace_id, plan_id, status, run_sha256, payload,
          created_at, updated_at FROM public.discovery_runs
          WHERE tenant_id = ? AND (workspace_id IS NOT DISTINCT FROM ?) AND run_id = ?`,
      ).get(tenantId, workspaceId, runId);
      if (found === undefined) return null;
      return parseRunRow(found);
    },
    async listRuns(tenantId, workspaceId) {
      const rows = await db.prepare(
        `SELECT run_id, tenant_id, workspace_id, plan_id, status, run_sha256, payload,
          created_at, updated_at FROM public.discovery_runs
          WHERE tenant_id = ? AND (workspace_id IS NOT DISTINCT FROM ?)
          ORDER BY updated_at DESC, run_id`,
      ).all(tenantId, workspaceId);
      if (!Array.isArray(rows) || isProxy(rows)) fail();
      return Object.freeze(rows.map((entry) => parseRunRow(entry)));
    },
    async updateRun(expectedRunHash, run) {
      const columns = runColumns(run);
      expectChanges(await db.prepare(
        `UPDATE public.discovery_runs
          SET status = ?, run_sha256 = ?, payload = ?::jsonb, updated_at = ?
          WHERE run_id = ? AND tenant_id = ? AND (workspace_id IS NOT DISTINCT FROM ?)
            AND run_sha256 = ?`,
      ).run(
        columns.status, columns.runSha256, jsonText(run), columns.updatedAt,
        columns.runId, columns.tenantId, columns.workspaceId,
        expectedRunHash.startsWith("sha256:") ? expectedRunHash.slice("sha256:".length) : expectedRunHash,
      ));
    },
    async insertAccount(record) {
      uuid(record.accountId); uuid(record.tenantId); uuid(record.workspaceId);
      const inserted = await db.prepare(
        `INSERT INTO public.canonical_accounts
          (account_id, tenant_id, workspace_id, version, status, redirect_to_account_id,
           display_name, profile, profile_sha256, exact_keys, observation_refs, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?::jsonb, ?, ?::jsonb, ?::jsonb, ?, ?)
          ON CONFLICT (account_id) DO NOTHING RETURNING account_id`,
      ).all(
        record.accountId, record.tenantId, record.workspaceId, record.version, record.status,
        record.redirectToAccountId, record.displayName, jsonText(record.profile),
        record.profileSha256, jsonText(record.exactKeys), jsonText(record.observationRefs),
        timestamp(record.createdAt), timestamp(record.updatedAt),
      );
      if (!Array.isArray(inserted) || isProxy(inserted)) fail();
      return inserted.length === 1 ? "created" : "replayed";
    },
    async getAccount(tenantId, workspaceId, accountId) {
      const found = await db.prepare(
        `SELECT account_id, tenant_id, workspace_id, version, status, redirect_to_account_id,
          display_name, profile, profile_sha256, exact_keys, observation_refs, created_at, updated_at
          FROM public.canonical_accounts
          WHERE tenant_id = ? AND workspace_id = ? AND account_id = ?`,
      ).get(tenantId, workspaceId, accountId);
      if (found === undefined) return null;
      return parseAccountRow(found);
    },
    async listAccounts(tenantId, workspaceId) {
      const rows = await db.prepare(
        `SELECT account_id, tenant_id, workspace_id, version, status, redirect_to_account_id,
          display_name, profile, profile_sha256, exact_keys, observation_refs, created_at, updated_at
          FROM public.canonical_accounts
          WHERE tenant_id = ? AND workspace_id = ?
          ORDER BY updated_at DESC, account_id`,
      ).all(tenantId, workspaceId);
      if (!Array.isArray(rows) || isProxy(rows)) fail();
      return Object.freeze(rows.map((entry) => parseAccountRow(entry)));
    },
    async updateAccountProjection(record) {
      uuid(record.accountId); uuid(record.tenantId); uuid(record.workspaceId);
      expectChanges(await db.prepare(
        `UPDATE public.canonical_accounts
          SET version = ?, status = ?, redirect_to_account_id = ?, display_name = ?,
            profile = ?::jsonb, profile_sha256 = ?, exact_keys = ?::jsonb,
            observation_refs = ?::jsonb, updated_at = ?
          WHERE account_id = ? AND tenant_id = ? AND workspace_id = ? AND version = ?`,
      ).run(
        record.version, record.status, record.redirectToAccountId, record.displayName,
        jsonText(record.profile), record.profileSha256, jsonText(record.exactKeys),
        jsonText(record.observationRefs), timestamp(record.updatedAt),
        record.accountId, record.tenantId, record.workspaceId, record.expectedVersion,
      ));
    },
    async insertObservationBinding(record) {
      refValue(record.observationId);
      uuid(record.tenantId); uuid(record.workspaceId); uuid(record.accountId);
      refValue(record.sourceKey); refValue(record.namespace); refValue(record.externalId);
      sha(record.payloadSha256); sha(record.provenanceSha256);
      if (record.resolutionId !== null && !RESOLUTION_ID.test(record.resolutionId)) fail();
      if (record.discoveryRunId !== null && !RUN_ID.test(record.discoveryRunId)) fail();
      if (record.sourceObservationId !== null) refValue(record.sourceObservationId);
      const inserted = await db.prepare(
        `INSERT INTO public.account_source_observations
          (observation_id, tenant_id, workspace_id, account_id, source_key, namespace,
           external_id, observed_at, payload_sha256, provenance_sha256, resolution_id,
           discovery_run_id, source_observation_id)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT (observation_id) DO NOTHING RETURNING observation_id`,
      ).all(
        record.observationId, record.tenantId, record.workspaceId, record.accountId,
        record.sourceKey, record.namespace, record.externalId, timestamp(record.observedAt),
        record.payloadSha256, record.provenanceSha256, record.resolutionId,
        record.discoveryRunId, record.sourceObservationId,
      );
      if (!Array.isArray(inserted) || isProxy(inserted)) fail();
      return inserted.length === 1 ? "created" : "replayed";
    },
    async listAccountObservations(tenantId, workspaceId, accountId) {
      const rows = await db.prepare(
        `SELECT observation_id, tenant_id, workspace_id, account_id, source_key, namespace,
          external_id, observed_at, payload_sha256, provenance_sha256, resolution_id,
          discovery_run_id, source_observation_id, created_at
          FROM public.account_source_observations
          WHERE tenant_id = ? AND workspace_id = ? AND account_id = ?
          ORDER BY observed_at DESC, observation_id`,
      ).all(tenantId, workspaceId, accountId);
      if (!Array.isArray(rows) || isProxy(rows)) fail();
      return Object.freeze(rows.map((entry) => parseObservationRow(entry)));
    },
    async listScopedObservations(tenantId, workspaceId) {
      const rows = await db.prepare(
        `SELECT observation_id, tenant_id, workspace_id, account_id, source_key, namespace,
          external_id, observed_at, payload_sha256, provenance_sha256, resolution_id,
          discovery_run_id, source_observation_id, created_at
          FROM public.account_source_observations
          WHERE tenant_id = ? AND workspace_id = ?
          ORDER BY observed_at DESC, observation_id LIMIT 500`,
      ).all(tenantId, workspaceId);
      if (!Array.isArray(rows) || isProxy(rows)) fail();
      return Object.freeze(rows.map((entry) => parseObservationRow(entry)));
    },
    async insertResolution(record) {
      if (typeof record.resolutionId !== "string" || !RESOLUTION_ID.test(record.resolutionId)) fail();
      uuid(record.tenantId); uuid(record.workspaceId);
      if (!RESOLUTION_STATES.has(record.state)) fail();
      if (typeof record.ruleId !== "string" || !RESOLUTION_RULES.has(record.ruleId)) fail();
      if (record.targetAccountId !== null) uuid(record.targetAccountId);
      sha(record.resolutionSha256);
      timestamp(record.createdAt);
      const inserted = await db.prepare(
        `INSERT INTO public.account_resolutions
          (resolution_id, tenant_id, workspace_id, state, rule_id, target_account_id,
           canonical_candidate_id, candidate_account_ids, observations, resolution_sha256, created_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?::jsonb, ?::jsonb, ?, ?)
          ON CONFLICT (resolution_id) DO NOTHING RETURNING resolution_id`,
      ).all(
        record.resolutionId, record.tenantId, record.workspaceId, record.state, record.ruleId,
        record.targetAccountId, record.canonicalCandidateId, jsonText(record.candidateAccountIds),
        jsonText(record.observations), record.resolutionSha256, timestamp(record.createdAt),
      );
      if (!Array.isArray(inserted) || isProxy(inserted)) fail();
      return inserted.length === 1 ? "created" : "replayed";
    },
    async listResolutions(tenantId, workspaceId) {
      const rows = await db.prepare(
        `SELECT resolution_id, tenant_id, workspace_id, state, rule_id, target_account_id,
          canonical_candidate_id, candidate_account_ids, observations, resolution_sha256, created_at
          FROM public.account_resolutions
          WHERE tenant_id = ? AND workspace_id = ?
          ORDER BY created_at DESC, resolution_id`,
      ).all(tenantId, workspaceId);
      if (!Array.isArray(rows) || isProxy(rows)) fail();
      return Object.freeze(rows.map((entry) => parseResolutionRow(entry)));
    },
    async getMergeSnapshot(tenantId, workspaceId) {
      const found = await db.prepare(
        `SELECT tenant_id, workspace_id, members, state_sha256, updated_at
          FROM public.account_merge_snapshots WHERE tenant_id = ? AND workspace_id = ?`,
      ).get(tenantId, workspaceId);
      if (found === undefined) return null;
      return parseMergeSnapshotRow(found);
    },
    async upsertMergeSnapshot(record, expectedStateSha256) {
      uuid(record.tenantId); uuid(record.workspaceId);
      sha(record.stateSha256); timestamp(record.updatedAt);
      if (expectedStateSha256 === null) {
        const inserted = await db.prepare(
          `INSERT INTO public.account_merge_snapshots
            (tenant_id, workspace_id, members, state_sha256, updated_at)
            VALUES (?, ?, ?::jsonb, ?, ?)
            ON CONFLICT (tenant_id, workspace_id) DO NOTHING RETURNING tenant_id`,
        ).all(record.tenantId, record.workspaceId, jsonText(record.members),
          record.stateSha256, record.updatedAt);
        if (!Array.isArray(inserted) || isProxy(inserted)) fail();
        if (inserted.length !== 1) fail();
        return;
      }
      sha(expectedStateSha256);
      expectChanges(await db.prepare(
        `UPDATE public.account_merge_snapshots
          SET members = ?::jsonb, state_sha256 = ?, updated_at = ?
          WHERE tenant_id = ? AND workspace_id = ? AND state_sha256 = ?`,
      ).run(jsonText(record.members), record.stateSha256, record.updatedAt,
        record.tenantId, record.workspaceId, expectedStateSha256));
    },
    async insertMergeEvent(event) {
      if (typeof event.eventId !== "string" || !MERGE_EVENT_ID.test(event.eventId)) fail();
      uuid(event.tenantId); uuid(event.workspaceId);
      uuid(event.survivorAccountId); uuid(event.retiredAccountId);
      if (event.action !== "merge" && event.action !== "unmerge") fail();
      timestamp(event.at);
      const inserted = await db.prepare(
        `INSERT INTO public.account_merge_events
          (event_id, tenant_id, workspace_id, action, survivor_account_id, retired_account_id,
           evidence_observation_ids, actor, at, reason)
          VALUES (?, ?, ?, ?, ?, ?, ?::jsonb, ?::jsonb, ?, ?)
          ON CONFLICT (event_id) DO NOTHING RETURNING event_id`,
      ).all(
        event.eventId, event.tenantId, event.workspaceId, event.action, event.survivorAccountId,
        event.retiredAccountId, jsonText(event.evidenceObservationIds), jsonText(event.actor),
        event.at, event.reason,
      );
      if (!Array.isArray(inserted) || isProxy(inserted)) fail();
      return inserted.length === 1 ? "created" : "replayed";
    },
    async listMergeEvents(tenantId, workspaceId) {
      const rows = await db.prepare(
        `SELECT event_id, tenant_id, workspace_id, action, survivor_account_id, retired_account_id,
          evidence_observation_ids, actor, at, reason
          FROM public.account_merge_events
          WHERE tenant_id = ? AND workspace_id = ?
          ORDER BY at, event_id`,
      ).all(tenantId, workspaceId);
      if (!Array.isArray(rows) || isProxy(rows)) fail();
      return Object.freeze(rows.map((entry) => parseMergeEventRow(entry)));
    },
  };
  return Object.freeze(repository);
}
