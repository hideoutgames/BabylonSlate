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

/** Ortho half-height used by Play overlay cameras (frustum height 9). */
export const SCENE_LAYER_ORTHO_HALF_HEIGHT = 4.5;
export const SCENE_LAYER_DEFAULT_FRUSTUM_HEIGHT =
  SCENE_LAYER_ORTHO_HALF_HEIGHT * 2;
export const SCENE_LAYER_DEFAULT_FRUSTUM_WIDTH = 16;

const ANCHOR_ORIGIN: Record<SceneLayerAnchor, readonly [number, number]> = {
  topLeft: [-1, 1],
  topCenter: [0, 1],
  topRight: [1, 1],
  centerLeft: [-1, 0],
  center: [0, 0],
  centerRight: [1, 0],
  bottomLeft: [-1, -1],
  bottomCenter: [0, -1],
  bottomRight: [1, -1],
};

export const SCENE_LAYER_ANCHOR_LABELS: Record<SceneLayerAnchor, string> = {
  topLeft: "Top Left",
  topCenter: "Top Center",
  topRight: "Top Right",
  centerLeft: "Center Left",
  center: "Center",
  centerRight: "Center Right",
  bottomLeft: "Bottom Left",
  bottomCenter: "Bottom Center",
  bottomRight: "Bottom Right",
};

export const SCENE_LAYER_HIT_TEST_LABELS: Record<SceneLayerHitTest, string> = {
  ignore: "Ignore",
  block: "Block",
  passThrough: "Pass Through",
};

export function sceneLayerFrustumSize(aspect: number): {
  width: number;
  height: number;
} {
  const height = SCENE_LAYER_DEFAULT_FRUSTUM_HEIGHT;
  const safeAspect =
    Number.isFinite(aspect) && aspect > 0 ? aspect : 16 / 9;
  return { width: height * safeAspect, height };
}

export function sceneLayerAnchorWorldPosition(
  anchor: SceneLayerAnchor,
  offsetX: number,
  offsetY: number,
  frustumWidth: number,
  frustumHeight: number,
): { x: number; y: number } {
  const origin = ANCHOR_ORIGIN[anchor] ?? ANCHOR_ORIGIN.center;
  return {
    x: origin[0] * (frustumWidth / 2) + offsetX,
    y: origin[1] * (frustumHeight / 2) + offsetY,
  };
}

export type OverlayPointerHit = {
  layerId: string;
  actorGuid: string;
  hitTest: SceneLayerHitTest;
  hasButton?: boolean;
};

export type OverlayPointerWalkResult = {
  targets: OverlayPointerHit[];
  blocked: boolean;
};

/** Walk overlay picks from high z-order to low. Ignore skips; Block stops. */
export function walkOverlayPointerHits(
  hitsHighToLow: readonly OverlayPointerHit[],
): OverlayPointerWalkResult {
  const targets: OverlayPointerHit[] = [];
  for (const hit of hitsHighToLow) {
    if (hit.hitTest === "ignore") continue;
    targets.push(hit);
    if (hit.hitTest === "block") {
      return { targets, blocked: true };
    }
  }
  return { targets, blocked: false };
}

/** Persist an editor 2D scene back to a SceneLayer document. */
export function editorSceneToSceneLayer(
  scene: SerializedScene,
): SerializedSceneLayer {
  return normalizeSceneLayer({
    name: scene.name,
    settings: {
      gravity: scene.settings.gravity,
      fixedTimestepMs: scene.settings.fixedTimestepMs,
      postProcessStack: scene.settings.postProcessStack,
    },
    actors: scene.actors,
    folders: scene.folders,
  });
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
