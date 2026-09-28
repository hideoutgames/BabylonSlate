import {
  newAssetGuid,
  nextCopyName,
  type AssetRegistry,
  type IndexedAsset,
} from "@babylonslate/assets";
import type { SerializedGraph, WaterStyle } from "@babylonslate/core";
import { engineParentOf, walkAncestry } from "@babylonslate/editor-kit";
import {
  isLockedEngineClassId,
  MAX_CLASS_INHERITANCE_DEPTH,
} from "@babylonslate/object-model";
import type { MaterialDomain } from "@babylonslate/shader-graph";
import {
  ASSETS_ROOT,
  CREATABLE_ASSET_TYPES,
  buildNewAssetResult,
  classIdFromClassAsset,
  classParentLookup,
  defaultParentClassForType,
  joinAssetFolderPath,
  newAssetFileName,
  newAssetFileSuffix,
  type CreatableAssetType,
} from "./content-browser-helpers";
import { collectClassGraphsForPalette } from "./logic-graph-document";
import { PROJECT_CONTENT_ROOT_ID } from "./plugin-ui";
import { classIdForGraphPath } from "../services/script-compiler";

/** The single New Asset write path (Content Browser and picker Create New rows). */
export async function createProjectAsset(options: {
  registry: Pick<AssetRegistry, "createAsset">;
  rootId: string;
  /** Folder inside the root (`Levels`), empty for the root itself. */
  folderRelative: string;
  type: CreatableAssetType;
  name: string;
  parentClass?: string | null;
  waterStyle?: WaterStyle;
  materialDomain?: MaterialDomain;
  classParentOf?: (id: string) => string | null | undefined;
  parentGraphs?: Record<string, SerializedGraph>;
}): Promise<IndexedAsset> {
  const { type, name } = options;
  const fileName = newAssetFileName(type, name);
  if (!fileName) throw new Error("Enter a name for the new asset.");
  const parentClass =
    type === "Class"
      ? (options.parentClass ?? defaultParentClassForType(type))
      : defaultParentClassForType(type);
  if (
    type === "Class" &&
    walkAncestry(parentClass, options.classParentOf ?? engineParentOf).length >=
      MAX_CLASS_INHERITANCE_DEPTH
  ) {
    throw new Error(
      `${parentClass} cannot have children: Classes allow at most ${MAX_CLASS_INHERITANCE_DEPTH} levels of inheritance.`,
    );
  }
  const result = buildNewAssetResult({
    type,
    name,
    guid: newAssetGuid(),
    parentClass,
    parentOf: options.classParentOf,
    parentGraphs: type === "Class" ? options.parentGraphs : undefined,
    waterStyle: options.waterStyle,
    materialDomain: options.materialDomain,
  });
  return options.registry.createAsset(
    options.rootId,
    joinAssetFolderPath(options.folderRelative, fileName),
    result,
  );
}

/** Types a picker may offer as Create New rows (editor-only tools excluded). */
export function isPickerCreatableAssetType(
  type: string,
): type is CreatableAssetType {
  return (
    type !== "SkyboxCreator" &&
    (CREATABLE_ASSET_TYPES as readonly string[]).includes(type)
  );
}

/** Class ids are file stems, so picker-created Class names use only `[A-Za-z0-9_]`. */
export function sanitizeClassName(name: string): string {
  return name
    .trim()
    .replace(/[^A-Za-z0-9_]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

/**
 * Name for a picker-created asset: the requested name (or `New<Type>`) when its
 * file is free in `folderPath`, else the next `_N` copy name. Class names are
 * sanitized and must also avoid every project and engine class id.
 */
export function uniqueNewAssetName(options: {
  type: CreatableAssetType;
  preferred?: string;
  /** Full folder path (`assets/Levels`). */
  folderPath: string;
  existingPaths: Iterable<string>;
  /** Class ids used anywhere in the project (Class creation only). */
  classIds?: Iterable<string>;
}): string {
  const { type } = options;
  const isClass = type === "Class";
  const fallback = `New${type}`;
  const requested = options.preferred?.trim() || fallback;
  const name = isClass ? sanitizeClassName(requested) || fallback : requested;
  const suffix = newAssetFileSuffix(type);
  const prefix = `${options.folderPath.replace(/\/+$/, "")}/`;
  const used: string[] = [];
  for (const path of options.existingPaths) {
    if (!path.startsWith(prefix) || !path.endsWith(suffix)) continue;
    const fileName = path.slice(prefix.length);
    if (fileName.includes("/")) continue;
    used.push(fileName.slice(0, -suffix.length));
  }
  const stem = newAssetFileName(type, name).slice(0, -suffix.length);
  if (isClass) {
    used.push(...(options.classIds ?? []));
    if (isLockedEngineClassId(stem) || engineParentOf(stem) !== undefined) {
      used.push(stem);
    }
  }
  return used.includes(stem) ? nextCopyName(stem, used) : name;
}

export type PickerCreateFolder = {
  rootId: string;
  /** Full folder path (`assets/Levels`). */
  folderPath: string;
  /** Folder inside the root, empty for the root itself. */
  relative: string;
};

/**
 * Picker-created assets go next to the owning document when it sits in a
 * writable content root; otherwise (engine plugins, no document) in `assets`.
 */
export function pickerCreateFolder(
  ownerPath: string | null | undefined,
  roots: ReadonlyArray<{ id: string; pathPrefix: string; readOnly?: boolean }>,
): PickerCreateFolder {
  const folder = ownerPath?.includes("/")
    ? ownerPath.slice(0, ownerPath.lastIndexOf("/"))
    : "";
  const root = roots
    .filter(
      (candidate) =>
        folder === candidate.pathPrefix ||
        folder.startsWith(`${candidate.pathPrefix}/`),
    )
    .sort((a, b) => b.pathPrefix.length - a.pathPrefix.length)[0];
  if (root && !root.readOnly) {
    return {
      rootId: root.id,
      folderPath: folder,
      relative:
        folder === root.pathPrefix
          ? ""
          : folder.slice(root.pathPrefix.length + 1),
    };
  }
  const project = roots.find((entry) => entry.id === PROJECT_CONTENT_ROOT_ID);
  return {
    rootId: PROJECT_CONTENT_ROOT_ID,
    folderPath: project?.pathPrefix ?? ASSETS_ROOT,
    relative: "",
  };
}

type PickerRegistry = Pick<AssetRegistry, "createAsset" | "list" | "listRoots">;

/**
 * Creates an asset for a picker's Create New row: unique name, owning-document
 * folder, and Class lineage from the project. Returns the indexed asset.
 */
export async function createPickerAsset(options: {
  registry: PickerRegistry;
  ownerPath: string | null | undefined;
  openDocuments: ReadonlyArray<{
    ref: { kind: string; path: string };
    content: unknown;
  }>;
  type: CreatableAssetType;
  name?: string;
  parentClass?: string | null;
  materialDomain?: MaterialDomain;
}): Promise<IndexedAsset> {
  const { registry, type } = options;
  const assets = registry.list();
  const folder = pickerCreateFolder(options.ownerPath, registry.listRoots());
  const classIds =
    type === "Class"
      ? assets
          .filter(
            (asset) =>
              asset.header.type === "Class" || asset.header.type === "Graph",
          )
          .map((asset) => classIdFromClassAsset(asset))
      : undefined;
  const name = uniqueNewAssetName({
    type,
    preferred: options.name,
    folderPath: folder.folderPath,
    existingPaths: assets.map((asset) => asset.path),
    classIds,
  });
  return createProjectAsset({
    registry,
    rootId: folder.rootId,
    folderRelative: folder.relative,
    type,
    name,
    parentClass: options.parentClass,
    materialDomain: options.materialDomain,
    classParentOf: classParentLookup(assets),
    parentGraphs:
      type === "Class"
        ? collectClassGraphsForPalette({
            assets,
            openDocuments: options.openDocuments,
            classIdForPath: classIdForGraphPath,
          })
        : undefined,
  });
}
