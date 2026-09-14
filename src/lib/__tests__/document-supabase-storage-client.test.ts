vi.mock("server-only", () => ({}));

import { createHmac } from "node:crypto";

import { describe, expect, it, vi } from "vitest";

import { MAX_SIGNED_UPLOAD_SECONDS, reserveDocumentUpload } from "@/lib/documents";
import { SupabaseDocumentStorageAdapter } from "@/lib/documents/supabase-storage-adapter";
import {
  createSupabaseStorageClient,
  type SupabaseStorageHttpRequest,
  type SupabaseStorageHttpResponse,
  type SupabaseStorageTransport,
} from "@/lib/documents/supabase-storage-client";
import type { SupabasePrivateUploadReservationRequest } from "@/lib/documents/supabase-storage-adapter";

const ORIGIN = "https://storage.rehearsal.test";
const BUCKET = "nova-quarantine";
const SERVICE_KEY = `service-role-jwt-${"x".repeat(48)}`;

const TENANT_ID = "11111111-1111-4111-8111-111111111111";
const WORKSPACE_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const DOCUMENT_ID = "22222222-2222-4222-8222-222222222222";
const VERSION_ID = "33333333-3333-4333-8333-333333333333";
const OBJECT_KEY =
  `tenants/${TENANT_ID}/documents/${DOCUMENT_ID}/versions/${VERSION_ID}/original`;

const CSV_BYTES = new TextEncoder().encode("name,role\nAda,founder\n");

function b64url(value: unknown): string {
  return Buffer.from(JSON.stringify(value)).toString("base64url");
}

function mintSignedUploadToken(
  objectPath: string,
  overrides: Record<string, unknown> = {},
): string {
  const header = b64url({ alg: "HS256", typ: "JWT" });
  const payload = b64url({
    url: objectPath,
    upsert: false,
    scope: "upload",
    iat: Math.floor(Date.now() / 1000) - 1,
    exp: Math.floor(Date.now() / 1000) + 300,
    ...overrides,
  });
  const signature = createHmac("sha256", "rehearsal-signing-key")
    .update(`${header}.${payload}`)
    .digest("base64url");
  return `${header}.${payload}.${signature}`;
}

function signResponse(objectKey: string, tokenOverrides: Record<string, unknown> = {}) {
  const token = mintSignedUploadToken(`${BUCKET}/${objectKey}`, tokenOverrides);
  return {
    url: `/object/upload/sign/${BUCKET}/${objectKey}?token=${token}`,
    token,
  };
}

function jsonResponse(body: unknown, status = 200): SupabaseStorageHttpResponse {
  return Object.freeze({
    status,
    body: new TextEncoder().encode(JSON.stringify(body)),
  });
}

function recordTransport(
  handler: (
    request: SupabaseStorageHttpRequest,
    call: number,
  ) => SupabaseStorageHttpResponse | Promise<SupabaseStorageHttpResponse>,
): { transport: SupabaseStorageTransport; calls: SupabaseStorageHttpRequest[] } {
  const calls: SupabaseStorageHttpRequest[] = [];
  return {
    calls,
    transport: (request) => {
      calls.push(request);
      return Promise.resolve(handler(request, calls.length - 1));
    },
  };
}

function reservationRequest(overrides: Partial<SupabasePrivateUploadReservationRequest> = {}) {
  return Object.freeze({
    bucket: BUCKET,
    objectKey: OBJECT_KEY,
    expiresAt: new Date(Date.now() + 300_000).toISOString(),
    visibility: "private" as const,
    upsert: false as const,
    metadata: Object.freeze({
      tenantId: TENANT_ID,
      documentId: DOCUMENT_ID,
      versionId: VERSION_ID,
      objectClass: "quarantine-original" as const,
      expectedMediaType: "text/csv",
      maxBytes: CSV_BYTES.byteLength,
    }),
    ...overrides,
  });
}

function clientWith(transport: SupabaseStorageTransport) {
  return createSupabaseStorageClient({
    serviceOrigin: ORIGIN,
    serviceRoleKey: SERVICE_KEY,
    bucket: BUCKET,
    transport,
  });
}

describe("supabase storage client: signed upload reservation", () => {
  it("issues a provider-shaped signed upload bound to the exact quarantine key", async () => {
    const { transport, calls } = recordTransport(() =>
      jsonResponse(signResponse(OBJECT_KEY)));
    const client = clientWith(transport);
    const response = await client.storage
      .from(BUCKET)
      .createSignedUploadReservation(reservationRequest()) as {
        data: {
          signedUrl: string;
          expiresAt: string;
          upsert: boolean;
          visibility: string;
        };
      };

    expect(calls).toHaveLength(1);
    expect(calls[0].method).toBe("POST");
    expect(calls[0].path).toBe(
      `/storage/v1/object/upload/sign/${BUCKET}/${OBJECT_KEY}`,
    );
    expect(calls[0].headers.authorization).toBe(`Bearer ${SERVICE_KEY}`);
    expect(calls[0].headers["x-upsert"]).toBe("false");
    expect(calls[0].headers["content-type"]).toBe("text/csv");
    const metadata = JSON.parse(
      Buffer.from(calls[0].headers["x-metadata"], "base64").toString("utf8"),
    );
    expect(metadata).toMatchObject({
      tenantId: TENANT_ID,
      documentId: DOCUMENT_ID,
      versionId: VERSION_ID,
      objectClass: "quarantine-original",
      expectedMediaType: "text/csv",
      maxBytes: CSV_BYTES.byteLength,
    });
    expect(response.data.signedUrl.startsWith(
      `${ORIGIN}/storage/v1/object/upload/sign/${BUCKET}/${OBJECT_KEY}?token=`,
    )).toBe(true);
    expect(response.data.visibility).toBe("private");
    expect(response.data.upsert).toBe(false);
  });

  it("satisfies the SupabaseDocumentStorageAdapter end to end", async () => {
    const { transport } = recordTransport(() =>
      jsonResponse(signResponse(OBJECT_KEY)));
    const adapter = new SupabaseDocumentStorageAdapter(clientWith(transport), {
      bucket: BUCKET,
      allowedBuckets: [BUCKET],
      serviceOrigin: ORIGIN,
      allowedOrigins: [ORIGIN],
    });

    const reservation = await reserveDocumentUpload({
      tenantId: TENANT_ID,
      documentId: DOCUMENT_ID,
      versionId: VERSION_ID,
      fileName: "roster.csv",
      declaredMediaType: "text/csv",
      declaredByteSize: CSV_BYTES.byteLength,
    }, adapter);

    expect(reservation.objectKey).toBe(OBJECT_KEY);
    expect(reservation.visibility).toBe("private");
    expect(reservation.uploadUrl).toContain(`${ORIGIN}/storage/v1/object/upload/sign/`);
    expect(Date.parse(reservation.expiresAt)).toBeLessThanOrEqual(
      Date.now() + MAX_SIGNED_UPLOAD_SECONDS * 1000 + 5_000,
    );
  });

  it.each([
    {
      label: "a different object's signed URL",
      build: () => ({
        ...signResponse(OBJECT_KEY),
        url: `/object/upload/sign/${BUCKET}/${OBJECT_KEY}x?token=${
          mintSignedUploadToken(`${BUCKET}/${OBJECT_KEY}`)
        }`,
      }),
    },
    {
      label: "a token minted for a different object",
      build: () => signResponse(`tenants/${TENANT_ID}/documents/${DOCUMENT_ID}/versions/${VERSION_ID}/other`),
    },
    {
      label: "an upsert-enabled token",
      build: () => signResponse(OBJECT_KEY, { upsert: true }),
    },
    {
      label: "a token outliving the requested window",
      build: () => signResponse(OBJECT_KEY, {
        exp: Math.floor(Date.now() / 1000) + 600,
      }),
    },
    {
      label: "an expired token",
      build: () => signResponse(OBJECT_KEY, {
        exp: Math.floor(Date.now() / 1000) - 10,
      }),
    },
    {
      label: "a non-upload scope",
      build: () => signResponse(OBJECT_KEY, { scope: "download" }),
    },
  ])("fails closed on $label", async ({ build }) => {
    const { transport } = recordTransport(() => jsonResponse(build()));
    const client = clientWith(transport);
    await expect(
      client.storage.from(BUCKET).createSignedUploadReservation(
        reservationRequest(),
      ),
    ).rejects.toMatchObject({ code: "storage_boundary_error" });
  });

  it.each([
    { label: "denied request", response: jsonResponse({ error: "denied" }, 403) },
    { label: "malformed body", response: Object.freeze({ status: 200, body: new TextEncoder().encode("not json") }) },
    { label: "missing token", response: jsonResponse({ url: `/object/upload/sign/${BUCKET}/${OBJECT_KEY}?token=x` }) },
    { label: "provider 500", response: jsonResponse({ error: "boom" }, 500) },
  ])("fails closed on a $label", async ({ response }) => {
    const { transport } = recordTransport(() => response);
    const client = clientWith(transport);
    await expect(
      client.storage.from(BUCKET).createSignedUploadReservation(
        reservationRequest(),
      ),
    ).rejects.toMatchObject({ code: "storage_boundary_error" });
  });

  it("rejects a reservation for a bucket it is not pinned to", async () => {
    const { transport } = recordTransport(() =>
      jsonResponse(signResponse(OBJECT_KEY)));
    const client = clientWith(transport);
    expect(() => client.storage.from("other-bucket"))
      .toThrowError(expect.objectContaining({ code: "storage_boundary_error" }));
  });
});

describe("supabase storage client: verified read", () => {
  function readTransport(
    infoOverride: Record<string, unknown> = {},
    body: Uint8Array = CSV_BYTES,
  ) {
    return recordTransport((request) => {
      if (request.path.startsWith("/storage/v1/object/info/authenticated/")) {
        return jsonResponse({
          id: "obj-1",
          name: OBJECT_KEY,
          version: "v1",
          bucket_id: BUCKET,
          size: CSV_BYTES.byteLength,
          content_type: "text/csv",
          cache_control: "no-cache",
          etag: "etag",
          metadata: {},
          last_modified: "2026-09-14T00:00:00.000Z",
          created_at: "2026-09-14T00:00:00.000Z",
          archived_at: null,
          is_delete_marker: false,
          is_versioned: false,
          ...infoOverride,
        });
      }
      return Object.freeze({ status: 200, body });
    });
  }

  it("reads the exact bound object through info + authenticated download", async () => {
    const { transport, calls } = readTransport();
    const client = clientWith(transport);
    const result = await client.readUploadedObject({
      tenantId: TENANT_ID,
      workspaceId: WORKSPACE_ID,
      documentId: DOCUMENT_ID,
      versionId: VERSION_ID,
      objectKey: OBJECT_KEY,
      maxBytes: 1024,
    }) as { objectKey: string; bytes: Uint8Array; mediaType: string; byteSize: number };

    expect(calls.map((call) => `${call.method} ${call.path}`)).toEqual([
      `GET /storage/v1/object/info/authenticated/${BUCKET}/${OBJECT_KEY}`,
      `GET /storage/v1/object/authenticated/${BUCKET}/${OBJECT_KEY}`,
    ]);
    expect(result.objectKey).toBe(OBJECT_KEY);
    expect(result.mediaType).toBe("text/csv");
    expect(result.byteSize).toBe(CSV_BYTES.byteLength);
    expect(Buffer.from(result.bytes).toString()).toBe("name,role\nAda,founder\n");
  });

  it.each([
    {
      label: "rebuilt key mismatch",
      request: { objectKey: `tenants/${TENANT_ID}/documents/${DOCUMENT_ID}/versions/${VERSION_ID}/derivatives/${VERSION_ID}` },
    },
    {
      label: "non-uuid document id",
      request: { documentId: "not-a-uuid" },
    },
    {
      label: "oversized bound",
      request: { maxBytes: 60 * 1024 * 1024 },
    },
  ])("refuses a read with $label without touching the provider", async ({ request }) => {
    const { transport, calls } = readTransport();
    const client = clientWith(transport);
    await expect(client.readUploadedObject({
      tenantId: TENANT_ID,
      workspaceId: WORKSPACE_ID,
      documentId: DOCUMENT_ID,
      versionId: VERSION_ID,
      objectKey: OBJECT_KEY,
      maxBytes: 1024,
      ...request,
    } as never)).rejects.toMatchObject({ code: "storage_boundary_error" });
    expect(calls).toHaveLength(0);
  });

  it("rejects provider-reported size drift before trusting bytes", async () => {
    const { transport } = readTransport({ size: CSV_BYTES.byteLength + 1 });
    const client = clientWith(transport);
    await expect(client.readUploadedObject({
      tenantId: TENANT_ID,
      workspaceId: WORKSPACE_ID,
      documentId: DOCUMENT_ID,
      versionId: VERSION_ID,
      objectKey: OBJECT_KEY,
      maxBytes: 1024,
    })).rejects.toMatchObject({ code: "storage_boundary_error" });
  });

  it("rejects an object absent from the private bucket", async () => {
    const { transport } = recordTransport(() =>
      jsonResponse({ statusCode: "404", error: "not_found", code: "NoSuchKey" }, 404));
    const client = clientWith(transport);
    await expect(client.readUploadedObject({
      tenantId: TENANT_ID,
      workspaceId: WORKSPACE_ID,
      documentId: DOCUMENT_ID,
      versionId: VERSION_ID,
      objectKey: OBJECT_KEY,
      maxBytes: 1024,
    })).rejects.toMatchObject({ code: "storage_boundary_error" });
  });

  it("returns null for a missing quarantine object scan read", async () => {
    const { transport } = recordTransport(() =>
      jsonResponse({ statusCode: "404", error: "not_found", code: "NoSuchKey" }, 404));
    const client = clientWith(transport);
    await expect(client.readQuarantineObjectBytes({ objectKey: OBJECT_KEY }))
      .resolves.toBeNull();
  });
});

describe("supabase storage client: write + delete", () => {
  it("writes fetched bytes to the exact private object with binding metadata", async () => {
    const { transport, calls } = recordTransport(() =>
      jsonResponse({ Id: "id-1", Key: `${BUCKET}/${OBJECT_KEY}` }));
    const client = clientWith(transport);
    const result = await client.writeFetchedObject({
      tenantId: TENANT_ID,
      workspaceId: WORKSPACE_ID,
      documentId: DOCUMENT_ID,
      versionId: VERSION_ID,
      objectKey: OBJECT_KEY,
      mediaType: "text/csv",
      bytes: CSV_BYTES,
    }) as { objectKey: string; byteSize: number };

    expect(result).toMatchObject({ objectKey: OBJECT_KEY, byteSize: CSV_BYTES.byteLength });
    expect(calls[0].method).toBe("POST");
    expect(calls[0].path).toBe(`/storage/v1/object/${BUCKET}/${OBJECT_KEY}`);
    expect(calls[0].headers["x-upsert"]).toBe("false");
    expect(calls[0].headers["content-length"]).toBe(String(CSV_BYTES.byteLength));
    const metadata = JSON.parse(
      Buffer.from(calls[0].headers["x-metadata"], "base64").toString("utf8"),
    );
    expect(metadata.objectClass).toBe("quarantine-original");
    expect(metadata.tenantId).toBe(TENANT_ID);
  });

  it("rejects a write whose response Key does not echo the exact object", async () => {
    const { transport } = recordTransport(() =>
      jsonResponse({ Id: "id-1", Key: `${BUCKET}/somewhere/else` }));
    const client = clientWith(transport);
    await expect(client.writeFetchedObject({
      tenantId: TENANT_ID,
      workspaceId: WORKSPACE_ID,
      documentId: DOCUMENT_ID,
      versionId: VERSION_ID,
      objectKey: OBJECT_KEY,
      mediaType: "text/csv",
      bytes: CSV_BYTES,
    })).rejects.toMatchObject({ code: "storage_boundary_error" });
  });

  it.each([
    { label: "deleted", status: 200, removed: true },
    { label: "already absent", status: 404, removed: false },
  ])("reports removal when the object was $label", async ({ status, removed }) => {
    const { transport } = recordTransport(() =>
      status === 200
        ? jsonResponse({ message: "Successfully deleted" })
        : jsonResponse({ statusCode: "404", error: "not_found", code: "NoSuchKey" }, 404));
    const client = clientWith(transport);
    await expect(client.deleteObject({ tenantId: TENANT_ID, objectKey: OBJECT_KEY }))
      .resolves.toMatchObject({ objectKey: OBJECT_KEY, removed });
  });

  it("refuses a delete outside the tenant prefix", async () => {
    const { transport, calls } = recordTransport(() => jsonResponse({ message: "ok" }));
    const client = clientWith(transport);
    const foreignKey = OBJECT_KEY.replace(TENANT_ID, "99999999-9999-4999-8999-999999999999");
    await expect(client.deleteObject({ tenantId: TENANT_ID, objectKey: foreignKey }))
      .rejects.toMatchObject({ code: "storage_boundary_error" });
    expect(calls).toHaveLength(0);
  });
});
