import type { ControlMessage } from "@haptic/bridge";
import {
  modelMaterialGuids,
  normalizeAnimationPayload,
  retargetAnimationLoadsFromAnimations,
  spriteAnimationTextureGuids,
  type ModelPayload,
  type SpriteAnimationPayload,
  type SpritePayload,
  type TilemapPayload,
  type TilesetPayload,
} from "@haptic/assets";
import {
  normalizeTilemapPayload,
  normalizeTilesetPayload,
  tilemapTilesetGuids,
} from "@haptic/assets";
import {
  UI_CONTROL_2D_CLASS_IDS,
  isEditorOnlyAsset,
  parseSkyboxFaces,
  sceneEnvironmentTextureGuid,
  skyboxFaceGuids,
  text2dFontGuidsFromScene,
  text2dImageGuidsFromScene,
  text3DFontGuidsFromScene,
  type CollisionTriangleMesh,
  type SerializedGraph,
  type SerializedScene,
} from "@haptic/core";
import {
  isMaterialInstanceContent,
  materialDependencies,
  materialInstanceDependencies,
  normalizeMaterialDocument,
  normalizeMaterialFunctionDocument,
  normalizeMaterialInstanceDocument,
} from "@haptic/shader-graph";

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

/** Sprite asset guids referenced by scene SpriteComponents. */
export function spriteAssetGuidsFromScene(
  scene: SerializedScene | null | undefined,
): string[] {
  return componentGuidsFromScene(scene, "SpriteComponent", ["assetGuid"]);
}

/** Texture guids on overlay 2DTexture components and RichText `[img]` tags. */
export function overlayTextureGuidsFromScene(
  scene: SerializedScene | null | undefined,
): string[] {
  const found: string[] = [];
  const seen = new Set<string>();
  for (const guid of [
    ...UI_CONTROL_2D_CLASS_IDS.flatMap(classId => componentGuidsFromScene(scene, classId, ["backgroundTextureGuid", "trackTextureGuid", "fillTextureGuid", "thumbTextureGuid", "indicatorTextureGuid"])),
    ...componentGuidsFromScene(scene, "2DTextureComponent", ["textureGuid"]),
    ...componentGuidsFromScene(scene, "2DPanelComponent", ["textureGuid"]),
    ...text2dImageGuidsFromScene(scene),
  ]) {
    if (seen.has(guid)) continue;
    seen.add(guid);
    found.push(guid);
  }
  return found;
}

/** Font guids on 3D Text and overlay 2D Text / 2D Rich Text. */
export function playFontGuidsFromScenes(
  scenes: readonly (SerializedScene | null | undefined)[],
): string[] {
  const found: string[] = [];
  const seen = new Set<string>();
  for (const scene of scenes) {
    for (const guid of [
      ...text3DFontGuidsFromScene(scene),
      ...text2dFontGuidsFromScene(scene),
    ]) {
      if (seen.has(guid)) continue;
      seen.add(guid);
      found.push(guid);
    }
  }
  return found;
}

/** Tilemap asset guids referenced by scene TilemapComponents. */
export function tilemapAssetGuidsFromScene(
  scene: SerializedScene | null | undefined,
): string[] {
  return componentGuidsFromScene(scene, "TilemapComponent", ["assetGuid"]);
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

/** Material asset guids referenced by world and overlay rendering components. */
export function materialAssetGuidsFromScene(
  scene: SerializedScene | null | undefined,
): string[] {
  const guids: string[] = [];
  const seen = new Set<string>();
  for (const guid of [
    ...componentGuidsFromScene(scene, "MeshComponent", ["materialGuid"]),
    ...componentGuidsFromScene(scene, "DynamicRuntimeMeshComponent", ["materialGuid"]),
    ...componentGuidsFromScene(scene, "CableComponent", ["materialGuid"]),
    ...componentGuidsFromScene(scene, "MirrorComponent", ["materialGuid"]),
    ...componentGuidsFromScene(scene, "LandscapeComponent", ["materialGuid"]),
    ...(scene?.actors.flatMap((actor) => actor.components.flatMap((component) => component.classId === "FoliageComponent" ? parseFoliageProperties(component.properties).batches.flatMap((batch) => batch.materialGuid ? [batch.materialGuid] : []) : [])) ?? []),
    ...UI_CONTROL_2D_CLASS_IDS.flatMap(classId => componentGuidsFromScene(scene, classId, ["backgroundMaterialGuid", "trackMaterialGuid", "fillMaterialGuid", "thumbMaterialGuid", "indicatorMaterialGuid"])),
    ...componentGuidsFromScene(scene, "2DJoystickComponent", ["backgroundMaterialGuid", "joystickMaterialGuid"]),
    ...componentGuidsFromScene(scene, "2DMaterialComponent", ["materialGuid"]),
    ...componentGuidsFromScene(scene, "2DPanelComponent", ["materialGuid"]),
    ...componentGuidsFromScene(scene, "2DTextComponent", ["materialGuid"]),
    ...componentGuidsFromScene(scene, "2DRichTextComponent", ["materialGuid"]),
  ]) {
    if (seen.has(guid)) continue;
    seen.add(guid);
    guids.push(guid);
  }
  return guids;
}

/** Surface instance textures are scoped to the component's current assignment. */
export function materialInstanceTextureGuidsFromScenes(
  scenes: readonly (SerializedScene | null | undefined)[],
): string[] {
  const guids = new Set<string>();
  for (const scene of scenes) for (const actor of scene?.actors ?? []) for (const component of actor.components) {
    const instance = component.materialInstance;
    if (!instance || instance.materialGuid !== component.properties.materialGuid) continue;
    for (const parameter of Object.values(instance.parameters)) {
      if (parameter.kind === "texture" && parameter.textureAssetGuid?.trim()) guids.add(parameter.textureAssetGuid.trim());
    }
  }
  return [...guids];
}

/** Include saved overrides even while their pass is disabled, so later activation needs no missing texture. */
export function postProcessTextureGuidsFromScenes(
  scenes: readonly (SerializedScene | null | undefined)[],
): string[] {
  const guids = new Set<string>();
  for (const scene of scenes)
    for (const entry of scene?.settings.postProcessStack ?? [])
      for (const parameter of Object.values(entry.parameters ?? {}))
        if (parameter.kind === "texture" && parameter.textureAssetGuid?.trim())
          guids.add(parameter.textureAssetGuid.trim());
  return [...guids];
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
  // Play drops the boot document once streamed sources own the Scene.
  if (current?.guid === guid && current.scene) return current.scene;
  return library.find((entry) => entry.guid === guid)?.scene;
}

/**
 * Materials plus every Material Function they call, transitively, and each
 * Material Instance's parent chain. Play and export both need the closure, not
 * just the directly referenced set. `referenced` lists every guid visited,
 * including ones whose content is not loaded yet, so callers can load and retry.
 */
export function materialClosureFromGuids(
  guids: readonly string[],
  documentForGuid: (guid: string) => unknown | null,
): { materials: string[]; instances: string[]; functions: string[]; textures: string[]; referenced: string[] } {
  const materials: string[] = [];
  const instances: string[] = [];
  const functions: string[] = [];
  const textures = new Set<string>();
  const seen = new Set<string>();
  const queue = [...guids];

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

  for (let index = 0; index < queue.length; index++) {
    const guid = queue[index]!;
    if (seen.has(guid)) continue;
    seen.add(guid);
    const content = documentForGuid(guid);
    if (!content) continue;
    if (isMaterialInstanceContent(content)) {
      instances.push(guid);
      const deps = materialInstanceDependencies(normalizeMaterialInstanceDocument(content));
      for (const texture of deps.textures) textures.add(texture);
      if (deps.parent) queue.push(deps.parent);
      continue;
    }
    materials.push(guid);
    const deps = materialDependencies(normalizeMaterialDocument(content));
    for (const texture of deps.textures) textures.add(texture);
    for (const fn of deps.functions) visitFunction(fn);
  }
  return { materials, instances, functions, textures: [...textures].sort(), referenced: [...seen] };
}

/** Model asset guids on MeshComponent.assetGuid (imported GLB). */
export function modelAssetGuidsFromScene(
  scene: SerializedScene | null | undefined,
): string[] {
  return [...new Set([
    ...componentGuidsFromScene(scene, "MeshComponent", ["assetGuid"]),
    ...(scene?.actors.flatMap((actor) => actor.components.flatMap((component) => component.classId === "FoliageComponent" ? parseFoliageProperties(component.properties).batches.map((batch) => batch.modelGuid) : [])) ?? []),
  ])];
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

/** Environment cubes needed by the active scene and future scene changes. */
export function environmentTextureGuidsFromScenes(scenes: readonly (SerializedScene | null | undefined)[]): string[] {
  const guids = new Set<string>();
  for (const scene of scenes) {
    const guid = scene ? sceneEnvironmentTextureGuid(scene.settings) : null;
    if (guid) guids.add(guid);
  }
  return [...guids];
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

/** Worker `loadModels` control, or null when Play has no Model payloads. */
export function playLoadModelsControl(
  models: ReadonlyMap<string, ModelPayload> | undefined,
  complexMeshes?: ReadonlyMap<string, CollisionTriangleMesh>,
): Extract<ControlMessage, { type: "loadModels" }> | null {
  if (!models || models.size === 0) return null;
  return {
    type: "loadModels",
    models: guidDocuments(models),
    ...(complexMeshes && complexMeshes.size > 0
      ? {
          complexMeshes: [...complexMeshes.entries()].map(([guid, mesh]) => ({
            guid,
            positions: mesh.positions,
            indices: mesh.indices,
          })),
        }
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
import { parseFoliageProperties } from "@haptic/core";
