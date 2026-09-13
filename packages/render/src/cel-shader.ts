import { ShaderStore, type Effect, type Scene } from "@babylonjs/core";
import { lightFragment } from "@babylonjs/core/Shaders/ShadersInclude/lightFragment";
import { lightFragmentWGSL } from "@babylonjs/core/ShadersWGSL/ShadersInclude/lightFragment";
import { lightsFragmentFunctions } from "@babylonjs/core/Shaders/ShadersInclude/lightsFragmentFunctions";
import { lightsFragmentFunctionsWGSL } from "@babylonjs/core/ShadersWGSL/ShadersInclude/lightsFragmentFunctions";
import { sceneRenderingSettings } from "./render-settings";
import { checkedShader } from "./checked-shader";
import { withShadowDistanceFade } from "./shadow-shader";

export const CEL_UNIFORMS = [
  "slateCelBands",
  "slateCelSpecular",
  "slateCelLight",
];

export function celLightAccumulators(wgsl: boolean): string {
  return ["slateCelPeak", "slateCelTotal", "slateCelWins"]
    .map((name) => (wgsl ? `var ${name}: f32=0.0;` : `float ${name}=0.0;`))
    .join("\n");
}

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
  if (slateCelBands.y <= 0.0) { return clamp(floor(shifted + 0.5) / levels, 0.0, 1.0); }
  float width = slateCelBands.y;
  return clamp((lower + smoothstep(0.5 - width, 0.5 + width, fract(shifted))) / levels, 0.0, 1.0);
}
float slateCelStrength(vec3 color) {
  return max(color.r, max(color.g, color.b));
}
vec3 slateCelAccumulate(vec3 previous, vec3 incoming, float wins) {
  if (slateCelLight.y < 0.5) { return mix(previous, incoming, wins); }
  return previous + incoming;
}
vec3 slateCelSurfaceSpecular(vec3 color, float peak, float total) {
  if (slateCelLight.y > 1.5) { return color * peak / max(total, 0.00001); }
  return color;
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
  if (slateCelSpecular.z <= 0.0) { return step(edge, ndh) * step(0.00001, ndl) * slateCelSpecular.x; }
  float width = slateCelSpecular.z;
  return smoothstep(edge - width, edge + width, ndh) * step(0.00001, ndl) * slateCelSpecular.x;
}
vec3 slateCelSurfaceLight(vec3 color, float peak) {
  if (slateCelLight.z > 0.5) { return vec3(1.0); }
  float strength = max(color.r, max(color.g, color.b));
  float brightness = strength;
  if (slateCelLight.y > 1.5) { brightness = peak; }
  return mix(vec3(1.0 - slateCelBands.w), slateCelTint(color / max(strength, 0.00001)), slateCelBand(brightness));
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
    checkedShader(source, wgsl ? "lighting WGSL" : "lighting GLSL")
      // Colored sky/ground fills must not reintroduce a smooth hue gradient.
      .replaceAll(
        `${wgsl ? "var ndl: f32=" : "float ndl="}dot(vNormal,lightData.xyz)*0.5+0.5;`,
        `${wgsl ? "var ndl: f32=" : "float ndl="}slateCelBand(dot(vNormal,lightData.xyz)*0.5+0.5);`,
        1,
      )
      // Retain raw diffuse brightness through attenuation and shadows. The
      // selected mixing policy feeds one ramp, never separately banded sums.
      .replaceAll(
        "specComp=pow(specComp,max(1.,glossiness));",
        "specComp=slateCelHighlight(specComp,ndl);",
        3,
      )
      .replaceAll(
        "specComp*specularColor*attenuation",
        "specComp*slateCelSpecularTint(specularColor,diffuseColor)*slateCelBand(attenuation)",
        2,
      )
      .replaceAll(
        "specComp*specularColor;",
        "specComp*slateCelSpecularTint(specularColor,diffuseColor);",
        1,
      )
      .value
  );
}

for (const wgsl of [false, true]) {
  const store = ShaderStore.GetIncludesShadersStore(wgsl ? 1 : 0);
  store.slateCelLightFragment = checkedShader(withShadowDistanceFade((
    wgsl ? lightFragmentWGSL : lightFragment
  ).shader, wgsl), wgsl ? "light fragment WGSL" : "light fragment GLSL")
    .replace(
      /diffuseBase\+=info\.diffuse\*(shadow(?:Debug\{X\})?);/g,
      (
        _match,
        shadow: string,
      ) => `${wgsl ? "var slateCelIncoming{X}: f32" : "float slateCelIncoming{X}"}=slateCelStrength(info.diffuse*${shadow});
slateCelWins=0.0;
if (slateCelIncoming{X}>slateCelPeak) { slateCelWins=1.0; }
slateCelPeak=max(slateCelPeak,slateCelIncoming{X});
slateCelTotal+=slateCelIncoming{X};
diffuseBase=slateCelAccumulate(diffuseBase,info.diffuse*${shadow},slateCelWins);`,
      2,
    )
    .replace(
      "specularBase+=info.specular*shadow;",
      "specularBase=slateCelAccumulate(specularBase,info.specular*slateCelBand(shadow),slateCelWins);",
    ).value;
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
    cel.specularEnabled ? cel.specularStrength : 0,
    cel.specularSize,
    cel.specularSoftness,
    0,
  );
  effect.setFloat4(
    "slateCelLight",
    cel.lightColorInfluence,
    cel.lightMixing === "strongest"
      ? 0
      : cel.lightMixing === "additive"
        ? 1
        : 2,
    unlit || !scene.lightsEnabled ? 1 : 0,
    0,
  );
}
