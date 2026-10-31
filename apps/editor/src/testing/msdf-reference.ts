/**
 * Test-build-only: Text2D's MSDF glyph shader as the engine drew it before the unlit Material replaced it
 * (`text2d-mesh.ts`), the reference the unlit parity proof (`unlit-parity-proof.ts`) draws MSDF glyphs against.
 *
 * One change, the one the unlit Material makes: under a Scene Linear display stage the glyph colour decodes with the
 * Engine's own conversion (`useExactSrgbConversions`, exact sRGB in the editor and player) instead of a fixed 2.2 power,
 * so it round-trips through the Display Color stage's encode as every other surface's colour does.
 */
import { Color3, Effect, ShaderLanguage, ShaderMaterial, ShaderStore, type BaseTexture, type Scene } from "@babylonjs/core";
import { overlayVisualStyle } from "../../../../packages/render/src/overlay-visual-style";

const MSDF_SHADER = "text2dMsdfReference";
let msdfShadersRegistered = false;

function ensureMsdfShaders(): void {
  if (msdfShadersRegistered) return;
  msdfShadersRegistered = true;
  ShaderStore.ShadersStoreWGSL[`${MSDF_SHADER}VertexShader`] = `
attribute position: vec3f;
attribute uv: vec2f;
uniform worldViewProjection: mat4x4f;
varying vUV: vec2f;
@vertex
fn main(input: VertexInputs) -> FragmentInputs {
  vertexOutputs.vUV = vertexInputs.uv;
  vertexOutputs.position = uniforms.worldViewProjection * vec4f(vertexInputs.position, 1.0);
}
`;
  ShaderStore.ShadersStoreWGSL[`${MSDF_SHADER}FragmentShader`] = `
varying vUV: vec2f;
var atlasSampler: sampler;
var atlas: texture_2d<f32>;
uniform fillColor: vec3f;
uniform strokeColor: vec3f;
uniform strokeWidth: f32;
uniform glyphOpacity: f32;
uniform overlayTint: vec4f;
uniform linearOutput: f32;
uniform exactSrgb: f32;
fn median(r: f32, g: f32, b: f32) -> f32 {
  return max(min(r, g), min(max(r, g), b));
}
@fragment
fn main(input: FragmentInputs) -> FragmentOutputs {
  let msd = textureSample(atlas, atlasSampler, fragmentInputs.vUV).rgb;
  let sd = median(msd.r, msd.g, msd.b);
  let screenPxDistance = fwidth(sd) * 0.5;
  let fill = clamp((sd - 0.5) / max(screenPxDistance, 0.0001) + 0.5, 0.0, 1.0);
  let outline = select(fill, clamp((sd - 0.5 + uniforms.strokeWidth) / max(screenPxDistance, 0.0001) + 0.5, 0.0, 1.0), uniforms.strokeWidth > 0.0);
  var color = mix(uniforms.strokeColor, uniforms.fillColor, fill);
  if (uniforms.linearOutput > 0.5) {
    if (uniforms.exactSrgb > 0.5) { color = select(pow(color * 0.947867 + 0.0521327, vec3f(2.4)), color * 0.0773993, color <= vec3f(0.04045)); }
    else { color = pow(max(color, vec3f(0.0)), vec3f(2.2)); }
  }
  let alpha = max(fill, outline) * uniforms.glyphOpacity;
  if (alpha < 0.01) { discard; }
  fragmentOutputs.color = vec4f(color, alpha) * uniforms.overlayTint;
}
`;
  Effect.ShadersStore[`${MSDF_SHADER}VertexShader`] = `
attribute vec3 position;
attribute vec2 uv;
uniform mat4 worldViewProjection;
varying vec2 vUV;
void main() {
  vUV = uv;
  gl_Position = worldViewProjection * vec4(position, 1.0);
}
`;
  Effect.ShadersStore[`${MSDF_SHADER}FragmentShader`] = `
varying vec2 vUV;
uniform sampler2D atlas;
uniform vec3 fillColor;
uniform vec3 strokeColor;
uniform float strokeWidth;
uniform float glyphOpacity;
uniform vec4 overlayTint;
uniform float linearOutput;
uniform float exactSrgb;
float median(float r, float g, float b) {
  return max(min(r, g), min(max(r, g), b));
}
void main() {
  vec3 msd = texture2D(atlas, vUV).rgb;
  float sd = median(msd.r, msd.g, msd.b);
  float screenPxDistance = fwidth(sd) * 0.5;
  float fill = clamp((sd - 0.5) / max(screenPxDistance, 0.0001) + 0.5, 0.0, 1.0);
  float outline = strokeWidth > 0.0
    ? clamp((sd - 0.5 + strokeWidth) / max(screenPxDistance, 0.0001) + 0.5, 0.0, 1.0)
    : fill;
  vec3 color = mix(strokeColor, fillColor, fill);
  if (linearOutput > 0.5) {
    color = exactSrgb > 0.5
      ? mix(pow(color * 0.947867 + 0.0521327, vec3(2.4)), color * 0.0773993, vec3(lessThanEqual(color, vec3(0.04045))))
      : pow(max(color, vec3(0.0)), vec3(2.2));
  }
  float alpha = max(fill, outline) * glyphOpacity;
  if (alpha < 0.01) discard;
  gl_FragColor = vec4(color, alpha) * overlayTint;
}
`;
}

/** A glyph style's MSDF material: fill, outline (the style's `outline`, scaled as the engine scaled it) and opacity. */
export function msdfReferenceMaterial(
  scene: Scene,
  color: readonly [number, number, number],
  outline: number,
  outlineColor: readonly [number, number, number],
  atlas: BaseTexture,
): ShaderMaterial {
  ensureMsdfShaders();
  const material = new ShaderMaterial(
    "msdf-reference",
    scene,
    { vertex: MSDF_SHADER, fragment: MSDF_SHADER },
    {
      shaderLanguage: scene.getEngine().isWebGPU ? ShaderLanguage.WGSL : ShaderLanguage.GLSL,
      attributes: ["position", "uv"],
      uniforms: ["worldViewProjection", "fillColor", "strokeColor", "strokeWidth", "glyphOpacity", "overlayTint", "linearOutput", "exactSrgb"],
      samplers: ["atlas"],
      needAlphaBlending: true,
    },
  );
  material.backFaceCulling = false;
  material.setTexture("atlas", atlas);
  material.setColor3("fillColor", new Color3(color[0], color[1], color[2]));
  material.setColor3("strokeColor", new Color3(outlineColor[0], outlineColor[1], outlineColor[2]));
  material.setFloat("strokeWidth", Math.max(0, outline) * 0.08);
  material.setFloat("glyphOpacity", 1);
  material.onBindObservable.add((mesh) => {
    material.getEffect()?.setFloat("glyphOpacity", mesh?.visibility ?? 1);
    const { opacity, tint } = overlayVisualStyle(mesh);
    material.getEffect()?.setFloat4("overlayTint", tint[0], tint[1], tint[2], tint[3] * opacity);
    material.getEffect()?.setFloat("linearOutput", scene.imageProcessingConfiguration.applyByPostProcess ? 1 : 0);
    material.getEffect()?.setFloat("exactSrgb", scene.getEngine().useExactSrgbConversions ? 1 : 0);
  });
  return material;
}
