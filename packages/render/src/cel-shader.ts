import { ShaderStore, type Effect, type Scene } from "@babylonjs/core";
import { lightFragment } from "@babylonjs/core/Shaders/ShadersInclude/lightFragment";
import { lightFragmentWGSL } from "@babylonjs/core/ShadersWGSL/ShadersInclude/lightFragment";
import { lightsFragmentFunctions } from "@babylonjs/core/Shaders/ShadersInclude/lightsFragmentFunctions";
import { lightsFragmentFunctionsWGSL } from "@babylonjs/core/ShadersWGSL/ShadersInclude/lightsFragmentFunctions";
import { sceneRenderingSettings } from "./render-settings";

export const CEL_UNIFORMS = [
  "slateCelBands",
  "slateCelSpecular",
  "slateCelLight",
];

/** Display-space lighting deliberately avoids a PBR BRDF and tone mapping. */
export function celFunctions(wgsl: boolean): string {
  const source = `
vec3 slateCelTextureToDisplay(vec3 color) {
  return mix(12.92 * color, 1.055 * pow(max(color, vec3(0.0)), vec3(1.0 / 2.4)) - vec3(0.055), step(vec3(0.0031308), color));
}
float slateCelBand(float value) {
  float levels = slateCelBands.x - 1.0;
  float shifted = pow(clamp(value, 0.0, 1.0), log(0.5) / log(slateCelBands.z)) * levels;
  float lower = floor(shifted);
  float width = max(slateCelBands.y, 0.00001);
  return clamp((lower + smoothstep(0.5 - width, 0.5 + width, fract(shifted))) / levels, 0.0, 1.0);
}
float slateCelAttenuation(float value) {
  return mix(value, slateCelBand(value), slateCelLight.y);
}
vec3 slateCelTint(vec3 color) {
  float strength = max(color.r, max(color.g, color.b));
  return mix(vec3(strength), color, slateCelLight.x);
}
vec3 slateCelSpecularTint(vec3 specular, vec3 diffuse) {
  float strength = max(diffuse.r, max(diffuse.g, diffuse.b));
  return slateCelTint(specular * diffuse / max(strength, 0.00001));
}
float slateCelHighlight(float ndh, float ndl) {
  float edge = 1.0 - slateCelSpecular.y;
  float width = max(slateCelSpecular.z, 0.00001);
  return smoothstep(edge - width, edge + width, ndh) * step(0.00001, ndl) * slateCelSpecular.x;
}
vec3 slateCelSurfaceLight(vec3 color, vec3 unattenuated) {
  if (slateCelLight.z > 0.5) { return vec3(1.0); }
  float strength = max(color.r, max(color.g, color.b));
  float angularStrength = max(unattenuated.r, max(unattenuated.g, unattenuated.b));
  float ramp = slateCelBand(mix(angularStrength, strength, slateCelLight.y));
  float fade = mix(clamp(strength / max(angularStrength, 0.00001), 0.0, 1.0), 1.0, slateCelLight.y);
  return mix(vec3(1.0 - slateCelBands.w), slateCelTint(color / max(strength, 0.00001)), ramp * fade);
}
`;
  if (!wgsl) return source;
  // This small shared source only uses scalar/vector declarations and functions.
  return source
    .replace(
      /(float|vec3) (slateCel\w+)\(([^)]*)\)/g,
      (_all, type: string, name: string, args: string) =>
        `fn ${name}(${args.replace(/(float|vec3) (\w+)/g, (_arg, t: string, n: string) => `${n}: ${t === "float" ? "f32" : "vec3f"}`)}) -> ${type === "float" ? "f32" : "vec3f"}`,
    )
    .replace(/float (\w+) =/g, "var $1: f32 =")
    .replace(/vec3\(/g, "vec3f(")
    .replace(
      /\b(slateCelBands|slateCelSpecular|slateCelLight)\b/g,
      "uniforms.$1",
    );
}

/** Retain Babylon's light transforms, colors, ranges, cones and shadow bindings. */
export function celLightingFunctions(source: string, wgsl: boolean): string {
  return (
    source
      .replace(
        wgsl ? "diffuse: vec3f," : "vec3 diffuse;",
        wgsl
          ? "diffuse: vec3f, celUnattenuated: vec3f,"
          : "vec3 diffuse; vec3 celUnattenuated;",
      )
      // Keep raw irradiance until all lights and their shadows have accumulated.
      // A second sum lets Smooth fade distance/cone attenuation outside the ramp.
      .replace(
        /result\.diffuse=([^;]+);/g,
        (_match, expression: string) =>
          `result.diffuse=${expression};result.celUnattenuated=${expression.replaceAll("*attenuation", "")};`,
      )
      .replaceAll(
        "specComp=pow(specComp,max(1.,glossiness));",
        "specComp=slateCelHighlight(specComp,ndl);",
      )
      .replaceAll(
        "specComp*specularColor*attenuation",
        "specComp*slateCelSpecularTint(specularColor,diffuseColor)*slateCelAttenuation(attenuation)",
      )
      .replaceAll(
        "specComp*specularColor;",
        "specComp*slateCelSpecularTint(specularColor,diffuseColor);",
      )
  );
}

for (const wgsl of [false, true]) {
  const store = ShaderStore.GetIncludesShadersStore(wgsl ? 1 : 0);
  store.slateCelLightFragment = (
    wgsl ? lightFragmentWGSL : lightFragment
  ).shader
    .replace(
      /diffuseBase\+=info\.diffuse\*(shadow(?:Debug\{X\})?);/g,
      "$&slateCelUnattenuated+=info.celUnattenuated*$1;",
    )
    .replace(
      /info\.diffuse\*=(computeProjectionTextureDiffuseLighting\([^;]+);/g,
      "$&info.celUnattenuated*=$1;",
    )
    .replace(/info\.specular\*shadow\b/g, "info.specular*slateCelBand(shadow)");
  store.slateCelLightsFragmentFunctions =
    celFunctions(wgsl) +
    celLightingFunctions(
      (wgsl ? lightsFragmentFunctionsWGSL : lightsFragmentFunctions).shader,
      wgsl,
    );
}

export function bindCelSettings(
  effect: Effect,
  scene: Scene,
  unlit = false,
): void {
  const { cel } = sceneRenderingSettings(scene);
  effect.setFloat4(
    "slateCelBands",
    cel.shadowBands,
    cel.bandSoftness,
    cel.shadowThreshold,
    cel.shadowStrength,
  );
  effect.setFloat4(
    "slateCelSpecular",
    cel.specularStrength,
    cel.specularSize,
    cel.specularSoftness,
    0,
  );
  effect.setFloat4(
    "slateCelLight",
    cel.lightColorInfluence,
    cel.lightFalloff === "banded" ? 1 : 0,
    unlit || !scene.lightsEnabled ? 1 : 0,
    0,
  );
}
