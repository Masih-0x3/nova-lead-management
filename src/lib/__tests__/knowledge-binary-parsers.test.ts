import { createHash } from "node:crypto";
import { crc32, deflateRawSync, deflateSync } from "node:zlib";

import { describe, expect, it } from "vitest";

import {
  runKnowledgeExtractionPipeline,
  type KnowledgeExtractionPipelineInput,
} from "@/lib/knowledge/extraction-pipeline";
import { countWorkbookRows } from "@/lib/knowledge/parsers/ooxml";
import { countPdfPages } from "@/lib/knowledge/parsers/pdf";
import { createDocumentParserRegistry } from "@/lib/knowledge/parsers/registry";
import { readZipEntries } from "@/lib/knowledge/parsers/zip";
import { DOCUMENT_MAX_BYTES, type LaunchDocumentFormat } from "@/lib/documents/validation";

const TENANT_ID = "00000000-0000-4000-8000-0000000000b1";
const WORKSPACE_ID = "10000000-0000-4000-8000-0000000000b1";
const DOCUMENT_ID = "20000000-0000-4000-8000-0000000000b1";
const VERSION_ID = "30000000-0000-4000-8000-0000000000b1";
const POLICY_VERSION = "launch-v1";

const MEDIA_TYPES: Readonly<Record<string, string>> = {
  pdf: "application/pdf",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
};

function writeUint16(view: DataView, offset: number, value: number): void {
  view.setUint16(offset, value, true);
}

function writeUint32(view: DataView, offset: number, value: number): void {
  view.setUint32(offset, value, true);
}

/** Builds a real ZIP container (stored or raw-deflated members). */
function zip(entries: readonly Readonly<{ name: string; content: string; deflate?: boolean }>[]): Uint8Array {
  const encoded = entries.map((entry) => {
    const name = new TextEncoder().encode(entry.name);
    const raw = new TextEncoder().encode(entry.content);
    const data = entry.deflate ? new Uint8Array(deflateRawSync(raw)) : raw;
    return { name, raw, data, method: entry.deflate ? 8 : 0, crc: crc32(raw) };
  });
  const localSize = encoded.reduce((total, entry) => total + 30 + entry.name.byteLength + entry.data.byteLength, 0);
  const centralSize = encoded.reduce((total, entry) => total + 46 + entry.name.byteLength, 0);
  const out = new Uint8Array(localSize + centralSize + 22);
  const view = new DataView(out.buffer);
  let offset = 0;
  const central: { entry: (typeof encoded)[number]; localOffset: number }[] = [];
  for (const entry of encoded) {
    central.push({ entry, localOffset: offset });
    writeUint32(view, offset, 0x04034b50);
    writeUint16(view, offset + 4, 20);
    writeUint16(view, offset + 8, entry.method);
    writeUint32(view, offset + 14, entry.crc);
    writeUint32(view, offset + 18, entry.data.byteLength);
    writeUint32(view, offset + 22, entry.raw.byteLength);
    writeUint16(view, offset + 26, entry.name.byteLength);
    out.set(entry.name, offset + 30);
    out.set(entry.data, offset + 30 + entry.name.byteLength);
    offset += 30 + entry.name.byteLength + entry.data.byteLength;
  }
  const centralOffset = offset;
  for (const { entry, localOffset } of central) {
    writeUint32(view, offset, 0x02014b50);
    writeUint16(view, offset + 4, 20);
    writeUint16(view, offset + 6, 20);
    writeUint16(view, offset + 10, entry.method);
    writeUint32(view, offset + 16, entry.crc);
    writeUint32(view, offset + 20, entry.data.byteLength);
    writeUint32(view, offset + 24, entry.raw.byteLength);
    writeUint16(view, offset + 28, entry.name.byteLength);
    writeUint32(view, offset + 42, localOffset);
    out.set(entry.name, offset + 46);
    offset += 46 + entry.name.byteLength;
  }
  writeUint32(view, offset, 0x06054b50);
  writeUint16(view, offset + 8, encoded.length);
  writeUint16(view, offset + 10, encoded.length);
  writeUint32(view, offset + 12, centralSize);
  writeUint32(view, offset + 16, centralOffset);
  return out;
}

function docxFixture(documentXml: string, deflate = true): Uint8Array {
  return zip([
    { name: "[Content_Types].xml", content: "<Types/>", deflate },
    { name: "word/document.xml", content: documentXml, deflate },
  ]);
}

function xlsxFixture(
  options: Readonly<{ sheets?: string; rels?: string; shared?: string; data?: string; deflate?: boolean }> = {},
): Uint8Array {
  return zip([
    { name: "[Content_Types].xml", content: "<Types/>", deflate: options.deflate ?? true },
    {
      name: "xl/workbook.xml",
      content: options.sheets
        ?? `<workbook><sheets><sheet name="Customers" sheetId="1" r:id="rId1"/></sheets></workbook>`,
      deflate: options.deflate ?? true,
    },
    {
      name: "xl/_rels/workbook.xml.rels",
      content: options.rels
        ?? `<Relationships><Relationship Id="rId1" Type="x" Target="worksheets/sheet1.xml"/></Relationships>`,
      deflate: options.deflate ?? true,
    },
    {
      name: "xl/sharedStrings.xml",
      content: options.shared ?? `<sst><si><t>Acme Corp</t></si><si><t>Industrial</t></si></sst>`,
      deflate: options.deflate ?? true,
    },
    {
      name: "xl/worksheets/sheet1.xml",
      content: options.data
        ?? `<worksheet><sheetData><row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c></row><row r="3"><c r="A3"><v>42</v></c></row></sheetData></worksheet>`,
      deflate: options.deflate ?? true,
    },
  ]);
}

function pdfFixture(content: Uint8Array | string, pages = 1): Uint8Array {
  const pageObjects = Array.from(
    { length: pages },
    (_, index) => `${index + 3} 0 obj <</Type/Page/Parent 2 0 R/Contents 50 0 R>> endobj\n`,
  ).join("");
  const parts = [
    "%PDF-1.4\n",
    "1 0 obj <</Type/Catalog/Pages 2 0 R>> endobj\n",
    `2 0 obj <</Type/Pages/Kids[${Array.from({ length: pages }, (_v, i) => `${i + 3} 0 R`).join(" ")}]/Count ${pages}>> endobj\n`,
    pageObjects,
    `50 0 obj <</Length 0>> stream\n`,
  ];
  const head = new TextEncoder().encode(parts.join(""));
  const streamBytes = typeof content === "string" ? new TextEncoder().encode(content) : content;
  const tail = new TextEncoder().encode("\nendstream\nendobj\n%%EOF\n");
  const out = new Uint8Array(head.byteLength + streamBytes.byteLength + tail.byteLength);
  out.set(head, 0);
  out.set(streamBytes, head.byteLength);
  out.set(tail, head.byteLength + streamBytes.byteLength);
  return out;
}

function input(bytes: Uint8Array, format: LaunchDocumentFormat): KnowledgeExtractionPipelineInput {
  const checksum = createHash("sha256").update(bytes).digest("hex");
  const binding = { versionId: VERSION_ID, checksum, policyVersion: POLICY_VERSION };
  return {
    version: 1,
    tenantId: TENANT_ID,
    workspaceId: WORKSPACE_ID,
    documentId: DOCUMENT_ID,
    candidate: {
      version: { versionId: VERSION_ID, checksum, state: "clean" },
      immutable: true,
      format,
      cleanBinding: { ...binding },
      expectedBinding: { ...binding },
      parserMetadata: {
        ...binding,
        validated: true,
        ...(format === "pdf" ? { pageCount: countPdfPages(bytes) } : {}),
        ...(format === "xlsx" ? { rowCount: countWorkbookRows(bytes) } : {}),
      },
    },
    mediaType: MEDIA_TYPES[format],
    bytes,
    chunking: {
      algorithmVersion: "structural-v1",
      maxUtf8Bytes: 4_096,
      maxBlocksPerChunk: 8,
    },
  };
}

describe("zip container reader", () => {
  it("extracts stored and deflated members with normalized names", () => {
    const bytes = zip([
      { name: "Word\\Document.XML", content: "<w:document/>" },
      { name: "xl/workbook.xml", content: "<workbook/>", deflate: true },
    ]);
    const entries = readZipEntries(bytes);
    expect(entries?.map((entry) => entry.name)).toEqual(["word/document.xml", "xl/workbook.xml"]);
    expect(new TextDecoder().decode(entries![0].bytes)).toBe("<w:document/>");
    expect(new TextDecoder().decode(entries![1].bytes)).toBe("<workbook/>");
  });

  it("rejects traversal names, duplicates, and truncated archives", () => {
    expect(readZipEntries(new Uint8Array([1, 2, 3]))).toBeNull();
    const traversal = zip([{ name: "../evil.xml", content: "x" }]);
    expect(readZipEntries(traversal)).toBeNull();
    const good = zip([{ name: "a.xml", content: "ok" }]);
    expect(readZipEntries(good.subarray(0, good.byteLength - 10))).toBeNull();
  });
});

describe("docx parser", () => {
  it("emits heading, paragraph, and table-row blocks with section locators", async () => {
    const fixture = docxFixture(
      `<w:document><w:body>`
      + `<w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr><w:r><w:t>Pricing</w:t></w:r></w:p>`
      + `<w:p><w:r><w:t>Starter plan costs </w:t></w:r><w:r><w:t>$10/month</w:t></w:r></w:p>`
      + `<w:tbl><w:tr><w:tc><w:p><w:r><w:t>SKU</w:t></w:r></w:p></w:tc>`
      + `<w:tc><w:p><w:r><w:t>Use &amp; abuse</w:t></w:r></w:p></w:tc></w:tr></w:tbl>`
      + `</w:body></w:document>`,
    );
    const result = await runKnowledgeExtractionPipeline(input(fixture, "docx"));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.artifact.binding.parserId).toBe("launch-docx-blocks");
    expect(result.artifact.blocks).toMatchObject([
      {
        kind: "heading",
        text: "Pricing",
        sourceLocator: { kind: "section", label: "Section Pricing", sectionPath: ["Pricing"], block: 0 },
      },
      {
        kind: "paragraph",
        text: "Starter plan costs $10/month",
        sourceLocator: { kind: "section", label: "Section Pricing", sectionPath: ["Pricing"], block: 1 },
      },
      {
        kind: "table_row",
        text: "SKU | Use & abuse",
        sourceLocator: { kind: "section", label: "Section Pricing", sectionPath: ["Pricing"], block: 2 },
      },
    ]);
    for (const block of result.artifact.blocks) {
      expect(block.contentHash).toBe(
        `sha256:${createHash("sha256").update(block.text, "utf8").digest("hex")}`,
      );
    }
  });

  it("fails closed on a container without the document part", async () => {
    const result = await runKnowledgeExtractionPipeline(
      input(zip([{ name: "[Content_Types].xml", content: "<Types/>" }]), "docx"),
    );
    expect(result).toEqual({ ok: false, stage: "parser", code: "PARSER_FAILED" });
  });
});

describe("xlsx parser", () => {
  it("resolves shared strings and emits table rows with sheet row locators", async () => {
    const fixture = xlsxFixture();
    const result = await runKnowledgeExtractionPipeline(input(fixture, "xlsx"));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.artifact.binding.parserId).toBe("launch-xlsx-rows");
    expect(result.artifact.blocks).toMatchObject([
      { kind: "table_row", text: "Acme Corp | Industrial", sourceLocator: { kind: "row", label: "Row 1", row: 1 } },
      { kind: "table_row", text: "42", sourceLocator: { kind: "row", label: "Row 3", row: 3 } },
    ]);
    expect(result.artifact.tables[0].rowCount).toBe(2);
  });

  it("supports inline strings and counts rows for eligibility metadata", async () => {
    const fixture = xlsxFixture({
      shared: "<sst/>",
      data: `<worksheet><sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>Beta</t></is></c></row></sheetData></worksheet>`,
    });
    expect(countWorkbookRows(fixture)).toBe(1);
    const result = await runKnowledgeExtractionPipeline(input(fixture, "xlsx"));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.artifact.blocks[0].text).toBe("Beta");
  });

  it("fails closed when the workbook part is missing", async () => {
    const result = await runKnowledgeExtractionPipeline(
      input(zip([{ name: "[Content_Types].xml", content: "<Types/>" }]), "xlsx"),
    );
    expect(result).toEqual({ ok: false, stage: "input", code: "MALFORMED_INPUT" });
    expect(countWorkbookRows(zip([{ name: "a", content: "b" }]))).toBeNull();
  });
});

describe("pdf parser", () => {
  it("extracts the text layer from a plain content stream", async () => {
    const fixture = pdfFixture("BT /F1 12 Tf 100 700 Td (Pricing Summary) Tj ET");
    expect(countPdfPages(fixture)).toBe(1);
    const result = await runKnowledgeExtractionPipeline(input(fixture, "pdf"));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.artifact.binding.parserId).toBe("launch-pdf-text-layer");
    expect(result.artifact.blocks).toMatchObject([
      {
        kind: "paragraph",
        text: "Pricing Summary",
        sourceLocator: { kind: "page", label: "Page 1", page: 1, block: 0 },
      },
    ]);
    expect(result.artifact.warnings).toContain("pdf_text_layer_approximate");
    expect(result.artifact.quality.reviewRequired).toBe(true);
  });

  it("extracts flate-compressed streams and honors line-positioning breaks", async () => {
    const stream = deflateSync(
      new TextEncoder().encode("BT /F1 12 Tf 72 720 Td (Line one) Tj T* (Line \\(two\\)) Tj ET"),
    );
    const fixture = pdfFixture(new Uint8Array(stream));
    const result = await runKnowledgeExtractionPipeline(input(fixture, "pdf"));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.artifact.blocks[0].text).toBe("Line one\nLine (two)");
  });

  it("rejects a pdf whose text layer is empty", async () => {
    const result = await runKnowledgeExtractionPipeline(
      input(pdfFixture("0 0 m 100 100 l S"), "pdf"),
    );
    expect(result).toEqual({ ok: false, stage: "parser", code: "PARSER_FAILED" });
  });
});

describe("binary-format eligibility and registry boundaries", () => {
  it("rejects pdf candidates without a positive page count", async () => {
    const fixture = pdfFixture("BT (x) Tj ET");
    const request = input(fixture, "pdf");
    (request.candidate.parserMetadata as Record<string, unknown>).pageCount = 0;
    await expect(runKnowledgeExtractionPipeline(request)).resolves.toEqual({
      ok: false,
      stage: "eligibility",
      code: "DOCUMENT_NOT_ELIGIBLE",
      reason: "parser_metadata_malformed",
    });
  });

  it("rejects xlsx candidates whose row count metadata is missing", async () => {
    const request = input(xlsxFixture(), "xlsx");
    delete (request.candidate.parserMetadata as Record<string, unknown>).rowCount;
    await expect(runKnowledgeExtractionPipeline(request)).resolves.toEqual({
      ok: false,
      stage: "eligibility",
      code: "DOCUMENT_NOT_ELIGIBLE",
      reason: "parser_metadata_malformed",
    });
  });

  it("reports signature mismatches for format/media-type confusion", async () => {
    const { PDF_DOCUMENT_PARSER } = await import("@/lib/knowledge/parsers/pdf");
    const registry = createDocumentParserRegistry([PDF_DOCUMENT_PARSER]);
    const fixture = pdfFixture("BT (x) Tj ET");
    const result = await registry.parse({
      version: 1,
      documentVersionId: VERSION_ID,
      checksum: createHash("sha256").update(fixture).digest("hex"),
      format: "pdf",
      mediaType: "text/plain",
      bytes: fixture,
    });
    expect(result).toEqual({ ok: false, code: "SIGNATURE_MISMATCH" });
  });

  it("rejects oversized bytes at the registry boundary and inside the pdf parser", async () => {
    const { PDF_DOCUMENT_PARSER } = await import("@/lib/knowledge/parsers/pdf");
    const registry = createDocumentParserRegistry([PDF_DOCUMENT_PARSER]);
    const oversized = new Uint8Array(DOCUMENT_MAX_BYTES + 1);
    oversized.set(new TextEncoder().encode("%PDF-1.7"), 0);
    const checksum = createHash("sha256").update(oversized).digest("hex");
    await expect(registry.parse({
      version: 1,
      documentVersionId: VERSION_ID,
      checksum,
      format: "pdf",
      mediaType: "application/pdf",
      bytes: oversized,
    })).resolves.toEqual({ ok: false, code: "MALFORMED_REQUEST" });
    await expect(PDF_DOCUMENT_PARSER.parse({
      documentVersionId: VERSION_ID,
      checksum,
      format: "pdf",
      mediaType: "application/pdf",
      bytes: oversized,
      signal: new AbortController().signal,
    })).rejects.toThrow("pdf exceeds the launch byte limit");
  });
});
