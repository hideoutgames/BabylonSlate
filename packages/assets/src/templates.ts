import type { ProjectStorage } from "@babylonslate/core";
import {
  decodeProjectZip,
  PROJECT_MANIFEST_FILE,
  readProjectTree,
  type ProjectTreeFile,
} from "./babproject";

export interface ProjectTemplate {
  /** Folder or zip entry name, e.g. `Platformer` or `TopDown.zip`. */
  id: string;
  name: string;
  files: ProjectTreeFile[];
}

function displayName(entryName: string): string {
  return entryName.replace(/(\.babproject|\.zip)$/i, "");
}

function isProjectArchive(entryName: string): boolean {
  return /\.(zip|babproject)$/i.test(entryName);
}

function stripPrefix(
  files: ProjectTreeFile[],
  prefix: string,
): ProjectTreeFile[] {
  return files.map((file) => ({
    path: file.path.startsWith(prefix) ? file.path.slice(prefix.length) : file.path,
    data: file.data,
  }));
}

/**
 * Discover project templates in a templates folder. Directory templates need a
 * `project.json`; zip / legacy `.babproject` files are decoded the same way.
 * Entries without a project manifest are ignored rather than failing discovery.
 */
export async function listTemplates(
  storage: ProjectStorage,
  root = "",
): Promise<ProjectTemplate[]> {
  let entries;
  try {
    entries = await storage.readdir(root || ".");
  } catch {
    return [];
  }

  const templates: ProjectTemplate[] = [];
  for (const entry of entries) {
    const path = root ? `${root}/${entry.name}` : entry.name;
    try {
      const files = entry.isDir
        ? stripPrefix(await readProjectTree(storage, path), `${path}/`)
        : isProjectArchive(entry.name)
          ? decodeProjectZip(await storage.readBinary(path))
          : null;
      if (!files?.some((file) => file.path === PROJECT_MANIFEST_FILE)) continue;
      templates.push({ id: entry.name, name: displayName(entry.name), files });
    } catch {
      continue;
    }
  }
  return templates.sort((a, b) => a.name.localeCompare(b.name));
}
