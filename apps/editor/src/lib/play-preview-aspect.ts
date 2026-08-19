import { fitContainedRect, playFramebufferSize } from "@babylonslate/core";

export {
  clampRenderResolution,
  fitContainedRect,
  playFramebufferSize,
} from "@babylonslate/core";

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
    overlay.classList.toggle("bg-black", true);
    overlay.classList.toggle("bg-background", false);
    overlay.classList.toggle("items-center", true);
    overlay.classList.toggle("justify-center", true);
    canvas.classList.toggle("h-full", false);
    canvas.classList.toggle("w-full", false);
    const fitted = fitContainedRect(
      overlay.clientWidth,
      overlay.clientHeight,
      framebuffer.width,
      framebuffer.height,
    );
    canvas.style.width = `${fitted.width}px`;
    canvas.style.height = `${fitted.height}px`;
    canvas.style.objectFit = "";
    return;
  }
  const fillHost = followSystem || options.render?.customResolution === true;
  overlay.classList.toggle("bg-black", !fillHost);
  overlay.classList.toggle("bg-background", fillHost);
  overlay.classList.toggle("items-center", !fillHost);
  overlay.classList.toggle("justify-center", !fillHost);
  canvas.classList.toggle("h-full", fillHost);
  canvas.classList.toggle("w-full", fillHost);
  canvas.style.objectFit = "";
  if (fillHost) {
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
