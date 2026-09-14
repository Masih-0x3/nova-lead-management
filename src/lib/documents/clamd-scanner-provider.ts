import "server-only";

import { createHash } from "node:crypto";
import { connect as netConnect, type Socket } from "node:net";
import { isProxy } from "node:util/types";

import type {
  ScannerProviderCapability,
  ScannerProviderScanRequest,
} from "./scanner-provider-adapter";
import { DOCUMENT_MAX_BYTES } from "./validation";

const SHA256 = /^[0-9a-f]{64}$/u;
const APPROVED_IDENTIFIER = /^[a-z0-9][a-z0-9._:-]{0,127}$/u;
const CANONICAL_UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const CLAMD_HOST = /^[A-Za-z0-9][A-Za-z0-9.-]{0,252}$/u;
const CLAMD_VERSION_REPLY = /^ClamAV ([0-9]+\.[0-9]+\.[0-9]+)\/[0-9]+\//u;
const FOUND_SIGNATURE = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,255}$/u;
const INSTREAM_CHUNK_BYTES = 256 * 1024;
const REPLY_MAX_BYTES = 4 * 1024;
const DEFAULT_CONNECT_TIMEOUT_MS = 5_000;
const DEFAULT_SCAN_TIMEOUT_MS = 120_000;
const MAX_CONNECT_TIMEOUT_MS = 30_000;
const MAX_SCAN_TIMEOUT_MS = 300_000;

/** Bounded byte source for the exact quarantine object under scan. */
export type QuarantineObjectSource = (
  objectKey: string,
) => Promise<Uint8Array | null>;

export type ClamdScannerProviderOptions = Readonly<{
  host: string;
  port: number;
  objectSource: QuarantineObjectSource;
  connectTimeoutMs?: number;
  scanTimeoutMs?: number;
}>;

type ClamdFailure =
  | Readonly<{ kind: "timeout" }>
  | Readonly<{ kind: "unavailable" }>
  | Readonly<{ kind: "protocol" }>
  | Readonly<{ kind: "version"; actual: string }>
  | Readonly<{ kind: "size_limit" }>;

type ClamdVerdict =
  | Readonly<{ kind: "clean" }>
  | Readonly<{ kind: "infected"; signature: string }>
  | Readonly<{ kind: "failure"; failure: ClamdFailure }>;

class ClamdSocketError extends Error {
  readonly kind: "timeout" | "unavailable" | "protocol";

  constructor(kind: ClamdSocketError["kind"], message: string) {
    super(message);
    this.name = "ClamdSocketError";
    this.kind = kind;
  }
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
    if (keys.some((key) => typeof key !== "string" || !allowed.has(key))) return null;
    if (required.some((key) => !Object.hasOwn(descriptors, key))) return null;
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

function parseScanRequest(request: ScannerProviderScanRequest): ScannerProviderScanRequest | null {
  const input = dataRecord(request, [
    "quarantineObject", "checksum", "policyVersion", "scannerAdapterId", "scannerVersion",
  ]);
  const target = dataRecord(input?.quarantineObject, [
    "tenantId", "documentId", "versionId", "objectKey",
  ]);
  if (
    !input || !target ||
    typeof target.tenantId !== "string" || !CANONICAL_UUID.test(target.tenantId) ||
    typeof target.documentId !== "string" || !CANONICAL_UUID.test(target.documentId) ||
    typeof target.versionId !== "string" || !CANONICAL_UUID.test(target.versionId) ||
    typeof target.objectKey !== "string" || target.objectKey.length > 512 ||
    typeof input.checksum !== "string" || !SHA256.test(input.checksum) ||
    typeof input.policyVersion !== "string" || !APPROVED_IDENTIFIER.test(input.policyVersion) ||
    typeof input.scannerAdapterId !== "string" ||
    !APPROVED_IDENTIFIER.test(input.scannerAdapterId) ||
    typeof input.scannerVersion !== "string" ||
    !APPROVED_IDENTIFIER.test(input.scannerVersion)
  ) {
    return null;
  }
  return Object.freeze({
    quarantineObject: Object.freeze({
      tenantId: target.tenantId,
      documentId: target.documentId,
      versionId: target.versionId,
      objectKey: target.objectKey,
    }),
    checksum: input.checksum,
    policyVersion: input.policyVersion,
    scannerAdapterId: input.scannerAdapterId,
    scannerVersion: input.scannerVersion,
  });
}

/**
 * One bounded IDSESSION conversation. Replies are framed "<seq>: <payload>"
 * records; every reply must match the command currently in flight — anything
 * else (unframed, out-of-sequence, or arriving while no command is pending)
 * is a protocol failure and can never become a verdict. A single absolute
 * deadline settles every pending read and write, so close, error, backpressure,
 * or a slow trickle cannot leave the caller hanging.
 */
const REPLY_FRAME = /^([0-9]{1,9}): (.*)$/u;

type SessionPending =
  | Readonly<{
    kind: "reply";
    resolve: (payload: string) => void;
    reject: (error: Error) => void;
    cleanup: () => void;
  }>
  | Readonly<{
    kind: "write";
    resolve: () => void;
    reject: (error: Error) => void;
    cleanup: () => void;
  }>;

function openClamdSession(
  socket: Socket,
  deadlineAt: number,
): Readonly<{
  command: (seq: number, line: string) => Promise<void>;
  send: (bytes: Buffer) => Promise<void>;
  awaitReply: () => Promise<string>;
  end: () => void;
}> {
  let buffered = Buffer.alloc(0);
  let deadError: Error | null = null;
  let pending: SessionPending | null = null;
  let inflight = -1;
  const ready: string[] = [];

  const deadlineTimer = setTimeout(
    () => fail(new ClamdSocketError("timeout", "clamd session deadline exceeded")),
    Math.max(1, deadlineAt - Date.now()),
  );

  function fail(error: Error): void {
    if (deadError) return;
    deadError = error;
    clearTimeout(deadlineTimer);
    const waiter = pending;
    pending = null;
    if (waiter) {
      waiter.cleanup();
      waiter.reject(error);
    }
    socket.destroy();
  }

  const onData = (chunk: Buffer): void => {
    if (deadError) return;
    buffered = Buffer.concat([buffered, chunk]);
    // Validate every record in the chunk before delivering any payload: a
    // well-formed verdict must never outrun malformed or out-of-sequence
    // trailing bytes that arrive in the same read.
    const accepted: string[] = [];
    for (;;) {
      const newline = buffered.indexOf(0x0a);
      if (newline === -1) {
        if (buffered.byteLength > REPLY_MAX_BYTES) {
          fail(new ClamdSocketError("protocol", "clamd reply exceeded bounds"));
          return;
        }
        break;
      }
      // A terminated record beyond the cap is still oversized: cap before
      // resolving so a large newline-terminated line cannot slip through.
      if (newline > REPLY_MAX_BYTES) {
        fail(new ClamdSocketError("protocol", "clamd reply record exceeded bounds"));
        return;
      }
      const line = buffered.subarray(0, newline).toString("utf8");
      buffered = buffered.subarray(newline + 1);
      const frame = REPLY_FRAME.exec(line);
      if (!frame) {
        fail(new ClamdSocketError("protocol", "clamd reply was not session-framed"));
        return;
      }
      const seq = Number(frame[1]);
      if (seq !== inflight) {
        fail(new ClamdSocketError("protocol", "clamd reply id did not match the in-flight command"));
        return;
      }
      inflight = -1;
      accepted.push(frame[2] as string);
    }
    if (deadError) return;
    for (const payload of accepted) {
      const waiter = pending;
      if (waiter?.kind === "reply") {
        pending = null;
        waiter.cleanup();
        waiter.resolve(payload);
      } else {
        // A reply may legitimately arrive while a large INSTREAM write is
        // draining; hold it for the command's awaitReply rather than losing
        // or misattributing it.
        ready.push(payload);
      }
    }
  };
  const onError = (error: Error): void =>
    fail(new ClamdSocketError("unavailable", error.message));
  const onClose = (): void =>
    fail(new ClamdSocketError("unavailable", "clamd closed the session"));

  socket.on("data", onData);
  socket.once("error", onError);
  socket.once("close", onClose);

  async function send(bytes: Buffer): Promise<void> {
    if (deadError) throw deadError;
    if (!socket.write(bytes)) {
      // Backpressure: the wait is settled by drain or by fail() — socket
      // error/close/deadline all route through fail(), which rejects and
      // unregisters this pending write instead of leaving it hung.
      await new Promise<void>((resolve, reject) => {
        const onDrain = (): void => {
          pending = null;
          socket.off("drain", onDrain);
          resolve();
        };
        pending = {
          kind: "write",
          resolve,
          reject,
          cleanup: () => socket.off("drain", onDrain),
        };
        socket.once("drain", onDrain);
      });
    }
    if (deadError) throw deadError;
  }

  async function command(seq: number, line: string): Promise<void> {
    // Register the expected reply id before the bytes leave the socket so an
    // early reply still matches the command it answers.
    inflight = seq;
    await send(Buffer.from(line, "utf8"));
  }

  function awaitReply(): Promise<string> {
    if (deadError) return Promise.reject(deadError);
    const queued = ready.shift();
    if (queued !== undefined) return Promise.resolve(queued);
    return new Promise<string>((resolve, reject) => {
      pending = { kind: "reply", resolve, reject, cleanup: () => undefined };
    });
  }

  function end(): void {
    if (!deadError) {
      clearTimeout(deadlineTimer);
      socket.off("data", onData);
      socket.off("error", onError);
      socket.off("close", onClose);
    }
    socket.destroy();
  }

  return Object.freeze({ command, send, awaitReply, end });
}

function connectBounded(
  config: Readonly<{ host: string; port: number; connectTimeoutMs: number }>,
): Promise<Socket> {
  return new Promise((resolve, reject) => {
    const socket = netConnect({ host: config.host, port: config.port });
    let settled = false;
    const finish = (fn: () => void): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.off("connect", onConnect);
      socket.off("error", onError);
      socket.off("close", onClose);
      fn();
    };
    const timer = setTimeout(
      () => finish(() => {
        socket.destroy();
        reject(new ClamdSocketError("timeout", "clamd connect timed out"));
      }),
      config.connectTimeoutMs,
    );
    const onConnect = (): void => finish(() => resolve(socket));
    const onError = (error: Error): void =>
      finish(() => reject(new ClamdSocketError("unavailable", error.message)));
    const onClose = (): void =>
      finish(() => reject(new ClamdSocketError("unavailable", "clamd closed during connect")));
    socket.once("connect", onConnect);
    socket.once("error", onError);
    socket.once("close", onClose);
  });
}

/**
 * Drives one clamd IDSESSION: VERSION pins the running engine to the approved
 * scanner version, then INSTREAM streams the exact quarantine bytes, all on a
 * single session socket under one absolute deadline. (A non-session clamd
 * connection is closed by the daemon after one command.) Reply vocabulary is
 * the documented clamd session protocol; anything else is a protocol failure
 * that must never be read as a verdict.
 */
async function runClamdSession(
  bytes: Uint8Array,
  expectedVersion: string,
  config: Readonly<{
    host: string;
    port: number;
    connectTimeoutMs: number;
    scanTimeoutMs: number;
  }>,
): Promise<ClamdVerdict> {
  const socket = await connectBounded(config);
  const session = openClamdSession(socket, Date.now() + config.scanTimeoutMs);
  try {
    // IDSESSION itself consumes no reply id; subsequent replies are framed
    // "<seq>: <payload>" with seq starting at 1.
    await session.send(Buffer.from("nIDSESSION\n", "utf8"));
    await session.command(1, "nVERSION\n");
    const versionPayload = (await session.awaitReply()).trimEnd();
    const versionMatch = CLAMD_VERSION_REPLY.exec(versionPayload);
    if (!versionMatch) {
      throw new ClamdSocketError("protocol", "clamd VERSION reply was malformed");
    }
    if (versionMatch[1] !== expectedVersion) {
      return {
        kind: "failure",
        failure: { kind: "version", actual: versionMatch[1] ?? "" },
      };
    }

    await session.command(2, "nINSTREAM\n");
    for (let offset = 0; offset < bytes.byteLength; offset += INSTREAM_CHUNK_BYTES) {
      const chunk = Buffer.from(
        bytes.subarray(offset, Math.min(offset + INSTREAM_CHUNK_BYTES, bytes.byteLength)),
      );
      const header = Buffer.alloc(4);
      header.writeUInt32BE(chunk.byteLength, 0);
      await session.send(Buffer.concat([header, chunk]));
    }
    const terminator = Buffer.alloc(4);
    await session.send(terminator);

    const verdictPayload = (await session.awaitReply()).trimEnd();
    session.send(Buffer.from("nEND\n", "utf8")).catch(() => undefined);

    if (verdictPayload === "stream: OK") return { kind: "clean" };
    if (/^INSTREAM size limit exceeded/u.test(verdictPayload)) {
      return { kind: "failure", failure: { kind: "size_limit" } };
    }
    const found = /^stream: (.+) FOUND$/u.exec(verdictPayload);
    if (found && FOUND_SIGNATURE.test(found[1] ?? "")) {
      return { kind: "infected", signature: found[1] as string };
    }
    if (/ERROR\b/u.test(verdictPayload) || /^UNKNOWN COMMAND/u.test(verdictPayload)) {
      return {
        kind: "failure",
        failure: { kind: "unavailable" },
      };
    }
    throw new ClamdSocketError("protocol", "clamd INSTREAM reply was malformed");
  } finally {
    session.end();
  }
}

function providerBoundaryError(): Error {
  const error = new Error("The clamd scan could not produce a safe verdict.");
  error.name = "ScannerProviderBoundaryError";
  return error;
}

/**
 * Binds a real clamd daemon (INSTREAM over TCP) to the ScannerProviderCapability
 * contract. Byte integrity is proven here: the provider refuses to emit a
 * verdict unless the fetched object's SHA-256 equals the leased checksum.
 */
export function createClamdScannerProvider(
  options: ClamdScannerProviderOptions,
): ScannerProviderCapability {
  const config = dataRecord(options, ["host", "port", "objectSource"], [
    "connectTimeoutMs", "scanTimeoutMs",
  ]);
  const host = typeof config?.host === "string" && CLAMD_HOST.test(config.host)
    ? config.host
    : null;
  const port = typeof config?.port === "number" && Number.isSafeInteger(config.port)
    && config.port >= 1 && config.port <= 65_535 ? config.port : null;
  const connectTimeoutMs = config?.connectTimeoutMs === undefined
    ? DEFAULT_CONNECT_TIMEOUT_MS
    : typeof config.connectTimeoutMs === "number"
        && Number.isSafeInteger(config.connectTimeoutMs)
        && config.connectTimeoutMs >= 100
        && config.connectTimeoutMs <= MAX_CONNECT_TIMEOUT_MS
      ? config.connectTimeoutMs
      : null;
  const scanTimeoutMs = config?.scanTimeoutMs === undefined
    ? DEFAULT_SCAN_TIMEOUT_MS
    : typeof config.scanTimeoutMs === "number"
        && Number.isSafeInteger(config.scanTimeoutMs)
        && config.scanTimeoutMs >= 1_000
        && config.scanTimeoutMs <= MAX_SCAN_TIMEOUT_MS
      ? config.scanTimeoutMs
      : null;
  if (
    !host || port === null || connectTimeoutMs === null || scanTimeoutMs === null ||
    typeof config?.objectSource !== "function"
  ) {
    throw providerBoundaryError();
  }
  const objectSource = config.objectSource;

  function observation(
    request: ScannerProviderScanRequest,
    verdict: "clean" | "infected" | "error",
    extra: Readonly<{ reasonCode?: string; retryable?: boolean }> = {},
  ): unknown {
    return Object.freeze({
      data: Object.freeze({
        quarantineObject: request.quarantineObject,
        verdict,
        scannerAdapterId: request.scannerAdapterId,
        scannerVersion: request.scannerVersion,
        scannedChecksum: request.checksum,
        scannedAt: new Date().toISOString(),
        policyVersion: request.policyVersion,
        ...extra,
      }),
      error: null,
    });
  }

  return Object.freeze({
    async scanQuarantinedObject(
      rawRequest: ScannerProviderScanRequest,
    ): Promise<unknown> {
      const request = parseScanRequest(rawRequest);
      if (!request) throw providerBoundaryError();

      let bytes: Uint8Array | null;
      try {
        bytes = await objectSource(request.quarantineObject.objectKey);
      } catch {
        throw providerBoundaryError();
      }
      if (bytes === null) {
        // The exact quarantine object is absent from private storage; the
        // lease can never be satisfied, so the error is deliberately not
        // retryable.
        return observation(request, "error", {
          reasonCode: "provider_unavailable",
          retryable: false,
        });
      }
      if (bytes.byteLength < 1 || bytes.byteLength > DOCUMENT_MAX_BYTES) {
        throw providerBoundaryError();
      }

      const actualChecksum = createHash("sha256").update(bytes).digest("hex");
      if (actualChecksum !== request.checksum) {
        // The fetched bytes are not the leased bytes; no honest verdict can be
        // reported against the bound checksum.
        throw providerBoundaryError();
      }

      let verdict: ClamdVerdict;
      try {
        verdict = await runClamdSession(bytes, request.scannerVersion, {
          host,
          port,
          connectTimeoutMs,
          scanTimeoutMs,
        });
      } catch (error) {
        if (error instanceof ClamdSocketError) {
          if (error.kind === "timeout") {
            return observation(request, "error", {
              reasonCode: "provider_timeout",
              retryable: true,
            });
          }
          if (error.kind === "unavailable") {
            return observation(request, "error", {
              reasonCode: "provider_unavailable",
              retryable: true,
            });
          }
        }
        throw providerBoundaryError();
      }

      if (verdict.kind === "clean") return observation(request, "clean");
      if (verdict.kind === "infected") {
        return observation(request, "infected", { reasonCode: "malware_detected" });
      }
      if (verdict.failure.kind === "size_limit") {
        return observation(request, "error", {
          reasonCode: "unsupported_content",
          retryable: false,
        });
      }
      if (verdict.failure.kind === "version") {
        // The running engine is not the approved scanner version: refuse to
        // produce verdicts until the deployment/config drift is resolved.
        return observation(request, "error", {
          reasonCode: "provider_policy_error",
          retryable: false,
        });
      }
      return observation(request, "error", {
        reasonCode: "provider_unavailable",
        retryable: true,
      });
    },
  });
}
