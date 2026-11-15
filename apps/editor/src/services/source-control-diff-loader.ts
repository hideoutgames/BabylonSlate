import type { AssetVersionSource } from "@haptic/assets/asset-diff";
import { AssetDiffClient } from "@haptic/assets/asset-diff-client";
import { assetBlobFolder } from "./source-control-restore";
import type { DiffLoader, DiffTarget } from "./source-control-diff";
import type { SourceControlSyncService } from "./source-control-sync";

/**
 * Reads one version of `path` for the diff worker: the working copy from the
 * project folder, a commit from the Git object store. A blob comes from the
 * asset's own root's `.blobs` folder: the working copy's file, or (for a
 * commit) the LFS object, downloaded when the copy no longer has it.
 */
function versionSource(sync: SourceControlSyncService, path: string, commit: string | null, working: boolean, signal: AbortSignal): AssetVersionSource {
  const blobPath = (sha256: string) => {
    const folder = assetBlobFolder(path);
    if (!folder) throw new Error(`${path} is outside the project's assets, so it has no blobs.`);
    return `${folder}/${sha256}`;
  };
  if (working) {
    return {
      key: null,
      read: () => sync.readWorking(path),
      readBlob: async (sha256, byteLength) => {
        const bytes = await sync.readWorking(blobPath(sha256));
        if (!bytes || bytes.byteLength !== byteLength) throw new Error(`The working copy is missing blob ${sha256}.`);
        return bytes;
      },
    };
  }
  return {
    // A commit's version never changes, so the worker keeps it decoded.
    key: commit ? `${path}@${commit}` : null,
    read: () => (commit ? sync.readFileAt(path, commit) : Promise.resolve(null)),
    readBlob: (sha256, byteLength) => sync.readLfsObject(blobPath(sha256), byteLength, signal),
  };
}

/** Diffs on one long-lived worker (`AssetDiffClient`), reading through the project's sync. */
export function createDiffLoader(sync: SourceControlSyncService): DiffLoader {
  const client = new AssetDiffClient();
  return {
    load(target: DiffTarget, commits, signal) {
      return client.diff({
        path: target.path,
        base: versionSource(sync, target.path, commits.base, target.base.kind === "working", signal),
        compare: versionSource(sync, target.path, commits.compare, target.compare.kind === "working", signal),
        signal,
      });
    },
    dispose: () => client.dispose(),
  };
}
