import { isProxy } from "node:util/types";

import type { DbClient } from "@/lib/db";
import { createTenantAuditLog } from "@/lib/db/queries";
import {
  assertTenantPermission,
  type TenantPolicyContext,
  type TenantResourceScopeClass,
} from "@/lib/tenancy/authorize";
import { createTenantQueryRepository } from "@/lib/tenancy/queries";
import { tenantPolicySchema, type TenantPolicySchemaType } from "@/lib/tenancy/schemas";
import type { TenantSession } from "@/lib/auth";
import { createPostgresConnectorAuthorityRepository } from "@/lib/connectors/repository";
import { createPostgresConnectorCommandRepository } from "@/lib/connectors/command-repository";
import type { ConnectorServiceDeps } from "@/lib/connectors/service";
import { createPostgresDiscoveryRepository } from "@/lib/discovery/repository";
import { createPostgresPlayAuthorityPort } from "@/lib/discovery/play-authority-port";
import type { DiscoveryServiceDeps } from "@/lib/discovery/service";
import type { AccountServiceDeps, ReviewEnqueuePort } from "@/lib/discovery/account-service";
import { createPostgresContactRepository } from "@/lib/contacts/repository";
import type { ContactServiceDeps } from "@/lib/contacts/service";
import { createPostgresQualificationRepository } from "@/lib/qualification/repository";
import type {
  QualificationServiceDeps,
  ReviewEnqueuePort as QualificationReviewEnqueuePort,
} from "@/lib/qualification/service";
import { createPostgresReviewRepository } from "@/lib/review/repository";
import { enqueueItem, type ReviewServiceDeps } from "@/lib/review/service";

/**
 * Adapts the tenant audit log to the service-layer sink contract. The ambient
 * tenant context installed by withL05TenantDb supplies actor + correlation.
 */
const audit = {
  record: (event: Readonly<{
    action: string;
    entityType: string;
    entityId: string;
    metadata: Readonly<Record<string, unknown>>;
  }>) => createTenantAuditLog(
    event.action,
    event.entityType,
    event.entityId,
    { ...event.metadata },
  ),
};

export function connectorDeps(db: DbClient): ConnectorServiceDeps {
  return {
    authority: createPostgresConnectorAuthorityRepository(db),
    commands: createPostgresConnectorCommandRepository(db),
    audit,
  };
}

export function discoveryDeps(db: DbClient): DiscoveryServiceDeps {
  return {
    repository: createPostgresDiscoveryRepository(db),
    playAuthority: createPostgresPlayAuthorityPort(db),
  };
}

export function reviewDeps(db: DbClient): ReviewServiceDeps {
  return { repository: createPostgresReviewRepository(db) };
}

/** Wires account-resolution review outcomes into the durable review queue. */
function resolutionReviewPort(db: DbClient): ReviewEnqueuePort {
  const deps = reviewDeps(db);
  return {
    enqueueResolutionReview: async (input) => {
      await enqueueItem(deps, {
        tenantId: input.tenantId,
        workspaceId: input.workspaceId,
        kind: "ambiguous_account_resolution",
        subject: {
          subjectId: input.resolutionId,
          versionId: input.resolutionId,
          contentHash: input.resolutionHash,
        },
        priority: "normal",
        reason: input.reason,
        at: input.at,
      });
    },
  };
}

/** Wires needs_review qualification snapshots into the durable review queue. */
function qualificationReviewPort(db: DbClient): QualificationReviewEnqueuePort {
  const deps = reviewDeps(db);
  return {
    enqueueQualificationReview: async (input) => {
      await enqueueItem(deps, {
        tenantId: input.tenantId,
        workspaceId: input.workspaceId,
        kind: "qualification_review",
        subject: {
          subjectId: input.versionId,
          versionId: input.versionId,
          contentHash: input.qualificationHash,
        },
        priority: input.uncertaintyIds.length > 0 ? "high" : "normal",
        reason: input.reason,
        uncertaintyIds: input.uncertaintyIds,
        at: input.at,
      });
    },
  };
}

export function accountDeps(db: DbClient): AccountServiceDeps {
  return {
    repository: createPostgresDiscoveryRepository(db),
    audit,
    reviewQueue: resolutionReviewPort(db),
  };
}

export function contactDeps(db: DbClient): ContactServiceDeps {
  return { repository: createPostgresContactRepository(db), audit };
}

export function qualificationDeps(db: DbClient): QualificationServiceDeps {
  return {
    repository: createPostgresQualificationRepository(db),
    audit,
    reviewQueue: qualificationReviewPort(db),
  };
}

export type L05PolicyField =
  | "sourceResearchEnabled"
  | "contactResearchEnabled"
  | "outreachDraftingEnabled"
  | "copyExportEnabled"
  | "aiProcessingEnabled";

export type L05GateOptions = Readonly<{
  workspaceId: string | null;
  scopeClass: TenantResourceScopeClass;
  action: string;
  resourceId?: string;
  resourceType?: string;
  requirePolicy?: (policy: TenantPolicySchemaType) => boolean;
}>;

/**
 * Enforces a conditional (C) permission: loads the current tenant policy
 * inside the tenant transaction and requires the requested feature flag (or
 * caller predicate) to hold. A missing or malformed policy fails closed.
 */
export async function gateL05Policy(
  session: TenantSession,
  db: DbClient,
  permission: string,
  options: L05GateOptions,
): Promise<void> {
  const currentPolicy = await createTenantQueryRepository(db).getCurrentTenantPolicy(session.tenantId);
  const parsedPolicy = tenantPolicySchema.safeParse(currentPolicy);
  const requirePolicy = options.requirePolicy ?? ((policy: TenantPolicySchemaType) =>
    policy.sourceResearchEnabled === true);
  await assertTenantPermission(session, permission, {
    action: options.action,
    scopeClass: options.scopeClass,
    resource: {
      tenantId: session.tenantId,
      workspaceId: options.workspaceId,
      resourceId: options.resourceId,
      resourceType: options.resourceType,
    },
    policyEvaluator: (context: TenantPolicyContext) => ({
      allowed: context.tenantId === session.tenantId
        && parsedPolicy.success
        && parsedPolicy.data.tenantId === session.tenantId
        && requirePolicy(parsedPolicy.data),
      context,
    }),
  });
}

export function isPlainBody(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value) || isProxy(value)) return false;
  try {
    const prototype = Object.getPrototypeOf(value);
    return prototype === Object.prototype || prototype === null;
  } catch {
    return false;
  }
}
