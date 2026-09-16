import "server-only";

import type { DbClient } from "@/lib/db";
import type {
  AgentRuntimeRegistry,
  StoredAgentPolicyVersion,
  StoredAgentPromptVersion,
} from "@/lib/agent-runtime/prompts";
import { agentPolicyRef, agentPromptRef, seedL04AgentRuntime } from "@/lib/agent-runtime/prompts";

/**
 * Postgres registry adapter (L-04 / 0X3-243).
 *
 * The DB registry is the authoritative attestation that a (key, version) pair
 * is registered; prompt bodies and policy limits stay in code seeds so no
 * instruction text is ever persisted or served from the database. A seed row
 * whose stored hash disagrees with the code definition fails closed at
 * preflight — exactly the drift defense the hash is for.
 */

const PROMPT_REGISTER_SQL =
  "SELECT kind FROM public.novatrade_l04_register_agent_prompt(?,?,?,?,?,?)";
const POLICY_REGISTER_SQL =
  "SELECT kind FROM public.novatrade_l04_register_agent_policy(?,?,?,?,?,?,?,?)";

/**
 * Idempotently attests the code-seeded prompt/policy versions through the
 * member-gated registry append capability. Returns the count of rows that
 * were created; replays and conflicts are surfaced in the returned detail.
 */
export async function seedL04AgentRuntimeRegistry(db: DbClient): Promise<Readonly<{
  prompts: readonly Readonly<{ ref: string; kind: string }>[];
  policies: readonly Readonly<{ ref: string; kind: string }>[];
}>> {
  const seeds = seedL04AgentRuntime();
  const prompts: { ref: string; kind: string }[] = [];
  const policies: { ref: string; kind: string }[] = [];
  for (const prompt of seeds.prompts) {
    const row = await db.prepare(PROMPT_REGISTER_SQL).get<{ kind?: unknown }>(
      prompt.promptKey,
      String(prompt.version),
      prompt.instructionsRef,
      prompt.instructionsSha256,
      JSON.stringify(prompt.allowedTools),
      JSON.stringify(prompt.allowedClassifications),
    );
    prompts.push(Object.freeze({
      ref: agentPromptRef(prompt.promptKey, prompt.version),
      kind: typeof row?.kind === "string" ? row.kind : "denied",
    }));
  }
  for (const policy of seeds.policies) {
    const row = await db.prepare(POLICY_REGISTER_SQL).get<{ kind?: unknown }>(
      policy.policyKey,
      String(policy.version),
      policy.provider,
      policy.model,
      policy.state,
      policy.policySha256,
      JSON.stringify(policy.allowedTools),
      JSON.stringify(policy.allowedClassifications),
    );
    policies.push(Object.freeze({
      ref: agentPolicyRef(policy.policyKey, policy.version),
      kind: typeof row?.kind === "string" ? row.kind : "denied",
    }));
  }
  return Object.freeze({
    prompts: Object.freeze(prompts),
    policies: Object.freeze(policies),
  });
}

/**
 * Registry that serves the code-seeded definitions but only for rows that are
 * attested present in `agent_prompt_versions`/`agent_policy_versions` under
 * the caller's member context. An unattested or drifted row resolves to null.
 */
export async function createSeededAgentRuntimeRegistry(db: DbClient): Promise<AgentRuntimeRegistry> {
  const seeds = seedL04AgentRuntime();
  const promptRows = await db.prepare(
    "SELECT prompt_key, version::text AS version, instructions_ref, instructions_sha256, allowed_tools, allowed_classifications FROM public.agent_prompt_versions",
  ).all<{
    prompt_key: string;
    version: string;
    instructions_ref: string;
    instructions_sha256: string;
    allowed_tools: unknown;
    allowed_classifications: unknown;
  }>();
  const policyRows = await db.prepare(
    "SELECT policy_key, version::text AS version, provider, model, state, policy_sha256, allowed_tools, allowed_classifications FROM public.agent_policy_versions",
  ).all<{
    policy_key: string;
    version: string;
    provider: string;
    model: string;
    state: string;
    policy_sha256: string;
    allowed_tools: unknown;
    allowed_classifications: unknown;
  }>();

  const attestedPrompts = new Map<string, true>();
  for (const row of promptRows) {
    const version = Number(row.version);
    if (!Number.isSafeInteger(version)) continue;
    const ref = agentPromptRef(row.prompt_key, version);
    const seed = seeds.prompts.find((candidate) =>
      agentPromptRef(candidate.promptKey, candidate.version) === ref);
    if (seed && seed.instructionsRef === row.instructions_ref
      && seed.instructionsSha256 === row.instructions_sha256) {
      attestedPrompts.set(ref, true);
    }
  }
  const attestedPolicies = new Map<string, true>();
  for (const row of policyRows) {
    const version = Number(row.version);
    if (!Number.isSafeInteger(version)) continue;
    const ref = agentPolicyRef(row.policy_key, version);
    const seed = seeds.policies.find((candidate) =>
      agentPolicyRef(candidate.policyKey, candidate.version) === ref);
    if (seed && seed.provider === row.provider && seed.model === row.model
      && seed.state === row.state && seed.policySha256 === row.policy_sha256) {
      attestedPolicies.set(ref, true);
    }
  }

  const promptByRef = new Map<string, StoredAgentPromptVersion>();
  for (const prompt of seeds.prompts) {
    const ref = agentPromptRef(prompt.promptKey, prompt.version);
    if (attestedPrompts.has(ref)) promptByRef.set(ref, prompt);
  }
  const policyByRef = new Map<string, StoredAgentPolicyVersion>();
  for (const policy of seeds.policies) {
    const ref = agentPolicyRef(policy.policyKey, policy.version);
    if (attestedPolicies.has(ref)) policyByRef.set(ref, policy);
  }
  const latest = <T extends { version: number }>(rows: T[]): T | null =>
    rows.reduce<T | null>((best, row) => (best === null || row.version > best.version ? row : best), null);

  return Object.freeze({
    getPrompt(promptKey: string, version: number): StoredAgentPromptVersion | null {
      return promptByRef.get(agentPromptRef(promptKey, version)) ?? null;
    },
    getLatestPrompt(promptKey: string): StoredAgentPromptVersion | null {
      return latest([...promptByRef.values()].filter((row) => row.promptKey === promptKey));
    },
    getPolicy(policyKey: string, version: number): StoredAgentPolicyVersion | null {
      return policyByRef.get(agentPolicyRef(policyKey, version)) ?? null;
    },
    getLatestPolicy(policyKey: string): StoredAgentPolicyVersion | null {
      return latest([...policyByRef.values()].filter((row) => row.policyKey === policyKey));
    },
  });
}
