/**
 * Scene document schema (v2): actors, components and scene settings.
 *
 * The 2D convention is fixed here and assumed by every consumer: 2D lives on
 * the XY plane with +Y up and +X right, and the editor camera sits at negative
 * Z looking toward +Z because Babylon is left-handed.
 */

export type ViewportMode = "3d" | "2d";

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
}

export interface SceneSettings {
  /** Clear colour as [r, g, b] in 0..1. */
  environmentColor: [number, number, number];
  fogEnabled: boolean;
  gravity: [number, number, number];
  fixedTimestepMs: number;
  /** GameInstance class override for this scene, null to use the project default. */
  gameInstanceClass: string | null;
  grid: SceneGridSettings;
}

export interface SerializedScene {
  name: string;
  /** Mode the scene opens in; the viewport toggle stays available regardless. */
  viewportMode: ViewportMode;
  settings: SceneSettings;
  actors: SerializedActor[];
}

export const SCENE_SCHEMA_VERSION = 2;

export function identitySerializedTransform(): SerializedTransform {
  return {
    position: [0, 0, 0],
    rotation: [0, 0, 0, 1],
    scale: [1, 1, 1],
  };
}

export function createDefaultSceneSettings(): SceneSettings {
  return {
    environmentColor: [0.06, 0.07, 0.09],
    fogEnabled: false,
    gravity: [0, -9.81, 0],
    fixedTimestepMs: 16.6667,
    gameInstanceClass: null,
    grid: {
      snapEnabled: false,
      snapTranslate: 1,
      snapRotateDeg: 15,
      snapScale: 0.25,
      tileSize: 1,
    },
  };
}

export function createMeshComponent(
  id: string,
  meshKind = "box",
): SerializedComponent {
  return {
    id,
    classId: "MeshComponent",
    properties: { meshKind, assetGuid: null },
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

export function normalizeSceneSettings(value: unknown): SceneSettings {
  const defaults = createDefaultSceneSettings();
  const source = (value ?? {}) as Record<string, unknown>;
  const grid = (source.grid ?? {}) as Record<string, unknown>;
  return {
    environmentColor: asNumberTuple3(
      source.environmentColor,
      defaults.environmentColor,
    ),
    fogEnabled: source.fogEnabled === true,
    gravity: asNumberTuple3(source.gravity, defaults.gravity),
    fixedTimestepMs:
      typeof source.fixedTimestepMs === "number"
        ? source.fixedTimestepMs
        : defaults.fixedTimestepMs,
    gameInstanceClass:
      typeof source.gameInstanceClass === "string"
        ? source.gameInstanceClass
        : null,
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
    },
  };
}

/** Coerce an unknown payload into a structurally valid scene document. */
export function normalizeScene(value: unknown): SerializedScene {
  const source = (value ?? {}) as Record<string, unknown>;
  return {
    name: typeof source.name === "string" ? source.name : "Untitled",
    viewportMode: source.viewportMode === "2d" ? "2d" : "3d",
    settings: normalizeSceneSettings(source.settings),
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
