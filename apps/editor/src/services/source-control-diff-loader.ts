import { PROJECT_FILE } from "@haptic/core";
import type { AssetVersionSource } from "@haptic/assets/asset-diff";
import { AssetDiffClient } from "@haptic/assets/asset-diff-client";
import { diffProjectVersions, EMPTY_PROJECT_DIFF_LOOKUP, type ProjectDiffLookup } from "@haptic/assets/project-settings-diff";
import { assetBlobFolder } from "../lib/source-control-changes";
import { refLabel, type DiffLoader, type DiffRef, type DiffTarget } from "./source-control-diff";
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
      // Each read is a fresh file read: it moves to the worker without a copy.
      owned: true,
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

/** One version of `project.json`: the working copy's file, or a commit's (none for a side with no commit). */
function readProjectFile(sync: SourceControlSyncService, ref: DiffRef, commit: string | null): Promise<Uint8Array | null> {
  if (ref.kind === "working") return sync.readWorking(PROJECT_FILE);
  return commit ? sync.readFileAt(PROJECT_FILE, commit) : Promise.resolve(null);
}

/**
 * Asset diffs on one long-lived worker (`AssetDiffClient`), reading through
 * the project's sync. Project Settings (`project.json`) are compared on the
 * main thread (one small JSON file), with the names `lookup` knows now.
 */
export function createDiffLoader(sync: SourceControlSyncService, lookup: () => ProjectDiffLookup = () => EMPTY_PROJECT_DIFF_LOOKUP): DiffLoader {
  const client = new AssetDiffClient();
  return {
    async load(target: DiffTarget, commits, signal) {
      if (target.path === PROJECT_FILE) {
        const snapshot = sync.getSnapshot();
        const [base, compare] = await Promise.all([
          readProjectFile(sync, target.base, commits.base),
          readProjectFile(sync, target.compare, commits.compare),
        ]);
        signal.throwIfAborted();
        return diffProjectVersions(
          { bytes: base, label: refLabel(target.base, snapshot) },
          { bytes: compare, label: refLabel(target.compare, snapshot) },
          lookup(),
        );
      }
      // Folder markers and other files are plain files: only assets and Project Settings are compared.
      if (!target.path.endsWith(".hasset")) throw new Error(`${target.name} is not an asset, so it has no diff.`);
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
