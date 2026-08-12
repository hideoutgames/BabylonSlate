import { describe, expect, it } from "vitest";
import { listedProjectsFromRecents } from "./listed-projects";

describe("listedProjectsFromRecents", () => {
  it("uses recents order and labels while keeping stored folder names", () => {
    const listed = listedProjectsFromRecents(
      [
        { id: "opfs:Game.babproject", name: "Pretty Game", tier: "opfs" },
        { id: "ext-1", name: "External", tier: "external" },
      ],
      [
        {
          id: "opfs:Game.babproject",
          name: "Game.babproject",
          tier: "opfs",
        },
      ],
    );
    expect(listed).toEqual([
      {
        id: "opfs:Game.babproject",
        name: "Game.babproject",
        tier: "opfs",
        label: "Pretty Game",
      },
      {
        id: "ext-1",
        name: "External",
        tier: "external",
        label: "External",
      },
    ]);
  });

  it("omits stored projects that are not in recents", () => {
    expect(
      listedProjectsFromRecents(
        [],
        [{ id: "opfs:Old.babproject", name: "Old.babproject", tier: "opfs" }],
      ),
    ).toEqual([]);
  });
});
