import { createHash } from "node:crypto";

import { DOCUMENT_SPREADSHEET_MAX_ROWS } from "@/lib/documents/extraction";
import { DOCUMENT_MAX_BYTES } from "@/lib/documents/validation";

import type { DocumentParser, NormalizedDocumentBlock, ParserOutput } from "./types";
import { readZipEntries, zipEntry } from "./zip";

export const DOCX_MAX_BLOCKS = 100_000;
export const XLSX_MAX_ROWS = DOCUMENT_SPREADSHEET_MAX_ROWS;
export const OOXML_MAX_PART_CHARS = DOCUMENT_MAX_BYTES;

const CONTENT_TYPES = "[content_types].xml";

function decodeEntities(text: string): string {
  return text
    .replace(/&#x([0-9a-fA-F]{1,6});/gu, (_match, hex: string) => {
      const value = Number.parseInt(hex, 16);
      return Number.isSafeInteger(value) && value >= 0 && value <= 0x10ffff
        ? String.fromCodePoint(value)
        : "";
    })
    .replace(/&#([0-9]{1,7});/gu, (_match, dec: string) => {
      const value = Number.parseInt(dec, 10);
      return Number.isSafeInteger(value) && value >= 0 && value <= 0x10ffff
        ? String.fromCodePoint(value)
        : "";
    })
    .replace(/&lt;/gu, "<")
    .replace(/&gt;/gu, ">")
    .replace(/&quot;/gu, '"')
    .replace(/&apos;/gu, "'")
    .replace(/&amp;/gu, "&");
}

function utf8(bytes: Uint8Array): string {
  return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
}

function contentHash(text: string): string {
  return `sha256:${createHash("sha256").update(text, "utf8").digest("hex")}`;
}

function attribute(fragment: string, name: string): string | null {
  const match = new RegExp(`\\b${name}\\s*=\\s*"([^"]*)"`, "u").exec(fragment)
    ?? new RegExp(`\\b${name}\\s*=\\s*'([^']*)'`, "u").exec(fragment);
  return match ? decodeEntities(match[1]) : null;
}

function innerText(fragment: string, tagPattern: RegExp): string {
  const parts: string[] = [];
  for (const match of fragment.matchAll(tagPattern)) {
    parts.push(decodeEntities(match[1]));
  }
  return parts.join("");
}

const W_TEXT = /<w:t(?:\s[^>]*)?>([\s\S]*?)<\/w:t>/gu;
const W_PARAGRAPH = /<w:p(?:\s[^>]*)?>[\s\S]*?<\/w:p>/gu;
const W_TABLE_ROW = /<w:tr(?:\s[^>]*)?>[\s\S]*?<\/w:tr>/gu;
const W_TABLE_CELL = /<w:tc(?:\s[^>]*)?>[\s\S]*?<\/w:tc>/gu;
const HEADING_STYLE = /^(?:heading\s*[1-9]|title|subtitle)$/iu;

async function parseDocx(context: Parameters<DocumentParser["parse"]>[0]): Promise<ParserOutput> {
  if (context.signal.aborted) throw new Error("docx parse canceled");
  const archive = readZipEntries(context.bytes);
  if (!archive) throw new Error("docx container is malformed");
  if (!zipEntry(archive, CONTENT_TYPES)) throw new Error("docx content types are missing");
  const documentPart = zipEntry(archive, "word/document.xml");
  if (!documentPart || documentPart.bytes.byteLength > OOXML_MAX_PART_CHARS) {
    throw new Error("docx document part is missing or oversized");
  }
  const xml = utf8(documentPart.bytes);

  const rows: Readonly<{ start: number; end: number; fragment: string }>[] = [];
  for (const match of xml.matchAll(W_TABLE_ROW)) {
    rows.push(Object.freeze({ start: match.index, end: match.index + match[0].length, fragment: match[0] }));
  }
  const insideRow = (offset: number) => rows.some((row) => offset >= row.start && offset < row.end);
  const paragraphs: Readonly<{ start: number; fragment: string }>[] = [];
  for (const match of xml.matchAll(W_PARAGRAPH)) {
    if (!insideRow(match.index)) {
      paragraphs.push(Object.freeze({ start: match.index, fragment: match[0] }));
    }
  }
  const ordered = [
    ...paragraphs.map((item) => ({ start: item.start, kind: "paragraph" as const, fragment: item.fragment })),
    ...rows.map((item) => ({ start: item.start, kind: "row" as const, fragment: item.fragment })),
  ].sort((left, right) => left.start - right.start);

  const blocks: NormalizedDocumentBlock[] = [];
  let sectionPath: readonly string[] = ["Document"];
  let sectionBlock = 0;
  for (const item of ordered) {
    if ((blocks.length & 1023) === 0 && context.signal.aborted) throw new Error("docx parse canceled");
    if (blocks.length >= DOCX_MAX_BLOCKS) throw new Error("docx block limit exceeded");
    if (item.kind === "row") {
      const cells: string[] = [];
      for (const cellMatch of item.fragment.matchAll(W_TABLE_CELL)) {
        cells.push(innerText(cellMatch[0], W_TEXT).trim());
      }
      const text = cells.filter((cell) => cell.length > 0).join(" | ");
      if (text.length === 0) continue;
      blocks.push({
        kind: "table_row",
        ordinal: blocks.length,
        text,
        contentHash: contentHash(text),
        locator: { kind: "section", sectionPath, block: sectionBlock },
      });
      sectionBlock += 1;
      continue;
    }
    const text = innerText(item.fragment, W_TEXT).trim();
    if (text.length === 0) continue;
    const style = attribute(item.fragment, "w:val");
    if (style && HEADING_STYLE.test(style)) {
      sectionPath = Object.freeze([text]);
      sectionBlock = 0;
      blocks.push({
        kind: "heading",
        ordinal: blocks.length,
        text,
        contentHash: contentHash(text),
        locator: { kind: "section", sectionPath, block: sectionBlock },
      });
      sectionBlock += 1;
      continue;
    }
    blocks.push({
      kind: "paragraph",
      ordinal: blocks.length,
      text,
      contentHash: contentHash(text),
      locator: { kind: "section", sectionPath, block: sectionBlock },
    });
    sectionBlock += 1;
  }
  if (blocks.length === 0) throw new Error("docx parser cannot return empty success");
  return {
    parserId: "launch-docx-blocks",
    parserVersion: "1.0.0",
    status: "review_required",
    blocks,
    warnings: ["language_gate_pending"],
    quality: { score: 0.99, reviewRequired: true },
  };
}

const SHEET_ELEMENT = /<sheet\b[^>]*\/?>/gu;
const RELATIONSHIP = /<Relationship\b[^>]*\/?>/gu;
const ROW_ELEMENT = /<row\b[^>]*>([\s\S]*?)<\/row>|<row\b[^>]*\/>/gu;
const CELL_ELEMENT = /<c\b[^>]*>([\s\S]*?)<\/c>|<c\b[^>]*\/>/gu;
const SHARED_ITEM = /<si\b[^>]*>([\s\S]*?)<\/si>/gu;
const SI_TEXT = /<t(?:\s[^>]*)?>([\s\S]*?)<\/t>/gu;
const CELL_VALUE = /<v\b[^>]*>([\s\S]*?)<\/v>/u;
const INLINE_TEXT = /<is\b[^>]*>([\s\S]*?)<\/is>/u;

function workbookSheets(
  archive: readonly { name: string; bytes: Uint8Array }[],
): readonly Readonly<{ name: string; target: string }>[] | null {
  const workbook = zipEntry(archive, "xl/workbook.xml");
  const rels = zipEntry(archive, "xl/_rels/workbook.xml.rels");
  if (!workbook || !rels) return null;
  const targets = new Map<string, string>();
  for (const match of utf8(rels.bytes).matchAll(RELATIONSHIP)) {
    const id = attribute(match[0], "Id");
    const target = attribute(match[0], "Target");
    if (!id || !target) return null;
    const normalized = target.replace(/^\//u, "");
    targets.set(id, normalized.startsWith("xl/") ? normalized : `xl/${normalized}`);
  }
  const sheets: Readonly<{ name: string; target: string }>[] = [];
  for (const match of utf8(workbook.bytes).matchAll(SHEET_ELEMENT)) {
    const name = attribute(match[0], "name");
    const relationId = attribute(match[0], "r:id") ?? attribute(match[0], "id");
    const target = relationId && targets.get(relationId);
    if (!name || !target) return null;
    sheets.push(Object.freeze({ name, target }));
  }
  return sheets.length > 0 ? Object.freeze(sheets) : null;
}

function sharedStrings(archive: readonly { name: string; bytes: Uint8Array }[]): readonly string[] {
  const part = zipEntry(archive, "xl/sharedstrings.xml");
  if (!part) return [];
  const values: string[] = [];
  for (const match of utf8(part.bytes).matchAll(SHARED_ITEM)) {
    values.push(innerText(match[1], SI_TEXT));
  }
  return values;
}

function cellText(fragment: string, shared: readonly string[]): string | null {
  const type = attribute(fragment, "t");
  if (type === "inlineStr") {
    const inline = INLINE_TEXT.exec(fragment);
    return inline ? innerText(inline[1], SI_TEXT) : null;
  }
  const value = CELL_VALUE.exec(fragment);
  if (!value) return null;
  const raw = decodeEntities(value[1]);
  if (type === "s") {
    if (!/^[0-9]+$/u.test(raw.trim())) return null;
    const index = Number.parseInt(raw.trim(), 10);
    return index < shared.length ? shared[index] : null;
  }
  if (type === "b") return raw.trim() === "1" ? "TRUE" : "FALSE";
  return raw;
}

function sheetRows(
  xml: string,
  sheet: string,
  shared: readonly string[],
  blocks: NormalizedDocumentBlock[],
  signal: AbortSignal,
): number {
  let rowCount = 0;
  for (const rowMatch of xml.matchAll(ROW_ELEMENT)) {
    if ((rowCount & 1023) === 0 && signal.aborted) throw new Error("xlsx parse canceled");
    const rowNumber = attribute(rowMatch[0], "r");
    const row = rowNumber && /^[0-9]+$/u.test(rowNumber)
      ? Number.parseInt(rowNumber, 10)
      : rowCount + 1;
    if (row > XLSX_MAX_ROWS) throw new Error("xlsx row limit exceeded");
    const cells: string[] = [];
    for (const cellMatch of (rowMatch[1] ?? "").matchAll(CELL_ELEMENT)) {
      const text = cellText(cellMatch[0], shared);
      if (text !== null && text.trim().length > 0) cells.push(text.trim());
    }
    rowCount += 1;
    if (cells.length === 0) continue;
    const text = cells.join(" | ");
    blocks.push({
      kind: "table_row",
      ordinal: blocks.length,
      text,
      contentHash: contentHash(text),
      locator: { kind: "row", sheet, row },
    });
    if (blocks.length > XLSX_MAX_ROWS) throw new Error("xlsx row limit exceeded");
  }
  return rowCount;
}

function workbookArchive(bytes: Uint8Array): readonly { name: string; bytes: Uint8Array }[] | null {
  const archive = readZipEntries(bytes);
  if (!archive || !zipEntry(archive, CONTENT_TYPES)) return null;
  return archive;
}

async function parseXlsx(context: Parameters<DocumentParser["parse"]>[0]): Promise<ParserOutput> {
  if (context.signal.aborted) throw new Error("xlsx parse canceled");
  const archive = workbookArchive(context.bytes);
  if (!archive) throw new Error("xlsx container is malformed");
  const sheets = workbookSheets(archive);
  if (!sheets) throw new Error("xlsx workbook part is missing");
  const shared = sharedStrings(archive);
  const blocks: NormalizedDocumentBlock[] = [];
  let totalRows = 0;
  for (const sheet of sheets) {
    const part = zipEntry(archive, sheet.target);
    if (!part || part.bytes.byteLength > OOXML_MAX_PART_CHARS) continue;
    totalRows += sheetRows(utf8(part.bytes), sheet.name, shared, blocks, context.signal);
    if (totalRows > XLSX_MAX_ROWS) throw new Error("xlsx row limit exceeded");
  }
  if (blocks.length === 0) throw new Error("xlsx parser cannot return empty success");
  return {
    parserId: "launch-xlsx-rows",
    parserVersion: "1.0.0",
    status: "review_required",
    blocks,
    warnings: ["language_gate_pending"],
    quality: { score: 0.99, reviewRequired: true },
  };
}

/**
 * Counts populated worksheet rows across the workbook for the extraction
 * eligibility gate. Returns null when the container is unreadable.
 */
export function countWorkbookRows(bytes: Uint8Array): number | null {
  try {
    const archive = workbookArchive(bytes);
    if (!archive) return null;
    const sheets = workbookSheets(archive);
    if (!sheets) return null;
    let total = 0;
    for (const sheet of sheets) {
      const part = zipEntry(archive, sheet.target);
      if (!part || part.bytes.byteLength > OOXML_MAX_PART_CHARS) return null;
      total += Array.from(utf8(part.bytes).matchAll(ROW_ELEMENT)).length;
      if (total > XLSX_MAX_ROWS) return total;
    }
    return total;
  } catch {
    return null;
  }
}

export const DOCX_DOCUMENT_PARSER: DocumentParser = Object.freeze({
  capability: Object.freeze({
    parserId: "launch-docx-blocks",
    parserVersion: "1.0.0",
    formats: Object.freeze(["docx"] as const),
    mediaTypes: Object.freeze([
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    ] as const),
    maxBytes: DOCUMENT_MAX_BYTES,
    maxBlocks: DOCX_MAX_BLOCKS,
    timeBudgetMs: 60_000,
    networkAccess: "forbidden" as const,
  }),
  parse: parseDocx,
});

export const XLSX_DOCUMENT_PARSER: DocumentParser = Object.freeze({
  capability: Object.freeze({
    parserId: "launch-xlsx-rows",
    parserVersion: "1.0.0",
    formats: Object.freeze(["xlsx"] as const),
    mediaTypes: Object.freeze([
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    ] as const),
    maxBytes: DOCUMENT_MAX_BYTES,
    maxBlocks: XLSX_MAX_ROWS,
    timeBudgetMs: 90_000,
    networkAccess: "forbidden" as const,
  }),
  parse: parseXlsx,
});
