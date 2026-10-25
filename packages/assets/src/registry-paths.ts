import type { ContentRoot } from "./content-root";
import type { FolderNode, IndexedAsset } from "./registry-types";
import { assetFileSuffix } from "./unique-names";

/**
 * The folder tree of `root`: its known folders and the folders holding
 * `assets` (the root's indexed assets), children and assets sorted.
 */
export function buildFolderTree(root: ContentRoot, knownFolders: Iterable<string>, assets: readonly IndexedAsset[]): FolderNode {
  const rootNode: FolderNode = {
    name: root.pathPrefix.split("/").pop() ?? root.pathPrefix,
    path: root.pathPrefix,
    children: [],
    assets: [],
  };
  const nodes = new Map<string, FolderNode>([[root.pathPrefix, rootNode]]);

  const ensureNode = (path: string): FolderNode => {
    const existing = nodes.get(path);
    if (existing) return existing;
    const parentPath = path.includes("/")
      ? path.slice(0, path.lastIndexOf("/"))
      : root.pathPrefix;
    const parent = parentPath === path ? rootNode : ensureNode(parentPath);
    const node: FolderNode = {
      name: path.slice(path.lastIndexOf("/") + 1),
      path,
      children: [],
      assets: [],
    };
    parent.children.push(node);
    nodes.set(path, node);
    return node;
  };

  for (const folderPath of knownFolders) {
    if (
      folderPath === root.pathPrefix ||
      folderPath.startsWith(`${root.pathPrefix}/`)
    ) {
      ensureNode(folderPath);
    }
  }

  for (const asset of assets) {
    const dir = asset.path.includes("/")
      ? asset.path.slice(0, asset.path.lastIndexOf("/"))
      : root.pathPrefix;
    const node = dir === root.pathPrefix ? rootNode : ensureNode(dir);
    node.assets.push(asset.header.guid);
  }

  sortFolderTree(rootNode);
  return rootNode;
}

function sortFolderTree(node: FolderNode): void {
  node.children.sort((a, b) => a.name.localeCompare(b.name));
  node.assets.sort();
  for (const child of node.children) sortFolderTree(child);
}

export function joinRootPath(root: ContentRoot, relativePath: string): string {
  const trimmed = relativePath.replace(/^\/+/, "");
  return trimmed ? `${root.pathPrefix}/${trimmed}` : root.pathPrefix;
}

export function joinRelative(folderRelative: string, fileName: string): string {
  const trimmed = folderRelative.replace(/^\/+|\/+$/g, "");
  return trimmed ? `${trimmed}/${fileName}` : fileName;
}

export function parentPath(path: string): string {
  return path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "";
}

export function isWithinFolder(path: string, folder: string): boolean {
  return path === folder || path.startsWith(`${folder}/`);
}

export function sanitizeFileName(name: string): string {
  return name.replace(/[^a-zA-Z0-9_.-]+/g, "_");
}

/** Validate a single visible Content Browser name without changing Unicode. */
export function contentEntryNameError(name: string): string | null {
  const trimmed = name.trim();
  if (!trimmed) return "Enter a name.";
  if (trimmed === "." || trimmed === "..") return "Choose a name other than . or ...";
  if (/[\\/:*?"<>|]/.test(trimmed) || Array.from(trimmed).some((character) => character.charCodeAt(0) < 32)) {
    return "Names cannot contain path separators or these characters: : * ? \" < > |.";
  }
  if (trimmed.endsWith(".")) return "Names cannot end with a period.";
  return null;
}

/** Rename the display stem while retaining the asset's complete container suffix. */
export function renamedAssetPath(currentPath: string, newName: string): string {
  const error = contentEntryNameError(newName);
  if (error) throw new Error(error);
  const dir = currentPath.includes("/") ? currentPath.slice(0, currentPath.lastIndexOf("/") + 1) : "";
  const suffix = assetFileSuffix(currentPath);
  return `${dir}${newName.trim()}${suffix}`;
}
