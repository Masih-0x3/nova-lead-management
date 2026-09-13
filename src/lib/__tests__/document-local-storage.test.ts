vi.mock("server-only", () => ({}));

import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { vi } from "vitest";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  createLocalDocumentStore,
  readLocalDocumentObject,
  type LocalDocumentStoreOptions,
} from "@/lib/documents/local-storage-adapter";
import { MAX_SIGNED_UPLOAD_SECONDS } from "@/lib/documents";

const TENANT_ID = "11111111-1111-4111-8111-111111111111";
const WORKSPACE_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const DOCUMENT_ID = "22222222-2222-4222-8222-222222222222";
const VERSION_ID = "33333333-3333-4333-8333-333333333333";
const OBJECT_KEY = `tenants/${TENANT_ID}/documents/${DOCUMENT_ID}/versions/${VERSION_ID}/original`;
const SIGNING_SECRET = "local-signing-secret-with-at-least-32-characters";
const ORIGIN = "https://app.example.test";

let rootDir: string;

function expectThrow(fn: () => unknown, code: string): void {
  try {
    fn();
    expect.unreachable();
  } catch (error) {
    expect(error).toMatchObject({ name: "DocumentIntakeError", code });
  }
}

function store(overrides: Partial<LocalDocumentStoreOptions> = {}) {
  return createLocalDocumentStore({
    rootDir,
    signingSecret: SIGNING_SECRET,
    uploadOrigin: ORIGIN,
    ...overrides,
  });
}

async function reserve() {
  const response = await store().reserveUpload({
    objectKey: OBJECT_KEY,
    expectedMediaType: "text/plain",
    maxBytes: 5,
    expiresInSeconds: MAX_SIGNED_UPLOAD_SECONDS,
  });
  return response as { objectKey: string; uploadUrl: string; expiresAt: string; visibility: string };
}

function capabilityFrom(url: string) {
  return store().verifyUploadCapability(
    Object.fromEntries(new URL(url).searchParams.entries()),
  );
}

beforeEach(async () => {
  rootDir = await mkdtemp(path.join(tmpdir(), "nova-doc-store-"));
});

afterEach(async () => {
  await rm(rootDir, { recursive: true, force: true });
});

describe("createLocalDocumentStore", () => {
  it("rejects a short signing secret", () => {
    expectThrow(
      () => createLocalDocumentStore({ rootDir, signingSecret: "too-short" }),
      "storage_boundary_error",
    );
  });

  it("rejects a non-HTTPS upload origin", () => {
    expectThrow(
      () => store({ uploadOrigin: "http://app.example.test" }),
      "storage_boundary_error",
    );
  });

  it("constructs a receive-only store without an upload origin", () => {
    expect(() => createLocalDocumentStore({ rootDir, signingSecret: SIGNING_SECRET }))
      .not.toThrow();
  });
});

describe("reserveUpload + verifyUploadCapability", () => {
  it("mints a private signed upload URL under the canonical object key", async () => {
    const reservation = await reserve();
    expect(reservation.objectKey).toBe(OBJECT_KEY);
    expect(reservation.visibility).toBe("private");
    const url = new URL(reservation.uploadUrl);
    expect(url.origin).toBe(ORIGIN);
    expect(url.pathname).toBe("/api/documents/upload");
    expect(url.searchParams.get("key")).toBe(OBJECT_KEY);
    expect(Date.parse(reservation.expiresAt)).toBeGreaterThan(Date.now());
  });

  it("round-trips the capability through the query parameters", async () => {
    const reservation = await reserve();
    const capability = capabilityFrom(reservation.uploadUrl);
    expect(capability).toEqual({
      objectKey: OBJECT_KEY,
      mediaType: "text/plain",
      byteSize: 5,
      expiresAt: reservation.expiresAt,
    });
  });

  it("rejects a tampered signature", async () => {
    const reservation = await reserve();
    const url = new URL(reservation.uploadUrl);
    url.searchParams.set("sig", "0".repeat(64));
    expectThrow(() => capabilityFrom(url.toString()), "malformed_signature");
  });

  it("rejects a capability whose declared metadata drifted", async () => {
    const reservation = await reserve();
    const url = new URL(reservation.uploadUrl);
    url.searchParams.set("bytes", "6");
    expectThrow(() => capabilityFrom(url.toString()), "malformed_signature");
  });

  it("rejects an expired capability", async () => {
    let now = 1_000_000;
    const expiring = createLocalDocumentStore({
      rootDir, signingSecret: SIGNING_SECRET, uploadOrigin: ORIGIN, now: () => now,
    });
    const response = await expiring.reserveUpload({
      objectKey: OBJECT_KEY,
      expectedMediaType: "text/plain",
      maxBytes: 5,
      expiresInSeconds: MAX_SIGNED_UPLOAD_SECONDS,
    }) as { uploadUrl: string };
    now += MAX_SIGNED_UPLOAD_SECONDS * 1000 + 1;
    expectThrow(
      () => expiring.verifyUploadCapability(
        Object.fromEntries(new URL(response.uploadUrl).searchParams.entries()),
      ),
      "malformed_signature",
    );
  });

  it("fails closed when reservation is attempted without an upload origin", async () => {
    const receiveOnly = createLocalDocumentStore({ rootDir, signingSecret: SIGNING_SECRET });
    await expect(receiveOnly.reserveUpload({
      objectKey: OBJECT_KEY,
      expectedMediaType: "text/plain",
      maxBytes: 5,
      expiresInSeconds: MAX_SIGNED_UPLOAD_SECONDS,
    })).rejects.toMatchObject({ code: "storage_boundary_error" });
  });
});

describe("acceptSignedUpload", () => {
  it("writes the object and sidecar only after exact checks pass", async () => {
    const capability = capabilityFrom((await reserve()).uploadUrl);
    const acceptance = await store().acceptSignedUpload({
      capability,
      bytes: new Uint8Array([104, 101, 108, 108, 111]),
      contentType: "text/plain",
    });
    expect(acceptance).toEqual({ objectKey: OBJECT_KEY, byteSize: 5 });
    const objectPath = path.join(rootDir, ...OBJECT_KEY.split("/"));
    expect(await readFile(objectPath)).toEqual(Buffer.from("hello"));
    const meta = JSON.parse(await readFile(`${objectPath}.meta.json`, "utf8"));
    expect(meta).toEqual({ objectKey: OBJECT_KEY, mediaType: "text/plain", byteSize: 5 });
  });

  it("rejects a byte-length mismatch and writes nothing", async () => {
    const capability = capabilityFrom((await reserve()).uploadUrl);
    await expect(store().acceptSignedUpload({
      capability,
      bytes: new Uint8Array([1, 2]),
      contentType: "text/plain",
    })).rejects.toMatchObject({ code: "size_mismatch" });
    await expect(stat(path.join(rootDir, ...OBJECT_KEY.split("/")))).rejects.toThrow();
  });

  it("rejects a content-type mismatch", async () => {
    const capability = capabilityFrom((await reserve()).uploadUrl);
    await expect(store().acceptSignedUpload({
      capability,
      bytes: new Uint8Array([104, 101, 108, 108, 111]),
      contentType: "application/pdf",
    })).rejects.toMatchObject({ code: "type_mismatch" });
  });
});

describe("readUploadedObject / readLocalDocumentObject", () => {
  async function seeded() {
    const capability = capabilityFrom((await reserve()).uploadUrl);
    await store().acceptSignedUpload({
      capability,
      bytes: new Uint8Array([104, 101, 108, 108, 111]),
      contentType: "text/plain",
    });
  }

  it("reads the sealed object back through the member-facing port", async () => {
    await seeded();
    const object = await store().readUploadedObject({
      tenantId: TENANT_ID,
      workspaceId: WORKSPACE_ID,
      documentId: DOCUMENT_ID,
      versionId: VERSION_ID,
      objectKey: OBJECT_KEY,
      maxBytes: 50 * 1024 * 1024,
    }) as { objectKey: string; bytes: Uint8Array; mediaType: string; byteSize: number };
    expect(object.objectKey).toBe(OBJECT_KEY);
    expect(Buffer.from(object.bytes).toString()).toBe("hello");
    expect(object.mediaType).toBe("text/plain");
  });

  it("rejects an object key bound to a different tenant", async () => {
    await seeded();
    await expect(store().readUploadedObject({
      tenantId: "99999999-9999-4999-8999-999999999999",
      workspaceId: WORKSPACE_ID,
      documentId: DOCUMENT_ID,
      versionId: VERSION_ID,
      objectKey: OBJECT_KEY,
      maxBytes: 50 * 1024 * 1024,
    })).rejects.toMatchObject({ code: "storage_boundary_error" });
  });

  it("rejects traversal-shaped keys before touching the filesystem", async () => {
    await expect(readLocalDocumentObject(rootDir, "tenants/../../etc/passwd"))
      .rejects.toMatchObject({ code: "unsafe_object_key" });
    await expect(readLocalDocumentObject(rootDir, OBJECT_KEY + "/../original"))
      .rejects.toMatchObject({ code: "unsafe_object_key" });
  });

  it("returns null for a well-formed but missing object", async () => {
    await expect(readLocalDocumentObject(rootDir, OBJECT_KEY)).resolves.toBeNull();
  });
});

describe("deleteObject", () => {
  it("reports whether bytes were actually removed", async () => {
    const capability = capabilityFrom((await reserve()).uploadUrl);
    await store().acceptSignedUpload({
      capability,
      bytes: new Uint8Array([104, 101, 108, 108, 111]),
      contentType: "text/plain",
    });
    const first = await store().deleteObject({ tenantId: TENANT_ID, objectKey: OBJECT_KEY });
    expect(first).toEqual({ objectKey: OBJECT_KEY, removed: true });
    const second = await store().deleteObject({ tenantId: TENANT_ID, objectKey: OBJECT_KEY });
    expect(second).toEqual({ objectKey: OBJECT_KEY, removed: false });
  });

  it("rejects an object key outside the caller's tenant prefix", async () => {
    await expect(store().deleteObject({
      tenantId: "99999999-9999-4999-8999-999999999999",
      objectKey: OBJECT_KEY,
    })).rejects.toMatchObject({ code: "storage_boundary_error" });
  });
});
