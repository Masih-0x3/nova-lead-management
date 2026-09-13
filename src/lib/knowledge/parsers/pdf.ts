import { createHash } from "node:crypto";
import { inflateRawSync, inflateSync } from "node:zlib";

import { DOCUMENT_PDF_MAX_PAGES } from "@/lib/documents/extraction";
import { DOCUMENT_MAX_BYTES } from "@/lib/documents/validation";

import type { DocumentParser, NormalizedDocumentBlock, ParserOutput } from "./types";

export const PDF_MAX_STREAMS = 4_096;
export const PDF_MAX_STREAM_BYTES = DOCUMENT_MAX_BYTES * 2;
export const PDF_MAX_TEXT_OBJECTS = 500_000;

const HEADER = /^%PDF-1\.[0-9]/u;
const PAGE_MARKER = /\/Type\s*\/Page(?![A-Za-z])/gu;
const LATIN1 = new TextDecoder("latin1");
const CONTROL_CHAR = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u;

/**
 * Counts page-tree leaf nodes for the extraction eligibility gate. Returns
 * null when the object is not a plausible PDF.
 */
export function countPdfPages(bytes: Uint8Array): number | null {
  if (bytes.byteLength < 8 || !HEADER.test(LATIN1.decode(bytes.subarray(0, 8)))) return null;
  const matches = LATIN1.decode(bytes).match(PAGE_MARKER);
  return matches ? matches.length : 0;
}

function streamBodies(bytes: Uint8Array): Uint8Array[] {
  const streams: Uint8Array[] = [];
  let offset = 0;
  while (streams.length < PDF_MAX_STREAMS) {
    const start = bytes.indexOf(0x73, offset); // 's'
    if (start < 0) break;
    if (LATIN1.decode(bytes.subarray(start, start + 6)) !== "stream") {
      offset = start + 1;
      continue;
    }
    let dataStart = start + 6;
    if (bytes[dataStart] === 0x0d && bytes[dataStart + 1] === 0x0a) dataStart += 2;
    else if (bytes[dataStart] === 0x0a || bytes[dataStart] === 0x0d) dataStart += 1;
    const end = indexOfEndstream(bytes, dataStart);
    if (end < 0) break;
    streams.push(bytes.subarray(dataStart, end));
    offset = end + 9;
  }
  return streams;
}

function indexOfEndstream(bytes: Uint8Array, from: number): number {
  const marker = "endstream";
  outer: for (let offset = from; offset + marker.length <= bytes.byteLength; offset += 1) {
    if (bytes[offset] !== 0x65) continue;
    for (let index = 0; index < marker.length; index += 1) {
      if (bytes[offset + index] !== marker.charCodeAt(index)) continue outer;
    }
    return offset;
  }
  return -1;
}

function inflated(stream: Uint8Array): Uint8Array {
  for (const inflate of [inflateSync, inflateRawSync]) {
    try {
      return new Uint8Array(inflate(stream, { maxOutputLength: PDF_MAX_STREAM_BYTES }));
    } catch {
      continue;
    }
  }
  return stream;
}

function isOperatorBoundary(bytes: Uint8Array, offset: number): boolean {
  if (offset < 0 || offset >= bytes.byteLength) return true;
  const value = bytes[offset];
  return value <= 0x20 || value === 0x28 || value === 0x29 || value === 0x3c
    || value === 0x3e || value === 0x5b || value === 0x5d || value === 0x7b
    || value === 0x7d || value === 0x2f || value === 0x25;
}

function* textObjects(content: Uint8Array): Generator<Uint8Array> {
  let offset = 0;
  while (offset + 1 < content.byteLength) {
    if (content[offset] === 0x42 && content[offset + 1] === 0x54
      && isOperatorBoundary(content, offset - 1) && isOperatorBoundary(content, offset + 2)) {
      let depth = 0;
      let cursor = offset + 2;
      while (cursor + 1 < content.byteLength) {
        const value = content[cursor];
        if (value === 0x28) depth += 1;
        else if (value === 0x29 && depth > 0) depth -= 1;
        else if (depth === 0 && value === 0x45 && content[cursor + 1] === 0x54
          && isOperatorBoundary(content, cursor - 1) && isOperatorBoundary(content, cursor + 2)) {
          break;
        }
        cursor += 1;
      }
      yield content.subarray(offset + 2, cursor);
      offset = cursor + 2;
      continue;
    }
    offset += 1;
  }
}

function hexNibble(value: number): number {
  if (value >= 0x30 && value <= 0x39) return value - 0x30;
  if (value >= 0x41 && value <= 0x46) return value - 0x41 + 10;
  if (value >= 0x61 && value <= 0x66) return value - 0x61 + 10;
  return -1;
}

function decodeHexString(content: Uint8Array, start: number): Readonly<{ text: string; end: number }> {
  const digits: number[] = [];
  let cursor = start;
  while (cursor < content.byteLength && content[cursor] !== 0x3e) {
    const nibble = hexNibble(content[cursor]);
    if (nibble >= 0) digits.push(nibble);
    cursor += 1;
  }
  if (digits.length % 2 === 1) digits.push(0);
  const decoded = new Uint8Array(digits.length / 2);
  for (let index = 0; index < digits.length; index += 2) {
    decoded[index / 2] = digits[index] * 16 + digits[index + 1];
  }
  return Object.freeze({ text: LATIN1.decode(decoded), end: cursor });
}

function decodeLiteral(content: Uint8Array, start: number): Readonly<{ text: string; end: number }> {
  const out: number[] = [];
  let depth = 1;
  let cursor = start;
  while (cursor < content.byteLength && depth > 0) {
    const value = content[cursor];
    if (value === 0x5c) {
      const next = content[cursor + 1];
      cursor += 2;
      if (next === undefined) break;
      if (next === 0x6e) out.push(0x0a);
      else if (next === 0x72) out.push(0x0d);
      else if (next === 0x74) out.push(0x09);
      else if (next === 0x62) out.push(0x08);
      else if (next === 0x66) out.push(0x0c);
      else if (next === 0x28 || next === 0x29 || next === 0x5c) out.push(next);
      else if (next >= 0x30 && next <= 0x37) {
        let octal = next - 0x30;
        for (let digit = 0; digit < 2; digit += 1) {
          const extra = content[cursor];
          if (extra === undefined || extra < 0x30 || extra > 0x37) break;
          octal = octal * 8 + (extra - 0x30);
          cursor += 1;
        }
        out.push(octal & 0xff);
      } else if (next === 0x0d) {
        if (content[cursor] === 0x0a) cursor += 1;
      } else if (next !== 0x0a) out.push(next);
      continue;
    }
    if (value === 0x28) depth += 1;
    else if (value === 0x29) {
      depth -= 1;
      if (depth === 0) {
        cursor += 1;
        break;
      }
    }
    out.push(value);
    cursor += 1;
  }
  return Object.freeze({ text: LATIN1.decode(Uint8Array.from(out)), end: cursor });
}

/**
 * Collects the text shown by one text object. TJ kerning numbers above 250
 * (in thousandths of an em, negated) and line-positioning operators split
 * runs into lines.
 */
function textOf(object: Uint8Array): string {
  const parts: string[] = [];
  let cursor = 0;
  let pendingBreak = false;
  while (cursor < object.byteLength) {
    const value = object[cursor];
    if (value === 0x28) {
      const decoded = decodeLiteral(object, cursor + 1);
      if (pendingBreak && parts.length > 0) parts.push("\n");
      parts.push(decoded.text);
      pendingBreak = false;
      cursor = decoded.end;
      continue;
    }
    if (value === 0x3c && object[cursor + 1] !== 0x3c) {
      const decoded = decodeHexString(object, cursor + 1);
      if (pendingBreak && parts.length > 0) parts.push("\n");
      parts.push(decoded.text);
      pendingBreak = false;
      cursor = decoded.end;
      continue;
    }
    if (value === 0x54 && (object[cursor + 1] === 0x64 || object[cursor + 1] === 0x44 || object[cursor + 1] === 0x2a)
        && isOperatorBoundary(object, cursor - 1) && isOperatorBoundary(object, cursor + 2)) {
      pendingBreak = true;
      cursor += 2;
      continue;
    }
    // Positive TJ displacements of ≥250 thousandths of an em render as a gap.
    if (value === 0x2d || (value >= 0x30 && value <= 0x39)) {
      const match = /^-?[0-9]+(?:\.[0-9]+)?/u.exec(LATIN1.decode(object.subarray(cursor, cursor + 24)));
      if (match) {
        const displacement = Number.parseFloat(match[0]);
        if (Number.isFinite(displacement) && displacement >= 250) parts.push(" ");
        cursor += match[0].length;
        continue;
      }
    }
    cursor += 1;
  }
  return parts.join("");
}

function contentHash(text: string): string {
  return `sha256:${createHash("sha256").update(text, "utf8").digest("hex")}`;
}

async function parsePdf(context: Parameters<DocumentParser["parse"]>[0]): Promise<ParserOutput> {
  if (context.signal.aborted) throw new Error("pdf parse canceled");
  if (context.bytes.byteLength < 8
    || !HEADER.test(LATIN1.decode(context.bytes.subarray(0, 8)))) {
    throw new Error("pdf signature is missing");
  }
  const pageCount = countPdfPages(context.bytes);
  if (!pageCount || pageCount > DOCUMENT_PDF_MAX_PAGES) {
    throw new Error("pdf page count is unavailable or exceeds the launch limit");
  }

  const streams = streamBodies(context.bytes);
  const blocks: NormalizedDocumentBlock[] = [];
  const warnings: string[] = ["language_gate_pending", "pdf_text_layer_approximate"];
  let page = 0;
  for (const stream of streams) {
    if (context.signal.aborted) throw new Error("pdf parse canceled");
    const content = inflated(stream);
    let blockIndex = 0;
    let streamHasText = false;
    for (const object of textObjects(content)) {
      if (blocks.length >= PDF_MAX_TEXT_OBJECTS) throw new Error("pdf text object limit exceeded");
      const text = textOf(object)
        .split("\n")
        .map((line) => line.replace(/\s+/gu, " ").trim())
        .filter((line) => line.length > 0)
        .join("\n");
      if (text.length === 0) continue;
      streamHasText = true;
      blocks.push({
        kind: "paragraph",
        ordinal: blocks.length,
        text,
        contentHash: contentHash(text),
        locator: { kind: "page", page: page + 1, block: blockIndex },
      });
      blockIndex += 1;
    }
    if (streamHasText) page += 1;
  }
  if (blocks.length === 0) throw new Error("pdf text layer is empty");
  const controlRatio = blocks.reduce(
    (total, block) => total + (CONTROL_CHAR.test(block.text) ? 1 : 0),
    0,
  ) / blocks.length;
  if (controlRatio > 0.25) {
    warnings.push("pdf_text_encoding_unverified");
  }
  return {
    parserId: "launch-pdf-text-layer",
    parserVersion: "1.0.0",
    status: "review_required",
    blocks,
    warnings,
    quality: { score: controlRatio > 0.25 ? 0.6 : 0.85, reviewRequired: true },
  };
}

export const PDF_DOCUMENT_PARSER: DocumentParser = Object.freeze({
  capability: Object.freeze({
    parserId: "launch-pdf-text-layer",
    parserVersion: "1.0.0",
    formats: Object.freeze(["pdf"] as const),
    mediaTypes: Object.freeze(["application/pdf"] as const),
    maxBytes: DOCUMENT_MAX_BYTES,
    maxBlocks: PDF_MAX_TEXT_OBJECTS,
    timeBudgetMs: 90_000,
    networkAccess: "forbidden" as const,
  }),
  parse: parsePdf,
});
