import { isProxy } from "node:util/types";

import {
  buildBuyingCenter,
  transitionBuyingCenterReview,
  type BuyingCenter,
  type BuyingCenterFailureCode,
} from "./buying-center";
import {
  buildContactRecord,
  transitionContactRecordReview,
  type ContactRecord,
} from "./contact-record";
import type { BuyingCenterRow, ContactRepository, ContactVersionRow } from "./repository";

export type ContactServiceErrorCode =
  | "CONTACT_INPUT_INVALID"
  | "CONTACT_NOT_FOUND"
  | "CONTACT_STALE"
  | "CONTACT_CONFLICT"
  | `CONTACT_${BuyingCenterFailureCode}`;

export class ContactServiceError extends Error {
  readonly code: ContactServiceErrorCode;

  constructor(code: ContactServiceErrorCode, message: string) {
    super(message);
    this.name = "ContactServiceError";
    this.code = code;
  }
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const HASH = /^sha256:[0-9a-f]{64}$/u;
const CONTACT_VERSION = /^contact-version:[0-9a-f]{64}$/u;
const CENTER_VERSION = /^buying-center-version:[0-9a-f]{64}$/u;

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

function invalid(message: string): ContactServiceError {
  return new ContactServiceError("CONTACT_INPUT_INVALID", message);
}

function uuid(value: unknown, field: string): string {
  if (typeof value !== "string" || !UUID.test(value)) throw invalid(`${field} must be a UUID`);
  return value;
}

function nowIso(clock: (() => Date) | undefined): string {
  const observed = clock ? clock() : new Date();
  if (!(observed instanceof Date) || !Number.isFinite(observed.getTime())) {
    throw invalid("A valid clock is required");
  }
  return observed.toISOString();
}

function engineFailure(code: string): ContactServiceError {
  if (code === "STALE_VERSION") {
    return new ContactServiceError("CONTACT_STALE", "The record changed concurrently; retry with the latest hash.");
  }
  return new ContactServiceError(
    `CONTACT_${code}` as ContactServiceErrorCode,
    `The contact operation was rejected (${code}).`);
}

export interface ContactAuditSink {
  record(event: Readonly<{
    action: string;
    entityType: string;
    entityId: string;
    metadata: Readonly<Record<string, unknown>>;
  }>): Promise<void>;
}

export interface ContactServiceDeps {
  readonly repository: ContactRepository;
  readonly audit?: ContactAuditSink;
  readonly clock?: () => Date;
}

export type RegisterContactInput = Readonly<{
  tenantId: string;
  workspaceId: string;
  accountId: string;
  stableKey: string;
  identity: Record<string, unknown>;
  sourceReceipt: Record<string, unknown>;
  roleHypothesis: Record<string, unknown> | null;
  freshness: Record<string, unknown>;
  permittedUse: Record<string, unknown>;
  suppressionDisposition: string;
  createdAt?: string;
}>;

/** Creates a v1 contact record (draft review) and persists the version row. */
export async function registerContactRecord(
  deps: ContactServiceDeps,
  rawInput: unknown,
): Promise<Readonly<{ record: ContactRecord; persisted: "created" | "replayed" }>> {
  if (!isPlainRecord(rawInput)) throw invalid("Expected a plain object");
  const tenantId = uuid(rawInput.tenantId, "tenantId");
  const workspaceId = uuid(rawInput.workspaceId, "workspaceId");
  const accountId = uuid(rawInput.accountId, "accountId");
  const built = buildContactRecord({
    version: 1, tenantId, workspaceId, accountId,
    stableKey: rawInput.stableKey,
    revision: 1,
    createdAt: rawInput.createdAt ?? nowIso(deps.clock),
    identity: rawInput.identity,
    roleHypothesis: rawInput.roleHypothesis ?? null,
    sourceReceipt: rawInput.sourceReceipt,
    freshness: rawInput.freshness,
    permittedUse: rawInput.permittedUse,
    suppressionDisposition: rawInput.suppressionDisposition ?? "unknown",
    predecessor: null,
  });
  if (!built.ok) throw engineFailure(built.code);
  const persisted = await deps.repository.insertContact(built.record);
  await deps.audit?.record({
    action: "contact.record.registered",
    entityType: "contact_record",
    entityId: built.record.versionId,
    metadata: { stableKey: built.record.stableKey, revision: built.record.revision },
  });
  return Object.freeze({ record: built.record, persisted });
}

export type SupersedeContactInput = Readonly<{
  tenantId: string;
  workspaceId: string;
  accountId: string;
  predecessorVersionId: string;
  identity: Record<string, unknown>;
  sourceReceipt: Record<string, unknown>;
  roleHypothesis: Record<string, unknown> | null;
  freshness: Record<string, unknown>;
  permittedUse: Record<string, unknown>;
  suppressionDisposition: string;
  createdAt?: string;
}>;

/** Creates revision n+1 of a contact record, superseding an approved predecessor. */
export async function supersedeContactRecord(
  deps: ContactServiceDeps,
  rawInput: unknown,
): Promise<Readonly<{ record: ContactRecord; persisted: "created" | "replayed" }>> {
  if (!isPlainRecord(rawInput)) throw invalid("Expected a plain object");
  const tenantId = uuid(rawInput.tenantId, "tenantId");
  const workspaceId = uuid(rawInput.workspaceId, "workspaceId");
  const accountId = uuid(rawInput.accountId, "accountId");
  const predecessorVersionId = typeof rawInput.predecessorVersionId === "string"
    && CONTACT_VERSION.test(rawInput.predecessorVersionId) ? rawInput.predecessorVersionId
    : (() => { throw invalid("predecessorVersionId is malformed"); })();
  const predecessorRow = await deps.repository.getContact(tenantId, workspaceId, predecessorVersionId);
  if (!predecessorRow || predecessorRow.accountId !== accountId) {
    throw new ContactServiceError("CONTACT_NOT_FOUND", "The predecessor contact record was not found.");
  }
  const built = buildContactRecord({
    version: 1, tenantId, workspaceId, accountId,
    stableKey: predecessorRow.stableKey,
    revision: predecessorRow.revision + 1,
    createdAt: rawInput.createdAt ?? nowIso(deps.clock),
    identity: rawInput.identity,
    roleHypothesis: rawInput.roleHypothesis ?? null,
    sourceReceipt: rawInput.sourceReceipt,
    freshness: rawInput.freshness,
    permittedUse: rawInput.permittedUse,
    suppressionDisposition: rawInput.suppressionDisposition ?? "unknown",
    predecessor: {
      predecessorVersion: 1,
      stableKey: predecessorRow.stableKey,
      revision: predecessorRow.revision,
      supersedesVersionId: predecessorRow.supersedesVersionId,
      record: predecessorRow.payload,
    },
  });
  if (!built.ok) throw engineFailure(built.code);
  const persisted = await deps.repository.insertContact(built.record);
  await deps.audit?.record({
    action: "contact.record.superseded",
    entityType: "contact_record",
    entityId: built.record.versionId,
    metadata: { supersedesVersionId: predecessorVersionId, revision: built.record.revision },
  });
  return Object.freeze({ record: built.record, persisted });
}

export type ContactReviewInput = Readonly<{
  tenantId: string;
  workspaceId: string;
  accountId: string;
  versionId: string;
  expectedVersionId: string;
  expectedContentHash: string;
  expectedReviewHash: string;
  to: "in_review" | "approved" | "rejected";
  actorId: string;
  at?: string;
  reason: string;
}>;

/** Applies a human review transition to a contact record under expected hashes. */
export async function transitionContactReview(
  deps: ContactServiceDeps,
  rawInput: unknown,
): Promise<Readonly<{ record: ContactRecord }>> {
  if (!isPlainRecord(rawInput)) throw invalid("Expected a plain object");
  const tenantId = uuid(rawInput.tenantId, "tenantId");
  const workspaceId = uuid(rawInput.workspaceId, "workspaceId");
  const accountId = uuid(rawInput.accountId, "accountId");
  const actorId = uuid(rawInput.actorId, "actorId");
  const versionId = typeof rawInput.versionId === "string" && CONTACT_VERSION.test(rawInput.versionId)
    ? rawInput.versionId : (() => { throw invalid("versionId is malformed"); })();
  for (const field of ["expectedContentHash", "expectedReviewHash"] as const) {
    if (typeof rawInput[field] !== "string" || !HASH.test(rawInput[field])) {
      throw invalid(`${field} is malformed`);
    }
  }
  const row = await deps.repository.getContact(tenantId, workspaceId, versionId);
  if (!row || row.accountId !== accountId) {
    throw new ContactServiceError("CONTACT_NOT_FOUND", "The contact record was not found.");
  }
  const transitioned = transitionContactRecordReview({
    version: 1, tenantId, workspaceId, accountId,
    current: row.payload,
    expectedVersionId: rawInput.expectedVersionId,
    expectedContentHash: rawInput.expectedContentHash,
    expectedReviewHash: rawInput.expectedReviewHash,
    actor: { kind: "human", actorId },
    to: rawInput.to,
    at: rawInput.at ?? nowIso(deps.clock),
    reason: rawInput.reason,
  });
  if (!transitioned.ok) throw engineFailure(transitioned.code);
  try {
    await deps.repository.updateContactReview(
      row.reviewSha256, transitioned.record as Readonly<Record<string, unknown>>);
  } catch {
    throw new ContactServiceError("CONTACT_STALE", "The contact record changed concurrently.");
  }
  await deps.audit?.record({
    action: "contact.review.transitioned",
    entityType: "contact_record",
    entityId: versionId,
    metadata: { to: rawInput.to, actorId },
  });
  return Object.freeze({ record: transitioned.record });
}

export type RegisterBuyingCenterInput = Readonly<{
  tenantId: string;
  workspaceId: string;
  accountId: string;
  playVersionId: string;
  stableKey: string;
  hypotheses: readonly unknown[];
  createdAt?: string;
}>;

/** Creates a v1 buying-center hypothesis record (distinct from verified contacts). */
export async function registerBuyingCenter(
  deps: ContactServiceDeps,
  rawInput: unknown,
): Promise<Readonly<{ center: BuyingCenter; persisted: "created" | "replayed" }>> {
  if (!isPlainRecord(rawInput)) throw invalid("Expected a plain object");
  const tenantId = uuid(rawInput.tenantId, "tenantId");
  const workspaceId = uuid(rawInput.workspaceId, "workspaceId");
  const accountId = uuid(rawInput.accountId, "accountId");
  const playVersionId = typeof rawInput.playVersionId === "string"
    && /^lead-play-version:[0-9a-f]{64}$/u.test(rawInput.playVersionId) ? rawInput.playVersionId
    : (() => { throw invalid("playVersionId is malformed"); })();
  if (!Array.isArray(rawInput.hypotheses)) throw invalid("hypotheses must be an array");
  const built = buildBuyingCenter({
    version: 1, tenantId, workspaceId, accountId, playVersionId,
    stableKey: rawInput.stableKey,
    revision: 1,
    predecessor: null,
    createdAt: rawInput.createdAt ?? nowIso(deps.clock),
    hypotheses: rawInput.hypotheses,
  });
  if (!built.ok) throw engineFailure(built.code);
  const persisted = await deps.repository.insertCenter(built.center);
  await deps.audit?.record({
    action: "buying_center.registered",
    entityType: "buying_center",
    entityId: built.center.versionId,
    metadata: { stableKey: built.center.stableKey, revision: built.center.revision },
  });
  return Object.freeze({ center: built.center, persisted });
}

export type BuyingCenterReviewInput = Readonly<{
  tenantId: string;
  workspaceId: string;
  accountId: string;
  versionId: string;
  expectedVersionId: string;
  expectedContentHash: string;
  expectedReviewHash: string;
  to: "in_review" | "approved" | "rejected";
  actorId: string;
  at?: string;
  reason: string;
}>;

/** Applies a human review transition to a buying-center record. */
export async function transitionBuyingCenterReviewService(
  deps: ContactServiceDeps,
  rawInput: unknown,
): Promise<Readonly<{ center: BuyingCenter }>> {
  if (!isPlainRecord(rawInput)) throw invalid("Expected a plain object");
  const tenantId = uuid(rawInput.tenantId, "tenantId");
  const workspaceId = uuid(rawInput.workspaceId, "workspaceId");
  const accountId = uuid(rawInput.accountId, "accountId");
  const actorId = uuid(rawInput.actorId, "actorId");
  const versionId = typeof rawInput.versionId === "string" && CENTER_VERSION.test(rawInput.versionId)
    ? rawInput.versionId : (() => { throw invalid("versionId is malformed"); })();
  const row = await deps.repository.getCenter(tenantId, workspaceId, versionId);
  if (!row || row.accountId !== accountId) {
    throw new ContactServiceError("CONTACT_NOT_FOUND", "The buying-center record was not found.");
  }
  const transitioned = transitionBuyingCenterReview({
    version: 1, tenantId, workspaceId, accountId,
    playVersionId: row.playVersionId,
    current: row.payload,
    expectedVersionId: rawInput.expectedVersionId,
    expectedContentHash: rawInput.expectedContentHash,
    expectedReviewHash: rawInput.expectedReviewHash,
    actor: { kind: "human", actorId },
    to: rawInput.to,
    at: rawInput.at ?? nowIso(deps.clock),
    reason: rawInput.reason,
  });
  if (!transitioned.ok) throw engineFailure(transitioned.code);
  try {
    await deps.repository.updateCenterReview(
      row.reviewSha256, transitioned.center as Readonly<Record<string, unknown>>);
  } catch {
    throw new ContactServiceError("CONTACT_STALE", "The buying-center record changed concurrently.");
  }
  await deps.audit?.record({
    action: "buying_center.review.transitioned",
    entityType: "buying_center",
    entityId: versionId,
    metadata: { to: rawInput.to, actorId },
  });
  return Object.freeze({ center: transitioned.center });
}

/* ---------- query projections ---------- */

export type ContactView = Readonly<{
  versionId: string;
  accountId: string;
  stableKey: string;
  revision: number;
  displayName: string | null;
  contactPointClass: string;
  roleTitle: string | null;
  confidence: number | null;
  reviewStatus: ContactVersionRow["reviewStatus"];
  reviewEligible: boolean;
  reviewEligibilityReasons: readonly string[];
  suppressionDisposition: string;
  freshnessState: string;
  freshnessExpiresAt: string | null;
  permittedUse: readonly string[];
  connectorKey: string;
  observedAt: string | null;
  createdAt: string;
}>;

export type BuyingCenterView = Readonly<{
  versionId: string;
  accountId: string;
  playVersionId: string;
  stableKey: string;
  revision: number;
  reviewStatus: BuyingCenterRow["reviewStatus"];
  hypothesisCount: number;
  verifiedContactCount: number;
  hypotheses: readonly Readonly<{
    role: string;
    confidence: number;
    verifiedContact: boolean;
  }>[];
  createdAt: string;
}>;

function toContactView(row: ContactVersionRow): ContactView {
  const payload = row.payload;
  const identity = isPlainRecord(payload.identity) ? payload.identity : {};
  const role = isPlainRecord(payload.roleHypothesis) ? payload.roleHypothesis : null;
  const freshness = isPlainRecord(payload.freshness) ? payload.freshness : {};
  const permittedUse = isPlainRecord(payload.permittedUse) ? payload.permittedUse : {};
  const receipt = isPlainRecord(payload.sourceReceipt) ? payload.sourceReceipt : {};
  const review = isPlainRecord(payload.review) ? payload.review : {};
  const eligibility = isPlainRecord(review.eligibility) ? review.eligibility : {};
  return Object.freeze({
    versionId: row.versionId,
    accountId: row.accountId,
    stableKey: row.stableKey,
    revision: row.revision,
    displayName: typeof identity.displayName === "string" ? identity.displayName : null,
    contactPointClass: row.contactPointClass,
    roleTitle: role && typeof role.title === "string" ? role.title : null,
    confidence: role && typeof role.confidence === "number" ? role.confidence : null,
    reviewStatus: row.reviewStatus,
    reviewEligible: eligibility.eligible === true,
    reviewEligibilityReasons: Object.freeze(Array.isArray(eligibility.reasons)
      ? eligibility.reasons.filter((item): item is string => typeof item === "string") : []),
    suppressionDisposition: row.suppressionDisposition,
    freshnessState: row.freshnessState,
    freshnessExpiresAt: typeof freshness.expiresAt === "string" ? freshness.expiresAt : null,
    permittedUse: Object.freeze(Array.isArray(permittedUse.uses)
      ? permittedUse.uses.filter((item): item is string => typeof item === "string") : []),
    connectorKey: typeof receipt.connectorKey === "string" ? receipt.connectorKey : row.connectorKey,
    observedAt: typeof receipt.observedAt === "string" ? receipt.observedAt : null,
    createdAt: row.createdAt,
  });
}

function toCenterView(row: BuyingCenterRow): BuyingCenterView {
  const hypotheses = Array.isArray(row.payload.hypotheses) ? row.payload.hypotheses : [];
  return Object.freeze({
    versionId: row.versionId,
    accountId: row.accountId,
    playVersionId: row.playVersionId,
    stableKey: row.stableKey,
    revision: row.revision,
    reviewStatus: row.reviewStatus,
    hypothesisCount: row.hypothesisCount,
    verifiedContactCount: row.verifiedContactCount,
    hypotheses: Object.freeze(hypotheses.filter(isPlainRecord).map((hypothesis) => Object.freeze({
      role: typeof hypothesis.role === "string" ? hypothesis.role : "unknown",
      confidence: typeof hypothesis.confidence === "number" ? hypothesis.confidence : 0,
      verifiedContact: isPlainRecord(hypothesis.contactVersionRef),
    }))),
    createdAt: row.createdAt,
  });
}

export async function listContactViews(
  repository: ContactRepository,
  scope: Readonly<{ tenantId: string; workspaceId: string; accountId?: string }>,
): Promise<readonly ContactView[]> {
  const tenantId = uuid(scope.tenantId, "tenantId");
  const workspaceId = uuid(scope.workspaceId, "workspaceId");
  const rows = scope.accountId
    ? await repository.listAccountContacts(tenantId, workspaceId, uuid(scope.accountId, "accountId"))
    : await repository.listContacts(tenantId, workspaceId);
  return Object.freeze(rows.map(toContactView));
}

export async function listBuyingCenterViews(
  repository: ContactRepository,
  scope: Readonly<{ tenantId: string; workspaceId: string; accountId?: string }>,
): Promise<readonly BuyingCenterView[]> {
  const tenantId = uuid(scope.tenantId, "tenantId");
  const workspaceId = uuid(scope.workspaceId, "workspaceId");
  const rows = scope.accountId
    ? await repository.listAccountCenters(tenantId, workspaceId, uuid(scope.accountId, "accountId"))
    : await repository.listCenters(tenantId, workspaceId);
  return Object.freeze(rows.map(toCenterView));
}
