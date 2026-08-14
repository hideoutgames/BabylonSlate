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
import type { SerializedGraph, SerializedScene } from "@babylonslate/core";
import type { UserInterfaceDocument, WidgetNode } from "@babylonslate/ui-runtime";
import {
  migrateUserInterfacePayload,
  normalizeLayout,
  isBabylonWidgetLayout,
} from "@babylonslate/ui-runtime";

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

function sizeFrom(value: unknown): { width: number; height: number } | null {
  if (!value || typeof value !== "object") return null;
  const record = value as { width?: unknown; height?: unknown };
  const width = record.width;
  const height = record.height;
  if (typeof width !== "number" || !Number.isFinite(width)) return null;
  if (typeof height !== "number" || !Number.isFinite(height)) return null;
  return { width: Math.max(1, width), height: Math.max(1, height) };
}

/** Hydrate a UserInterface document from an open asset payload. */
export function asUiDocument(value: unknown): UserInterfaceDocument {
  const record = migrateUserInterfacePayload(asRecord(value));
  const designResolution =
    sizeFrom(record.designResolution) ?? { width: 1920, height: 1080 };
  return {
    name: typeof record.name === "string" ? record.name : "HUD",
    rootId: typeof record.rootId === "string" ? record.rootId : "canvas",
    designResolution,
    desiredSize:
      sizeFrom(record.desiredSize) ?? { ...designResolution },
    scaleRule:
      record.scaleRule === "fitWidth" || record.scaleRule === "fitHeight"
        ? record.scaleRule
        : "shortestSide",
    viewportLayer: record.viewportLayer !== false,
    widgets: asUiWidgets(asRecord(record.widgets)),
  };
}

function asUiWidgets(
  widgets: Record<string, unknown>,
): UserInterfaceDocument["widgets"] {
  const next: UserInterfaceDocument["widgets"] = {};
  for (const [id, widget] of Object.entries(widgets)) {
    if (!widget || typeof widget !== "object") continue;
    const record = widget as WidgetNode;
    const layout = isBabylonWidgetLayout(record.layout)
      ? normalizeLayout(record.layout)
      : record.layout;
    next[id] = { ...record, id: typeof record.id === "string" ? record.id : id, layout };
  }
  return next;
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

/** Model asset guids on MeshComponent.assetGuid (imported GLB). */
export function modelAssetGuidsFromScene(
  scene: SerializedScene | null | undefined,
): string[] {
  return componentGuidsFromScene(scene, "MeshComponent", ["assetGuid"]);
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
