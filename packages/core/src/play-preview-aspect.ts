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

/**
 * Locked custom-resolution size for letterbox present, each side clamped to
 * 1..8192 like a live override. `blackBars: false` does not cap the buffer —
 * the host fills and cameras follow the live aspect. A live Scalability Set
 * Render Resolution override still locks.
 */
export function playFramebufferSize(
  render?: {
    customResolution: boolean;
    width: number;
    height: number;
    blackBars: boolean;
  } | null,
  liveSize?: { width: number; height: number } | null,
): { width: number; height: number } | null {
  if (liveSize && liveSize.width > 0 && liveSize.height > 0) {
    return { width: clampRenderResolution(liveSize.width), height: clampRenderResolution(liveSize.height) };
  }
  if (!render?.customResolution || !render.blackBars) return null;
  const width = render.width > 0 ? clampRenderResolution(render.width) : 1920;
  const height = render.height > 0 ? clampRenderResolution(render.height) : 1080;
  return { width, height };
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
  if (containerWidth <= 0 || containerHeight <= 0 || width <= 0 || height <= 0) return { width: 0, height: 0 };
  const multiple = Math.floor(Math.min((containerWidth * ratio) / width, (containerHeight * ratio) / height));
  if (multiple < 1) return fitContainedRect(containerWidth, containerHeight, width, height);
  return { width: (multiple * width) / ratio, height: (multiple * height) / ratio };
}

/** Whether a locked design size reaches the screen pixelated (Upscaling: Pixelated, with Custom Resolution and Black Bars). */
export function pixelatedUpscaling(
  render?: { customResolution: boolean; blackBars: boolean; upscaling?: "smooth" | "pixelated" } | null,
): boolean {
  return !!render?.customResolution && render.blackBars && render.upscaling === "pixelated";
}

/** The CSS size and `image-rendering` that present a locked framebuffer in a container. */
export function presentedFramebufferStyle(
  render: Parameters<typeof pixelatedUpscaling>[0],
  framebuffer: { width: number; height: number },
  container: { width: number; height: number },
  devicePixelRatio = 1,
): { width: number; height: number; imageRendering: "" | "pixelated" } {
  const pixelated = pixelatedUpscaling(render);
  const fitted = pixelated
    ? fitWholeMultipleRect(container.width, container.height, framebuffer.width, framebuffer.height, devicePixelRatio)
    : fitContainedRect(container.width, container.height, framebuffer.width, framebuffer.height);
  return { ...fitted, imageRendering: pixelated ? "pixelated" : "" };
}

export function clampRenderResolution(value: number): number {
  if (!Number.isFinite(value) || value < 1) return 1;
  return Math.min(Math.round(value), 8192);
}
