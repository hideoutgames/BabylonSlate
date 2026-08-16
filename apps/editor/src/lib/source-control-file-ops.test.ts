import { describe, expect, it } from "vitest";
import { refuseTheirsPaths } from "./source-control-file-ops";

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
