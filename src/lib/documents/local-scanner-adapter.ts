import "server-only";

import { createHash } from "node:crypto";
import { isProxy } from "node:util/types";

import type {
  MalwareScannerAdapter,
  ScannerObservation,
  ScannerRequest,
} from "./adapters";
import { DocumentIntakeError } from "./errors";
import { readLocalDocumentObject } from "./local-storage-adapter";
import { buildDocumentObjectKey } from "./object-keys";

const SCANNER_ADAPTER_ID = "local-signature-scanner";
const SCANNER_VERSION = "1.0.0";
const CANONICAL_UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const SHA256 = /^[0-9a-f]{64}$/u;
const POLICY_VERSION = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;

/**
 * The industry-standard EICAR antivirus test string lets deployments prove the
 * quarantine boundary end to end without shipping real malware.
 */
const EICAR_TEST_SIGNATURE =
  "X5O!P%@AP[4\\PZX54(P^)7CC)7}$EICAR-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*";

const EXECUTABLE_MAGICS: readonly (readonly number[])[] = [
  [0x4d, 0x5a], // PE/COFF ("MZ")
  [0x7f, 0x45, 0x4c, 0x46], // ELF
  [0xfe, 0xed, 0xfa, 0xce], // Mach-O 32
  [0xce, 0xfa, 0xed, 0xfe],
  [0xfe, 0xed, 0xfa, 0xcf], // Mach-O 64
  [0xcf, 0xfa, 0xed, 0xfe],
  [0xca, 0xfe, 0xba, 0xbe], // Mach-O fat / Java class
  [0x23, 0x21], // "#!" script interpreter line
];

export type LocalDocumentScannerOptions = Readonly<{
  rootDir: string;
  /** Lowercase hex sha256 digests treated as known-bad signatures. */
  blockedChecksums?: readonly string[];
  now?: () => number;
}>;

function boundaryError(): DocumentIntakeError {
  return new DocumentIntakeError(
    "intake_boundary_error",
    "The local document scanner could not complete the scan safely.",
  );
}

function dataRecord(
  value: unknown,
  required: readonly string[],
  optional: readonly string[] = [],
): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || isProxy(value) || Array.isArray(value)) {
    return null;
  }
  try {
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) return null;
    const descriptors = Object.getOwnPropertyDescriptors(value);
    const allowed = new Set([...required, ...optional]);
    const keys = Reflect.ownKeys(descriptors);
    if (keys.some((key) => typeof key !== "string" || !allowed.has(key))
      || required.some((key) => !Object.hasOwn(descriptors, key))) {
      return null;
    }
    const snapshot: Record<string, unknown> = {};
    for (const key of keys as string[]) {
      const descriptor = descriptors[key];
      if (!("value" in descriptor) || !descriptor.enumerable) return null;
      snapshot[key] = descriptor.value;
    }
    return snapshot;
  } catch {
    return null;
  }
}

function hasExecutableMagic(bytes: Uint8Array): boolean {
  return EXECUTABLE_MAGICS.some(
    (magic) => bytes.byteLength >= magic.length
      && magic.every((byte, index) => bytes[index] === byte),
  );
}

function containsSignature(bytes: Uint8Array, signature: string): boolean {
  if (bytes.byteLength < signature.length) return false;
  return Buffer.from(bytes).includes(signature);
}

/**
 * Local quarantine scanner: deterministic signature/hash heuristics behind the
 * MalwareScannerAdapter port so ClamAV or a hosted provider can bind later
 * without touching the fenced persist path.
 */
export function createLocalDocumentScanner(
  options: LocalDocumentScannerOptions,
): MalwareScannerAdapter {
  const config = dataRecord(options, ["rootDir"], ["blockedChecksums", "now"]);
  const rootDir = typeof config?.rootDir === "string" && config.rootDir.length > 0
    && config.rootDir.length <= 512 ? config.rootDir : null;
  if (rootDir === null) throw boundaryError();
  const blocked = new Set(
    (Array.isArray(options.blockedChecksums) ? options.blockedChecksums : [])
      .filter((value): value is string => typeof value === "string" && SHA256.test(value)),
  );
  const now = typeof options.now === "function" ? options.now : () => Date.now();

  function observation(
    request: ScannerRequest,
    verdict: ScannerObservation["verdict"],
    scannedChecksum: string,
    extra: Readonly<{ reasonCode?: string; retryable?: boolean }> = {},
  ): ScannerObservation {
    return Object.freeze({
      verdict,
      scannerAdapterId: SCANNER_ADAPTER_ID,
      scannerVersion: SCANNER_VERSION,
      scannedChecksum,
      scannedAt: new Date(now()).toISOString(),
      policyVersion: request.policyVersion,
      ...extra,
    });
  }

  return Object.freeze({
    async scan(request: ScannerRequest): Promise<ScannerObservation> {
      const input = dataRecord(request, ["quarantineObject", "checksum", "policyVersion"]);
      const target = input ? dataRecord(input.quarantineObject, [
        "tenantId", "documentId", "versionId", "objectKey",
      ]) : null;
      if (!input || !target
        || typeof input.checksum !== "string" || !SHA256.test(input.checksum)
        || typeof input.policyVersion !== "string"
        || !POLICY_VERSION.test(input.policyVersion)
        || typeof target.tenantId !== "string" || !CANONICAL_UUID.test(target.tenantId)
        || typeof target.documentId !== "string" || !CANONICAL_UUID.test(target.documentId)
        || typeof target.versionId !== "string" || !CANONICAL_UUID.test(target.versionId)
        || typeof target.objectKey !== "string"
        || target.objectKey !== buildDocumentObjectKey({
          tenantId: target.tenantId,
          documentId: target.documentId,
          versionId: target.versionId,
          object: { kind: "original" },
        })) {
        throw boundaryError();
      }

      const bytes = await readLocalDocumentObject(rootDir, target.objectKey);
      if (bytes === null) {
        return observation(request, "error", input.checksum, {
          reasonCode: "object_unreadable",
          retryable: true,
        });
      }
      const actualChecksum = createHash("sha256").update(bytes).digest("hex");
      if (actualChecksum !== input.checksum) {
        return observation(request, "error", actualChecksum, {
          reasonCode: "integrity_mismatch",
          retryable: false,
        });
      }
      if (blocked.has(actualChecksum)) {
        return observation(request, "infected", actualChecksum, {
          reasonCode: "known_signature",
        });
      }
      if (containsSignature(bytes, EICAR_TEST_SIGNATURE)) {
        return observation(request, "infected", actualChecksum, {
          reasonCode: "test_signature",
        });
      }
      if (hasExecutableMagic(bytes)) {
        return observation(request, "infected", actualChecksum, {
          reasonCode: "executable_content",
        });
      }
      return observation(request, "clean", actualChecksum);
    },
  });
}
