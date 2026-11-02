export function fitContainedRect(
  containerWidth: number,
  containerHeight: number,
  aspectWidth: number,
  aspectHeight: number,
): { width: number; height: number } {
  if (
    containerWidth <= 0 ||
    containerHeight <= 0 ||
    aspectWidth <= 0 ||
    aspectHeight <= 0
  ) {
    return { width: 0, height: 0 };
  }
  const target = aspectWidth / aspectHeight;
  const container = containerWidth / containerHeight;
  if (container > target) {
    const height = containerHeight;
    return { width: Math.round(height * target), height };
  }
  const width = containerWidth;
  return { width, height: Math.round(width / target) };
}

/** The render settings that decide how Play presents its framebuffer. */
export type PlayOutputSettings = {
  customResolution: boolean;
  width: number;
  height: number;
  blackBars: boolean;
  upscaling?: "smooth" | "pixelated";
};

/** A host box in CSS pixels and its device pixel ratio. */
export type PlayContainer = { width: number; height: number; devicePixelRatio?: number };

/** The design size, each side clamped to 1..8192 (1920 x 1080 when unset). */
function designSize(render: PlayOutputSettings): { width: number; height: number } {
  return {
    width: render.width > 0 ? clampRenderResolution(render.width) : 1920,
    height: render.height > 0 ? clampRenderResolution(render.height) : 1080,
  };
}

/** The largest whole multiple of `frame` that fits the container in device pixels (0 when it does not fit once). */
function wholeMultiple(container: PlayContainer, frame: { width: number; height: number }): number {
  const ratio = container.devicePixelRatio && container.devicePixelRatio > 0 ? container.devicePixelRatio : 1;
  if (container.width <= 0 || container.height <= 0 || frame.width <= 0 || frame.height <= 0) return 0;
  return Math.floor(Math.min((container.width * ratio) / frame.width, (container.height * ratio) / frame.height));
}

/** Whether Play enlarges its design size pixelated (Upscaling: Pixelated with Custom Resolution), with or without bars. */
export function pixelatedUpscaling(render?: PlayOutputSettings | null): boolean {
  return !!render?.customResolution && render.upscaling === "pixelated";
}

/**
 * Pixelated without Black Bars: the design size is enlarged by the largest whole multiple that fits, and the
 * framebuffer extends past it on whichever sides would show bars, so the view fills the window without stretching.
 */
export function pixelatedExtend(render?: PlayOutputSettings | null): boolean {
  return pixelatedUpscaling(render) && !render!.blackBars;
}

/**
 * Play's locked framebuffer, each side clamped to 1..8192 like a live override, or null when the host fills at the
 * window size (cameras follow the live aspect). A live Scalability Set Render Resolution override locks; Black Bars
 * lock the design size; Pixelated without Black Bars locks the window's device pixels divided by the whole multiple
 * (`pixelatedExtend`), which needs the `container` (null without one: the caller sizes it once it has one).
 */
export function playFramebufferSize(
  render?: PlayOutputSettings | null,
  liveSize?: { width: number; height: number } | null,
  container?: PlayContainer | null,
): { width: number; height: number } | null {
  if (liveSize && liveSize.width > 0 && liveSize.height > 0) {
    return { width: clampRenderResolution(liveSize.width), height: clampRenderResolution(liveSize.height) };
  }
  if (!render?.customResolution) return null;
  const design = designSize(render);
  if (render.blackBars) return design;
  if (!pixelatedExtend(render) || !container) return null;
  const multiple = wholeMultiple(container, design);
  // A window smaller than the design size shows it fitted, as Black Bars would.
  if (multiple < 1) return design;
  const ratio = container.devicePixelRatio && container.devicePixelRatio > 0 ? container.devicePixelRatio : 1;
  return {
    width: clampRenderResolution(Math.ceil((container.width * ratio) / multiple)),
    height: clampRenderResolution(Math.ceil((container.height * ratio) / multiple)),
  };
}

/**
 * How much more world an extended framebuffer shows than the design size, vertically (1 unless `pixelatedExtend`):
 * cameras widen their lens by it, so the design size keeps its scale and the extra rows show more of the scene.
 */
export function pixelatedLensExtent(render: PlayOutputSettings | null | undefined, framebuffer: { height: number }): number {
  if (!pixelatedExtend(render) || framebuffer.height <= 0) return 1;
  return Math.max(1, framebuffer.height / designSize(render!).height);
}

/**
 * The CSS size that shows a `width` x `height` frame at the largest whole multiple of its size in device pixels that
 * fits the container, so every frame pixel covers the same square of screen pixels. A container smaller than the frame
 * fits it as `fitContainedRect` does.
 */
export function fitWholeMultipleRect(
  containerWidth: number,
  containerHeight: number,
  width: number,
  height: number,
  devicePixelRatio = 1,
): { width: number; height: number } {
  const ratio = devicePixelRatio > 0 ? devicePixelRatio : 1;
  const multiple = wholeMultiple({ width: containerWidth, height: containerHeight, devicePixelRatio: ratio }, { width, height });
  if (containerWidth <= 0 || containerHeight <= 0 || width <= 0 || height <= 0) return { width: 0, height: 0 };
  if (multiple < 1) return fitContainedRect(containerWidth, containerHeight, width, height);
  return { width: (multiple * width) / ratio, height: (multiple * height) / ratio };
}

/**
 * The CSS size and `image-rendering` that present a locked framebuffer in a container. Pixelated shows it at a whole
 * multiple: of itself with Black Bars, of the design size when it extends past it (`pixelatedExtend`), so its CSS
 * size covers the container by less than one game pixel and the host crops the rest.
 */
export function presentedFramebufferStyle(
  render: PlayOutputSettings | null | undefined,
  framebuffer: { width: number; height: number },
  container: PlayContainer,
): { width: number; height: number; imageRendering: "" | "pixelated" } {
  if (!pixelatedUpscaling(render)) {
    return { ...fitContainedRect(container.width, container.height, framebuffer.width, framebuffer.height), imageRendering: "" };
  }
  const ratio = container.devicePixelRatio && container.devicePixelRatio > 0 ? container.devicePixelRatio : 1;
  const base = pixelatedExtend(render) ? designSize(render!) : framebuffer;
  const multiple = wholeMultiple(container, base);
  if (multiple < 1) {
    return { ...fitContainedRect(container.width, container.height, framebuffer.width, framebuffer.height), imageRendering: "pixelated" };
  }
  return { width: (multiple * framebuffer.width) / ratio, height: (multiple * framebuffer.height) / ratio, imageRendering: "pixelated" };
}

export function clampRenderResolution(value: number): number {
  if (!Number.isFinite(value) || value < 1) return 1;
  return Math.min(Math.round(value), 8192);
}
