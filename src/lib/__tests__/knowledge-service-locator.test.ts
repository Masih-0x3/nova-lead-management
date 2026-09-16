import { describe, expect, it, vi } from "vitest";

/**
 * The persisted `source_locator` contract is the render-safe union produced by
 * the extraction pipeline (line_range | row | page | section). The knowledge
 * read boundary must validate that exact contract — real PDF/DOCX parser
 * locators traverse it, malformed or foreign-keyed locators fail closed.
 */

vi.mock("server-only", () => ({}));

import {
  getDocumentKnowledge,
  resolveKnowledgeCitation,
} from "@/lib/knowledge/knowledge-service";

const TENANT = "00000000-0000-4000-8000-0000000000a1";
const WORKSPACE = "10000000-0000-4000-8000-0000000000a1";
const DOCUMENT = "20000000-0000-4000-8000-0000000000a1";
const VERSION = "30000000-0000-4000-8000-0000000000a1";
const EVIDENCE = `evidence:${"a".repeat(64)}`;
const CITATION = `citation:${"b".repeat(64)}`;
const QUOTE_HASH = `sha256:${"c".repeat(64)}`;

function knowledgeRow(sourceLocator: Record<string, unknown>) {
  return {
    evidence_id: EVIDENCE,
    document_id: DOCUMENT,
    version_id: VERSION,
    block_ordinal: 0,
    source_locator: sourceLocator,
    quote: "quoted evidence text",
    quote_hash: QUOTE_HASH,
    citation_id: CITATION,
    claim_id: null,
    claim_version_id: null,
    claim_class: null,
    subject: null,
    predicate: null,
    value: null,
    unit: null,
    polarity: null,
    material: null,
    review_state: null,
    review_reason: null,
  };
}

function repository(rows: readonly Record<string, unknown>[]) {
  return { getDocumentKnowledge: vi.fn(async () => rows) };
}

const scope = { tenantId: TENANT, workspaceId: WORKSPACE, documentId: DOCUMENT, versionId: VERSION };

describe("knowledge read boundary source_locator contract", () => {
  it.each([
    ["line_range", { kind: "line_range", label: "Lines 3-7", startLine: 3, endLine: 7 }],
    ["row", { kind: "row", label: "Row 5", row: 5 }],
    ["page", { kind: "page", label: "Page 2", page: 2, block: 0 }],
    ["section", { kind: "section", label: "Section Pricing / Annual", sectionPath: ["Pricing", "Annual"], block: 1 }],
  ])("accepts a parser-produced %s locator", async (_name, sourceLocator) => {
    const result = await getDocumentKnowledge(scope, {
      repository: repository([knowledgeRow(sourceLocator)]),
    });
    expect(result.evidence).toHaveLength(1);
    expect(result.evidence[0]!.sourceLocator).toMatchObject(sourceLocator);
  });

  it("resolves a citation whose evidence uses a page locator", async () => {
    const resolved = await resolveKnowledgeCitation(
      { tenantId: TENANT, workspaceId: WORKSPACE, citationId: CITATION },
      {
        repository: {
          resolveCitation: vi.fn(async () => ({
            citation_id: CITATION,
            evidence_id: EVIDENCE,
            document_id: DOCUMENT,
            version_id: VERSION,
            quote: "quoted evidence text",
            quote_hash: QUOTE_HASH,
            source_locator: { kind: "page", label: "Page 4", page: 4, block: 2 },
            version_state: "ready",
          })),
        },
      },
    );
    expect(resolved?.citationId).toBe(CITATION);
    expect(resolved?.sourceLocator).toMatchObject({ kind: "page", page: 4, block: 2 });
  });

  it.each([
    ["foreign key on page locator", { kind: "page", label: "Page 2", page: 2, block: 0, injected: "x" }],
    ["missing block on page locator", { kind: "page", label: "Page 2", page: 2 }],
    ["non-canonical label", { kind: "page", label: "Tampered label", page: 2, block: 0 }],
    ["unknown kind", { kind: "cell", label: "A1", sheet: "S", row: 1, column: "A" }],
    ["non-integer page", { kind: "page", label: "Page x", page: "2", block: 0 }],
    ["sectionPath entries with padding", { kind: "section", label: "Section  x ", sectionPath: [" x "], block: 0 }],
    ["line range inverted", { kind: "line_range", label: "Lines 9-4", startLine: 9, endLine: 4 }],
  ])("rejects %s", async (_name, sourceLocator) => {
    await expect(
      getDocumentKnowledge(scope, { repository: repository([knowledgeRow(sourceLocator as Record<string, unknown>)]) }),
    ).rejects.toMatchObject({ code: "persistence_boundary_error" });
  });
});
