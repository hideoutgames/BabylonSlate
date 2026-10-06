import { isBuiltinBehaviourTreeClassId } from "@babylonslate/core";
import { isLockedEngineClassId } from "@babylonslate/object-model";
import { getRequiredDependencies } from "./asset-dependencies";
import type { BabassetHeader } from "./babasset";

export interface AssetClassCatalogEntry {
  path: string;
  header: BabassetHeader;
}

/** Resolve symbolic authored class IDs from catalog headers without opening documents. */
export function resolveAssetCatalogDependencies(
  header: BabassetHeader,
  assets: readonly AssetClassCatalogEntry[],
  required = false,
): string[] {
  const dependencies = new Set(required ? getRequiredDependencies(header) : header.dependencies);
  const references = required ? header.requiredClassReferences : header.classReferences;
  if (!references?.length) return [...dependencies].sort();
  const classes = new Map<string, Set<string>>();
  for (const asset of assets) {
    if (asset.header.type !== "Class" && asset.header.type !== "Graph") continue;
    const file = asset.path.split("/").pop() ?? asset.header.name;
    const stem = file.replace(/\.(graph|class)\.(babasset|json)$/, "").replace(/\.babasset$/, "");
    const classId = stem.replace(/[^A-Za-z0-9_]+/g, "_") || "Graph";
    for (const alias of [asset.header.guid, classId, asset.header.payload.classId]) {
      if (typeof alias !== "string" || !alias) continue;
      const matches = classes.get(alias) ?? new Set<string>();
      matches.add(asset.header.guid);
      classes.set(alias, matches);
    }
  }
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
