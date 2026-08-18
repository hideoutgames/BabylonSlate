import type { ProjectFolderHandle, StorageTier } from "@babylonslate/core";
import { displayProjectName } from "./display-project-name";

export type ListedProject = ProjectFolderHandle & {
  /** Display name from recents / metadata; folder `name` stays the I/O identity. */
  label: string;
  lastOpenedAt?: string;
  createdAt?: string;
};

function storageTierLabel(tier: StorageTier): string {
  return tier === "external" ? "Chosen folder" : "On this device";
}

/** Human location for a recents row, or null when every row would read the same. */
export function listedProjectLocationLabel(
  projects: Array<{ tier: StorageTier }>,
  project: { tier: StorageTier },
): string | null {
  const labels = new Set(projects.map((entry) => storageTierLabel(entry.tier)));
  if (labels.size <= 1) return null;
  return storageTierLabel(project.tier);
}

export function formatListedProjectDate(iso: string | undefined): string | null {
  if (!iso) return null;
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return null;
  return date.toLocaleDateString();
}

/** Created / last opened / location for a recents row; empty when there is nothing to show. */
export function listedProjectMetaParts(
  projects: ListedProject[],
  project: ListedProject,
): string[] {
  const parts: string[] = [];
  const created = formatListedProjectDate(project.createdAt);
  if (created) parts.push(`Created ${created}`);
  const opened = formatListedProjectDate(project.lastOpenedAt);
  if (opened) parts.push(`Last opened ${opened}`);
  const location = listedProjectLocationLabel(projects, project);
  if (location) parts.push(location);
  return parts;
}

export function listedProjectsFromRecents(
  recents: Array<{
    id: string;
    name: string;
    tier: ProjectFolderHandle["tier"];
    lastOpenedAt?: string;
    createdAt?: string;
  }>,
  stored: ProjectFolderHandle[],
): ListedProject[] {
  const byId = new Map(stored.map((project) => [project.id, project]));
  return recents.map((recent) => {
    const handle = byId.get(recent.id) ?? {
      id: recent.id,
      name: recent.name,
      tier: recent.tier,
    };
    return {
      ...handle,
      label: recent.name,
      ...(recent.lastOpenedAt ? { lastOpenedAt: recent.lastOpenedAt } : {}),
      ...(recent.createdAt ? { createdAt: recent.createdAt } : {}),
    };
  });
}

export type HomepageProjectLocationFilter = "on-this-device" | "chosen-folder";

export type HomepageProjectSortMode =
  | "name-asc"
  | "name-desc"
  | "last-opened-desc"
  | "last-opened-asc"
  | "created-desc"
  | "created-asc";

export const HOMEPAGE_PROJECT_SORT_OPTIONS: ReadonlyArray<{
  mode: HomepageProjectSortMode;
  label: string;
}> = [
  { mode: "name-asc", label: "Name A–Z" },
  { mode: "name-desc", label: "Name Z–A" },
  { mode: "last-opened-desc", label: "Last Opened (Newest)" },
  { mode: "last-opened-asc", label: "Last Opened (Oldest)" },
  { mode: "created-desc", label: "Created (Newest)" },
  { mode: "created-asc", label: "Created (Oldest)" },
];

function locationFilterForTier(
  tier: StorageTier,
): HomepageProjectLocationFilter {
  return tier === "external" ? "chosen-folder" : "on-this-device";
}

function matchesListedProjectSearch(
  project: ListedProject,
  search: string,
): boolean {
  const query = search.trim().toLowerCase();
  if (!query) return true;
  const haystacks = [
    project.label,
    project.name,
    displayProjectName(project.label),
    displayProjectName(project.name),
  ];
  return haystacks.some((value) => value.toLowerCase().includes(query));
}

export function filterListedProjects(
  projects: ListedProject[],
  options: {
    search: string;
    locationFilters: HomepageProjectLocationFilter[];
  },
): ListedProject[] {
  const filters = options.locationFilters;
  return projects.filter((project) => {
    if (
      filters.length > 0 &&
      !filters.includes(locationFilterForTier(project.tier))
    ) {
      return false;
    }
    return matchesListedProjectSearch(project, options.search);
  });
}

const NAME_COMPARE: Intl.CollatorOptions = { sensitivity: "base" };

function compareProjectNames(left: ListedProject, right: ListedProject): number {
  const byLabel = displayProjectName(left.label).localeCompare(
    displayProjectName(right.label),
    undefined,
    NAME_COMPARE,
  );
  if (byLabel !== 0) return byLabel;
  const byName = displayProjectName(left.name).localeCompare(
    displayProjectName(right.name),
    undefined,
    NAME_COMPARE,
  );
  if (byName !== 0) return byName;
  return left.id.localeCompare(right.id);
}

function dateMs(iso: string | undefined): number {
  if (!iso) return 0;
  const value = Date.parse(iso);
  return Number.isNaN(value) ? 0 : value;
}

export function sortListedProjects(
  projects: readonly ListedProject[],
  mode: HomepageProjectSortMode,
): ListedProject[] {
  return [...projects].sort((left, right) => {
    let primary = 0;
    switch (mode) {
      case "name-asc":
      case "name-desc":
        primary = compareProjectNames(left, right);
        if (mode === "name-desc") primary = -primary;
        break;
      case "last-opened-asc":
      case "last-opened-desc":
        primary = dateMs(left.lastOpenedAt) - dateMs(right.lastOpenedAt);
        if (mode === "last-opened-desc") primary = -primary;
        break;
      case "created-asc":
      case "created-desc":
        primary = dateMs(left.createdAt) - dateMs(right.createdAt);
        if (mode === "created-desc") primary = -primary;
        break;
    }
    if (primary !== 0) return primary;
    const byName = compareProjectNames(left, right);
    if (byName !== 0) return byName;
    return left.id.localeCompare(right.id);
  });
}
