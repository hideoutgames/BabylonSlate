import type { ProjectFolderHandle } from "@babylonslate/core";

export type ListedProject = ProjectFolderHandle & {
  /** Display name from recents / metadata; folder `name` stays the I/O identity. */
  label: string;
};

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
