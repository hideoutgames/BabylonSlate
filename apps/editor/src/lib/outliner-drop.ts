import { rangeSelectTreeIds, type TreeSelectOptions } from "@babylonslate/editor-kit";
import {
  actorSubtree,
  findActor,
  findFolder,
  folderSubtree,
  wouldCreateCycle,
  wouldCreateFolderCycle,
  type SerializedScene,
} from "@babylonslate/core";

const FOLDER_ROW_PREFIX = "folder:";
const ACTOR_ROW_PREFIX = "actor:";

export function folderRowId(folderId: string): string {
  return `${FOLDER_ROW_PREFIX}${folderId}`;
}

export function actorRowId(actorId: string): string {
  return `${ACTOR_ROW_PREFIX}${actorId}`;
}

export type OutlinerRowTarget =
  | { kind: "folder"; id: string }
  | { kind: "actor"; id: string };

/** Rows are namespaced so a folder can never be mistaken for an actor. */
export function outlinerRowTarget(
  rowId: string | null,
): OutlinerRowTarget | null {
  if (!rowId) return null;
  if (rowId.startsWith(FOLDER_ROW_PREFIX)) {
    return { kind: "folder", id: rowId.slice(FOLDER_ROW_PREFIX.length) };
  }
  if (rowId.startsWith(ACTOR_ROW_PREFIX)) {
    return { kind: "actor", id: rowId.slice(ACTOR_ROW_PREFIX.length) };
  }
  return null;
}

export function splitOutlinerRowIds(rowIds: readonly string[]): {
  folderIds: string[];
  actorIds: string[];
} {
  const folderIds: string[] = [];
  const actorIds: string[] = [];
  for (const rowId of rowIds) {
    const target = outlinerRowTarget(rowId);
    if (target?.kind === "folder") folderIds.push(target.id);
    else if (target?.kind === "actor") actorIds.push(target.id);
  }
  return { folderIds, actorIds };
}

export function applyOutlinerRowSelect(
  rowId: string,
  options: TreeSelectOptions | undefined,
  visibleRowIds: readonly string[],
  selectedRowIds: readonly string[],
): { folderIds: string[]; actorIds: string[] } {
  const target = outlinerRowTarget(rowId);
  if (!target) return { folderIds: [], actorIds: [] };
  if (options?.range) {
    const from = selectedRowIds[selectedRowIds.length - 1];
    return splitOutlinerRowIds(rangeSelectTreeIds(visibleRowIds, from, rowId));
  }
  if (options?.additive) {
    const next = selectedRowIds.includes(rowId)
      ? selectedRowIds.filter((id) => id !== rowId)
      : [...selectedRowIds, rowId];
    return splitOutlinerRowIds(next);
  }
  if (target.kind === "folder") {
    return { folderIds: [target.id], actorIds: [] };
  }
  return { folderIds: [], actorIds: [target.id] };
}

export type OutlinerDropMove =
  | { kind: "folder"; id: string; parentFolderId: string | null }
  | { kind: "actor"; id: string; parentId: string | null; folderId: string | null };

function ancestorFolderSelected(
  scene: SerializedScene,
  folderId: string,
  selected: ReadonlySet<string>,
): boolean {
  let parent = findFolder(scene, folderId)?.parentFolderId ?? null;
  while (parent) {
    if (selected.has(parent)) return true;
    parent = findFolder(scene, parent)?.parentFolderId ?? null;
  }
  return false;
}

function ancestorActorSelected(
  scene: SerializedScene,
  actorId: string,
  selected: ReadonlySet<string>,
): boolean {
  let parent = findActor(scene, actorId)?.parentId ?? null;
  while (parent) {
    if (selected.has(parent)) return true;
    parent = findActor(scene, parent)?.parentId ?? null;
  }
  return false;
}

function coveredFolderIds(
  scene: SerializedScene,
  folderRoots: readonly string[],
): Set<string> {
  const ids = new Set<string>();
  for (const folderId of folderRoots) {
    for (const folder of folderSubtree(scene, folderId)) ids.add(folder.id);
  }
  return ids;
}

function actorFolderCovered(
  scene: SerializedScene,
  actorId: string,
  folders: ReadonlySet<string>,
): boolean {
  const folderId = findActor(scene, actorId)?.folderId ?? null;
  return folderId !== null && folders.has(folderId);
}

function actorMoveForTarget(
  scene: SerializedScene,
  actorId: string,
  target: OutlinerRowTarget | null,
): OutlinerDropMove | null {
  if (target?.kind === "folder") {
    return { kind: "actor", id: actorId, parentId: null, folderId: target.id };
  }
  const parentId = target?.kind === "actor" ? target.id : null;
  if (parentId && wouldCreateCycle(scene, actorId, parentId)) return null;
  const folderId = parentId
    ? (findActor(scene, parentId)?.folderId ?? null)
    : null;
  return { kind: "actor", id: actorId, parentId, folderId };
}

function folderMoveForTarget(
  scene: SerializedScene,
  folderId: string,
  target: OutlinerRowTarget | null,
  rejectActorTarget: boolean,
): OutlinerDropMove | null {
  if (target?.kind === "actor") {
    if (rejectActorTarget) return null;
    return { kind: "folder", id: folderId, parentFolderId: null };
  }
  const parentFolderId = target?.kind === "folder" ? target.id : null;
  if (parentFolderId === folderId) return null;
  if (wouldCreateFolderCycle(scene, folderId, parentFolderId)) return null;
  return { kind: "folder", id: folderId, parentFolderId };
}

export function outlinerTreeDropMoves(options: {
  dragRowId: string;
  targetRowId: string | null;
  selectedRowIds: readonly string[];
  scene: SerializedScene;
}): OutlinerDropMove[] {
  const { dragRowId, targetRowId, scene } = options;
  if (!outlinerRowTarget(dragRowId)) return [];
  const inSelection = options.selectedRowIds.includes(dragRowId);
  const selected = splitOutlinerRowIds(
    inSelection ? options.selectedRowIds : [dragRowId],
  );
  const selectedFolders = new Set(selected.folderIds);
  const selectedActors = new Set(selected.actorIds);
  const folderRoots = selected.folderIds.filter(
    (id) => !ancestorFolderSelected(scene, id, selectedFolders),
  );
  const folderCover = coveredFolderIds(scene, folderRoots);
  const actorRoots = selected.actorIds.filter(
    (id) =>
      !ancestorActorSelected(scene, id, selectedActors) &&
      !actorFolderCovered(scene, id, folderCover),
  );

  const target = outlinerRowTarget(targetRowId);
  if (inSelection && folderRoots.length > 0 && target?.kind === "actor") {
    return [];
  }

  const movingFolders = coveredFolderIds(scene, folderRoots);
  const movingActors = new Set<string>();
  for (const actorId of actorRoots) {
    for (const actor of actorSubtree(scene, actorId)) movingActors.add(actor.id);
  }
  if (target?.kind === "folder" && movingFolders.has(target.id)) return [];
  if (target?.kind === "actor" && movingActors.has(target.id)) return [];

  const moves: OutlinerDropMove[] = [];
  for (const folderId of folderRoots) {
    const move = folderMoveForTarget(scene, folderId, target, inSelection);
    if (!move) return [];
    moves.push(move);
  }
  for (const actorId of actorRoots) {
    const move = actorMoveForTarget(scene, actorId, target);
    if (!move) return [];
    moves.push(move);
  }
  return moves;
}

export function applyOutlinerDropMoves(
  scene: SerializedScene,
  moves: readonly OutlinerDropMove[],
): SerializedScene {
  const folderParent = new Map<string, string | null>();
  const actorMove = new Map<string, Extract<OutlinerDropMove, { kind: "actor" }>>();
  for (const move of moves) {
    if (move.kind === "folder") folderParent.set(move.id, move.parentFolderId);
    else actorMove.set(move.id, move);
  }
  return {
    ...scene,
    folders: scene.folders.map((folder) =>
      folderParent.has(folder.id)
        ? { ...folder, parentFolderId: folderParent.get(folder.id)! }
        : folder,
    ),
    actors: scene.actors.map((actor) => {
      const move = actorMove.get(actor.id);
      return move
        ? { ...actor, parentId: move.parentId, folderId: move.folderId }
        : actor;
    }),
  };
}
