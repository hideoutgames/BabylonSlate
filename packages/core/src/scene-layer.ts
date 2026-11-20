import type { SerializedGraph } from "./project";
import type { SerializedTimelineClip } from "./timeline-clips";
import {
  createDefaultSceneSettings,
  normalizeCameraLocation2D,
  normalizeScene,
  normalizeSceneLayerSpawnList,
  normalizeScenePostProcessStack,
  type SceneLayerSpawnEntry,
  type ScenePostProcessEntry,
  type SerializedActor,
  type SerializedOutlinerFolder,
  type SerializedScene,
} from "./scene";
import { SCENE_LAYER_DENIED_COMPONENT_CLASS_IDS } from "./engine-components";
import { DEFAULT_LAYER_CAMERA_STATE, type LayerCameraState } from "./layer-camera";
import {
  SCENE_LAYER_ANCHOR_ORIGIN,
  createDefaultSceneLayerCanvasDesign,
  normalizeSceneLayerCanvasDesign,
  normalizeSceneLayerFrameDesign,
  sceneLayerCanvasRect,
  sceneLayerFitToAspect,
  type SceneLayerAnchor,
  type SceneLayerCanvasContext,
  type SceneLayerCanvasDesign,
  type SceneLayerContentBounds,
  type SceneLayerFrameDesign,
  type SceneLayerRect,
} from "./scene-layer-canvas";

export { normalizeSceneLayerSpawnList, type SceneLayerSpawnEntry };
export { SCENE_LAYER_DENIED_COMPONENT_CLASS_IDS } from "./engine-components";

export {
  SCENE_LAYER_ANCHORS,
  SCENE_LAYER_ANCHOR_LABELS,
  parseSceneLayerAnchor,
  type SceneLayerAnchor,
} from "./scene-layer-canvas";

/** Editor-only SceneLayerActor Prefab frame, saved with the Class (`SerializedGraph.overlayDesign`). */
export type SceneLayerActorDesign = SceneLayerFrameDesign;

export function normalizeSceneLayerActorDesign(value: unknown): SceneLayerActorDesign {
  return normalizeSceneLayerFrameDesign(value);
}

/**
 * The SceneLayerActor Prefab's orange frame in layer units, by the same rule
 * as a Scene Layer's canvas (`sceneLayerCanvasRect`): Fullscreen is the design
 * resolution and Custom `customSizePx`, both over Pixels Per Unit and hanging
 * from the Prefab Root at `rootAnchor`; Desired is the content bounds wherever
 * they are (null without content).
 */
export function sceneLayerActorFrameBounds(
  design: SceneLayerActorDesign,
  context: SceneLayerCanvasContext,
  contentBounds: SceneLayerContentBounds | null,
): SceneLayerRect | null {
  return sceneLayerCanvasRect(design, context, contentBounds);
}

/**
 * One pass of the Scene Layer post-processing stack every layer shares (Project Settings
 * `sceneLayerPostProcessStack`, and Play's live stack). Layers always draw at full resolution, so a pass has no
 * Scalable flag.
 */
export type SceneLayerPostProcessEntry = Omit<ScenePostProcessEntry, "id" | "scalable"> & { id: string };

/** The Scene's pass rules (`normalizeScenePostProcessStack`: an id per pass, enabled by default) without `scalable`. */
export function normalizeSceneLayerPostProcessStack(value: unknown): SceneLayerPostProcessEntry[] {
  return normalizeScenePostProcessStack(value).map((entry) => ({
    id: entry.id,
    materialGuid: entry.materialGuid,
    enabled: entry.enabled,
    ...(entry.parameters ? { parameters: entry.parameters } : {}),
  }));
}

export const SCENE_LAYER_HIT_TESTS = [
  "ignore",
  "block",
  "passThrough",
] as const;

export type SceneLayerHitTest = (typeof SCENE_LAYER_HIT_TESTS)[number];

export interface SceneLayerSettings {
  gravity: [number, number, number];
  fixedTimestepMs: number;
  /** The design canvas (`sceneLayerCanvasRect`) and how Play scales it (`sceneLayerView`). Default Fullscreen, Root Center, Fit To Screen. */
  canvas: SceneLayerCanvasDesign;
  /** Where each instance's Layer Camera starts: its offset from the view the canvas sets. Default (0, 0). */
  cameraLocation: [number, number];
  /**
   * Each instance simulates in its own 2D physics world with `gravity`. Off
   * (the default): the layer gets no physics world, so its bodies neither move
   * nor collide and fire no collision events.
   */
  physicsEnabled: boolean;
  /**
   * While a script has paused the game, every actor in each instance keeps ticking, whatever its
   * own Tick On Pause, and so does the SceneLayerScript. Off by default.
   */
  tickOnPause: boolean;
}

export interface SerializedSceneLayer {
  name: string;
  settings: SceneLayerSettings;
  actors: SerializedActor[];
  folders: SerializedOutlinerFolder[];
  /**
   * The SceneLayerScript: an Object-like graph that runs once per instance of
   * this layer, for that instance's lifetime. Absent until authored.
   */
  script?: SerializedGraph;
  /** Timeline Clips authored in Timeline mode; absent until one is created. */
  timelineClips?: SerializedTimelineClip[];
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
 * A layer actor carrying 3D geometry rotates and scales on all three axes in
 * the Inspector; it keeps 2D placement and the viewport's 2D box.
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

export function createDefaultSceneLayerSettings(): SceneLayerSettings {
  const defaults = createDefaultSceneSettings("2d");
  return {
    gravity: [...defaults.gravity] as [number, number, number],
    fixedTimestepMs: defaults.fixedTimestepMs,
    canvas: createDefaultSceneLayerCanvasDesign(),
    cameraLocation: [0, 0],
    physicsEnabled: false,
    tickOnPause: false,
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
  const sourceSettings =
    (source.settings as Record<string, unknown> | undefined) ?? {};
  return {
    name: typeof source.name === "string" ? source.name : scene.name,
    settings: {
      gravity: scene.settings.gravity,
      fixedTimestepMs: scene.settings.fixedTimestepMs,
      canvas: normalizeSceneLayerCanvasDesign(sourceSettings.canvas),
      cameraLocation: normalizeCameraLocation2D(sourceSettings.cameraLocation),
      physicsEnabled: sourceSettings.physicsEnabled === true,
      tickOnPause: sourceSettings.tickOnPause === true,
    },
    actors: scene.actors.map(stripDeniedComponents),
    folders: scene.folders,
    ...(scene.script ? { script: scene.script } : {}),
    ...(scene.timelineClips ? { timelineClips: scene.timelineClips } : {}),
  };
}

export function parseSceneLayerHitTest(
  value: unknown,
  fallback: SceneLayerHitTest = "ignore",
): SceneLayerHitTest {
  return SCENE_LAYER_HIT_TESTS.includes(value as SceneLayerHitTest)
    ? (value as SceneLayerHitTest)
    : fallback;
}

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

/**
 * A Scene's Layer Camera Width × Height widened or heightened to the viewport
 * aspect, so it stays whole and centred and its content keeps its proportions.
 */
export function sceneLayerViewBounds(
  bounds: { width?: number; height?: number } | null | undefined,
  aspect: number,
): { width: number; height: number } {
  const width = typeof bounds?.width === "number" && bounds.width > 0 ? bounds.width : 16;
  const height = typeof bounds?.height === "number" && bounds.height > 0 ? bounds.height : 9;
  return sceneLayerFitToAspect({ width, height }, aspect);
}

/**
 * A Play canvas pixel (Y down) in a Scene Layer's space (Y up): through the
 * view (its size and, for a Scene Layer, its centre: `sceneLayerView`), then
 * the camera's zoom, roll and location, as the compositor draws and picks the
 * layer.
 */
export function sceneLayerCanvasToLayer(
  canvasX: number,
  canvasY: number,
  canvasWidth: number,
  canvasHeight: number,
  view: { width: number; height: number; center?: readonly [number, number] },
  camera: Readonly<LayerCameraState> = DEFAULT_LAYER_CAMERA_STATE,
): { x: number; y: number } {
  const viewX = (canvasX / Math.max(1, canvasWidth) - 0.5) * view.width / camera.zoom;
  const viewY = (0.5 - canvasY / Math.max(1, canvasHeight)) * view.height / camera.zoom;
  const x = camera.x + (view.center?.[0] ?? 0);
  const y = camera.y + (view.center?.[1] ?? 0);
  if (camera.rotation === 0) return { x: x + viewX, y: y + viewY };
  const radians = camera.rotation * Math.PI / 180;
  const cos = Math.cos(radians);
  const sin = Math.sin(radians);
  return { x: x + viewX * cos - viewY * sin, y: y + viewX * sin + viewY * cos };
}

function sceneLayerAnchorPoint(anchor: SceneLayerAnchor, rect: SceneLayerRect): { x: number; y: number } {
  const origin = SCENE_LAYER_ANCHOR_ORIGIN[anchor] ?? SCENE_LAYER_ANCHOR_ORIGIN.center;
  return {
    x: rect.center[0] + origin[0] * (rect.width / 2),
    y: rect.center[1] + origin[1] * (rect.height / 2),
  };
}

/**
 * Map a design-space XY from the layer's canvas onto the view 2D Anchors use
 * (`sceneLayerAnchorView`): the anchor point moves to the matching view point
 * and the actor keeps its authored distance from it, so nothing is scaled.
 */
export function sceneLayerRelativeAnchorWorldPosition(options: {
  anchor: SceneLayerAnchor;
  authoredX: number;
  authoredY: number;
  offsetX?: number;
  offsetY?: number;
  canvas: SceneLayerRect;
  view: SceneLayerRect;
}): { x: number; y: number } {
  const origin = sceneLayerAnchorPoint(options.anchor, options.canvas);
  const screen = sceneLayerAnchorPoint(options.anchor, options.view);
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
      canvas: scene.settings.layerCanvas,
      cameraLocation: scene.settings.cameraLocation2D,
      physicsEnabled: scene.settings.layerPhysicsEnabled === true,
      tickOnPause: scene.settings.layerTickOnPause === true,
    },
    actors: scene.actors,
    folders: scene.folders,
    script: scene.script,
    timelineClips: scene.timelineClips,
  });
}

/**
 * The editor's preview background behind a Scene Layer: a neutral mid grey, so Translucent, Additive and Multiply
 * visuals each show what they do (over black a Multiply would only show black). Play draws layers over the world and
 * never reads it; Save does not keep it.
 */
export const SCENE_LAYER_PREVIEW_BACKGROUND: readonly [number, number, number] = [0.5, 0.5, 0.5];

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
      environmentColor: [...SCENE_LAYER_PREVIEW_BACKGROUND],
      gravity: layer.settings.gravity,
      fixedTimestepMs: layer.settings.fixedTimestepMs,
      cameraLocation2D: [...layer.settings.cameraLocation],
      layerPhysicsEnabled: layer.settings.physicsEnabled,
      layerTickOnPause: layer.settings.tickOnPause,
      layerCanvas: { ...layer.settings.canvas, customSizePx: { ...layer.settings.canvas.customSizePx } },
    },
    actors: layer.actors,
    folders: layer.folders,
    ...(layer.script ? { script: layer.script } : {}),
    ...(layer.timelineClips ? { timelineClips: layer.timelineClips } : {}),
  };
}
