import type { OutreachEvidenceSource } from "@/lib/outreach/evidence-pack";

/**
 * Deterministic draft composer. Given the evidence-pack sources the bounded
 * agent run consumed, it renders subject/body text where every material
 * assertion is a declared claim bound to a pack source. Nothing here invents
 * facts: claim text is either a source statement verbatim or a hypothesis
 * explicitly flagged through `uncertainty`.
 */

export type OutreachDraftKind = "initial" | "follow_up" | "call_brief" | "objection";

export const OUTREACH_DRAFT_KINDS: readonly OutreachDraftKind[] = Object.freeze([
  "initial", "follow_up", "call_brief", "objection",
]);

export type ComposedClaim = Readonly<{
  claimId: string;
  field: "subject" | "body";
  start: number;
  end: number;
  text: string;
  claimClass: string;
  material: boolean;
  /** Evidence-pack key of the bound source; the service resolves citation ids. */
  sourceKey: string;
  uncertainty: string | null;
}>;

export type ComposedDraft = Readonly<{
  subject: string;
  body: string;
  claims: readonly ComposedClaim[];
}>;

export type ComposerContext = Readonly<{
  kind: OutreachDraftKind;
  /** Tenant-approved opt-out boilerplate appended verbatim to the body. */
  optOutText: string;
  /** Display name used in the greeting line, when a recipient exists. */
  greetingName: string | null;
  sources: readonly OutreachEvidenceSource[];
}>;

const MAX_FACT_CLAIMS = 3;
const ROLE_UNCERTAINTY = "Role hypothesis — the reviewer and recipient must validate.";
const OBJECTION_UNCERTAINTY = "Objection hypothesis derived from the cited fact — requires validation.";

interface Cursor {
  text: string;
  claims: ComposedClaim[];
}

function appendPlain(cursor: Cursor, text: string): void {
  cursor.text += text;
}

function appendClaim(
  cursor: Cursor,
  field: "subject" | "body",
  text: string,
  claimClass: string,
  sourceKey: string,
  material: boolean,
  uncertainty: string | null,
): void {
  const start = cursor.text.length;
  cursor.text += text;
  cursor.claims.push(Object.freeze({
    claimId: `claim:${field}:${cursor.claims.length}`,
    field,
    start,
    end: start + text.length,
    text,
    claimClass,
    material,
    sourceKey,
    uncertainty,
  }));
}

function findSource(
  sources: readonly OutreachEvidenceSource[],
  claimClass: string,
): OutreachEvidenceSource | null {
  return sources.find((source) => source.claimClass === claimClass) ?? null;
}

function factSources(sources: readonly OutreachEvidenceSource[]): readonly OutreachEvidenceSource[] {
  return sources.filter((source) =>
    source.claimClass !== "identity" && source.claimClass !== "contact_role");
}

function greeting(context: ComposerContext): string {
  return context.greetingName !== null && context.greetingName.length > 0
    ? `Hello ${context.greetingName},\n\n`
    : "Hello,\n\n";
}

function composeInitial(context: ComposerContext): ComposedDraft {
  const subjectCursor: Cursor = { text: "", claims: [] };
  const identity = findSource(context.sources, "identity");
  if (identity) {
    appendPlain(subjectCursor, "Introduction for ");
    appendClaim(subjectCursor, "subject", identity.statement, "identity", identity.key, true, null);
  } else {
    appendPlain(subjectCursor, "Introduction");
  }

  const body: Cursor = { text: greeting(context), claims: [] };
  const role = findSource(context.sources, "contact_role");
  if (role) {
    appendClaim(
      body, "body",
      `This note is intended for the person responsible for ${role.statement}.`,
      "contact_role", role.key, true, ROLE_UNCERTAINTY,
    );
    appendPlain(body, "\n\n");
  }
  for (const source of factSources(context.sources).slice(0, MAX_FACT_CLAIMS)) {
    appendClaim(body, "body", source.statement, source.claimClass, source.key, true, null);
    appendPlain(body, "\n");
  }
  appendPlain(
    body,
    "\nWould a short conversation about these points fit your priorities?\n\n"
      + context.optOutText,
  );
  return Object.freeze({
    subject: subjectCursor.text,
    body: body.text,
    claims: Object.freeze([...subjectCursor.claims, ...body.claims]),
  });
}

function composeFollowUp(context: ComposerContext): ComposedDraft {
  const subjectCursor: Cursor = { text: "Following up", claims: [] };
  const identity = findSource(context.sources, "identity");
  if (identity) {
    appendPlain(subjectCursor, " — ");
    appendClaim(subjectCursor, "subject", identity.statement, "identity", identity.key, true, null);
  }
  const body: Cursor = { text: greeting(context) + "I am following up on my earlier note.\n\n", claims: [] };
  for (const source of factSources(context.sources).slice(0, MAX_FACT_CLAIMS)) {
    appendClaim(body, "body", source.statement, source.claimClass, source.key, true, null);
    appendPlain(body, "\n");
  }
  appendPlain(
    body,
    "\nWould a short conversation about these points fit your priorities?\n\n"
      + context.optOutText,
  );
  return Object.freeze({
    subject: subjectCursor.text,
    body: body.text,
    claims: Object.freeze([...subjectCursor.claims, ...body.claims]),
  });
}

function composeCallBrief(context: ComposerContext): ComposedDraft {
  const subjectCursor: Cursor = { text: "Call brief", claims: [] };
  const identity = findSource(context.sources, "identity");
  const body: Cursor = { text: "Call brief for ", claims: [] };
  if (identity) {
    appendPlain(subjectCursor, " — ");
    appendClaim(subjectCursor, "subject", identity.statement, "identity", identity.key, true, null);
    appendClaim(body, "body", identity.statement, "identity", identity.key, true, null);
  } else {
    appendPlain(body, "the account");
  }
  appendPlain(body, ".\n\nContext:\n");
  const role = findSource(context.sources, "contact_role");
  if (role) {
    appendClaim(
      body, "body",
      `Proposed contact role: ${role.statement}.`,
      "contact_role", role.key, true, ROLE_UNCERTAINTY,
    );
    appendPlain(body, "\n");
  }
  for (const source of factSources(context.sources).slice(0, MAX_FACT_CLAIMS)) {
    appendClaim(body, "body", source.statement, source.claimClass, source.key, true, null);
    appendPlain(body, "\n");
  }
  appendPlain(body, "\nTalking points:\n- Confirm the account context above before the call.\n");
  return Object.freeze({
    subject: subjectCursor.text,
    body: body.text,
    claims: Object.freeze([...subjectCursor.claims, ...body.claims]),
  });
}

function composeObjection(context: ComposerContext): ComposedDraft {
  const subjectCursor: Cursor = { text: "Objection hypotheses", claims: [] };
  const identity = findSource(context.sources, "identity");
  const body: Cursor = { text: "Objection hypotheses for ", claims: [] };
  if (identity) {
    appendPlain(subjectCursor, " — ");
    appendClaim(subjectCursor, "subject", identity.statement, "identity", identity.key, true, null);
    appendClaim(body, "body", identity.statement, "identity", identity.key, true, null);
  } else {
    appendPlain(body, "the account");
  }
  appendPlain(body, ".\n\n");
  for (const source of factSources(context.sources).slice(0, MAX_FACT_CLAIMS)) {
    appendClaim(
      body, "body",
      `They may say "${source.statement}" is not a current priority.`,
      source.claimClass, source.key, true, OBJECTION_UNCERTAINTY,
    );
    appendPlain(body, "\n");
  }
  return Object.freeze({
    subject: subjectCursor.text,
    body: body.text,
    claims: Object.freeze([...subjectCursor.claims, ...body.claims]),
  });
}

/**
 * Composes the draft deterministically. At least one claim is required —
 * callers must fail closed when the evidence pack produced no usable source.
 */
export function composeOutreachDraft(context: ComposerContext): ComposedDraft {
  if (!OUTREACH_DRAFT_KINDS.includes(context.kind)) {
    throw new TypeError("Unknown outreach draft kind.");
  }
  const composed = context.kind === "initial" ? composeInitial(context)
    : context.kind === "follow_up" ? composeFollowUp(context)
      : context.kind === "call_brief" ? composeCallBrief(context)
        : composeObjection(context);
  if (composed.claims.length === 0) {
    throw new TypeError("The draft has no cited claims; generation must fail closed.");
  }
  return composed;
}
