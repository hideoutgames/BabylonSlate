import { describe, expect, it } from "vitest";
import {
  filterListedProjects,
  listedProjectsFromRecents,
  recentProjectsWithOpenedProject,
  shouldDeleteOpfsOnRemove,
  sortListedProjects,
  type ListedProject,
} from "./listed-projects";

describe("shouldDeleteOpfsOnRemove", () => {
  it("deletes only web OPFS projects", () => {
    expect(shouldDeleteOpfsOnRemove("web", "opfs")).toBe(true);
    expect(shouldDeleteOpfsOnRemove("web", "documents")).toBe(false);
    expect(shouldDeleteOpfsOnRemove("ios", "opfs")).toBe(false);
    expect(shouldDeleteOpfsOnRemove("electron", "documents")).toBe(false);
  });
});

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

  it("keeps createdAt and lastOpenedAt from recents", () => {
    const listed = listedProjectsFromRecents(
      [
        {
          id: "opfs:Game.babproject",
          name: "Pretty Game",
          tier: "opfs",
          lastOpenedAt: "2026-08-18T12:00:00.000Z",
          createdAt: "2026-03-15T12:00:00.000Z",
          appearance: { icon: "rocket", color: "lilac" },
        },
      ],
      [
        {
          id: "opfs:Game.babproject",
          name: "Game.babproject",
          tier: "opfs",
        },
      ],
    );
    expect(listed[0]).toMatchObject({
      id: "opfs:Game.babproject",
      name: "Game.babproject",
      label: "Pretty Game",
      lastOpenedAt: "2026-08-18T12:00:00.000Z",
      createdAt: "2026-03-15T12:00:00.000Z",
      appearance: { icon: "rocket", color: "lilac" },
    });
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

describe("recentProjectsWithOpenedProject", () => {
  it("preserves the edited project identity after reopening the original folder", () => {
    const result = recentProjectsWithOpenedProject(
      [{ id: "opfs:Original", name: "Old Label", tier: "opfs", lastOpenedAt: "2026-09-08" }],
      { id: "opfs:Original", name: "Original", tier: "opfs" },
      {
        name: "Edited Name", version: "0.0.0", createdAt: "2026-09-01", updatedAt: "2026-09-09",
        appearance: { icon: "mountain", color: "mint" },
      },
      "2026-09-09T12:00:00.000Z",
      true,
    );
    expect(result).toEqual([{
      id: "opfs:Original", name: "Edited Name", tier: "opfs", bookmark: null,
      createdAt: "2026-09-01", lastOpenedAt: "2026-09-09T12:00:00.000Z",
      appearance: { icon: "mountain", color: "mint" }, sourceControl: true,
    }]);
    expect(listedProjectsFromRecents(result, [
      { id: "opfs:Original", name: "Original", tier: "opfs" },
    ])[0]).toMatchObject({
      name: "Original", label: "Edited Name", appearance: { icon: "mountain", color: "mint" },
      sourceControl: true,
    });
  });
});

function project(
  name: string,
  tier: ListedProject["tier"],
  extras: Partial<ListedProject> = {},
): ListedProject {
  return { id: `${tier}:${name}`, name, tier, label: extras.label ?? name, ...extras };
}

describe("filterListedProjects", () => {
  const mixed = [
    project("Alpha.babproject", "opfs", { label: "Pretty Alpha" }),
    project("Beta.babproject", "external"),
  ];

  it("matches display label and folder name without requiring a query", () => {
    expect(filterListedProjects(mixed, { search: "", locationFilters: [] })).toEqual(
      mixed,
    );
    expect(
      filterListedProjects(mixed, { search: "pretty", locationFilters: [] }).map(
        (entry) => entry.id,
      ),
    ).toEqual(["opfs:Alpha.babproject"]);
    expect(
      filterListedProjects(mixed, { search: "Beta.bab", locationFilters: [] }).map(
        (entry) => entry.id,
      ),
    ).toEqual(["external:Beta.babproject"]);
  });

  it("keeps every location when filters are empty and hides Chosen folder when asked", () => {
    expect(
      filterListedProjects(mixed, {
        search: "",
        locationFilters: ["on-this-device"],
      }).map((entry) => entry.id),
    ).toEqual(["opfs:Alpha.babproject"]);
    expect(
      filterListedProjects(mixed, {
        search: "",
        locationFilters: ["chosen-folder"],
      }).map((entry) => entry.id),
    ).toEqual(["external:Beta.babproject"]);
  });
});

describe("sortListedProjects", () => {
  it("sorts by display name and treats missing dates as oldest", () => {
    const zebra = project("zebra.babproject", "opfs", { label: "Zebra" });
    const alpha = project("alpha.babproject", "opfs", {
      label: "Alpha",
      lastOpenedAt: "2026-08-18T12:00:00.000Z",
      createdAt: "2026-01-01T00:00:00.000Z",
    });
    const mid = project("mid.babproject", "opfs", {
      label: "Mid",
      lastOpenedAt: "2026-06-01T00:00:00.000Z",
      createdAt: "2026-03-01T00:00:00.000Z",
    });
    const ids = (mode: Parameters<typeof sortListedProjects>[1]) =>
      sortListedProjects([zebra, alpha, mid], mode).map((entry) => entry.label);

    expect(ids("name-asc")).toEqual(["Alpha", "Mid", "Zebra"]);
    expect(ids("name-desc")).toEqual(["Zebra", "Mid", "Alpha"]);
    expect(ids("last-opened-desc")).toEqual(["Alpha", "Mid", "Zebra"]);
    expect(ids("last-opened-asc")).toEqual(["Zebra", "Mid", "Alpha"]);
    expect(ids("created-desc")).toEqual(["Mid", "Alpha", "Zebra"]);
    expect(ids("created-asc")).toEqual(["Zebra", "Alpha", "Mid"]);
  });
});
