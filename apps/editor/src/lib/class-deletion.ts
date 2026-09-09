import type { ClassAssetReference, ClassAssetReplacement, IndexedAsset } from "@babylonslate/assets";
import { walkAncestry } from "@babylonslate/editor-kit";
import { classIdFromClassAsset, classParentLookup } from "./content-browser-helpers";

export function classAssetReference(asset: IndexedAsset): ClassAssetReference {
  return { guid: asset.header.guid, classId: classIdFromClassAsset(asset) };
}

export function isClassAsset(asset: IndexedAsset): boolean {
  return asset.header.type === "Class" || asset.header.type === "Graph";
}

/** Retained Classes in the same engine lineage, excluding inheritance cycles. */
export function classDeletionCandidates(
  source: IndexedAsset,
  assets: readonly IndexedAsset[],
  deleting: ReadonlySet<string>,
): IndexedAsset[] {
  const classes = assets.filter(isClassAsset);
  const parentOf = classParentLookup(classes.map((asset) => ({ ...asset,
    header: { ...asset.header, type: "Class", parentClass: asset.header.parentClass ??
      (asset.header.type === "Graph" ? "Actor" : "BObject") },
  })));
  const projectIds = new Set(classes.map(classIdFromClassAsset));
  const deletedIds = new Set(classes.filter((asset) => deleting.has(asset.header.guid)).map(classIdFromClassAsset));
  const base = walkAncestry(classIdFromClassAsset(source), parentOf)
    .find((id) => !projectIds.has(id)) ?? "BObject";
  return classes.filter((asset) => {
    if (deleting.has(asset.header.guid)) return false;
    const ancestry = walkAncestry(classIdFromClassAsset(asset), parentOf);
    return ancestry.includes(base) && !ancestry.some((id) => deletedIds.has(id));
  });
}

export function validateClassDeletionReplacements(
  replacements: readonly ClassAssetReplacement[],
  assets: readonly IndexedAsset[],
  deleting: ReadonlySet<string>,
): void {
  const seen = new Set<string>();
  for (const entry of replacements) {
    const source = assets.find((asset) => asset.header.guid === entry.guid && isClassAsset(asset));
    if (!source || !deleting.has(entry.guid) || classIdFromClassAsset(source) !== entry.classId || seen.has(entry.guid)) {
      throw new Error("The Classes selected for deletion changed. Review the deletion again.");
    }
    seen.add(entry.guid);
    if (entry.replacement && !classDeletionCandidates(source, assets, deleting).some((asset) =>
      asset.header.guid === entry.replacement!.guid && classIdFromClassAsset(asset) === entry.replacement!.classId,
    )) throw new Error(`The replacement for ${source.header.name} is unavailable or incompatible.`);
  }
  if (assets.some((asset) => isClassAsset(asset) && deleting.has(asset.header.guid) && !seen.has(asset.header.guid))) {
    throw new Error("Every deleted Class needs a replacement choice, including None.");
  }
}
