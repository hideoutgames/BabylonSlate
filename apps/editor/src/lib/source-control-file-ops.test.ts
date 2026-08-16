import { describe, expect, it } from "vitest";
import {
  applyLockTransfers,
  containedAssetPaths,
  folderMoveLockTransfers,
  refuseTheirsPaths,
} from "./source-control-file-ops";

describe("refuseTheirsPaths", () => {
  it("returns the holder message for the first path locked by someone else", () => {
    const refuse = (path: string) =>
      path === "assets/theirs.babasset" ? "Locked by Bob" : null;
    expect(
      refuseTheirsPaths(
        ["assets/mine.babasset", "assets/theirs.babasset"],
        refuse,
      ),
    ).toBe("Locked by Bob");
  });

  it("allows a move when none of the paths are theirs", () => {
    expect(
      refuseTheirsPaths(["assets/mine.babasset"], () => null),
    ).toBeNull();
  });
});

describe("containedAssetPaths", () => {
  const assets = [
    { path: "assets/hero.scene.babasset" },
    { path: "assets/chars/ada.babasset" },
    { path: "assets/chars/bob.babasset" },
    { path: "assets/chars/extra/c.babasset" },
    { path: "assets/chars_backup/x.babasset" },
  ];

  it("lists nested assets under a folder prefix, not sibling names", () => {
    expect(containedAssetPaths(assets, "assets/chars")).toEqual([
      "assets/chars/ada.babasset",
      "assets/chars/bob.babasset",
      "assets/chars/extra/c.babasset",
    ]);
  });
});

describe("folderMoveLockTransfers", () => {
  it("pairs each contained path with the remapped destination", () => {
    expect(
      folderMoveLockTransfers(
        [
          { path: "assets/chars/ada.babasset" },
          { path: "assets/chars/extra/c.babasset" },
        ],
        "assets/chars",
        "assets/people",
      ),
    ).toEqual([
      {
        from: "assets/chars/ada.babasset",
        to: "assets/people/ada.babasset",
      },
      {
        from: "assets/chars/extra/c.babasset",
        to: "assets/people/extra/c.babasset",
      },
    ]);
  });
});

describe("applyLockTransfers", () => {
  it("transfers only ours locks and skips unchanged paths", async () => {
    const transferred: string[] = [];
    await applyLockTransfers(
      [
        { from: "assets/a.babasset", to: "assets/b.babasset" },
        { from: "assets/same.babasset", to: "assets/same.babasset" },
        { from: "assets/theirs.babasset", to: "assets/moved.babasset" },
      ],
      (path) => (path === "assets/a.babasset" ? "mine" : null),
      async (from, to) => {
        transferred.push(`${from}->${to}`);
      },
    );
    expect(transferred).toEqual(["assets/a.babasset->assets/b.babasset"]);
  });
});
