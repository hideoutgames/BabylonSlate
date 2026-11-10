import type { Camera } from "@babylonjs/core/Cameras/camera";
import type { AbstractEngine } from "@babylonjs/core/Engines/abstractEngine";
import { Constants } from "@babylonjs/core/Engines/constants";
import { ShaderStore } from "@babylonjs/core/Engines/shaderStore";
import type { FrameGraphRenderContext } from "@babylonjs/core/FrameGraph/frameGraphRenderContext";
import type { FrameGraphTextureHandle } from "@babylonjs/core/FrameGraph/frameGraphTypes";
import { Texture } from "@babylonjs/core/Materials/Textures/texture";
import type { Effect } from "@babylonjs/core/Materials/effect";
import { EffectWrapper } from "@babylonjs/core/Materials/effectRenderer";
import { ShaderLanguage } from "@babylonjs/core/Materials/shaderLanguage";
import { Matrix } from "@babylonjs/core/Maths/math.vector";
import "@babylonjs/core/Shaders/postprocess.vertex";
// The WGSL twin registers with the WebGPU Engine's code (webgpu-registrations).

/**
 * A geometry pass whose only attachment is the view depth, seeded from the scene's depth: one full-screen draw writes
 * each pixel's view depth, computed from the depth the view's object pass stored, and that depth itself, so the pass
 * then draws only the meshes that depth lacks (blended surfaces, drawn over it as they always were) instead of the
 * whole scene again. A pixel the object pass left clear takes the pass's far value (`far`), as its own clear gives it.
 */
export const GEOMETRY_DEPTH_SEED_SHADER = "hapticGeometryDepthSeed";

function registerGeometryDepthSeedShader(webgpu: boolean): void {
  ShaderStore.ShadersStore[`${GEOMETRY_DEPTH_SEED_SHADER}PixelShader`] = `
varying vec2 vUV;
uniform sampler2D sceneDepth;
uniform mat4 inverseProjection;
// The raw depth's scale and offset to clip space, and the view depth of a pixel nothing drew.
uniform vec3 depthRange;
uniform float reverseDepth;
void main(void) {
  float raw = texture2DLodEXT(sceneDepth, vUV, 0.0).r;
  float clear = reverseDepth > 0.5 ? step(raw, 0.0) : step(1.0, raw);
  vec4 view = inverseProjection * vec4(vUV * 2.0 - 1.0, raw * depthRange.x + depthRange.y, 1.0);
  float w = abs(view.w) > 1e-8 ? view.w : 1e-8;
  // Positive distance along the view axis for either handedness.
  float viewZ = min(abs(view.z / w), depthRange.z);
  gl_FragColor = vec4(mix(viewZ, depthRange.z, clear), 0.0, 0.0, 1.0);
  gl_FragDepth = raw;
}`;
  if (webgpu)
    ShaderStore.ShadersStoreWGSL[`${GEOMETRY_DEPTH_SEED_SHADER}PixelShader`] = `
varying vUV: vec2f;
var sceneDepthSampler: sampler; var sceneDepth: texture_2d<f32>;
uniform inverseProjection: mat4x4f;
uniform depthRange: vec3f;
uniform reverseDepth: f32;
@fragment
fn main(input: FragmentInputs) -> FragmentOutputs {
  let uv = fragmentInputs.vUV;
  let raw = textureSampleLevel(sceneDepth, sceneDepthSampler, uv, 0.0).r;
  let clear = select(step(1.0, raw), step(raw, 0.0), uniforms.reverseDepth > 0.5);
  let view = uniforms.inverseProjection * vec4f(uv * 2.0 - 1.0, raw * uniforms.depthRange.x + uniforms.depthRange.y, 1.0);
  let w = select(1e-8, view.w, abs(view.w) > 1e-8);
  let viewZ = min(abs(view.z / w), uniforms.depthRange.z);
  fragmentOutputs.color = vec4f(mix(viewZ, uniforms.depthRange.z, clear), 0.0, 0.0, 1.0);
  fragmentOutputs.fragDepth = raw;
}`;
}

/** The scene depth a geometry pass starts from, and the effect that copies it in. */
export interface GeometryDepthSeed {
  /** The view's scene depth as its object pass left it, single-sample (resolved where that pass is multisampled). */
  readonly depth: FrameGraphTextureHandle;
  readonly wrapper: EffectWrapper;
}

export function createGeometryDepthSeed(
  engine: AbstractEngine, name: string, depth: FrameGraphTextureHandle, onError: (effect: Effect, errors: string) => void,
): GeometryDepthSeed {
  registerGeometryDepthSeedShader(engine.isWebGPU);
  return {
    depth,
    wrapper: new EffectWrapper({
      name, engine, useShaderStore: true,
      fragmentShader: GEOMETRY_DEPTH_SEED_SHADER,
      uniformNames: ["inverseProjection", "depthRange", "reverseDepth"], samplerNames: ["sceneDepth"],
      shaderLanguage: engine.isWebGPU ? ShaderLanguage.WGSL : ShaderLanguage.GLSL,
      onError,
    }),
  };
}

const inverseProjection = Matrix.Identity();

/**
 * Draws `seed` into the bound geometry target: the view depth into its colour and the scene's depth into its depth.
 * `far` is the view depth of a pixel the object pass left clear.
 */
export function drawGeometryDepthSeed(context: FrameGraphRenderContext, engine: AbstractEngine, seed: GeometryDepthSeed, camera: Camera, far: number): void {
  const effect = seed.wrapper.effect;
  context.setTextureSamplingMode(seed.depth, Texture.NEAREST_SAMPLINGMODE);
  context.applyFullScreenEffect(seed.wrapper.drawWrapper, () => {
    // The context turns depth writes off for a full-screen draw; this one exists to write depth, whatever it holds.
    engine.setDepthWrite(true);
    engine.setDepthFunction(Constants.ALWAYS);
    effect.setFloat2("scale", 1, 1);
    camera.getProjectionMatrix().invertToRef(inverseProjection);
    effect.setMatrix("inverseProjection", inverseProjection);
    effect.setFloat3("depthRange", engine.isNDCHalfZRange ? 1 : 2, engine.isNDCHalfZRange ? 0 : -1, far);
    effect.setFloat("reverseDepth", engine.useReverseDepthBuffer ? 1 : 0);
    context.bindTextureHandle(effect, "sceneDepth", seed.depth);
  }, undefined, false, false, true);
}
