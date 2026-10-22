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
import { SCENE_LAYER_DENIED_COMPONENT_CLASS_IDS } from "./engine-components";

export { normalizeSceneLayerSpawnList, type SceneLayerSpawnEntry };
export { SCENE_LAYER_DENIED_COMPONENT_CLASS_IDS } from "./engine-components";

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
  /**
   * Each instance simulates in its own 2D physics world with `gravity`. Off
   * (the default): the layer gets no physics world, so its bodies neither move
   * nor collide and fire no collision events.
   */
  physicsEnabled: boolean;
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

/** Components that draw 3D geometry inside the flat layer. */
export const SCENE_LAYER_3D_COMPONENT_CLASS_IDS = [
  "MeshComponent",
  "Text3DComponent",
] as const;

/**
 * A layer actor carrying 3D geometry is posed in full 3D in the Inspector (X/Y
 * tilt, depth, Z scale); the viewport still edits it with the 2D box.
 */
export function isSceneLayer3DActor(actor: {
  components: readonly { classId: string; destroyed?: boolean }[];
}): boolean {
  return actor.components.some(
    (component) =>
      !component.destroyed &&
      (SCENE_LAYER_3D_COMPONENT_CLASS_IDS as readonly string[]).includes(component.classId),
  );
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
    physicsEnabled: false,
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
      physicsEnabled: sourceSettings.physicsEnabled === true,
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

/** A 0–1 fraction of the source texture edge. */
function marginFraction(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? Math.min(value, 1)
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
    marginLeft: marginFraction(source.marginLeft),
    marginRight: marginFraction(source.marginRight),
    marginTop: marginFraction(source.marginTop),
    marginBottom: marginFraction(source.marginBottom),
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

/** The orange design canvas (Layer Width × Height), defaulted when unset or invalid. */
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

/**
 * Play HUD ortho size: the design canvas widened or heightened to the
 * viewport aspect, so it stays whole and centred and its content keeps its
 * proportions. Anchors carry content out to the extra edges.
 */
export function sceneLayerViewBounds(
  bounds: { width?: number; height?: number } | null | undefined,
  aspect: number,
): { width: number; height: number } {
  const design = sceneLayerOrthoBounds(bounds);
  if (!Number.isFinite(aspect) || aspect <= 0) return design;
  return aspect >= design.width / design.height
    ? { width: design.height * aspect, height: design.height }
    : { width: design.width, height: design.width / aspect };
}

/**
 * A Scene Layer instance's Play camera, set by scripts: the layer-space point
 * at the centre of the view, its roll in degrees (positive turns the camera
 * counter-clockwise, so content turns clockwise on screen) and its zoom (2
 * shows half the view bounds at twice the size). Session state, never saved.
 */
export interface SceneLayerCamera {
  x: number;
  y: number;
  rotation: number;
  zoom: number;
}

export const SCENE_LAYER_DEFAULT_CAMERA: Readonly<SceneLayerCamera> = Object.freeze({ x: 0, y: 0, rotation: 0, zoom: 1 });

/** Zoom never reaches 0, where the view would have no size (an overshooting tween can ask for less). */
export const SCENE_LAYER_CAMERA_MIN_ZOOM = 0.01;

/**
 * `camera` with `changes` applied: non-finite values keep the current one and
 * zoom is raised to {@link SCENE_LAYER_CAMERA_MIN_ZOOM}.
 */
export function updateSceneLayerCamera(
  camera: Readonly<SceneLayerCamera>,
  changes: { x?: unknown; y?: unknown; rotation?: unknown; zoom?: unknown },
): SceneLayerCamera {
  const pick = (value: unknown, current: number) => {
    const number = Number(value);
    return value !== undefined && value !== null && Number.isFinite(number) ? number : current;
  };
  return {
    x: pick(changes.x, camera.x),
    y: pick(changes.y, camera.y),
    rotation: pick(changes.rotation, camera.rotation),
    zoom: Math.max(SCENE_LAYER_CAMERA_MIN_ZOOM, pick(changes.zoom, camera.zoom)),
  };
}

/**
 * A Play canvas pixel (Y down) in a Scene Layer's space (Y up): through the
 * view bounds, then the camera's zoom, roll and centre, as the compositor
 * draws and picks the layer.
 */
export function sceneLayerCanvasToLayer(
  canvasX: number,
  canvasY: number,
  canvasWidth: number,
  canvasHeight: number,
  view: { width: number; height: number },
  camera: Readonly<SceneLayerCamera> = SCENE_LAYER_DEFAULT_CAMERA,
): { x: number; y: number } {
  const viewX = (canvasX / Math.max(1, canvasWidth) - 0.5) * view.width / camera.zoom;
  const viewY = (0.5 - canvasY / Math.max(1, canvasHeight)) * view.height / camera.zoom;
  if (camera.rotation === 0) return { x: camera.x + viewX, y: camera.y + viewY };
  const radians = camera.rotation * Math.PI / 180;
  const cos = Math.cos(radians);
  const sin = Math.sin(radians);
  return { x: camera.x + viewX * cos - viewY * sin, y: camera.y + viewX * sin + viewY * cos };
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

/**
 * Map a design-space XY from the orange layer bounds onto the Play frustum:
 * the anchor point moves to the matching frustum point and the actor keeps
 * its authored distance from it, so nothing is scaled.
 */
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
  return { x: screen.x + dx, y: screen.y + dy };
}

export type OverlayPointerHit = {
  layerId: string;
  actorGuid: string;
  hitTest: SceneLayerHitTest;
  hasButton?: boolean;
  /** Scene-local mesh identity of a built-in joystick surface. */
  joystickMeshName?: string;
  /** Scene-local mesh identity of an interactive control surface. */
  controlMeshName?: string;
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
      physicsEnabled: scene.settings.layerPhysicsEnabled === true,
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
      layerPhysicsEnabled: layer.settings.physicsEnabled,
    },
    actors: layer.actors,
    folders: layer.folders,
  };
}
