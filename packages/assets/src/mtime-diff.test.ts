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
        { "assets/a.hasset": 1, "assets/b.hasset": 2 },
        { "assets/a.hasset": 3, "assets/c.hasset": 4 },
      ),
    ).toEqual({
      changedPaths: ["assets/a.hasset"],
      addedPaths: ["assets/c.hasset"],
      removedPaths: ["assets/b.hasset"],
    });
  });
});

describe("classifyExternalChanges", () => {
  it("returns none when mtimes are unchanged", () => {
    const result = classifyExternalChanges({
      previousAssets: { "assets/a.hasset": 1 },
      nextAssets: { "assets/a.hasset": 1 },
      previousProjectJsonMtime: 10,
      nextProjectJsonMtime: 10,
      openDocs: [{ path: "assets/a.hasset", dirty: true }],
    });
    expect(result.kind).toBe("none");
  });

  it("asks to reload a clean open document whose file changed", () => {
    const result = classifyExternalChanges({
      previousAssets: { "assets/a.hasset": 1 },
      nextAssets: { "assets/a.hasset": 2 },
      previousProjectJsonMtime: 10,
      nextProjectJsonMtime: 10,
      openDocs: [{ path: "assets/a.hasset", dirty: false }],
    });
    expect(result.kind).toBe("reload-clean");
    expect(result.cleanChangedPaths).toEqual(["assets/a.hasset"]);
  });

  it("warns when a dirty open document changed on disk", () => {
    const result = classifyExternalChanges({
      previousAssets: { "assets/a.hasset": 1 },
      nextAssets: { "assets/a.hasset": 2 },
      previousProjectJsonMtime: 10,
      nextProjectJsonMtime: 10,
      openDocs: [{ path: "assets/a.hasset", dirty: true }],
    });
    expect(result.kind).toBe("dirty-disk");
    expect(result.dirtyChangedPaths).toEqual(["assets/a.hasset"]);
  });

  it("reports open documents whose files were deleted on disk", () => {
    const deleted = (dirty: boolean) => classifyExternalChanges({
      previousAssets: { "assets/a.hasset": 1, "assets/b.hasset": 1 },
      nextAssets: { "assets/b.hasset": 1 },
      previousProjectJsonMtime: 10,
      nextProjectJsonMtime: 10,
      openDocs: [{ path: "assets/a.hasset", dirty }],
    });
    expect(deleted(true)).toMatchObject({ kind: "dirty-disk", dirtyChangedPaths: ["assets/a.hasset"] });
    expect(deleted(false)).toMatchObject({ kind: "reload-clean", cleanChangedPaths: ["assets/a.hasset"] });
  });

  it("prefers Reload Project when project.json or many assets change", () => {
    expect(
      classifyExternalChanges({
        previousAssets: { "assets/a.hasset": 1 },
        nextAssets: { "assets/a.hasset": 1 },
        previousProjectJsonMtime: 10,
        nextProjectJsonMtime: 11,
        openDocs: [],
      }).kind,
    ).toBe("reload-project");

    const many: Record<string, number | null> = {};
    const next: Record<string, number | null> = {};
    for (let i = 0; i < MANY_EXTERNAL_CHANGES; i += 1) {
      many[`assets/${i}.hasset`] = 1;
      next[`assets/${i}.hasset`] = 2;
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
