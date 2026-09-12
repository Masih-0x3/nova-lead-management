import type { DbClient } from "@/lib/db";
import { createTenantAuditLog } from "@/lib/db/queries";
import { createPostgresAgentRunStore } from "@/lib/agent-runtime/run-store";
import { createDeterministicFixtureProvider } from "@/lib/agent-runtime/fixture-provider";
import { createPostgresContactRepository } from "@/lib/contacts/repository";
import { createPostgresDiscoveryRepository } from "@/lib/discovery/repository";
import { createPostgresLearningRepository } from "@/lib/learning/repository";
import type { LearningServiceDeps } from "@/lib/learning/service";
import { createPostgresOutcomeRepository } from "@/lib/outcomes/repository";
import type { OutcomeServiceDeps } from "@/lib/outcomes/service";
import {
  attestOutreachAgentSeeds,
  createOutreachAgentRegistry,
} from "@/lib/outreach/agent-seeds";
import { createPostgresOutreachRepository } from "@/lib/outreach/repository";
import type { OutreachMemberPort, OutreachServiceDeps } from "@/lib/outreach/service";
import { createPostgresReviewRepository } from "@/lib/review/repository";
import type { ReviewServiceDeps } from "@/lib/review/service";
import { createPostgresStrategyRepository } from "@/lib/strategy/repository";
import { createPostgresSuppressionRepository } from "@/lib/suppressions/repository";
import { createPostgresUnderstandingRepository } from "@/lib/understanding/repository";

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

function memberPort(db: DbClient): OutreachMemberPort {
  return {
    countActiveMembers: async (tenantId) => {
      const row = await db.prepare(
        "SELECT COUNT(*)::text AS count FROM tenant_memberships WHERE tenant_id = ? AND status = 'active'",
      ).get(tenantId);
      const count = row && typeof (row as Record<string, unknown>).count === "string"
        ? Number((row as Record<string, unknown>).count) : Number.NaN;
      if (!Number.isSafeInteger(count) || count < 0) {
        throw new Error("The membership count could not be resolved.");
      }
      return count;
    },
  };
}

/**
 * Outreach deps for the L-06 route surface. The fixture provider is the only
 * model binding; seeds are attested inside the caller's member transaction
 * before the registry is built so drifted prompt/policy rows fail closed.
 */
export async function outreachDeps(db: DbClient): Promise<OutreachServiceDeps> {
  await attestOutreachAgentSeeds(db);
  const registry = await createOutreachAgentRegistry(db);
  return {
    outreach: createPostgresOutreachRepository(db),
    suppressions: createPostgresSuppressionRepository(db),
    contacts: createPostgresContactRepository(db),
    accounts: createPostgresDiscoveryRepository(db),
    understanding: createPostgresUnderstandingRepository(db),
    strategy: createPostgresStrategyRepository(db),
    review: { repository: createPostgresReviewRepository(db) } satisfies ReviewServiceDeps,
    runtime: {
      store: createPostgresAgentRunStore(db),
      registry,
      provider: createDeterministicFixtureProvider(),
    },
    members: memberPort(db),
    audit,
  };
}

export function outcomeDeps(db: DbClient): OutcomeServiceDeps {
  return {
    outcomes: createPostgresOutcomeRepository(db),
    outreach: createPostgresOutreachRepository(db),
    suppressions: createPostgresSuppressionRepository(db),
    audit,
  };
}

export function learningDeps(db: DbClient): LearningServiceDeps {
  return {
    learning: createPostgresLearningRepository(db),
    outcomes: createPostgresOutcomeRepository(db),
    strategy: createPostgresStrategyRepository(db),
    audit,
  };
}
