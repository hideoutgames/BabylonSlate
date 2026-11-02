import {
  playFramebufferSize,
  presentedFramebufferStyle,
  type RenderProjectSettings,
} from "@haptic/core";

export function applyPlayerLayout(options: {
  root: HTMLElement;
  canvas: HTMLCanvasElement;
  render: RenderProjectSettings;
}): { width: number; height: number } | null {
  const framebuffer = playFramebufferSize(options.render);
  if (!framebuffer) {
    options.root.style.background = options.render.blackBars ? "#000" : "#111";
    options.canvas.style.width = "100%";
    options.canvas.style.height = "100%";
    options.canvas.style.imageRendering = "";
    return null;
  }
  options.root.style.background = "#000";
  const presented = presentedFramebufferStyle(options.render, framebuffer, {
    width: options.root.clientWidth || window.innerWidth,
    height: options.root.clientHeight || window.innerHeight,
  }, globalThis.devicePixelRatio ?? 1);
  options.canvas.style.width = `${presented.width}px`;
  options.canvas.style.height = `${presented.height}px`;
  options.canvas.style.imageRendering = presented.imageRendering;
  return framebuffer;
}
