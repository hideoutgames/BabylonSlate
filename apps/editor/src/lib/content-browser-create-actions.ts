/**
 * Assets the Content Browser's Create actions build from a selection: Sprites
 * and Materials from Textures, a Tilemap from Tilesets, a Prefab or Actor
 * Class from Models (and Sprites or Particle Systems), a Particle System from
 * emitters, a Data Definition from a Structure and a Render Target Texture
 * from a Render Target. Each builder is pure; the menu writes the result.
 */
import {
  ATLAS_TEXTURES_META,
  PARTICLE_SYSTEM_MAX_EMITTERS,
  addTilemapTileset,
  createDefaultParticleSystemPayload,
  createDefaultSpritePayload,
  createDefaultTilemapPayload,
  type ImportResult,
  type TilesetPayload,
} from "@haptic/assets";
import {
  createDataDefinitionAsset,
  createDefaultRenderTargetTexturePayload,
  createMeshComponent,
  type DataDefinitionAsset,
  type DataDefinitionField,
  type SerializedComponent,
} from "@haptic/core";
import {
  createDefaultMaterialDocument,
  materialDependencies,
  type MaterialDocument,
  type MaterialGraphEdge,
  type MaterialGraphNode,
} from "@haptic/shader-graph";
import { defaultPropertiesFor } from "../panels/add-component-catalog";
import { assetHeaderDependencies } from "./asset-header-dependencies";
import { documentAsset } from "./new-asset-result";
import type { StructureAsset } from "@haptic/scripting";

type AssetRef = { guid: string; name: string };

/** A Sprite showing the whole Texture, with the default pivot and full collision box. */
export function buildSpriteAssetResult(textureGuid: string, guid: string, name: string): ImportResult {
  const result = documentAsset("Sprite", name, guid, { ...createDefaultSpritePayload(), textureGuid });
  return { ...result, payload: { ...result.payload, [ATLAS_TEXTURES_META]: [textureGuid] }, dependencies: [textureGuid] };
}

/** A Tilemap painting with `tilesets`, in order, at the first Tileset's tile size. */
export function buildTilemapAssetResult(
  tilesets: ReadonlyArray<{ guid: string; payload: TilesetPayload }>,
  guid: string,
  name: string,
): ImportResult {
  const known = new Map(tilesets.map((entry) => [entry.guid, entry.payload]));
  const first = tilesets[0]?.payload;
  let map = createDefaultTilemapPayload();
  if (first) map = { ...map, tileWidth: first.tileWidth, tileHeight: first.tileHeight };
  for (const entry of tilesets) map = addTilemapTileset(map, entry.guid, entry.payload, known);
  return {
    ...documentAsset("Tilemap", name, guid, map as unknown as Record<string, unknown>),
    dependencies: map.tilesets.map((ref) => ref.guid),
  };
}

/** Material inputs a Texture can feed; `ao` is recognised so it groups, but Materials have no occlusion input. */
export type MaterialTextureSlot = "baseColor" | "normal" | "roughness" | "metallic" | "emissive" | "ao";

const SLOT_SUFFIXES: ReadonlyArray<{ slot: MaterialTextureSlot; pattern: RegExp }> = [
  { slot: "normal", pattern: /[_\-. ](normal|norm|nrm|nor)$/i },
  { slot: "roughness", pattern: /[_\-. ](roughness|rough|rgh)$/i },
  { slot: "metallic", pattern: /[_\-. ](metallic|metalness|metal|mtl)$/i },
  { slot: "emissive", pattern: /[_\-. ](emissive|emission|emit)$/i },
  { slot: "ao", pattern: /[_\-. ](ambientocclusion|occlusion|ao)$/i },
  { slot: "baseColor", pattern: /[_\-. ](basecolor|base_color|albedo|diffuse|diff|color|col)$/i },
];

/** One Material's Textures: the shared name before the map suffix, and each slot's Texture. */
export interface MaterialTextureGroup {
  name: string;
  maps: Partial<Record<MaterialTextureSlot, string>>;
  /** The group's first Texture, which the Material is written beside. */
  firstGuid: string;
}

/**
 * Groups Textures by the name before a map suffix (`Rock_albedo`,
 * `Rock_normal` → `Rock`); a Texture without one is its group's Base Color.
 * The first Texture of each slot wins. Groups keep the order of `textures`.
 */
export function materialTextureGroups(textures: readonly AssetRef[]): MaterialTextureGroup[] {
  const groups = new Map<string, MaterialTextureGroup>();
  for (const texture of textures) {
    const match = SLOT_SUFFIXES.find((entry) => entry.pattern.test(texture.name));
    const name = match ? texture.name.replace(match.pattern, "") || texture.name : texture.name;
    const slot = match?.slot ?? "baseColor";
    const key = name.toLowerCase();
    const group = groups.get(key) ?? { name, maps: {}, firstGuid: texture.guid };
    groups.set(key, group);
    group.maps[slot] ??= texture.guid;
  }
  return [...groups.values()];
}

const SLOT_LABEL: Record<Exclude<MaterialTextureSlot, "ao">, string> = {
  baseColor: "Base Color",
  normal: "Normal",
  roughness: "Roughness",
  metallic: "Metallic",
  emissive: "Emissive",
};

/** The output pin and sample output each slot wires; Normal goes through a Normal Map node. */
const SLOT_WIRING: Record<Exclude<MaterialTextureSlot, "ao">, { output: string; sample: string }> = {
  baseColor: { output: "baseColor", sample: "rgb" },
  normal: { output: "normal", sample: "rgb" },
  roughness: { output: "roughness", sample: "r" },
  metallic: { output: "metallic", sample: "r" },
  emissive: { output: "emissive", sample: "rgb" },
};

/** A Surface Material sampling each group Texture into its input; without a Base Color map it keeps the default color. */
export function textureMaterialDocument(group: MaterialTextureGroup): MaterialDocument {
  const base = createDefaultMaterialDocument(group.name);
  const output = base.nodes.find((node) => node.type === "output.surface")!;
  const nodes: MaterialGraphNode[] = [{ ...output, position: { x: 980, y: 0 } }];
  const edges: MaterialGraphEdge[] = [];
  if (!group.maps.baseColor) {
    nodes.push(...base.nodes.filter((node) => node.id !== output.id));
    edges.push(...base.edges);
  }
  const slots = (Object.keys(SLOT_WIRING) as Array<keyof typeof SLOT_WIRING>).filter((slot) => group.maps[slot]);
  // Columns wide and rows tall enough that the Texture Sample nodes never overlap.
  if (slots.length > 0) nodes.push({ id: "uv", type: "input.uv", position: { x: 0, y: -160 }, properties: {} });
  slots.forEach((slot, index) => {
    const y = index * 320;
    const param = `${slot}-texture`;
    const sample = `${slot}-sample`;
    nodes.push(
      { id: param, type: "param.texture", position: { x: 0, y }, properties: { textureGuid: group.maps[slot], name: SLOT_LABEL[slot] } },
      { id: sample, type: "texture.sample", position: { x: 340, y }, properties: {} },
    );
    edges.push(
      { id: `e-${param}`, sourceNodeId: param, sourcePinId: "out", targetNodeId: sample, targetPinId: "texture" },
      { id: `e-${slot}-uv`, sourceNodeId: "uv", sourcePinId: "uv", targetNodeId: sample, targetPinId: "uv" },
    );
    const wiring = SLOT_WIRING[slot];
    if (slot === "normal") {
      nodes.push({ id: "normal-map", type: "shading.normalMap", position: { x: 680, y }, properties: {} });
      edges.push(
        { id: "e-normal-packed", sourceNodeId: sample, sourcePinId: wiring.sample, targetNodeId: "normal-map", targetPinId: "packed" },
        { id: "e-normal-map-uv", sourceNodeId: "uv", sourcePinId: "uv", targetNodeId: "normal-map", targetPinId: "uv" },
        { id: "e-normal-output", sourceNodeId: "normal-map", sourcePinId: "normal", targetNodeId: output.id, targetPinId: wiring.output },
      );
      return;
    }
    edges.push({ id: `e-${slot}-output`, sourceNodeId: sample, sourcePinId: wiring.sample, targetNodeId: output.id, targetPinId: wiring.output });
  });
  return { ...base, nodes, edges };
}

export function buildTextureMaterialAssetResult(group: MaterialTextureGroup, guid: string, name: string): ImportResult {
  const document = { ...textureMaterialDocument(group), name };
  return {
    ...documentAsset("Material", name, guid, document as unknown as Record<string, unknown>),
    dependencies: materialDependencies(document).all,
  };
}

/** Asset types Create Actor turns into components. */
export const ACTOR_SOURCE_TYPES: ReadonlySet<string> = new Set(["Model", "Sprite", "ParticleSystem"]);

/**
 * One component per asset, as placing it in a scene makes: a Mesh for a
 * Model, a Sprite for a Sprite, a Particle (playing on start) for a Particle
 * System. Other types are skipped. Ids are stable per kind and order.
 */
export function componentsForAssets(
  assets: ReadonlyArray<{ guid: string; type: string }>,
  idPrefix: string,
): SerializedComponent[] {
  const counts = new Map<string, number>();
  const nextId = (kind: string) => {
    const count = (counts.get(kind) ?? 0) + 1;
    counts.set(kind, count);
    return `${idPrefix}-${kind}-${count}`;
  };
  return assets.flatMap((asset): SerializedComponent[] => {
    if (asset.type === "Model") {
      const component = createMeshComponent(nextId("mesh"), "box");
      component.properties.assetGuid = asset.guid;
      return [component];
    }
    if (asset.type === "Sprite") {
      return [{ id: nextId("sprite"), classId: "SpriteComponent", properties: { ...defaultPropertiesFor("SpriteComponent"), assetGuid: asset.guid } }];
    }
    if (asset.type === "ParticleSystem") {
      return [{
        id: nextId("particle"),
        classId: "ParticleComponent",
        properties: { ...defaultPropertiesFor("ParticleComponent"), particleSystemGuid: asset.guid, playOnStart: true },
      }];
    }
    return [];
  });
}

/** A Prefab holding one Mesh component per Model, all at its origin. */
export function buildModelPrefabAssetResult(modelGuids: readonly string[], guid: string, name: string): ImportResult {
  const payload = { components: componentsForAssets(modelGuids.map((model) => ({ guid: model, type: "Model" })), "prefab") };
  const result = documentAsset("Prefab", name, guid, payload);
  return { ...result, dependencies: assetHeaderDependencies("Prefab", result.payload) };
}

/** A Particle System playing `emitterGuids` (Basic Particle Emitters and Particle Graphs), up to its limit. */
export function buildParticleSystemAssetResult(emitterGuids: readonly string[], guid: string, name: string): ImportResult {
  const payload = { ...createDefaultParticleSystemPayload(), emitterGuids: emitterGuids.slice(0, PARTICLE_SYSTEM_MAX_EMITTERS) };
  const result = documentAsset("ParticleSystem", name, guid, payload as unknown as Record<string, unknown>);
  return { ...result, dependencies: assetHeaderDependencies("ParticleSystem", result.payload) };
}

/** A Data Definition whose fields start as the Structure's; fields without an id get `field-N`. */
export function dataDefinitionFromStructure(structure: StructureAsset): DataDefinitionAsset {
  const used = new Set(structure.fields.flatMap((field) => (field.id ? [field.id] : [])));
  let next = 1;
  const fields = structure.fields.map((field): DataDefinitionField => {
    if (field.id) return { ...field, id: field.id };
    while (used.has(`field-${next}`)) next += 1;
    const id = `field-${next}`;
    used.add(id);
    return { ...field, id };
  });
  return createDataDefinitionAsset(fields);
}

/** A Render Target Texture bound to `renderTargetGuid`. */
export function buildRenderTargetTextureAssetResult(renderTargetGuid: string, guid: string, name: string): ImportResult {
  const payload = { ...createDefaultRenderTargetTexturePayload(), renderTargetGuid };
  return {
    ...documentAsset("RenderTargetTexture", name, guid, payload as unknown as Record<string, unknown>),
    dependencies: [renderTargetGuid],
  };
}
