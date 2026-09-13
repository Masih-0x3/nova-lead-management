import { NextRequest, NextResponse } from "next/server";

import { DocumentIntakeError } from "@/lib/documents/errors";
import { createLocalDocumentStore } from "@/lib/documents/local-storage-adapter";
import { DOCUMENT_MAX_BYTES } from "@/lib/documents/validation";
import { applyNoStoreHeaders } from "@/lib/http-cache";

const STORE_ROOT_ENV = "NOVA_DOCUMENT_STORE_ROOT";
const SIGNING_SECRET_ENV = "NOVA_DOCUMENT_SIGNING_SECRET";

function localStore() {
  const rootDir = process.env[STORE_ROOT_ENV]?.trim() || ".data/document-objects";
  const signingSecret = process.env[SIGNING_SECRET_ENV]?.trim() ?? "";
  return createLocalDocumentStore({ rootDir, signingSecret });
}

function reject(status: number) {
  return applyNoStoreHeaders(NextResponse.json(
    { status: "error", error: "upload_rejected" },
    { status },
  ));
}

/**
 * Receives the raw bytes for a reserved private upload. Authority is the
 * HMAC-signed capability minted by reserveUpload — there is no session on a
 * presigned write, so the signature, expiry, exact byte count, and declared
 * media type are the whole boundary.
 */
export async function PUT(request: NextRequest) {
  let store: ReturnType<typeof localStore>;
  try {
    store = localStore();
  } catch {
    return reject(503);
  }

  let capability: ReturnType<typeof store.verifyUploadCapability>;
  try {
    capability = store.verifyUploadCapability(
      Object.fromEntries(request.nextUrl.searchParams.entries()),
    );
  } catch (error) {
    if (error instanceof DocumentIntakeError) {
      return reject(error.code === "malformed_signature" || error.code === "unsafe_object_key"
        ? 403 : 400);
    }
    return reject(400);
  }

  const declaredLength = Number.parseInt(request.headers.get("content-length") ?? "", 10);
  if (!Number.isSafeInteger(declaredLength) || declaredLength !== capability.byteSize) {
    return reject(413);
  }
  if (declaredLength > DOCUMENT_MAX_BYTES) return reject(413);

  const contentType = (request.headers.get("content-type") ?? "").split(";")[0].trim();
  let body: Uint8Array;
  try {
    body = new Uint8Array(await request.arrayBuffer());
  } catch {
    return reject(400);
  }

  try {
    const result = await store.acceptSignedUpload({ capability, bytes: body, contentType });
    return applyNoStoreHeaders(NextResponse.json({
      status: "ok",
      objectKey: result.objectKey,
      byteSize: result.byteSize,
    }));
  } catch (error) {
    if (error instanceof DocumentIntakeError) {
      if (error.code === "size_mismatch" || error.code === "size_limit_exceeded") return reject(413);
      if (error.code === "type_mismatch") return reject(415);
      return reject(400);
    }
    return reject(500);
  }
}

export async function GET() {
  return applyNoStoreHeaders(NextResponse.json(
    { status: "error", error: "Method Not Allowed" },
    { status: 405, headers: { Allow: "PUT" } },
  ));
}
