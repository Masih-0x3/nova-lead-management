import type {
  ConnectorFixtureExecutorResolver,
  ConnectorFixturePageExecutor,
} from "./runner";

/**
 * Built-in fixture executor registry. Entries map a source card to the
 * executor that pages its approved fixture dataset. No connector card ships
 * with a durable fixture dataset binding yet — run inputs persist only their
 * hash, so a dataset cannot be reconstructed here — therefore the registry is
 * intentionally empty and scheduled ticks idle with `no_fixture_executor`
 * instead of fabricating observations. When a fixture store lands, bind cards
 * to dataset-backed executors in this map only; never bind a live provider.
 */
const CONNECTOR_FIXTURE_EXECUTORS: Readonly<Record<string, ConnectorFixturePageExecutor>> =
  Object.freeze({});

export const resolveConnectorFixtureExecutor: ConnectorFixtureExecutorResolver = (
  sourceCardId,
) => (Object.hasOwn(CONNECTOR_FIXTURE_EXECUTORS, sourceCardId)
  ? CONNECTOR_FIXTURE_EXECUTORS[sourceCardId]
  : null);
