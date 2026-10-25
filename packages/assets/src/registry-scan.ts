import { isStorageNotFound, SourceRevisionChangedError, type ProjectStorageReader } from "@haptic/core";
import { createReadAhead } from "./bounded-concurrency";
import type { ContentRoot } from "./content-root";
import { readAssetCatalog } from "./payload-loader";
import { FOLDER_MARKER_NAME, type RegistryHost } from "./registry-types";
import { STORAGE_MOVE_BACKUP_PREFIX } from "./storage-move";

/** Header reads requested at once within a run of files while a root is scanned (a folder being walked has one such run active). */
const SCAN_CATALOG_READS = 8;

const BLOBS_DIR_NAME = ".blobs";

/** Index the asset files and folders of `root` under `dir`, walking each subfolder in turn. */
export async function walkRoot(host: RegistryHost, root: ContentRoot, dir: string, storage: ProjectStorageReader): Promise<void> {
  let entries;
  try {
    entries = await storage.readdir(dir);
  } catch (error) {
    // Missing (a root without content yet, or a folder removed since its
    // parent was listed) is empty. Any other failure fails the scan.
    if (isStorageNotFound(error)) return;
    throw error;
  }
  // The header reads of a run of files overlap (bounded), but each result is consumed in
  // directory order. Guid-conflict resolution (the first indexed file keeps a shared guid),
  // folder registration and the first scan error therefore stay those of a serial scan.
  // A run ends at a subfolder that will be walked: reads never start ahead across that walk,
  // so a header is not read long before it is indexed (a `reindexPath` in between would
  // otherwise be overwritten by the older header).
  const slots: Array<{ run: string[]; index: number }> = [];
  let run: string[] = [];
  for (const entry of entries) {
    const path = `${dir}/${entry.name}`;
    if (entry.isDir) {
      if (!(entry.name === BLOBS_DIR_NAME || entry.name.startsWith(STORAGE_MOVE_BACKUP_PREFIX))) run = [];
    } else if (entry.name !== FOLDER_MARKER_NAME && path.endsWith(".hasset")) {
      run.push(path);
      slots.push({ run, index: run.length - 1 });
    }
  }
  const readCatalog = createReadAhead(SCAN_CATALOG_READS, (path: string) => readScannedCatalog(storage, path));
  let nextSlot = 0;
  try {
    for (const entry of entries) {
      // A remount of this id replaced the root: its own scan indexes the folder.
      if (host.roots.get(root.id) !== root) break;
      const path = `${dir}/${entry.name}`;
      if (entry.isDir) {
        if (entry.name === BLOBS_DIR_NAME || entry.name.startsWith(STORAGE_MOVE_BACKUP_PREFIX)) continue;
        host.addKnownFolder(path);
        await walkRoot(host, root, path, storage);
        continue;
      }
      if (entry.name === FOLDER_MARKER_NAME) {
        host.addKnownFolder(dir);
        continue;
      }
      if (!path.endsWith(".hasset")) continue;
      const slot = slots[nextSlot++]!;
      const { header, locator } = await readCatalog(slot.run, slot.index);
      if (host.roots.get(root.id) !== root) break;
      const indexed = host.byGuid.get(header.guid);
      if (indexed && !indexed.placeholder && indexed.path !== path) {
        // A second file with an indexed guid (a copy made outside the editor)
        // must not evict the first one's entry; it is recorded instead.
        host.guidConflicts.set(path, { rootId: root.id, path, guid: header.guid, indexedPath: indexed.path });
        host.changed();
        continue;
      }
      host.indexHeader(root.id, path, header, false, entry.mtime ?? null, locator);
    }
  } finally {
    // Reads left running must not outlive the scan: the read scope ends when it returns.
    await readCatalog.settle();
  }
}

/** A save can land between a scan's bounded header reads; read that file again. */
async function readScannedCatalog(storage: ProjectStorageReader, path: string) {
  for (let attempt = 1; ; attempt++) {
    try { return await readAssetCatalog(storage, path); }
    catch (error) {
      if (!(error instanceof SourceRevisionChangedError) || attempt === 3) throw error;
    }
  }
}
