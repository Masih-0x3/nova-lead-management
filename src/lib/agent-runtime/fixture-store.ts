import { isProxy } from "node:util/types";

import {
  AgentRunRecordError,
  FixtureAgentRunRecordStore,
  type AgentRunRecord,
  type CreateAgentRunInput,
} from "@/lib/agent-runtime/records";
import type {
  AgentRuntimeScope,
  AgentRunStoreOutcome,
  AgentRunStorePort,
  StoredAgentRunInput,
} from "@/lib/agent-runtime/service";

/**
 * In-memory `AgentRunStorePort` over the fixture record store — used by unit
 * tests and any environment without Postgres. Durable run inputs are kept in
 * a side map keyed by run id.
 */
export class FixtureAgentRunStoreAdapter implements AgentRunStorePort {
  readonly #store: FixtureAgentRunRecordStore;
  readonly #inputs = new Map<string, StoredAgentRunInput>();

  constructor(store?: FixtureAgentRunRecordStore) {
    this.#store = store ?? new FixtureAgentRunRecordStore();
  }

  #wrap<T>(fn: () => T): Promise<T> {
    try {
      return Promise.resolve(fn());
    } catch (error) {
      return Promise.reject(error);
    }
  }

  createOrReplay(
    input: CreateAgentRunInput,
    runInput: StoredAgentRunInput,
  ): Promise<AgentRunStoreOutcome> {
    return this.#wrap(() => {
      const result = this.#store.createOrReplay(input);
      if (result.action === "created") {
        if (isProxy(runInput)) throw new AgentRunRecordError("INVALID_AGENT_RUN_RECORD");
        this.#inputs.set(input.id, Object.freeze({ ...runInput }));
      }
      return result.action === "replay"
        ? Object.freeze({ action: "replay" as const, record: result.record, resultRef: result.resultRef })
        : Object.freeze({ action: result.action, record: result.record });
    });
  }

  getRunInput(scope: AgentRuntimeScope, runId: string): Promise<StoredAgentRunInput | null> {
    return this.#wrap(() => {
      const record = this.#store.get({
        tenantId: scope.tenantId, workspaceId: scope.workspaceId, runId });
      return this.#inputs.get(record.id) ?? null;
    });
  }

  get(scope: AgentRuntimeScope & { readonly runId: string }): Promise<AgentRunRecord> {
    return this.#wrap(() => this.#store.get(scope));
  }

  lease(input: AgentRuntimeScope & Readonly<{
    runId: string; workerId: string; leaseToken: string; now: string; leaseDurationMs: number;
  }>): Promise<AgentRunRecord> {
    return this.#wrap(() => this.#store.lease(input));
  }

  heartbeat(input: AgentRuntimeScope & Readonly<{
    runId: string; leaseToken: string; now: string; leaseDurationMs: number;
  }>): Promise<AgentRunRecord> {
    return this.#wrap(() => this.#store.heartbeat(input));
  }

  appendStep(input: Parameters<FixtureAgentRunRecordStore["appendStep"]>[0]
    & AgentRuntimeScope): Promise<AgentRunRecord> {
    return this.#wrap(() => this.#store.appendStep(input));
  }

  appendToolCall(input: Parameters<FixtureAgentRunRecordStore["appendToolCall"]>[0]
    & AgentRuntimeScope): Promise<AgentRunRecord> {
    return this.#wrap(() => this.#store.appendToolCall(input));
  }

  complete(input: Parameters<FixtureAgentRunRecordStore["complete"]>[0]
    & AgentRuntimeScope): Promise<AgentRunRecord> {
    return this.#wrap(() => this.#store.complete(input));
  }

  fail(input: Parameters<FixtureAgentRunRecordStore["fail"]>[0]
    & AgentRuntimeScope): Promise<AgentRunRecord> {
    return this.#wrap(() => this.#store.fail(input));
  }

  cancel(input: AgentRuntimeScope & Readonly<{
    runId: string; canceledAt: string;
  }>): Promise<AgentRunRecord> {
    return this.#wrap(() => this.#store.cancel(input));
  }
}

export function createFixtureAgentRunStoreAdapter(): FixtureAgentRunStoreAdapter {
  return new FixtureAgentRunStoreAdapter();
}
