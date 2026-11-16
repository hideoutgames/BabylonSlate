/**
 * Test-build-only: Text2D's MSDF glyph shader as the engine drew it before the unlit Material replaced it
 * (`text2d-mesh.ts`), the reference the unlit parity proof (`unlit-parity-proof.ts`) draws MSDF glyphs against.
 *
 * One change, the one the unlit Material makes: under a Scene Linear display stage the glyph colour decodes with the
 * Engine's own conversion (`useExactSrgbConversions`, exact sRGB in the editor and player) instead of a fixed 2.2 power,
 * so it round-trips through the Display Color stage's encode as every other surface's colour does.
 */
import type { BaseTexture } from "@babylonjs/core/Materials/Textures/baseTexture";
import { Effect } from "@babylonjs/core/Materials/effect";
import { ShaderLanguage } from "@babylonjs/core/Materials/shaderLanguage";
import { ShaderMaterial } from "@babylonjs/core/Materials/shaderMaterial";
import { Color3 } from "@babylonjs/core/Maths/math.color";
import type { Scene } from "@babylonjs/core/scene";
import { overlayVisualStyle } from "../../../../packages/render/src/overlay-visual-style";

const MSDF_SHADER = "text2dMsdfReference";
let msdfShadersRegistered = false;

function ensureMsdfShaders(): void {
  if (msdfShadersRegistered) return;
  msdfShadersRegistered = true;
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
      shaderLanguage: ShaderLanguage.GLSL,
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
