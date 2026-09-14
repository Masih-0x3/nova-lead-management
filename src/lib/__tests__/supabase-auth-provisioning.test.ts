// Focused tests for the Supabase auth-user provisioner's bounded provider
// HTTP deadline (Kody #4009519379): the service-role getUserById call runs
// inside acceptInvitation's guarded transaction, so a hung provider request
// must be genuinely aborted — Promise.race alone would leave the socket open
// and the transaction holding locks.
import http from "node:http";
import type { AddressInfo } from "node:net";

import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { createSupabaseAdminClient, createBoundedFetch } from "@/lib/supabase/admin";
import { createSupabaseAuthUserProvisioner } from "@/lib/tenancy/supabase-auth-provisioning";
import { TenantInvitationError } from "@/lib/tenancy/provisioning";

const AUTH_ID = "f0000000-0000-4000-8000-0000000000aa";
const OTHER_ID = "f0000000-0000-4000-8000-0000000000bb";
const SERVICE_KEY = "synthetic-service-role-key-for-tests-only-0000";
const URL_ENV = "NEXT_PUBLIC_SUPABASE_URL";
const KEY_ENV = "SUPABASE_SERVICE_ROLE_KEY";

interface LoopbackServer {
  url: string;
  requestCount: () => number;
  closedSocketCount: () => number;
  close: () => Promise<void>;
}

async function startLoopback(handler: (req: http.IncomingMessage, res: http.ServerResponse) => void): Promise<LoopbackServer> {
  const sockets = new Set<import("node:net").Socket>();
  let closed = 0;
  let requests = 0;
  const server = http.createServer((req, res) => {
    requests += 1;
    handler(req, res);
  });
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.on("close", () => {
      if (sockets.delete(socket)) closed += 1;
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    requestCount: () => requests,
    closedSocketCount: () => closed,
    close: async () => {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

// Socket 'close' is async — poll briefly so the abort evidence can land.
async function eventually(predicate: () => boolean, timeoutMs = 2_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  return predicate();
}

function request(overrides: Record<string, string> = {}) {
  return {
    authIdentityId: AUTH_ID,
    invitationId: "f0000000-0000-4000-8000-0000000000cc",
    tenantId: "f0000000-0000-4000-8000-0000000000dd",
    correlationId: "corr-provisioner-test",
    ...overrides,
  };
}

describe("supabase auth user provisioner", () => {
  let savedUrl: string | undefined;
  let savedKey: string | undefined;
  const servers: LoopbackServer[] = [];

  beforeAll(() => {
    savedUrl = process.env[URL_ENV];
    savedKey = process.env[KEY_ENV];
    process.env[KEY_ENV] = SERVICE_KEY;
  });

  afterEach(async () => {
    delete process.env[URL_ENV];
    while (servers.length > 0) await servers.pop()!.close();
  });

  afterAll(() => {
    if (savedUrl === undefined) delete process.env[URL_ENV];
    else process.env[URL_ENV] = savedUrl;
    if (savedKey === undefined) delete process.env[KEY_ENV];
    else process.env[KEY_ENV] = savedKey;
  });

  function provision(options?: { requestTimeoutMs?: number }) {
    return createSupabaseAuthUserProvisioner(options);
  }

  it("verifies a valid identity and reports it as existing", async () => {
    const server = await startLoopback((req, res) => {
      expect(req.url).toBe(`/auth/v1/admin/users/${AUTH_ID}`);
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ id: AUTH_ID, aud: "authenticated", role: "authenticated" }));
    });
    servers.push(server);
    process.env[URL_ENV] = server.url;

    const outcome = await provision({ requestTimeoutMs: 5_000 }).ensureAuthUser(request());
    expect(outcome).toEqual({ provisioned: "existing", authIdentityId: AUTH_ID });
    expect(server.requestCount()).toBe(1);
  });

  it("rejects a provider response whose id does not match the requested identity", async () => {
    const server = await startLoopback((_req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ id: OTHER_ID }));
    });
    servers.push(server);
    process.env[URL_ENV] = server.url;

    const error = await provision({ requestTimeoutMs: 5_000 }).ensureAuthUser(request())
      .then(() => null, (thrown: unknown) => thrown as TenantInvitationError);
    expect(error).toBeInstanceOf(TenantInvitationError);
    expect(error?.code).toBe("SERVICE_MISCONFIGURED");
    expect(error?.retryable).toBe(true);
    expect(error?.message).not.toContain(OTHER_ID);
    expect(error?.message).not.toContain(SERVICE_KEY);
  });

  it("rejects a malformed identity without contacting the provider", async () => {
    const server = await startLoopback((_req, res) => {
      res.writeHead(500);
      res.end();
    });
    servers.push(server);
    process.env[URL_ENV] = server.url;

    await expect(provision().ensureAuthUser(request({ authIdentityId: "not-a-uuid" })))
      .rejects.toBeInstanceOf(TenantInvitationError);
    expect(server.requestCount()).toBe(0);
  });

  it("aborts a hung provider request at the bounded deadline", async () => {
    // The server accepts the connection and never answers. If the deadline
    // merely raced the promise the socket would stay open; the provider must
    // actually observe the connection being torn down.
    const server = await startLoopback(() => { /* never respond */ });
    servers.push(server);
    process.env[URL_ENV] = server.url;

    const started = Date.now();
    const error = await provision({ requestTimeoutMs: 300 }).ensureAuthUser(request())
      .then(() => null, (thrown: unknown) => thrown as TenantInvitationError);
    const elapsed = Date.now() - started;

    expect(error).toBeInstanceOf(TenantInvitationError);
    expect(error?.retryable).toBe(true);
    expect(elapsed).toBeLessThan(5_000);
    // The hung socket was really aborted, not just abandoned.
    expect(await eventually(() => server.closedSocketCount() > 0)).toBe(true);
  }, 15_000);

  it("sanitizes provider transport failures", async () => {
    // A free-but-closed loopback port refuses the connection.
    const server = await startLoopback((_req, res) => res.end());
    const refusedUrl = server.url;
    await server.close();
    process.env[URL_ENV] = refusedUrl;

    const error = await provision({ requestTimeoutMs: 2_000 }).ensureAuthUser(request())
      .then(() => null, (thrown: unknown) => thrown as TenantInvitationError);
    expect(error).toBeInstanceOf(TenantInvitationError);
    expect(error?.code).toBe("SERVICE_MISCONFIGURED");
    expect(error?.retryable).toBe(true);
    expect(error?.message).not.toContain(SERVICE_KEY);
    expect(error?.message).not.toContain(refusedUrl);
  });

  it("rejects out-of-bounds provider deadlines at construction", () => {
    expect(() => provision({ requestTimeoutMs: 0 })).toThrow(/timeout/i);
    expect(() => provision({ requestTimeoutMs: 10 })).toThrow(/timeout/i);
    expect(() => provision({ requestTimeoutMs: 300_000 })).toThrow(/timeout/i);
    expect(() => provision({ requestTimeoutMs: Number.NaN })).toThrow(/timeout/i);
  });

  it("fails fast with a sanitized error when the provider is not configured", async () => {
    const saved = process.env[KEY_ENV];
    delete process.env[KEY_ENV];
    try {
      const error = await provision().ensureAuthUser(request())
        .then(() => null, (thrown: unknown) => thrown as TenantInvitationError);
      expect(error).toBeInstanceOf(TenantInvitationError);
      expect(error?.code).toBe("SERVICE_MISCONFIGURED");
      expect(error?.retryable).toBe(true);
    } finally {
      process.env[KEY_ENV] = saved;
    }
  });
});

describe("createBoundedFetch (provider HTTP deadline)", () => {
  const servers: LoopbackServer[] = [];
  afterEach(async () => {
    while (servers.length > 0) await servers.pop()!.close();
  });

  it("aborts the underlying socket at the deadline", async () => {
    const server = await startLoopback(() => { /* never respond */ });
    servers.push(server);
    const wrapped = createBoundedFetch(200);
    const started = Date.now();
    await expect(wrapped(`${server.url}/hang`)).rejects.toThrow();
    expect(Date.now() - started).toBeLessThan(5_000);
    expect(await eventually(() => server.closedSocketCount() > 0)).toBe(true);
  }, 15_000);

  it("preserves a caller abort signal alongside the deadline", async () => {
    const server = await startLoopback(() => { /* never respond */ });
    servers.push(server);
    const wrapped = createBoundedFetch(60_000); // deadline far away
    const caller = new AbortController();
    const started = Date.now();
    const pending = wrapped(`${server.url}/hang`, { signal: caller.signal });
    setTimeout(() => { caller.abort(new Error("caller cancelled")); }, 40);
    const error = await pending.then(() => null, (thrown: unknown) => thrown as Error);
    expect(error).toBeTruthy();
    expect(Date.now() - started).toBeLessThan(5_000);
    expect(await eventually(() => server.closedSocketCount() > 0)).toBe(true);
  }, 15_000);

  it("applies the bounded fetch inside the admin client", async () => {
    const server = await startLoopback(() => { /* never respond */ });
    servers.push(server);
    process.env[URL_ENV] = server.url;
    process.env[KEY_ENV] = SERVICE_KEY;
    const admin = createSupabaseAdminClient({ requestTimeoutMs: 250 });
    const started = Date.now();
    const { data, error } = await admin.auth.admin.getUserById(AUTH_ID);
    expect(error).toBeTruthy();
    expect(data.user).toBeNull();
    expect(Date.now() - started).toBeLessThan(5_000);
    expect(await eventually(() => server.closedSocketCount() > 0)).toBe(true);
  }, 15_000);
});
