/**
 * Scene document schema (v3): actors, components and scene settings.
 *
 * The 2D convention is fixed here and assumed by every consumer: 2D lives on
 * the XY plane with +Y up and +X right, and the editor camera sits at negative
 * Z looking toward +Z because Babylon is left-handed.
 *
 * v3 adds `settings.physicsWorld` (`"3d"` | `"2d"`). Older documents default
 * from `viewportMode` on normalize. `editorJoystickEnabled` is additive on v3
 * (missing keys normalize to false). `grid.showGrid` is additive (missing keys
 * normalize to true so older scenes keep the editor grid). Fog color/start/end,
 * `environmentTextureGuid`, and Default Camera ids are additive on v3 (missing
 * keys normalize to defaults; a Default Camera pick requires both actor and
 * component ids).
 */

export type ViewportMode = "3d" | "2d";

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
  properties: Record<string, unknown>;
  /** Prefab / actor component attach parent; missing documents normalize to null. */
  parentId?: string | null;
  /** Local TRS relative to parent component, or the actor origin when unparented. */
  transform?: SerializedTransform;
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
  /** Clear colour as [r, g, b] in 0..1. */
  environmentColor: [number, number, number];
  fogEnabled: boolean;
  /** Linear fog colour as [r, g, b] in 0..1. */
  fogColor: [number, number, number];
  fogStart: number;
  fogEnd: number;
  /** Optional IBL cube texture asset guid. */
  environmentTextureGuid: string | null;
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
   * Ordered post-process Material passes for the active camera. Empty by
   * default: a full-screen pass is the classic mobile fill-rate cost.
   */
  postProcessStack: ScenePostProcessEntry[];
}

/** One entry of the scene's ordered post-process chain. */
export interface ScenePostProcessEntry {
  materialGuid: string;
  enabled: boolean;
}

export interface SerializedScene {
  name: string;
  /** Mode the scene opens in; the viewport toggle stays available regardless. */
  viewportMode: ViewportMode;
  settings: SceneSettings;
  actors: SerializedActor[];
}

export const SCENE_SCHEMA_VERSION = 3;

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
    environmentColor: [0.06, 0.07, 0.09],
    fogEnabled: false,
    fogColor: [0.5, 0.5, 0.5],
    fogStart: 0,
    fogEnd: 100,
    environmentTextureGuid: null,
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
    editorJoystickEnabled: false,
    postProcessStack: [],
  };
}

export function createMeshComponent(
  id: string,
  meshKind = "box",
): SerializedComponent {
  return {
    id,
    classId: "MeshComponent",
    // `materialGuid` overrides the whole mesh; imported models can additionally
    // override one slot at a time through `materialSlots`.
    properties: { meshKind, assetGuid: null, materialGuid: null },
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
    transform: overrides.transform ?? identitySerializedTransform(),
    visible: overrides.visible ?? true,
    locked: overrides.locked ?? false,
    components: overrides.components ?? [],
  };
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

function normalizeComponent(
  value: unknown,
  index: number,
): SerializedComponent {
  const source = (value ?? {}) as Record<string, unknown>;
  return {
    id: typeof source.id === "string" ? source.id : `component-${index}`,
    classId:
      typeof source.classId === "string" ? source.classId : "MeshComponent",
    properties:
      typeof source.properties === "object" && source.properties !== null
        ? { ...(source.properties as Record<string, unknown>) }
        : {},
    parentId: typeof source.parentId === "string" ? source.parentId : null,
    transform: normalizeTransform(source.transform),
  };
}

function normalizeActor(value: unknown, index: number): SerializedActor {
  const source = (value ?? {}) as Record<string, unknown>;
  return {
    id: typeof source.id === "string" ? source.id : `actor-${index}`,
    name: typeof source.name === "string" ? source.name : `Actor ${index + 1}`,
    classId: typeof source.classId === "string" ? source.classId : "Actor",
    parentId: typeof source.parentId === "string" ? source.parentId : null,
    transform: normalizeTransform(source.transform),
    visible: source.visible !== false,
    locked: source.locked === true,
    components: Array.isArray(source.components)
      ? source.components.map(normalizeComponent)
      : [],
  };
}

function asNullableString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value : null;
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
    environmentColor: asNumberTuple3(
      source.environmentColor,
      defaults.environmentColor,
    ),
    fogEnabled: source.fogEnabled === true,
    fogColor: asNumberTuple3(source.fogColor, defaults.fogColor),
    fogStart:
      typeof source.fogStart === "number" ? source.fogStart : defaults.fogStart,
    fogEnd: typeof source.fogEnd === "number" ? source.fogEnd : defaults.fogEnd,
    environmentTextureGuid: asNullableString(source.environmentTextureGuid),
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
    editorJoystickEnabled: source.editorJoystickEnabled === true,
    postProcessStack: normalizeScenePostProcessStack(source.postProcessStack),
  };
}

/** Authored order is the array order; entries default to enabled. */
export function normalizeScenePostProcessStack(
  value: unknown,
): ScenePostProcessEntry[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry) => {
    if (!entry || typeof entry !== "object") return [];
    const record = entry as Record<string, unknown>;
    const materialGuid = record.materialGuid;
    if (typeof materialGuid !== "string" || materialGuid === "") return [];
    return [{ materialGuid, enabled: record.enabled !== false }];
  });
}

/** Coerce an unknown payload into a structurally valid scene document. */
export function normalizeScene(value: unknown): SerializedScene {
  const source = (value ?? {}) as Record<string, unknown>;
  const viewportMode: ViewportMode =
    source.viewportMode === "2d" ? "2d" : "3d";
  return {
    name: typeof source.name === "string" ? source.name : "Untitled",
    viewportMode,
    settings: normalizeSceneSettings(source.settings, viewportMode),
    actors: Array.isArray(source.actors)
      ? source.actors.map(normalizeActor)
      : [],
  };
}

export function findActor(
  scene: SerializedScene,
  actorId: string,
): SerializedActor | undefined {
  return scene.actors.find((actor) => actor.id === actorId);
}

export function actorChildren(
  scene: SerializedScene,
  parentId: string | null,
): SerializedActor[] {
  return scene.actors.filter((actor) => actor.parentId === parentId);
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
