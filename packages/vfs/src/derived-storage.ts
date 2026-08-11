import { OpfsStorageAdapter } from "./web-adapter";
import type { ProjectStorage } from "@babylonslate/core";
import { DocumentsStorageAdapter } from "./documents-adapter";
import { isMobilePlatform } from "./platform";

const DERIVED_ROOT = "__babylonslate_derived__";

/**
 * App-private derived-data store keyed under a stable root (outside project trees).
 * Web: OPFS. Mobile: Documents under BabylonSlate/projects/__babylonslate_derived__.
 */
export async function createDerivedStorage(): Promise<ProjectStorage> {
  if (isMobilePlatform()) {
    const storage = new DocumentsStorageAdapter();
    await storage.openDocumentsProject(DERIVED_ROOT);
    return storage;
  }
  const storage = new OpfsStorageAdapter();
  await storage.openDocumentsProject(DERIVED_ROOT);
  return storage;
}
