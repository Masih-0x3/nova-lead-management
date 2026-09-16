import { createHash, randomUUID } from "node:crypto";
import { isProxy } from "node:util/types";

import {
  createAccountMergeSnapshot,
  resolveAccountObservations,
  transitionAccountMerge,
  type AccountMergeEvent,
  type AccountMergeMember,
  type AccountMergeSnapshot,
  type AccountResolution,
  type AccountResolutionFailureCode,
} from "./account-resolution";
import type {
  AccountObservationRow,
  AccountRepository,
  AccountResolutionRow,
  CanonicalAccountRow,
} from "./repository";

export type AccountServiceErrorCode =
  | "ACCOUNT_INPUT_INVALID"
  | "ACCOUNT_NOT_FOUND"
  | "ACCOUNT_STALE"
  | "ACCOUNT_CONFLICT"
  | "ACCOUNT_REVIEW_REQUIRED"
  | `RESOLUTION_${AccountResolutionFailureCode}`;

export class AccountServiceError extends Error {
  readonly code: AccountServiceErrorCode;

  constructor(code: AccountServiceErrorCode, message: string) {
    super(message);
    this.name = "AccountServiceError";
    this.code = code;
  }
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const REF = /^[A-Za-z0-9][A-Za-z0-9:._@/-]{0,299}$/u;
const HASH = /^sha256:[0-9a-f]{64}$/u;

type PlainRecord = Record<string, unknown>;

function isPlainRecord(value: unknown): value is PlainRecord {
  if (!value || typeof value !== "object" || Array.isArray(value) || isProxy(value)) return false;
  try {
    const prototype = Object.getPrototypeOf(value);
    return prototype === Object.prototype || prototype === null;
  } catch {
    return false;
  }
}

function invalid(message: string): AccountServiceError {
  return new AccountServiceError("ACCOUNT_INPUT_INVALID", message);
}

function uuid(value: unknown, field: string): string {
  if (typeof value !== "string" || !UUID.test(value)) throw invalid(`${field} must be a UUID`);
  return value;
}

function refValue(value: unknown, field: string): string {
  if (typeof value !== "string" || !REF.test(value)) throw invalid(`${field} is malformed`);
  return value;
}

function sha256Doc(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value), "utf8").digest("hex");
}

function nowIso(clock: (() => Date) | undefined): string {
  const observed = clock ? clock() : new Date();
  if (!(observed instanceof Date) || !Number.isFinite(observed.getTime())) {
    throw invalid("A valid clock is required");
  }
  return observed.toISOString();
}

function resolutionFailure(code: AccountResolutionFailureCode): AccountServiceError {
  return new AccountServiceError(`RESOLUTION_${code}`, `The account operation was rejected (${code}).`);
}

export interface AccountAuditSink {
  record(event: Readonly<{
    action: string;
    entityType: string;
    entityId: string;
    metadata: Readonly<Record<string, unknown>>;
  }>): Promise<void>;
}

export interface ReviewEnqueuePort {
  enqueueResolutionReview(input: Readonly<{
    tenantId: string;
    workspaceId: string;
    resolutionId: string;
    resolutionHash: string;
    reason: string;
    at: string;
  }>): Promise<void>;
}

export interface AccountServiceDeps {
  readonly repository: AccountRepository;
  readonly audit?: AccountAuditSink;
  readonly reviewQueue?: ReviewEnqueuePort;
  readonly clock?: () => Date;
}

function memberOf(account: CanonicalAccountRow): AccountMergeMember {
  return Object.freeze({
    accountId: account.accountId,
    version: account.version,
    status: account.status,
    redirectToAccountId: account.redirectToAccountId,
    observationRefs: account.observationRefs,
  });
}

function snapshotDoc(
  tenantId: string,
  workspaceId: string,
  members: readonly AccountMergeMember[],
  events: readonly AccountMergeEvent[],
): AccountMergeSnapshot {
  const payload = Object.freeze({
    mergeVersion: 1 as const, tenantId, workspaceId,
    members: Object.freeze([...members].sort((a, b) => a.accountId < b.accountId ? -1 : 1)),
    events: Object.freeze([...events]),
  });
  return Object.freeze({ ...payload, stateHash: `sha256:${sha256Doc(payload)}` });
}

function memberDoc(value: unknown): AccountMergeMember {
  const member = isPlainRecord(value) ? value : null;
  if (!member || typeof member.accountId !== "string"
    || typeof member.version !== "number" || !Number.isSafeInteger(member.version)
    || (member.status !== "active" && member.status !== "merged")
    || (member.redirectToAccountId !== null && typeof member.redirectToAccountId !== "string")
    || !Array.isArray(member.observationRefs)) {
    throw new AccountServiceError("ACCOUNT_CONFLICT", "The merge ledger member is malformed.");
  }
  return Object.freeze({
    accountId: member.accountId,
    version: member.version,
    status: member.status,
    redirectToAccountId: member.redirectToAccountId,
    observationRefs: Object.freeze(member.observationRefs.filter(
      (ref): ref is string => typeof ref === "string")),
  });
}

function eventDoc(event: {
  eventId: string; tenantId: string; workspaceId: string; action: string;
  survivorAccountId: string; retiredAccountId: string;
  evidenceObservationIds: readonly string[]; actor: Record<string, unknown>;
  at: string; reason: string;
}): AccountMergeEvent {
  const actor = event.actor;
  const actorId = actor.actorId;
  if (event.action !== "merge" && event.action !== "unmerge") {
    throw new AccountServiceError("ACCOUNT_CONFLICT", "The merge ledger contains an unknown action.");
  }
  return Object.freeze({
    tenantId: event.tenantId, workspaceId: event.workspaceId,
    action: event.action, survivorAccountId: event.survivorAccountId,
    retiredAccountId: event.retiredAccountId,
    evidenceObservationIds: Object.freeze([...event.evidenceObservationIds]),
    actor: Object.freeze({ kind: "human" as const,
      actorId: typeof actorId === "string" && UUID.test(actorId) ? actorId
        : (() => { throw new AccountServiceError("ACCOUNT_CONFLICT", "The merge ledger actor is malformed."); })() }),
    at: event.at, reason: event.reason,
    eventId: event.eventId,
  });
}

async function loadSnapshotDoc(
  repository: AccountRepository,
  tenantId: string,
  workspaceId: string,
): Promise<Readonly<{ snapshot: AccountMergeSnapshot; stateSha256: string }> | null> {
  const row = await repository.getMergeSnapshot(tenantId, workspaceId);
  if (!row) return null;
  const events = await repository.listMergeEvents(tenantId, workspaceId);
  const doc = snapshotDoc(
    tenantId, workspaceId,
    row.members.map((member) => memberDoc(member)),
    events.map((event) => eventDoc(event)),
  );
  if (doc.stateHash !== `sha256:${row.stateSha256}`) {
    throw new AccountServiceError("ACCOUNT_CONFLICT", "The merge ledger does not replay to its stored hash.");
  }
  return Object.freeze({ snapshot: doc, stateSha256: row.stateSha256 });
}

/**
 * Synchronizes one canonical account into the scope merge ledger. Members
 * always mirror the durable account rows; the ledger hash is recomputed and
 * written under optimistic concurrency on the previous hash.
 */
async function syncMergeMember(
  repository: AccountRepository,
  account: CanonicalAccountRow,
): Promise<void> {
  const existing = await loadSnapshotDoc(repository, account.tenantId, account.workspaceId);
  const member = memberOf(account);
  if (!existing) {
    const accounts = await repository.listAccounts(account.tenantId, account.workspaceId);
    if (accounts.length < 2) return;
    if (accounts.some((entry) => entry.status !== "active")) {
      throw new AccountServiceError("ACCOUNT_CONFLICT", "Merged accounts exist without a merge ledger.");
    }
    const created = createAccountMergeSnapshot({
      version: 1, tenantId: account.tenantId, workspaceId: account.workspaceId,
      members: accounts.map(memberOf),
    });
    if (!created.ok) throw resolutionFailure(created.code);
    await repository.upsertMergeSnapshot({
      tenantId: account.tenantId, workspaceId: account.workspaceId,
      members: created.snapshot.members,
      stateSha256: created.snapshot.stateHash.slice("sha256:".length),
      updatedAt: nowIso(undefined),
    }, null);
    return;
  }
  const members = existing.snapshot.members.filter((entry) => entry.accountId !== account.accountId);
  members.push(member);
  const next = snapshotDoc(account.tenantId, account.workspaceId, members,
    existing.snapshot.events);
  if (next.stateHash === existing.snapshot.stateHash) return;
  try {
    await repository.upsertMergeSnapshot({
      tenantId: account.tenantId, workspaceId: account.workspaceId,
      members: next.members,
      stateSha256: next.stateHash.slice("sha256:".length),
      updatedAt: nowIso(undefined),
    }, existing.stateSha256);
  } catch {
    throw new AccountServiceError("ACCOUNT_STALE", "The merge ledger changed concurrently.");
  }
}

export type RegisterCanonicalAccountInput = Readonly<{
  tenantId: string;
  workspaceId: string;
  displayName?: string | null;
  profile?: Record<string, unknown>;
  exactKeys?: readonly unknown[];
  observationRefs?: readonly string[];
}>;

export async function registerCanonicalAccount(
  deps: AccountServiceDeps,
  rawInput: unknown,
): Promise<Readonly<{ accountId: string; kind: "created" }>> {
  if (!isPlainRecord(rawInput)) throw invalid("Expected a plain object");
  const tenantId = uuid(rawInput.tenantId, "tenantId");
  const workspaceId = uuid(rawInput.workspaceId, "workspaceId");
  const displayName = rawInput.displayName === undefined || rawInput.displayName === null
    ? null : typeof rawInput.displayName === "string" && rawInput.displayName.trim().length >= 1
      && rawInput.displayName.length <= 300 ? rawInput.displayName : (() => { throw invalid("displayName is malformed"); })();
  const profile = rawInput.profile === undefined ? {} : isPlainRecord(rawInput.profile) ? rawInput.profile
    : (() => { throw invalid("profile must be an object"); })();
  const exactKeys = rawInput.exactKeys === undefined ? [] : Array.isArray(rawInput.exactKeys)
    ? rawInput.exactKeys : (() => { throw invalid("exactKeys must be an array"); })();
  const observationRefs = rawInput.observationRefs === undefined ? [] : Array.isArray(rawInput.observationRefs)
    ? rawInput.observationRefs.map((item) => refValue(item, "observationRefs[]"))
    : (() => { throw invalid("observationRefs must be an array"); })();

  const at = nowIso(deps.clock);
  const accountId = randomUUID();
  const profileSha256 = sha256Doc(profile);
  await deps.repository.insertAccount({
    accountId, tenantId, workspaceId, version: 1, status: "active",
    redirectToAccountId: null, displayName, profile, profileSha256,
    exactKeys: Object.freeze([...exactKeys]), observationRefs: Object.freeze([...observationRefs]),
    createdAt: at, updatedAt: at,
  });
  const row = await deps.repository.getAccount(tenantId, workspaceId, accountId);
  if (!row) throw new AccountServiceError("ACCOUNT_CONFLICT", "The account could not be read back.");
  await syncMergeMember(deps.repository, row);
  await deps.audit?.record({
    action: "account.canonical.registered",
    entityType: "canonical_account",
    entityId: accountId,
    metadata: { source: "manual" },
  });
  return Object.freeze({ accountId, kind: "created" });
}

export type ResolveObservationsInput = Readonly<{
  tenantId: string;
  workspaceId: string;
  observations: readonly unknown[];
  bindings?: Readonly<Record<string, Readonly<{
    discoveryRunId?: string | null;
    sourceObservationId?: string | null;
  }>>>;
}>;

export type ResolveObservationsResult = Readonly<{
  resolution: AccountResolution;
  applied: "auto_resolved" | "canonical_candidate" | "human_review";
  accountId: string | null;
}>;

/**
 * Resolves source observations to canonical accounts. Candidate accounts are
 * always loaded from the durable store — caller-supplied candidate sets are
 * never trusted. Outcomes: auto_resolved binds to the matched account,
 * canonical_candidate materializes a new canonical account, human_review
 * leaves the resolution receipt for the review queue.
 */
export async function resolveAccountObservationsService(
  deps: AccountServiceDeps,
  rawInput: unknown,
): Promise<ResolveObservationsResult> {
  if (!isPlainRecord(rawInput)) throw invalid("Expected a plain object");
  const tenantId = uuid(rawInput.tenantId, "tenantId");
  const workspaceId = uuid(rawInput.workspaceId, "workspaceId");
  if (!Array.isArray(rawInput.observations) || rawInput.observations.length === 0
    || rawInput.observations.length > 64) throw invalid("observations must be a non-empty array");
  const bindings = rawInput.bindings === undefined ? {} : isPlainRecord(rawInput.bindings)
    ? rawInput.bindings : (() => { throw invalid("bindings must be an object"); })();

  const candidates = (await deps.repository.listAccounts(tenantId, workspaceId)).map((account) =>
    Object.freeze({
      accountId: account.accountId,
      tenantId: account.tenantId,
      workspaceId: account.workspaceId,
      version: account.version,
      status: account.status,
      exactKeys: account.exactKeys,
      observationRefs: account.observationRefs,
    }));

  const resolved = resolveAccountObservations({
    version: 1, tenantId, workspaceId, observations: rawInput.observations, candidates,
  });
  if (!resolved.ok) throw resolutionFailure(resolved.code);
  const resolution = resolved.resolution;

  const persisted = await deps.repository.insertResolution({
    resolutionId: resolution.resolutionId,
    tenantId, workspaceId,
    state: resolution.state,
    ruleId: resolution.ruleId,
    targetAccountId: typeof resolution.targetAccountId === "string" && UUID.test(resolution.targetAccountId)
      ? resolution.targetAccountId : null,
    canonicalCandidateId: resolution.canonicalCandidateId,
    candidateAccountIds: resolution.candidateAccountIds.filter(
      (id): id is string => typeof id === "string" && UUID.test(id)),
    observations: resolution.observations,
    resolutionSha256: resolution.resolutionHash.slice("sha256:".length),
    createdAt: nowIso(deps.clock),
  });
  void persisted;

  const bindObservations = async (accountId: string) => {
    for (const observation of resolution.observations) {
      const rawLink: unknown = bindings[observation.observationId];
      const link: PlainRecord = isPlainRecord(rawLink) ? rawLink : {};
      const discoveryRunId = typeof link.discoveryRunId === "string" && UUID.test(link.discoveryRunId)
        ? link.discoveryRunId : null;
      const sourceObservationId = typeof link.sourceObservationId === "string"
        && REF.test(link.sourceObservationId) ? link.sourceObservationId : null;
      await deps.repository.insertObservationBinding({
        observationId: observation.observationId,
        tenantId, workspaceId, accountId,
        sourceKey: observation.sourceKey, namespace: observation.namespace,
        externalId: observation.externalId, observedAt: observation.observedAt,
        payloadSha256: observation.payloadHash.slice("sha256:".length),
        provenanceSha256: observation.provenanceHash.slice("sha256:".length),
        resolutionId: resolution.resolutionId,
        discoveryRunId,
        sourceObservationId,
      });
    }
  };

  if (resolution.state === "auto_resolved" && resolution.targetAccountId) {
    const account = await deps.repository.getAccount(tenantId, workspaceId, resolution.targetAccountId);
    if (!account) throw new AccountServiceError("ACCOUNT_NOT_FOUND", "The resolved account was not found.");
    await bindObservations(account.accountId);
    const mergedRefs = [...new Set([...account.observationRefs,
      ...resolution.observations.map((item) => item.observationId)])].sort();
    const newKeys = resolution.observations.map((item) => Object.freeze({
      sourceKey: item.sourceKey, namespace: item.namespace, externalId: item.externalId,
    }));
    const mergedKeys = [...account.exactKeys];
    for (const key of newKeys) {
      const keyId = `${key.sourceKey}${key.namespace}${key.externalId}`;
      const exists = mergedKeys.some((existing) => isPlainRecord(existing)
        && `${existing.sourceKey}${existing.namespace}${existing.externalId}` === keyId);
      if (!exists) mergedKeys.push(key);
    }
    await deps.repository.updateAccountProjection({
      accountId: account.accountId, tenantId, workspaceId, expectedVersion: account.version,
      version: account.version + 1, status: account.status,
      redirectToAccountId: account.redirectToAccountId, displayName: account.displayName,
      profile: account.profile, profileSha256: account.profileSha256,
      exactKeys: Object.freeze(mergedKeys), observationRefs: Object.freeze(mergedRefs),
      updatedAt: nowIso(deps.clock),
    });
    const updated = await deps.repository.getAccount(tenantId, workspaceId, account.accountId);
    if (updated) await syncMergeMember(deps.repository, updated);
    await deps.audit?.record({
      action: "account.observations.bound",
      entityType: "canonical_account",
      entityId: account.accountId,
      metadata: { resolutionId: resolution.resolutionId, state: resolution.state },
    });
    return Object.freeze({ resolution, applied: "auto_resolved", accountId: account.accountId });
  }

  if (resolution.state === "canonical_candidate") {
    const at = nowIso(deps.clock);
    const accountId = randomUUID();
    const keys = resolution.observations.map((item) => Object.freeze({
      sourceKey: item.sourceKey, namespace: item.namespace, externalId: item.externalId,
    }));
    await deps.repository.insertAccount({
      accountId, tenantId, workspaceId, version: 1, status: "active",
      redirectToAccountId: null, displayName: null,
      profile: Object.freeze({ promotedFrom: resolution.canonicalCandidateId }),
      profileSha256: sha256Doc({ promotedFrom: resolution.canonicalCandidateId }),
      exactKeys: Object.freeze(keys),
      observationRefs: Object.freeze(resolution.observations.map((item) => item.observationId).sort()),
      createdAt: at, updatedAt: at,
    });
    await bindObservations(accountId);
    const row = await deps.repository.getAccount(tenantId, workspaceId, accountId);
    if (row) await syncMergeMember(deps.repository, row);
    await deps.audit?.record({
      action: "account.canonical.promoted",
      entityType: "canonical_account",
      entityId: accountId,
      metadata: { resolutionId: resolution.resolutionId, candidateId: resolution.canonicalCandidateId },
    });
    return Object.freeze({ resolution, applied: "canonical_candidate", accountId });
  }

  await deps.reviewQueue?.enqueueResolutionReview({
    tenantId, workspaceId,
    resolutionId: resolution.resolutionId,
    resolutionHash: resolution.resolutionHash,
    reason: resolution.ruleId,
    at: nowIso(deps.clock),
  });
  await deps.audit?.record({
    action: "account.resolution.queued",
    entityType: "account_resolution",
    entityId: resolution.resolutionId,
    metadata: { state: resolution.state, ruleId: resolution.ruleId },
  });
  return Object.freeze({ resolution, applied: "human_review", accountId: null });
}

export type MergeTransitionInput = Readonly<{
  tenantId: string;
  workspaceId: string;
  action: "merge" | "unmerge";
  survivorAccountId: string;
  retiredAccountId: string;
  evidenceObservationIds: readonly string[];
  actorId: string;
  expectedStateHash: string;
  at?: string;
  reason: string;
}>;

/** Applies a human merge/unmerge with reversible ledger + account redirects. */
export async function applyAccountMergeTransition(
  deps: AccountServiceDeps,
  rawInput: unknown,
): Promise<Readonly<{ snapshot: AccountMergeSnapshot; eventId: string }>> {
  if (!isPlainRecord(rawInput)) throw invalid("Expected a plain object");
  const tenantId = uuid(rawInput.tenantId, "tenantId");
  const workspaceId = uuid(rawInput.workspaceId, "workspaceId");
  const survivorAccountId = uuid(rawInput.survivorAccountId, "survivorAccountId");
  const retiredAccountId = uuid(rawInput.retiredAccountId, "retiredAccountId");
  const actorId = uuid(rawInput.actorId, "actorId");
  const expectedStateHash = typeof rawInput.expectedStateHash === "string" && HASH.test(rawInput.expectedStateHash)
    ? rawInput.expectedStateHash : (() => { throw invalid("expectedStateHash is malformed"); })();
  const action = rawInput.action === "merge" || rawInput.action === "unmerge" ? rawInput.action
    : (() => { throw invalid("action must be merge or unmerge"); })();
  if (!Array.isArray(rawInput.evidenceObservationIds) || rawInput.evidenceObservationIds.length === 0) {
    throw invalid("evidenceObservationIds must be a non-empty array");
  }
  const at = rawInput.at === undefined ? nowIso(deps.clock) : rawInput.at;
  if (typeof at !== "string") throw invalid("at is malformed");
  if (typeof rawInput.reason !== "string" || rawInput.reason.length < 1) throw invalid("reason is required");

  const existing = await loadSnapshotDoc(deps.repository, tenantId, workspaceId);
  if (!existing) {
    const accounts = await deps.repository.listAccounts(tenantId, workspaceId);
    if (accounts.some((entry) => entry.status !== "active") || accounts.length < 2) {
      throw new AccountServiceError("ACCOUNT_CONFLICT", "The merge ledger cannot be initialized safely.");
    }
    const created = createAccountMergeSnapshot({
      version: 1, tenantId, workspaceId, members: accounts.map(memberOf),
    });
    if (!created.ok) throw resolutionFailure(created.code);
    await deps.repository.upsertMergeSnapshot({
      tenantId, workspaceId, members: created.snapshot.members,
      stateSha256: created.snapshot.stateHash.slice("sha256:".length),
      updatedAt: nowIso(deps.clock),
    }, null);
    if (created.snapshot.stateHash !== expectedStateHash) {
      throw new AccountServiceError("ACCOUNT_STALE", "The merge ledger was just initialized; retry with the new hash.");
    }
    return applyAccountMergeTransition(deps, rawInput);
  }

  const transitioned = transitionAccountMerge({
    version: 1, tenantId, workspaceId, current: existing.snapshot, expectedStateHash,
    action, survivorAccountId, retiredAccountId,
    evidenceObservationIds: rawInput.evidenceObservationIds,
    actor: Object.freeze({ kind: "human" as const, actorId }),
    at, reason: rawInput.reason,
  });
  if (!transitioned.ok) throw resolutionFailure(transitioned.code);
  const next = transitioned.snapshot;

  try {
    await deps.repository.upsertMergeSnapshot({
      tenantId, workspaceId, members: next.members,
      stateSha256: next.stateHash.slice("sha256:".length),
      updatedAt: at,
    }, existing.stateSha256);
  } catch {
    throw new AccountServiceError("ACCOUNT_STALE", "The merge ledger changed concurrently.");
  }

  const event = next.events[next.events.length - 1];
  if (!event) throw new AccountServiceError("ACCOUNT_CONFLICT", "The merge transition produced no event.");
  await deps.repository.insertMergeEvent({
    eventId: event.eventId, tenantId, workspaceId, action: event.action,
    survivorAccountId: event.survivorAccountId, retiredAccountId: event.retiredAccountId,
    evidenceObservationIds: event.evidenceObservationIds,
    actor: event.actor, at: event.at, reason: event.reason,
  });

  for (const member of [survivorAccountId, retiredAccountId]) {
    const nextMember = next.members.find((entry) => entry.accountId === member);
    const account = await deps.repository.getAccount(tenantId, workspaceId, member);
    if (!nextMember || !account) {
      throw new AccountServiceError("ACCOUNT_NOT_FOUND", "A merge member is missing.");
    }
    await deps.repository.updateAccountProjection({
      accountId: member, tenantId, workspaceId, expectedVersion: account.version,
      version: nextMember.version, status: nextMember.status,
      redirectToAccountId: nextMember.redirectToAccountId, displayName: account.displayName,
      profile: account.profile, profileSha256: account.profileSha256,
      exactKeys: account.exactKeys, observationRefs: nextMember.observationRefs,
      updatedAt: at,
    });
  }
  await deps.audit?.record({
    action: `account.${action}.applied`,
    entityType: "canonical_account",
    entityId: retiredAccountId,
    metadata: { survivorAccountId, eventId: event.eventId },
  });
  return Object.freeze({ snapshot: next, eventId: event.eventId });
}

/* ---------- query projections for the L-07 panels ---------- */

export type AccountPortfolioView = Readonly<{
  accountId: string;
  displayName: string | null;
  status: "active" | "merged";
  redirectToAccountId: string | null;
  version: number;
  observationCount: number;
  updatedAt: string;
  freshness: "current" | "stale" | "unknown";
}>;

export type ResolutionView = Readonly<{
  resolutionId: string;
  state: AccountResolutionRow["state"];
  ruleId: string;
  targetAccountId: string | null;
  canonicalCandidateId: string | null;
  candidateAccountIds: readonly string[];
  observationCount: number;
  createdAt: string;
}>;

export type MergeHistoryView = Readonly<{
  eventId: string;
  action: "merge" | "unmerge";
  survivorAccountId: string;
  retiredAccountId: string;
  actorId: string | null;
  at: string;
  reason: string;
}>;

function freshnessOf(observations: readonly AccountObservationRow[], now: string, staleDays = 90)
  : "current" | "stale" | "unknown" {
  if (observations.length === 0) return "unknown";
  const latest = observations.reduce((max, item) =>
    Date.parse(item.observedAt) > Date.parse(max) ? item.observedAt : max, observations[0].observedAt);
  const ageMs = Date.parse(now) - Date.parse(latest);
  return ageMs <= staleDays * 24 * 60 * 60 * 1_000 ? "current" : "stale";
}

export async function listAccountPortfolio(
  repository: AccountRepository,
  scope: Readonly<{ tenantId: string; workspaceId: string }>,
  options: Readonly<{ staleDays?: number; now?: string }> = {},
): Promise<readonly AccountPortfolioView[]> {
  const tenantId = uuid(scope.tenantId, "tenantId");
  const workspaceId = uuid(scope.workspaceId, "workspaceId");
  const accounts = await repository.listAccounts(tenantId, workspaceId);
  const observations = await repository.listScopedObservations(tenantId, workspaceId);
  const byAccount = new Map<string, AccountObservationRow[]>();
  for (const observation of observations) {
    const list = byAccount.get(observation.accountId) ?? [];
    list.push(observation);
    byAccount.set(observation.accountId, list);
  }
  const now = options.now ?? nowIso(undefined);
  return Object.freeze(accounts.map((account): AccountPortfolioView => {
    const accountObservations = byAccount.get(account.accountId) ?? [];
    return Object.freeze({
      accountId: account.accountId,
      displayName: account.displayName,
      status: account.status,
      redirectToAccountId: account.redirectToAccountId,
      version: account.version,
      observationCount: account.observationRefs.length,
      updatedAt: account.updatedAt,
      freshness: freshnessOf(accountObservations, now, options.staleDays),
    });
  }));
}

export async function listAccountResolutionViews(
  repository: AccountRepository,
  scope: Readonly<{ tenantId: string; workspaceId: string }>,
): Promise<readonly ResolutionView[]> {
  const rows = await repository.listResolutions(uuid(scope.tenantId, "tenantId"), uuid(scope.workspaceId, "workspaceId"));
  return Object.freeze(rows.map((row): ResolutionView => Object.freeze({
    resolutionId: row.resolutionId,
    state: row.state,
    ruleId: row.ruleId,
    targetAccountId: row.targetAccountId,
    canonicalCandidateId: row.canonicalCandidateId,
    candidateAccountIds: row.candidateAccountIds,
    observationCount: row.observations.length,
    createdAt: row.createdAt,
  })));
}

export async function listMergeHistory(
  repository: AccountRepository,
  scope: Readonly<{ tenantId: string; workspaceId: string }>,
): Promise<readonly MergeHistoryView[]> {
  const rows = await repository.listMergeEvents(uuid(scope.tenantId, "tenantId"), uuid(scope.workspaceId, "workspaceId"));
  return Object.freeze(rows.map((row): MergeHistoryView => Object.freeze({
    eventId: row.eventId,
    action: row.action,
    survivorAccountId: row.survivorAccountId,
    retiredAccountId: row.retiredAccountId,
    actorId: typeof row.actor.actorId === "string" ? row.actor.actorId : null,
    at: row.at,
    reason: row.reason,
  })));
}
