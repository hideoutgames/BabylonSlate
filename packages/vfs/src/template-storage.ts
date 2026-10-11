import type { ProjectStorage } from "@babylonslate/core";
import { DocumentsStorageAdapter } from "./documents-adapter";
import { isMobilePlatform } from "./platform";
import { OpfsStorageAdapter } from "./web-adapter";

/**
 * Bind storage to an app-owned library folder (templates, engine plugins and
 * extensions). Mobile libraries live beside projects in the Documents tier;
 * web and Electron use an OPFS library bind, which is not listed as a project.
 */
export async function createTemplateStorage(
  folder: string,
): Promise<ProjectStorage> {
  const storage = isMobilePlatform()
    ? new DocumentsStorageAdapter()
    : new OpfsStorageAdapter({ library: true });
  await storage.openDocumentsProject(folder);
  return storage;
}
