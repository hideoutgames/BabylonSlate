import type { AbstractEngine } from "@babylonjs/core/Engines/abstractEngine";
import { ShaderStore } from "@babylonjs/core/Engines/shaderStore";
import "@babylonjs/core/Shaders/ShadersInclude/shadowMapVertexMetric";

/**
 * How a sun cascade keeps the casters in front of its near plane without writing depth from the fragment stage.
 *
 * A cascade's projection is fitted to its slice of the view, so casters between the sun and that slice lie in front of
 * its near plane. Babylon keeps them (`depthClamp`, `SM_DEPTHCLAMP 1`) by placing every vertex on the near plane and
 * writing the real, clamped depth with `gl_FragDepth` in the fragment stage. A fragment shader that writes depth cannot
 * be depth-tested before it runs, and on a tile-based GPU it turns off hidden-surface removal for every caster fragment.
 *
 * `SM_DEPTHCLAMP 3` (where the context has `EXT_depth_clamp`): the vertex stage writes the depth Babylon's fragment stage
 * would (its depth metric, affine in clip z, so interpolating it across the triangle is the same), and the rasteriser's
 * depth clamp keeps a fragment in front of the near plane at depth 0 instead of clipping it, as `clamp` did. The stored
 * depth is the same up to float rounding, triangles crossing the near plane included. `cascadeDepthClamp` turns the
 * clamp on for the cascade passes only: anywhere else it would draw what the camera's near plane cuts away.
 *
 * Debug (`shadowdebug depthclamp off`), `SM_DEPTHCLAMP 2`: each vertex's depth clamped to the near plane, the depth
 * left to the rasteriser without the extension. It is exact for a triangle wholly in front of the plane or wholly
 * behind it; a triangle that crosses the plane reads slightly nearer the sun past the crossing.
 *
 * Both sit behind define values Babylon never emits, so every other depth program compiles as before.
 */
export const SHADOW_FRAGMENT_CLAMP_DEFINE = "#define SM_DEPTHCLAMP 1";
export const SHADOW_VERTEX_CLAMP_DEFINE = "#define SM_DEPTHCLAMP 2";
export const SHADOW_RASTER_CLAMP_DEFINE = "#define SM_DEPTHCLAMP 3";

const MARK = "SM_DEPTHCLAMP==2";
const VERTEX_CLAMP = `#if defined(SM_DEPTHCLAMP) && ${MARK}
#ifdef USE_REVERSE_DEPTHBUFFER
gl_Position.z=min(gl_Position.z,gl_Position.w);
#elif defined(IS_NDC_HALF_ZRANGE)
gl_Position.z=max(gl_Position.z,0.0);
#else
gl_Position.z=max(gl_Position.z,-gl_Position.w);
#endif
#elif defined(SM_DEPTHCLAMP) && SM_DEPTHCLAMP==3 && SM_USEDISTANCE==0
#ifdef USE_REVERSE_DEPTHBUFFER
gl_Position.z=(1.0-2.0*vDepthMetricSM)*gl_Position.w;
#elif defined(IS_NDC_HALF_ZRANGE)
gl_Position.z=vDepthMetricSM*gl_Position.w;
#else
gl_Position.z=(vDepthMetricSM*2.0-1.0)*gl_Position.w;
#endif
#endif
`;

const includes = ShaderStore.IncludesShadersStore;
const metric = includes.shadowMapVertexMetric;
if (metric !== undefined && !metric.includes(MARK)) includes.shadowMapVertexMetric = `${metric}${VERTEX_CLAMP}`;

/** `defines` with the fragment-stage clamp replaced by `replacement`, in place. */
function replaceClamp(defines: string[], replacement: string): void {
  const index = defines.indexOf(SHADOW_FRAGMENT_CLAMP_DEFINE);
  if (index >= 0) defines[index] = replacement;
}

/** `defines` with the fragment-stage clamp replaced by the vertex-stage one, in place (`shadowdebug depthclamp off`). */
export function applyVertexDepthClamp(defines: string[]): void {
  replaceClamp(defines, SHADOW_VERTEX_CLAMP_DEFINE);
}

/** `defines` with the fragment-stage clamp replaced by the rasteriser's (`SM_DEPTHCLAMP 3`), in place. */
export function applyRasterDepthClamp(defines: string[]): void {
  replaceClamp(defines, SHADOW_RASTER_CLAMP_DEFINE);
}

type ClampEngine = AbstractEngine & { _gl?: WebGL2RenderingContext };
/** Per Engine, its `EXT_depth_clamp` enum, or null without the extension. */
const clampEnums = new WeakMap<AbstractEngine, number | null>();

/** `DEPTH_CLAMP_EXT` of `engine`'s context, or null where it has no `EXT_depth_clamp` (or no WebGL context). */
function depthClampEnum(engine: AbstractEngine): number | null {
  let value = clampEnums.get(engine);
  if (value === undefined) {
    const extension = (engine as ClampEngine)._gl?.getExtension?.("EXT_depth_clamp") as { DEPTH_CLAMP_EXT: number } | null | undefined;
    value = extension ? extension.DEPTH_CLAMP_EXT : null;
    clampEnums.set(engine, value);
  }
  return value;
}

/** Whether `engine` clamps cascade depth in the rasteriser (`SM_DEPTHCLAMP 3`): its context has `EXT_depth_clamp`. */
export function rasterDepthClampAvailable(engine: AbstractEngine): boolean {
  return depthClampEnum(engine) !== null;
}

/** Turns the rasteriser's depth clamp on or off for `engine` (`EXT_depth_clamp`); nothing without the extension. */
export function cascadeDepthClamp(engine: AbstractEngine, on: boolean): void {
  const clamp = depthClampEnum(engine);
  const gl = (engine as ClampEngine)._gl;
  if (clamp === null || !gl) return;
  if (on) gl.enable(clamp); else gl.disable(clamp);
}
