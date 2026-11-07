import { fitContainedRect, playFramebufferSize, presentedFramebufferStyle, type PlayContainer, type PlayOutputSettings } from "@haptic/core";

/** The Play overlay's box: what a pixelated framebuffer that extends past the design size fills. */
export function playOverlayContainer(overlay: HTMLElement): PlayContainer {
  return { width: overlay.clientWidth, height: overlay.clientHeight, devicePixelRatio: window.devicePixelRatio };
}

export function applyPlayPreviewCanvasLayout(options: {
  overlay: HTMLElement;
  canvas: HTMLCanvasElement;
  followSystem: boolean;
  aspectWidth: number;
  aspectHeight: number;
  render?: PlayOutputSettings | null;
  liveSize?: { width: number; height: number } | null;
}): void {
  const { overlay, canvas, followSystem, aspectWidth, aspectHeight } = options;
  const container = playOverlayContainer(overlay);
  const framebuffer = playFramebufferSize(options.render, options.liveSize, container);
  if (framebuffer) {
    overlay.classList.toggle("bg-black", true);
    overlay.classList.toggle("bg-background", false);
    overlay.classList.toggle("items-center", true);
    overlay.classList.toggle("justify-center", true);
    // A framebuffer extended past the design size covers the box by under one game pixel: crop it.
    overlay.classList.toggle("overflow-hidden", true);
    canvas.classList.toggle("h-full", false);
    canvas.classList.toggle("w-full", false);
    canvas.classList.toggle("shrink-0", true);
    const presented = presentedFramebufferStyle(options.render, framebuffer, container);
    canvas.style.width = `${presented.width}px`;
    canvas.style.height = `${presented.height}px`;
    canvas.style.imageRendering = presented.imageRendering;
    canvas.style.objectFit = "";
    return;
  }
  overlay.classList.toggle("overflow-hidden", false);
  canvas.classList.toggle("shrink-0", false);
  canvas.style.imageRendering = "";
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
