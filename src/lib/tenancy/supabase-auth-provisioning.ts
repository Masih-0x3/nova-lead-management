import "server-only";

import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { TenantInvitationError, type TenantAuthUserProvisioner } from "@/lib/tenancy/provisioning";
import { authIdentityIdSchema } from "@/lib/tenancy/schemas";

// The identity check runs inside acceptInvitation's guarded transaction; a
// hung provider request would hold transaction locks indefinitely. The
// deadline must be bounded and the request actually aborted (not merely
// raced). Injectable for tests; bounds are validated at construction.
const DEFAULT_PROVIDER_TIMEOUT_MS = 10_000;
const MIN_PROVIDER_TIMEOUT_MS = 250;
const MAX_PROVIDER_TIMEOUT_MS = 60_000;

/**
 * Production auth provisioner: verifies the authenticated identity against the
 * Supabase project using the service-role client, and creates the auth user
 * when the provider is expected to have issued one at acceptance time (owner
 * path). Never stores provider secrets or raw recipient material.
 */
export function createSupabaseAuthUserProvisioner(options?: {
  /** Provider HTTP deadline in ms; default 10s, bounded 250ms..60s. */
  requestTimeoutMs?: number;
}): TenantAuthUserProvisioner {
  const requestTimeoutMs = options?.requestTimeoutMs === undefined
    ? DEFAULT_PROVIDER_TIMEOUT_MS
    : Number.isSafeInteger(options.requestTimeoutMs)
        && options.requestTimeoutMs >= MIN_PROVIDER_TIMEOUT_MS
        && options.requestTimeoutMs <= MAX_PROVIDER_TIMEOUT_MS
      ? options.requestTimeoutMs
      : null;
  if (requestTimeoutMs === null) {
    throw new Error("Supabase auth provisioner request timeout is invalid");
  }
  return {
    ensureAuthUser: async (request) => {
      const parsed = authIdentityIdSchema.safeParse(request.authIdentityId);
      if (!parsed.success) {
        throw new TenantInvitationError("SERVICE_MISCONFIGURED", "The auth identity is invalid.", true);
      }
      const authIdentityId = parsed.data;

      let admin;
      try {
        admin = createSupabaseAdminClient({ requestTimeoutMs });
      } catch {
        throw new TenantInvitationError("SERVICE_MISCONFIGURED", "The auth provider is unavailable.", true);
      }

      const { data, error } = await admin.auth.admin.getUserById(authIdentityId);
      if (error || !data.user) {
        throw new TenantInvitationError("SERVICE_MISCONFIGURED", "The auth provider could not resolve the identity.", true);
      }
      if (data.user.id !== authIdentityId) {
        throw new TenantInvitationError("SERVICE_MISCONFIGURED", "The auth provider returned an inconsistent identity.", true);
      }
      return { authIdentityId, provisioned: "existing" };
    },
  };
}
