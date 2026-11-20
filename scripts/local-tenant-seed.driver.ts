/**
 * L-02 local seed driver — bundled by scripts/seed-local-tenant-sqlite.mjs.
 *
 * Drives the canonical tenancy services against the local SQLite compatibility
 * runtime (nova-leads.db, the DATABASE_URL-absent path) so the member-facing
 * surfaces under /users and /tenancy are exercisable in a browser:
 *
 *   1. provisionTenant         — operator path; pending tenant + owner invite
 *   2. acceptInvitation(owner) — owner acceptance activates the tenant
 *   3. invitePendingMember + issueMembershipInvitation + acceptInvitation —
 *      optional second member so two-person deletion governance is exercisable
 *
 * Every step is journaled/idempotent: re-running replays the same keys and
 * converges to the same durable state. The script seeds only via the same
 * service layer the app uses — no raw inserts.
 */
import { getDb } from "@/lib/db";
import {
  createLocalInvitationDeliveryAdapter,
  createLocalTenantInvitationService,
  createLocalTenantProvisioningService,
} from "@/lib/tenancy/local-tenant-provisioning";
import {
  createLocalTenantMembershipAdministrationService,
  hashLocalAuthIdentitySelector,
} from "@/lib/tenancy/local-membership-administration";
import { createLocalTenantLimitService } from "@/lib/tenancy/local-tenant-limits";
import { createLocalTenantFeatureService } from "@/lib/tenancy/local-features";
import { createLocalTenantRetentionService } from "@/lib/tenancy/local-retention-policy";
import { TENANT_FEATURES } from "@/lib/tenancy/features";
import { createAppUserForAuthUser, getAppUserByUserId } from "@/lib/app-users";
import type { TenantSession } from "@/lib/auth";
import type { LaunchRole } from "@/lib/tenancy/types";

// Deterministic local identities — mirror scripts/seed-local-tenant.mjs so the
// seeded auth users on the local Supabase stack resolve to these memberships.
const L01_ADMIN_IDENTITY = "12000000-0000-4000-8000-000000000001";
const L01_RESEARCHER_IDENTITY = "12000000-0000-4000-8000-000000000002";
const L01_APPROVER_IDENTITY = "12000000-0000-4000-8000-000000000003";
const L01_SUPPORT_IDENTITY = "12000000-0000-4000-8000-000000000005";
const LOCAL_OPERATOR_IDENTITY = "00000000-0000-4000-8000-0000000000ff";

export interface LocalSeedMember {
  readonly identityId: string;
  readonly email: string;
  readonly role: LaunchRole;
  readonly appRole: "admin" | "researcher";
  readonly displayName: string;
  readonly label: string;
  /** Post-acceptance promotion via assignMemberRole — member invitations cannot issue owner. */
  readonly promoteToOwner?: boolean;
}

export interface LocalSeedConfig {
  readonly tenantSlug: string;
  readonly tenantName: string;
  readonly ownerIdentityId: string;
  readonly ownerEmail: string;
  readonly members: readonly LocalSeedMember[];
  readonly withMember: boolean;
  readonly withAccept: boolean;
}

function env(key: string, fallback: string): string {
  const value = process.env[key]?.trim();
  return value && value.length > 0 ? value : fallback;
}

export function loadConfig(): LocalSeedConfig {
  return {
    tenantSlug: env("LOCAL_SEED_TENANT_SLUG", "local-dev"),
    tenantName: env("LOCAL_SEED_TENANT_NAME", "Local Development"),
    ownerIdentityId: env("LOCAL_SEED_OWNER_IDENTITY_ID", L01_ADMIN_IDENTITY),
    ownerEmail: env("LOCAL_SEED_OWNER_EMAIL", "admin@nova.local"),
    // Two-person deletion governance needs three distinct actors:
    // requester (owner), verifier (owner/admin != requester), approver
    // (owner != requester and != verifier). The verifier defaults to admin
    // and the approver to a second owner so the full chain is exercisable.
    members: [
      {
        identityId: env("LOCAL_SEED_MEMBER_IDENTITY_ID", L01_RESEARCHER_IDENTITY),
        email: env("LOCAL_SEED_MEMBER_EMAIL", "researcher@nova.local"),
        role: env("LOCAL_SEED_MEMBER_ROLE", "admin") as LaunchRole,
        appRole: "researcher",
        displayName: "Local Researcher",
        label: "member",
      },
      {
        identityId: env("LOCAL_SEED_APPROVER_IDENTITY_ID", L01_APPROVER_IDENTITY),
        email: env("LOCAL_SEED_APPROVER_EMAIL", "approver@nova.local"),
        role: "admin" as LaunchRole,
        appRole: "admin",
        displayName: "Local Approver",
        label: "approver",
        // Member invitations cannot issue owner; promoted post-acceptance
        // through the canonical assignMemberRole mutation.
        promoteToOwner: true,
      },
    ],
    withMember: process.env.LOCAL_SEED_MEMBER !== "0",
    withAccept: process.env.LOCAL_SEED_ACCEPT !== "0",
  };
}

async function ensureAppProfile(userId: string, email: string, role: "admin" | "researcher", displayName: string) {
  const existing = await getAppUserByUserId(userId);
  if (existing && existing.status === "active" && existing.role === role) return existing;
  return createAppUserForAuthUser({ userId, email, displayName, role, status: "active", createdBy: null });
}

export async function main(): Promise<void> {
  const config = loadConfig();
  const db = await getDb();
  const delivery = createLocalInvitationDeliveryAdapter();
  const limits = createLocalTenantLimitService(db);

  const provisioning = createLocalTenantProvisioningService(db, {
    operatorIdentityId: LOCAL_OPERATOR_IDENTITY,
    invitationDelivery: delivery,
  });
  const invitations = createLocalTenantInvitationService(db, {
    invitationDelivery: delivery,
    limits,
  });
  const memberships = createLocalTenantMembershipAdministrationService(db);

  const provisioned = await provisioning.provisionTenant({
    organizationName: config.tenantName,
    organizationSlug: config.tenantSlug,
    requestedPolicyVersion: "policy-v1",
    ownerIdentityId: config.ownerIdentityId,
    locale: "en-US",
    timezone: "UTC",
    // No workspace: tenant-admin surfaces (/tenancy, /users) require a
    // tenant-wide membership, and a workspace-bound membership can never
    // resolve tenant scope.
    idempotencyKey: `local-seed.provision.${config.tenantSlug}`,
    correlationId: `local-seed:provision:${config.tenantSlug}`,
  });
  console.log(`[seed] provisionTenant ${provisioned.resultCode}: tenant=${provisioned.tenantId} status=${provisioned.tenantStatus} invitation=${provisioned.invitationId}`);

  const appProfiles = [
    await ensureAppProfile(config.ownerIdentityId, config.ownerEmail, "admin", "Local Admin"),
    ...(config.withMember
      ? await Promise.all(config.members.map((member) =>
          ensureAppProfile(member.identityId, member.email, member.appRole, member.displayName)))
      : []),
  ];
  for (const profile of appProfiles) {
    console.log(`[seed] app_users ${profile.user_id} role=${profile.role} status=${profile.status}`);
  }

  if (!config.withAccept) {
    console.log(`[seed] LOCAL_SEED_ACCEPT=0 — leaving owner invitation issued for manual acceptance: ${provisioned.invitationId}`);
    return;
  }

  const ownerAccept = await invitations.acceptInvitation(config.ownerIdentityId, {
    invitationId: provisioned.invitationId,
    idempotencyKey: `local-seed.accept-owner.${config.tenantSlug}`,
    correlationId: `local-seed:accept-owner:${config.tenantSlug}`,
  });
  console.log(`[seed] acceptInvitation(owner) ${ownerAccept.resultCode}: membership=${ownerAccept.membershipId} tenant=${ownerAccept.tenantStatus}`);

  if (config.withMember) {
    const ownerSession: TenantSession = {
      userId: config.ownerIdentityId,
      email: config.ownerEmail,
      displayName: "Local Admin",
      tenantId: provisioned.tenantId,
      workspaceId: null,
      membershipId: provisioned.membershipId,
      role: "owner",
      roleBindingId: provisioned.roleBindingId,
    };
    for (const member of config.members) {
      const selectorHash = hashLocalAuthIdentitySelector(member.identityId);
      const invited = await memberships.invitePendingMember(ownerSession, {
        identitySelectorHash: selectorHash,
        role: member.role,
        workspaceId: null,
        reasonCode: "local_seed_member",
        correlationId: `local-seed:invite-${member.label}:${config.tenantSlug}`,
        idempotencyKey: `local-seed.invite-${member.label}.${config.tenantSlug}`,
      });
      const issued = await invitations.issueMembershipInvitation({
        tenantId: provisioned.tenantId,
        membershipId: invited.membership.membershipId,
        role: member.role,
        workspaceId: null,
        expectedIdentityRefHash: selectorHash,
        actorMembershipId: provisioned.membershipId,
        actorIdentityId: config.ownerIdentityId,
        idempotencyKey: `local-seed.issue-${member.label}.${config.tenantSlug}`,
        correlationId: `local-seed:issue-${member.label}:${config.tenantSlug}`,
      });
      const memberAccept = await invitations.acceptInvitation(member.identityId, {
        invitationId: issued.invitationId,
        idempotencyKey: `local-seed.accept-${member.label}.${config.tenantSlug}`,
        correlationId: `local-seed:accept-${member.label}:${config.tenantSlug}`,
      });
      console.log(`[seed] ${member.label} ${memberAccept.resultCode}: membership=${memberAccept.membershipId} role=${memberAccept.role}`);
      if (member.promoteToOwner) {
        const promoted = await memberships.assignMemberRole(ownerSession, {
          membershipId: memberAccept.membershipId,
          role: "owner",
          reasonCode: "local_seed_approver",
          correlationId: `local-seed:promote-${member.label}:${config.tenantSlug}`,
          idempotencyKey: `local-seed.promote-${member.label}.${config.tenantSlug}`,
        });
        console.log(`[seed] ${member.label} assignMemberRole owner: ${promoted.code} role=${promoted.membership.role}`);
      }
    }
  }

  // The support-access lane needs a registered platform principal — the
  // grant request resolves supportPrincipalRef against this registry and
  // fails closed without one. Platform-global config (like the local
  // operator identity), not tenant state; replay-safe via OR IGNORE.
  const supportReference = env("LOCAL_SEED_SUPPORT_REFERENCE", "support@nova.local");
  const supportIdentityId = env("LOCAL_SEED_SUPPORT_IDENTITY_ID", L01_SUPPORT_IDENTITY);
  const principal = await db
    .prepare("INSERT OR IGNORE INTO platform_support_principals (reference, auth_identity_id, status) VALUES (?, ?, 'active')")
    .run(supportReference, supportIdentityId);
  if (principal.changes === 1) {
    console.log(`[seed] platform_support_principals ${supportReference} -> ${supportIdentityId}`);
  }

  // The provisioned tenant_policies baseline is restrictive-by-default.
  // primary_delete_within_days drops to its schema minimum (1; the bound is
  // 1–30) through the canonical requestRetentionChange path as the owner
  // member-actor (tenant:manage-capable): the local adapters CAS
  // tenant_policies one version forward and append the member-scope audit
  // event atomically. Like the feature change below this runs after
  // invitations bind their policy version, and the service's own no-op
  // "unchanged" result makes reseeding replay-safe. A 30-day deletion
  // schedule could never be exercised locally.
  const retention = await db
    .prepare("SELECT version, primary_delete_within_days FROM tenant_policies WHERE tenant_id = ?")
    .get<{ version: number; primary_delete_within_days: number }>(provisioned.tenantId);
  if (retention) {
    const retentionPolicy = createLocalTenantRetentionService(db, {
      actor: { authIdentityId: config.ownerIdentityId, membershipId: provisioned.membershipId },
    });
    const shortened = await retentionPolicy.requestRetentionChange({
      tenantId: provisioned.tenantId,
      knob: "primary_delete_within_days",
      days: 1,
      expectedPolicyVersion: retention.version,
      reason: "Seed the local deletion schedule",
      correlationId: `local-seed:retention-primary-delete:${config.tenantSlug}`,
    });
    console.log(`[seed] retention primary_delete_within_days=${shortened.status} policy=v${shortened.previousPolicyVersion}->v${shortened.resultingPolicyVersion}`);
  }

  // copy_export enables through the canonical requestFeatureChange path as
  // the owner member-actor (feature:manage-capable): the local adapters CAS
  // tenant_policies one version forward and append the member-scope audit
  // event atomically. This runs LAST: invitations bind the policy version at
  // issue/acceptance time, so bumping earlier would invalidate them. The
  // service's own no-op "unchanged" result makes reseeding replay-safe.
  const policyForFeature = await db
    .prepare("SELECT version FROM tenant_policies WHERE tenant_id = ?")
    .get<{ version: number }>(provisioned.tenantId);
  if (policyForFeature) {
    const features = createLocalTenantFeatureService(db, {
      actor: { authIdentityId: config.ownerIdentityId, membershipId: provisioned.membershipId },
    });
    const enabled = await features.requestFeatureChange({
      tenantId: provisioned.tenantId,
      featureId: TENANT_FEATURES.COPY_EXPORT,
      enabled: true,
      expectedPolicyVersion: policyForFeature.version,
      reason: "Seed the local export surface",
      correlationId: `local-seed:feature-copy-export:${config.tenantSlug}`,
      humanReviewAcknowledged: true,
    });
    console.log(`[seed] feature copy_export=${enabled.status} policy=v${enabled.previousPolicyVersion}->v${enabled.resultingPolicyVersion}`);
  }

  console.log(`[seed] done — sign in as ${config.ownerEmail} (owner)${config.withMember ? `, ${config.members.map((m) => `${m.email} (${m.role})`).join(" or ")}` : ""} to reach /users and /tenancy`);
}
