import { OpfsStorageAdapter } from "./web-adapter";
import type { ProjectStorage } from "@haptic/core";
import { DocumentsStorageAdapter } from "./documents-adapter";
import { isMobilePlatform } from "./platform";
import { DERIVED_STORAGE_ROOT } from "./library-folders";

/**
 * App-private derived-data store keyed under a stable root (outside project trees).
 * Web and Electron: an OPFS library bind. Mobile: the project tier's
 * BabylonSlate/projects/__haptic_derived__.
 */
export async function createDerivedStorage(): Promise<ProjectStorage> {
  const storage = isMobilePlatform()
    ? new DocumentsStorageAdapter()
    : new OpfsStorageAdapter({ library: true });
  await storage.openDocumentsProject(DERIVED_STORAGE_ROOT);
  return storage;
}
