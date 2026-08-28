import {
  createDefaultSceneSettings,
  normalizeScene,
  normalizeSceneLayerSpawnList,
  normalizeScenePostProcessStack,
  type SceneCameraBounds2D,
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
  "HemisphericFillLightComponent",
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
  /** Orange editor outline / 2DAnchor design canvas. Default 32×18. */
  layerBounds: SceneCameraBounds2D;
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

export const SCENE_LAYER_DEFAULT_LAYER_BOUNDS: SceneCameraBounds2D = {
  width: 32,
  height: 18,
};

export function createDefaultSceneLayerSettings(): SceneLayerSettings {
  const defaults = createDefaultSceneSettings("2d");
  return {
    gravity: [...defaults.gravity] as [number, number, number],
    fixedTimestepMs: defaults.fixedTimestepMs,
    postProcessStack: [],
    layerBounds: { ...SCENE_LAYER_DEFAULT_LAYER_BOUNDS },
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

function normalizeLayerBounds(value: unknown): SceneCameraBounds2D {
  const source = (value ?? {}) as Record<string, unknown>;
  return {
    width:
      typeof source.width === "number" && source.width > 0
        ? source.width
        : SCENE_LAYER_DEFAULT_LAYER_BOUNDS.width,
    height:
      typeof source.height === "number" && source.height > 0
        ? source.height
        : SCENE_LAYER_DEFAULT_LAYER_BOUNDS.height,
  };
}

function bakeIdentityOverlayAnchor(
  actor: SerializedActor,
  layerWidth: number,
  layerHeight: number,
): SerializedActor {
  const anchor = actor.components.find(
    (component) => component.classId === "2DAnchorComponent",
  );
  if (!anchor) return actor;
  const position = actor.transform.position;
  if (position[0] !== 0 || position[1] !== 0) return actor;
  const offsetX = Number(anchor.properties.offsetX) || 0;
  const offsetY = Number(anchor.properties.offsetY) || 0;
  if (offsetX === 0 && offsetY === 0) return actor;
  const baked = sceneLayerAnchorWorldPosition(
    parseSceneLayerAnchor(anchor.properties.anchor),
    offsetX,
    offsetY,
    layerWidth,
    layerHeight,
  );
  return {
    ...actor,
    transform: {
      ...actor.transform,
      position: [baked.x, baked.y, position[2]],
    },
    components: actor.components.map((component) =>
      component.id === anchor.id
        ? {
            ...component,
            properties: { ...component.properties, offsetX: 0, offsetY: 0 },
          }
        : component,
    ),
  };
}

export function normalizeSceneLayer(value: unknown): SerializedSceneLayer {
  const source = (value ?? {}) as Record<string, unknown>;
  const scene = normalizeScene({
    ...source,
    viewportMode: "2d",
  });
  const sourceSettings =
    (source.settings as Record<string, unknown> | undefined) ?? {};
  const layerBounds = normalizeLayerBounds(sourceSettings.layerBounds);
  return {
    name: typeof source.name === "string" ? source.name : scene.name,
    settings: {
      gravity: scene.settings.gravity,
      fixedTimestepMs: scene.settings.fixedTimestepMs,
      postProcessStack: normalizeScenePostProcessStack(
        sourceSettings.postProcessStack ?? scene.settings.postProcessStack,
      ),
      layerBounds,
    },
    actors: scene.actors
      .map(stripDeniedComponents)
      .map((actor) =>
        bakeIdentityOverlayAnchor(
          actor,
          layerBounds.width,
          layerBounds.height,
        ),
      ),
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

export const SCENE_LAYER_PANEL_SOURCES = ["texture", "material"] as const;
export type SceneLayerPanelSource = (typeof SCENE_LAYER_PANEL_SOURCES)[number];

export const SCENE_LAYER_PANEL_SOURCE_LABELS: Record<
  SceneLayerPanelSource,
  string
> = {
  texture: "Texture",
  material: "Material",
};

export type OverlayPanelProperties = {
  source: SceneLayerPanelSource;
  textureGuid: string | null;
  materialGuid: string | null;
  marginLeft: number;
  marginRight: number;
  marginTop: number;
  marginBottom: number;
  hitTest: SceneLayerHitTest;
};

function nonNegativeNumber(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? value
    : 0;
}

function optionalGuid(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

export function parseOverlayPanelProperties(
  value: unknown,
): OverlayPanelProperties {
  const source = (value ?? {}) as Record<string, unknown>;
  return {
    source: source.source === "material" ? "material" : "texture",
    textureGuid: optionalGuid(source.textureGuid),
    materialGuid: optionalGuid(source.materialGuid),
    marginLeft: nonNegativeNumber(source.marginLeft),
    marginRight: nonNegativeNumber(source.marginRight),
    marginTop: nonNegativeNumber(source.marginTop),
    marginBottom: nonNegativeNumber(source.marginBottom),
    hitTest: parseSceneLayerHitTest(source.hitTest, "ignore"),
  };
}

export function sceneLayerFrustumSize(aspect: number): {
  width: number;
  height: number;
} {
  const height = SCENE_LAYER_DEFAULT_FRUSTUM_HEIGHT;
  const safeAspect =
    Number.isFinite(aspect) && aspect > 0 ? aspect : 16 / 9;
  return { width: height * safeAspect, height };
}

/** Play HUD ortho size: the orange design canvas, stretched to the framebuffer. */
export function sceneLayerOrthoBounds(bounds?: {
  width?: number;
  height?: number;
} | null): { width: number; height: number } {
  return {
    width:
      typeof bounds?.width === "number" && bounds.width > 0
        ? bounds.width
        : SCENE_LAYER_DEFAULT_LAYER_BOUNDS.width,
    height:
      typeof bounds?.height === "number" && bounds.height > 0
        ? bounds.height
        : SCENE_LAYER_DEFAULT_LAYER_BOUNDS.height,
  };
}

export function sceneLayerAnchorOrigin(
  anchor: SceneLayerAnchor,
  width: number,
  height: number,
): { x: number; y: number } {
  const origin = ANCHOR_ORIGIN[anchor] ?? ANCHOR_ORIGIN.center;
  return {
    x: origin[0] * (width / 2),
    y: origin[1] * (height / 2),
  };
}

export function sceneLayerAnchorWorldPosition(
  anchor: SceneLayerAnchor,
  offsetX: number,
  offsetY: number,
  frustumWidth: number,
  frustumHeight: number,
): { x: number; y: number } {
  const origin = sceneLayerAnchorOrigin(anchor, frustumWidth, frustumHeight);
  return {
    x: origin.x + offsetX,
    y: origin.y + offsetY,
  };
}

/** Map a design-space XY from the orange layer bounds onto the Play frustum. */
export function sceneLayerRelativeAnchorWorldPosition(options: {
  anchor: SceneLayerAnchor;
  authoredX: number;
  authoredY: number;
  offsetX?: number;
  offsetY?: number;
  layerWidth: number;
  layerHeight: number;
  frustumWidth: number;
  frustumHeight: number;
}): { x: number; y: number } {
  const layerWidth =
    options.layerWidth > 0
      ? options.layerWidth
      : SCENE_LAYER_DEFAULT_LAYER_BOUNDS.width;
  const layerHeight =
    options.layerHeight > 0
      ? options.layerHeight
      : SCENE_LAYER_DEFAULT_LAYER_BOUNDS.height;
  const frustumWidth =
    options.frustumWidth > 0 ? options.frustumWidth : layerWidth;
  const frustumHeight =
    options.frustumHeight > 0 ? options.frustumHeight : layerHeight;
  const origin = sceneLayerAnchorOrigin(options.anchor, layerWidth, layerHeight);
  const screen = sceneLayerAnchorOrigin(
    options.anchor,
    frustumWidth,
    frustumHeight,
  );
  const dx = options.authoredX + (options.offsetX ?? 0) - origin.x;
  const dy = options.authoredY + (options.offsetY ?? 0) - origin.y;
  return {
    x: screen.x + (dx / layerWidth) * frustumWidth,
    y: screen.y + (dy / layerHeight) * frustumHeight,
  };
}

export type OverlayPointerHit = {
  layerId: string;
  actorGuid: string;
  hitTest: SceneLayerHitTest;
  hasButton?: boolean;
  componentId?: string;
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
      layerBounds: scene.settings.cameraBounds2D,
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
    overlayEditor: true,
    settings: {
      ...settings,
      environmentColor: [0, 0, 0],
      gravity: layer.settings.gravity,
      fixedTimestepMs: layer.settings.fixedTimestepMs,
      postProcessStack: layer.settings.postProcessStack,
      cameraBounds2D: { ...layer.settings.layerBounds },
    },
    actors: layer.actors,
    folders: layer.folders,
  };
}
