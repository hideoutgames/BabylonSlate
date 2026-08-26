import { parseAnimGraphDocument, resolveAnimGraphClips } from "@babylonslate/anim-graph";
import type { AnimClipCatalogEntry } from "@babylonslate/anim-graph";
import {
  parseBehaviourTreeDocument,
  parseBlackboardDocument,
  builtinClassId,
} from "@babylonslate/behaviour-tree";
import {
  modelMaterialGuids,
  normalizeAnimationPayload,
  parseSpriteAnimationPayload,
  retargetAnimationLoadsFromAnimations,
  spriteAnimationTextureGuids,
  type ModelPayload,
  type SpriteAnimationPayload,
  type SpritePayload,
  type TilemapPayload,
  type TilesetPayload,
} from "@babylonslate/assets";
import {
  AUDIO_REVERB_CHUNK_ID,
  normalizeTilemapPayload,
  normalizeTilesetPayload,
  tilemapTilesetGuids,
} from "@babylonslate/assets";
import {
  isEditorOnlyAsset,
  parseSkyboxFaces,
  sceneLayerToEditorScene,
  skyboxFaceGuids,
  type SerializedGraph,
  type SerializedScene,
  type SerializedSceneLayer,
} from "@babylonslate/core";
import {
  materialDependencies,
  normalizeMaterialDocument,
  normalizeMaterialFunctionDocument,
} from "@babylonslate/shader-graph";
import { NAVMESH_CHUNK_ID } from "@babylonslate/navigation";

export interface PlayContentDocument {
  id: string;
  ref: { kind: string; path: string };
  content: unknown;
}

export function filterPlayScriptDocuments<
  T extends { path: string; content: SerializedGraph },
>(
  graphs: ReadonlyArray<T>,
  headers: Record<string, { type: string; parentClass?: string | null }>,
  parentOf: (id: string) => string | null | undefined,
): T[] {
  return graphs.filter((graph) => {
    const header = headers[graph.path];
    if (!header) return true;
    return !isEditorOnlyAsset(header, parentOf);
  });
}

export function collectPlayScriptDocuments(
  classGraphs: ReadonlyArray<{ path: string; content: SerializedGraph }>,
  headers: Record<string, { type: string; parentClass?: string | null }>,
  parentOf: (id: string) => string | null | undefined,
): Array<{
  path: string;
  content: SerializedGraph;
  classId?: string;
  parentClassId?: string | null;
}> {
  return filterPlayScriptDocuments(classGraphs, headers, parentOf).map(
    (graph) => ({
      ...graph,
      parentClassId: headers[graph.path]?.parentClass ?? null,
    }),
  );
}

export type PlayAnimGraphEntry = { guid: string; document: unknown };
export type PlayBehaviourTreeEntry = { guid: string; document: unknown };
export type PlayBlackboardEntry = { guid: string; document: unknown };

/**
 * Open AnimationGraph documents for the worker `loadAnimGraphs` control.
 * `guidForPath` maps the asset path to the registry guid (graphGuid).
 */
export function playAnimGraphsFromOpenDocuments(
  documents: readonly PlayContentDocument[],
  guidForPath: (path: string) => string | null,
  catalog: readonly AnimClipCatalogEntry[] = [],
): PlayAnimGraphEntry[] {
  const graphs: PlayAnimGraphEntry[] = [];
  for (const entry of documents) {
    if (entry.ref.kind !== "anim-graph" || !entry.content) continue;
    const parsed = parseAnimGraphDocument(entry.content);
    if (!parsed) continue;
    const guid = guidForPath(entry.ref.path) ?? entry.ref.path;
    graphs.push({ guid, document: resolveAnimGraphClips(parsed, catalog) });
  }
  return graphs;
}

function stringGuid(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function componentGuidsFromScene(
  scene: SerializedScene | null | undefined,
  classId: string,
  keys: readonly string[],
): string[] {
  const found: string[] = [];
  const seen = new Set<string>();
  for (const actor of scene?.actors ?? []) {
    for (const component of actor.components) {
      if (component.classId !== classId) continue;
      for (const key of keys) {
        const guid = stringGuid(component.properties[key]);
        if (!guid || seen.has(guid)) continue;
        seen.add(guid);
        found.push(guid);
      }
    }
  }
  return found;
}

/** AnimationGraph guids referenced by scene components (not only open tabs). */
export function animationGraphGuidsFromScene(
  scene: SerializedScene | null | undefined,
): string[] {
  return componentGuidsFromScene(scene, "AnimationGraphComponent", [
    "graphGuid",
    "assetGuid",
  ]);
}

export function behaviourTreeGuidsFromScene(
  scene: SerializedScene | null | undefined,
): string[] {
  return componentGuidsFromScene(scene, "BehaviourTreeComponent", [
    "treeGuid",
    "assetGuid",
  ]);
}

export function blackboardGuidsFromScene(
  scene: SerializedScene | null | undefined,
): string[] {
  return componentGuidsFromScene(scene, "BehaviourTreeComponent", [
    "blackboardGuid",
  ]);
}

/** Sprite asset guids referenced by scene SpriteComponents. */
export function spriteAssetGuidsFromScene(
  scene: SerializedScene | null | undefined,
): string[] {
  return componentGuidsFromScene(scene, "SpriteComponent", ["assetGuid"]);
}

function pinDefaultFromNodeData(
  data: Record<string, unknown> | undefined,
  pinName: string,
): string | null {
  if (!data) return null;
  const properties =
    data.properties && typeof data.properties === "object"
      ? (data.properties as Record<string, unknown>)
      : data;
  const raw = properties[`default:${pinName}`] ?? properties[pinName];
  return typeof raw === "string" && raw.trim().length > 0 ? raw.trim() : null;
}

function serializedGraphNodes(
  graph: SerializedGraph,
): SerializedGraph["nodes"] {
  const nodes = [...graph.nodes];
  for (const nested of Object.values(graph.functionGraphs ?? {})) {
    nodes.push(...nested.nodes);
  }
  return nodes;
}

/** SceneLayer asset guids authored on world Scene Options. */
export function sceneLayerGuidsFromScenes(
  scenes: readonly (SerializedScene | null | undefined)[],
): string[] {
  const guids: string[] = [];
  const seen = new Set<string>();
  for (const scene of scenes) {
    for (const entry of scene?.settings.sceneLayers ?? []) {
      if (!entry.assetGuid || seen.has(entry.assetGuid)) continue;
      seen.add(entry.assetGuid);
      guids.push(entry.assetGuid);
    }
  }
  return guids;
}

/** SceneLayer asset guids on Create Scene Layer pin defaults. */
export function sceneLayerGuidsFromGraphs(
  graphs: readonly SerializedGraph[],
): string[] {
  const guids: string[] = [];
  const seen = new Set<string>();
  for (const graph of graphs) {
    for (const node of serializedGraphNodes(graph)) {
      if (node.type !== "scene-layer.create") continue;
      const guid = pinDefaultFromNodeData(node.data, "asset");
      if (!guid || seen.has(guid)) continue;
      seen.add(guid);
      guids.push(guid);
    }
  }
  return guids;
}

/** Post-process Material guids on SceneLayer Register/Unregister nodes. */
export function sceneLayerMaterialGuidsFromGraphs(
  graphs: readonly SerializedGraph[],
): string[] {
  const guids: string[] = [];
  const seen = new Set<string>();
  for (const graph of graphs) {
    for (const node of serializedGraphNodes(graph)) {
      if (
        node.type !== "scene-layer.registerPostProcess" &&
        node.type !== "scene-layer.unregisterPostProcess"
      ) {
        continue;
      }
      const guid = pinDefaultFromNodeData(node.data, "material");
      if (!guid || seen.has(guid)) continue;
      seen.add(guid);
      guids.push(guid);
    }
  }
  return guids;
}

export function overlayEditorScenesFromLayers(
  layers: ReadonlyArray<{ guid: string; layer: SerializedSceneLayer }>,
): SerializedScene[] {
  return layers.map((entry) => sceneLayerToEditorScene(entry.layer));
}

/** Texture guids on overlay 2DTexture components. */
export function overlayTextureGuidsFromScene(
  scene: SerializedScene | null | undefined,
): string[] {
  return componentGuidsFromScene(scene, "2DTextureComponent", ["textureGuid"]);
}

export function overlayTextureGuidsFromScenes(
  scenes: readonly (SerializedScene | null | undefined)[],
): string[] {
  const guids: string[] = [];
  const seen = new Set<string>();
  for (const scene of scenes) {
    for (const guid of overlayTextureGuidsFromScene(scene)) {
      if (seen.has(guid)) continue;
      seen.add(guid);
      guids.push(guid);
    }
  }
  return guids;
}

/** Tilemap asset guids referenced by scene TilemapComponents. */
export function tilemapAssetGuidsFromScene(
  scene: SerializedScene | null | undefined,
): string[] {
  return componentGuidsFromScene(scene, "TilemapComponent", ["assetGuid"]);
}

export function playAnimGraphsFromGuids(
  guids: readonly string[],
  documentForGuid: (guid: string) => unknown | null,
  catalog: readonly AnimClipCatalogEntry[] = [],
): PlayAnimGraphEntry[] {
  const graphs: PlayAnimGraphEntry[] = [];
  for (const guid of guids) {
    const content = documentForGuid(guid);
    if (!content) continue;
    const parsed = parseAnimGraphDocument(content);
    if (!parsed) continue;
    graphs.push({ guid, document: resolveAnimGraphClips(parsed, catalog) });
  }
  return graphs;
}

export function mergePlayAnimGraphs(
  ...groups: readonly PlayAnimGraphEntry[][]
): PlayAnimGraphEntry[] {
  const byGuid = new Map<string, PlayAnimGraphEntry>();
  for (const group of groups) {
    for (const entry of group) byGuid.set(entry.guid, entry);
  }
  return [...byGuid.values()];
}

/** Compile inputs for Animation Object + transition-rule scripts. */
export function collectAnimGraphCompileDocuments(
  entries: readonly PlayAnimGraphEntry[],
  pathForGuid: (guid: string) => string | null,
): Array<{ guid: string; path: string; document: unknown }> {
  return entries.map((entry) => ({
    guid: entry.guid,
    path: pathForGuid(entry.guid) ?? entry.guid,
    document: entry.document,
  }));
}

export function playBehaviourTreesFromOpenDocuments(
  documents: readonly PlayContentDocument[],
  guidForPath: (path: string) => string | null,
): PlayBehaviourTreeEntry[] {
  const trees: PlayBehaviourTreeEntry[] = [];
  for (const entry of documents) {
    if (entry.ref.kind !== "behaviour-tree" || !entry.content) continue;
    const parsed = parseBehaviourTreeDocument(entry.content);
    if (!parsed) continue;
    const guid = guidForPath(entry.ref.path) ?? entry.ref.path;
    trees.push({ guid, document: parsed });
  }
  return trees;
}

export function playBehaviourTreesFromGuids(
  guids: readonly string[],
  documentForGuid: (guid: string) => unknown | null,
): PlayBehaviourTreeEntry[] {
  const trees: PlayBehaviourTreeEntry[] = [];
  for (const guid of guids) {
    const content = documentForGuid(guid);
    if (!content) continue;
    const parsed = parseBehaviourTreeDocument(content);
    if (!parsed) continue;
    trees.push({ guid, document: parsed });
  }
  return trees;
}

export function mergePlayBehaviourTrees(
  ...groups: readonly PlayBehaviourTreeEntry[][]
): PlayBehaviourTreeEntry[] {
  const byGuid = new Map<string, PlayBehaviourTreeEntry>();
  for (const group of groups) {
    for (const entry of group) byGuid.set(entry.guid, entry);
  }
  return [...byGuid.values()];
}

export function playBlackboardsFromOpenDocuments(
  documents: readonly PlayContentDocument[],
  guidForPath: (path: string) => string | null,
): PlayBlackboardEntry[] {
  const boards: PlayBlackboardEntry[] = [];
  for (const entry of documents) {
    if (entry.ref.kind !== "blackboard" || !entry.content) continue;
    const parsed = parseBlackboardDocument(entry.content);
    if (!parsed) continue;
    const guid = guidForPath(entry.ref.path) ?? entry.ref.path;
    boards.push({ guid, document: parsed });
  }
  return boards;
}

export function playBlackboardsFromGuids(
  guids: readonly string[],
  documentForGuid: (guid: string) => unknown | null,
): PlayBlackboardEntry[] {
  const boards: PlayBlackboardEntry[] = [];
  for (const guid of guids) {
    const content = documentForGuid(guid);
    if (!content) continue;
    const parsed = parseBlackboardDocument(content);
    if (!parsed) continue;
    boards.push({ guid, document: parsed });
  }
  return boards;
}

export function mergePlayBlackboards(
  ...groups: readonly PlayBlackboardEntry[][]
): PlayBlackboardEntry[] {
  const byGuid = new Map<string, PlayBlackboardEntry>();
  for (const group of groups) {
    for (const entry of group) byGuid.set(entry.guid, entry);
  }
  return [...byGuid.values()];
}

function asSpritePayload(value: unknown): SpritePayload | null {
  if (!value || typeof value !== "object") return null;
  const record = value as { frames?: unknown; clips?: unknown };
  if (!Array.isArray(record.frames) || !Array.isArray(record.clips)) return null;
  return value as SpritePayload;
}

function asSpriteAnimationPayload(value: unknown): SpriteAnimationPayload | null {
  if (!value || typeof value !== "object") return null;
  const record = value as { frames?: unknown; clips?: unknown };
  if (!Array.isArray(record.frames) || Array.isArray(record.clips)) return null;
  return parseSpriteAnimationPayload(value);
}

export function playSpritePayloadsFromGuids(
  guids: readonly string[],
  payloadForGuid: (guid: string) => unknown | null,
): Map<string, SpritePayload> {
  const map = new Map<string, SpritePayload>();
  for (const guid of guids) {
    const payload = asSpritePayload(payloadForGuid(guid));
    if (payload) map.set(guid, payload);
  }
  return map;
}

export function playSpriteAnimationPayloadsFromGuids(
  guids: readonly string[],
  payloadForGuid: (guid: string) => unknown | null,
): Map<string, SpriteAnimationPayload> {
  const map = new Map<string, SpriteAnimationPayload>();
  for (const guid of guids) {
    const payload = asSpriteAnimationPayload(payloadForGuid(guid));
    if (payload) map.set(guid, payload);
  }
  return map;
}

/** Sprite Animation asset guids referenced by loaded Animation Graphs. */
export function spriteAnimationGuidsFromAnimGraphs(
  graphs: readonly PlayAnimGraphEntry[],
): string[] {
  const guids: string[] = [];
  const seen = new Set<string>();
  for (const entry of graphs) {
    const document = parseAnimGraphDocument(entry.document);
    if (!document) continue;
    for (const clip of document.clips) {
      if (clip.kind !== "sprite" || !clip.assetGuid || seen.has(clip.assetGuid)) {
        continue;
      }
      seen.add(clip.assetGuid);
      guids.push(clip.assetGuid);
    }
  }
  return guids;
}

/** Sprite Animation asset guids referenced by BT Play Animation tasks. */
export function spriteAnimationGuidsFromBehaviourTrees(
  trees: readonly PlayBehaviourTreeEntry[],
): string[] {
  const guids: string[] = [];
  const seen = new Set<string>();
  for (const entry of trees) {
    const document = parseBehaviourTreeDocument(entry.document);
    if (!document) continue;
    for (const node of document.nodes) {
      if (builtinClassId(node.classId) !== "bt.task.playAnimation") continue;
      if (node.properties.clipKind !== "sprite") continue;
      const guid =
        typeof node.properties.clipAssetGuid === "string"
          ? node.properties.clipAssetGuid.trim()
          : "";
      if (!guid || seen.has(guid)) continue;
      seen.add(guid);
      guids.push(guid);
    }
  }
  return guids;
}

export function playTilemapPayloadsFromGuids(
  guids: readonly string[],
  payloadForGuid: (guid: string) => unknown | null,
): Map<string, TilemapPayload> {
  const map = new Map<string, TilemapPayload>();
  for (const guid of guids) {
    const content = payloadForGuid(guid);
    if (!content) continue;
    map.set(guid, normalizeTilemapPayload(content));
  }
  return map;
}

export function tilesetGuidsFromTilemaps(
  tilemaps: ReadonlyMap<string, TilemapPayload>,
): string[] {
  const guids: string[] = [];
  const seen = new Set<string>();
  for (const tilemap of tilemaps.values()) {
    for (const guid of tilemapTilesetGuids(tilemap)) {
      if (seen.has(guid)) continue;
      seen.add(guid);
      guids.push(guid);
    }
  }
  return guids;
}

/** Texture asset guids referenced by loaded sprite / tileset payloads. */
export function textureGuidsFromPlayPayloads(
  sprites: ReadonlyMap<string, SpritePayload> | undefined,
  tilesets: ReadonlyMap<string, TilesetPayload> | undefined,
  spriteAnimations?: ReadonlyMap<string, SpriteAnimationPayload>,
): string[] {
  const guids: string[] = [];
  const seen = new Set<string>();
  const add = (guid: string | null | undefined) => {
    if (!guid || seen.has(guid)) return;
    seen.add(guid);
    guids.push(guid);
  };
  if (sprites) {
    for (const sprite of sprites.values()) add(sprite.textureGuid);
  }
  if (tilesets) {
    for (const tileset of tilesets.values()) add(tileset.textureGuid);
  }
  if (spriteAnimations) {
    for (const animation of spriteAnimations.values()) {
      for (const guid of spriteAnimationTextureGuids(animation)) add(guid);
    }
  }
  return guids;
}

/** Material asset guids referenced by scene MeshComponents and overlay 2DMaterial. */
export function materialAssetGuidsFromScene(
  scene: SerializedScene | null | undefined,
): string[] {
  const guids: string[] = [];
  const seen = new Set<string>();
  for (const guid of [
    ...componentGuidsFromScene(scene, "MeshComponent", ["materialGuid"]),
    ...componentGuidsFromScene(scene, "2DMaterialComponent", ["materialGuid"]),
  ]) {
    if (seen.has(guid)) continue;
    seen.add(guid);
    guids.push(guid);
  }
  return guids;
}

/** Post-process Material guids authored on the scene, in order. */
export function postProcessMaterialGuidsFromScene(
  scene: SerializedScene | null | undefined,
): string[] {
  return (scene?.settings.postProcessStack ?? []).map(
    (entry) => entry.materialGuid,
  );
}

/** Surface plus post-process Material guids from every Play library scene. */
export function materialGuidsFromScenes(
  scenes: readonly (SerializedScene | null | undefined)[],
): string[] {
  const guids: string[] = [];
  const seen = new Set<string>();
  for (const scene of scenes) {
    for (const guid of [
      ...materialAssetGuidsFromScene(scene),
      ...postProcessMaterialGuidsFromScene(scene),
    ]) {
      if (seen.has(guid)) continue;
      seen.add(guid);
      guids.push(guid);
    }
  }
  return guids;
}

/** Scene materials plus extra guids, de-duplicated. */
export function playMaterialGuidsFromSources(
  scenes: readonly (SerializedScene | null | undefined)[],
  extraGuids: readonly string[] = [],
): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  const add = (guid: string) => {
    if (!guid || seen.has(guid)) return;
    seen.add(guid);
    out.push(guid);
  };
  for (const guid of materialGuidsFromScenes(scenes)) add(guid);
  for (const guid of extraGuids) add(guid);
  return out;
}

/** Look up the scene document for an `activeScene` command. */
export function playSceneByGuid(
  guid: string,
  library: ReadonlyArray<{ guid: string; scene: SerializedScene }>,
  current?: { guid?: string; scene?: SerializedScene },
): SerializedScene | undefined {
  if (current?.guid === guid) return current.scene;
  return library.find((entry) => entry.guid === guid)?.scene;
}

/**
 * Materials plus every Material Function they call, transitively.
 * Play and export both need the closure, not just the directly referenced set.
 */
export function materialClosureFromGuids(
  guids: readonly string[],
  documentForGuid: (guid: string) => unknown | null,
): { materials: string[]; functions: string[]; textures: string[] } {
  const materials: string[] = [];
  const functions: string[] = [];
  const textures = new Set<string>();
  const seen = new Set<string>();

  const visitFunction = (guid: string) => {
    if (seen.has(guid)) return;
    seen.add(guid);
    const content = documentForGuid(guid);
    if (!content) return;
    functions.push(guid);
    const deps = materialDependencies(
      normalizeMaterialFunctionDocument(content),
    );
    for (const texture of deps.textures) textures.add(texture);
    for (const nested of deps.functions) visitFunction(nested);
  };

  for (const guid of guids) {
    if (seen.has(guid)) continue;
    seen.add(guid);
    const content = documentForGuid(guid);
    if (!content) continue;
    materials.push(guid);
    const deps = materialDependencies(normalizeMaterialDocument(content));
    for (const texture of deps.textures) textures.add(texture);
    for (const fn of deps.functions) visitFunction(fn);
  }
  return { materials, functions, textures: [...textures].sort() };
}

/** Model asset guids on MeshComponent.assetGuid (imported GLB). */
export function modelAssetGuidsFromScene(
  scene: SerializedScene | null | undefined,
): string[] {
  return componentGuidsFromScene(scene, "MeshComponent", ["assetGuid"]);
}

/** Scene Models plus source Models required to Play retargeted Animation rows. */
export function modelGuidsForPlayRetarget(
  sceneModelGuids: readonly string[],
  animations: ReadonlyArray<{ guid: string; payload: unknown }>,
): string[] {
  const guids = new Set(sceneModelGuids.filter((guid) => guid.length > 0));
  const loads = retargetAnimationLoadsFromAnimations(
    animations.map((entry) => ({
      guid: entry.guid,
      payload: normalizeAnimationPayload(entry.payload),
    })),
  );
  for (const [targetModelGuid, rows] of loads) {
    if (!guids.has(targetModelGuid)) continue;
    for (const row of rows) guids.add(row.sourceModelGuid);
  }
  return [...guids];
}

/** Slot Material guids Play must compile so Model overrides are not pink. */
export function modelSlotMaterialGuidsFromPayloads(
  payloads: ReadonlyMap<string, ModelPayload> | undefined,
): string[] {
  if (!payloads || payloads.size === 0) return [];
  const guids = new Set<string>();
  for (const payload of payloads.values()) {
    for (const guid of modelMaterialGuids(payload)) guids.add(guid);
  }
  return [...guids].sort();
}

/** Texture guids on SkyboxComponent faces. Engine default faces are not assets. */
export function skyboxFaceGuidsFromScene(
  scene: SerializedScene | null | undefined,
): string[] {
  const found: string[] = [];
  const seen = new Set<string>();
  for (const actor of scene?.actors ?? []) {
    for (const component of actor.components) {
      if (component.classId !== "SkyboxComponent") continue;
      for (const guid of skyboxFaceGuids(
        parseSkyboxFaces(component.properties.faces),
      )) {
        if (seen.has(guid)) continue;
        seen.add(guid);
        found.push(guid);
      }
    }
  }
  return found;
}

/** Scene `navmesh` extra chunk for Play import. Never generates. */
export async function readPlayNavmeshBytes(
  path: string | undefined,
  readChunk: (path: string, chunkId: string) => Promise<Uint8Array | null>,
): Promise<Uint8Array | null> {
  if (!path) return null;
  return readChunk(path, NAVMESH_CHUNK_ID);
}

/** Scene `audioReverb` extra chunk for Play import. Never generates. */
export async function readPlayAudioReverbBytes(
  path: string | undefined,
  readChunk: (path: string, chunkId: string) => Promise<Uint8Array | null>,
): Promise<Uint8Array | null> {
  if (!path) return null;
  return readChunk(path, AUDIO_REVERB_CHUNK_ID);
}

export function playTilesetPayloadsFromGuids(
  guids: readonly string[],
  payloadForGuid: (guid: string) => unknown | null,
): Map<string, TilesetPayload> {
  const map = new Map<string, TilesetPayload>();
  for (const guid of guids) {
    const content = payloadForGuid(guid);
    if (!content) continue;
    map.set(guid, normalizeTilesetPayload(content));
  }
  return map;
}

function guidDocuments<T>(
  payloads: ReadonlyMap<string, T> | undefined,
): Array<{ guid: string; document: unknown }> {
  if (!payloads) return [];
  return [...payloads.entries()].map(([guid, document]) => ({ guid, document }));
}

/** Worker `loadSprites` control, or null when Play has no sprite content. */
export function playLoadSpritesControl(
  sprites: ReadonlyMap<string, SpritePayload> | undefined,
  spriteAnimations: ReadonlyMap<string, SpriteAnimationPayload> | undefined,
  pixelsPerUnit?: number,
): {
  type: "loadSprites";
  sprites: Array<{ guid: string; document: unknown }>;
  spriteAnimations: Array<{ guid: string; document: unknown }>;
  pixelsPerUnit?: number;
} | null {
  if (
    (!sprites || sprites.size === 0) &&
    (!spriteAnimations || spriteAnimations.size === 0)
  ) {
    return null;
  }
  return {
    type: "loadSprites",
    sprites: guidDocuments(sprites),
    spriteAnimations: guidDocuments(spriteAnimations),
    ...(typeof pixelsPerUnit === "number" && pixelsPerUnit > 0
      ? { pixelsPerUnit }
      : {}),
  };
}

/** Worker `loadTilemaps` control, or null when Play has no tile content. */
export function playLoadTilemapsControl(
  tilemaps: ReadonlyMap<string, TilemapPayload> | undefined,
  tilesets: ReadonlyMap<string, TilesetPayload> | undefined,
  pixelsPerUnit?: number,
): {
  type: "loadTilemaps";
  tilemaps: Array<{ guid: string; document: unknown }>;
  tilesets: Array<{ guid: string; document: unknown }>;
  pixelsPerUnit?: number;
} | null {
  if ((!tilemaps || tilemaps.size === 0) && (!tilesets || tilesets.size === 0)) {
    return null;
  }
  return {
    type: "loadTilemaps",
    tilemaps: guidDocuments(tilemaps),
    tilesets: guidDocuments(tilesets),
    ...(typeof pixelsPerUnit === "number" && pixelsPerUnit > 0
      ? { pixelsPerUnit }
      : {}),
  };
}
