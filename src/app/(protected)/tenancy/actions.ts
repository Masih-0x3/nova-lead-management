"use server";

import { randomUUID } from "node:crypto";

import { runSurfaceAction, type SurfaceActionResult } from "../_lib/action";
import { createTenantAuditLog } from "@/lib/db/queries";
import {
  createTenantLifecycleService,
  type TenantLifecycleAuditWriter,
} from "@/lib/tenancy/lifecycle";
import { createTenantQueryRepository } from "@/lib/tenancy/queries";
import type { TenantStatus } from "@/lib/tenancy/types";

/**
 * Canonical tenant lifecycle transition (suspend/resume/archive). The
 * permission is conditional, so the gate requires the tenant policy to be
 * present and well-formed; the service additionally enforces the state
 * machine and expected-current-state CAS.
 */
export async function transitionTenantLifecycleAction(input: Readonly<{
  expectedCurrentState: unknown;
  toStatus: unknown;
  reasonCode: unknown;
  reason: unknown;
}>): Promise<SurfaceActionResult> {
  return runSurfaceAction(
    {
      permission: "tenant:lifecycle",
      action: "l07:tenancy:lifecycle-transition",
      resourceType: "tenant",
      requirePolicy: () => true,
      revalidate: ["/tenancy"],
    },
    async (db, session) => {
      const repository = createTenantQueryRepository(db);
      const auditWriter: TenantLifecycleAuditWriter = {
        write: (event) => createTenantAuditLog(
          event.action,
          "tenant",
          event.tenantId,
          {
            fromStatus: event.fromStatus,
            toStatus: event.toStatus,
            actorLayer: event.actorLayer,
            reasonCode: event.reasonCode,
            reason: event.reason,
            correlationId: event.correlationId,
            outcome: "allowed",
          },
        ),
      };
      const service = createTenantLifecycleService({
        transactionRunner: {
          run: (callback) => callback({ db, repository, auditWriter }),
        },
      });
      const result = await service.transitionTenantLifecycle({
        tenantId: session.tenantId,
        actorId: session.membershipId,
        actorLayer: "member",
        reasonCode: typeof input.reasonCode === "string" ? input.reasonCode : "",
        reason: typeof input.reason === "string" ? input.reason : "",
        correlationId: randomUUID(),
        expectedCurrentState: input.expectedCurrentState as TenantStatus,
        toStatus: input.toStatus as TenantStatus,
      });
      return `Tenant status changed to ${result.tenant.status}.`;
    },
  );
}
