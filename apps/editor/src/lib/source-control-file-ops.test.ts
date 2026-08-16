import { describe, expect, it } from "vitest";
import { oursLockPaths, refuseTheirsPaths } from "./source-control-file-ops";

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

describe("oursLockPaths", () => {
  it("returns only paths we currently hold", () => {
    expect(
      oursLockPaths(
        ["assets/mine.babasset", "assets/theirs.babasset", "assets/free.babasset"],
        (path) =>
          path === "assets/mine.babasset"
            ? "mine"
            : path === "assets/theirs.babasset"
              ? "theirs"
              : null,
      ),
    ).toEqual(["assets/mine.babasset"]);
  });
});
