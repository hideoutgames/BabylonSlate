import {
  DOCUMENT_CHUNK_ID,
  modelMaterialGuids,
  normalizeModelPayload,
  type AssetRegistry,
  type IndexedAsset,
  type ModelPayload,
} from "@babylonslate/assets";
import type { SerializedComponent, SerializedScene } from "@babylonslate/core";
import { engineParentOf } from "@babylonslate/editor-kit";
import type { AssetThumbnailRequest } from "@babylonslate/render";
import {
  materialDependencies,
  normalizeMaterialDocument,
  normalizeMaterialFunctionDocument,
  type MaterialDocument,
  type MaterialFunctionDocument,
} from "@babylonslate/shader-graph";
import { classIdForGraphPath } from "../services/script-compiler";
import { texturePixelSizesFromHeaders } from "./collect-gpu-texture-bytes";
import {
  materialAssetGuidsFromScene,
  modelAssetGuidsFromScene,
  overlayTextureGuidsFromScene,
  playSpritePayloadsFromGuids,
  spriteAssetGuidsFromScene,
} from "./play-content";
import {
  mergePrefabComponents,
  prefabComponentsFromGraph,
  previewSceneFor,
} from "./prefab-preview";

export interface AssetThumbnailInputOptions {
  asset: IndexedAsset;
  registry: Pick<AssetRegistry, "list" | "getByGuid">;
  readAssetChunk: (path: string, chunkId: string) => Promise<Uint8Array | null>;
  collectTextureBytes: (guids: readonly string[]) => Promise<Map<string, Uint8Array>>;
  shouldContinue?: () => boolean;
  pixelsPerUnit?: number;
}

function classAsset(asset: IndexedAsset): boolean {
  return asset.header.type === "Class" || asset.header.type === "Graph";
}

function parentClass(asset: IndexedAsset): string {
  return asset.header.parentClass ?? (asset.header.type === "Graph" ? "Actor" : "BObject");
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

/**
 * Saved, dependency-scoped capture input. No open document, gameplay graph,
 * or unrelated project payload is read while browsing an asset tile.
 */
export async function prepareAssetThumbnailInput(
  options: AssetThumbnailInputOptions,
): Promise<AssetThumbnailRequest | null> {
  const { asset, registry } = options;
  const current = options.shouldContinue ?? (() => true);
  if (!current()) return null;
  const readChunk = async (entry: IndexedAsset, id: string) =>
    current() ? options.readAssetChunk(entry.path, id) : null;
  const readDocument = async (entry: IndexedAsset) => {
    if (!current()) return null;
    if (!entry.header.chunks.some((chunk) => chunk.id === DOCUMENT_CHUNK_ID)) {
      return entry.header.payload;
    }
    const bytes = await readChunk(entry, DOCUMENT_CHUNK_ID);
    if (!current() || !bytes?.byteLength) return null;
    try {
      return asRecord(JSON.parse(new TextDecoder().decode(bytes)));
    } catch {
      return null;
    }
  };

  let prefab: SerializedScene | undefined;
  if (classAsset(asset)) {
    const byClass = new Map<string, IndexedAsset>();
    for (const entry of registry.list()) {
      if (!classAsset(entry)) continue;
      byClass.set(classIdForGraphPath(entry.path), entry);
      byClass.set(entry.header.name, entry);
    }
    const chain: IndexedAsset[] = [];
    const seen = new Set<string>([classIdForGraphPath(asset.path), asset.header.name]);
    let parent: string | null = parentClass(asset);
    let isActor = false;
    while (parent && !seen.has(parent)) {
      if (parent === "Actor") {
        isActor = true;
        break;
      }
      seen.add(parent);
      const entry = byClass.get(parent);
      if (entry) {
        chain.push(entry);
        parent = parentClass(entry);
      } else {
        parent = engineParentOf(parent) ?? null;
      }
    }
    if (!isActor) return null;
    const ancestors: Array<{ classId: string; components: SerializedComponent[] }> = [];
    for (const entry of chain.reverse()) {
      const content = await readDocument(entry);
      if (!current() || !content) return null;
      if (Array.isArray(content.components)) {
        ancestors.push({
          classId: classIdForGraphPath(entry.path),
          components: content.components as SerializedComponent[],
        });
      }
    }
    const content = await readDocument(asset);
    if (!current() || !content) return null;
    const local = Array.isArray(content.components)
      ? content.components as SerializedComponent[]
      : ancestors.some((entry) => entry.components.length > 0)
        ? []
        : prefabComponentsFromGraph(null);
    const components = mergePrefabComponents(ancestors, local);
    const spriteOnly = components.some((component) => component.classId === "SpriteComponent") &&
      !components.some((component) => ["MeshComponent", "Text3DComponent", "LandscapeComponent", "FoliageComponent", "CableComponent"].includes(component.classId));
    prefab = previewSceneFor(components, spriteOnly ? "2d" : "3d");
  } else if (asset.header.type !== "Material") {
    return null;
  }

  const materialGuids = new Set(prefab ? materialAssetGuidsFromScene(prefab) : [asset.header.guid]);
  const textureGuids = new Set(overlayTextureGuidsFromScene(prefab));
  const modelBytes = new Map<string, Uint8Array>();
  const modelPayloads = new Map<string, ModelPayload>();
  for (const guid of modelAssetGuidsFromScene(prefab)) {
    if (!current()) return null;
    const entry = registry.getByGuid(guid);
    if (!entry || entry.header.type !== "Model") return null;
    const content = await readDocument(entry);
    if (!current()) return null;
    const payload = normalizeModelPayload(content ?? entry.header.payload);
    // A static, tiny capture does not need to generate automatic model LODs.
    modelPayloads.set(guid, { ...payload, autoLod: false });
    for (const material of modelMaterialGuids(payload)) materialGuids.add(material);
    const source = entry.header.chunks.find((chunk) => chunk.id === "source" || chunk.kind === "source");
    if (!source) return null;
    const bytes = await readChunk(entry, source.id);
    if (!current() || !bytes?.byteLength) return null;
    modelBytes.set(guid, bytes);
  }

  const spriteDocuments = new Map<string, unknown>();
  for (const guid of spriteAssetGuidsFromScene(prefab)) {
    if (!current()) return null;
    const entry = registry.getByGuid(guid);
    if (entry?.header.type !== "Sprite") continue;
    const content = await readDocument(entry);
    if (!current()) return null;
    if (content) spriteDocuments.set(guid, content);
  }
  const spritePayloads = playSpritePayloadsFromGuids(
    [...spriteDocuments.keys()],
    (guid) => spriteDocuments.get(guid) ?? null,
  );
  for (const sprite of spritePayloads.values()) {
    if (sprite.textureGuid) textureGuids.add(sprite.textureGuid);
  }

  const materials = new Map<string, MaterialDocument>();
  const functions: Record<string, MaterialFunctionDocument> = {};
  const needed = [...materialGuids].map((guid) => ({ guid, type: "Material" }));
  const visited = new Set<string>();
  for (let index = 0; index < needed.length; index += 1) {
    if (!current()) return null;
    const { guid, type } = needed[index]!;
    if (visited.has(guid)) continue;
    visited.add(guid);
    const entry = registry.getByGuid(guid);
    if (!entry || entry.header.type !== type) continue;
    const content = await readDocument(entry);
    if (!current()) return null;
    if (!content) continue;
    const document = type === "Material"
      ? normalizeMaterialDocument(content)
      : normalizeMaterialFunctionDocument(content);
    if (type === "Material") materials.set(guid, document as MaterialDocument);
    else functions[guid] = document as MaterialFunctionDocument;
    const dependencies = materialDependencies(document);
    for (const texture of dependencies.textures) textureGuids.add(texture);
    for (const fn of dependencies.functions) needed.push({ guid: fn, type: "MaterialFunction" });
  }
  if (!prefab && !materials.has(asset.header.guid)) return null;
  if (!current()) return null;
  const textures = [...textureGuids];
  const textureBytes = textures.length > 0
    ? await options.collectTextureBytes(textures)
    : new Map<string, Uint8Array>();
  if (!current()) return null;
  const assets = {
    textureBytes,
    texturePixelSizes: texturePixelSizesFromHeaders(
      textures.flatMap((guid) => {
        const entry = registry.getByGuid(guid);
        return entry ? [entry] : [];
      }),
      textures,
    ),
    modelBytes,
    modelPayloads,
    spritePayloads,
    ...(options.pixelsPerUnit ? { pixelsPerUnit: options.pixelsPerUnit } : {}),
  };
  return prefab
    ? { kind: "ActorPrefab", prefab, materials, functions, assets }
    : { kind: "Material", materialGuid: asset.header.guid, materials, functions, assets };
}
