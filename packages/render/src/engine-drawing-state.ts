import type { AbstractEngine } from "@babylonjs/core/Engines/abstractEngine";
import type { RenderTargetWrapper } from "@babylonjs/core/Engines/renderTargetWrapper";
import type { ThinEngine } from "@babylonjs/core/Engines/thinEngine";
import type { IViewportLike } from "@babylonjs/core/Maths/math.like";
import type { Nullable } from "@babylonjs/core/types";

/**
 * Engine state an owned pass changes: framebuffer attachment (WebGL framebuffer), viewport, depth/cull, stencil, alpha
 * and colour write. Reusable, so passes that run every frame save without allocating.
 */
interface EngineDrawingState {
  viewport: Nullable<IViewportLike>;
  width: number;
  height: number;
  target: Nullable<RenderTargetWrapper>;
  framebuffer: WebGLFramebuffer | null | undefined;
  depthTest: boolean;
  depthMask: boolean;
  depthFunc: Nullable<number>;
  cull: Nullable<boolean>;
  cullFace: Nullable<number>;
  frontFace: Nullable<number>;
  zOffset: number;
  zOffsetUnits: number;
  stencilTest: boolean;
  stencilMaterial: unknown;
  alpha: number;
  color: boolean;
}

export function createEngineDrawingState(): EngineDrawingState {
  return {
    viewport: null, width: 0, height: 0, target: null, framebuffer: undefined,
    depthTest: false, depthMask: false, depthFunc: null, cull: null, cullFace: null, frontFace: null, zOffset: 0, zOffsetUnits: 0,
    stencilTest: false, stencilMaterial: undefined, alpha: 0, color: true,
  };
}

/** Fallback when no viewport was cached; never mutated. */
const FULL_VIEWPORT: IViewportLike = Object.freeze({ x: 0, y: 0, width: 1, height: 1 });

/**
 * Pinned 9.29 adapter: records the exact framebuffer attachment and render state. Keeps the engine's own viewport
 * object (never copied or mutated), so a caller holding that reference still sees its values.
 */
export function saveEngineDrawingState(engine: AbstractEngine, state: EngineDrawingState): void {
  state.viewport = engine.currentViewport;
  state.width = engine.getRenderWidth();
  state.height = engine.getRenderHeight();
  state.target = engine._currentRenderTarget;
  state.framebuffer = (engine as ThinEngine)._currentFramebuffer;
  const depth = engine.depthCullingState;
  state.depthTest = depth.depthTest;
  state.depthMask = depth.depthMask;
  state.depthFunc = depth.depthFunc;
  state.cull = depth.cull;
  state.cullFace = depth.cullFace;
  state.frontFace = depth.frontFace;
  state.zOffset = depth.zOffset;
  state.zOffsetUnits = depth.zOffsetUnits;
  state.stencilTest = engine.stencilState.stencilTest;
  state.stencilMaterial = engine.stencilStateComposer.stencilMaterial;
  // Babylon reports -1 after a cache reset (wipeCaches(true), context restore) while blending is off; handing that
  // sentinel back to setAlphaMode would enable blending with stale factors, so it restores as ALPHA_DISABLE.
  state.alpha = Math.max(0, engine.getAlphaMode());
  state.color = engine.getColorWrite();
}

/** Rebinds the recorded attachment and restores the recorded render state, then resets the engine's state caches. */
export function restoreEngineDrawingState(engine: AbstractEngine, state: EngineDrawingState): void {
  const target = state.target;
  (engine as ThinEngine)._bindUnboundFramebuffer(state.framebuffer ?? null);
  engine._currentRenderTarget = target;
  engine.setViewport(state.viewport ?? FULL_VIEWPORT, state.width, state.height);
  engine.setAlphaMode(state.alpha);
  engine.setColorWrite(state.color);
  const depth = engine.depthCullingState;
  depth.depthTest = state.depthTest;
  depth.depthMask = state.depthMask;
  depth.depthFunc = state.depthFunc;
  depth.cull = state.cull;
  // Babylon holds null until the first draw sets a face; assigning null over a set value would mark it dirty and
  // `apply` would pass null to gl.cullFace / gl.frontFace (GL_INVALID_ENUM). Unset is left as is.
  if (state.cullFace !== null) depth.cullFace = state.cullFace;
  if (state.frontFace !== null) depth.frontFace = state.frontFace;
  depth.zOffset = state.zOffset;
  depth.zOffsetUnits = state.zOffsetUnits;
  engine.stencilState.stencilTest = state.stencilTest;
  engine.stencilStateComposer.stencilMaterial = state.stencilMaterial as typeof engine.stencilStateComposer.stencilMaterial;
  engine.wipeCaches();
}

/** Runs `draw` and restores the engine's attachment and render state afterwards, even when `draw` throws. */
export function withDrawingState<T>(engine: AbstractEngine, draw: () => T): T {
  const state = createEngineDrawingState();
  saveEngineDrawingState(engine, state);
  try {
    return draw();
  } finally {
    restoreEngineDrawingState(engine, state);
  }
}
