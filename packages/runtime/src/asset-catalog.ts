import {
  assetFolderOfPath,
  isFolderWithin,
  normalizeAssetFolderPath,
  type RuntimeAssetCatalogEntry,
} from "@babylonslate/core";
import { ClassRegistry } from "@babylonslate/object-model";

/**
 * Runtime value of the `engine:AssetData` struct. Break/Make Structure read
 * and write these exact PascalCase keys.
 */
export interface AssetDataValue {
  Asset: string;
  Name: string;
  Path: string;
  Folder: string;
  Type: string;
  Class: string;
  ParentClass: string;
}

/** Runtime value of the `engine:AssetFilter` struct. Missing fields mean "no constraint". */
export interface AssetFilterValue {
  Folders?: readonly string[];
  Recursive?: boolean;
  Types?: readonly string[];
  Classes?: readonly string[];
  IncludeSubclasses?: boolean;
  NameContains?: string;
}

/** `ctx.assetRegistry`: the Asset Registry node queries. Every method is pure and never throws. */
export interface ScriptAssetRegistry {
  getAssetData(asset: string): AssetDataValue;
  hasAsset(asset: string): boolean;
  getAssetByPath(path: string): AssetDataValue;
  hasAssetPath(path: string): boolean;
  getAssetsByPath(folder: string, recursive: boolean): AssetDataValue[];
  getAssetsByType(type: string, folder: string, recursive: boolean): AssetDataValue[];
  getAssetsByClass(
    classId: string,
    includeSubclasses: boolean,
    folder: string,
    recursive: boolean,
  ): AssetDataValue[];
  findAssets(filter: AssetFilterValue): AssetDataValue[];
  getSubFolders(folder: string, recursive: boolean): string[];
  folderHasAssets(folder: string, recursive: boolean): boolean;
  getDependencies(asset: string, hardOnly: boolean): string[];
  getReferencers(asset: string, hardOnly: boolean): string[];
}

export interface RuntimeAssetCatalogOptions {
  /** Known folders that hold no asset (the editor registry's empty folders). */
  folders?: readonly string[];
}

/** What `Get Asset Data` reports for an asset the catalog does not hold. */
export function emptyAssetData(): AssetDataValue {
  return { Asset: "", Name: "", Path: "", Folder: "", Type: "", Class: "", ParentClass: "" };
}

function byPath(a: RuntimeAssetCatalogEntry, b: RuntimeAssetCatalogEntry): number {
  if (a.path !== b.path) return a.path < b.path ? -1 : 1;
  return a.guid < b.guid ? -1 : a.guid > b.guid ? 1 : 0;
}

/** Graph values are untyped at runtime; anything but a string reads as empty. */
function text(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function textList(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string") : [];
}

function isClassAsset(entry: RuntimeAssetCatalogEntry): boolean {
  return entry.type === "Class" || entry.type === "Graph";
}

let engineClasses: ClassRegistry | undefined;

/**
 * Pure query surface over the packaged asset list that the Asset Registry
 * nodes read. Results are sorted by Path and freshly allocated per call.
 */
export class RuntimeAssetCatalog implements ScriptAssetRegistry {
  private readonly entries: readonly RuntimeAssetCatalogEntry[];
  private readonly byGuid = new Map<string, RuntimeAssetCatalogEntry>();
  private readonly byAssetPath = new Map<string, RuntimeAssetCatalogEntry>();
  private readonly folderOf = new Map<RuntimeAssetCatalogEntry, string>();
  private readonly parentByClass = new Map<string, string | undefined>();
  private readonly ancestryByClass = new Map<string, readonly string[]>();
  private readonly allFolders: readonly string[];
  private referencersAll: Map<string, RuntimeAssetCatalogEntry[]> | undefined;
  private referencersHard: Map<string, RuntimeAssetCatalogEntry[]> | undefined;

  constructor(
    entries: readonly RuntimeAssetCatalogEntry[] = [],
    options: RuntimeAssetCatalogOptions = {},
  ) {
    this.entries = [...entries].sort(byPath);
    const folders = new Set<string>();
    const addFolder = (folder: string) => {
      for (let path = folder; path !== ""; path = assetFolderOfPath(path)) folders.add(path);
    };
    for (const entry of this.entries) {
      this.byGuid.set(entry.guid, entry);
      this.byAssetPath.set(normalizeAssetFolderPath(entry.path), entry);
      const folder = normalizeAssetFolderPath(assetFolderOfPath(entry.path));
      this.folderOf.set(entry, folder);
      addFolder(folder);
      if (isClassAsset(entry) && entry.classId) this.parentByClass.set(entry.classId, entry.parentClass);
    }
    for (const folder of options.folders ?? []) addFolder(normalizeAssetFolderPath(folder));
    this.allFolders = [...folders].sort();
  }

  getAssetData(asset: string): AssetDataValue {
    const entry = this.byGuid.get(asset);
    return entry ? this.dataOf(entry) : emptyAssetData();
  }

  hasAsset(asset: string): boolean {
    return this.byGuid.has(asset);
  }

  getAssetByPath(path: string): AssetDataValue {
    const entry = this.byAssetPath.get(normalizeAssetFolderPath(text(path)));
    return entry ? this.dataOf(entry) : emptyAssetData();
  }

  hasAssetPath(path: string): boolean {
    return this.byAssetPath.has(normalizeAssetFolderPath(text(path)));
  }

  getAssetsByPath(folder: string, recursive: boolean): AssetDataValue[] {
    return this.select({ folders: [folder], recursive });
  }

  getAssetsByType(type: string, folder: string, recursive: boolean): AssetDataValue[] {
    return this.select({ folders: [folder], recursive, types: [type] });
  }

  getAssetsByClass(
    classId: string,
    includeSubclasses: boolean,
    folder: string,
    recursive: boolean,
  ): AssetDataValue[] {
    return this.select({
      folders: [folder],
      recursive,
      classes: [classId],
      includeSubclasses,
    });
  }

  findAssets(filter: AssetFilterValue): AssetDataValue[] {
    const folders = textList(filter?.Folders).map(normalizeAssetFolderPath).filter((folder) => folder !== "");
    return this.select({
      // No folder constraint searches every root, however Recursive is set.
      folders: folders.length > 0 ? folders : [""],
      recursive: folders.length > 0 ? filter?.Recursive !== false : true,
      types: textList(filter?.Types).filter((type) => type !== ""),
      classes: textList(filter?.Classes).filter((classId) => classId !== ""),
      includeSubclasses: filter?.IncludeSubclasses !== false,
      nameContains: text(filter?.NameContains),
    });
  }

  getSubFolders(folder: string, recursive: boolean): string[] {
    const parent = normalizeAssetFolderPath(text(folder));
    return this.allFolders.filter((candidate) =>
      recursive
        ? candidate !== parent && isFolderWithin(candidate, parent)
        : assetFolderOfPath(candidate) === parent,
    );
  }

  folderHasAssets(folder: string, recursive: boolean): boolean {
    return this.select({ folders: [folder], recursive }).length > 0;
  }

  getDependencies(asset: string, hardOnly: boolean): string[] {
    const entry = this.byGuid.get(asset);
    if (!entry) return [];
    const guids = hardOnly ? entry.requiredDependencies : entry.dependencies;
    return [...new Set(guids)]
      .flatMap((guid) => {
        const target = this.byGuid.get(guid);
        return target && target !== entry ? [target] : [];
      })
      .sort(byPath)
      .map((target) => target.guid);
  }

  getReferencers(asset: string, hardOnly: boolean): string[] {
    const index = hardOnly ? (this.referencersHard ??= this.indexReferencers(true))
      : (this.referencersAll ??= this.indexReferencers(false));
    return (index.get(asset) ?? []).map((entry) => entry.guid);
  }

  private indexReferencers(hardOnly: boolean): Map<string, RuntimeAssetCatalogEntry[]> {
    const index = new Map<string, RuntimeAssetCatalogEntry[]>();
    // Entries are already in Path order, so every referencer list is too.
    for (const entry of this.entries) {
      for (const guid of new Set(hardOnly ? entry.requiredDependencies : entry.dependencies)) {
        if (guid === entry.guid || !this.byGuid.has(guid)) continue;
        const list = index.get(guid) ?? [];
        list.push(entry);
        index.set(guid, list);
      }
    }
    return index;
  }

  private dataOf(entry: RuntimeAssetCatalogEntry): AssetDataValue {
    const isClass = isClassAsset(entry);
    return {
      Asset: entry.guid,
      Name: entry.name,
      Path: entry.path,
      Folder: this.folderOf.get(entry) ?? "",
      Type: entry.type,
      Class: isClass ? entry.classId ?? "" : "",
      ParentClass: isClass ? entry.parentClass ?? "" : "",
    };
  }

  /** Class ids from `classId` up through project Classes and into the engine bases. */
  private ancestry(classId: string): readonly string[] {
    const cached = this.ancestryByClass.get(classId);
    if (cached) return cached;
    const chain: string[] = [];
    const seen = new Set<string>();
    let current: string | undefined = classId;
    while (current && !seen.has(current)) {
      seen.add(current);
      chain.push(current);
      if (this.parentByClass.has(current)) {
        current = this.parentByClass.get(current) ?? "BObject";
        continue;
      }
      engineClasses ??= new ClassRegistry();
      for (const id of engineClasses.ancestry(current).slice(1)) {
        if (seen.has(id)) break;
        seen.add(id);
        chain.push(id);
      }
      break;
    }
    this.ancestryByClass.set(classId, chain);
    return chain;
  }

  private select(query: {
    folders: readonly string[];
    recursive: boolean;
    types?: readonly string[];
    classes?: readonly string[];
    includeSubclasses?: boolean;
    nameContains?: string;
  }): AssetDataValue[] {
    const folders = query.folders.map((folder) => normalizeAssetFolderPath(text(folder)));
    const needle = query.nameContains?.toLowerCase() ?? "";
    const classes = query.classes ?? [];
    const types = query.types ?? [];
    const matches: AssetDataValue[] = [];
    for (const entry of this.entries) {
      const folder = this.folderOf.get(entry) ?? "";
      if (!folders.some((root) => (query.recursive ? isFolderWithin(folder, root) : folder === root))) continue;
      if (types.length > 0 && !types.includes(entry.type)) continue;
      if (classes.length > 0) {
        if (!isClassAsset(entry) || !entry.classId) continue;
        const own = entry.classId;
        const lineage = query.includeSubclasses === false ? [own] : this.ancestry(own);
        if (!classes.some((classId) => classId !== "" && lineage.includes(classId))) continue;
      }
      if (needle && !entry.name.toLowerCase().includes(needle)) continue;
      matches.push(this.dataOf(entry));
    }
    return matches;
  }
}

/** The empty catalog hosts without one use, so every query answers "nothing". */
export const EMPTY_ASSET_CATALOG = new RuntimeAssetCatalog();
