import { AsyncLocalStorage } from "node:async_hooks";

/**
 * The edge-asserted support session. Platform infrastructure authenticates a
 * platform-support principal and asserts the tenant/workspace/grant envelope
 * the request operates under; the db layer maps the assertion to the same
 * transaction-local GUCs a service-minted SupportAccessContext produces, so
 * SECURITY DEFINER lane gates and the RLS support predicates re-validate it
 * server-side.
 *
 * The assertion is not authorization: installing it never proves the grant is
 * live — it only names the grant, actor, tenant, and correlation the request
 * claims. `novatrade_rls_support_context()` remains the authority on whether
 * the envelope actually admits data access, and the support-access service's
 * check/authorizeAndRun re-validate the grant under it before minting the
 * run-scoped SupportAccessContext.
 */
export interface SupportSessionAssertion {
  readonly tenantId: string;
  readonly workspaceId: string | null;
  readonly actorAuthIdentityId: string;
  readonly supportGrantId: string;
  readonly correlationId: string;
}

export class SupportSessionContextError extends Error {
  code: "SUPPORT_SESSION_INVALID" | "SUPPORT_SESSION_REQUIRED" = "SUPPORT_SESSION_INVALID";

  constructor(message = "The support session assertion is invalid") {
    super(message);
    this.name = "SupportSessionContextError";
  }
}

export class SupportSessionContextRequiredError extends SupportSessionContextError {
  constructor() {
    super("A support session assertion is required");
    this.name = "SupportSessionContextRequiredError";
    this.code = "SUPPORT_SESSION_REQUIRED";
  }
}

const supportSessionStorage = new AsyncLocalStorage<SupportSessionAssertion>();

function freezeContext(assertion: SupportSessionAssertion): SupportSessionAssertion {
  return Object.freeze({ ...assertion });
}

function sameContext(left: SupportSessionAssertion, right: SupportSessionAssertion): boolean {
  return left.tenantId === right.tenantId &&
    left.workspaceId === right.workspaceId &&
    left.actorAuthIdentityId === right.actorAuthIdentityId &&
    left.supportGrantId === right.supportGrantId &&
    left.correlationId === right.correlationId;
}

/** Installs only an edge-asserted support envelope for this callback lifetime. */
export function runWithSupportSession<T>(
  assertion: SupportSessionAssertion,
  callback: () => T,
): T {
  if (typeof callback !== "function") throw new SupportSessionContextError();

  const next = freezeContext(assertion);
  const current = supportSessionStorage.getStore();
  if (current && !sameContext(current, next)) {
    throw new SupportSessionContextError("The support session assertion conflicts with the active context");
  }

  return supportSessionStorage.run(current ?? next, callback);
}

export function getSupportSession(): SupportSessionAssertion | null {
  return supportSessionStorage.getStore() ?? null;
}

export function requireSupportSession(): SupportSessionAssertion {
  const assertion = getSupportSession();
  if (!assertion) throw new SupportSessionContextRequiredError();
  return assertion;
}
