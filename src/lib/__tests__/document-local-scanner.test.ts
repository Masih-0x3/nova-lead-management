vi.mock("server-only", () => ({}));

import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { vi } from "vitest";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createLocalDocumentScanner } from "@/lib/documents/local-scanner-adapter";

const TENANT_ID = "11111111-1111-4111-8111-111111111111";
const DOCUMENT_ID = "22222222-2222-4222-8222-222222222222";
const VERSION_ID = "33333333-3333-4333-8333-333333333333";
const OBJECT_KEY = `tenants/${TENANT_ID}/documents/${DOCUMENT_ID}/versions/${VERSION_ID}/original`;
const POLICY_VERSION = "launch-v1";

let rootDir: string;

function scanner(options: { blockedChecksums?: string[] } = {}) {
  return createLocalDocumentScanner({ rootDir, ...options });
}

async function seedObject(bytes: Uint8Array): Promise<string> {
  const objectPath = path.join(rootDir, ...OBJECT_KEY.split("/"));
  await mkdir(path.dirname(objectPath), { recursive: true });
  await writeFile(objectPath, bytes);
  return createHash("sha256").update(bytes).digest("hex");
}

function request(checksum: string) {
  return {
    quarantineObject: {
      tenantId: TENANT_ID,
      documentId: DOCUMENT_ID,
      versionId: VERSION_ID,
      objectKey: OBJECT_KEY,
    },
    checksum,
    policyVersion: POLICY_VERSION,
  };
}

beforeEach(async () => {
  rootDir = await mkdtemp(path.join(tmpdir(), "nova-doc-scan-"));
});

afterEach(async () => {
  await rm(rootDir, { recursive: true, force: true });
});

describe("createLocalDocumentScanner", () => {
  it("returns a clean verdict for benign bytes", async () => {
    const checksum = await seedObject(new Uint8Array([104, 101, 108, 108, 111]));
    const observation = await scanner().scan(request(checksum));
    expect(observation).toMatchObject({
      verdict: "clean",
      scannerAdapterId: "local-signature-scanner",
      scannedChecksum: checksum,
      policyVersion: POLICY_VERSION,
    });
  });

  it("flags the EICAR test signature as infected", async () => {
    const eicar = "X5O!P%@AP[4\\PZX54(P^)7CC)7}$EICAR-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*";
    const checksum = await seedObject(new TextEncoder().encode(`prefix ${eicar} suffix`));
    const observation = await scanner().scan(request(checksum));
    expect(observation).toMatchObject({ verdict: "infected", reasonCode: "test_signature" });
  });

  it("flags a checksum on the blocklist as infected", async () => {
    const checksum = await seedObject(new Uint8Array([1, 2, 3]));
    const observation = await scanner({ blockedChecksums: [checksum] }).scan(request(checksum));
    expect(observation).toMatchObject({ verdict: "infected", reasonCode: "known_signature" });
  });

  it("flags executable magic bytes as infected", async () => {
    for (const magic of [
      [0x4d, 0x5a, 0x90, 0x00],
      [0x7f, 0x45, 0x4c, 0x46],
      [0x23, 0x21, 0x2f, 0x62],
    ]) {
      const checksum = await seedObject(new Uint8Array(magic));
      const observation = await scanner().scan(request(checksum));
      expect(observation).toMatchObject({ verdict: "infected", reasonCode: "executable_content" });
    }
  });

  it("reports a missing object as a retryable error", async () => {
    const observation = await scanner().scan(request("0".repeat(64)));
    expect(observation).toMatchObject({
      verdict: "error",
      reasonCode: "object_unreadable",
      retryable: true,
    });
  });

  it("reports stored bytes that drifted from the claimed checksum as a hard error", async () => {
    await seedObject(new Uint8Array([1, 2, 3]));
    const claimed = "f".repeat(64);
    const observation = await scanner().scan(request(claimed));
    expect(observation).toMatchObject({
      verdict: "error",
      reasonCode: "integrity_mismatch",
      retryable: false,
    });
    expect(observation.scannedChecksum).not.toBe(claimed);
  });

  it("rejects a malformed scan request before reading storage", async () => {
    await expect(scanner().scan({
      quarantineObject: {
        tenantId: TENANT_ID,
        documentId: DOCUMENT_ID,
        versionId: VERSION_ID,
        objectKey: "tenants/../escape",
      },
      checksum: "0".repeat(64),
      policyVersion: POLICY_VERSION,
    })).rejects.toMatchObject({ name: "DocumentIntakeError" });
  });
});
