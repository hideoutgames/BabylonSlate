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
  options.root.style.background = options.render.blackBars ? "#000" : "#111";
  if (!framebuffer) {
    options.canvas.style.width = "100%";
    options.canvas.style.height = "100%";
    options.canvas.style.objectFit = "";
    return null;
  }
  if (options.render.blackBars) {
    const fitted = fitContainedRect(
      options.root.clientWidth || window.innerWidth,
      options.root.clientHeight || window.innerHeight,
      framebuffer.width,
      framebuffer.height,
    );
    options.canvas.style.width = `${fitted.width}px`;
    options.canvas.style.height = `${fitted.height}px`;
    options.canvas.style.objectFit = "";
  } else {
    options.canvas.style.width = "100%";
    options.canvas.style.height = "100%";
    options.canvas.style.objectFit = "fill";
  }
  return framebuffer;
}
