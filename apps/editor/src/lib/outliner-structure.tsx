import type { SerializedActor, SerializedOutlinerFolder, SerializedScene } from "@haptic/core";
import { engineParentOf, type TreeViewNode } from "@haptic/editor-kit";
import { FolderIcon } from "lucide-react";
import { OutlinerActorIcon } from "./outliner-actor-icon";
import { actorRowId, folderRowId } from "./outliner-drop";
import { sceneActorDisplayNames } from "./scene-actor-names";

const defaultParentOf = (id: string): string | null => engineParentOf(id) ?? null;

/**
 * The parent a row is listed under. A parent that is not in the scene, or a
 * chain that loops back to the row, lists it at the root so it stays visible.
 */
function listedParent(
  id: string,
  parentById: ReadonlyMap<string, string | null>,
): string | null {
  const parent = parentById.get(id) ?? null;
  if (parent === null || !parentById.has(parent)) return null;
  const seen = new Set<string>();
  let cursor: string | null = parent;
  while (cursor !== null && parentById.has(cursor) && !seen.has(cursor)) {
    if (cursor === id) return null;
    seen.add(cursor);
    cursor = parentById.get(cursor) ?? null;
  }
  return parent;
}

/**
 * Depth-first walk so children follow their parent in the flattened list.
 * Folders come first at each level, then the actors they hold. Transform
 * children stay under their parent actor regardless of folder, because
 * `parentId` is attachment and `folderId` is only organization.
 */
export function flattenOutliner(
  scene: SerializedScene,
  options: {
    collapsed: ReadonlySet<string>;
    search: string;
    parentOf?: (id: string) => string | null;
  },
): TreeViewNode[] {
  const parentOf = options.parentOf ?? defaultParentOf;
  const actorIcon = (actor: SerializedActor) => (
    <OutlinerActorIcon
      actorId={actor.id}
      classId={actor.classId}
      components={actor.components}
      parentOf={parentOf}
    />
  );
  const folderIcon = (folder: SerializedOutlinerFolder) => (
    <FolderIcon data-testid={`outliner-folder-icon-${folder.id}`} />
  );

  const names = sceneActorDisplayNames(scene);
  const needle = options.search.trim().toLowerCase();
  const actorParentById = new Map(
    scene.actors.map((actor) => [actor.id, actor.parentId]),
  );
  const folderParentById = new Map(
    scene.folders.map((folder) => [folder.id, folder.parentFolderId]),
  );
  const childrenOf = new Map<string | null, SerializedActor[]>();
  for (const actor of scene.actors) {
    const parentId = listedParent(actor.id, actorParentById);
    const bucket = childrenOf.get(parentId) ?? [];
    bucket.push(actor);
    childrenOf.set(parentId, bucket);
  }
  const foldersByParent = new Map<string | null, SerializedOutlinerFolder[]>();
  for (const folder of scene.folders) {
    const parentFolderId = listedParent(folder.id, folderParentById);
    const bucket = foldersByParent.get(parentFolderId) ?? [];
    bucket.push(folder);
    foldersByParent.set(parentFolderId, bucket);
  }
  const folderById = new Map(
    scene.folders.map((folder) => [folder.id, folder]),
  );

  const folderPath = (folderId: string | null): string => {
    const parts: string[] = [];
    const seen = new Set<string>();
    let cursor = folderId;
    while (cursor !== null && !seen.has(cursor)) {
      seen.add(cursor);
      const folder = folderById.get(cursor);
      if (!folder) break;
      parts.unshift(folder.name);
      cursor = folder.parentFolderId;
    }
    return parts.join(" / ");
  };

  if (needle) {
    // Search flattens the hierarchy: matches are what the user is looking for.
    const rows: TreeViewNode[] = [];
    for (const folder of scene.folders) {
      if (!folder.name.toLowerCase().includes(needle)) continue;
      rows.push({
        id: folderRowId(folder.id),
        label: folderPath(folder.id),
        renamable: true,
        renameValue: folder.name,
        depth: 0,
        hasChildren: false,
        expanded: false,
        icon: folderIcon(folder),
      });
    }
    for (const actor of scene.actors) {
      if (!actor.name.toLowerCase().includes(needle)) continue;
      const path = folderPath(actor.folderId);
      rows.push({
        id: actorRowId(actor.id),
        label: path ? `${path} / ${names.get(actor.id)!}` : names.get(actor.id)!,
        renamable: true,
        renameValue: actor.name,
        depth: 0,
        hasChildren: false,
        expanded: false,
        muted: !actor.visible,
        icon: actorIcon(actor),
      });
    }
    return rows;
  }

  const rows: TreeViewNode[] = [];

  const walkActors = (parentId: string | null, depth: number) => {
    for (const actor of childrenOf.get(parentId) ?? []) {
      const children = childrenOf.get(actor.id) ?? [];
      const rowId = actorRowId(actor.id);
      const expanded = !options.collapsed.has(rowId);
      rows.push({
        id: rowId,
        label: names.get(actor.id)!,
        renamable: true,
        renameValue: actor.name,
        depth,
        hasChildren: children.length > 0,
        expanded,
        muted: !actor.visible,
        icon: actorIcon(actor),
      });
      if (expanded) walkActors(actor.id, depth + 1);
    }
  };

  const rootActorsByFolder = new Map<
    string | null | undefined,
    SerializedActor[]
  >();
  for (const actor of childrenOf.get(null) ?? []) {
    const folderId =
      actor.folderId !== null && folderById.has(actor.folderId)
        ? actor.folderId
        : null;
    const bucket = rootActorsByFolder.get(folderId) ?? [];
    bucket.push(actor);
    rootActorsByFolder.set(folderId, bucket);
  }
  const actorsAtFolderRoot = (folderId: string | null) =>
    rootActorsByFolder.get(folderId) ?? [];

  const walkFolders = (parentFolderId: string | null, depth: number) => {
    for (const folder of foldersByParent.get(parentFolderId) ?? []) {
      const rowId = folderRowId(folder.id);
      const expanded = !options.collapsed.has(rowId);
      const hasChildren =
        (foldersByParent.get(folder.id)?.length ?? 0) > 0 ||
        actorsAtFolderRoot(folder.id).length > 0;
      rows.push({
        id: rowId,
        label: folder.name,
        renamable: true,
        depth,
        hasChildren,
        expanded,
        icon: folderIcon(folder),
      });
      if (!expanded) continue;
      walkFolders(folder.id, depth + 1);
      for (const actor of actorsAtFolderRoot(folder.id)) {
        const children = childrenOf.get(actor.id) ?? [];
        const actorRow = actorRowId(actor.id);
        const actorExpanded = !options.collapsed.has(actorRow);
        rows.push({
          id: actorRow,
          label: names.get(actor.id)!,
        renamable: true,
        renameValue: actor.name,
          depth: depth + 1,
          hasChildren: children.length > 0,
          expanded: actorExpanded,
          muted: !actor.visible,
          icon: actorIcon(actor),
        });
        if (actorExpanded) walkActors(actor.id, depth + 2);
      }
    }
  };

  walkFolders(null, 0);
  for (const actor of actorsAtFolderRoot(null)) {
    const children = childrenOf.get(actor.id) ?? [];
    const rowId = actorRowId(actor.id);
    const expanded = !options.collapsed.has(rowId);
    rows.push({
      id: rowId,
      label: names.get(actor.id)!,
      renamable: true,
      renameValue: actor.name,
      depth: 0,
      hasChildren: children.length > 0,
      expanded,
      muted: !actor.visible,
      icon: actorIcon(actor),
    });
    if (expanded) walkActors(actor.id, 1);
  }
  return rows;
}

/**
 * Whether two Scenes list the same Outliner rows: every field
 * `flattenOutliner` and the lock toggles read (actor names, hierarchy,
 * folders, visibility, locks, classes and component classes) is unchanged.
 * Property and transform edits keep all of them.
 */
export function sameOutlinerStructure(a: SerializedScene, b: SerializedScene): boolean {
  if (a.actors.length !== b.actors.length || a.folders.length !== b.folders.length) return false;
  const sameActors = a.actors.every((actor, index) => {
    const other = b.actors[index]!;
    return actor === other || (
      actor.id === other.id &&
      actor.name === other.name &&
      actor.parentId === other.parentId &&
      actor.folderId === other.folderId &&
      actor.visible === other.visible &&
      actor.locked === other.locked &&
      actor.classId === other.classId &&
      (actor.components === other.components || (
        actor.components.length === other.components.length &&
        actor.components.every((component, at) => component.classId === other.components[at]!.classId)
      ))
    );
  });
  return sameActors && (a.folders === b.folders || a.folders.every((folder, index) => {
    const other = b.folders[index]!;
    return folder === other || (
      folder.id === other.id && folder.name === other.name && folder.parentFolderId === other.parentFolderId
    );
  }));
}
