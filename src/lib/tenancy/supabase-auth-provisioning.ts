import "server-only";

import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { TenantInvitationError, type TenantAuthUserProvisioner } from "@/lib/tenancy/provisioning";
import { authIdentityIdSchema } from "@/lib/tenancy/schemas";

/**
 * Production auth provisioner: verifies the authenticated identity against the
 * Supabase project using the service-role client, and creates the auth user
 * when the provider is expected to have issued one at acceptance time (owner
 * path). Never stores provider secrets or raw recipient material.
 */
export function createSupabaseAuthUserProvisioner(): TenantAuthUserProvisioner {
  return {
    ensureAuthUser: async (request) => {
      const parsed = authIdentityIdSchema.safeParse(request.authIdentityId);
      if (!parsed.success) {
        throw new TenantInvitationError("SERVICE_MISCONFIGURED", "The auth identity is invalid.", true);
      }
      const authIdentityId = parsed.data;

      let admin;
      try {
        admin = createSupabaseAdminClient();
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
