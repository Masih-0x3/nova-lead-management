import { describe, expect, it } from "vitest";
import {
  LEGACY_PLACE_CACHE_METADATA_KEY,
  PLACE_CACHE_METADATA_KEY,
  readPlaceCacheMetadata,
} from "@/lib/place-cache-contract";

describe("place cache metadata contract", () => {
  it("reads metadata stored under the current key", () => {
    expect(readPlaceCacheMetadata({ [PLACE_CACHE_METADATA_KEY]: { schemaVersion: 1, detailsStage: "stage-a" } }))
      .toEqual({ schemaVersion: 1, detailsStage: "stage-a" });
  });

  it("still reads metadata persisted under the pre-rebrand key", () => {
    expect(readPlaceCacheMetadata({ [LEGACY_PLACE_CACHE_METADATA_KEY]: { schemaVersion: 1, detailsStage: "stage-b" } }))
      .toEqual({ schemaVersion: 1, detailsStage: "stage-b" });
  });
});
