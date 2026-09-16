/**
 * L-02 local operator driver — bundled by scripts/local-tenant-operator.mjs.
 *
 * Drives the platform-operator invitation operations against the local SQLite
 * compatibility runtime (nosite-leads.db, the DATABASE_URL-absent path) through
 * the canonical services — the same way the seed drives provisionTenant:
 *
 *   status   <invitationId>                 — privacy-safe lifecycle view
 *   reissue  <invitationId> [expiresAtIso]  — supersede + issue generation n+1
 *   revoke   <invitationId>                 — revoke an issued invitation
 *   run-deletion <jobId>                    — worker lane: execute a scheduled
 *                                             tenant deletion to completion
 *   invite   <authIdentityId> [role]        — member-actor pending invite
 *                                             (invitePendingMember + issue) so
 *                                             a pending invitation exists to
 *                                             exercise the operator ops
 *   limit-cap    <authIdentityId> <action> <cap>    — member-actor per-tenant
 *                                                     quota cap change
 *   limit-kill   <authIdentityId> <action> <on|off> — member-actor per-tenant
 *                                                     action kill switch
 *   platform-limit-kill <operatorPrincipalId> ...   — platform kill switch;
 *                                                     needs LOCAL_PLATFORM_OPERATOR_ID
 *
 * Operator ops audit as actorLayer "system" under the configured operator
 * identity (LOCAL_OPERATOR_IDENTITY, default the local operator subject).
 * Every op is journaled: keys are deterministic per command target so an
 * accidental re-run replays the recorded result instead of double-acting.
 * Set LOCAL_OPERATOR_IDEM=<key> to override the derived idempotency key.
 */
import { createHash } from "node:crypto";
import { getDb, getTenantDbContext, withTenantDbContext } from "@/lib/db";
import {
  createLocalInvitationDeliveryAdapter,
  createLocalTenantInvitationService,
} from "@/lib/tenancy/local-tenant-provisioning";
import {
  createLocalTenantMembershipAdministrationService,
  hashLocalAuthIdentitySelector,
} from "@/lib/tenancy/local-membership-administration";
import {
  createLocalTenantLimitBackend,
  createLocalTenantLimitService,
} from "@/lib/tenancy/local-tenant-limits";
import {
  TENANT_LIMIT_ACTIONS,
  type TenantLimitAction,
} from "@/lib/tenancy/limits";
import type { TenantPolicyEvaluator } from "@/lib/tenancy/authorize";
import {
  createLocalExportRunner,
  createLocalTenantLifecycleOperationsService,
} from "@/lib/tenancy/local-lifecycle-operations";
import { createLocalTenantFeatureService } from "@/lib/tenancy/local-features";
import { createLocalTenantRetentionService } from "@/lib/tenancy/local-retention-policy";
import {
  createLocalSupportAccessPolicyEvaluator,
  createLocalSupportAccessRepository,
  createLocalSupportPrincipalResolver,
} from "@/lib/tenancy/local-support-access";
import { createSupportAccessService } from "@/lib/tenancy/support-access";
import { runWithTenantContext } from "@/lib/tenancy/context";
import type { TenantSession } from "@/lib/auth";
import type { LaunchRole } from "@/lib/tenancy/types";
import type { TenantFeatureId } from "@/lib/tenancy/features";
import type { TenantRetentionKnob } from "@/lib/tenancy/retention-policy";

const DEFAULT_OPERATOR_IDENTITY = "00000000-0000-4000-8000-0000000000ff";
const DEFAULT_REASON_CODE = "local.ops";

interface MembershipRow {
  readonly id: string;
  readonly tenant_id: string;
  readonly workspace_id: string | null;
}

interface MemberRow extends MembershipRow {
  readonly role: string;
  readonly binding_id: string;
}

async function memberSession(db: Awaited<ReturnType<typeof getDb>>, identityId: string): Promise<TenantSession> {
  const membership = await db
    .prepare(
      `SELECT m.id, m.tenant_id, m.workspace_id, rb.role, rb.id AS binding_id
       FROM tenant_memberships m
       JOIN tenant_role_bindings rb ON rb.membership_id = m.id AND rb.revoked_at IS NULL
       WHERE m.auth_identity_id = ? AND m.status = 'active'
       ORDER BY m.created_at LIMIT 1`,
    )
    .get<MemberRow>(identityId);
  if (!membership || membership.workspace_id !== null) {
    throw new Error(`No active tenant-wide membership found for ${identityId} — run npm run local:seed:sqlite first.`);
  }
  return {
    userId: identityId,
    email: "operator@local.nosite.test",
    displayName: "Local Operator",
    tenantId: membership.tenant_id,
    workspaceId: null,
    membershipId: membership.id,
    role: membership.role as TenantSession["role"],
    roleBindingId: membership.binding_id,
  };
}

async function ownerSession(db: Awaited<ReturnType<typeof getDb>>, identityId: string): Promise<TenantSession> {
  const session = await memberSession(db, identityId);
  if (session.role !== "owner") {
    throw new Error(`Membership for ${identityId} is ${session.role}, not owner — run npm run local:seed:sqlite first.`);
  }
  return session;
}

const LIMIT_ACTION_SET = new Set<string>(TENANT_LIMIT_ACTIONS);

/**
 * The session-echo evaluator used by executeTenantOperation: a conditional
 * ("C") permission decision passes only when the evaluated policy context
 * binds this session's tenant facts and the tenant policy row exists.
 */
function memberPolicyEcho(
  db: Awaited<ReturnType<typeof getDb>>,
  session: TenantSession,
): TenantPolicyEvaluator {
  return async (context) => ({
    allowed:
      context.tenantId === session.tenantId &&
      context.workspaceId === session.workspaceId &&
      context.membershipId === session.membershipId &&
      !!(await db
        .prepare("SELECT 1 AS present FROM tenant_policies WHERE tenant_id = ?")
        .get(session.tenantId)),
    context,
  });
}

/** Reads the CAS version off a backend runtime-state payload. */
function configurationVersionOf(value: unknown): number | null {
  if (typeof value !== "object" || value === null) return null;
  const version = (value as { configurationVersion?: unknown }).configurationVersion;
  return typeof version === "number" && Number.isSafeInteger(version) && version >= 1 ? version : null;
}

export async function main(argv: readonly string[]): Promise<void> {
  const [command, target, extra, flag] = argv;
  const db = await getDb();
  const delivery = createLocalInvitationDeliveryAdapter();
  const limits = createLocalTenantLimitService(db);
  const invitations = createLocalTenantInvitationService(db, {
    operatorIdentityId: process.env.LOCAL_OPERATOR_IDENTITY ?? DEFAULT_OPERATOR_IDENTITY,
    invitationDelivery: delivery,
    limits,
  });
  const reasonCode = process.env.LOCAL_OPERATOR_REASON_CODE ?? DEFAULT_REASON_CODE;
  const reason = process.env.LOCAL_OPERATOR_REASON ?? "Local operator action";

  switch (command) {
    case "status": {
      const view = await invitations.getInvitationStatus({
        invitationId: target,
        correlationId: `local-operator:status:${target}`,
      });
      console.log(JSON.stringify(view, null, 2));
      return;
    }
    case "reissue": {
      const result = await invitations.reissueInvitation({
        invitationId: target,
        reasonCode,
        reason,
        ...(extra ? { expiresAt: extra } : {}),
        idempotencyKey: process.env.LOCAL_OPERATOR_IDEM ?? `local-operator.reissue.${target}`,
        correlationId: `local-operator:reissue:${target}`,
      });
      console.log(`[operator] reissue ${result.resultCode}: prior=${result.priorInvitationId} next=${result.invitationId} generation=${result.generation} expires=${result.expiresAt} delivery=${result.deliveryState}`);
      return;
    }
    case "revoke": {
      const result = await invitations.revokeInvitation({
        invitationId: target,
        reasonCode,
        reason,
        idempotencyKey: process.env.LOCAL_OPERATOR_IDEM ?? `local-operator.revoke.${target}`,
        correlationId: `local-operator:revoke:${target}`,
      });
      console.log(`[operator] revoke ${result.resultCode}: invitation=${result.invitationId} status=${result.status} at=${result.revokedAt}`);
      return;
    }
    case "invite": {
      // Member-actor path: the owner session invites a pending member and
      // issues the durable invitation — produces exercisable operator state.
      const identityId = target;
      const role = (extra ?? "researcher") as LaunchRole;
      const session = await ownerSession(
        db,
        process.env.LOCAL_SEED_OWNER_IDENTITY_ID ?? "12000000-0000-4000-8000-000000000001",
      );
      const selectorHash = hashLocalAuthIdentitySelector(identityId);
      const memberships = createLocalTenantMembershipAdministrationService(db);
      const invited = await memberships.invitePendingMember(session, {
        identitySelectorHash: selectorHash,
        role,
        workspaceId: null,
        reasonCode: "local_operator_invite",
        correlationId: `local-operator:invite:${identityId}`,
        idempotencyKey: process.env.LOCAL_OPERATOR_IDEM ?? `local-operator.invite-member.${identityId}`,
      });
      const issued = await invitations.issueMembershipInvitation({
        tenantId: session.tenantId,
        membershipId: invited.membership.membershipId,
        role,
        workspaceId: null,
        expectedIdentityRefHash: selectorHash,
        actorMembershipId: session.membershipId,
        actorIdentityId: session.userId,
        idempotencyKey: process.env.LOCAL_OPERATOR_IDEM_ISSUE ?? `local-operator.invite-issue.${identityId}`,
        correlationId: `local-operator:invite-issue:${identityId}`,
      });
      console.log(`[operator] invite membership=${invited.membership.membershipId} invitation=${issued.invitationId} expires=${issued.expiresAt}`);
      return;
    }
    case "feature-set": {
      // Member-actor feature-policy change through the canonical
      // requestFeatureChange path — the local actor resolver proves the
      // caller's feature:manage capability and the executor CASes
      // tenant_policies (version +1 per the guard) with the audit append in
      // one transaction.
      const [identityId, featureId, enabled] = [target, extra, flag];
      if (!identityId || !featureId || (enabled !== "on" && enabled !== "off")) {
        throw new Error("usage: feature-set <authIdentityId> <featureId> <on|off>");
      }
      const session = await memberSession(db, identityId);
      const policy = await db
        .prepare("SELECT version FROM tenant_policies WHERE tenant_id = ?")
        .get<{ version: number }>(session.tenantId);
      if (!policy) throw new Error(`No tenant policy for ${session.tenantId}`);
      const features = createLocalTenantFeatureService(db, {
        actor: { authIdentityId: session.userId, membershipId: session.membershipId },
      });
      const result = await features.requestFeatureChange({
        tenantId: session.tenantId,
        featureId: featureId as TenantFeatureId,
        enabled: enabled === "on",
        expectedPolicyVersion: policy.version,
        reason,
        correlationId: `local-operator:feature-set:${featureId}:${session.tenantId}`,
        humanReviewAcknowledged: true,
      });
      console.log(`[operator] feature-set ${featureId}=${enabled === "on"} status=${result.status} policy=v${result.previousPolicyVersion}->v${result.resultingPolicyVersion}`);
      return;
    }
    case "retention-set": {
      // Member-actor retention-knob change through the canonical
      // requestRetentionChange path — the local actor resolver proves the
      // caller's tenant:manage capability and the executor CASes
      // tenant_policies (version +1 per the guard) with the audit append in
      // one transaction.
      const [identityId, knob, daysArg] = [target, extra, flag];
      const days = Number(daysArg);
      if (!identityId || !knob || !Number.isInteger(days)) {
        throw new Error("usage: retention-set <authIdentityId> <knob> <days>");
      }
      const session = await memberSession(db, identityId);
      const policy = await db
        .prepare("SELECT version FROM tenant_policies WHERE tenant_id = ?")
        .get<{ version: number }>(session.tenantId);
      if (!policy) throw new Error(`No tenant policy for ${session.tenantId}`);
      const retention = createLocalTenantRetentionService(db, {
        actor: { authIdentityId: session.userId, membershipId: session.membershipId },
      });
      const result = await retention.requestRetentionChange({
        tenantId: session.tenantId,
        knob: knob as TenantRetentionKnob,
        days,
        expectedPolicyVersion: policy.version,
        reason,
        correlationId: `local-operator:retention-set:${knob}:${session.tenantId}`,
      });
      console.log(`[operator] retention-set ${knob}=${days} status=${result.status} policy=v${result.previousPolicyVersion}->v${result.resultingPolicyVersion}`);
      return;
    }
    case "limit-cap":
    case "limit-kill": {
      // Member-actor quota-configuration change through the canonical
      // changeConfiguration path — the tenant context supplies authority, the
      // role's budget:manage/feature:manage decision (conditional "C") passes
      // through the session-echo policy evaluator, and the backend CASes
      // tenant_limit_configuration with the audit append in one transaction.
      const [identityId, action, value] = [target, extra, flag];
      const isCap = command === "limit-cap";
      const cap = Number(value);
      const toggled = value === "on" ? true : value === "off" ? false : null;
      if (
        !identityId ||
        !action ||
        !LIMIT_ACTION_SET.has(action) ||
        (isCap && !(Number.isInteger(cap) && cap >= 1)) ||
        (!isCap && toggled === null)
      ) {
        throw new Error(`usage: ${command} <authIdentityId> <action> ${isCap ? "<cap>" : "<on|off>"}`);
      }
      const session = await memberSession(db, identityId);
      const limits = createLocalTenantLimitService(db, {
        policyEvaluator: memberPolicyEcho(db, session),
      });
      const backend = createLocalTenantLimitBackend(db);
      const correlationId = `local-operator:${command}:${action}:${session.tenantId}`;
      const result = await runWithTenantContext(session, correlationId, async () => {
        const expectedVersion = configurationVersionOf(
          await backend.getRuntimeState({ tenantId: session.tenantId, action: action as TenantLimitAction }),
        );
        if (expectedVersion === null) {
          throw new Error(`No limit runtime state for ${session.tenantId}`);
        }
        return limits.changeConfiguration({
          action,
          expectedVersion,
          ...(isCap ? { tenantPolicyCap: cap } : { tenantActionKill: toggled }),
          reason,
          correlationId,
        });
      });
      console.log(`[operator] ${command} ${action} status=${result.status} config=v${result.previousVersion}->v${result.resultingVersion}`);
      return;
    }
    case "platform-limit-kill": {
      // Platform-operator kill switch through the canonical
      // changePlatformKillSwitch path. Locally the operator registry is the
      // LOCAL_PLATFORM_OPERATOR_ID env seam — without it every principal
      // resolves null and the service denies PLATFORM_CONFIGURATION_UNAUTHORIZED.
      const [principalId, scope, third, fourth] = [target, extra, flag, argv[4]];
      const action = scope === "action" ? third : null;
      const toggle = (scope === "global" ? third : fourth) as string | undefined;
      const enabled = toggle === "on" ? true : toggle === "off" ? false : null;
      if (
        !principalId ||
        (scope !== "global" && scope !== "action") ||
        (scope === "action" && (!action || !LIMIT_ACTION_SET.has(action))) ||
        (scope === "global" && fourth !== undefined) ||
        enabled === null
      ) {
        throw new Error("usage: platform-limit-kill <operatorPrincipalId> <global <on|off>|action <action> <on|off>>");
      }
      const registered = process.env.LOCAL_PLATFORM_OPERATOR_ID;
      const limits = createLocalTenantLimitService(db, {
        platformOperatorResolver: {
          resolve: async (candidate) =>
            registered && candidate === registered
              ? { operatorId: candidate, permission: "platform:limit_manage" }
              : null,
        },
      });
      const expectedVersion = configurationVersionOf(
        await createLocalTenantLimitBackend(db).getPlatformRuntimeState(),
      );
      if (expectedVersion === null) {
        throw new Error("No platform limit runtime state.");
      }
      const result = await limits.changePlatformKillSwitch(
        {
          scope: scope as "global" | "action",
          ...(action ? { action } : {}),
          enabled,
          expectedVersion,
          reason,
          correlationId: `local-operator:platform-limit-kill:${scope}:${action ?? "global"}`,
        },
        { kind: "platform_operator", principalId },
      );
      console.log(`[operator] platform-limit-kill ${scope}${action ? `:${action}` : ""}=${enabled} status=${result.status} config=v${result.previousVersion}->v${result.resultingVersion}`);
      return;
    }
    case "support-request":
    case "support-approve":
    case "support-revoke":
    case "support-list": {
      // Member-actor support-grant ops — the service reads the member context
      // installed by runWithTenantContext (same as the HTTP action path).
      const session = await memberSession(
        db,
        command === "support-request" || command === "support-list" ? target : extra,
      );
      const support = createSupportAccessService({
        repository: createLocalSupportAccessRepository(db),
        principalResolver: createLocalSupportPrincipalResolver(db),
        policyEvaluator: createLocalSupportAccessPolicyEvaluator(db),
        limits,
      });
      const result = await runWithTenantContext(session, `local-operator:${command}`, async () => {
        if (command === "support-request") {
          const principalRef = extra;
          if (!principalRef) throw new Error("usage: support-request <authIdentityId> <principalRef> [permissionsCsv] [dataClassesCsv]");
          const now = Date.now();
          // The key charset excludes '@' (support-access TEXT pattern), so the
          // opaque principal reference is hashed into the key material.
          const refHash = createHash("sha256").update(principalRef, "utf8").digest("hex").slice(0, 16);
          const permissions = flag
            ? flag.split(",") as never
            : ["tenant:read", "audit:read"] as never;
          const dataClasses = argv[4]
            ? argv[4].split(",") as never
            : ["tenant_metadata", "audit_operational_metadata"] as never;
          return support.request({
            tenantId: session.tenantId,
            supportPrincipalRef: principalRef,
            reasonCode,
            reason,
            startsAt: new Date(now).toISOString(),
            expiresAt: new Date(now + 2 * 60 * 60 * 1000).toISOString(),
            permissions,
            dataClasses,
            idempotencyKey: process.env.LOCAL_OPERATOR_IDEM ?? `local-operator.support-request.${session.tenantId}.${refHash}`,
          });
        }
        if (command === "support-list") {
          return support.listCurrent({
            tenantId: session.tenantId,
            idempotencyKey: `local-operator.support-list.${session.tenantId}`,
          });
        }
        const grantId = target;
        if (!grantId) throw new Error(`usage: ${command} <grantId> <authIdentityId>`);
        const input = {
          tenantId: session.tenantId,
          grantId,
          idempotencyKey: process.env.LOCAL_OPERATOR_IDEM ?? `local-operator.${command}.${grantId}`,
        };
        return command === "support-approve" ? support.approve(input) : support.revoke(input);
      });
      const grant = (result as { grant?: { id: string; state: string } }).grant;
      console.log(`[operator] ${command} ${result.code}${grant ? `: grant=${grant.id} state=${grant.state}` : ""}`);
      if (command === "support-list") {
        const grants = (result as { grants?: readonly { id: string; state: string; expiresAt: string }[] }).grants ?? [];
        for (const entry of grants) console.log(`[operator]   grant=${entry.id} state=${entry.state} expires=${entry.expiresAt}`);
      }
      return;
    }
    case "support-check": {
      // Support-actor lane: the acting principal comes from the resolver's
      // currentReference binding (the stand-in for the support session), and
      // the call must run outside any member context — mixed contexts deny.
      const [grantId, principalRef] = [target, extra];
      if (!grantId || !principalRef) throw new Error("usage: support-check <grantId> <principalRef>");
      const grant = await db
        .prepare("SELECT tenant_id, workspace_id FROM support_access_grants WHERE id = ?")
        .get<{ tenant_id: string; workspace_id: string | null }>(grantId);
      if (!grant) throw new Error(`No support grant ${grantId}`);
      const permissionRows = await db
        .prepare("SELECT permission FROM support_access_grant_permissions WHERE grant_id = ?")
        .all<{ permission: string }>(grantId);
      const dataClassRows = await db
        .prepare("SELECT data_class FROM support_access_grant_data_classes WHERE grant_id = ?")
        .all<{ data_class: string }>(grantId);
      const support = createSupportAccessService({
        repository: createLocalSupportAccessRepository(db),
        principalResolver: createLocalSupportPrincipalResolver(db, { currentReference: () => principalRef }),
        policyEvaluator: createLocalSupportAccessPolicyEvaluator(db),
        limits,
      });
      const result = await support.check({
        tenantId: grant.tenant_id,
        supportPrincipalRef: principalRef,
        grantId,
        permission: permissionRows[0].permission as never,
        dataClasses: dataClassRows.map((row) => row.data_class) as never,
        correlationId: `local-operator:support-check:${grantId}`,
        idempotencyKey: `local-operator.support-check.${grantId}`,
        ...(grant.workspace_id ? { workspaceId: grant.workspace_id } : {}),
      });
      console.log(`[operator] support-check ${result.code}: grant=${grantId}`);
      return;
    }
    case "support-run":
    case "support-export": {
      // The "use" half of the grant: authorizeAndRun journals the decision and
      // installs the SupportAccessContext the db layer resolves into a
      // source:"support" tenant scope. support-run proves the context inside
      // the callback with a scoped read; support-export additionally drives
      // the canonical requester.supportAccessGrantId path in requestExport —
      // the one op that consumes grant authority — under its data:export
      // permission.
      const [grantId, principalRef] = [target, extra];
      if (!grantId || !principalRef) throw new Error(`usage: ${command} <grantId> <principalRef>`);
      const grant = await db
        .prepare("SELECT tenant_id, workspace_id, support_actor_auth_identity_id FROM support_access_grants WHERE id = ?")
        .get<{ tenant_id: string; workspace_id: string | null; support_actor_auth_identity_id: string }>(grantId);
      if (!grant) throw new Error(`No support grant ${grantId}`);
      const permissionRows = await db
        .prepare("SELECT permission FROM support_access_grant_permissions WHERE grant_id = ?")
        .all<{ permission: string }>(grantId);
      const dataClassRows = await db
        .prepare("SELECT data_class FROM support_access_grant_data_classes WHERE grant_id = ?")
        .all<{ data_class: string }>(grantId);
      const support = createSupportAccessService({
        repository: createLocalSupportAccessRepository(db),
        principalResolver: createLocalSupportPrincipalResolver(db, { currentReference: () => principalRef }),
        policyEvaluator: createLocalSupportAccessPolicyEvaluator(db),
        limits,
      });
      // support-run asserts the grant's own first declared permission;
      // support-export must assert data:export (denied if the grant lacks it).
      const permission = command === "support-export" ? "data:export" : permissionRows[0].permission;
      const result = await support.authorizeAndRun({
        tenantId: grant.tenant_id,
        supportPrincipalRef: principalRef,
        grantId,
        permission: permission as never,
        dataClasses: dataClassRows.map((row) => row.data_class) as never,
        correlationId: `local-operator:${command}:${grantId}`,
        idempotencyKey: `local-operator.${command}.${grantId}`,
        ...(grant.workspace_id ? { workspaceId: grant.workspace_id } : {}),
      }, async (context) => {
        // Inside the installed support context: the db layer must resolve a
        // source:"support" tenant scope (mixed/missing contexts throw).
        const scoped = await withTenantDbContext(async (scopedDb) => {
          const dbContext = getTenantDbContext();
          const members = await scopedDb
            .prepare("SELECT COUNT(*) AS count FROM tenant_memberships WHERE tenant_id = ?")
            .get<{ count: number }>(context.tenantId);
          return { source: dbContext?.source ?? null, grantId: dbContext?.supportGrantId ?? null, members: members?.count ?? -1 };
        });
        if (command === "support-run") return scoped;
        const lifecycle = createLocalTenantLifecycleOperationsService(db, { limits });
        const requested = await lifecycle.requestExport({
          tenantId: context.tenantId,
          workspaceId: context.workspaceId,
          requester: { authIdentityId: context.supportActorAuthIdentityId, supportAccessGrantId: context.supportGrantId },
          idempotencyKey: `local-operator.support-export-request.${grantId}`,
          correlationId: `local-operator:support-export:${grantId}`,
        });
        const ran = await lifecycle.runExport({
          tenantId: context.tenantId,
          jobId: requested.job.id,
          executor: { authIdentityId: context.supportActorAuthIdentityId, layer: "system" },
          correlationId: `local-operator:support-export-run:${grantId}`,
        });
        return { ...scoped, exportJob: ran.job.id, exportStatus: ran.job.status };
      });
      console.log(`[operator] ${command} ${result.code}: grant=${grantId}${result.value ? ` value=${JSON.stringify(result.value)}` : ""}`);
      return;
    }
    case "archive": {
      // Member-actor transition (same op the /tenancy archive action calls).
      const session = await memberSession(db, target);
      const lifecycle = createLocalTenantLifecycleOperationsService(db, { limits });
      const result = await lifecycle.archive({
        tenantId: session.tenantId,
        actor: { authIdentityId: session.userId, layer: "member", membershipId: session.membershipId },
        expectedCurrentState: "active",
        reasonCode,
        reason,
        correlationId: `local-operator:archive:${session.tenantId}`,
      });
      console.log(`[operator] archive ${result.code}: tenant=${session.tenantId} status=${result.tenant.status}`);
      return;
    }
    case "deletion-request": {
      // Member-actor request; wrapped in tenant context so the deletion_request
      // quota consumes exactly like the HTTP action path.
      const session = await memberSession(db, target);
      const lifecycle = createLocalTenantLifecycleOperationsService(db, { limits });
      const result = await runWithTenantContext(session, `local-operator:deletion-request:${target}`, () =>
        lifecycle.requestDeletion({
          tenantId: session.tenantId,
          workspaceId: null,
          requester: { authIdentityId: session.userId, membershipId: session.membershipId },
          idempotencyKey: process.env.LOCAL_OPERATOR_IDEM ?? `local-operator.deletion-request.${session.tenantId}`,
          correlationId: `local-operator:deletion-request:${session.tenantId}`,
        }));
      console.log(`[operator] deletion-request ${result.code}: job=${result.job.id} status=${result.job.status}${result.replayed ? " (replayed)" : ""}`);
      return;
    }
    case "deletion-verify":
    case "deletion-approve":
    case "deletion-cancel":
    case "deletion-requeue": {
      const [jobId, identityId] = [target, extra];
      if (!jobId || !identityId) throw new Error(`usage: ${command} <jobId> <authIdentityId>`);
      const session = await memberSession(db, identityId);
      const job = await db
        .prepare("SELECT tenant_id FROM tenant_deletion_jobs WHERE id = ?")
        .get<{ tenant_id: string }>(jobId);
      if (!job) throw new Error(`No deletion job ${jobId}`);
      const lifecycle = createLocalTenantLifecycleOperationsService(db, { limits });
      const actor = { authIdentityId: session.userId, membershipId: session.membershipId };
      const result = command === "deletion-verify"
        ? await lifecycle.verifyDeletion({ tenantId: job.tenant_id, jobId, verifier: actor, correlationId: `local-operator:verify:${jobId}` })
        : command === "deletion-approve"
          ? await lifecycle.approveDeletion({ tenantId: job.tenant_id, jobId, approver: actor, correlationId: `local-operator:approve:${jobId}` })
          : command === "deletion-requeue"
            ? await lifecycle.requeueDeletion({ tenantId: job.tenant_id, jobId, executor: { ...actor, layer: "member" as const }, correlationId: `local-operator:requeue:${jobId}` })
            : await lifecycle.cancelDeletion({ tenantId: job.tenant_id, jobId, actor: { ...actor, layer: "member" as const }, correlationId: `local-operator:cancel:${jobId}` });
      console.log(`[operator] ${command} ${result.code}: job=${result.job.id} status=${result.job.status}`);
      return;
    }
    case "export-request": {
      // Member-actor export request (same op the /tenancy action calls),
      // wrapped in tenant context so the export_request quota consumes exactly
      // like the HTTP path.
      const session = await memberSession(db, target);
      const lifecycle = createLocalTenantLifecycleOperationsService(db, { limits });
      const result = await runWithTenantContext(session, `local-operator:export-request:${target}`, () =>
        lifecycle.requestExport({
          tenantId: session.tenantId,
          workspaceId: null,
          requester: { authIdentityId: session.userId, membershipId: session.membershipId },
          idempotencyKey: process.env.LOCAL_OPERATOR_IDEM ?? `local-operator.export-request.${session.tenantId}.${target}`,
          correlationId: `local-operator:export-request:${session.tenantId}`,
        }));
      console.log(`[operator] export-request ${result.code}: job=${result.job.id} status=${result.job.status}${result.replayed ? " (replayed)" : ""}`);
      return;
    }
    case "run-export": {
      // Worker lane: the system executor drives the snapshot→redact→artifact
      // pipeline. LOCAL_EXPORT_ARTIFACT_TTL_MS wraps the runner's committed
      // expiresAt so the released→expired sweep window (policy floor: one day)
      // is exercisable in a local session — the row's facts are real; only the
      // artifact's committed lifetime is shortened.
      const job = await db
        .prepare("SELECT tenant_id, status FROM tenant_export_jobs WHERE id = ?")
        .get<{ tenant_id: string; status: string }>(target);
      if (!job) throw new Error(`No export job ${target}`);
      const ttlMs = Number(process.env.LOCAL_EXPORT_ARTIFACT_TTL_MS ?? "");
      const lifecycle = createLocalTenantLifecycleOperationsService(db, {
        limits,
        ...(Number.isFinite(ttlMs) && ttlMs > 0 ? {
          exportRunner: {
            execute: async (input) => {
              const facts = await createLocalExportRunner(db).execute(input);
              return { ...facts, expiresAt: new Date(Date.now() + ttlMs).toISOString() };
            },
            purge: async () => {},
          },
        } : {}),
      });
      const result = await lifecycle.runExport({
        tenantId: job.tenant_id,
        jobId: target,
        executor: { authIdentityId: process.env.LOCAL_OPERATOR_IDENTITY ?? DEFAULT_OPERATOR_IDENTITY, layer: "system" },
        correlationId: `local-operator:run-export:${target}`,
      });
      console.log(`[operator] run-export ${result.code}: job=${result.job.id} status=${result.job.status} expires=${result.job.expiresAt}`);
      return;
    }
    case "export-sweep": {
      // Retention sweep: released→expired past expires_at, expired→deleted
      // after the runner purge. One transition per job per pass — run twice to
      // carry an artifact all the way back to a requestable state.
      const lifecycle = createLocalTenantLifecycleOperationsService(db, { limits });
      const result = await lifecycle.sweepExportRetention({
        tenantId: target,
        executor: { authIdentityId: process.env.LOCAL_OPERATOR_IDENTITY ?? DEFAULT_OPERATOR_IDENTITY, layer: "system" },
        correlationId: `local-operator:export-sweep:${target}`,
      });
      console.log(`[operator] export-sweep ${result.code}: expired=[${result.expiredJobIds.join(",")}] deleted=[${result.deletedJobIds.join(",")}]`);
      return;
    }
    case "run-deletion": {
      // Platform worker lane stand-in: runDeletion takes a system executor —
      // the local runtime has no leased deletion worker, so the operator
      // drives the scheduled job through the canonical executor. The job must
      // be approved (scheduled) and its scheduled_at must have arrived.
      const job = await db
        .prepare("SELECT tenant_id, status, scheduled_at FROM tenant_deletion_jobs WHERE id = ?")
        .get<{ tenant_id: string; status: string; scheduled_at: string | null }>(target);
      if (!job) throw new Error(`No deletion job ${target}`);
      const operator = process.env.LOCAL_OPERATOR_IDENTITY ?? DEFAULT_OPERATOR_IDENTITY;
      // A real worker wakes when the schedule arrives; the local driver uses
      // the service's designed clock seam to advance to the job's scheduled_at
      // (a 1–30 day policy wait can never elapse in a local session). The
      // ledger stays internally consistent — every timestamp the executor
      // writes flows through the same injected clock.
      const wakeAt = job.scheduled_at && new Date(job.scheduled_at).getTime() > Date.now()
        ? new Date(new Date(job.scheduled_at).getTime() + 1000)
        : null;
      const lifecycle = createLocalTenantLifecycleOperationsService(db, {
        limits,
        ...(wakeAt ? { clock: () => wakeAt } : {}),
      });
      const result = await lifecycle.runDeletion({
        tenantId: job.tenant_id,
        jobId: target,
        executor: { authIdentityId: operator, layer: "system" },
        correlationId: `local-operator:run-deletion:${target}`,
      });
      console.log(`[operator] run-deletion ${result.code}: job=${result.job.id} status=${result.job.status}`);
      return;
    }
    default:
      console.error("usage: local:tenancy:operator <status|reissue|revoke> <invitationId> [expiresAtIso]");
      console.error("       local:tenancy:operator invite <authIdentityId> [role]");
      console.error("       local:tenancy:operator feature-set <authIdentityId> <featureId> <on|off>");
      console.error("       local:tenancy:operator retention-set <authIdentityId> <knob> <days>");
      console.error("       local:tenancy:operator limit-cap <authIdentityId> <action> <cap>");
      console.error("       local:tenancy:operator limit-kill <authIdentityId> <action> <on|off>");
      console.error("       local:tenancy:operator platform-limit-kill <operatorPrincipalId> <global <on|off>|action <action> <on|off>>");
      console.error("       local:tenancy:operator support-request <authIdentityId> <principalRef>");
      console.error("       local:tenancy:operator <support-approve|support-revoke> <grantId> <authIdentityId>");
      console.error("       local:tenancy:operator support-list <authIdentityId>");
      console.error("       local:tenancy:operator support-check <grantId> <principalRef>");
      console.error("       local:tenancy:operator <support-run|support-export> <grantId> <principalRef>");
      console.error("       local:tenancy:operator <archive|deletion-request|export-request> <authIdentityId>");
      console.error("       local:tenancy:operator <deletion-verify|deletion-approve|deletion-cancel|deletion-requeue> <jobId> <authIdentityId>");
      console.error("       local:tenancy:operator run-deletion <jobId>");
      console.error("       local:tenancy:operator run-export <jobId>");
      console.error("       local:tenancy:operator export-sweep <tenantId>");
      process.exitCode = 2;
  }
}
