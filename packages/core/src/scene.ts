import { normalizeCelShadingOverrides } from "./cel-shading";
import { parseLandscapeProperties } from "./landscape";
import { normalizeFoliageGroups, parseFoliageProperties, type FoliageGroup } from "./foliage";
import { normalizeMaterialInstanceOverrides, normalizeMaterialParameterOverrides, type MaterialInstanceOverrides, type MaterialParameterValue } from "./material-parameter-value";
import { normalizeShadowOverrides } from "./shadows";
import { normalizeEnvironmentLightingOverrides, type EnvironmentLightingOverrides } from "./environment-lighting";
import { parseSplineProperties, SPLINE_COMPONENT_CLASS_ID } from "./spline-component";
import { normalizeSceneStreamingProperties } from "./scene-streaming";


/**
 * Scene document schema (v4): actors, components and scene settings.
 *
 * The 2D convention is fixed here and assumed by every consumer: 2D lives on
 * the XY plane with +Y up and +X right, and the editor camera sits at negative
 * Z looking toward +Z because Babylon is left-handed.
 *
 * v3 adds `settings.physicsWorld` (`"3d"` | `"2d"`). Older documents default
 * from `viewportMode` on normalize. `editorJoystickEnabled` is additive on v3
 * (missing keys normalize to true). `grid.showGrid` is additive (missing keys
 * normalize to true so older scenes keep the editor grid). `showNavmesh` is
 * additive (missing keys normalize to false, except a leftover
 * `NavMeshComponent.debugOverlay === true` migrates the overlay on). Fog
 * color/start/end,
 * `environmentTextureGuid`, and Default Camera ids are additive on v3 (missing
 * keys normalize to defaults; a Default Camera pick requires both actor and
 * component ids). v4 distinguishes automatic shadow capacity from a saved
 * manual local-light limit. Fog mode/density are additive on v4; missing mode
 * preserves linear fog in existing scenes.
 */

export type ViewportMode = "3d" | "2d";

export type SceneFogMode = "linear" | "exponential" | "exponentialSquared";

/** Which physics backend a scene uses — never both (engineplan §13.4). */
export type PhysicsWorldKind = "3d" | "2d";


export interface SerializedTransform {
  position: [number, number, number];
  /** Quaternion as [x, y, z, w]. */
  rotation: [number, number, number, number];
  scale: [number, number, number];
}

export interface SerializedComponent {
  id: string;
  classId: string;
  /** Editor display name; missing shows the class label. Asset details in brackets are never part of it. */
  name?: string;
  properties: Record<string, unknown>;
  /** Prefab / actor component attach parent; missing documents normalize to null. */
  parentId?: string | null;
  /** Local TRS relative to parent component, or the actor origin when unparented. */
  transform?: SerializedTransform;
  /**
   * Prefab component id this instance row was spawned from. Missing means the
   * component was added on the scene actor and prefab sync must not remove it.
   */
  sourceId?: string;
  /**
   * Property names plus `transform` / `parentId` that the scene instance owns.
   * Prefab sync copies every other field from the Class prefab.
   */
  overrideKeys?: string[];
  /** Private surface parameters, valid only for the named material assignment. */
  materialInstance?: MaterialInstanceOverrides;
}

export interface SerializedActor {
  id: string;
  name: string;
  /** Class id from the object-model class registry, e.g. "Actor". */
  classId: string;
  parentId: string | null;
  transform: SerializedTransform;
  visible: boolean;
  locked: boolean;
  components: SerializedComponent[];
  /** Per-instance actor variable overrides, including SceneLayer switcher entries. */
  properties?: Record<string, unknown>;
  /** Removed Class prefab rows; source IDs survive actor/component duplication. */
  suppressedComponentSourceIds?: string[];
  /**
   * Prefab asset GUID this logic-free actor was placed from. Editor sync uses
   * it; the runtime ignores it because the components are already baked in.
   */
  prefabGuid?: string;
  /**
   * Outliner folder that lists this actor, or null for the scene root. Purely
   * organizational: `parentId` still owns transform attachment, and the runtime
   * ignores folders entirely.
   */
  folderId: string | null;
}

/** An Outliner-only anchor carrier has no authored spatial pose. */
export function isSceneLayerAnchorActor(actor: {
  components: readonly { classId: string; destroyed?: boolean }[];
}): boolean {
  const components = actor.components.filter((component) => !component.destroyed);
  return components.length > 0 && components.every(
    (component) => component.classId === "2DAnchorComponent",
  );
}

/** Editor-only Outliner grouping. Never instantiated as a runtime actor. */
export interface SerializedOutlinerFolder {
  id: string;
  name: string;
  parentFolderId: string | null;
}

export interface SceneGridSettings {
  snapEnabled: boolean;
  /** World units per translate snap step. */
  snapTranslate: number;
  snapRotateDeg: number;
  snapScale: number;
  /** Tile size in world units, used by the 2D tile grid. */
  tileSize: number;
  /** Minor grid lines drawn between two major tile lines. */
  tileSubdivisions: number;
  /** Editor viewport grid visibility; missing keys normalize to true. */
  showGrid: boolean;
}

/** Rectangle the game camera frames in 2D, drawn as bounds in the viewport. */
export interface SceneCameraBounds2D {
  width: number;
  height: number;
}

export interface SceneSettings {
  /** Model-only brush palettes, shared by this scene's Foliage mode. */
  foliageGroups?: FoliageGroup[];
  shadowOverrides?: import("./shadows").ShadowOverrides;
  /** Absent CEL fields inherit from Project Settings. Inactive in PBR mode. */
  celShading?: import("./cel-shading").CelShadingOverrides;
  /** Clear colour as [r, g, b] in 0..1. */
  environmentColor: [number, number, number];
  fogEnabled: boolean;
  /** Babylon distance-fog falloff; older scenes retain linear fog. */
  fogMode: SceneFogMode;
  /** Fog colour as [r, g, b] in 0..1. */
  fogColor: [number, number, number];
  /** Nonnegative density for exponential and exponential-squared fog. */
  fogDensity: number;
  /** Linear fog distances in world units; end must be greater than start. */
  fogStart: number;
  fogEnd: number;
  /** Optional IBL cube texture asset guid. */
  environmentTextureGuid: string | null;
  environmentLighting?: EnvironmentLightingOverrides;
  /** Default Camera actor id; both ids required to resolve. */
  mainCameraActorId: string | null;
  mainCameraComponentId: string | null;
  gravity: [number, number, number];
  fixedTimestepMs: number;
  /** GameInstance class override for this scene, null to use the project default. */
  gameInstanceClass: string | null;
  /**
   * Physics backend for this scene. Defaults from `viewportMode` on create;
   * a scene never mixes 2D and 3D physics worlds.
   */
  physicsWorld: PhysicsWorldKind;
  grid: SceneGridSettings;
  cameraBounds2D: SceneCameraBounds2D;
  /** Editor viewport on-screen stick for flying/panning the camera. */
  editorJoystickEnabled: boolean;
  /**
   * Editor viewport navmesh debug overlay. Missing keys normalize to false
   * unless a leftover NavMesh `debugOverlay` flag is true.
   */
  showNavmesh: boolean;
  /**
   * Ordered post-process Material passes for the active camera. Empty by
   * default: a full-screen pass is the classic mobile fill-rate cost.
   */
  postProcessStack: ScenePostProcessEntry[];
  /**
   * SceneLayer overlays to spawn with this world scene and tear down when it
   * unloads. Missing keys normalize to [].
   */
  sceneLayers: SceneLayerSpawnEntry[];
}

/** One entry of the scene's ordered post-process chain. */
export interface ScenePostProcessEntry {
  /** Stable within the owning Scene/SceneLayer; absent only in legacy input. */
  id?: string;
  scalable?: boolean;
  materialGuid: string;
  enabled: boolean;
  parameters?: Record<string, MaterialParameterValue>;
}

/** World-scene default overlay to spawn with that scene. */
export interface SceneLayerSpawnEntry {
  assetGuid: string;
  zOrder: number;
  enabled: boolean;
}

export interface SerializedScene {
  name: string;
  /** Mode the scene opens in; the viewport toggle stays available regardless. */
  viewportMode: ViewportMode;
  settings: SceneSettings;
  actors: SerializedActor[];
  /** Outliner folders; missing on older documents and normalized to []. */
  folders: SerializedOutlinerFolder[];
  /**
   * Editor-only SceneLayer tab flag. Opaque black clear; not persisted on
   * SceneLayer or world Scene documents.
   */
  overlayEditor?: boolean;
}

export const SCENE_SCHEMA_VERSION = 4;

export function identitySerializedTransform(): SerializedTransform {
  return {
    position: [0, 0, 0],
    rotation: [0, 0, 0, 1],
    scale: [1, 1, 1],
  };
}

export function createDefaultSceneSettings(
  viewportMode: ViewportMode = "3d",
): SceneSettings {
  return {
    celShading: {},
    shadowOverrides: {},
    environmentColor: [0.06, 0.07, 0.09],
    fogEnabled: false,
    fogMode: "linear",
    fogColor: [0.5, 0.5, 0.5],
    fogDensity: 0.01,
    fogStart: 0,
    fogEnd: 100,
    environmentTextureGuid: null,
    environmentLighting: {},
    mainCameraActorId: null,
    mainCameraComponentId: null,
    gravity: [0, -9.81, 0],
    fixedTimestepMs: 16.6667,
    gameInstanceClass: null,
    physicsWorld: viewportMode === "2d" ? "2d" : "3d",
    grid: {
      snapEnabled: false,
      snapTranslate: 1,
      snapRotateDeg: 15,
      snapScale: 0.25,
      tileSize: 1,
      tileSubdivisions: 4,
      showGrid: true,
    },
    cameraBounds2D: { width: 16, height: 9 },
    editorJoystickEnabled: true,
    showNavmesh: false,
    postProcessStack: [],
    sceneLayers: [],
  };
}

/**
 * A new MeshComponent draws only: collision is opt-in ("simple" or "complex"),
 * so it never adds a hidden shape beside the actor's explicit colliders.
 */
export function createMeshComponent(
  id: string,
  meshKind = "box",
  collisionMode: "none" | "simple" | "complex" = "none",
): SerializedComponent {
  return {
    id,
    classId: "MeshComponent",
    // `materialGuid` overrides the whole mesh; imported models can additionally
    // override one slot at a time through `materialSlots`.
    properties: {
      meshKind,
      assetGuid: null,
      materialGuid: null,
      collisionMode,
      layer: 1,
      mask: 0xffffffff,
    },
    parentId: null,
    transform: identitySerializedTransform(),
  };
}

export function createActor(
  id: string,
  name: string,
  overrides: Partial<Omit<SerializedActor, "id" | "name">> = {},
): SerializedActor {
  return {
    id,
    name,
    classId: overrides.classId ?? "Actor",
    parentId: overrides.parentId ?? null,
    transform: isSceneLayerAnchorActor({ components: overrides.components ?? [] })
      ? identitySerializedTransform()
      : overrides.transform ?? identitySerializedTransform(),
    visible: overrides.visible ?? true,
    locked: overrides.locked ?? false,
    components: overrides.components ?? [],
    ...(overrides.properties ? { properties: structuredClone(overrides.properties) } : {}),
    ...(overrides.suppressedComponentSourceIds?.length
      ? { suppressedComponentSourceIds: normalizeSuppressedComponentSourceIds(overrides.suppressedComponentSourceIds) } : {}),
    ...(overrides.prefabGuid ? { prefabGuid: overrides.prefabGuid } : {}),
    folderId: overrides.folderId ?? null,
  };
}

export function normalizeSuppressedComponentSourceIds(value: unknown): string[] {
  return Array.isArray(value)
    ? [...new Set(value.filter((entry): entry is string => typeof entry === "string" && !!entry.trim()).map((entry) => entry.trim()))]
    : [];
}

function asNumberTuple3(
  value: unknown,
  fallback: [number, number, number],
): [number, number, number] {
  if (!Array.isArray(value) || value.length < 3) return fallback;
  const [x, y, z] = value as unknown[];
  return [
    typeof x === "number" ? x : fallback[0],
    typeof y === "number" ? y : fallback[1],
    typeof z === "number" ? z : fallback[2],
  ];
}

export function normalizeTransform(value: unknown): SerializedTransform {
  const source = (value ?? {}) as Record<string, unknown>;
  const rotation = source.rotation;
  const identity = identitySerializedTransform();
  return {
    position: asNumberTuple3(source.position, identity.position),
    rotation:
      Array.isArray(rotation) && rotation.length >= 4
        ? [
            Number(rotation[0]) || 0,
            Number(rotation[1]) || 0,
            Number(rotation[2]) || 0,
            typeof rotation[3] === "number" ? rotation[3] : 1,
          ]
        : identity.rotation,
    scale: asNumberTuple3(source.scale, identity.scale),
  };
}

function normalizeOverrideKeys(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const keys = value.filter(
    (entry): entry is string => typeof entry === "string" && entry.trim().length > 0,
  );
  return keys.length > 0 ? keys : undefined;
}

function normalizeComponent(
  value: unknown,
  index: number,
): SerializedComponent {
  const source = (value ?? {}) as Record<string, unknown>;
  const sourceId =
    typeof source.sourceId === "string" && source.sourceId.trim()
      ? source.sourceId.trim()
      : undefined;
  const overrideKeys = normalizeOverrideKeys(source.overrideKeys);
  const materialInstance = normalizeMaterialInstanceOverrides(source.materialInstance);
  const name = typeof source.name === "string" ? source.name.trim() : "";
  return {
    id: typeof source.id === "string" ? source.id : `component-${index}`,
    classId:
      typeof source.classId === "string" ? source.classId : "MeshComponent",
    ...(name ? { name } : {}),
    properties:
      source.classId === "CableComponent" ? { ...parseCableProperties(source.properties) } :
      source.classId === SPLINE_COMPONENT_CLASS_ID ? { ...parseSplineProperties(source.properties) } :
      source.classId === "SceneStreamingComponent" ? { ...normalizeSceneStreamingProperties(source.properties) } :
      source.classId === "LandscapeComponent" ? { ...parseLandscapeProperties(source.properties) } :
      source.classId === "FoliageComponent" ? { ...parseFoliageProperties(source.properties) } :
      source.classId === "FogVolumeComponent" ? { ...parseFogVolumeProperties(source.properties) } :
      source.classId === "DeformerComponent" ? { ...parseDeformerProperties(source.properties) } :
      source.classId === "AreaRectLightComponent" ? { ...parseAreaRectLightProperties(source.properties) } : source.classId === "OutlineComponent" ? { ...parseOutlineProperties(source.properties) } : source.classId === SPRING_ARM_COMPONENT_CLASS_ID ? { ...parseSpringArmProperties(source.properties) } : typeof source.properties === "object" && source.properties !== null
        ? { ...(source.properties as Record<string, unknown>) }
        : {},
    parentId: typeof source.parentId === "string" ? source.parentId : null,
    ...(source.classId === "2DAnchorComponent" ? {} : { transform: normalizeTransform(source.transform) }),
    ...(sourceId ? { sourceId } : {}),
    ...(overrideKeys ? { overrideKeys } : {}),
    ...(materialInstance ? { materialInstance } : {}),
  };
}

/** Prefab asset payload: logic-free component templates only. */
export interface SerializedPrefab {
  components: SerializedComponent[];
}

export function normalizePrefab(value: unknown): SerializedPrefab {
  const source = (value ?? {}) as Record<string, unknown>;
  return {
    components: Array.isArray(source.components)
      ? source.components.map(normalizeComponent)
      : [],
  };
}

function normalizeActor(value: unknown, index: number): SerializedActor {
  const source = (value ?? {}) as Record<string, unknown>;
  const components = Array.isArray(source.components) ? source.components.map(normalizeComponent) : [];
  const suppressedComponentSourceIds = normalizeSuppressedComponentSourceIds(source.suppressedComponentSourceIds);
  return {
    id: typeof source.id === "string" ? source.id : `actor-${index}`,
    name: typeof source.name === "string" ? source.name : `Actor ${index + 1}`,
    classId: typeof source.classId === "string" ? source.classId : "Actor",
    parentId: typeof source.parentId === "string" ? source.parentId : null,
    transform: isSceneLayerAnchorActor({ components })
      ? identitySerializedTransform()
      : normalizeTransform(source.transform),
    visible: source.visible !== false,
    locked: source.locked === true,
    components,
    ...(suppressedComponentSourceIds.length ? { suppressedComponentSourceIds } : {}),
    ...(typeof source.prefabGuid === "string" && source.prefabGuid.trim() ? { prefabGuid: source.prefabGuid.trim() } : {}),
    ...(source.properties && typeof source.properties === "object" && !Array.isArray(source.properties)
      ? { properties: structuredClone(source.properties as Record<string, unknown>) } : {}),
    folderId: asNullableString(source.folderId),
  };
}

/**
 * Folders are editor metadata, so a malformed row is dropped rather than
 * repaired into a phantom group. Surviving rows get unique ids, and parent
 * links that dangle or form a cycle fall back to the root so no folder can
 * become unreachable in the Outliner.
 */
function normalizeFolders(value: unknown): SerializedOutlinerFolder[] {
  if (!Array.isArray(value)) return [];
  const taken = new Set<string>();
  const folders: SerializedOutlinerFolder[] = [];
  for (const entry of value) {
    if (!entry || typeof entry !== "object") continue;
    const source = entry as Record<string, unknown>;
    const id = asNullableString(source.id);
    const name = asNullableString(source.name);
    if (!id || !name) continue;
    let unique = id;
    let suffix = 2;
    while (taken.has(unique)) {
      unique = `${id}-${suffix}`;
      suffix += 1;
    }
    taken.add(unique);
    folders.push({
      id: unique,
      name,
      parentFolderId: asNullableString(source.parentFolderId),
    });
  }

  const byId = new Map(folders.map((folder) => [folder.id, folder]));
  return folders.map((folder) => {
    let parent = folder.parentFolderId;
    if (parent !== null && !byId.has(parent)) parent = null;
    // Walk up to the root; a loop means this link cannot stay.
    const seen = new Set<string>([folder.id]);
    let cursor = parent;
    while (cursor !== null) {
      if (seen.has(cursor)) {
        parent = null;
        break;
      }
      seen.add(cursor);
      cursor = byId.get(cursor)?.parentFolderId ?? null;
    }
    return parent === folder.parentFolderId ? folder : { ...folder, parentFolderId: parent };
  });
}

function withResolvedFolderIds(
  actors: SerializedActor[],
  folders: readonly SerializedOutlinerFolder[],
): SerializedActor[] {
  const known = new Set(folders.map((folder) => folder.id));
  return actors.map((actor) =>
    actor.folderId !== null && !known.has(actor.folderId)
      ? { ...actor, folderId: null }
      : actor,
  );
}

function asNullableString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value : null;
}

/**
 * Actor ids are the runtime guids of a document's actors, and two live actors
 * never share a guid. A document that repeats one is rejected, never repaired.
 */
export function assertUniqueSceneActorIds(
  actors: readonly Pick<SerializedActor, "id" | "name">[],
  documentName: string,
): void {
  const names = new Map<string, string>();
  for (const actor of actors) {
    const first = names.get(actor.id);
    if (first !== undefined) {
      throw new Error(`"${documentName}" contains duplicate actor id "${actor.id}" (actors "${first}" and "${actor.name}"). ` +
        "Actor ids must be unique; give one of these actors a new id in the document file.");
    }
    names.set(actor.id, actor.name);
  }
}

function normalizeMainCamera(
  actorId: unknown,
  componentId: unknown,
): { mainCameraActorId: string | null; mainCameraComponentId: string | null } {
  const mainCameraActorId = asNullableString(actorId);
  const mainCameraComponentId = asNullableString(componentId);
  if (!mainCameraActorId || !mainCameraComponentId) {
    return { mainCameraActorId: null, mainCameraComponentId: null };
  }
  return { mainCameraActorId, mainCameraComponentId };
}

/** Keep authored fog safe for both document loading and live viewport edits. */
export function normalizeSceneFogSettings(
  value: unknown,
): Pick<SceneSettings, "fogMode" | "fogDensity" | "fogStart" | "fogEnd"> {
  const source = (value ?? {}) as Record<string, unknown>;
  const defaults = createDefaultSceneSettings();
  const finite = (value: unknown, fallback: number): number =>
    typeof value === "number" && Number.isFinite(value) ? value : fallback;
  let fogStart = finite(source.fogStart, defaults.fogStart);
  let fogEnd = finite(source.fogEnd, defaults.fogEnd);
  if (fogEnd <= fogStart) {
    // The relative increment stays representable for large authored distances.
    fogEnd = fogStart + Math.max(0.01, Math.abs(fogStart) * Number.EPSILON);
    if (!Number.isFinite(fogEnd)) {
      fogStart = defaults.fogStart;
      fogEnd = defaults.fogEnd;
    }
  }
  return {
    fogMode:
      source.fogMode === "exponential" || source.fogMode === "exponentialSquared"
        ? source.fogMode
        : "linear",
    fogDensity: Math.max(0, finite(source.fogDensity, defaults.fogDensity)),
    fogStart,
    fogEnd,
  };
}

export function normalizeSceneSettings(
  value: unknown,
  viewportMode: ViewportMode = "3d",
): SceneSettings {
  const defaults = createDefaultSceneSettings(viewportMode);
  const source = (value ?? {}) as Record<string, unknown>;
  const grid = (source.grid ?? {}) as Record<string, unknown>;
  const bounds = (source.cameraBounds2D ?? {}) as Record<string, unknown>;
  const physicsWorld: PhysicsWorldKind =
    source.physicsWorld === "2d" || source.physicsWorld === "3d"
      ? source.physicsWorld
      : defaults.physicsWorld;
  return {
    celShading: normalizeCelShadingOverrides(source.celShading),
    shadowOverrides: normalizeShadowOverrides(source.shadowOverrides),
    environmentColor: asNumberTuple3(
      source.environmentColor,
      defaults.environmentColor,
    ),
    fogEnabled: source.fogEnabled === true,
    fogColor: asNumberTuple3(source.fogColor, defaults.fogColor),
    ...normalizeSceneFogSettings(source),
    environmentTextureGuid: asNullableString(source.environmentTextureGuid),
    environmentLighting: normalizeEnvironmentLightingOverrides(source.environmentLighting),
    ...normalizeMainCamera(
      source.mainCameraActorId,
      source.mainCameraComponentId,
    ),
    gravity: asNumberTuple3(source.gravity, defaults.gravity),
    fixedTimestepMs:
      typeof source.fixedTimestepMs === "number"
        ? source.fixedTimestepMs
        : defaults.fixedTimestepMs,
    gameInstanceClass:
      typeof source.gameInstanceClass === "string"
        ? source.gameInstanceClass
        : null,
    physicsWorld,
    grid: {
      snapEnabled: grid.snapEnabled === true,
      snapTranslate:
        typeof grid.snapTranslate === "number"
          ? grid.snapTranslate
          : defaults.grid.snapTranslate,
      snapRotateDeg:
        typeof grid.snapRotateDeg === "number"
          ? grid.snapRotateDeg
          : defaults.grid.snapRotateDeg,
      snapScale:
        typeof grid.snapScale === "number"
          ? grid.snapScale
          : defaults.grid.snapScale,
      tileSize:
        typeof grid.tileSize === "number" ? grid.tileSize : defaults.grid.tileSize,
      tileSubdivisions:
        typeof grid.tileSubdivisions === "number"
          ? Math.max(1, Math.round(grid.tileSubdivisions))
          : defaults.grid.tileSubdivisions,
      showGrid: grid.showGrid !== false,
    },
    cameraBounds2D: {
      width:
        typeof bounds.width === "number" && bounds.width > 0
          ? bounds.width
          : defaults.cameraBounds2D.width,
      height:
        typeof bounds.height === "number" && bounds.height > 0
          ? bounds.height
          : defaults.cameraBounds2D.height,
    },
    editorJoystickEnabled: source.editorJoystickEnabled !== false,
    showNavmesh: source.showNavmesh === true,
    postProcessStack: normalizeScenePostProcessStack(source.postProcessStack),
    sceneLayers: normalizeSceneLayerSpawnList(source.sceneLayers),
    ...(source.foliageGroups !== undefined ? { foliageGroups: normalizeFoliageGroups(source.foliageGroups) } : {}),
  };
}

/** Authored order is the array order; entries default to enabled. */
export function normalizeScenePostProcessStack(
  value: unknown,
): Array<ScenePostProcessEntry & { id: string }> {
  if (!Array.isArray(value)) return [];
  const entries = value.flatMap((entry) => {
    if (!entry || typeof entry !== "object") return [];
    const record = entry as Record<string, unknown>;
    const materialGuid = record.materialGuid;
    if (typeof materialGuid !== "string" || materialGuid === "") return [];
    const parameters = normalizeMaterialParameterOverrides(record.parameters);
    return [{
      id: typeof record.id === "string" && record.id.trim() ? record.id : undefined,
      materialGuid,
      enabled: record.enabled !== false,
      ...(record.scalable === true ? { scalable: true } : {}),
      ...(Object.keys(parameters).length ? { parameters } : {}),
    }];
  });
  // Reserve authored IDs before migration so an early legacy entry cannot take
  // the identity of a later authored one. Persisted IDs survive every reorder.
  const reserved = new Set(entries.map((entry) => entry.id).filter(Boolean));
  const used = new Set<string>();
  let sequence = 0;
  return entries.map((entry) => {
    let id = entry.id;
    if (!id || used.has(id)) {
      do { id = `legacy-pass-${++sequence}`; } while (reserved.has(id) || used.has(id));
    }
    used.add(id);
    return { ...entry, id };
  });
}

/** Authored order is the array order; entries default to enabled. */
export function normalizeSceneLayerSpawnList(
  value: unknown,
): SceneLayerSpawnEntry[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry) => {
    if (!entry || typeof entry !== "object") return [];
    const record = entry as Record<string, unknown>;
    const assetGuid = record.assetGuid;
    if (typeof assetGuid !== "string" || assetGuid === "") return [];
    const zRaw = record.zOrder;
    const zOrder =
      typeof zRaw === "number" && Number.isFinite(zRaw) ? Math.trunc(zRaw) : 0;
    return [{ assetGuid, zOrder, enabled: record.enabled !== false }];
  });
}

/** Coerce an unknown payload into a structurally valid scene document. */
export function normalizeScene(value: unknown): SerializedScene {
  const source = (value ?? {}) as Record<string, unknown>;
  const viewportMode: ViewportMode =
    source.viewportMode === "2d" ? "2d" : "3d";
  const folders = normalizeFolders(source.folders);
  const name = typeof source.name === "string" ? source.name : "Untitled";
  const actors = Array.isArray(source.actors) ? source.actors.map(normalizeActor) : [];
  assertUniqueSceneActorIds(actors, name);
  const settings = normalizeSceneSettings(source.settings, viewportMode);
  const rawSettings =
    source.settings && typeof source.settings === "object"
      ? (source.settings as Record<string, unknown>)
      : {};
  const leftoverNavDebug =
    !("showNavmesh" in rawSettings) &&
    actors.some((actor) =>
      actor.components.some(
        (component) =>
          component.classId === "NavMeshComponent" &&
          component.properties.debugOverlay === true,
      ),
    );
  return {
    name,
    viewportMode,
    settings: leftoverNavDebug ? { ...settings, showNavmesh: true } : settings,
    actors: withResolvedFolderIds(actors, folders),
    folders,
  };
}

export function findActor(
  scene: SerializedScene,
  actorId: string,
): SerializedActor | undefined {
  return scene.actors.find((actor) => actor.id === actorId);
}

/** Actor plus every descendant, in scene order. */
export function actorSubtree(
  scene: SerializedScene,
  actorId: string,
): SerializedActor[] {
  const ids = new Set<string>([actorId]);
  let grew = true;
  while (grew) {
    grew = false;
    for (const actor of scene.actors) {
      if (ids.has(actor.id)) continue;
      if (actor.parentId !== null && ids.has(actor.parentId)) {
        ids.add(actor.id);
        grew = true;
      }
    }
  }
  return scene.actors.filter((actor) => ids.has(actor.id));
}

export function findFolder(
  scene: SerializedScene,
  folderId: string,
): SerializedOutlinerFolder | undefined {
  return scene.folders.find((folder) => folder.id === folderId);
}

/** Folder plus every descendant folder, in scene order. */
export function folderSubtree(
  scene: SerializedScene,
  folderId: string,
): SerializedOutlinerFolder[] {
  const ids = new Set<string>([folderId]);
  let grew = true;
  while (grew) {
    grew = false;
    for (const folder of scene.folders) {
      if (
        folder.parentFolderId !== null &&
        ids.has(folder.parentFolderId) &&
        !ids.has(folder.id)
      ) {
        ids.add(folder.id);
        grew = true;
      }
    }
  }
  return scene.folders.filter((folder) => ids.has(folder.id));
}

/** True when moving `folderId` under `parentFolderId` would create a cycle. */
export function wouldCreateFolderCycle(
  scene: SerializedScene,
  folderId: string,
  parentFolderId: string | null,
): boolean {
  if (parentFolderId === null) return false;
  if (parentFolderId === folderId) return true;
  return folderSubtree(scene, folderId).some(
    (folder) => folder.id === parentFolderId,
  );
}

export function nextFolderId(scene: SerializedScene): string {
  let index = 1;
  while (scene.folders.some((folder) => folder.id === `folder-${index}`)) {
    index += 1;
  }
  return `folder-${index}`;
}

/** True when moving `actorId` under `parentId` would create a cycle. */
export function wouldCreateCycle(
  scene: SerializedScene,
  actorId: string,
  parentId: string | null,
): boolean {
  let cursor = parentId;
  while (cursor !== null) {
    if (cursor === actorId) return true;
    cursor = findActor(scene, cursor)?.parentId ?? null;
  }
  return false;
}

/** True when moving `componentId` under `parentId` would create a cycle. */
export function wouldCreateComponentCycle(
  components: readonly SerializedComponent[],
  componentId: string,
  parentId: string | null,
): boolean {
  if (!parentId) return false;
  const byId = new Map(components.map((component) => [component.id, component]));
  let cursor: string | null = parentId;
  const seen = new Set<string>();
  while (cursor !== null) {
    if (cursor === componentId) return true;
    if (seen.has(cursor)) return true;
    seen.add(cursor);
    cursor = byId.get(cursor)?.parentId ?? null;
  }
  return false;
}
import { parseAreaRectLightProperties } from "./area-rect-light";
import { parseFogVolumeProperties } from "./fog-volume";
import { parseOutlineProperties } from "./outline-component";
import { parseDeformerProperties } from "./deformer-component";
import { parseSpringArmProperties, SPRING_ARM_COMPONENT_CLASS_ID } from "./spring-arm-component";
import { parseCableProperties } from "./cable-component";
