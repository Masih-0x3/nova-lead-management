import { inflateRawSync } from "node:zlib";

import { DOCUMENT_MAX_BYTES } from "@/lib/documents/validation";

export const ZIP_MAX_ENTRIES = 4_096;
export const ZIP_MAX_MEMBER_BYTES = DOCUMENT_MAX_BYTES * 2;
export const ZIP_MAX_NAME_BYTES = 1_024;

const EOCD = 0x06054b50;
const CENTRAL_HEADER = 0x02014b50;
const LOCAL_HEADER = 0x04034b50;
const STORED = 0;
const DEFLATED = 8;

export type ZipArchiveEntry = Readonly<{
  name: string;
  bytes: Uint8Array;
}>;

function readUint16(bytes: Uint8Array, offset: number): number | null {
  if (offset < 0 || offset + 2 > bytes.byteLength) return null;
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint16(offset, true);
}

function readUint32(bytes: Uint8Array, offset: number): number | null {
  if (offset < 0 || offset + 4 > bytes.byteLength) return null;
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(offset, true);
}

/**
 * Parses the central directory and inflates each member. Returns null on any
 * structural anomaly; callers treat the container as malformed.
 */
export function readZipEntries(bytes: Uint8Array): readonly ZipArchiveEntry[] | null {
  if (bytes.byteLength < 22) return null;
  const minimumOffset = Math.max(0, bytes.byteLength - 65_557);
  let endOffset = -1;
  for (let offset = bytes.byteLength - 22; offset >= minimumOffset; offset -= 1) {
    if (readUint32(bytes, offset) === EOCD) {
      endOffset = offset;
      break;
    }
  }
  if (endOffset < 0) return null;

  const entryCount = readUint16(bytes, endOffset + 10);
  const centralSize = readUint32(bytes, endOffset + 12);
  const centralOffset = readUint32(bytes, endOffset + 16);
  if (entryCount === null || entryCount <= 0 || entryCount > ZIP_MAX_ENTRIES
    || centralSize === null || centralOffset === null
    || centralOffset + centralSize !== endOffset) return null;

  const entries: ZipArchiveEntry[] = [];
  const names = new Set<string>();
  let offset = centralOffset;
  for (let index = 0; index < entryCount; index += 1) {
    if (readUint32(bytes, offset) !== CENTRAL_HEADER) return null;
    const flags = readUint16(bytes, offset + 8);
    const method = readUint16(bytes, offset + 10);
    const compressedSize = readUint32(bytes, offset + 20);
    const uncompressedSize = readUint32(bytes, offset + 24);
    const nameLength = readUint16(bytes, offset + 28);
    const extraLength = readUint16(bytes, offset + 30);
    const commentLength = readUint16(bytes, offset + 32);
    const localOffset = readUint32(bytes, offset + 42);
    if (flags === null || method === null || compressedSize === null || uncompressedSize === null
      || nameLength === null || nameLength <= 0 || nameLength > ZIP_MAX_NAME_BYTES
      || extraLength === null || commentLength === null || localOffset === null
      || (flags & 0x21) !== 0 // encrypted entries or patched deflate are rejected
      || (method !== STORED && method !== DEFLATED)) return null;

    const nameStart = offset + 46;
    const nextOffset = nameStart + nameLength + extraLength + commentLength;
    if (nextOffset > endOffset || uncompressedSize > ZIP_MAX_MEMBER_BYTES) return null;
    let name: string;
    try {
      name = new TextDecoder("utf-8", { fatal: true })
        .decode(bytes.subarray(nameStart, nameStart + nameLength));
    } catch {
      return null;
    }
    const normalized = name.replaceAll("\\", "/").toLowerCase().replace(/^\.\//u, "");
    if (!normalized || normalized.startsWith("/") || normalized.split("/").includes("..")
      || names.has(normalized)) return null;

    if (readUint32(bytes, localOffset) !== LOCAL_HEADER) return null;
    const localNameLength = readUint16(bytes, localOffset + 26);
    const localExtraLength = readUint16(bytes, localOffset + 28);
    if (localNameLength === null || localExtraLength === null) return null;
    const dataStart = localOffset + 30 + localNameLength + localExtraLength;
    if (dataStart < 0 || dataStart + compressedSize > bytes.byteLength) return null;
    const compressed = bytes.subarray(dataStart, dataStart + compressedSize);
    let content: Uint8Array;
    try {
      content = method === STORED
        ? new Uint8Array(compressed)
        : new Uint8Array(inflateRawSync(compressed, { maxOutputLength: ZIP_MAX_MEMBER_BYTES }));
    } catch {
      return null;
    }
    if (content.byteLength !== uncompressedSize) return null;

    names.add(normalized);
    entries.push(Object.freeze({ name: normalized, bytes: content }));
    offset = nextOffset;
  }
  return offset === endOffset ? Object.freeze(entries) : null;
}

export function zipEntry(
  archive: readonly ZipArchiveEntry[],
  name: string,
): ZipArchiveEntry | null {
  return archive.find((entry) => entry.name === name) ?? null;
}
