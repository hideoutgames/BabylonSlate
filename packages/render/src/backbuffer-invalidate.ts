import type { AbstractEngine } from "@babylonjs/core/Engines/abstractEngine";

type WebGlEngine = AbstractEngine & {
  _gl?: WebGL2RenderingContext;
  _currentFramebuffer?: WebGLFramebuffer | null;
  webGLVersion?: number;
};

/**
 * Debug (`backbufferdiscard on`): tells the driver the backbuffer's depth and stencil are not needed after this frame,
 * so a tile-based GPU need not store them when the backbuffer's pass ends (the context keeps its drawing buffer, depth
 * and stencil included, between frames otherwise). It must run while the backbuffer is still the bound framebuffer and
 * its pass is open: right after the frame's last draw into it, before anything binds another framebuffer. Their
 * contents are undefined afterwards, so every later frame must clear them before it reads them.
 *
 * False, and nothing done, on WebGL1 or while Babylon has another framebuffer bound.
 */
export function invalidateBackbufferDepthStencil(engine: AbstractEngine): boolean {
  const native = engine as WebGlEngine;
  const gl = native._gl;
  if (!gl || native.webGLVersion !== 2 || typeof gl.invalidateFramebuffer !== "function") return false;
  // Babylon caches the FRAMEBUFFER binding: null is the default framebuffer.
  if (native._currentFramebuffer) return false;
  // The default framebuffer's attachments are named DEPTH and STENCIL, not DEPTH_ATTACHMENT.
  gl.invalidateFramebuffer(gl.FRAMEBUFFER, [gl.DEPTH, gl.STENCIL]);
  return true;
}
