import { remapPathAfterFolderMove } from "./content-browser-helpers";

export type LockPathState = "mine" | "theirs" | null;

export interface LockTransferPair {
  from: string;
  to: string;
}

/** Returns a holder message when any path is locked by someone else. */
export function refuseTheirsPaths(
  paths: string[],
  refuseIfTheirs: (path: string) => string | null,
): string | null {
  for (const path of paths) {
    const message = refuseIfTheirs(path);
    if (message) return message;
  }
  return null;
}

/** Paths we hold, so a delete can unlock the old LFS path. */
export function oursLockPaths(
  paths: string[],
  lockStateForPath: (path: string) => LockPathState,
): string[] {
  return paths.filter((path) => lockStateForPath(path) === "mine");
}

/** Asset paths in a folder, including nested files. Sibling prefixes are excluded. */
export function containedAssetPaths(
  assets: readonly { path: string }[],
  folderPath: string,
): string[] {
  const prefix = `${folderPath}/`;
  return assets
    .filter((asset) => asset.path === folderPath || asset.path.startsWith(prefix))
    .map((asset) => asset.path);
}

export function folderMoveLockTransfers(
  assets: readonly { path: string }[],
  fromFolder: string,
  toFolder: string,
): LockTransferPair[] {
  return containedAssetPaths(assets, fromFolder).map((from) => ({
    from,
    to: remapPathAfterFolderMove(from, fromFolder, toFolder),
  }));
}

export async function applyLockTransfers(
  pairs: readonly LockTransferPair[],
  lockStateForPath: (path: string) => LockPathState,
  transferLock: (from: string, to: string) => Promise<void>,
): Promise<void> {
  for (const { from, to } of pairs) {
    if (from === to) continue;
    if (lockStateForPath(from) === "mine") {
      await transferLock(from, to);
    }
  }
}
