/**
 * Header `dependencies[]` and typed reference collection for asset payloads,
 * and the dependency map that adds already-loaded edits of open documents.
 * `content-browser-helpers.ts` re-exports the public names.
 */
import {
  areaEmissionTextureGuids,
  assetVariableGuidsFromGraph,
  classIdsFromVariableMembers,
  normalizeRenderTargetTexturePayload,
  normalizeWaterDefinition,
  renderTargetAssetGuidsFromGraph,
} from "@haptic/core";
import {
  animationAssetGuids,
  audioAssetDependencies,
  collectAssetDependencyMetadata,
  dataAssetDependencies,
  dataGraphAssetDependencies,
  findClassAssetReferences,
  modelAssetGuids,
  parseSpriteAnimationPayload,
  particleAssetDependencies,
  resolveAssetCatalogDependencies,
  skeletonAssetGuids,
  skyboxCreatorAssetDependencies,
  spriteAnimationTextureGuids,
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

/** Header `dependencies[]` written on save for Show References, remap, and export. */
function legacyAssetHeaderDependencies(
  assetType: string,
  payload: Record<string, unknown>,
  classes: readonly ClassAssetRef[] = [],
  parentClass?: string | null,
): string[] {
  const schemasByGuid = new Map(classes.flatMap(asset => {
    const fields = asset.header.payload?.fields;
    return asset.header.guid && ["DataDefinition", "Structure"].includes(asset.header.type) && Array.isArray(fields)
      ? [[asset.header.guid, fields] as const] : [];
  }));
  const definitionFields = (guid: string) => schemasByGuid.get(guid);
  const classRefs = classes.flatMap((asset) =>
    asset.header.guid && asset.header.type === "Class"
      ? [{ guid: asset.header.guid, classId: classIdFromClassAsset(asset) }] : []);
  if (["DataDefinition", "DataTree", "Structure", "Enum"].includes(assetType)) {
    return dataAssetDependencies(assetType, payload, classRefs, definitionFields);
  }
  const unique = new Set<string>([
    ...(assetType === "Class" ? dataGraphAssetDependencies(payload, classRefs, definitionFields) : []),
    ...(assetType === "SaveGame" && Array.isArray(payload.fields) ? payload.fields.flatMap((field) => {
      if (!field || typeof field !== "object" || field.type !== "asset") return [];
      return (Array.isArray(field.defaultValue) ? field.defaultValue : [field.defaultValue]).filter((value: unknown): value is string => typeof value === "string" && !!value);
    }) : []),
    ...(assetType === "Class" ? assetVariableGuidsFromGraph(payload as unknown as import("@haptic/core").SerializedGraph) : []),
    ...(assetType === "Class" ? renderTargetAssetGuidsFromGraph(payload as unknown as import("@haptic/core").SerializedGraph) : []),
    ...areaEmissionTextureGuids(payload),
    ...findClassAssetReferences({ ...payload, parentClass }, classRefs, definitionFields),
    ...materialAssetDependencies(assetType, payload),
    ...audioAssetDependencies(assetType, payload),
    ...particleAssetDependencies(assetType, payload),
    ...(assetType === "Water" && normalizeWaterDefinition(payload).materialGuid ? [normalizeWaterDefinition(payload).materialGuid!] : []),
    ...(assetType === "RenderTargetTexture" && normalizeRenderTargetTexturePayload(payload).renderTargetGuid ? [normalizeRenderTargetTexturePayload(payload).renderTargetGuid!] : []),
    ...skyboxCreatorAssetDependencies(assetType, payload),
    ...(assetType === "SpriteAnimation"
      ? spriteAnimationTextureGuids(parseSpriteAnimationPayload(payload))
      : []),
    ...(assetType === "Model" ? modelAssetGuids(payload) : []),
    ...(assetType === "Skeleton" ? skeletonAssetGuids(payload) : []),
    ...(assetType === "Animation" ? animationAssetGuids(payload) : []),
  ]);
  if (assetType === "Scene") {
    const settings = payload.settings as Record<string, unknown> | undefined;
    const environment = settings?.environmentTextureGuid;
    if (typeof environment === "string" && environment.length > 0) unique.add(environment);
  }
  if (["Scene", "SceneLayer", "Class"].includes(assetType)) {
    const addClass = (classId: unknown) => {
      if (typeof classId !== "string" || !classId) return;
      const asset = classRefs.find((entry) => entry.classId === classId);
      if (asset) unique.add(asset.guid);
    };
    const addComponents = (components: unknown) => {
      if (!Array.isArray(components)) return;
      for (const component of components) {
        if (!component || typeof component !== "object") continue;
        addClass(component.classId);
        if (component.classId === "SceneStreamingComponent") {
          const guid = component.properties?.sceneGuid;
          if (typeof guid === "string" && guid.length > 0) unique.add(guid);
        } else if (component.classId === "RenderTargetCaptureComponent") {
          const guid = component.properties?.renderTargetGuid;
          if (typeof guid === "string" && guid) unique.add(guid);
        }
        if (component.classId !== "MeshComponent" && component.classId !== "CableComponent") continue;
        for (const key of ["materialGuid", "assetGuid"]) {
          const guid = component.properties?.[key];
          if (typeof guid === "string" && guid.length > 0) unique.add(guid);
        }
      }
    };
    if (assetType === "Scene" || assetType === "SceneLayer") {
      if (Array.isArray(payload.actors)) {
        for (const actor of payload.actors) {
          if (!actor || typeof actor !== "object") continue;
          addClass(actor.classId);
          addComponents(actor.components);
        }
      }
    } else {
      addClass(parentClass);
      addComponents(payload.components);
      if (Array.isArray(payload.members)) {
        for (const classId of classIdsFromVariableMembers(payload.members)) addClass(classId);
      }
    }
  }
  return [...unique].sort();
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
    dependencies: legacyAssetHeaderDependencies(assetType, payload, classes, parentClass),
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
    graphPins: (type, properties) => defaultNodeRegistry.get(typeof properties.__nodeType === "string" ? properties.__nodeType : type)?.pins(properties),
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
