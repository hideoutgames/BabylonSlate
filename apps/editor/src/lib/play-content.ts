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
import type {
  CommandMessage,
  UiWidgetEventControl,
  UserInterfaceRuntimeDocument,
} from "@babylonslate/bridge";
import {
  isEditorOnlyAsset,
  parseSkyboxFaces,
  skyboxFaceGuids,
  userInterfaceClassId,
  userInterfaceClassMetadata,
  type SerializedGraph,
  type SerializedScene,
} from "@babylonslate/core";
import {
  materialDependencies,
  normalizeMaterialDocument,
  normalizeMaterialFunctionDocument,
} from "@babylonslate/shader-graph";
import {
  applyUiTreeAddWidget,
  applyUiTreePatchLayout,
  applyUiTreeRemoveWidget,
  applyUiTreeReparentWidget,
  cloneUserInterfaceDocument,
  normalizeUserInterfaceDocument,
  widgetRuntimeMeta,
  type UserInterfaceDocument,
  type WidgetLayoutPatch,
  collectMaterialGuidsFromUiDocuments,
} from "@babylonslate/ui-runtime";
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

/** True when a payload has a widget tree — not `{}` or dockKind-only. */
export function isUsableUiDocumentPayload(value: unknown): boolean {
  if (!value || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  if (typeof record.rootId === "string" && record.rootId.length > 0) return true;
  return record.widgets !== null && typeof record.widgets === "object";
}

export type PlayUiLibrary = Record<string, UserInterfaceDocument>;

export type NestedUiAssetRef = {
  path: string;
  header: { payload?: unknown };
};

export type ResolveNestedUiDocumentOptions = {
  selfGuid?: string | null;
  selfDocument?: UserInterfaceDocument | null;
  openDocuments?: ReadonlyArray<{ ref: { path: string }; content: unknown }>;
  getAsset?: (guid: string) => NestedUiAssetRef | null | undefined;
  uiLibrary?: PlayUiLibrary;
};

/**
 * Nested UserInterface documents: open content, then the loaded library,
 * then a usable header payload. Empty `{}` / dockKind-only headers are ignored.
 */
export function resolveNestedUiDocument(
  guid: string,
  options: ResolveNestedUiDocumentOptions,
): UserInterfaceDocument | null {
  if (!guid) return null;
  if (options.selfGuid && guid === options.selfGuid) {
    return options.selfDocument ?? null;
  }
  const asset = options.getAsset?.(guid) ?? null;
  const open = asset
    ? options.openDocuments?.find((entry) => entry.ref.path === asset.path)
    : undefined;
  if (isUsableUiDocumentPayload(open?.content)) {
    return asUiDocument(open!.content);
  }
  const fromLibrary = options.uiLibrary?.[guid];
  if (fromLibrary) return fromLibrary;
  if (asset && isUsableUiDocumentPayload(asset.header.payload)) {
    return asUiDocument(asset.header.payload);
  }
  return null;
}

function isSerializedGraph(value: unknown): value is SerializedGraph {
  if (!value || typeof value !== "object") return false;
  const record = value as { nodes?: unknown; edges?: unknown };
  return Array.isArray(record.nodes) && Array.isArray(record.edges);
}

export type UiScriptCompileDocument = {
  path: string;
  content: SerializedGraph;
  classId?: string;
  parentClassId?: string | null;
};

/** Play compiles UserInterface `logic` the same way as Class graphs. */
export function logicGraphFromUiPayload(
  path: string,
  payload: unknown,
  guid?: string,
): UiScriptCompileDocument | null {
  const logic = asRecord(payload).logic;
  if (!isSerializedGraph(logic) || logic.nodes.length === 0) return null;
  if (!guid?.trim()) return { path, content: logic };
  const metadata = userInterfaceClassMetadata(guid.trim());
  return {
    path,
    content: logic,
    classId: metadata.classId,
    parentClassId: metadata.parentClassId,
  };
}

export function mergePlayScriptDocuments(
  classGraphs: ReadonlyArray<{ path: string; content: SerializedGraph }>,
  uiAssets: ReadonlyArray<{ path: string; payload: unknown; guid?: string }>,
): Array<UiScriptCompileDocument> {
  const extra = uiAssets.flatMap((asset) => {
    const graph = logicGraphFromUiPayload(asset.path, asset.payload, asset.guid);
    return graph ? [graph] : [];
  });
  return [...classGraphs, ...extra];
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
  uiAssets: ReadonlyArray<{ path: string; payload: unknown; guid?: string }>,
  headers: Record<string, { type: string; parentClass?: string | null }>,
  parentOf: (id: string) => string | null | undefined,
): Array<{
  path: string;
  content: SerializedGraph;
  classId?: string;
  parentClassId?: string | null;
}> {
  return filterPlayScriptDocuments(
    mergePlayScriptDocuments(classGraphs, uiAssets),
    headers,
    parentOf,
  ).map((graph) => ({
    ...graph,
    parentClassId:
      graph.parentClassId ?? headers[graph.path]?.parentClass ?? null,
  }));
}

export type PlayHudInstance = {
  instanceId: string;
  assetGuid: string;
  classId: string;
  document?: UserInterfaceDocument;
};

/** Open in-memory UserInterface payloads win over disk bytes. */
export function preferOpenPlayUiContent(
  open: unknown | null | undefined,
  disk: unknown | null | undefined,
): unknown | null {
  if (open != null) return open;
  return disk ?? null;
}

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

/** Slim widget rows for `loadUserInterfaces`. Does not apply a HUD. */
export function playUserInterfaceRuntimeDocuments(
  library: PlayUiLibrary,
): UserInterfaceRuntimeDocument[] {
  return Object.entries(library).map(([guid, document]) => ({
    guid,
    widgets: Object.values(document.widgets).map(widgetRuntimeMeta),
    document,
  }));
}

export function playHudVisibilityKey(instanceId: string, widgetId: string): string {
  return `${instanceId}:${widgetId}`;
}

export function applyPlayHudVisibility(
  hidden: ReadonlySet<string>,
  instanceId: string,
  widgetId: string,
  visible: boolean,
): Set<string> {
  const next = new Set(hidden);
  const key = playHudVisibilityKey(instanceId, widgetId);
  if (visible) next.delete(key);
  else next.add(key);
  return next;
}

/** Split `instanceId:widgetId`, keeping nested `/` widget ids after the first colon. */
export function parsePlayHudControlId(
  prefixedId: string,
): { instanceId: string; widgetId: string } | null {
  const colon = prefixedId.indexOf(":");
  if (colon <= 0 || colon === prefixedId.length - 1) return null;
  return {
    instanceId: prefixedId.slice(0, colon),
    widgetId: prefixedId.slice(colon + 1),
  };
}

export type PlayUiWidgetEvent = Omit<UiWidgetEventControl, "type">;

let playUiWidgetEventSink: ((event: PlayUiWidgetEvent) => boolean) | null = null;

/** Register the live Play session dispatcher for HUD and test-host events. */
export function setPlayUiWidgetEventSink(
  sink: ((event: PlayUiWidgetEvent) => boolean) | null,
): void {
  playUiWidgetEventSink = sink;
}

/** Forward a widget event to the mounted Play session, if any. */
export function dispatchMountedPlayUiWidgetEvent(
  event: PlayUiWidgetEvent,
): boolean {
  return playUiWidgetEventSink?.(event) ?? false;
}

export function applyPlayHudInstance(
  instances: readonly PlayHudInstance[],
  instanceId: string,
  assetGuid: string,
  classId?: string,
): PlayHudInstance[] {
  const id = instanceId.trim();
  const guid = assetGuid.trim();
  if (!id || !guid) return [...instances];
  if (instances.some((entry) => entry.instanceId === id)) return [...instances];
  const resolvedClassId = classId?.trim() || userInterfaceClassId(guid);
  return [...instances, { instanceId: id, assetGuid: guid, classId: resolvedClassId }];
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
    const document = entry.document ?? library[entry.assetGuid];
    if (document) resolved.push({ instanceId: entry.instanceId, document });
  }
  return resolved;
}

function seedHudDocument(
  instance: PlayHudInstance,
  library: PlayUiLibrary,
): UserInterfaceDocument | undefined {
  if (instance.document) return instance.document;
  const seed = library[instance.assetGuid];
  return seed ? cloneUserInterfaceDocument(seed) : undefined;
}

function replaceHudInstance(
  instances: readonly PlayHudInstance[],
  instanceId: string,
  next: PlayHudInstance,
): PlayHudInstance[] {
  return instances.map((entry) =>
    entry.instanceId === instanceId ? next : entry,
  );
}

/** Clone the library tree onto a Play HUD instance and apply hierarchy commands. */
export function applyPlayHudUiCommand(
  instances: readonly PlayHudInstance[],
  library: PlayUiLibrary,
  command: CommandMessage,
): PlayHudInstance[] {
  if (command.type === "uiApply") {
    const next = applyPlayHudInstance(
      instances,
      command.instanceId,
      command.assetGuid,
      command.classId,
    );
    return next.map((entry) => {
      if (entry.instanceId !== command.instanceId || entry.document) return entry;
      const document = seedHudDocument(entry, library);
      return document ? { ...entry, document } : entry;
    });
  }
  const current = instances.find((entry) => entry.instanceId === command.instanceId);
  if (!current) return [...instances];
  const seed = seedHudDocument(current, library);
  if (!seed) return [...instances];
  if (command.type === "uiAddWidget") {
    return replaceHudInstance(instances, current.instanceId, {
      ...current,
      document: applyUiTreeAddWidget(seed, {
        widgetId: command.widgetId,
        kind: command.kind,
        name: command.name,
        parentId: command.parentId,
      }),
    });
  }
  if (command.type === "uiRemoveWidget") {
    return replaceHudInstance(instances, current.instanceId, {
      ...current,
      document: applyUiTreeRemoveWidget(seed, command.widgetId),
    });
  }
  if (command.type === "uiReparentWidget") {
    return replaceHudInstance(instances, current.instanceId, {
      ...current,
      document: applyUiTreeReparentWidget(seed, {
        widgetId: command.widgetId,
        parentId: command.parentId,
        siblingIndex: command.siblingIndex,
      }),
    });
  }
  if (command.type === "uiPatchLayout") {
    return replaceHudInstance(instances, current.instanceId, {
      ...current,
      document: applyUiTreePatchLayout(
        seed,
        command.widgetId,
        command.layout as WidgetLayoutPatch,
      ),
    });
  }
  return [...instances];
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

/** Interface Material guids referenced by HUD Material widgets. */
export function interfaceMaterialGuidsFromUiDocuments(
  documents: Iterable<UserInterfaceDocument>,
  resolveNested?: (guid: string) => UserInterfaceDocument | null,
): string[] {
  return collectMaterialGuidsFromUiDocuments(documents, resolveNested);
}

/** Scene materials plus HUD Interface materials, in that order, de-duplicated. */
export function playMaterialGuidsFromSources(
  scenes: readonly (SerializedScene | null | undefined)[],
  uiDocuments: Iterable<UserInterfaceDocument>,
  extraGuids: readonly string[] = [],
  resolveNested?: (guid: string) => UserInterfaceDocument | null,
): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  const add = (guid: string) => {
    if (!guid || seen.has(guid)) return;
    seen.add(guid);
    out.push(guid);
  };
  for (const guid of materialGuidsFromScenes(scenes)) add(guid);
  for (const guid of interfaceMaterialGuidsFromUiDocuments(
    uiDocuments,
    resolveNested,
  )) {
    add(guid);
  }
  for (const guid of extraGuids) add(guid);
  return out;
}

/** Interface-domain Material documents only; other domains do not bind on HUD. */
export function lookupInterfaceMaterialDocument<
  T extends { domain?: string },
>(
  guid: string,
  documents: ReadonlyMap<string, T> | undefined | null,
): T | null {
  const id = guid.trim();
  if (!id || !documents) return null;
  const document = documents.get(id);
  return document?.domain === "interface" ? document : null;
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
