import { ShaderStore } from "@babylonjs/core/Engines/shaderStore";
import "@babylonjs/core/Shaders/ShadersInclude/shadowMapVertexMetric";

/**
 * Debug (`shadowdebug depthclamp off`): a sun cascade clamps the casters in front of its near plane in the vertex stage.
 *
 * A cascade's projection is fitted to its slice of the view, so casters between the sun and that slice lie in front of
 * its near plane. Babylon keeps them (`depthClamp`, `SM_DEPTHCLAMP 1`) by placing every vertex on the near plane and
 * writing the real, clamped depth with `gl_FragDepth` in the fragment stage. A fragment shader that writes depth cannot
 * be depth-tested before it runs, which a tile-based GPU pays for on every caster fragment.
 *
 * `SM_DEPTHCLAMP 2` clamps each vertex's depth to the near plane instead and leaves the depth to the rasteriser. It is
 * exact for a triangle wholly in front of the plane or wholly behind it. A triangle that crosses the plane differs:
 * its clamped part is flat on the plane in both, but the depth interpolated across the rest starts from the clamped
 * vertex, not from where the triangle really crosses, so it reads slightly nearer the sun there.
 *
 * The addition sits behind a define value Babylon never emits, so every other depth program compiles as before.
 */
export const SHADOW_FRAGMENT_CLAMP_DEFINE = "#define SM_DEPTHCLAMP 1";
export const SHADOW_VERTEX_CLAMP_DEFINE = "#define SM_DEPTHCLAMP 2";

const MARK = "SM_DEPTHCLAMP==2";
const VERTEX_CLAMP = `#if defined(SM_DEPTHCLAMP) && ${MARK}
#ifdef USE_REVERSE_DEPTHBUFFER
gl_Position.z=min(gl_Position.z,gl_Position.w);
#elif defined(IS_NDC_HALF_ZRANGE)
gl_Position.z=max(gl_Position.z,0.0);
#else
gl_Position.z=max(gl_Position.z,-gl_Position.w);
#endif
#endif
`;

const includes = ShaderStore.IncludesShadersStore;
const metric = includes.shadowMapVertexMetric;
if (metric !== undefined && !metric.includes(MARK)) includes.shadowMapVertexMetric = `${metric}${VERTEX_CLAMP}`;

/** `defines` with the fragment-stage clamp replaced by the vertex-stage one, in place. */
export function applyVertexDepthClamp(defines: string[]): void {
  const index = defines.indexOf(SHADOW_FRAGMENT_CLAMP_DEFINE);
  if (index >= 0) defines[index] = SHADOW_VERTEX_CLAMP_DEFINE;
}
