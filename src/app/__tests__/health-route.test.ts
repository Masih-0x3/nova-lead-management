import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const dbMocks = vi.hoisted(() => ({
  getDb: vi.fn(),
  isTransientDbError: vi.fn(() => false),
  withDbStatementTimeout: vi.fn((_timeoutMs: number, fn: () => Promise<unknown>) => fn()),
}));

const queryMocks = vi.hoisted(() => ({
  ensureDbReady: vi.fn(),
  getSettings: vi.fn(),
}));

const workerAuthMocks = vi.hoisted(() => ({
  getConfiguredWorkerCronSecrets: vi.fn(() => ["secret"]),
}));

const routeTimingMocks = vi.hoisted(() => ({
  logRouteTiming: vi.fn(),
  startRouteTiming: vi.fn(),
}));

vi.mock("@/lib/db/index", () => dbMocks);
vi.mock("@/lib/db/queries", () => queryMocks);
vi.mock("@/lib/internal-worker-auth", () => workerAuthMocks);
vi.mock("@/lib/route-timing", () => ({
  startRouteTiming: routeTimingMocks.startRouteTiming,
}));

import { GET } from "@/app/api/health/route";

describe("/api/health", () => {
  beforeEach(() => {
    process.env.NEXT_PUBLIC_SUPABASE_URL = "https://supabase.example";
    process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY = "publishable";
    process.env.NEXT_PUBLIC_APP_URL = "https://example.com";
    process.env.DATABASE_URL = "postgres://example";
    process.env.SUPABASE_SERVICE_ROLE_KEY = "service-role";

    dbMocks.getDb.mockReset();
    dbMocks.getDb.mockResolvedValue({
      prepare: vi.fn(() => ({
        get: vi.fn(() => ({ ok: 1 })),
      })),
    });
    dbMocks.isTransientDbError.mockReturnValue(false);
    dbMocks.withDbStatementTimeout.mockReset();
    dbMocks.withDbStatementTimeout.mockImplementation((_timeoutMs: number, fn: () => Promise<unknown>) => fn());

    queryMocks.ensureDbReady.mockReset();
    queryMocks.getSettings.mockReset();
    queryMocks.getSettings.mockResolvedValue({
      ai_model: "test-model",
      openai_api_key_configured: true,
      google_places_api_key_configured: true,
    });

    workerAuthMocks.getConfiguredWorkerCronSecrets.mockReturnValue(["secret"]);
    routeTimingMocks.logRouteTiming.mockReset();
    routeTimingMocks.startRouteTiming.mockReturnValue(routeTimingMocks.logRouteTiming);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("returns only coarse public health fields while preserving no-store headers and status timing", async () => {
    const response = await GET();
    const json = await response.json();

    expect(response.status).toBe(200);
    expect(json.status).toBe("ok");
    expect(typeof json.checkedAt).toBe("string");
    expect(json).not.toHaveProperty("runtime");
    expect(json).not.toHaveProperty("checks");
    expect(json).not.toHaveProperty("durationMs");
    expect(Object.keys(json).sort()).toEqual(["checkedAt", "status"]);
    expect(response.headers.get("Cache-Control")).toContain("no-store");
    expect(queryMocks.getSettings).toHaveBeenCalledTimes(1);
    expect(routeTimingMocks.logRouteTiming).toHaveBeenCalledWith(200, { healthStatus: "ok" });
  });

  it("returns a bounded 503 response when a health dependency never settles", async () => {
    vi.useFakeTimers();
    queryMocks.getSettings.mockImplementation(() => new Promise(() => {}));

    const responsePromise = GET();
    await vi.advanceTimersByTimeAsync(6_000);
    const response = await responsePromise;
    const json = await response.json();

    expect(response.status).toBe(503);
    expect(json.status).toBe("error");
    expect(queryMocks.getSettings).toHaveBeenCalledTimes(1);
    expect(routeTimingMocks.logRouteTiming).toHaveBeenCalledWith(503, { healthStatus: "error" });
  });

  it("redacts dependency errors and configured secrets from the public 503 response", async () => {
    const databaseSecret = "postgres://health-user:database-secret@example.invalid/app";
    const providerSecret = "sk-provider-secret";
    queryMocks.ensureDbReady.mockRejectedValue(new Error(`Database rejected ${databaseSecret}`));
    queryMocks.getSettings.mockRejectedValue(new Error(`Provider rejected ${providerSecret}`));

    const response = await GET();
    const json = await response.json();
    const serialized = JSON.stringify(json);

    expect(response.status).toBe(503);
    expect(json.status).toBe("error");
    expect(Object.keys(json).sort()).toEqual(["checkedAt", "status"]);
    expect(serialized).not.toContain(databaseSecret);
    expect(serialized).not.toContain(providerSecret);
    expect(serialized).not.toContain(process.env.SUPABASE_SERVICE_ROLE_KEY);
    expect(response.headers.get("Cache-Control")).toBe("private, no-store, max-age=0, must-revalidate, no-transform");
    expect(response.headers.get("Pragma")).toBe("no-cache");
    expect(response.headers.get("Expires")).toBe("0");
    expect(routeTimingMocks.logRouteTiming).toHaveBeenCalledWith(503, { healthStatus: "error" });
  });

  it("reports ok when NEXT_PUBLIC_APP_URL matches the request origin", async () => {
    process.env.NEXT_PUBLIC_APP_URL = "https://example.com/";
    const response = await GET(new Request("https://example.com/api/health"));

    expect(response.status).toBe(200);
    expect((await response.json()).status).toBe("ok");
  });

  it("degrades when NEXT_PUBLIC_APP_URL differs from the forwarded request origin", async () => {
    const response = await GET(new Request("http://internal:3000/api/health", {
      headers: { "x-forwarded-host": "stale.example.com", "x-forwarded-proto": "https" },
    }));

    expect(response.status).toBe(200);
    expect((await response.json()).status).toBe("degraded");
  });

  it("degrades when NEXT_PUBLIC_APP_URL includes a path on the request host", async () => {
    process.env.NEXT_PUBLIC_APP_URL = "https://example.com/app";
    const response = await GET(new Request("https://example.com/api/health"));

    expect((await response.json()).status).toBe("degraded");
  });

  it("degrades when NEXT_PUBLIC_APP_URL is missing", async () => {
    process.env.NEXT_PUBLIC_APP_URL = "";
    const response = await GET(new Request("https://example.com/api/health"));

    expect(response.status).toBe(200);
    expect((await response.json()).status).toBe("degraded");
  });
});
