import type { ProjectStorage } from "@babylonslate/core";
import { DocumentsStorageAdapter } from "./documents-adapter";
import { isMobilePlatform } from "./platform";
import { OpfsStorageAdapter } from "./web-adapter";

/**
 * Bind storage to the Engine Settings templates folder. Templates live beside
 * projects in the same tier, so directory and zip templates both read through
 * the ordinary project backends.
 */
export async function createTemplateStorage(
  folder: string,
): Promise<ProjectStorage> {
  const storage = isMobilePlatform()
    ? new DocumentsStorageAdapter()
    : new OpfsStorageAdapter();
  await storage.openDocumentsProject(folder);
  return storage;
}
