import type { ProjectStorage } from "@haptic/core";
import { DocumentsStorageAdapter } from "./documents-adapter";
import { ElectronLibraryStorageAdapter } from "./electron-storage-adapter";
import type { LibraryFolder } from "./library-folders";
import { isElectronHost, isMobilePlatform } from "./platform";
import { OpfsStorageAdapter } from "./web-adapter";

/**
 * Bind storage to an app-owned library folder (templates, engine plugins and
 * extensions). Mobile libraries live beside projects in the Documents tier;
 * Electron libraries are real folders under `userData/libraries`, reached
 * through the scoped `library:*` IPC; web uses an OPFS library bind. None of
 * them is listed as a project.
 */
export async function createTemplateStorage(
  folder: LibraryFolder,
): Promise<ProjectStorage> {
  const storage = isMobilePlatform()
    ? new DocumentsStorageAdapter()
    : isElectronHost()
      ? new ElectronLibraryStorageAdapter(folder)
      : new OpfsStorageAdapter({ library: true });
  await storage.openDocumentsProject(folder);
  return storage;
}
