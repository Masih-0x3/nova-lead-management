import "server-only";

import { isProxy } from "node:util/types";

import type { DbClient } from "@/lib/db";
import type {
  LeadPlayActivationState,
  LeadPlaySimulationEligibilityReview,
} from "@/lib/strategy/lead-play-activation";
import type {
  IcpReviewEvent,
  IcpReviewSnapshot,
} from "@/lib/strategy/icp";
import type {
  LeadPlayReviewEvent,
  LeadPlayReviewSnapshot,
} from "@/lib/strategy/lead-play";
import type {
  LeadPlaySimulation,
} from "@/lib/strategy/lead-play-simulation";
import type {
  StoredIcpVersion,
  StoredLeadPlayActivation,
  StoredLeadPlaySimulation,
  StoredLeadPlaySimulationReview,
  StoredLeadPlayVersion,
  StrategyRepository,
  StrategyScope,
} from "@/lib/strategy/service";

/**
 * Postgres adapter for the L-04 strategy repository port. Writes flow through
 * the `novatrade_l04_*` member-gated definer capabilities; reads are plain
 * SELECTs under the caller's tenant GUCs and the `l04_*_member_select` RLS
 * policies. JSONB payloads are stored verbatim so service-side hydration can
 * rebuild and verify every identity hash.
 */

function parseJson(value: unknown): unknown {
  if (typeof value === "string") return JSON.parse(value);
  return value;
}

function iso(value: unknown): string {
  if (value instanceof Date) return value.toISOString();
  const text = String(value);
  const parsed = Date.parse(text);
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : text;
}

interface IcpRow {
  readonly version_id: string;
  readonly tenant_id: string;
  readonly workspace_id: string | null;
  readonly stable_key: string;
  readonly revision: number | string;
  readonly supersedes_version_id: string | null;
  readonly content_hash: string;
  readonly understanding_version_id: string;
  readonly review_hash: string;
  readonly status: string;
  readonly source: unknown;
  readonly review: unknown;
  readonly created_at: unknown;
  readonly updated_at: unknown;
}

interface LeadPlayRow {
  readonly version_id: string;
  readonly tenant_id: string;
  readonly workspace_id: string | null;
  readonly stable_key: string;
  readonly revision: number | string;
  readonly supersedes_version_id: string | null;
  readonly icp_version_id: string;
  readonly understanding_version_id: string;
  readonly content_hash: string;
  readonly review_hash: string;
  readonly status: string;
  readonly source: unknown;
  readonly review: unknown;
  readonly created_at: unknown;
  readonly updated_at: unknown;
}

interface SimulationRow {
  readonly simulation_id: string;
  readonly tenant_id: string;
  readonly workspace_id: string | null;
  readonly play_version_id: string;
  readonly play_review_hash: string;
  readonly simulation_hash: string;
  readonly input: unknown;
  readonly simulation: unknown;
  readonly created_at: unknown;
}

interface SimulationReviewRow {
  readonly tenant_id: string;
  readonly workspace_id: string | null;
  readonly play_version_id: string;
  readonly simulation_id: string;
  readonly eligibility_hash: string;
  readonly decision: string;
  readonly review: unknown;
  readonly created_at: unknown;
}

interface ActivationRow {
  readonly tenant_id: string;
  readonly workspace_id: string | null;
  readonly stable_key: string;
  readonly state_hash: string;
  readonly state: unknown;
  readonly created_at: unknown;
  readonly updated_at: unknown;
}

const ICP_SELECT = `SELECT version_id,tenant_id::text AS tenant_id,
  workspace_id::text AS workspace_id,stable_key,revision,supersedes_version_id,
  content_hash,understanding_version_id,review_hash,status,source,review,
  created_at,updated_at FROM public.icp_versions`;

const PLAY_SELECT = `SELECT version_id,tenant_id::text AS tenant_id,
  workspace_id::text AS workspace_id,stable_key,revision,supersedes_version_id,
  icp_version_id,understanding_version_id,content_hash,review_hash,status,source,
  review,created_at,updated_at FROM public.lead_play_versions`;

const SIMULATION_SELECT = `SELECT simulation_id,tenant_id::text AS tenant_id,
  workspace_id::text AS workspace_id,play_version_id,play_review_hash,
  simulation_hash,input,simulation,created_at FROM public.lead_play_simulations`;

function mapIcp(row: IcpRow): StoredIcpVersion {
  return Object.freeze({
    tenantId: row.tenant_id,
    workspaceId: row.workspace_id,
    versionId: row.version_id,
    stableKey: row.stable_key,
    revision: Number(row.revision),
    supersedesVersionId: row.supersedes_version_id,
    contentHash: row.content_hash,
    understandingVersionId: row.understanding_version_id,
    source: parseJson(row.source),
    review: parseJson(row.review) as IcpReviewSnapshot,
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
  });
}

function mapLeadPlay(row: LeadPlayRow): StoredLeadPlayVersion {
  return Object.freeze({
    tenantId: row.tenant_id,
    workspaceId: row.workspace_id,
    versionId: row.version_id,
    stableKey: row.stable_key,
    revision: Number(row.revision),
    supersedesVersionId: row.supersedes_version_id,
    contentHash: row.content_hash,
    icpVersionId: row.icp_version_id,
    understandingVersionId: row.understanding_version_id,
    source: parseJson(row.source),
    review: parseJson(row.review) as LeadPlayReviewSnapshot,
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
  });
}

function mapSimulation(row: SimulationRow): StoredLeadPlaySimulation {
  return Object.freeze({
    tenantId: row.tenant_id,
    workspaceId: row.workspace_id,
    simulationId: row.simulation_id,
    playVersionId: row.play_version_id,
    playReviewHash: row.play_review_hash,
    simulationHash: row.simulation_hash,
    input: parseJson(row.input),
    simulation: parseJson(row.simulation) as LeadPlaySimulation,
    createdAt: iso(row.created_at),
  });
}

function mapSimulationReview(row: SimulationReviewRow): StoredLeadPlaySimulationReview {
  return Object.freeze({
    tenantId: row.tenant_id,
    workspaceId: row.workspace_id,
    playVersionId: row.play_version_id,
    simulationId: row.simulation_id,
    eligibilityHash: row.eligibility_hash,
    review: parseJson(row.review) as LeadPlaySimulationEligibilityReview,
    createdAt: iso(row.created_at),
  });
}

function mapActivation(row: ActivationRow): StoredLeadPlayActivation {
  return Object.freeze({
    tenantId: row.tenant_id,
    workspaceId: row.workspace_id,
    stableKey: row.stable_key,
    state: parseJson(row.state) as LeadPlayActivationState,
    updatedAt: iso(row.updated_at),
  });
}

type WriteKind = { readonly kind?: unknown } | undefined;

export class PostgresStrategyRepository implements StrategyRepository {
  constructor(private readonly db: DbClient) {
    if (isProxy(db)) throw new Error("Invalid repository dependency.");
  }

  async getIcpVersion(scope: StrategyScope, versionId: string): Promise<StoredIcpVersion | null> {
    const row = await this.db.prepare(
      `${ICP_SELECT} WHERE version_id=? AND tenant_id=? AND workspace_id IS NOT DISTINCT FROM ?`,
    ).get<IcpRow>(versionId, scope.tenantId, scope.workspaceId);
    return row ? mapIcp(row) : null;
  }

  async getLatestIcpVersionByStableKey(
    scope: StrategyScope,
    stableKey: string,
  ): Promise<StoredIcpVersion | null> {
    const row = await this.db.prepare(
      `${ICP_SELECT} WHERE tenant_id=? AND workspace_id IS NOT DISTINCT FROM ? AND stable_key=?
       ORDER BY revision DESC, created_at DESC LIMIT 1`,
    ).get<IcpRow>(scope.tenantId, scope.workspaceId, stableKey);
    return row ? mapIcp(row) : null;
  }

  async listIcpVersions(scope: StrategyScope): Promise<readonly StoredIcpVersion[]> {
    const rows = await this.db.prepare(
      `${ICP_SELECT} WHERE tenant_id=? AND workspace_id IS NOT DISTINCT FROM ?
       ORDER BY stable_key, revision, version_id`,
    ).all<IcpRow>(scope.tenantId, scope.workspaceId);
    return Object.freeze(rows.map(mapIcp));
  }

  async appendIcpVersion(record: StoredIcpVersion): Promise<"created" | "replayed" | "conflict"> {
    const row = await this.db.prepare(
      "SELECT kind FROM public.novatrade_l04_append_icp_version(?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
    ).get<WriteKind>(
      record.tenantId,
      record.workspaceId,
      record.versionId,
      record.stableKey,
      String(record.revision),
      record.supersedesVersionId,
      record.contentHash,
      record.understandingVersionId,
      record.review.reviewHash,
      "draft",
      JSON.stringify(record.source),
      JSON.stringify(record.review),
      record.createdAt,
      record.updatedAt,
    );
    return row?.kind === "created" ? "created"
      : row?.kind === "replay" ? "replayed" : "conflict";
  }

  async applyIcpReviewTransition(
    scope: StrategyScope,
    versionId: string,
    expectedReviewHash: string,
    review: IcpReviewSnapshot,
    event: IcpReviewEvent,
  ): Promise<"updated" | "stale" | "not_found"> {
    const row = await this.db.prepare(
      "SELECT kind FROM public.novatrade_l04_transition_icp_review(?,?,?,?,?,?,?,?,?)",
    ).get<WriteKind>(
      scope.tenantId,
      scope.workspaceId,
      versionId,
      expectedReviewHash,
      event.to,
      review.reviewHash,
      JSON.stringify(review),
      JSON.stringify({ ...event, sequence: review.events.length }),
      event.at,
    );
    return row?.kind === "updated" ? "updated"
      : row?.kind === "not_found" ? "not_found" : "stale";
  }

  async getLeadPlayVersion(
    scope: StrategyScope,
    versionId: string,
  ): Promise<StoredLeadPlayVersion | null> {
    const row = await this.db.prepare(
      `${PLAY_SELECT} WHERE version_id=? AND tenant_id=? AND workspace_id IS NOT DISTINCT FROM ?`,
    ).get<LeadPlayRow>(versionId, scope.tenantId, scope.workspaceId);
    return row ? mapLeadPlay(row) : null;
  }

  async getLatestLeadPlayVersionByStableKey(
    scope: StrategyScope,
    stableKey: string,
  ): Promise<StoredLeadPlayVersion | null> {
    const row = await this.db.prepare(
      `${PLAY_SELECT} WHERE tenant_id=? AND workspace_id IS NOT DISTINCT FROM ? AND stable_key=?
       ORDER BY revision DESC, created_at DESC LIMIT 1`,
    ).get<LeadPlayRow>(scope.tenantId, scope.workspaceId, stableKey);
    return row ? mapLeadPlay(row) : null;
  }

  async listLeadPlayVersions(scope: StrategyScope): Promise<readonly StoredLeadPlayVersion[]> {
    const rows = await this.db.prepare(
      `${PLAY_SELECT} WHERE tenant_id=? AND workspace_id IS NOT DISTINCT FROM ?
       ORDER BY stable_key, revision, version_id`,
    ).all<LeadPlayRow>(scope.tenantId, scope.workspaceId);
    return Object.freeze(rows.map(mapLeadPlay));
  }

  async appendLeadPlayVersion(
    record: StoredLeadPlayVersion,
  ): Promise<"created" | "replayed" | "conflict"> {
    const row = await this.db.prepare(
      "SELECT kind FROM public.novatrade_l04_append_lead_play_version(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
    ).get<WriteKind>(
      record.tenantId,
      record.workspaceId,
      record.versionId,
      record.stableKey,
      String(record.revision),
      record.supersedesVersionId,
      record.icpVersionId,
      record.understandingVersionId,
      record.contentHash,
      record.review.reviewHash,
      "draft",
      JSON.stringify(record.source),
      JSON.stringify(record.review),
      record.createdAt,
      record.updatedAt,
    );
    return row?.kind === "created" ? "created"
      : row?.kind === "replay" ? "replayed" : "conflict";
  }

  async applyLeadPlayReviewTransition(
    scope: StrategyScope,
    versionId: string,
    expectedReviewHash: string,
    review: LeadPlayReviewSnapshot,
    event: LeadPlayReviewEvent,
  ): Promise<"updated" | "stale" | "not_found"> {
    const row = await this.db.prepare(
      "SELECT kind FROM public.novatrade_l04_transition_lead_play_review(?,?,?,?,?,?,?,?,?)",
    ).get<WriteKind>(
      scope.tenantId,
      scope.workspaceId,
      versionId,
      expectedReviewHash,
      event.to,
      review.reviewHash,
      JSON.stringify(review),
      JSON.stringify({ ...event, sequence: review.events.length }),
      event.at,
    );
    return row?.kind === "updated" ? "updated"
      : row?.kind === "not_found" ? "not_found" : "stale";
  }

  async appendSimulation(
    record: StoredLeadPlaySimulation,
  ): Promise<"created" | "replayed" | "conflict"> {
    const row = await this.db.prepare(
      "SELECT kind FROM public.novatrade_l04_append_lead_play_simulation(?,?,?,?,?,?,?,?,?)",
    ).get<WriteKind>(
      record.tenantId,
      record.workspaceId,
      record.simulationId,
      record.playVersionId,
      record.playReviewHash,
      record.simulationHash,
      JSON.stringify(record.input),
      JSON.stringify(record.simulation),
      record.createdAt,
    );
    return row?.kind === "created" ? "created"
      : row?.kind === "replay" ? "replayed" : "conflict";
  }

  async getLatestSimulationForPlay(
    scope: StrategyScope,
    playVersionId: string,
  ): Promise<StoredLeadPlaySimulation | null> {
    const row = await this.db.prepare(
      `${SIMULATION_SELECT} WHERE tenant_id=? AND workspace_id IS NOT DISTINCT FROM ?
       AND play_version_id=? ORDER BY created_at DESC, simulation_id DESC LIMIT 1`,
    ).get<SimulationRow>(scope.tenantId, scope.workspaceId, playVersionId);
    return row ? mapSimulation(row) : null;
  }

  async listSimulationsForPlay(
    scope: StrategyScope,
    playVersionId: string,
  ): Promise<readonly StoredLeadPlaySimulation[]> {
    const rows = await this.db.prepare(
      `${SIMULATION_SELECT} WHERE tenant_id=? AND workspace_id IS NOT DISTINCT FROM ?
       AND play_version_id=? ORDER BY created_at, simulation_id`,
    ).all<SimulationRow>(scope.tenantId, scope.workspaceId, playVersionId);
    return Object.freeze(rows.map(mapSimulation));
  }

  async appendSimulationReview(
    record: StoredLeadPlaySimulationReview,
  ): Promise<"created" | "replayed" | "conflict"> {
    const row = await this.db.prepare(
      "SELECT kind FROM public.novatrade_l04_append_lead_play_simulation_review(?,?,?,?,?,?,?,?)",
    ).get<WriteKind>(
      record.tenantId,
      record.workspaceId,
      record.playVersionId,
      record.simulationId,
      record.eligibilityHash,
      record.review.decision,
      JSON.stringify(record.review),
      record.createdAt,
    );
    return row?.kind === "created" ? "created"
      : row?.kind === "replay" ? "replayed" : "conflict";
  }

  async getLatestSimulationReview(
    scope: StrategyScope,
    playVersionId: string,
    simulationId: string,
  ): Promise<StoredLeadPlaySimulationReview | null> {
    const row = await this.db.prepare(
      `SELECT tenant_id::text AS tenant_id,workspace_id::text AS workspace_id,
        play_version_id,simulation_id,eligibility_hash,decision,review,created_at
       FROM public.lead_play_simulation_reviews
       WHERE tenant_id=? AND workspace_id IS NOT DISTINCT FROM ?
         AND play_version_id=? AND simulation_id=?
       ORDER BY created_at DESC, eligibility_hash DESC LIMIT 1`,
    ).get<SimulationReviewRow>(
      scope.tenantId, scope.workspaceId, playVersionId, simulationId);
    return row ? mapSimulationReview(row) : null;
  }

  async getActivationState(
    scope: StrategyScope,
    stableKey: string,
  ): Promise<StoredLeadPlayActivation | null> {
    const row = await this.db.prepare(
      `SELECT tenant_id::text AS tenant_id,workspace_id::text AS workspace_id,
        stable_key,state_hash,state,created_at,updated_at
       FROM public.lead_play_activation_states
       WHERE tenant_id=? AND workspace_id IS NOT DISTINCT FROM ? AND stable_key=?`,
    ).get<ActivationRow>(scope.tenantId, scope.workspaceId, stableKey);
    return row ? mapActivation(row) : null;
  }

  async appendActivationState(
    record: StoredLeadPlayActivation,
  ): Promise<"created" | "conflict"> {
    const row = await this.db.prepare(
      "SELECT kind FROM public.novatrade_l04_append_activation_state(?,?,?,?,?,?)",
    ).get<WriteKind>(
      record.tenantId,
      record.workspaceId,
      record.stableKey,
      record.state.stateHash,
      JSON.stringify(record.state),
      record.updatedAt,
    );
    return row?.kind === "created" ? "created" : "conflict";
  }

  async applyActivationTransition(
    scope: StrategyScope,
    stableKey: string,
    expectedStateHash: string,
    state: LeadPlayActivationState,
  ): Promise<"updated" | "stale" | "not_found"> {
    const row = await this.db.prepare(
      "SELECT kind FROM public.novatrade_l04_transition_activation_state(?,?,?,?,?,?,?)",
    ).get<WriteKind>(
      scope.tenantId,
      scope.workspaceId,
      stableKey,
      expectedStateHash,
      state.stateHash,
      JSON.stringify(state),
      state.events.at(-1)?.at ?? state.createdAt,
    );
    return row?.kind === "updated" ? "updated"
      : row?.kind === "not_found" ? "not_found" : "stale";
  }
}

export function createPostgresStrategyRepository(db: DbClient): PostgresStrategyRepository {
  return new PostgresStrategyRepository(db);
}
