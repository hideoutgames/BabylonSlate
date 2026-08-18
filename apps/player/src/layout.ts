import {
  fitContainedRect,
  playFramebufferSize,
  type RenderProjectSettings,
} from "@babylonslate/core";

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
    options.canvas.style.objectFit = "";
    return null;
  }
  options.root.style.background = "#000";
  const fitted = fitContainedRect(
    options.root.clientWidth || window.innerWidth,
    options.root.clientHeight || window.innerHeight,
    framebuffer.width,
    framebuffer.height,
  );
  options.canvas.style.width = `${fitted.width}px`;
  options.canvas.style.height = `${fitted.height}px`;
  options.canvas.style.objectFit = "";
  return framebuffer;
}
