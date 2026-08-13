import { describe, expect, it } from "vitest";
import { dirtyScenesBlockingOpen } from "./exclusive-scene";

describe("dirtyScenesBlockingOpen", () => {
  it("returns the other dirty scene when opening a different scene", () => {
    expect(
      dirtyScenesBlockingOpen(
        [
          {
            id: "scene:a",
            dirty: true,
            ref: { kind: "scene" },
          },
          {
            id: "graph:b",
            dirty: true,
            ref: { kind: "graph" },
          },
        ],
        "scene:c",
      ).map((doc) => doc.id),
    ).toEqual(["scene:a"]);
  });

  it("does not block reopening the same dirty scene", () => {
    expect(
      dirtyScenesBlockingOpen(
        [{ id: "scene:a", dirty: true, ref: { kind: "scene" } }],
        "scene:a",
      ),
    ).toEqual([]);
  });
});
