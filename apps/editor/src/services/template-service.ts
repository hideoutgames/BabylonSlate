import {
  listTemplateCatalog,
  loadTemplateFiles,
  encodeProjectZip,
  type ProjectTemplateCatalogEntry,
  type ProjectTreeFile,
} from "@babylonslate/assets";
import { createTemplateStorage } from "@babylonslate/vfs";
import { readProjectArchive } from "./project-import";

const LIBRARY_ROOT = "__slate_templates__";

export async function importTemplateArchive(
  name: string,
  bytes: Uint8Array,
): Promise<void> {
  const files = readProjectArchive(bytes);
  const storage = await createTemplateStorage(LIBRARY_ROOT);
  const base =
    name
      .replace(/\.(zip|babproject)$/i, "")
      .replace(/[^a-zA-Z0-9 _-]/g, "")
      .trim()
      .slice(0, 80) || "Template";
  let target = `${base}.zip`;
  let suffix = 2;
  while (await storage.exists(target)) target = `${base} ${suffix++}.zip`;
  await storage.writeBinary(target, encodeProjectZip(files));
}

/**
 * List the app-owned ZIP template library. Built-in starters are defined by
 * the launcher.
 */
export async function loadTemplateCards(): Promise<ProjectTemplateCatalogEntry[]> {
  const library = await listTemplateCatalog(
    await createTemplateStorage(LIBRARY_ROOT),
  ).catch(() => []);
  return library.map((template) => ({
    ...template,
    id: `local:${template.id}`,
  }));
}

export async function loadSelectedTemplateFiles(id: string): Promise<ProjectTreeFile[]> {
  if (!id.startsWith("local:")) throw new Error(`Unknown template: ${id}`);
  return loadTemplateFiles(await createTemplateStorage(LIBRARY_ROOT), id.slice("local:".length));
}
