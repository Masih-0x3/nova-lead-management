export const DEV_APP_URL = "http://localhost:3000";

function normalizeAppUrl(value: string | undefined | null): string | null {
  const trimmed = value?.trim().replace(/\/+$/, "");
  return trimmed ? trimmed : null;
}

export const CANONICAL_APP_URL = normalizeAppUrl(process.env.NEXT_PUBLIC_APP_URL) ?? DEV_APP_URL;

export function resolveCanonicalAppUrl(
  requestOrigin?: string | null,
  env: { NEXT_PUBLIC_APP_URL?: string; NODE_ENV?: string } = process.env,
): string {
  const configured = normalizeAppUrl(env.NEXT_PUBLIC_APP_URL);
  if (configured) return configured;

  if (env.NODE_ENV === "production") {
    throw new Error("NEXT_PUBLIC_APP_URL is required in production to build auth links.");
  }

  return normalizeAppUrl(requestOrigin) ?? DEV_APP_URL;
}

export function buildAuthCallbackUrl(nextPath: string, appUrl: string): string {
  const safeNext = nextPath.startsWith("/") ? nextPath : `/${nextPath}`;
  return `${appUrl}/auth/callback?next=${encodeURIComponent(safeNext)}`;
}

export function buildPasswordRecoveryUrl(nextPath: string, appUrl: string): string {
  return buildAuthCallbackUrl(nextPath, appUrl);
}

export function buildWelcomeInviteUrl(nextPath: string, appUrl: string): string {
  return buildAuthCallbackUrl(nextPath, appUrl);
}
