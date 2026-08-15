export const MANY_EXTERNAL_CHANGES = 8;

export type AssetMtimeMap = Record<string, number | null>;

export interface AssetMtimeDiff {
  changedPaths: string[];
  addedPaths: string[];
  removedPaths: string[];
}

export type ExternalChangeKind =
  | "none"
  | "reload-project"
  | "reload-clean"
  | "dirty-disk";

export interface ExternalChangeClassification {
  kind: ExternalChangeKind;
  changedPaths: string[];
  dirtyChangedPaths: string[];
  cleanChangedPaths: string[];
}

export function snapshotIndexedMtimes(
  assets: ReadonlyArray<{ path: string; mtime?: number | null }>,
): AssetMtimeMap {
  const out: AssetMtimeMap = {};
  for (const asset of assets) {
    out[asset.path] = asset.mtime ?? null;
  }
  return out;
}

export function diffAssetMtimes(
  previous: AssetMtimeMap,
  next: AssetMtimeMap,
): AssetMtimeDiff {
  const changedPaths: string[] = [];
  const addedPaths: string[] = [];
  const removedPaths: string[] = [];
  for (const path of Object.keys(next)) {
    if (!(path in previous)) {
      addedPaths.push(path);
    } else if (previous[path] !== next[path]) {
      changedPaths.push(path);
    }
  }
  for (const path of Object.keys(previous)) {
    if (!(path in next)) {
      removedPaths.push(path);
    }
  }
  changedPaths.sort();
  addedPaths.sort();
  removedPaths.sort();
  return { changedPaths, addedPaths, removedPaths };
}

export function classifyExternalChanges(input: {
  previousAssets: AssetMtimeMap;
  nextAssets: AssetMtimeMap;
  previousProjectJsonMtime: number | null;
  nextProjectJsonMtime: number | null;
  openDocs: ReadonlyArray<{ path: string; dirty: boolean }>;
}): ExternalChangeClassification {
  const diff = diffAssetMtimes(input.previousAssets, input.nextAssets);
  const changedPaths = [
    ...diff.changedPaths,
    ...diff.addedPaths,
    ...diff.removedPaths,
  ];
  const projectJsonChanged =
    input.previousProjectJsonMtime !== input.nextProjectJsonMtime;
  const dirtyChangedPaths = input.openDocs
    .filter((doc) => doc.dirty && diff.changedPaths.includes(doc.path))
    .map((doc) => doc.path);
  const cleanChangedPaths = input.openDocs
    .filter((doc) => !doc.dirty && diff.changedPaths.includes(doc.path))
    .map((doc) => doc.path);

  let kind: ExternalChangeKind = "none";
  if (
    projectJsonChanged ||
    changedPaths.length >= MANY_EXTERNAL_CHANGES
  ) {
    kind = "reload-project";
  } else if (dirtyChangedPaths.length > 0) {
    kind = "dirty-disk";
  } else if (cleanChangedPaths.length > 0) {
    kind = "reload-clean";
  }

  return {
    kind,
    changedPaths: diff.changedPaths,
    dirtyChangedPaths,
    cleanChangedPaths,
  };
}
