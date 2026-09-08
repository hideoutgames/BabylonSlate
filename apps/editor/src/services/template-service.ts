import type { ProjectStorage } from "@babylonslate/core";
import {
  listTemplates,
  encodeProjectZip,
  type ProjectTemplate,
} from "@babylonslate/assets";
import {
  createTemplateStorage,
  type EngineSettings,
  type HostPlatform,
} from "@babylonslate/vfs";
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

export interface TemplateSourceDeps {
  platform: HostPlatform;
  loadSettings: () => Promise<EngineSettings>;
  openTemplatesFolder: (folder: string) => Promise<ProjectStorage>;
}

/**
 * Merge the app-owned ZIP library with the optional native templates folder.
 * Built-in starters are defined by the launcher. Unreadable folders are skipped.
 */
export async function loadTemplateCards(
  deps: TemplateSourceDeps,
): Promise<ProjectTemplate[]> {
  const library = await listTemplates(
    await createTemplateStorage(LIBRARY_ROOT),
  ).catch(() => []);
  const local = library.map((template) => ({
    ...template,
    id: `local:${template.id}`,
  }));
  if (deps.platform === "web") return local;
  const { templatesFolder } = await deps.loadSettings();
  if (!templatesFolder) return local;
  try {
    const folder = await listTemplates(
      await deps.openTemplatesFolder(templatesFolder),
    );
    return [
      ...local,
      ...folder.map((template) => ({
        ...template,
        id: `folder:${template.id}`,
      })),
    ];
  } catch {
    return local;
  }
}
