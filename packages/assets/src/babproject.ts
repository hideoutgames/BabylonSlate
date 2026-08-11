import { unzipSync, zipSync } from "fflate";
import type { ProjectStorage } from "@babylonslate/core";
import { stableStringify } from "./bytes";

export type ManifestKind = "project" | "plugin";

export interface ProjectTreeFile {
  path: string;
  data: Uint8Array;
}

export interface BabprojectManifest {
  kind: ManifestKind;
  guid: string;
  name: string;
  engineVersion: string;
  version: number;
  startupScene?: string;
  [key: string]: unknown;
}

export const PROJECT_MANIFEST_FILE = "project.json";
export const PLUGIN_MANIFEST_FILE = "plugin.json";
export const LAYOUT_FILE = "layout.json";
export const ASSETS_DIR = "assets";
export const BLOBS_DIR = "assets/.blobs";
export const PLUGINS_DIR = "plugins";

export function manifestFileFor(kind: ManifestKind): string {
  return kind === "plugin" ? PLUGIN_MANIFEST_FILE : PROJECT_MANIFEST_FILE;
}

/**
 * Directory backend: read/write project tree through ProjectStorage.
 */
export async function writeProjectTree(
  storage: ProjectStorage,
  files: ProjectTreeFile[],
): Promise<void> {
  for (const file of files) {
    const dir = file.path.includes("/")
      ? file.path.slice(0, file.path.lastIndexOf("/"))
      : "";
    if (dir) {
      await storage.mkdir(dir, true);
    }
    await storage.writeBinary(file.path, file.data);
  }
}

export async function readProjectTree(
  storage: ProjectStorage,
  root = "",
): Promise<ProjectTreeFile[]> {
  const out: ProjectTreeFile[] = [];

  async function walk(dir: string): Promise<void> {
    let entries;
    try {
      entries = await storage.readdir(dir || ".");
    } catch {
      return;
    }
    for (const entry of entries) {
      const path = dir ? `${dir}/${entry.name}` : entry.name;
      if (entry.isDir) {
        await walk(path);
      } else {
        out.push({ path, data: await storage.readBinary(path) });
      }
    }
  }

  await walk(root);
  return out.sort((a, b) => a.path.localeCompare(b.path));
}

/**
 * Zip backend: encode a project tree to a single .babproject zip.
 * Uses a fixed mtime so encoded bytes are golden-stable.
 */
export function encodeProjectZip(files: ProjectTreeFile[]): Uint8Array {
  const record: Record<string, Uint8Array> = {};
  for (const file of [...files].sort((a, b) => a.path.localeCompare(b.path))) {
    record[file.path] = file.data;
  }
  return zipSync(record, { level: 6, mtime: new Date(Date.UTC(1980, 0, 1)) });
}

export function decodeProjectZip(bytes: Uint8Array): ProjectTreeFile[] {
  const record = unzipSync(bytes);
  return Object.entries(record)
    .map(([path, data]) => ({ path, data }))
    .sort((a, b) => a.path.localeCompare(b.path));
}

export function createEmptyProjectFiles(options: {
  kind?: ManifestKind;
  guid: string;
  name: string;
  engineVersion?: string;
}): ProjectTreeFile[] {
  const kind = options.kind ?? "project";
  const manifest: BabprojectManifest = {
    kind,
    guid: options.guid,
    name: options.name,
    engineVersion: options.engineVersion ?? "0.0.0",
    version: 1,
    startupScene: kind === "project" ? "assets/main.scene.babasset" : undefined,
  };
  const files: ProjectTreeFile[] = [
    {
      path: manifestFileFor(kind),
      data: new TextEncoder().encode(stableStringify(manifest)),
    },
  ];
  if (kind === "project") {
    files.push({
      path: LAYOUT_FILE,
      data: new TextEncoder().encode(
        stableStringify({ documents: {}, tabOrder: [] }),
      ),
    });
  }
  return files;
}

/** Export Project: directory tree → zip bytes (ignores derived data by construction). */
export async function exportProjectZip(
  storage: ProjectStorage,
): Promise<Uint8Array> {
  const files = await readProjectTree(storage);
  return encodeProjectZip(files);
}

/** Import a zip into the bound storage directory. */
export async function importProjectZip(
  storage: ProjectStorage,
  zipBytes: Uint8Array,
): Promise<void> {
  await writeProjectTree(storage, decodeProjectZip(zipBytes));
}

/**
 * Rewrite only project name and identity when instantiating from a template (§7.1).
 */
export function rewriteProjectIdentity(
  files: ProjectTreeFile[],
  options: { guid: string; name: string },
): ProjectTreeFile[] {
  return files.map((file) => {
    if (file.path !== PROJECT_MANIFEST_FILE && file.path !== PLUGIN_MANIFEST_FILE) {
      return file;
    }
    const json = JSON.parse(new TextDecoder().decode(file.data)) as Record<
      string,
      unknown
    >;
    json.guid = options.guid;
    json.name = options.name;
    if (json.metadata && typeof json.metadata === "object") {
      const metadata = json.metadata as Record<string, unknown>;
      metadata.name = options.name;
      metadata.updatedAt = new Date().toISOString();
    }
    return {
      path: file.path,
      data: new TextEncoder().encode(stableStringify(json)),
    };
  });
}

/** Copy a template tree into destination storage with a new name/guid. */
export async function createProjectFromTemplate(options: {
  templateFiles: ProjectTreeFile[];
  destination: ProjectStorage;
  guid: string;
  name: string;
}): Promise<void> {
  const rewritten = rewriteProjectIdentity(options.templateFiles, {
    guid: options.guid,
    name: options.name,
  });
  await writeProjectTree(options.destination, rewritten);
}

export interface TemplateCard {
  name: string;
  /** Directory- or zip-backed template identifier. */
  id: string;
}
