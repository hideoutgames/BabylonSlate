import { parseAnimGraphDocument } from "@babylonslate/anim-graph";
import {
  parseBehaviourTreeDocument,
  parseBlackboardDocument,
} from "@babylonslate/behaviour-tree";
import type { SpritePayload, TilemapPayload, TilesetPayload } from "@babylonslate/assets";
import {
  normalizeTilemapPayload,
  normalizeTilesetPayload,
} from "@babylonslate/assets";
import {
  isEditorOnlyAsset,
  type SerializedGraph,
  type SerializedScene,
} from "@babylonslate/core";
import {
  materialDependencies,
  normalizeMaterialDocument,
  normalizeMaterialFunctionDocument,
} from "@babylonslate/shader-graph";
import { normalizeUserInterfaceDocument, type UserInterfaceDocument } from "@babylonslate/ui-runtime";
import { NAVMESH_CHUNK_ID } from "@babylonslate/navigation";

export interface PlayContentDocument {
  id: string;
  ref: { kind: string; path: string };
  content: unknown;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object"
    ? (value as Record<string, unknown>)
    : {};
}

/** Hydrate a UserInterface document from an open asset payload. */
export function asUiDocument(value: unknown): UserInterfaceDocument {
  return normalizeUserInterfaceDocument(value);
}

function isSerializedGraph(value: unknown): value is SerializedGraph {
  if (!value || typeof value !== "object") return false;
  const record = value as { nodes?: unknown; edges?: unknown };
  return Array.isArray(record.nodes) && Array.isArray(record.edges);
}

/** Play compiles UserInterface `logic` the same way as Class graphs. */
export function logicGraphFromUiPayload(
  path: string,
  payload: unknown,
): { path: string; content: SerializedGraph } | null {
  const logic = asRecord(payload).logic;
  if (!isSerializedGraph(logic) || logic.nodes.length === 0) return null;
  return { path, content: logic };
}

export function mergePlayScriptDocuments(
  classGraphs: ReadonlyArray<{ path: string; content: SerializedGraph }>,
  uiAssets: ReadonlyArray<{ path: string; payload: unknown }>,
): Array<{ path: string; content: SerializedGraph }> {
  const extra = uiAssets.flatMap((asset) => {
    const graph = logicGraphFromUiPayload(asset.path, asset.payload);
    return graph ? [graph] : [];
  });
  return [...classGraphs, ...extra];
}

export function filterPlayScriptDocuments(
  graphs: ReadonlyArray<{ path: string; content: SerializedGraph }>,
  headers: Record<string, { type: string; parentClass?: string | null }>,
  parentOf: (id: string) => string | null | undefined,
): Array<{ path: string; content: SerializedGraph }> {
  return graphs.filter((graph) => {
    const header = headers[graph.path];
    if (!header) return true;
    return !isEditorOnlyAsset(header, parentOf);
  });
}

export function collectPlayScriptDocuments(
  classGraphs: ReadonlyArray<{ path: string; content: SerializedGraph }>,
  uiAssets: ReadonlyArray<{ path: string; payload: unknown }>,
  headers: Record<string, { type: string; parentClass?: string | null }>,
  parentOf: (id: string) => string | null | undefined,
): Array<{
  path: string;
  content: SerializedGraph;
  parentClassId?: string | null;
}> {
  return filterPlayScriptDocuments(
    mergePlayScriptDocuments(classGraphs, uiAssets),
    headers,
    parentOf,
  ).map((graph) => ({
    ...graph,
    parentClassId: headers[graph.path]?.parentClass ?? null,
  }));
}

export type PlayHudInstance = { instanceId: string; assetGuid: string };

export type PlayUiLibrary = Record<string, UserInterfaceDocument>;

export function playUiLibraryFromAssets(
  assets: ReadonlyArray<{ guid: string; path: string; type: string }>,
  contentByPath: (path: string) => unknown | null,
): PlayUiLibrary {
  const library: PlayUiLibrary = {};
  for (const asset of assets) {
    if (asset.type !== "UserInterface") continue;
    const content = contentByPath(asset.path);
    if (!content) continue;
    library[asset.guid] = asUiDocument(content);
  }
  return library;
}

export function applyPlayHudInstance(
  instances: readonly PlayHudInstance[],
  instanceId: string,
  assetGuid: string,
): PlayHudInstance[] {
  const id = instanceId.trim();
  const guid = assetGuid.trim();
  if (!id || !guid) return [...instances];
  if (instances.some((entry) => entry.instanceId === id)) return [...instances];
  return [...instances, { instanceId: id, assetGuid: guid }];
}

export function removePlayHudInstance(
  instances: readonly PlayHudInstance[],
  instanceId: string,
): PlayHudInstance[] {
  return instances.filter((entry) => entry.instanceId !== instanceId);
}

export function resolvePlayHudDocuments(
  instances: readonly PlayHudInstance[],
  library: PlayUiLibrary,
): Array<{ instanceId: string; document: UserInterfaceDocument }> {
  const resolved: Array<{ instanceId: string; document: UserInterfaceDocument }> =
    [];
  for (const entry of instances) {
    const document = library[entry.assetGuid];
    if (document) resolved.push({ instanceId: entry.instanceId, document });
  }
  return resolved;
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
): PlayAnimGraphEntry[] {
  const graphs: PlayAnimGraphEntry[] = [];
  for (const entry of documents) {
    if (entry.ref.kind !== "anim-graph" || !entry.content) continue;
    const parsed = parseAnimGraphDocument(entry.content);
    if (!parsed) continue;
    const guid = guidForPath(entry.ref.path) ?? entry.ref.path;
    graphs.push({ guid, document: parsed });
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

/** Tilemap asset guids referenced by scene TilemapComponents. */
export function tilemapAssetGuidsFromScene(
  scene: SerializedScene | null | undefined,
): string[] {
  return componentGuidsFromScene(scene, "TilemapComponent", ["assetGuid"]);
}

export function playAnimGraphsFromGuids(
  guids: readonly string[],
  documentForGuid: (guid: string) => unknown | null,
): PlayAnimGraphEntry[] {
  const graphs: PlayAnimGraphEntry[] = [];
  for (const guid of guids) {
    const content = documentForGuid(guid);
    if (!content) continue;
    const parsed = parseAnimGraphDocument(content);
    if (!parsed) continue;
    graphs.push({ guid, document: parsed });
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
    const guid = tilemap.tilesetGuid;
    if (!guid || seen.has(guid)) continue;
    seen.add(guid);
    guids.push(guid);
  }
  return guids;
}

/** Texture asset guids referenced by loaded sprite / tileset payloads. */
export function textureGuidsFromPlayPayloads(
  sprites: ReadonlyMap<string, SpritePayload> | undefined,
  tilesets: ReadonlyMap<string, TilesetPayload> | undefined,
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
  return guids;
}

/** Material asset guids referenced by scene MeshComponents. */
export function materialAssetGuidsFromScene(
  scene: SerializedScene | null | undefined,
): string[] {
  return componentGuidsFromScene(scene, "MeshComponent", ["materialGuid"]);
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

/** Scene `navmesh` extra chunk for Play import. Never generates. */
export async function readPlayNavmeshBytes(
  path: string | undefined,
  readChunk: (path: string, chunkId: string) => Promise<Uint8Array | null>,
): Promise<Uint8Array | null> {
  if (!path) return null;
  return readChunk(path, NAVMESH_CHUNK_ID);
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
