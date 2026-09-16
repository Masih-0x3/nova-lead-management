vi.mock("server-only", () => ({}));

import { createHash } from "node:crypto";
import { createServer, type Server, type Socket } from "node:net";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  executeQuarantineScan,
  type QuarantinedDocumentVersion,
} from "@/lib/documents";
import { createClamdScannerProvider } from "@/lib/documents/clamd-scanner-provider";
import { ScannerProviderAdapter } from "@/lib/documents/scanner-provider-adapter";

const TENANT_ID = "11111111-1111-4111-8111-111111111111";
const DOCUMENT_ID = "22222222-2222-4222-8222-222222222222";
const VERSION_ID = "33333333-3333-4333-8333-333333333333";
const OBJECT_KEY =
  `tenants/${TENANT_ID}/documents/${DOCUMENT_ID}/versions/${VERSION_ID}/original`;
const POLICY_VERSION = "launch-v1";
const SCANNER_ID = "clamd-instream";
const SCANNER_VERSION = "1.5.4";

const CLEAN_BYTES = new TextEncoder().encode("name,role\nAda,founder\n");
const EICAR_BYTES = new TextEncoder().encode(
  "X5O!P%@AP[4\\PZX54(P^)7CC)7}$EICAR-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*",
);
const CLEAN_CHECKSUM = createHash("sha256").update(CLEAN_BYTES).digest("hex");
const EICAR_CHECKSUM = createHash("sha256").update(EICAR_BYTES).digest("hex");

type StubBehavior = Readonly<{
  /** INSTREAM verdict: ok / found / error line / hold the reply / socket games. */
  verdict:
    | "ok" | "found" | "garbage" | "hang" | "trickle" | "oversized"
    | "early_close" | "pause_close" | "ok_then_garbage" | "found_then_garbage"
    | "ok_then_partial_garbage";
  signature?: string;
  /** Reply VERSION with a different engine version. */
  version?: string;
  /** Reply to VERSION with this seq id instead of 1 (mismatch probe). */
  versionReplySeq?: number;
  /** Send an unframed (non-session) reply to VERSION. */
  unframedVersionReply?: boolean;
}>;

type StartedStub = Readonly<{
  port: number;
  /** Raw instream frames captured on the wire, in order. */
  frames: () => readonly Readonly<{ length: number; payload: Buffer }>[];
  close: () => Promise<void>;
}>;

const servers: Server[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) =>
    new Promise<void>((resolve) => server.close(() => resolve()))
  ));
});

/**
 * Emulates real clamd wire behavior: without IDSESSION the daemon answers one
 * command then closes the connection; inside a session every reply is framed
 * "<seq>: <payload>" and END closes the socket.
 */
function startClamdStub(behavior: StubBehavior): Promise<StartedStub> {
  const frames: { length: number; payload: Buffer }[] = [];
  const version = behavior.version ?? "ClamAV 1.5.4/28000/rehearsal";
  const server = createServer((socket: Socket) => {
    let buffer = Buffer.alloc(0);
    let inSession = false;
    let seq = 0;
    let instreamOpen = false;
    let answered = false;

    const framed = (payload: string) => `${seq}: ${payload}\n`;

    const verdictReply = () => {
      switch (behavior.verdict) {
        case "ok": socket.write(framed("stream: OK")); return;
        case "ok_then_partial_garbage": socket.write(`${framed("stream: OK")}garbage`); return;
        case "found":
          socket.write(framed(`stream: ${behavior.signature ?? "Eicar-Test-Signature"} FOUND`));
          return;
        case "garbage": socket.write(framed("GARBAGE NOT A VERDICT")); return;
        case "oversized":
          socket.write(framed(`stream: ${"X".repeat(8 * 1024)}`));
          return;
        case "trickle": {
          // One byte at a time: an inactivity timer would keep resetting, the
          // absolute session deadline must still fire.
          const line = framed("stream: OK");
          let i = 0;
          const drip = () => {
            if (i >= line.length) return;
            socket.write(line[i]);
            i += 1;
            setTimeout(drip, 150);
          };
          drip();
          return;
        }
        case "early_close": socket.destroy(); return;
        // Same-chunk poisoning: one write carries a valid framed verdict plus
        // a trailing malformed or out-of-sequence record. The client must
        // validate the whole chunk before trusting the verdict.
        case "ok_then_garbage":
          socket.write(`${framed("stream: OK")}NOT A FRAMED RECORD\n`);
          return;
        case "found_then_garbage":
          socket.write(
            `${framed(`stream: ${behavior.signature ?? "Eicar-Test-Signature"} FOUND`)}9: stream: OK\n`,
          );
          return;
        case "hang": default: return; // never replies inside the scan window
      }
    };

    const handleLine = (line: string) => {
      if (inSession) {
        seq += 1;
        if (line === "nEND") {
          socket.destroy();
          return;
        }
        if (line === "nVERSION") {
          const replySeq = behavior.versionReplySeq ?? seq;
          socket.write(
            behavior.unframedVersionReply
              ? `${version}\n`
              : `${replySeq}: ${version}\n`,
          );
          return;
        }
        if (line === "nPING") {
          socket.write(framed("PONG"));
          return;
        }
        if (line === "nINSTREAM") {
          instreamOpen = true;
          if (behavior.verdict === "pause_close") {
            // Stop reading so client-side writes hit real backpressure, then
            // drop the connection mid-stream: the pending drain must settle
            // through the session teardown path, never hang.
            socket.pause();
            setTimeout(() => socket.destroy(), 300);
          }
          return;
        }
        socket.write(framed("UNKNOWN COMMAND ERROR"));
        return;
      }
      // Non-session mode: real clamd answers one command, then closes.
      if (answered) {
        socket.destroy();
        return;
      }
      if (line === "nIDSESSION") {
        inSession = true;
        return; // IDSESSION produces no reply
      }
      answered = true;
      if (line === "nVERSION") {
        socket.write(`${version}\n`, () => socket.end());
        return;
      }
      socket.write("UNKNOWN COMMAND\n", () => socket.end());
    };

    socket.on("data", (chunk: Buffer) => {
      buffer = Buffer.concat([buffer, chunk]);
      for (;;) {
        if (instreamOpen) {
          if (buffer.byteLength < 4) return;
          const length = buffer.readUInt32BE(0);
          if (buffer.byteLength < 4 + length) return;
          frames.push({ length, payload: Buffer.from(buffer.subarray(4, 4 + length)) });
          buffer = buffer.subarray(4 + length);
          if (length === 0) {
            instreamOpen = false;
            verdictReply();
          }
          continue;
        }
        const newline = buffer.indexOf(0x0a);
        if (newline === -1) return;
        const line = buffer.subarray(0, newline).toString("utf8");
        buffer = buffer.subarray(newline + 1);
        handleLine(line);
        if (socket.destroyed) return;
      }
    });
    socket.on("error", () => undefined);
  });
  servers.push(server);
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        reject(new Error("stub did not bind"));
        return;
      }
      resolve(Object.freeze({
        port: address.port,
        frames: () => frames,
        close: () => new Promise<void>((done) => server.close(() => done())),
      }));
    });
  });
}

function quarantined(checksum: string): QuarantinedDocumentVersion {
  return Object.freeze({
    tenantId: TENANT_ID,
    documentId: DOCUMENT_ID,
    versionId: VERSION_ID,
    checksum,
    state: "quarantined" as const,
    objectKey: OBJECT_KEY,
  });
}

function providerFor(port: number, bytes: Uint8Array | null, overrides: Readonly<{
  scanTimeoutMs?: number;
}> = {}) {
  return new ScannerProviderAdapter(
    createClamdScannerProvider({
      host: "127.0.0.1",
      port,
      connectTimeoutMs: 1_000,
      scanTimeoutMs: overrides.scanTimeoutMs ?? 10_000,
      objectSource: async (objectKey) =>
        objectKey === OBJECT_KEY ? bytes : null,
    }),
    {
      enabled: true,
      approvedScannerId: SCANNER_ID,
      approvedScannerVersion: SCANNER_VERSION,
      approvedPolicyVersion: POLICY_VERSION,
    },
  );
}

describe("clamd scanner provider", () => {
  it("reports clean for clean bytes through a real session exchange", async () => {
    const stub = await startClamdStub({ verdict: "ok" });
    const result = await executeQuarantineScan(
      quarantined(CLEAN_CHECKSUM),
      POLICY_VERSION,
      providerFor(stub.port, CLEAN_BYTES),
    );
    expect(result.version.state).toBe("clean");
    expect(result.scan).toMatchObject({
      verdict: "clean",
      scannerAdapterId: SCANNER_ID,
      scannerVersion: SCANNER_VERSION,
      scannedChecksum: CLEAN_CHECKSUM,
      policyVersion: POLICY_VERSION,
    });
    const frames = stub.frames();
    expect(frames.at(-1)?.length).toBe(0);
    expect(Buffer.concat(frames.slice(0, -1).map((frame) => frame.payload)).equals(
      Buffer.from(CLEAN_BYTES),
    )).toBe(true);
  });

  it("reports infected for the standard EICAR signature reply", async () => {
    const stub = await startClamdStub({ verdict: "found" });
    const result = await executeQuarantineScan(
      quarantined(EICAR_CHECKSUM),
      POLICY_VERSION,
      providerFor(stub.port, EICAR_BYTES),
    );
    expect(result.version.state).toBe("infected");
    expect(result.scan).toMatchObject({
      verdict: "infected",
      reasonCode: "malware_detected",
      scannedChecksum: EICAR_CHECKSUM,
    });
    expect(result.scan.retryable).not.toBe(true);
  });

  it("fails closed on an unparseable session payload", async () => {
    const stub = await startClamdStub({ verdict: "garbage" });
    const result = await executeQuarantineScan(
      quarantined(CLEAN_CHECKSUM),
      POLICY_VERSION,
      providerFor(stub.port, CLEAN_BYTES),
    );
    expect(result.version.state).toBe("scanner_error");
    expect(result.scan).toMatchObject({
      verdict: "error",
      reasonCode: "adapter_error",
      retryable: true,
    });
  });

  it("maps a silent clamd to a retryable provider timeout", async () => {
    const stub = await startClamdStub({ verdict: "hang" });
    const result = await executeQuarantineScan(
      quarantined(CLEAN_CHECKSUM),
      POLICY_VERSION,
      providerFor(stub.port, CLEAN_BYTES, { scanTimeoutMs: 1_000 }),
    );
    expect(result.version.state).toBe("scanner_error");
    expect(result.scan).toMatchObject({
      verdict: "error",
      reasonCode: "provider_timeout",
      retryable: true,
    });
  });

  it("the absolute session deadline fires under a byte-per-interval trickle", async () => {
    const stub = await startClamdStub({ verdict: "trickle" });
    const result = await executeQuarantineScan(
      quarantined(CLEAN_CHECKSUM),
      POLICY_VERSION,
      providerFor(stub.port, CLEAN_BYTES, { scanTimeoutMs: 1_000 }),
    );
    expect(result.version.state).toBe("scanner_error");
    expect(result.scan).toMatchObject({
      verdict: "error",
      reasonCode: "provider_timeout",
      retryable: true,
    });
  });

  it("settles a pending write when the socket closes during backpressure", async () => {
    const stub = await startClamdStub({ verdict: "pause_close" });
    const bigBytes = Buffer.alloc(2 * 1024 * 1024, 0x61);
    const result = await executeQuarantineScan(
      quarantined(createHash("sha256").update(bigBytes).digest("hex")),
      POLICY_VERSION,
      providerFor(stub.port, bigBytes),
    );
    expect(result.version.state).toBe("scanner_error");
    expect(result.scan).toMatchObject({
      verdict: "error",
      reasonCode: "provider_unavailable",
      retryable: true,
    });
  });

  it("maps a mid-stream connection close to unavailable, not a verdict", async () => {
    const stub = await startClamdStub({ verdict: "early_close" });
    const result = await executeQuarantineScan(
      quarantined(CLEAN_CHECKSUM),
      POLICY_VERSION,
      providerFor(stub.port, CLEAN_BYTES),
    );
    expect(result.version.state).toBe("scanner_error");
    expect(result.scan).toMatchObject({
      verdict: "error",
      reasonCode: "provider_unavailable",
      retryable: true,
    });
  });

  it("rejects an oversized reply record even when terminated", async () => {
    const stub = await startClamdStub({ verdict: "oversized" });
    const result = await executeQuarantineScan(
      quarantined(CLEAN_CHECKSUM),
      POLICY_VERSION,
      providerFor(stub.port, CLEAN_BYTES),
    );
    expect(result.version.state).toBe("scanner_error");
    expect(result.scan).toMatchObject({
      verdict: "error",
      reasonCode: "adapter_error",
    });
  });

  it("rejects a reply id that does not match the in-flight command", async () => {
    const stub = await startClamdStub({
      verdict: "ok",
      versionReplySeq: 99,
    });
    const result = await executeQuarantineScan(
      quarantined(CLEAN_CHECKSUM),
      POLICY_VERSION,
      providerFor(stub.port, CLEAN_BYTES),
    );
    expect(result.version.state).toBe("scanner_error");
    expect(result.scan).toMatchObject({
      verdict: "error",
      reasonCode: "adapter_error",
    });
  });

  it("rejects an unframed reply inside the session", async () => {
    const stub = await startClamdStub({
      verdict: "ok",
      unframedVersionReply: true,
    });
    const result = await executeQuarantineScan(
      quarantined(CLEAN_CHECKSUM),
      POLICY_VERSION,
      providerFor(stub.port, CLEAN_BYTES),
    );
    expect(result.version.state).toBe("scanner_error");
    expect(result.scan).toMatchObject({
      verdict: "error",
      reasonCode: "adapter_error",
    });
  });

  it("never reports clean when the verdict shares a chunk with malformed bytes", async () => {
    const stub = await startClamdStub({ verdict: "ok_then_garbage" });
    const result = await executeQuarantineScan(
      quarantined(CLEAN_CHECKSUM),
      POLICY_VERSION,
      providerFor(stub.port, CLEAN_BYTES),
    );
    expect(result.version.state).toBe("scanner_error");
    expect(result.scan).toMatchObject({
      verdict: "error",
      reasonCode: "adapter_error",
    });
  });

  it("never reports clean when unframed trailing bytes have no newline yet", async () => {
    const stub = await startClamdStub({ verdict: "ok_then_partial_garbage" });
    const result = await executeQuarantineScan(
      quarantined(CLEAN_CHECKSUM),
      POLICY_VERSION,
      providerFor(stub.port, CLEAN_BYTES),
    );
    expect(result.version.state).toBe("scanner_error");
    expect(result.scan).toMatchObject({ verdict: "error", reasonCode: "adapter_error" });
  });

  it("never reports infected when FOUND shares a chunk with an out-of-sequence record", async () => {
    const stub = await startClamdStub({ verdict: "found_then_garbage" });
    const result = await executeQuarantineScan(
      quarantined(EICAR_CHECKSUM),
      POLICY_VERSION,
      providerFor(stub.port, EICAR_BYTES),
    );
    expect(result.version.state).toBe("scanner_error");
    expect(result.scan).toMatchObject({
      verdict: "error",
      reasonCode: "adapter_error",
    });
  });

  it("maps an unreachable clamd to a retryable provider_unavailable", async () => {
    const result = await executeQuarantineScan(
      quarantined(CLEAN_CHECKSUM),
      POLICY_VERSION,
      providerFor(1, CLEAN_BYTES),
    );
    expect(result.version.state).toBe("scanner_error");
    expect(result.scan).toMatchObject({
      verdict: "error",
      reasonCode: "provider_unavailable",
      retryable: true,
    });
  });

  it("refuses a clamd engine that is not the approved scanner version", async () => {
    const stub = await startClamdStub({
      verdict: "ok",
      version: "ClamAV 9.9.9/1/rehearsal",
    });
    const result = await executeQuarantineScan(
      quarantined(CLEAN_CHECKSUM),
      POLICY_VERSION,
      providerFor(stub.port, CLEAN_BYTES),
    );
    expect(result.version.state).toBe("scanner_error");
    expect(result.scan).toMatchObject({
      verdict: "error",
      reasonCode: "provider_policy_error",
      retryable: false,
    });
  });

  it("refuses to report a verdict when fetched bytes do not match the leased checksum", async () => {
    const stub = await startClamdStub({ verdict: "ok" });
    const result = await executeQuarantineScan(
      quarantined(CLEAN_CHECKSUM),
      POLICY_VERSION,
      providerFor(stub.port, new TextEncoder().encode("tampered bytes")),
    );
    expect(result.version.state).toBe("scanner_error");
    expect(result.scan).toMatchObject({
      verdict: "error",
      reasonCode: "adapter_error",
    });
    expect(stub.frames()).toHaveLength(0);
  });

  it("reports a missing quarantine object as non-retryable unavailable", async () => {
    const stub = await startClamdStub({ verdict: "ok" });
    const result = await executeQuarantineScan(
      quarantined(CLEAN_CHECKSUM),
      POLICY_VERSION,
      providerFor(stub.port, null),
    );
    expect(result.version.state).toBe("scanner_error");
    expect(result.scan).toMatchObject({
      verdict: "error",
      reasonCode: "provider_unavailable",
      retryable: false,
    });
  });
});
