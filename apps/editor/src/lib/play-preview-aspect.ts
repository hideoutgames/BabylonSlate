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

export function applyPlayPreviewCanvasLayout(options: {
  overlay: HTMLElement;
  canvas: HTMLCanvasElement;
  followSystem: boolean;
  aspectWidth: number;
  aspectHeight: number;
  render?: {
    customResolution: boolean;
    width: number;
    height: number;
    blackBars: boolean;
  } | null;
  liveSize?: { width: number; height: number } | null;
}): void {
  const { overlay, canvas, followSystem, aspectWidth, aspectHeight } = options;
  const framebuffer = playFramebufferSize(options.render, options.liveSize);
  if (framebuffer) {
    const blackBars = options.render?.blackBars === true;
    overlay.classList.toggle("bg-black", blackBars);
    overlay.classList.toggle("bg-background", !blackBars);
    overlay.classList.toggle("items-center", true);
    overlay.classList.toggle("justify-center", true);
    canvas.classList.toggle("h-full", false);
    canvas.classList.toggle("w-full", false);
    if (blackBars) {
      const fitted = fitContainedRect(
        overlay.clientWidth,
        overlay.clientHeight,
        framebuffer.width,
        framebuffer.height,
      );
      canvas.style.width = `${fitted.width}px`;
      canvas.style.height = `${fitted.height}px`;
      canvas.style.objectFit = "";
    } else {
      canvas.style.width = "100%";
      canvas.style.height = "100%";
      canvas.style.objectFit = "fill";
    }
    return;
  }
  overlay.classList.toggle("bg-black", !followSystem);
  overlay.classList.toggle("bg-background", followSystem);
  overlay.classList.toggle("items-center", !followSystem);
  overlay.classList.toggle("justify-center", !followSystem);
  canvas.classList.toggle("h-full", followSystem);
  canvas.classList.toggle("w-full", followSystem);
  canvas.style.objectFit = "";
  if (followSystem) {
    canvas.style.width = "";
    canvas.style.height = "";
    return;
  }
  const fitted = fitContainedRect(
    overlay.clientWidth,
    overlay.clientHeight,
    aspectWidth,
    aspectHeight,
  );
  canvas.style.width = `${fitted.width}px`;
  canvas.style.height = `${fitted.height}px`;
}

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
  if (!render?.customResolution) return null;
  const width = render.width > 0 ? Math.round(render.width) : 1920;
  const height = render.height > 0 ? Math.round(render.height) : 1080;
  return { width, height };
}

export function clampRenderResolution(value: number): number {
  if (!Number.isFinite(value) || value < 1) return 1;
  return Math.min(Math.round(value), 8192);
}
