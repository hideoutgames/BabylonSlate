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
float slateCelBand(float value) {
  float levels = slateCelBands.x - 1.0;
  float shifted = pow(clamp(value, 0.0, 1.0), log(0.5) / log(slateCelBands.z)) * levels;
  float lower = floor(shifted);
  float width = max(slateCelBands.y * levels, 0.00001);
  return clamp((lower + smoothstep(0.5 - width, 0.5 + width, fract(shifted))) / levels, 0.0, 1.0);
}
float slateCelAttenuation(float value) {
  return mix(value, slateCelBand(value), slateCelLight.y);
}
vec3 slateCelTint(vec3 color) {
  float strength = max(color.r, max(color.g, color.b));
  return mix(vec3(strength), color, slateCelLight.x);
}
float slateCelHighlight(float ndh, float ndl) {
  float edge = 1.0 - slateCelSpecular.y;
  float width = max(slateCelSpecular.z, 0.00001);
  return smoothstep(edge - width, edge + width, ndh) * step(0.00001, ndl) * slateCelSpecular.x;
}
vec3 slateCelSurfaceLight(vec3 color) {
  if (slateCelLight.z > 0.5) { return vec3(1.0); }
  return mix(vec3(1.0 - slateCelBands.w), vec3(1.0), clamp(color, vec3(0.0), vec3(1.0)));
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
  const scalar = wgsl ? "var ndl: f32=" : "float ndl=";
  return source
    .replaceAll(
      `${scalar}max(0.,dot(vNormal,lightVectorW));`,
      `${scalar}slateCelBand(max(0.,dot(vNormal,lightVectorW)));`,
    )
    .replaceAll(
      `${scalar}dot(vNormal,lightData.xyz)*0.5+0.5;`,
      `${scalar}slateCelBand(dot(vNormal,lightData.xyz)*0.5+0.5);`,
    )
    .replaceAll(
      "ndl*diffuseColor*attenuation",
      "ndl*slateCelTint(diffuseColor)*slateCelAttenuation(attenuation)",
    )
    .replaceAll(
      "mix(groundColor,diffuseColor,ndl)",
      "mix(slateCelTint(groundColor),slateCelTint(diffuseColor),ndl)",
    )
    .replaceAll(
      "specComp=pow(specComp,max(1.,glossiness));",
      "specComp=slateCelHighlight(specComp,ndl);",
    )
    .replaceAll(
      "specComp*specularColor*attenuation",
      "specComp*slateCelTint(specularColor)*slateCelAttenuation(attenuation)",
    )
    .replaceAll(
      "specComp*specularColor;",
      "specComp*slateCelTint(specularColor);",
    );
}

for (const wgsl of [false, true]) {
  const store = ShaderStore.GetIncludesShadersStore(wgsl ? 1 : 0);
  store.slateCelLightFragment = (
    wgsl ? lightFragmentWGSL : lightFragment
  ).shader
    .replace(/info\.diffuse\*shadow\b/g, "info.diffuse*slateCelBand(shadow)")
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
