import { createHash } from "node:crypto";

import type { AgentContextEvidenceInput } from "@/lib/agent-runtime/context-builder";
import type {
  UnderstandingCitation,
  UnderstandingEvidenceGrade,
  UnderstandingFact,
} from "@/lib/understanding/business-understanding";

/**
 * Materializes approved tenant facts into the strict citation/evidence
 * receipt the draft validator consumes, plus the untrusted-data records the
 * bounded agent runtime serializes. Every validator record binds one claim to
 * one source; claim-to-source selection happens in the draft composer.
 */

export type EvidenceSourceKind = "knowledge" | "account";

export type OutreachSourceResolution = Readonly<{
  kind: "understanding_fact" | "account_profile" | "contact_role";
  /** understanding_fact: the approved fact claim + citation evidence ids. */
  factClaimId?: string;
  factEvidenceId?: string;
  understandingVersionId?: string;
  /** account_profile: the canonical account row version bound at generation. */
  accountVersion?: number;
  /** contact_role: the contact record version + stable key bound at generation. */
  contactVersionId?: string;
  contactStableKey?: string;
}>;

export type OutreachEvidenceSource = Readonly<{
  /** Stable pack-local key, e.g. "src:0" — never a persisted identity. */
  key: string;
  sourceKind: EvidenceSourceKind;
  /** Account-scoped sources carry the account id; knowledge sources are null. */
  accountId: string | null;
  claimClass: string;
  statement: string;
  subject: string | null;
  material: boolean;
  support: "direct" | "corroborated";
  sourceVersionId: string;
  sourceContentHash: string;
  locator: string;
  resolution: OutreachSourceResolution;
}>;

export type OutreachEvidencePack = Readonly<{
  sources: readonly OutreachEvidenceSource[];
  /** Runtime evidence inputs — one per source, locator = pack-local key. */
  runtimeEvidence: readonly AgentContextEvidenceInput[];
}>;

export type ValidatorCitationRecord = Readonly<{
  citationVersion: 1;
  citationId: string;
  evidenceId: string;
  tenantId: string;
  workspaceId: string;
  accountId: string | null;
  state: "resolved";
  quoteHash: string;
  locator: string;
}>;

export type ValidatorEvidenceRecord = Readonly<{
  evidenceVersion: 1;
  evidenceId: string;
  sourceKind: EvidenceSourceKind;
  tenantId: string;
  workspaceId: string;
  accountId: string | null;
  approvalState: "approved";
  support: "direct" | "corroborated";
  freshness: "current";
  conflict: "none";
  revokedAt: null;
  claimTextHash: string;
  citationId: string;
  sourceReceipt: Readonly<{
    receiptVersion: 1;
    evidenceId: string;
    citationId: string;
    sourceVersionId: string;
    sourceContentHash: string;
    sourceKind: EvidenceSourceKind;
    tenantId: string;
    workspaceId: string;
    accountId: string | null;
    locator: string;
    quote: string;
    quoteHash: string;
    receiptHash: string;
  }>;
}>;

const MAX_PACK_SOURCES = 32;
const SAFE_TEXT = /^[^\x00-\x1f\x7f-\x9f]*$/u;

function sha256(value: unknown): string {
  return `sha256:${createHash("sha256").update(JSON.stringify(value), "utf8").digest("hex")}`;
}

function sha256Text(value: string): string {
  return `sha256:${createHash("sha256").update(value, "utf8").digest("hex")}`;
}

/** Deterministic uuid-shaped id minted from pack-local seeds (uuid v5, DNS). */
function packUuid(seed: string): string {
  const namespaceBytes = Buffer.from("6ba7b8109dad11d180b400c04fd430c8", "hex");
  const bytes = createHash("sha1").update(namespaceBytes).update(seed, "utf8").digest().subarray(0, 16);
  bytes[6] = (bytes[6] & 0x0f) | 0x50;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function gradeToSupport(grade: UnderstandingEvidenceGrade): "direct" | "corroborated" | null {
  if (grade === "direct_observation" || grade === "extracted") return "direct";
  if (grade === "tenant_client_provided" || grade === "corroborated") return "corroborated";
  return null;
}

function citationEligible(citation: UnderstandingCitation): boolean {
  return citation.freshness === "current" && gradeToSupport(citation.grade) !== null;
}

/** True when a fact may legally feed a cited outreach claim. */
export function factEligibleForOutreach(fact: UnderstandingFact): boolean {
  return fact.claimStatus === "supported" && fact.material
    && fact.citations.some(citationEligible);
}

/**
 * Selects outreach-usable (fact, citation) pairs. Only supported, material
 * facts with at least one current, non-inferred citation qualify; everything
 * else is excluded before the validator ever sees it.
 */
export function selectEvidenceSources(
  facts: readonly UnderstandingFact[],
): readonly Readonly<{ fact: UnderstandingFact; citation: UnderstandingCitation }>[] {
  const selected: { fact: UnderstandingFact; citation: UnderstandingCitation }[] = [];
  for (const fact of facts) {
    if (selected.length >= MAX_PACK_SOURCES) break;
    if (!factEligibleForOutreach(fact)) continue;
    const citation = fact.citations.find(citationEligible);
    if (!citation) continue;
    selected.push(Object.freeze({ fact, citation }));
  }
  return Object.freeze(selected);
}

export interface AccountEvidenceDescriptor {
  readonly accountId: string;
  readonly accountVersion: number;
  readonly displayName: string;
  readonly profileContent: unknown;
}

export interface ContactEvidenceDescriptor {
  readonly versionId: string;
  readonly stableKey: string;
  readonly contentHash: string;
  readonly roleStatement: string;
  readonly displayName: string | null;
}

/**
 * Builds the pack: approved understanding facts plus the account-identity and
 * contact-role sources the composer may bind to claims.
 */
export function buildEvidencePack(input: Readonly<{
  tenantId: string;
  workspaceId: string;
  accountId: string;
  facts: readonly Readonly<{ fact: UnderstandingFact; citation: UnderstandingCitation }>[];
  understandingVersionId: string | null;
  account?: AccountEvidenceDescriptor | null;
  contact?: ContactEvidenceDescriptor | null;
}>): OutreachEvidencePack {
  const sources: OutreachEvidenceSource[] = [];
  const push = (source: Omit<OutreachEvidenceSource, "key">) => {
    if (sources.length >= MAX_PACK_SOURCES) return;
    sources.push(Object.freeze({ ...source, key: `src:${sources.length}` }));
  };

  if (input.account) {
    push({
      sourceKind: "account",
      accountId: input.accountId,
      claimClass: "identity",
      statement: input.account.displayName,
      subject: "account_identity",
      material: true,
      support: "direct",
      sourceVersionId: `canonical-account:${input.account.accountId}:v${input.account.accountVersion}`,
      sourceContentHash: sha256(input.account.profileContent),
      locator: `account:${input.account.accountId}:profile`,
      resolution: Object.freeze({
        kind: "account_profile" as const,
        accountVersion: input.account.accountVersion,
      }),
    });
  }
  for (const { fact, citation } of input.facts) {
    const support = gradeToSupport(citation.grade);
    if (support === null || !SAFE_TEXT.test(fact.statement)) continue;
    push({
      sourceKind: "knowledge",
      accountId: null,
      claimClass: fact.claimClass,
      statement: fact.statement,
      subject: fact.subject,
      material: fact.material,
      support,
      sourceVersionId: citation.sourceVersionRef,
      sourceContentHash: citation.contentHash,
      locator: citation.locator,
      resolution: Object.freeze({
        kind: "understanding_fact" as const,
        factClaimId: fact.claimId,
        factEvidenceId: citation.evidenceId,
        understandingVersionId: input.understandingVersionId ?? undefined,
      }),
    });
  }
  if (input.contact && SAFE_TEXT.test(input.contact.roleStatement)) {
    push({
      sourceKind: "account",
      accountId: input.accountId,
      claimClass: "contact_role",
      statement: input.contact.roleStatement,
      subject: "contact_role",
      material: true,
      support: "direct",
      sourceVersionId: input.contact.versionId,
      sourceContentHash: input.contact.contentHash,
      locator: `contact:${input.contact.versionId}:role`,
      resolution: Object.freeze({
        kind: "contact_role" as const,
        contactVersionId: input.contact.versionId,
        contactStableKey: input.contact.stableKey,
      }),
    });
  }

  const runtimeEvidence: AgentContextEvidenceInput[] = sources.map((source, index) =>
    Object.freeze({
      tenantId: input.tenantId,
      workspaceId: input.workspaceId,
      sourceId: packUuid(`outreach-pack:${input.tenantId}:${source.sourceVersionId}:${index}`),
      evidenceId: packUuid(`outreach-evidence:${input.tenantId}:${source.sourceVersionId}:${index}`),
      locator: source.key,
      rank: index,
      text: source.statement,
    }));

  return Object.freeze({
    sources: Object.freeze(sources),
    runtimeEvidence: Object.freeze(runtimeEvidence),
  });
}

/**
 * Mints the mutually-bound validator citation + evidence pair for one claim.
 * claimText is the exact draft span text the evidence attests.
 */
export function materializeClaimBinding(input: Readonly<{
  tenantId: string;
  workspaceId: string;
  claimId: string;
  claimText: string;
  source: OutreachEvidenceSource;
  index: number;
}>): Readonly<{ citation: ValidatorCitationRecord; evidence: ValidatorEvidenceRecord }> {
  const citationId = `outreach-citation:${input.claimId}:${input.index}`;
  const evidenceId = `outreach-evidence:${input.claimId}:${input.index}`;
  const claimTextHash = sha256Text(input.claimText);
  const quoteHash = sha256Text(input.source.statement);
  const receiptPayload = Object.freeze({
    receiptVersion: 1 as const,
    evidenceId,
    citationId,
    sourceVersionId: input.source.sourceVersionId,
    sourceContentHash: input.source.sourceContentHash,
    sourceKind: input.source.sourceKind,
    tenantId: input.tenantId,
    workspaceId: input.workspaceId,
    accountId: input.source.accountId,
    locator: input.source.locator,
    quote: input.source.statement,
    quoteHash,
  });
  const citation: ValidatorCitationRecord = Object.freeze({
    citationVersion: 1,
    citationId,
    evidenceId,
    tenantId: input.tenantId,
    workspaceId: input.workspaceId,
    accountId: input.source.accountId,
    state: "resolved" as const,
    quoteHash,
    locator: input.source.locator,
  });
  const evidence: ValidatorEvidenceRecord = Object.freeze({
    evidenceVersion: 1,
    evidenceId,
    sourceKind: input.source.sourceKind,
    tenantId: input.tenantId,
    workspaceId: input.workspaceId,
    accountId: input.source.accountId,
    approvalState: "approved" as const,
    support: input.source.support,
    freshness: "current" as const,
    conflict: "none" as const,
    revokedAt: null,
    claimTextHash,
    citationId,
    sourceReceipt: Object.freeze({
      ...receiptPayload,
      receiptHash: sha256(receiptPayload),
    }),
  });
  return Object.freeze({ citation, evidence });
}
