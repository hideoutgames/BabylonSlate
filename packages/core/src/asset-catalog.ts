import { ASSET_DOCUMENT_KINDS, assetTypeForDocumentKind } from "./document";

/**
 * One packaged authored asset as the NodeGraph Asset Registry sees it. Editor
 * Play, Preview Build, exported games and editor graph hosts all answer asset
 * queries from a list of these (docs/architecture/asset-registry.md).
 */
export interface RuntimeAssetCatalogEntry {
  guid: string;
  /** Header name. */
  name: string;
  /** Header type, for example `Texture`, `Class` or `Scene`. */
  type: string;
  /** Authored storage path, for example `assets/Weapons/Rifle.class.babasset`. */
  path: string;
  /** Class assets: the class id. */
  classId?: string;
  /** Class assets: the header parent class. */
  parentClass?: string;
  /** Every header reference (Soft and Hard). */
  dependencies: string[];
  /** Header references needed whenever the asset is acquired (Hard). */
  requiredDependencies: string[];
}

/**
 * Every asset header type an authored or imported asset can have, in document
 * kind order. `Find Assets` can only target types listed here.
 */
export const ASSET_TYPES: readonly string[] = [
  ...new Set(ASSET_DOCUMENT_KINDS.map(assetTypeForDocumentKind)),
];

/** Class id of a Class asset: its file stem with non-identifier characters replaced by `_`. */
export function classIdForAssetPath(path: string): string {
  const file = path.split("/").pop() ?? path;
  const stem = file
    .replace(/\.(graph|class)\.(babasset|json)$/, "")
    .replace(/\.babasset$/, "");
  const cleaned = stem.replace(/[^A-Za-z0-9_]+/g, "_");
  return cleaned.length > 0 ? cleaned : "Graph";
}
