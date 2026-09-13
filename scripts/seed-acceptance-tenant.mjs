#!/usr/bin/env node
// L-08 acceptance seed: an isolated `acceptance-proof` tenant with an invited
// admin (owner) and approver (reviewer) identity on loopback PostgreSQL.
// Follows scripts/seed-local-tenant.mjs conventions: deterministic ids,
// idempotent upserts, refuse-by-default against non-loopback targets, and no
// printed secrets. It never repoints the singleton public.settings row — that
// belongs to the local-demo tenant used by the existing suites.
//
// The membership administration server actions are SQLite-only
// (isLocalMembershipAdministrationAvailable() is false when DATABASE_URL is
// set), so the PG invite step is provisioned the same way the L-01 seed
// provisions its identities: the script materializes the post-accept state
// (active membership + role binding + confirmed auth user) that an invite
// accept would produce.

import { argv, env, exit } from "node:process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { resolve } from "node:path";
import { readFileSync } from "node:fs";
import postgres from "postgres";

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "::1", "localhost"]);
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Deterministic acceptance identities, disjoint from the L-01 local-demo ids.
// The e2e specs import the same JSON so the constants cannot drift.
export const ACCEPTANCE_IDS = Object.freeze(
  JSON.parse(
    readFileSync(fileURLToPath(new URL("../e2e/acceptance-ids.json", import.meta.url)), "utf8"),
  ),
);

// Documented local-only defaults so `seed + playwright --project=acceptance`
// works with zero extra env on the disposable loopback stack. Real overrides
// come from env; generated or default values are never echoed back.
const DEFAULT_ADMIN_PASSWORD = "acceptance-admin-local";
const DEFAULT_APPROVER_PASSWORD = "acceptance-approver-local";

export const ACCEPTANCE_EMAILS = Object.freeze({
  admin: (env.ACCEPTANCE_ADMIN_EMAIL ?? "acceptance-admin@nova.local").trim().toLowerCase(),
  approver: (env.ACCEPTANCE_APPROVER_EMAIL ?? "acceptance-approver@nova.local").trim().toLowerCase(),
});

function fail(message) {
  console.error(`[seed-acceptance-tenant] ${message}`);
  exit(1);
}

function requiredEnv(name) {
  const value = env[name]?.trim();
  if (!value) fail(`${name} is required`);
  return value;
}

function password(name, fallback) {
  const provided = env[name]?.trim();
  return provided || fallback;
}

function assertLoopback(databaseUrl) {
  if (env.LOCAL_SEED_ALLOW_REMOTE === "1") return;
  const parsed = new URL(databaseUrl);
  if (!LOOPBACK_HOSTS.has(parsed.hostname)) {
    fail(`refusing to seed non-loopback target ${parsed.hostname}; set LOCAL_SEED_ALLOW_REMOTE=1 only for an approved disposable target`);
  }
}

async function main() {
  for (const id of Object.values(ACCEPTANCE_IDS)) {
    if (!UUID_PATTERN.test(id)) fail(`internal seed identity constant is not a UUID: ${id}`);
  }
  const databaseUrl = requiredEnv("DATABASE_URL");
  assertLoopback(databaseUrl);

  const adminPassword = password("ACCEPTANCE_ADMIN_PASSWORD", DEFAULT_ADMIN_PASSWORD);
  const approverPassword = password("ACCEPTANCE_APPROVER_PASSWORD", DEFAULT_APPROVER_PASSWORD);
  const now = new Date().toISOString();

  const sql = postgres(databaseUrl, {
    max: 1,
    prepare: false,
    onnotice: () => undefined,
    connect_timeout: 10,
  });

  try {
    await sql.unsafe("CREATE EXTENSION IF NOT EXISTS pgcrypto WITH SCHEMA public");
    await sql.begin(async (tx) => {
      for (const [id, email, pass] of [
        [ACCEPTANCE_IDS.adminIdentityId, ACCEPTANCE_EMAILS.admin, adminPassword],
        [ACCEPTANCE_IDS.approverIdentityId, ACCEPTANCE_EMAILS.approver, approverPassword],
      ]) {
        await tx.unsafe(`
          INSERT INTO auth.users (
            id, instance_id, aud, role, email, encrypted_password, email_confirmed_at,
            confirmation_token, recovery_token, email_change_token_new,
            email_change_token_current, phone_change_token, reauthentication_token,
            email_change, phone_change, email_change_confirm_status,
            is_super_admin, is_sso_user,
            raw_app_meta_data, raw_user_meta_data, created_at, updated_at
          ) VALUES ($1, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', $2, public.crypt($3, public.gen_salt('bf')), $4,
            '', '', '', '', '', '', '', '', 0, false, false, $5::jsonb, $6::jsonb, $7, $7)
          ON CONFLICT (id) DO UPDATE SET
            aud = EXCLUDED.aud,
            role = EXCLUDED.role,
            instance_id = EXCLUDED.instance_id,
            confirmation_token = EXCLUDED.confirmation_token,
            recovery_token = EXCLUDED.recovery_token,
            email_change_token_new = EXCLUDED.email_change_token_new,
            email_change_token_current = EXCLUDED.email_change_token_current,
            phone_change_token = EXCLUDED.phone_change_token,
            reauthentication_token = EXCLUDED.reauthentication_token,
            email_change = EXCLUDED.email_change,
            phone_change = EXCLUDED.phone_change,
            email_change_confirm_status = EXCLUDED.email_change_confirm_status,
            is_super_admin = EXCLUDED.is_super_admin,
            is_sso_user = EXCLUDED.is_sso_user,
            email = EXCLUDED.email,
            encrypted_password = EXCLUDED.encrypted_password,
            email_confirmed_at = EXCLUDED.email_confirmed_at,
            raw_app_meta_data = EXCLUDED.raw_app_meta_data,
            raw_user_meta_data = EXCLUDED.raw_user_meta_data,
            updated_at = EXCLUDED.updated_at`,
          [id, email, pass, now, { provider: "email", providers: ["email"] }, {}, now]);
        await tx.unsafe(`
          INSERT INTO auth.identities (
            id, user_id, provider_id, provider, identity_data,
            last_sign_in_at, created_at, updated_at
          ) VALUES (extensions.gen_random_uuid(), $1, $2::text, 'email', $3::jsonb, $4, $4, $4)
          ON CONFLICT (provider_id, provider) DO UPDATE SET
            user_id = EXCLUDED.user_id,
            identity_data = EXCLUDED.identity_data,
            updated_at = EXCLUDED.updated_at`,
          [id, email, { sub: id, email, email_verified: true }, now]);
      }

      await tx.unsafe(`
        INSERT INTO public.tenants (id, slug, name, status, locale, timezone)
        VALUES ($1, 'acceptance-proof', 'Acceptance Proof Tenant', 'active', 'en-US', 'UTC')
        ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name, status = EXCLUDED.status, updated_at = now()`,
      [ACCEPTANCE_IDS.tenantId]);
      await tx.unsafe(`
        INSERT INTO public.workspaces (id, tenant_id, slug, name, status)
        VALUES ($1, $2, 'main', 'Acceptance Workspace', 'active')
        ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name, status = EXCLUDED.status, updated_at = now()`,
      [ACCEPTANCE_IDS.workspaceId, ACCEPTANCE_IDS.tenantId]);

      for (const [membershipId, identityId] of [
        [ACCEPTANCE_IDS.adminMembershipId, ACCEPTANCE_IDS.adminIdentityId],
        [ACCEPTANCE_IDS.approverMembershipId, ACCEPTANCE_IDS.approverIdentityId],
      ]) {
        await tx.unsafe(`
          INSERT INTO public.tenant_memberships (id, tenant_id, auth_identity_id, workspace_id, status)
          VALUES ($1, $2, $3, NULL, 'active')
          ON CONFLICT (id) DO UPDATE SET
            auth_identity_id = EXCLUDED.auth_identity_id,
            workspace_id = EXCLUDED.workspace_id,
            status = EXCLUDED.status,
            updated_at = now()`, [membershipId, ACCEPTANCE_IDS.tenantId, identityId]);
      }

      // The approver needs admin (not reviewer): L-04 understanding/strategy
      // routes admit only owner/admin for C-rated approve permissions, so a
      // reviewer identity could never complete the approval chain.
      for (const [bindingId, membershipId, role] of [
        [ACCEPTANCE_IDS.adminBindingId, ACCEPTANCE_IDS.adminMembershipId, "owner"],
        [ACCEPTANCE_IDS.approverBindingId, ACCEPTANCE_IDS.approverMembershipId, "admin"],
      ]) {
        // tenant_role_bindings is an immutable ledger (guard freezes every
        // column; audit_logs FK-reference rows), so idempotency means: insert
        // when absent, verify when present. Never delete or rewrite.
        const existing = await tx.unsafe(
          "SELECT membership_id, role, revoked_at FROM public.tenant_role_bindings WHERE id = $1",
          [bindingId]);
        if (existing.length === 0) {
          await tx.unsafe(`
            INSERT INTO public.tenant_role_bindings (id, tenant_id, membership_id, role, created_at, valid_from, reason_code)
            VALUES ($1, $2, $3, $4, now() - interval '1 hour', now() - interval '1 hour', 'initial_provisioning')`,
          [bindingId, ACCEPTANCE_IDS.tenantId, membershipId, role]);
        } else if (existing[0].membership_id !== membershipId
          || existing[0].role !== role
          || existing[0].revoked_at !== null) {
          throw new Error(
            `tenant_role_bindings ${bindingId} exists but is revoked/mismatched ` +
            `(role=${existing[0].role}, revoked_at=${existing[0].revoked_at}); ` +
            "bindings are immutable — repair manually before reseeding");
        }
      }

      await tx.unsafe(`
        INSERT INTO public.tenant_policies (
          id, tenant_id, ai_processing_enabled, source_research_enabled,
          contact_research_enabled, outreach_drafting_enabled, copy_export_enabled
        ) VALUES ($1, $2, true, true, true, true, true)
        ON CONFLICT (tenant_id) DO UPDATE SET
          version = public.tenant_policies.version + 1,
          ai_processing_enabled = EXCLUDED.ai_processing_enabled,
          source_research_enabled = EXCLUDED.source_research_enabled,
          contact_research_enabled = EXCLUDED.contact_research_enabled,
          outreach_drafting_enabled = EXCLUDED.outreach_drafting_enabled,
          copy_export_enabled = EXCLUDED.copy_export_enabled,
          updated_at = now()`, [ACCEPTANCE_IDS.policyId, ACCEPTANCE_IDS.tenantId]);

      for (const [userId, email, displayName, role] of [
        [ACCEPTANCE_IDS.adminIdentityId, ACCEPTANCE_EMAILS.admin, "Acceptance Admin", "admin"],
        [ACCEPTANCE_IDS.approverIdentityId, ACCEPTANCE_EMAILS.approver, "Acceptance Approver", "admin"],
      ]) {
        await tx.unsafe(`
          INSERT INTO public.app_users (id, user_id, email, display_name, role, status, created_by, created_at, updated_at)
          VALUES (extensions.gen_random_uuid(), $1, $2, $3, $4, 'active', NULL, $5, $5)
          ON CONFLICT (user_id) DO UPDATE SET
            email = EXCLUDED.email,
            display_name = EXCLUDED.display_name,
            role = EXCLUDED.role,
            status = EXCLUDED.status,
            updated_at = EXCLUDED.updated_at`,
        [userId, email, displayName, role, now]);
      }
    });

    console.log("[seed-acceptance-tenant] seeded acceptance tenant foundation");
    console.log(`  tenant id: ${ACCEPTANCE_IDS.tenantId} (slug acceptance-proof); workspace: ${ACCEPTANCE_IDS.workspaceId}`);
    console.log(`  admin identity: ${ACCEPTANCE_EMAILS.admin} -> ${ACCEPTANCE_IDS.adminIdentityId} (role owner)`);
    console.log(`  approver identity: ${ACCEPTANCE_EMAILS.approver} -> ${ACCEPTANCE_IDS.approverIdentityId} (role admin)`);
    console.log("  passwords: env ACCEPTANCE_ADMIN_PASSWORD / ACCEPTANCE_APPROVER_PASSWORD or documented local defaults");
  } catch (error) {
    fail(error instanceof Error ? error.message : String(error));
  } finally {
    await sql.end({ timeout: 1 });
  }
}

if (argv[1] && pathToFileURL(resolve(argv[1])).href === import.meta.url) {
  void main();
}
