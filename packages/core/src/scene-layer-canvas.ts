/**
 * A Scene Layer's design canvas and how Play shows it, shared by Scene Layers
 * (their settings) and Scene Layer Actor Classes (their Prefab frame).
 */

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

/** Each anchor's point on a rectangle, from -1 (left, bottom) to 1 (right, top). */
export const SCENE_LAYER_ANCHOR_ORIGIN: Record<SceneLayerAnchor, readonly [number, number]> = {
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

/**
 * How a canvas is sized: the project's Custom Resolution (Fullscreen), the
 * bounds of the content (Desired), or an authored pixel size (Custom).
 */
export const SCENE_LAYER_SIZE_MODES = ["fullscreen", "desired", "custom"] as const;
export type SceneLayerSizeMode = (typeof SCENE_LAYER_SIZE_MODES)[number];

export const SCENE_LAYER_SIZE_MODE_LABELS: Record<SceneLayerSizeMode, string> = {
  fullscreen: "Fullscreen",
  desired: "Desired",
  custom: "Custom",
};

/**
 * How Play shows a Scene Layer's canvas: fitted to the screen without
 * stretching, or at its pixel size (one design pixel per pixel of the
 * project's design resolution).
 */
export const SCENE_LAYER_SCALINGS = ["fitToScreen", "truePixelSize"] as const;
export type SceneLayerScaling = (typeof SCENE_LAYER_SCALINGS)[number];

export const SCENE_LAYER_SCALING_LABELS: Record<SceneLayerScaling, string> = {
  fitToScreen: "Fit To Screen",
  truePixelSize: "True Pixel Size",
};

/** A canvas's size and the canvas point that sits on the origin. */
export interface SceneLayerFrameDesign {
  sizeMode: SceneLayerSizeMode;
  /** Canvas size in pixels for `custom`. */
  customSizePx: { width: number; height: number };
  /** Canvas point that sits on the origin (a Scene Layer's, or a Prefab's Root). */
  rootAnchor: SceneLayerAnchor;
}

/** A Scene Layer's canvas: its frame and how Play scales it. */
export interface SceneLayerCanvasDesign extends SceneLayerFrameDesign {
  scaling: SceneLayerScaling;
}

/** A rectangle in layer units: its size and its centre. */
export interface SceneLayerRect {
  width: number;
  height: number;
  center: readonly [number, number];
}

export type SceneLayerContentBounds = { minX: number; minY: number; maxX: number; maxY: number };

export const SCENE_LAYER_DEFAULT_CUSTOM_SIZE_PX = { width: 400, height: 300 } as const;

/** The design resolution without a Custom Resolution. */
export const SCENE_LAYER_FALLBACK_RESOLUTION = { width: 1920, height: 1080 } as const;

function positive(entry: unknown, fallback: number): number {
  return typeof entry === "number" && Number.isFinite(entry) && entry > 0 ? entry : fallback;
}

export function parseSceneLayerAnchor(value: unknown): SceneLayerAnchor {
  return SCENE_LAYER_ANCHORS.includes(value as SceneLayerAnchor)
    ? (value as SceneLayerAnchor)
    : "center";
}

export function normalizeSceneLayerFrameDesign(value: unknown): SceneLayerFrameDesign {
  const source = (value ?? {}) as Record<string, unknown>;
  const size = (source.customSizePx ?? {}) as Record<string, unknown>;
  return {
    sizeMode: (SCENE_LAYER_SIZE_MODES as readonly unknown[]).includes(source.sizeMode)
      ? source.sizeMode as SceneLayerSizeMode
      : "fullscreen",
    customSizePx: {
      width: positive(size.width, SCENE_LAYER_DEFAULT_CUSTOM_SIZE_PX.width),
      height: positive(size.height, SCENE_LAYER_DEFAULT_CUSTOM_SIZE_PX.height),
    },
    rootAnchor: parseSceneLayerAnchor(source.rootAnchor),
  };
}

export function normalizeSceneLayerCanvasDesign(value: unknown): SceneLayerCanvasDesign {
  const source = (value ?? {}) as Record<string, unknown>;
  return {
    ...normalizeSceneLayerFrameDesign(source),
    scaling: source.scaling === "truePixelSize" ? "truePixelSize" : "fitToScreen",
  };
}

export function createDefaultSceneLayerCanvasDesign(): SceneLayerCanvasDesign {
  return normalizeSceneLayerCanvasDesign(undefined);
}

/**
 * The design resolution in pixels: the project's Custom Resolution when it is
 * on (each side rounded and clamped to 1..8192), else 1920 × 1080.
 */
export function sceneLayerDesignResolution(
  render?: { customResolution?: boolean; width?: number; height?: number } | null,
): { width: number; height: number } {
  if (!render?.customResolution) return { ...SCENE_LAYER_FALLBACK_RESOLUTION };
  const side = (value: unknown, fallback: number) =>
    typeof value === "number" && Number.isFinite(value) && value >= 1 ? Math.min(Math.round(value), 8192) : fallback;
  return {
    width: side(render.width, SCENE_LAYER_FALLBACK_RESOLUTION.width),
    height: side(render.height, SCENE_LAYER_FALLBACK_RESOLUTION.height),
  };
}

/** The canvas sizes in layer units: Fullscreen (the design resolution) and the Pixels Per Unit for Custom. */
export interface SceneLayerCanvasContext {
  /** The design resolution in pixels (`sceneLayerDesignResolution`). */
  resolution: { width: number; height: number };
  pixelsPerUnit: number;
}

function unitsPerPixel(context: SceneLayerCanvasContext): number {
  return 1 / positive(context.pixelsPerUnit, 100);
}

/** The Fullscreen canvas in layer units: the design resolution over Pixels Per Unit. */
export function sceneLayerFullscreenSize(context: SceneLayerCanvasContext): { width: number; height: number } {
  const unit = unitsPerPixel(context);
  return {
    width: positive(context.resolution.width, SCENE_LAYER_FALLBACK_RESOLUTION.width) * unit,
    height: positive(context.resolution.height, SCENE_LAYER_FALLBACK_RESOLUTION.height) * unit,
  };
}

/**
 * Centre of a `width` × `height` rectangle whose `anchor` point sits on the
 * origin (+X right, +Y up).
 */
export function sceneLayerAnchoredCenter(
  anchor: SceneLayerAnchor,
  width: number,
  height: number,
): [number, number] {
  const [x, y] = SCENE_LAYER_ANCHOR_ORIGIN[anchor] ?? SCENE_LAYER_ANCHOR_ORIGIN.center;
  // `+ 0` keeps a centred axis at 0 rather than -0.
  return [(-x * width) / 2 + 0, (-y * height) / 2 + 0];
}

/**
 * A canvas in layer units: Fullscreen or Custom hang from the origin at their
 * Root; Desired is the content's bounds wherever they are (null without
 * content).
 */
export function sceneLayerCanvasRect(
  design: SceneLayerFrameDesign,
  context: SceneLayerCanvasContext,
  contentBounds: SceneLayerContentBounds | null,
): SceneLayerRect | null {
  if (design.sizeMode === "desired") {
    if (!contentBounds) return null;
    return {
      width: Math.max(contentBounds.maxX - contentBounds.minX, 1e-3),
      height: Math.max(contentBounds.maxY - contentBounds.minY, 1e-3),
      center: [(contentBounds.minX + contentBounds.maxX) / 2, (contentBounds.minY + contentBounds.maxY) / 2],
    };
  }
  const unit = unitsPerPixel(context);
  const { width, height } = design.sizeMode === "custom"
    ? { width: design.customSizePx.width * unit, height: design.customSizePx.height * unit }
    : sceneLayerFullscreenSize(context);
  return { width, height, center: sceneLayerAnchoredCenter(design.rootAnchor, width, height) };
}

/**
 * Play's canvas for a layer: its rectangle, or for Desired without content the
 * Fullscreen canvas at its Root.
 */
export function sceneLayerPlayCanvas(
  design: SceneLayerFrameDesign,
  context: SceneLayerCanvasContext,
  contentBounds: SceneLayerContentBounds | null,
): SceneLayerRect {
  return sceneLayerCanvasRect(design, context, contentBounds)
    ?? sceneLayerCanvasRect({ ...design, sizeMode: "fullscreen" }, context, null)!;
}

/** `size` widened (or heightened) to `aspect`, so it stays whole at uniform scale. */
export function sceneLayerFitToAspect(
  size: { width: number; height: number },
  aspect: number,
): { width: number; height: number } {
  if (!Number.isFinite(aspect) || aspect <= 0 || !(size.width > 0) || !(size.height > 0)) {
    return { width: size.width, height: size.height };
  }
  return aspect >= size.width / size.height
    ? { width: size.height * aspect, height: size.height }
    : { width: size.width, height: size.width / aspect };
}

/**
 * The output in design pixels: the drawn framebuffer itself when a pixelated
 * framebuffer extends past the design size (each of its pixels is one design
 * pixel), else the design resolution widened to the output's aspect.
 */
export function sceneLayerOutputDesignSize(
  resolution: { width: number; height: number },
  output: { width: number; height: number },
  extendsDesignSize: boolean,
): { width: number; height: number } {
  if (extendsDesignSize && output.width > 0 && output.height > 0) return { width: output.width, height: output.height };
  return sceneLayerFitToAspect(resolution, output.width > 0 && output.height > 0 ? output.width / output.height : Number.NaN);
}

/**
 * What a layer's camera frames at zoom 1 and its Camera Location (0, 0), in
 * layer units. `screen` is the output in design pixels over Pixels Per Unit.
 * Fullscreen, and every mode with True Pixel Size, frame the screen at one
 * design pixel per pixel; Custom and Desired with Fit To Screen frame their
 * canvas widened to the screen's aspect. The canvas's Root lines up with the
 * same point of the screen (Center: centred; Top Left: in the top left corner).
 */
export function sceneLayerView(
  canvas: SceneLayerRect,
  design: Pick<SceneLayerCanvasDesign, "sizeMode" | "rootAnchor" | "scaling">,
  screen: { width: number; height: number } | null,
): SceneLayerRect {
  const reference = screen && screen.width > 0 && screen.height > 0 ? screen : null;
  const size = !reference
    ? { width: canvas.width, height: canvas.height }
    : design.sizeMode === "fullscreen" || design.scaling === "truePixelSize"
      ? { width: reference.width, height: reference.height }
      : sceneLayerFitToAspect(canvas, reference.width / reference.height);
  const [ax, ay] = SCENE_LAYER_ANCHOR_ORIGIN[design.rootAnchor] ?? SCENE_LAYER_ANCHOR_ORIGIN.center;
  return {
    width: size.width,
    height: size.height,
    center: [
      canvas.center[0] + (ax * (canvas.width - size.width)) / 2 + 0,
      canvas.center[1] + (ay * (canvas.height - size.height)) / 2 + 0,
    ],
  };
}

/**
 * The view 2D Anchors carry content onto: the layer's view while the canvas
 * fills it (Fullscreen, or Custom with Fit To Screen), else the canvas itself,
 * so nothing moves: a Custom canvas at its pixel size shows only itself, and a
 * Desired canvas is measured from its content, which anchors would move.
 */
export function sceneLayerAnchorView(
  canvas: SceneLayerRect,
  view: SceneLayerRect,
  design: Pick<SceneLayerCanvasDesign, "sizeMode" | "scaling">,
): SceneLayerRect {
  if (design.sizeMode === "desired") return canvas;
  if (design.sizeMode === "custom" && design.scaling === "truePixelSize") return canvas;
  return view;
}
