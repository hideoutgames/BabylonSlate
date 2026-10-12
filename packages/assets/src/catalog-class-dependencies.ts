import { classIdForAssetPath, isBuiltinBehaviourTreeClassId } from "@babylonslate/core";
import { isLockedEngineClassId } from "@babylonslate/object-model";
import type { BabassetHeader } from "./babasset";

export interface AssetClassCatalogEntry {
  path: string;
  header: BabassetHeader;
}

/** Class alias (guid, path-derived id or authored `classId`) -> guids of the Class assets answering to it. */
export type ClassAliasIndex = ReadonlyMap<string, ReadonlySet<string>>;

export function buildClassAliasIndex(assets: Iterable<AssetClassCatalogEntry>): ClassAliasIndex {
  const classes = new Map<string, Set<string>>();
  for (const asset of assets) {
    if (asset.header.type !== "Class") continue;
    const classId = classIdForAssetPath(asset.path);
    for (const alias of [asset.header.guid, classId, asset.header.payload.classId]) {
      if (typeof alias !== "string" || !alias) continue;
      const matches = classes.get(alias) ?? new Set<string>();
      matches.add(asset.header.guid);
      classes.set(alias, matches);
    }
  }
  return classes;
}

/** Resolve symbolic authored class IDs from catalog headers without opening documents. */
export function resolveAssetCatalogDependencies(
  header: BabassetHeader,
  assets: readonly AssetClassCatalogEntry[],
  required = false,
): string[] {
  return resolveDependenciesWithClassAliases(header, () => buildClassAliasIndex(assets), required);
}

/** As `resolveAssetCatalogDependencies`, with the alias index supplied (and built only when the header needs it). */
export function resolveDependenciesWithClassAliases(
  header: BabassetHeader,
  aliases: () => ClassAliasIndex,
  required = false,
): string[] {
  const dependencies = new Set(required ? header.requiredDependencies : header.dependencies);
  const references = required ? header.requiredClassReferences : header.classReferences;
  if (!references?.length) return [...dependencies].sort();
  const classes = aliases();
  for (const classId of references) {
    if (isLockedEngineClassId(classId) || classId.startsWith("engine:")
      || (header.type === "BehaviourTree" && isBuiltinBehaviourTreeClassId(classId))) continue;
    if (/^scene:/i.test(classId)) { dependencies.add(classId.slice(6)); continue; }
    const matches = classes.get(classId);
    if (!matches?.size) {
      if (required) throw new Error(`Asset ${header.guid} requires missing Class ${classId}; restore the Class asset or update its reference`);
      continue;
    }
    if (required && matches.size > 1) throw new Error(`Asset ${header.guid} requires ambiguous Class ${classId}; give its Class assets distinct names`);
    for (const guid of matches) dependencies.add(guid);
  }
  return [...dependencies].sort();
}
