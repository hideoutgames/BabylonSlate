import { describe, expect, it } from "vitest";
import {
  listedProjectLocationLabel,
  listedProjectsFromRecents,
} from "./listed-projects";

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

describe("listedProjectLocationLabel", () => {
  it("hides the location when every row would read the same", () => {
    const opfs = [
      { tier: "opfs" as const },
      { tier: "opfs" as const },
    ];
    expect(listedProjectLocationLabel(opfs, opfs[0]!)).toBeNull();
    expect(
      listedProjectLocationLabel(
        [{ tier: "documents" }, { tier: "opfs" }],
        { tier: "opfs" },
      ),
    ).toBeNull();
  });

  it("labels a picked folder apart from on-device storage", () => {
    const projects = [{ tier: "opfs" as const }, { tier: "external" as const }];
    expect(listedProjectLocationLabel(projects, projects[0]!)).toBe(
      "On this device",
    );
    expect(listedProjectLocationLabel(projects, projects[1]!)).toBe(
      "Chosen folder",
    );
    expect(listedProjectLocationLabel(projects, projects[0]!)).not.toMatch(
      /opfs|idb|documents|external/i,
    );
  });
});
