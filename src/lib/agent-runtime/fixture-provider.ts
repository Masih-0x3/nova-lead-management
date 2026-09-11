import "server-only";

import { isProxy } from "node:util/types";

import type {
  AgentFixtureModelProvider,
  AgentFixtureModelRequest,
} from "@/lib/agent-runtime/execution";

/**
 * Deterministic local model adapter (L-04 / 0X3-243).
 *
 * The stub satisfies bounded runs now; a real provider binds later behind the
 * same `AgentFixtureModelProvider` seam. It echoes back the boundary binding,
 * derives one schema-valid "fact" claim per serialized evidence record, and
 * reports deterministic token/cost usage. It never performs I/O, never
 * executes embedded instructions, and respects the abort signal.
 */

const MAX_CLAIMS = 32;
const MAX_STATEMENT_CHARS = 240;

// The preflight/settlement boundary requires USD values that round-trip to
// integer micros, so cost is computed in micros: 10 tokens == 1 micro.
function usage(inputTokens: number, outputTokens: number) {
  const totalTokens = inputTokens + outputTokens;
  return Object.freeze({
    inputTokens,
    outputTokens,
    totalTokens,
    costUsd: Math.ceil(totalTokens / 10) / 1_000_000,
  });
}

interface SerializedEvidenceLine {
  readonly kind?: unknown;
  readonly locator?: unknown;
  readonly instructionLike?: unknown;
  readonly truncated?: unknown;
  readonly text?: unknown;
}

function statementFrom(text: string, instructionLike: boolean): string {
  const cleaned = text.replace(/\s+/gu, " ").trim();
  const prefix = instructionLike ? "Evidence flagged instruction-like: " : "Evidence states: ";
  const body = cleaned.slice(0, MAX_STATEMENT_CHARS - prefix.length);
  return `${prefix}${body}`;
}

async function executeFixture(request: AgentFixtureModelRequest): Promise<unknown> {
  if (isProxy(request) || request.signal.aborted) {
    throw new Error("fixture provider aborted");
  }

  const lines = request.context.serialized.split("\n");
  const claims: Array<Readonly<{
    statement: string;
    kind: "fact";
    support: "supported";
    citations: readonly Readonly<{ locator: string; status: "current" }>[];
  }>> = [];
  for (const line of lines) {
    if (claims.length >= MAX_CLAIMS) break;
    let parsed: SerializedEvidenceLine | null = null;
    try {
      const candidate = JSON.parse(line) as SerializedEvidenceLine;
      if (candidate && candidate.kind === "untrusted_data"
        && typeof candidate.locator === "string" && candidate.locator.trim().length > 0
        && typeof candidate.text === "string" && candidate.text.trim().length > 0) {
        parsed = candidate;
      }
    } catch {
      parsed = null;
    }
    if (!parsed) continue;
    claims.push(Object.freeze({
      statement: statementFrom(parsed.text as string, parsed.instructionLike === true),
      kind: "fact" as const,
      support: "supported" as const,
      citations: Object.freeze([
        Object.freeze({ locator: parsed.locator as string, status: "current" as const }),
      ]),
    }));
  }
  if (claims.length === 0) {
    claims.push(Object.freeze({
      statement: "No usable evidence records were supplied.",
      kind: "fact" as const,
      support: "supported" as const,
      citations: Object.freeze([
        Object.freeze({ locator: "agent-context:empty", status: "current" as const }),
      ]),
    }));
  }

  const output = Object.freeze({
    version: 1 as const,
    summary: `fixture synthesis over ${claims.length} evidence claim(s)`,
    claims: Object.freeze(claims),
  });

  const inputTokens = Math.max(1, Math.ceil(request.context.serialized.length / 8));
  const outputTokens = Math.min(
    request.requestedOutputTokens,
    Math.max(1, Math.ceil(JSON.stringify(output).length / 8)),
  );
  return Object.freeze({
    version: 1 as const,
    boundaryBindingSha256: request.boundaryBindingSha256,
    output,
    usage: usage(inputTokens, outputTokens),
  });
}

export function createDeterministicFixtureProvider(): AgentFixtureModelProvider {
  return Object.freeze({ kind: "fixture" as const, execute: executeFixture });
}
