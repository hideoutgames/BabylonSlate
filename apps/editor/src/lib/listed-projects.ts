import type { ProjectFolderHandle, StorageTier } from "@babylonslate/core";

export type ListedProject = ProjectFolderHandle & {
  /** Display name from recents / metadata; folder `name` stays the I/O identity. */
  label: string;
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

export function listedProjectsFromRecents(
  recents: Array<{
    id: string;
    name: string;
    tier: ProjectFolderHandle["tier"];
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
    return { ...handle, label: recent.name };
  });
}
