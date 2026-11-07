/**
 * Header `dependencies[]` and typed reference collection for asset payloads,
 * and the dependency map that adds already-loaded edits of open documents.
 * `content-browser-helpers.ts` re-exports the names its importers use.
 */
import {
  collectAssetDependencyMetadata,
  resolveAssetCatalogDependencies,
  type AssetDependencyMetadata,
  type IndexedAsset,
} from "@haptic/assets";
import {
  materialDependencies,
  materialInstanceDependencies,
  normalizeMaterialDocument,
  normalizeMaterialFunctionDocument,
  normalizeMaterialInstanceDocument,
} from "@haptic/shader-graph";
import { defaultNodeRegistry } from "../services/graph-validation";
import { classIdFromClassAsset, type ClassAssetRef } from "./class-asset-lookup";

/**
 * Textures, called functions and the preview mesh a material references.
 * Saving writes these into `header.dependencies[]` so Show References, delete
 * guards and the export closure all see them.
 */
export function materialAssetDependencies(
  assetType: string,
  payload: Record<string, unknown>,
): string[] {
  if (assetType === "Material") {
    return materialDependencies(normalizeMaterialDocument(payload)).all;
  }
  if (assetType === "MaterialFunction") {
    return materialDependencies(normalizeMaterialFunctionDocument(payload)).all;
  }
  if (assetType === "MaterialInstance") {
    return materialInstanceDependencies(normalizeMaterialInstanceDocument(payload)).all;
  }
  return [];
}

/** Shared typed reference collection, using only catalog schemas and this document. */
export function assetHeaderDependencyMetadata(
  assetType: string,
  payload: Record<string, unknown>,
  classes: readonly ClassAssetRef[] = [],
  parentClass?: string | null,
): AssetDependencyMetadata {
  const definitions = new Map(classes.flatMap(asset => {
    const fields = asset.header.payload?.fields;
    return asset.header.guid && Array.isArray(fields) ? [[asset.header.guid, fields] as const] : [];
  }));
  return collectAssetDependencyMetadata(assetType, payload, {
    parentClass,
    classes: classes.flatMap(asset => asset.header.guid && asset.header.type === "Class" ? [{
      guid: asset.header.guid,
      classId: classIdFromClassAsset(asset),
      parentClassId: asset.header.parentClass,
      requiredVariableNames: asset.header.requiredVariableNames,
      // Saved Class headers carry `classHeaderMeta` variables, not graph members.
      members: (asset.header.payload?.members ?? (Array.isArray(asset.header.payload?.variables)
        ? asset.header.payload.variables.map(variable => ({ ...variable, kind: "variable" })) : [])) as import("@haptic/core").GraphClassMember[],
    }] : []),
    definitionFields: guid => definitions.get(guid),
    graphPins: (type, properties) => defaultNodeRegistry().get(typeof properties.__nodeType === "string" ? properties.__nodeType : type)?.pins(properties),
  });
}

/** Complete graph for references/export, including deferred gameplay selections. */
export function assetHeaderDependencies(
  assetType: string,
  payload: Record<string, unknown>,
  classes: readonly ClassAssetRef[] = [],
  parentClass?: string | null,
): string[] {
  return assetHeaderDependencyMetadata(assetType, payload, classes, parentClass).dependencies;
}

/** Saved dependencies plus already-loaded edits, without reading closed payloads. */
export function assetDependenciesIncludingOpenDocuments(
  assets: readonly IndexedAsset[],
  openDocuments: ReadonlyArray<{ ref: { path: string }; content: unknown }>,
): Map<string, string[]> {
  const result = new Map<string, string[]>();
  const documentsByPath = new Map(openDocuments.map((doc) => [doc.ref.path, doc]));
  for (const asset of assets) {
    const dependencies = new Set(resolveAssetCatalogDependencies(asset.header, assets));
    const open = documentsByPath.get(asset.path);
    if (open?.content && typeof open.content === "object") {
      for (const dependency of assetHeaderDependencies(
        asset.header.type,
        open.content as Record<string, unknown>,
        assets,
        asset.header.parentClass,
      )) dependencies.add(dependency);
    }
    result.set(asset.header.guid, [...dependencies].sort());
  }
  return result;
}
