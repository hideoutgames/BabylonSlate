import { describe, expect, it } from "vitest";
import { sameActorTags, withActorTags } from "./actor-defaults-grid";

describe("Actor Tags authoring", () => {
  it("stores Tags only where they differ from the inherited ones, so a match keeps following the Class", () => {
    const inherited = { Tags: [1, 2] };
    expect(withActorTags({ initialIndex: 0 }, { Tags: [3] }, inherited)).toEqual({ initialIndex: 0, actorTags: { Tags: [3] } });
    expect(withActorTags({ initialIndex: 0, actorTags: { Tags: [3] } }, { Tags: [2, 1] }, inherited)).toEqual({ initialIndex: 0 });
    expect(withActorTags({ actorTags: { Tags: [3] } }, inherited, inherited)).toBeUndefined();
    // Clearing every inherited Tag is an override of its own.
    expect(withActorTags(undefined, { Tags: [] }, inherited)).toEqual({ actorTags: { Tags: [] } });
    expect(sameActorTags({ Tags: [1, 2] }, { Tags: [2, 1] })).toBe(true);
    expect(sameActorTags({ Tags: [1] }, { Tags: [1, 2] })).toBe(false);
  });
});
