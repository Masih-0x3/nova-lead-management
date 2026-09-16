import { isProxy } from "node:util/types";

import type { DbClient } from "@/lib/db";

import type { PlayAuthorityPort } from "./service";

/**
 * Postgres implementation of the L-04 play-authority port. The strategy lane
 * owns the play lifecycle tables; this adapter reads the version row's review
 * snapshot (`lead_play_versions.review`) and proposal input
 * (`lead_play_versions.source`) plus the durable activation document
 * (`lead_play_activation_states.state`) that buildDiscoveryPlan re-verifies.
 * When those tables are not present in this deployment the port returns null
 * and plan creation fails closed — it never fabricates authority.
 */
const EXPECTED_TABLES = [
  "lead_play_versions",
  "lead_play_activation_states",
] as const;

async function tableExists(db: DbClient, table: string): Promise<boolean> {
  const found = await db.prepare(
    `SELECT pg_catalog.to_regclass(?) AS present`,
  ).get(`public.${table}`);
  return !!found && (found as Record<string, unknown>).present !== null;
}

function isDocument(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value) && !isProxy(value);
}

export function createPostgresPlayAuthorityPort(db: DbClient): PlayAuthorityPort {
  if (!db || typeof db.prepare !== "function") throw new TypeError("A database client is required");
  const repository: PlayAuthorityPort = {
    async loadPlayAuthority(selector) {
      try {
        for (const table of EXPECTED_TABLES) {
          if (!(await tableExists(db, table))) return null;
        }
        const version = await db.prepare(
          `SELECT stable_key, source, review FROM public.lead_play_versions
            WHERE tenant_id = ? AND (workspace_id IS NOT DISTINCT FROM ?)
              AND version_id = ?`,
        ).get(selector.tenantId, selector.workspaceId, selector.playVersionId);
        if (!version) return null;
        const { stable_key: stableKey, source, review } = version as Record<string, unknown>;
        if (typeof stableKey !== "string" || !isDocument(source) || !isDocument(review)) return null;
        const activation = await db.prepare(
          `SELECT state FROM public.lead_play_activation_states
            WHERE tenant_id = ? AND (workspace_id IS NOT DISTINCT FROM ?)
              AND stable_key = ?`,
        ).get(selector.tenantId, selector.workspaceId, stableKey);
        if (!activation) return null;
        const state = (activation as Record<string, unknown>).state;
        if (!isDocument(state)) return null;
        return Object.freeze({
          activationState: state,
          playReview: review,
          playSource: source,
        });
      } catch {
        return null;
      }
    },
  };
  return Object.freeze(repository);
}
