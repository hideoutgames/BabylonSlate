import type { ProjectStorage } from "@babylonslate/core";
import {
  decodeProjectZip,
  PROJECT_MANIFEST_FILE,
  readProjectTree,
  type ProjectTreeFile,
} from "./babproject";

export interface ProjectTemplate {
  /** Folder or zip entry name, e.g. `Platformer.babproject`. */
  id: string;
  name: string;
  files: ProjectTreeFile[];
}

const TEMPLATE_SUFFIX = ".babproject";

function displayName(entryName: string): string {
  return entryName.endsWith(TEMPLATE_SUFFIX)
    ? entryName.slice(0, -TEMPLATE_SUFFIX.length)
    : entryName;
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
 * Discover `.babproject` templates in a templates folder. Both project backends
 * count: a directory template is read as a tree, a zip template is decoded.
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
    if (!entry.name.endsWith(TEMPLATE_SUFFIX)) continue;
    const path = root ? `${root}/${entry.name}` : entry.name;
    try {
      const files = entry.isDir
        ? stripPrefix(await readProjectTree(storage, path), `${path}/`)
        : decodeProjectZip(await storage.readBinary(path));
      if (!files.some((file) => file.path === PROJECT_MANIFEST_FILE)) continue;
      templates.push({ id: entry.name, name: displayName(entry.name), files });
    } catch {
      continue;
    }
  }
  return templates.sort((a, b) => a.name.localeCompare(b.name));
}
