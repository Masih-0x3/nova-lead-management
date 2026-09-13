// Stub for next/headers in the local seed bundle: the driver never executes
// auth/session code paths — only the canonical tenancy services and getDb.
export function cookies() {
  throw new Error("next/headers is unavailable outside the Next runtime");
}
export function headers() {
  throw new Error("next/headers is unavailable outside the Next runtime");
}
