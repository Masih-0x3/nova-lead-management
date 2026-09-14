// One-shot readiness + provisioning probe for the L03 rehearsal network.
// Runs inside a disposable container on the rehearsal podman network:
//   1. waits for supabase/storage-api /status
//   2. creates the private quarantine bucket and verifies it is not public
//   3. waits for clamd on its TCP socket and captures the engine VERSION line
// Prints structured lines the orchestrator parses; exits non-zero on failure.
import { connect } from "node:net";

const storage = process.env.STORAGE_ORIGIN ?? "";
const serviceKey = process.env.SERVICE_KEY ?? "";
const bucket = process.env.BUCKET ?? "";
const clamdHost = process.env.CLAMD_HOST ?? "";
const clamdPort = Number(process.env.CLAMD_PORT ?? "3310");

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitStorage() {
  for (let attempt = 0; attempt < 240; attempt += 1) {
    try {
      const res = await fetch(`${storage}/status`, {
        signal: AbortSignal.timeout(2_000),
      });
      if (res.ok) {
        console.log(`storage_status=${res.status}`);
        return;
      }
    } catch {}
    await sleep(500);
  }
  throw new Error("storage-api did not become healthy");
}

async function ensureBucket() {
  const res = await fetch(`${storage}/bucket`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${serviceKey}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({ name: bucket, public: false }),
    signal: AbortSignal.timeout(10_000),
  });
  const text = await res.text();
  if (!res.ok && !/already exists/i.test(text)) {
    throw new Error(`bucket create failed: ${res.status} ${text}`);
  }
  const info = await fetch(`${storage}/bucket/${bucket}`, {
    headers: { authorization: `Bearer ${serviceKey}` },
    signal: AbortSignal.timeout(10_000),
  });
  const body = await info.json();
  console.log(`bucket_name=${body.name} public=${body.public}`);
  if (body.public !== false) throw new Error("bucket is not private");
}

function clamdVersionOnce() {
  return new Promise((resolve, reject) => {
    const socket = connect({ host: clamdHost, port: clamdPort });
    socket.setTimeout(3_000);
    let buffered = Buffer.alloc(0);
    const finish = (fn) => {
      socket.destroy();
      fn();
    };
    socket.once("connect", () => socket.write("nVERSION\n"));
    socket.on("data", (chunk) => {
      buffered = Buffer.concat([buffered, chunk]);
      const end = buffered.indexOf(0x0a);
      if (end !== -1) finish(() => resolve(buffered.subarray(0, end).toString("utf8")));
    });
    socket.once("timeout", () => finish(() => reject(new Error("clamd timeout"))));
    socket.once("error", (error) => finish(() => reject(error)));
    socket.once("close", () => finish(() => reject(new Error("clamd closed"))));
  });
}

async function waitClamd() {
  let lastError = "";
  for (let attempt = 0; attempt < 420; attempt += 1) {
    try {
      const line = await clamdVersionOnce();
      if (/^ClamAV [0-9]+\.[0-9]+\.[0-9]+\//u.test(line.trimEnd())) {
        console.log(`clamd_version=${line.trim()}`);
        return;
      }
      lastError = `unexpected reply: ${line}`;
    } catch (error) {
      lastError = String(error);
    }
    await sleep(500);
  }
  throw new Error(`clamd did not become ready (${lastError})`);
}

await waitStorage();
await ensureBucket();
await waitClamd();
console.log("probe_ok=1");
