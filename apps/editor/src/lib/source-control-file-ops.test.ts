import { describe, expect, it } from "vitest";
import {
  applyLockTransfers,
  containedAssetPaths,
  folderMoveLockTransfers,
  oursLockPaths,
  refuseTheirsPaths,
} from "./source-control-file-ops";

describe("refuseTheirsPaths", () => {
  it("returns the holder message for the first path locked by someone else", () => {
    const refuse = (path: string) =>
      path === "assets/theirs.hasset" ? "Locked by Bob" : null;
    expect(
      refuseTheirsPaths(
        ["assets/mine.hasset", "assets/theirs.hasset"],
        refuse,
      ),
    ).toBe("Locked by Bob");
  });

  it("allows a move when none of the paths are theirs", () => {
    expect(
      refuseTheirsPaths(["assets/mine.hasset"], () => null),
    ).toBeNull();
  });
});

describe("oursLockPaths", () => {
  it("returns only paths we currently hold", () => {
    expect(
      oursLockPaths(
        ["assets/mine.hasset", "assets/theirs.hasset", "assets/free.hasset"],
        (path) =>
          path === "assets/mine.hasset"
            ? "mine"
            : path === "assets/theirs.hasset"
              ? "theirs"
              : null,
      ),
    ).toEqual(["assets/mine.hasset"]);
  });
});

describe("containedAssetPaths", () => {
  const assets = [
    { path: "assets/hero.scene.hasset" },
    { path: "assets/chars/ada.hasset" },
    { path: "assets/chars/bob.hasset" },
    { path: "assets/chars/extra/c.hasset" },
    { path: "assets/chars_backup/x.hasset" },
  ];

  it("lists nested assets under a folder prefix, not sibling names", () => {
    expect(containedAssetPaths(assets, "assets/chars")).toEqual([
      "assets/chars/ada.hasset",
      "assets/chars/bob.hasset",
      "assets/chars/extra/c.hasset",
    ]);
  });
});

describe("folderMoveLockTransfers", () => {
  it("pairs each contained path with the remapped destination", () => {
    expect(
      folderMoveLockTransfers(
        [
          { path: "assets/chars/ada.hasset" },
          { path: "assets/chars/extra/c.hasset" },
        ],
        "assets/chars",
        "assets/people",
      ),
    ).toEqual([
      {
        from: "assets/chars/ada.hasset",
        to: "assets/people/ada.hasset",
      },
      {
        from: "assets/chars/extra/c.hasset",
        to: "assets/people/extra/c.hasset",
      },
    ]);
  });
});

describe("applyLockTransfers", () => {
  it("transfers only ours locks and skips unchanged paths", async () => {
    const transferred: string[] = [];
    await applyLockTransfers(
      [
        { from: "assets/a.hasset", to: "assets/b.hasset" },
        { from: "assets/same.hasset", to: "assets/same.hasset" },
        { from: "assets/theirs.hasset", to: "assets/moved.hasset" },
      ],
      (path) => (path === "assets/a.hasset" ? "mine" : null),
      async (from, to) => {
        transferred.push(`${from}->${to}`);
      },
    );
    expect(transferred).toEqual(["assets/a.hasset->assets/b.hasset"]);
  });
});
