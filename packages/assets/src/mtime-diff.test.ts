import { describe, expect, it } from "vitest";
import {
  MANY_EXTERNAL_CHANGES,
  classifyExternalChanges,
  diffAssetMtimes,
} from "./mtime-diff";

describe("diffAssetMtimes", () => {
  it("reports changed, added, and removed paths", () => {
    expect(
      diffAssetMtimes(
        { "assets/a.babasset": 1, "assets/b.babasset": 2 },
        { "assets/a.babasset": 3, "assets/c.babasset": 4 },
      ),
    ).toEqual({
      changedPaths: ["assets/a.babasset"],
      addedPaths: ["assets/c.babasset"],
      removedPaths: ["assets/b.babasset"],
    });
  });
});

describe("classifyExternalChanges", () => {
  it("returns none when mtimes are unchanged", () => {
    const result = classifyExternalChanges({
      previousAssets: { "assets/a.babasset": 1 },
      nextAssets: { "assets/a.babasset": 1 },
      previousProjectJsonMtime: 10,
      nextProjectJsonMtime: 10,
      openDocs: [{ path: "assets/a.babasset", dirty: true }],
    });
    expect(result.kind).toBe("none");
  });

  it("asks to reload a clean open document whose file changed", () => {
    const result = classifyExternalChanges({
      previousAssets: { "assets/a.babasset": 1 },
      nextAssets: { "assets/a.babasset": 2 },
      previousProjectJsonMtime: 10,
      nextProjectJsonMtime: 10,
      openDocs: [{ path: "assets/a.babasset", dirty: false }],
    });
    expect(result.kind).toBe("reload-clean");
    expect(result.cleanChangedPaths).toEqual(["assets/a.babasset"]);
  });

  it("warns when a dirty open document changed on disk", () => {
    const result = classifyExternalChanges({
      previousAssets: { "assets/a.babasset": 1 },
      nextAssets: { "assets/a.babasset": 2 },
      previousProjectJsonMtime: 10,
      nextProjectJsonMtime: 10,
      openDocs: [{ path: "assets/a.babasset", dirty: true }],
    });
    expect(result.kind).toBe("dirty-disk");
    expect(result.dirtyChangedPaths).toEqual(["assets/a.babasset"]);
  });

  it("prefers Reload Project when project.json or many assets change", () => {
    expect(
      classifyExternalChanges({
        previousAssets: { "assets/a.babasset": 1 },
        nextAssets: { "assets/a.babasset": 1 },
        previousProjectJsonMtime: 10,
        nextProjectJsonMtime: 11,
        openDocs: [],
      }).kind,
    ).toBe("reload-project");

    const many: Record<string, number | null> = {};
    const next: Record<string, number | null> = {};
    for (let i = 0; i < MANY_EXTERNAL_CHANGES; i += 1) {
      many[`assets/${i}.babasset`] = 1;
      next[`assets/${i}.babasset`] = 2;
    }
    expect(
      classifyExternalChanges({
        previousAssets: many,
        nextAssets: next,
        previousProjectJsonMtime: 10,
        nextProjectJsonMtime: 10,
        openDocs: [],
      }).kind,
    ).toBe("reload-project");
  });
});
