/**
 * L-02 local feature-policy adapters.
 *
 * `createTenantFeatureService` (features.ts) deliberately leaves two ports to
 * the runtime — the trusted `feature:manage` actor resolver and the policy
 * change executor that must CAS `tenant_policies` and append the audit event
 * atomically. This module supplies both against the local SQLite runtime so
 * the canonical requestFeatureChange path is exercisable end to end.
 */
import { randomUUID } from "node:crypto";

import type { DbClient } from "@/lib/db";
import { isTenantRoleCapable } from "@/lib/permissions";
import {
  createTenantFeatureService,
  FEATURE_MANAGE_PERMISSION,
  type TenantFeaturePolicyField,
  type TenantFeatureService,
} from "@/lib/tenancy/features";
import { createTenantQueryRepository } from "@/lib/tenancy/queries";
import type { AuthIdentityId, MembershipId, TenantId } from "@/lib/tenancy/types";

export interface LocalTenantFeatureActor {
  readonly authIdentityId: AuthIdentityId;
  readonly membershipId: MembershipId;
}

export interface LocalTenantFeatureServiceOptions {
  /**
   * The server-derived member actor the resolver trusts for this composition —
   * the driver/session layer binds the authenticated identity here; the
   * request itself can never carry actor fields.
   */
  readonly actor: LocalTenantFeatureActor;
  readonly idFactory?: { next(): string };
  readonly clock?: () => Date;
}

const FEATURE_POLICY_COLUMNS: Record<TenantFeaturePolicyField, string> = {
  aiProcessingEnabled: "ai_processing_enabled",
  sourceResearchEnabled: "source_research_enabled",
  contactResearchEnabled: "contact_research_enabled",
  outreachDraftingEnabled: "outreach_drafting_enabled",
  copyExportEnabled: "copy_export_enabled",
  autonomousSendEnabled: "autonomous_send_enabled",
};

/**
 * The bound actor's verified tenant-scoped facts — an active tenant-wide
 * membership and its current (non-revoked) role binding. Re-read at each use
 * so the capability proof and the audit row share one snapshot.
 */
async function resolveMemberFacts(
  db: DbClient,
  tenantId: string,
  actor: LocalTenantFeatureActor,
) {
  const membership = await db
    .prepare(
      `SELECT id FROM tenant_memberships
       WHERE tenant_id = ? AND id = ? AND auth_identity_id = ?
         AND status = 'active' AND workspace_id IS NULL`,
    )
    .get<{ id: string }>(tenantId, actor.membershipId, actor.authIdentityId);
  if (!membership) return null;
  const binding = await createTenantQueryRepository(db)
    .getCurrentRoleBinding(tenantId, membership.id);
  if (!binding) return null;
  return { membershipId: membership.id, bindingId: binding.id, role: binding.role };
}

export function createLocalTenantFeatureService(
  db: DbClient,
  options: LocalTenantFeatureServiceOptions,
): TenantFeatureService {
  const idFactory = options.idFactory ?? { next: () => randomUUID() };
  const now = () => (options.clock?.() ?? new Date()).toISOString();
  const { actor } = options;

  return createTenantFeatureService({
    policyRepository: createTenantQueryRepository(db),
    actorResolver: {
      // Proves the bound actor holds feature:manage for the exact tenant —
      // the same capability check the permission matrix exposes (A or C).
      resolveFeatureManager: async (tenantId: TenantId) => {
        const facts = await resolveMemberFacts(db, tenantId, actor);
        if (!facts || !isTenantRoleCapable(facts.role, FEATURE_MANAGE_PERMISSION)) return null;
        return {
          tenantId,
          authIdentityId: actor.authIdentityId,
          permission: FEATURE_MANAGE_PERMISSION,
        } as const;
      },
    },
    changeExecutor: {
      // CAS the policy (version must advance exactly one per the guard
      // trigger) and append the member-scope audit row in one transaction.
      execute: (command) =>
        db.withTransaction!(async () => {
          const facts = await resolveMemberFacts(db, command.tenantId, actor);
          if (!facts) throw new Error("feature manager membership is unavailable");
          const column = FEATURE_POLICY_COLUMNS[command.mutation.policyField];
          const updated = await db
            .prepare(
              `UPDATE tenant_policies
               SET ${column} = ?, version = version + 1, updated_at = ?
               WHERE tenant_id = ? AND version = ?`,
            )
            .run(
              command.mutation.enabled ? 1 : 0,
              now(),
              command.tenantId,
              command.expectedPolicyVersion,
            );
          if (updated.changes !== 1) throw new Error("tenant policy CAS was lost");

          const audit = await db
            .prepare(
              `INSERT INTO audit_logs
                (id, action, entity_type, entity_id, metadata, scope_kind,
                 tenant_id, workspace_id, correlation_id,
                 actor_auth_identity_id, actor_membership_id,
                 actor_launch_role, actor_role_binding_id, actor_layer)
               VALUES (?, ?, 'tenant', ?, ?, 'tenant', ?, NULL, ?, ?, ?, ?, ?, 'member')`,
            )
            .run(
              idFactory.next(),
              command.auditEvent.eventType,
              command.tenantId,
              JSON.stringify(command.auditEvent),
              command.tenantId,
              command.auditEvent.correlationId,
              command.actor.authIdentityId,
              facts.membershipId,
              facts.role,
              facts.bindingId,
            );
          if (audit.changes !== 1) throw new Error("tenant feature audit append failed");

          return {
            tenantId: command.tenantId,
            featureId: command.featureId,
            previousPolicyVersion: command.previousPolicyVersion,
            resultingPolicyVersion: command.resultingPolicyVersion,
          };
        }),
    },
  });
}
