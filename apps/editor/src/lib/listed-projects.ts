import type { ProjectFolderHandle, StorageTier } from "@babylonslate/core";

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
