import { isProxy } from "node:util/types";

import type { DbClient } from "@/lib/db";

import type { PlayAuthorityPort } from "./service";

/**
 * Postgres implementation of the L-04 play-authority port. The strategy lane
 * owns the play lifecycle tables; this adapter reads the activation state,
 * review snapshot, and original proposal input that buildDiscoveryPlan
 * re-verifies. When those tables are not present in this deployment the port
 * returns null and plan creation fails closed — it never fabricates
 * authority.
 */
const EXPECTED_TABLES = [
  "lead_play_activation_states",
  "lead_play_reviews",
  "lead_play_proposals",
] as const;

async function tableExists(db: DbClient, table: string): Promise<boolean> {
  const found = await db.prepare(
    `SELECT pg_catalog.to_regclass(?) AS present`,
  ).get(`public.${table}`);
  return !!found && (found as Record<string, unknown>).present !== null;
}

export function createPostgresPlayAuthorityPort(db: DbClient): PlayAuthorityPort {
  if (!db || typeof db.prepare !== "function") throw new TypeError("A database client is required");
  const repository: PlayAuthorityPort = {
    async loadPlayAuthority(selector) {
      try {
        for (const table of EXPECTED_TABLES) {
          if (!(await tableExists(db, table))) return null;
        }
        const [activation, review, proposal] = await Promise.all([
          db.prepare(
            `SELECT payload FROM public.lead_play_activation_states
              WHERE tenant_id = ? AND (workspace_id IS NOT DISTINCT FROM ?)
              ORDER BY created_at DESC LIMIT 1`,
          ).get(selector.tenantId, selector.workspaceId),
          db.prepare(
            `SELECT payload FROM public.lead_play_reviews
              WHERE tenant_id = ? AND (workspace_id IS NOT DISTINCT FROM ?)
                AND version_id = ?
              ORDER BY created_at DESC LIMIT 1`,
          ).get(selector.tenantId, selector.workspaceId, selector.playVersionId),
          db.prepare(
            `SELECT input FROM public.lead_play_proposals
              WHERE tenant_id = ? AND (workspace_id IS NOT DISTINCT FROM ?)
                AND version_id = ?
              LIMIT 1`,
          ).get(selector.tenantId, selector.workspaceId, selector.playVersionId),
        ]);
        if (!activation || !review || !proposal) return null;
        const activationPayload = (activation as Record<string, unknown>).payload;
        const reviewPayload = (review as Record<string, unknown>).payload;
        const proposalInput = (proposal as Record<string, unknown>).input;
        if (!activationPayload || typeof activationPayload !== "object" || isProxy(activationPayload)
          || !reviewPayload || typeof reviewPayload !== "object" || isProxy(reviewPayload)
          || !proposalInput || typeof proposalInput !== "object" || isProxy(proposalInput)) {
          return null;
        }
        return Object.freeze({
          activationState: activationPayload,
          playReview: reviewPayload,
          playSource: proposalInput,
        });
      } catch {
        return null;
      }
    },
  };
  return Object.freeze(repository);
}
