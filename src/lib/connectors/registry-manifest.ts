import { isProxy } from "node:util/types";

import { CONNECTOR_CARD_REGISTRY } from "./policy";
import type { ConnectorRegistryVersionRecord } from "./source-policy-registry";

/**
 * Declarative connector manifest (0X3-247). Each connector declares its
 * authorization model, terms posture, capabilities, fields, cost model,
 * rate limits, retention, and health expectations. The manifest is static
 * configuration: durable runtime state lives on the connector-runtime and
 * source-policy-lifecycle foundations (migrations 20260829220000/20260829221000).
 */

export type ConnectorAuthorizationKind = "fixture_only" | "tenant_upload" | "credential_ref";

export type ConnectorManifestEntry = Readonly<{
  sourceCardId: string;
  implementation: "implemented" | "deferred";
  authorization: Readonly<{
    kind: ConnectorAuthorizationKind;
    requiresAttestation: boolean;
    allowedAccountStatuses: readonly ("fixture_only" | "ready")[];
  }>;
  terms: Readonly<{ requiredTermsState: "approved" }>;
  capabilities: Readonly<{
    operations: readonly string[];
    outputFields: readonly string[];
  }>;
  cost: Readonly<{
    unitKind: "provider_request" | "byte" | "record" | "page";
    centsPerUnit: number;
    defaultHardCapUnits: number;
  }>;
  rateLimits: Readonly<{
    requestsPerMinute: number | null;
    maxConcurrency: number;
  }>;
  retention: Readonly<{
    observationDays: number;
    payloadDays: number;
  }>;
  health: Readonly<{
    transport: "none" | "network";
    probe: "none";
    expectedStatus: "fixture_only" | "ready";
  }>;
}>;

const DEFERRED_CARD_IDS = [
  "directories",
  "associations",
  "social_network_profiles",
  "people_data_vendors",
  "licensed_databases",
  "bypass_scraping",
] as const;

function manifestEntry(entry: ConnectorManifestEntry): ConnectorManifestEntry {
  return Object.freeze(entry);
}

function cardCapabilities(sourceCardId: string): Readonly<{
  operations: readonly string[];
  outputFields: readonly string[];
}> {
  const card = Object.hasOwn(CONNECTOR_CARD_REGISTRY, sourceCardId)
    ? CONNECTOR_CARD_REGISTRY[sourceCardId]
    : null;
  return Object.freeze({
    operations: card ? card.operations : Object.freeze([]),
    outputFields: card ? card.fields : Object.freeze([]),
  });
}

export const CONNECTOR_REGISTRY_MANIFEST: Readonly<Record<string, ConnectorManifestEntry>> =
  Object.freeze({
    google_places_legacy: manifestEntry({
      sourceCardId: "google_places_legacy",
      implementation: "implemented",
      authorization: Object.freeze({
        kind: "credential_ref" as const,
        requiresAttestation: false,
        allowedAccountStatuses: Object.freeze(["fixture_only", "ready"] as const),
      }),
      terms: Object.freeze({ requiredTermsState: "approved" as const }),
      capabilities: cardCapabilities("google_places_legacy"),
      cost: Object.freeze({ unitKind: "provider_request" as const, centsPerUnit: 2, defaultHardCapUnits: 500 }),
      rateLimits: Object.freeze({ requestsPerMinute: 30, maxConcurrency: 1 }),
      retention: Object.freeze({ observationDays: 180, payloadDays: 90 }),
      health: Object.freeze({ transport: "none" as const, probe: "none" as const, expectedStatus: "fixture_only" as const }),
    }),
    tenant_upload_document: manifestEntry({
      sourceCardId: "tenant_upload_document",
      implementation: "implemented",
      authorization: Object.freeze({
        kind: "tenant_upload" as const,
        requiresAttestation: true,
        allowedAccountStatuses: Object.freeze(["fixture_only"] as const),
      }),
      terms: Object.freeze({ requiredTermsState: "approved" as const }),
      capabilities: cardCapabilities("tenant_upload_document"),
      cost: Object.freeze({ unitKind: "byte" as const, centsPerUnit: 0, defaultHardCapUnits: 52_428_800 }),
      rateLimits: Object.freeze({ requestsPerMinute: null, maxConcurrency: 1 }),
      retention: Object.freeze({ observationDays: 365, payloadDays: 365 }),
      health: Object.freeze({ transport: "none" as const, probe: "none" as const, expectedStatus: "fixture_only" as const }),
    }),
    customer_list_csv_upload: manifestEntry({
      sourceCardId: "customer_list_csv_upload",
      implementation: "implemented",
      authorization: Object.freeze({
        kind: "tenant_upload" as const,
        requiresAttestation: true,
        allowedAccountStatuses: Object.freeze(["fixture_only"] as const),
      }),
      terms: Object.freeze({ requiredTermsState: "approved" as const }),
      capabilities: cardCapabilities("customer_list_csv_upload"),
      cost: Object.freeze({ unitKind: "record" as const, centsPerUnit: 0, defaultHardCapUnits: 25_000 }),
      rateLimits: Object.freeze({ requestsPerMinute: null, maxConcurrency: 1 }),
      retention: Object.freeze({ observationDays: 365, payloadDays: 365 }),
      health: Object.freeze({ transport: "none" as const, probe: "none" as const, expectedStatus: "fixture_only" as const }),
    }),
    tenant_authorized_urls: manifestEntry({
      sourceCardId: "tenant_authorized_urls",
      implementation: "implemented",
      authorization: Object.freeze({
        kind: "credential_ref" as const,
        requiresAttestation: true,
        allowedAccountStatuses: Object.freeze(["fixture_only", "ready"] as const),
      }),
      terms: Object.freeze({ requiredTermsState: "approved" as const }),
      capabilities: cardCapabilities("tenant_authorized_urls"),
      cost: Object.freeze({ unitKind: "page" as const, centsPerUnit: 0, defaultHardCapUnits: 2_000 }),
      rateLimits: Object.freeze({ requestsPerMinute: 12, maxConcurrency: 1 }),
      retention: Object.freeze({ observationDays: 180, payloadDays: 30 }),
      health: Object.freeze({ transport: "none" as const, probe: "none" as const, expectedStatus: "fixture_only" as const }),
    }),
    public_official_company_website: manifestEntry({
      sourceCardId: "public_official_company_website",
      implementation: "implemented",
      authorization: Object.freeze({
        kind: "credential_ref" as const,
        requiresAttestation: true,
        allowedAccountStatuses: Object.freeze(["fixture_only", "ready"] as const),
      }),
      terms: Object.freeze({ requiredTermsState: "approved" as const }),
      capabilities: cardCapabilities("public_official_company_website"),
      cost: Object.freeze({ unitKind: "page" as const, centsPerUnit: 0, defaultHardCapUnits: 2_000 }),
      rateLimits: Object.freeze({ requestsPerMinute: 12, maxConcurrency: 1 }),
      retention: Object.freeze({ observationDays: 180, payloadDays: 30 }),
      health: Object.freeze({ transport: "none" as const, probe: "none" as const, expectedStatus: "fixture_only" as const }),
    }),
    ...Object.freeze(Object.fromEntries(DEFERRED_CARD_IDS.map((sourceCardId) => [
      sourceCardId,
      manifestEntry({
        sourceCardId,
        implementation: "deferred" as const,
        authorization: Object.freeze({
          kind: "credential_ref" as const,
          requiresAttestation: true,
          allowedAccountStatuses: Object.freeze([] as const),
        }),
        terms: Object.freeze({ requiredTermsState: "approved" as const }),
        capabilities: Object.freeze({
          operations: Object.freeze([] as const),
          outputFields: Object.freeze([] as const),
        }),
        cost: Object.freeze({ unitKind: "provider_request" as const, centsPerUnit: 0, defaultHardCapUnits: 0 }),
        rateLimits: Object.freeze({ requestsPerMinute: null, maxConcurrency: 0 }),
        retention: Object.freeze({ observationDays: 0, payloadDays: 0 }),
        health: Object.freeze({ transport: "none" as const, probe: "none" as const, expectedStatus: "fixture_only" as const }),
      }),
    ]))),
  });

export type ConnectorRegistryHealth = "unregistered" | "deferred" | "misconfigured" | "healthy";

export type ConnectorRegistryEntryView = Readonly<{
  manifest: ConnectorManifestEntry;
  registryVersion: ConnectorRegistryVersionRecord | null;
  health: ConnectorRegistryHealth;
  healthReasons: readonly string[];
}>;

const SHA256 = /^[0-9a-f]{64}$/u;

function operationsMatch(registry: ConnectorRegistryVersionRecord, manifest: ConnectorManifestEntry): boolean {
  return registry.operations.length === manifest.capabilities.operations.length
    && registry.operations.every((operation, index) => operation === manifest.capabilities.operations[index]);
}

function fieldsMatch(registry: ConnectorRegistryVersionRecord, manifest: ConnectorManifestEntry): boolean {
  return registry.outputFields.length === manifest.capabilities.outputFields.length
    && registry.outputFields.every((field, index) => field === manifest.capabilities.outputFields[index]);
}

/**
 * Computes registry health for one manifest entry against the durable registry
 * version row (when present). Fixture-only posture is enforced: a registered
 * version declaring live execution or network transport is misconfigured.
 */
export function evaluateConnectorRegistryHealth(
  manifest: ConnectorManifestEntry,
  registryVersion: ConnectorRegistryVersionRecord | null | undefined,
): ConnectorRegistryEntryView {
  if (!manifest || typeof manifest !== "object" || isProxy(manifest)
    || Object.getPrototypeOf(manifest) !== Object.prototype) {
    throw new TypeError("A connector manifest entry is required");
  }
  if (manifest.implementation === "deferred") {
    return Object.freeze({ manifest, registryVersion: null, health: "deferred", healthReasons: Object.freeze(["CONNECTOR_DEFERRED"]) });
  }
  if (!registryVersion || typeof registryVersion !== "object") {
    return Object.freeze({ manifest, registryVersion: null, health: "unregistered", healthReasons: Object.freeze(["REGISTRY_VERSION_MISSING"]) });
  }
  const reasons: string[] = [];
  if (registryVersion.sourceCardId !== manifest.sourceCardId) reasons.push("SOURCE_CARD_MISMATCH");
  if (registryVersion.executionMode !== "fixture") reasons.push("EXECUTION_MODE_NOT_FIXTURE");
  if (registryVersion.transport !== manifest.health.transport) reasons.push("TRANSPORT_MISMATCH");
  if (typeof registryVersion.adapterSha256 !== "string" || !SHA256.test(registryVersion.adapterSha256)) {
    reasons.push("ADAPTER_HASH_MALFORMED");
  }
  if (!operationsMatch(registryVersion, manifest)) reasons.push("OPERATIONS_MISMATCH");
  if (!fieldsMatch(registryVersion, manifest)) reasons.push("OUTPUT_FIELDS_MISMATCH");
  return Object.freeze({
    manifest,
    registryVersion,
    health: reasons.length === 0 ? "healthy" : "misconfigured",
    healthReasons: Object.freeze(reasons),
  });
}

export function describeConnectorRegistry(
  registryVersions: readonly ConnectorRegistryVersionRecord[],
): readonly ConnectorRegistryEntryView[] {
  const versions = new Map<string, ConnectorRegistryVersionRecord>();
  for (const version of Array.isArray(registryVersions) ? registryVersions : []) {
    if (version && typeof version.sourceCardId === "string" && !versions.has(version.sourceCardId)) {
      versions.set(version.sourceCardId, version);
    }
  }
  return Object.freeze(Object.values(CONNECTOR_REGISTRY_MANIFEST).map((manifest) =>
    evaluateConnectorRegistryHealth(manifest, versions.get(manifest.sourceCardId) ?? null)));
}
