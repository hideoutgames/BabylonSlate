import {
  createDefaultSceneSettings,
  normalizeScene,
  normalizeSceneLayerSpawnList,
  normalizeScenePostProcessStack,
  type SceneLayerSpawnEntry,
  type ScenePostProcessEntry,
  type SerializedActor,
  type SerializedOutlinerFolder,
  type SerializedScene,
} from "./scene";

export { normalizeSceneLayerSpawnList, type SceneLayerSpawnEntry };

/** SceneLayer document schema (v1): overlay actors, folders, 2D gravity, post-process. */
export const SCENE_LAYER_SCHEMA_VERSION = 1;

export const SCENE_LAYER_DENIED_COMPONENT_CLASS_IDS = [
  "SkyboxComponent",
  "CameraComponent",
  "LightComponent",
] as const;

export type SceneLayerDeniedComponentClassId =
  (typeof SCENE_LAYER_DENIED_COMPONENT_CLASS_IDS)[number];

export const SCENE_LAYER_ANCHORS = [
  "topLeft",
  "topCenter",
  "topRight",
  "centerLeft",
  "center",
  "centerRight",
  "bottomLeft",
  "bottomCenter",
  "bottomRight",
] as const;

export type SceneLayerAnchor = (typeof SCENE_LAYER_ANCHORS)[number];

export const SCENE_LAYER_HIT_TESTS = [
  "ignore",
  "block",
  "passThrough",
] as const;

export type SceneLayerHitTest = (typeof SCENE_LAYER_HIT_TESTS)[number];

export interface SceneLayerSettings {
  gravity: [number, number, number];
  fixedTimestepMs: number;
  postProcessStack: ScenePostProcessEntry[];
}

export interface SerializedSceneLayer {
  name: string;
  settings: SceneLayerSettings;
  actors: SerializedActor[];
  folders: SerializedOutlinerFolder[];
}

const DENIED = new Set<string>(SCENE_LAYER_DENIED_COMPONENT_CLASS_IDS);

export function isSceneLayerDeniedComponent(classId: string): boolean {
  return DENIED.has(classId);
}

export function createDefaultSceneLayerSettings(): SceneLayerSettings {
  const defaults = createDefaultSceneSettings("2d");
  return {
    gravity: [...defaults.gravity] as [number, number, number],
    fixedTimestepMs: defaults.fixedTimestepMs,
    postProcessStack: [],
  };
}

export function createDefaultSceneLayer(): SerializedSceneLayer {
  return {
    name: "Untitled",
    settings: createDefaultSceneLayerSettings(),
    actors: [],
    folders: [],
  };
}

function stripDeniedComponents(actor: SerializedActor): SerializedActor {
  return {
    ...actor,
    classId: actor.classId === "Actor" ? "SceneLayerActor" : actor.classId,
    components: actor.components.filter(
      (component) => !isSceneLayerDeniedComponent(component.classId),
    ),
  };
}

export function normalizeSceneLayer(value: unknown): SerializedSceneLayer {
  const source = (value ?? {}) as Record<string, unknown>;
  const scene = normalizeScene({
    ...source,
    viewportMode: "2d",
  });
  return {
    name: typeof source.name === "string" ? source.name : scene.name,
    settings: {
      gravity: scene.settings.gravity,
      fixedTimestepMs: scene.settings.fixedTimestepMs,
      postProcessStack: normalizeScenePostProcessStack(
        (source.settings as Record<string, unknown> | undefined)
          ?.postProcessStack ?? scene.settings.postProcessStack,
      ),
    },
    actors: scene.actors.map(stripDeniedComponents),
    folders: scene.folders,
  };
}

export function parseSceneLayerAnchor(value: unknown): SceneLayerAnchor {
  return SCENE_LAYER_ANCHORS.includes(value as SceneLayerAnchor)
    ? (value as SceneLayerAnchor)
    : "center";
}

export function parseSceneLayerHitTest(
  value: unknown,
  fallback: SceneLayerHitTest = "ignore",
): SceneLayerHitTest {
  return SCENE_LAYER_HIT_TESTS.includes(value as SceneLayerHitTest)
    ? (value as SceneLayerHitTest)
    : fallback;
}

/** Editor / Play viewport host a SceneLayer as a locked 2D SerializedScene. */
export function sceneLayerToEditorScene(
  layer: SerializedSceneLayer,
): SerializedScene {
  const settings = createDefaultSceneSettings("2d");
  return {
    name: layer.name,
    viewportMode: "2d",
    settings: {
      ...settings,
      gravity: layer.settings.gravity,
      fixedTimestepMs: layer.settings.fixedTimestepMs,
      postProcessStack: layer.settings.postProcessStack,
    },
    actors: layer.actors,
    folders: layer.folders,
  };
}
