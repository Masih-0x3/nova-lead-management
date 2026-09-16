/**
 * L-02 local retention-policy adapters.
 *
 * `createTenantRetentionService` (retention-policy.ts) deliberately leaves two
 * ports to the runtime — the trusted `tenant:manage` actor resolver and the
 * policy change executor that must CAS `tenant_policies` and append the audit
 * event atomically. This module supplies both against the local SQLite
 * runtime so the canonical requestRetentionChange path is exercisable end to
 * end.
 */
import { randomUUID } from "node:crypto";

import type { DbClient } from "@/lib/db";
import { isTenantRoleCapable } from "@/lib/permissions";
import { createTenantQueryRepository } from "@/lib/tenancy/queries";
import {
  createTenantRetentionService,
  RETENTION_MANAGE_PERMISSION,
  type TenantRetentionPolicyField,
  type TenantRetentionService,
} from "@/lib/tenancy/retention-policy";
import type { AuthIdentityId, MembershipId, TenantId } from "@/lib/tenancy/types";

export interface LocalTenantRetentionActor {
  readonly authIdentityId: AuthIdentityId;
  readonly membershipId: MembershipId;
}

export interface LocalTenantRetentionServiceOptions {
  /**
   * The server-derived member actor the resolver trusts for this composition —
   * the driver/session layer binds the authenticated identity here; the
   * request itself can never carry actor fields.
   */
  readonly actor: LocalTenantRetentionActor;
  readonly idFactory?: { next(): string };
  readonly clock?: () => Date;
}

const RETENTION_POLICY_COLUMNS: Record<TenantRetentionPolicyField, string> = {
  exportRetentionDays: "export_retention_days",
  operationalLogRetentionDays: "operational_log_retention_days",
  rawSourceRetentionDays: "raw_source_retention_days",
  contactFreshnessDays: "contact_freshness_days",
  primaryDeleteWithinDays: "primary_delete_within_days",
  backupExpireWithinDays: "backup_expire_within_days",
};

/**
 * The bound actor's verified tenant-scoped facts — an active tenant-wide
 * membership and its current (non-revoked) role binding. Re-read at each use
 * so the capability proof and the audit row share one snapshot.
 */
async function resolveMemberFacts(
  db: DbClient,
  tenantId: string,
  actor: LocalTenantRetentionActor,
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

export function createLocalTenantRetentionService(
  db: DbClient,
  options: LocalTenantRetentionServiceOptions,
): TenantRetentionService {
  const idFactory = options.idFactory ?? { next: () => randomUUID() };
  const now = () => (options.clock?.() ?? new Date()).toISOString();
  const { actor } = options;

  return createTenantRetentionService({
    policyRepository: createTenantQueryRepository(db),
    actorResolver: {
      // Proves the bound actor holds tenant:manage for the exact tenant —
      // the same capability check the permission matrix exposes (A or C).
      resolveRetentionManager: async (tenantId: TenantId) => {
        const facts = await resolveMemberFacts(db, tenantId, actor);
        if (!facts || !isTenantRoleCapable(facts.role, RETENTION_MANAGE_PERMISSION)) return null;
        return {
          tenantId,
          authIdentityId: actor.authIdentityId,
          permission: RETENTION_MANAGE_PERMISSION,
        } as const;
      },
    },
    changeExecutor: {
      // CAS the policy (version must advance exactly one per the guard
      // trigger) and append the member-scope audit row in one transaction.
      execute: (command) =>
        db.withTransaction!(async () => {
          const facts = await resolveMemberFacts(db, command.tenantId, actor);
          if (!facts) throw new Error("retention manager membership is unavailable");
          const column = RETENTION_POLICY_COLUMNS[command.mutation.policyField];
          const updated = await db
            .prepare(
              `UPDATE tenant_policies
               SET ${column} = ?, version = version + 1, updated_at = ?
               WHERE tenant_id = ? AND version = ?`,
            )
            .run(
              command.mutation.days,
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
          if (audit.changes !== 1) throw new Error("tenant retention audit append failed");

          return {
            tenantId: command.tenantId,
            knob: command.knob,
            previousPolicyVersion: command.previousPolicyVersion,
            resultingPolicyVersion: command.resultingPolicyVersion,
          };
        }),
    },
  });
}
