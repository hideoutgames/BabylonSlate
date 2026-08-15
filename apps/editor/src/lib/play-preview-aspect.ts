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
