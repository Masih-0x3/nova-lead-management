/**
 * L-02 Postgres feature-policy adapter.
 *
 * The twin of `createLocalTenantFeatureService` for the DATABASE_URL runtime.
 * Every port runs inside `withTenantDbContext`, so the accepted member (or
 * worker) AsyncLocalStorage context is installed as transaction-local GUCs
 * before any SQL executes — the runtime role never receives table authority
 * it can use outside that boundary.
 *
 * Reads flow through the member-select RLS policies; the mutation goes through
 * the SECURITY DEFINER `novatrade_apply_tenant_feature_policy_change`, which
 * re-validates the same member context database-side, requires tenant-wide
 * owner/admin authority, and CAS-updates the policy + audit row atomically.
 *
 * Unlike the local adapter this service takes no actor binding: the accepted
 * member context already carries the server-derived identity, membership,
 * role, and binding — trusting a caller-supplied actor would weaken that.
 */
import { withTenantDbContext, type DbClient } from "@/lib/db";
import { isTenantRoleCapable } from "@/lib/permissions";
import { getTenantContext } from "@/lib/tenancy/context";
import {
  createTenantFeatureService,
  FEATURE_MANAGE_PERMISSION,
  type TenantFeatureService,
} from "@/lib/tenancy/features";
import { createTenantQueryRepository } from "@/lib/tenancy/queries";
import type { TenantId } from "@/lib/tenancy/types";

interface FeatureChangeOutcome {
  readonly outcome: string;
  readonly policy_version: number | null;
}

async function memberPolicyFacts(db: DbClient, tenantId: string, membershipId: string, authIdentityId: string) {
  const membership = await db
    .prepare(
      `SELECT id FROM tenant_memberships
       WHERE tenant_id = ? AND id = ? AND auth_identity_id = ?
         AND status = 'active' AND workspace_id IS NULL`,
    )
    .get<{ id: string }>(tenantId, membershipId, authIdentityId);
  if (!membership) return null;
  const binding = await createTenantQueryRepository(db)
    .getCurrentRoleBinding(tenantId, membership.id);
  if (!binding) return null;
  return { membershipId: membership.id, bindingId: binding.id, role: binding.role };
}

export function createPostgresTenantFeatureService(): TenantFeatureService {
  if (!process.env.DATABASE_URL?.trim()) {
    throw new Error("The Postgres tenant feature service requires DATABASE_URL.");
  }

  return createTenantFeatureService({
    policyRepository: {
      getCurrentTenantPolicy: (tenantId: TenantId) =>
        withTenantDbContext((db) =>
          createTenantQueryRepository(db).getCurrentTenantPolicy(tenantId)),
    },
    actorResolver: {
      // The accepted member context is the only actor source; the live rows
      // are re-read under the same context so a suspended membership or
      // revoked binding is denied even if the session predates it.
      resolveFeatureManager: async (tenantId: TenantId) => {
        const member = getTenantContext();
        if (!member || member.tenantId !== tenantId) return null;
        return withTenantDbContext(async (db) => {
          const facts = await memberPolicyFacts(db, tenantId, member.membershipId, member.actorAuthIdentityId);
          if (!facts || !isTenantRoleCapable(facts.role, FEATURE_MANAGE_PERMISSION)) return null;
          return {
            tenantId,
            authIdentityId: member.actorAuthIdentityId,
            permission: FEATURE_MANAGE_PERMISSION,
          } as const;
        });
      },
    },
    changeExecutor: {
      // The canonical service has already validated the request, resolved the
      // actor, and CAS-checked the version it read; the function re-validates
      // the member context inside the database and performs the version CAS +
      // audit append in one statement. A lost race or a denied context lands
      // here as a non-applied outcome, which the service maps to
      // POLICY_CHANGE_EXECUTION_FAILED without enumerating a cause.
      execute: (command) =>
        withTenantDbContext(async (db) => {
          const row = await db
            .prepare(
              `SELECT outcome, policy_version
               FROM public.novatrade_apply_tenant_feature_policy_change(?, ?, ?, ?)`,
            )
            .get<FeatureChangeOutcome>(
              command.mutation.policyField,
              command.mutation.enabled,
              command.expectedPolicyVersion,
              JSON.stringify(command.auditEvent),
            );
          if (!row || row.outcome !== "applied" || row.policy_version !== command.resultingPolicyVersion) {
            throw new Error(`Tenant feature policy change was not committed: ${row?.outcome ?? "no outcome"}.`);
          }
          return {
            tenantId: command.tenantId,
            featureId: command.featureId,
            previousPolicyVersion: command.previousPolicyVersion,
            resultingPolicyVersion: row.policy_version,
          };
        }),
    },
  });
}
