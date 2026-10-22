import type { ProjectStorage } from "@haptic/core";
import {
  decodeProjectZip,
  PROJECT_MANIFEST_FILE,
  readProjectTree,
  type ProjectTreeFile,
} from "./hproject";

export interface ProjectTemplateCatalogEntry {
  /** Folder or zip entry name, e.g. `Platformer` or `TopDown.zip`. */
  id: string;
  name: string;
}

function displayName(entryName: string): string {
  return entryName.replace(/\.zip$/i, "");
}

function isProjectArchive(entryName: string): boolean {
  return /\.zip$/i.test(entryName);
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

/** List available templates without reading archives or directory payloads. */
export async function listTemplateCatalog(storage: ProjectStorage, root = ""): Promise<ProjectTemplateCatalogEntry[]> {
  const entries = await storage.readdir(root || ".").catch(() => []);
  const catalog: ProjectTemplateCatalogEntry[] = [];
  for (const entry of entries) {
    const path = root ? `${root}/${entry.name}` : entry.name;
    if (entry.isDir ? await storage.exists(`${path}/${PROJECT_MANIFEST_FILE}`) : isProjectArchive(entry.name)) {
      catalog.push({ id: entry.name, name: displayName(entry.name) });
    }
  }
  return catalog.sort((a, b) => a.name.localeCompare(b.name));
}

/** Decode one explicitly selected template; archive validation belongs here. */
export async function loadTemplateFiles(storage: ProjectStorage, id: string, root = ""): Promise<ProjectTreeFile[]> {
  const entries = await storage.readdir(root || ".");
  const entry = entries.find((candidate) => candidate.name === id);
  if (!entry) throw new Error(`Template not found: ${id}`);
  const path = root ? `${root}/${entry.name}` : entry.name;
  const files = entry.isDir
    ? stripPrefix(await readProjectTree(storage, path), `${path}/`)
    : isProjectArchive(entry.name) ? decodeProjectZip(await storage.readBinary(path)) : [];
  if (!files.some((file) => file.path === PROJECT_MANIFEST_FILE)) {
    throw new Error(`Template ${id} is missing ${PROJECT_MANIFEST_FILE}`);
  }
  return files;
}
