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
 * Locked custom-resolution size for letterbox present.
 * `blackBars: false` does not cap the buffer — the host fills and cameras
 * follow the live aspect. A live `setRenderResolution` override still locks.
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
    return { width: Math.round(liveSize.width), height: Math.round(liveSize.height) };
  }
  if (!render?.customResolution || !render.blackBars) return null;
  const width = render.width > 0 ? Math.round(render.width) : 1920;
  const height = render.height > 0 ? Math.round(render.height) : 1080;
  return { width, height };
}

export function clampRenderResolution(value: number): number {
  if (!Number.isFinite(value) || value < 1) return 1;
  return Math.min(Math.round(value), 8192);
}
