import {
  playFramebufferSize,
  presentedFramebufferStyle,
  type PlayContainer,
  type RenderProjectSettings,
} from "@haptic/core";

/** The player root's box: what a pixelated framebuffer that extends past the design size fills. */
export function playerContainer(root: HTMLElement): PlayContainer {
  return {
    width: root.clientWidth || globalThis.innerWidth || 0,
    height: root.clientHeight || globalThis.innerHeight || 0,
    devicePixelRatio: globalThis.devicePixelRatio ?? 1,
  };
}

export function applyPlayerLayout(options: {
  root: HTMLElement;
  canvas: HTMLCanvasElement;
  render: RenderProjectSettings;
}): { width: number; height: number } | null {
  const container = playerContainer(options.root);
  const framebuffer = playFramebufferSize(options.render, null, container);
  if (!framebuffer) {
    options.root.style.background = options.render.blackBars ? "#000" : "#111";
    options.canvas.style.width = "100%";
    options.canvas.style.height = "100%";
    options.canvas.style.imageRendering = "";
    return null;
  }
  options.root.style.background = "#000";
  const presented = presentedFramebufferStyle(options.render, framebuffer, container);
  options.canvas.style.width = `${presented.width}px`;
  options.canvas.style.height = `${presented.height}px`;
  options.canvas.style.imageRendering = presented.imageRendering;
  return framebuffer;
}
