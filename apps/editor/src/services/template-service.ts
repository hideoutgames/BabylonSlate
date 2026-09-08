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
import { unzipSync } from "fflate";

const LIBRARY_ROOT = "__slate_templates__";

export async function importTemplateArchive(
  name: string,
  bytes: Uint8Array,
): Promise<void> {
  if (bytes.byteLength > 50 * 1024 * 1024)
    throw new Error("Template archive exceeds 50 MB.");
  let total = 0;
  const archive = unzipSync(bytes, {
    filter: (entry) => {
      total += entry.originalSize;
      if (total > 200 * 1024 * 1024)
        throw new Error("Expanded template exceeds 200 MB.");
      return true;
    },
  });
  const files = Object.entries(archive)
    .filter(([path]) => !path.endsWith("/"))
    .map(([path, data]) => ({ path, data }));
  if (
    files.some(
      (file) =>
        file.path.startsWith("/") ||
        file.path.includes("\\") ||
        file.path
          .split("/")
          .some((part) => part === ".." || part.includes(":")),
    )
  )
    throw new Error("Invalid template paths.");
  const manifest = files.find((file) => file.path === "project.json");
  if (!manifest)
    throw new Error("Choose an exported project ZIP containing project.json.");
  const project: unknown = JSON.parse(new TextDecoder().decode(manifest.data));
  if (!project || typeof project !== "object" || Array.isArray(project))
    throw new Error("Invalid project manifest.");
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
