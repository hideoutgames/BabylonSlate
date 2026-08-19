import { describe, expect, it } from "vitest";
import {
  filterListedProjects,
  HOMEPAGE_PROJECT_SORT_OPTIONS,
  listedProjectLocationLabel,
  listedProjectMetaParts,
  listedProjectsFromRecents,
  sortListedProjects,
  type ListedProject,
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

  it("keeps createdAt and lastOpenedAt from recents", () => {
    const listed = listedProjectsFromRecents(
      [
        {
          id: "opfs:Game.babproject",
          name: "Pretty Game",
          tier: "opfs",
          lastOpenedAt: "2026-08-18T12:00:00.000Z",
          createdAt: "2026-03-15T12:00:00.000Z",
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

describe("listedProjectMetaParts", () => {
  it("joins created, last opened, and mixed location", () => {
    const projects = [
      {
        id: "opfs:Game.babproject",
        name: "Game.babproject",
        tier: "opfs" as const,
        label: "Game",
        createdAt: "2026-03-15T12:00:00.000Z",
        lastOpenedAt: "2026-08-18T12:00:00.000Z",
      },
      {
        id: "ext-1",
        name: "Studio.babproject",
        tier: "external" as const,
        label: "Studio",
      },
    ];
    expect(listedProjectMetaParts(projects, projects[0]!)).toEqual([
      `Created ${new Date("2026-03-15T12:00:00.000Z").toLocaleDateString()}`,
      `Last opened ${new Date("2026-08-18T12:00:00.000Z").toLocaleDateString()}`,
      "On this device",
    ]);
  });

  it("omits Created when createdAt is missing", () => {
    const project = {
      id: "opfs:Game.babproject",
      name: "Game.babproject",
      tier: "opfs" as const,
      label: "Game",
      lastOpenedAt: "2026-08-18T12:00:00.000Z",
    };
    expect(listedProjectMetaParts([project], project)).toEqual([
      `Last opened ${new Date("2026-08-18T12:00:00.000Z").toLocaleDateString()}`,
    ]);
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
  it("lists Name A–Z through Created (Oldest) as Content Browser-style options", () => {
    expect(HOMEPAGE_PROJECT_SORT_OPTIONS.map((option) => option.mode)).toEqual([
      "name-asc",
      "name-desc",
      "last-opened-desc",
      "last-opened-asc",
      "created-desc",
      "created-asc",
    ]);
    expect(HOMEPAGE_PROJECT_SORT_OPTIONS.map((option) => option.label)).toEqual([
      "Name A–Z",
      "Name Z–A",
      "Last Opened (Newest)",
      "Last Opened (Oldest)",
      "Created (Newest)",
      "Created (Oldest)",
    ]);
  });

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
