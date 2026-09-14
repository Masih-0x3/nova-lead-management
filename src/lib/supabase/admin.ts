import "server-only";

import { createClient } from "@supabase/supabase-js";

const DEFAULT_REQUEST_TIMEOUT_MS = 15_000;
const MIN_REQUEST_TIMEOUT_MS = 250;
const MAX_REQUEST_TIMEOUT_MS = 120_000;

/**
 * Wraps fetch so the underlying request is genuinely aborted at a bounded
 * deadline — the socket is destroyed, not merely raced and left running. A
 * caller-provided Request/init signal is preserved: whichever of the deadline or the
 * caller signal fires first aborts the request.
 */
export function createBoundedFetch(timeoutMs: number, baseFetch: typeof fetch = fetch): typeof fetch {
  return (input, init) => {
    const deadline = AbortSignal.timeout(timeoutMs);
    const caller = init?.signal === undefined
      ? (input instanceof Request ? input.signal : null) : init.signal;
    const signal = caller ? AbortSignal.any([deadline, caller]) : deadline;
    return baseFetch(input, { ...init, signal });
  };
}

export function createSupabaseAdminClient(options?: { requestTimeoutMs?: number }) {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL?.trim();
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY?.trim();

  if (!url || !serviceRoleKey) {
    throw new Error("Supabase admin client is not configured");
  }
  const requestTimeoutMs = options?.requestTimeoutMs === undefined
    ? DEFAULT_REQUEST_TIMEOUT_MS
    : Number.isSafeInteger(options.requestTimeoutMs)
        && options.requestTimeoutMs >= MIN_REQUEST_TIMEOUT_MS
        && options.requestTimeoutMs <= MAX_REQUEST_TIMEOUT_MS
      ? options.requestTimeoutMs
      : null;
  if (requestTimeoutMs === null) {
    throw new Error("Supabase admin client request timeout is invalid");
  }

  return createClient(url, serviceRoleKey, {
    auth: {
      autoRefreshToken: false,
      persistSession: false,
    },
    global: { fetch: createBoundedFetch(requestTimeoutMs) },
  });
}
