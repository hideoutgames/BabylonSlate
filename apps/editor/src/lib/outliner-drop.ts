import { rangeSelectTreeIds, type TreeDropPlacement, type TreeSelectOptions } from "@babylonslate/editor-kit";
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
  | {
      kind: "folder";
      id: string;
      parentFolderId: string | null;
      beforeId?: string;
      afterId?: string;
    }
  | {
      kind: "actor";
      id: string;
      parentId: string | null;
      folderId: string | null;
      beforeId?: string;
      afterId?: string;
    };

function moveIdsRelativeTo<T extends { id: string }>(
  items: readonly T[],
  ids: readonly string[],
  anchorId: string,
  placement: "before" | "after",
): T[] {
  const movingSet = new Set(ids);
  const moving = items.filter((item) => movingSet.has(item.id));
  const rest = items.filter((item) => !movingSet.has(item.id));
  const index = rest.findIndex((item) => item.id === anchorId);
  if (index < 0) return [...rest, ...moving];
  const insertAt = placement === "before" ? index : index + 1;
  return [...rest.slice(0, insertAt), ...moving, ...rest.slice(insertAt)];
}

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
  placement: TreeDropPlacement,
): OutlinerDropMove | null {
  const around = placement === "before" || placement === "after";
  if (!around) {
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
  if (!target) {
    return { kind: "actor", id: actorId, parentId: null, folderId: null };
  }
  if (target.kind === "folder") {
    const folder = findFolder(scene, target.id);
    if (!folder) return null;
    return {
      kind: "actor",
      id: actorId,
      parentId: null,
      folderId: folder.parentFolderId,
    };
  }
  const anchor = findActor(scene, target.id);
  if (!anchor) return null;
  if (wouldCreateCycle(scene, actorId, anchor.parentId)) return null;
  return {
    kind: "actor",
    id: actorId,
    parentId: anchor.parentId,
    folderId: anchor.folderId,
    ...(placement === "before" ? { beforeId: anchor.id } : { afterId: anchor.id }),
  };
}

function folderMoveForTarget(
  scene: SerializedScene,
  folderId: string,
  target: OutlinerRowTarget | null,
  rejectActorTarget: boolean,
  placement: TreeDropPlacement,
): OutlinerDropMove | null {
  const around = placement === "before" || placement === "after";
  if (!around) {
    if (target?.kind === "actor") {
      if (rejectActorTarget) return null;
      return { kind: "folder", id: folderId, parentFolderId: null };
    }
    const parentFolderId = target?.kind === "folder" ? target.id : null;
    if (parentFolderId === folderId) return null;
    if (wouldCreateFolderCycle(scene, folderId, parentFolderId)) return null;
    return { kind: "folder", id: folderId, parentFolderId };
  }
  if (!target) {
    return { kind: "folder", id: folderId, parentFolderId: null };
  }
  if (target.kind === "actor") {
    return {
      kind: "folder",
      id: folderId,
      parentFolderId: findActor(scene, target.id)?.folderId ?? null,
    };
  }
  const anchor = findFolder(scene, target.id);
  if (!anchor) return null;
  const parentFolderId = anchor.parentFolderId;
  if (parentFolderId === folderId) return null;
  if (wouldCreateFolderCycle(scene, folderId, parentFolderId)) return null;
  return {
    kind: "folder",
    id: folderId,
    parentFolderId,
    ...(placement === "before" ? { beforeId: anchor.id } : { afterId: anchor.id }),
  };
}

export function outlinerTreeDropMoves(options: {
  dragRowId: string;
  targetRowId: string | null;
  selectedRowIds: readonly string[];
  scene: SerializedScene;
  placement?: TreeDropPlacement;
}): OutlinerDropMove[] {
  const { dragRowId, targetRowId, scene } = options;
  const placement = options.placement ?? "into";
  const around = placement === "before" || placement === "after";
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
  if (
    inSelection &&
    folderRoots.length > 0 &&
    target?.kind === "actor" &&
    !around
  ) {
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
    const move = folderMoveForTarget(
      scene,
      folderId,
      target,
      inSelection,
      placement,
    );
    if (!move) return [];
    moves.push(move);
  }
  for (const actorId of actorRoots) {
    const move = actorMoveForTarget(scene, actorId, target, placement);
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
  let folders = scene.folders.map((folder) =>
    folderParent.has(folder.id)
      ? { ...folder, parentFolderId: folderParent.get(folder.id)! }
      : folder,
  );
  let actors = scene.actors.map((actor) => {
    const move = actorMove.get(actor.id);
    return move
      ? { ...actor, parentId: move.parentId, folderId: move.folderId }
      : actor;
  });
  const folderAnchor = moves.find(
    (move): move is Extract<OutlinerDropMove, { kind: "folder" }> =>
      move.kind === "folder" && Boolean(move.beforeId || move.afterId),
  );
  if (folderAnchor) {
    const ids = moves
      .filter((move) => move.kind === "folder")
      .map((move) => move.id);
    folders = moveIdsRelativeTo(
      folders,
      ids,
      folderAnchor.beforeId ?? folderAnchor.afterId!,
      folderAnchor.beforeId ? "before" : "after",
    );
  }
  const actorAnchor = moves.find(
    (move): move is Extract<OutlinerDropMove, { kind: "actor" }> =>
      move.kind === "actor" && Boolean(move.beforeId || move.afterId),
  );
  if (actorAnchor) {
    const ids = moves
      .filter((move) => move.kind === "actor")
      .map((move) => move.id);
    actors = moveIdsRelativeTo(
      actors,
      ids,
      actorAnchor.beforeId ?? actorAnchor.afterId!,
      actorAnchor.beforeId ? "before" : "after",
    );
  }
  return {
    ...scene,
    folders,
    actors,
  };
}
