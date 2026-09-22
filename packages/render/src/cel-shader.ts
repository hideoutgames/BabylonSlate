import { Constants, ShaderStore, type Effect, type Scene } from "@babylonjs/core";
import {
  BAKED_IRRADIANCE_INV_PI,
  bakedIrradianceTexelSample,
} from "./baked-irradiance";
import { lightFragment } from "@babylonjs/core/Shaders/ShadersInclude/lightFragment";
import { lightFragmentWGSL } from "@babylonjs/core/ShadersWGSL/ShadersInclude/lightFragment";
import { lightsFragmentFunctions } from "@babylonjs/core/Shaders/ShadersInclude/lightsFragmentFunctions";
import { lightsFragmentFunctionsWGSL } from "@babylonjs/core/ShadersWGSL/ShadersInclude/lightsFragmentFunctions";
import { sceneRenderingSettings } from "./render-settings";
import { checkedShader } from "./checked-shader";
import { withShadowDistanceFade } from "./shadow-shader";
import {
  celClusteredLighting,
  celClusteredLightingWGSL,
} from "./clustered-cel-shader";

export const CEL_UNIFORMS = [
  "slateCelBands",
  "slateCelSpecular",
  "slateCelLight",
  "slateCelEnvironment",
  "slateCelEnvironmentRotation0",
  "slateCelEnvironmentRotation1",
  "slateCelEnvironmentRotation2",
  ...["x", "y", "z", "xx", "yy", "zz", "xy", "yz", "zx"].map((key) => `slateCelIrradiance_${key}`),
];

/**
 * One diffuse environmental contribution enters the same final CEL ramp.
 * Under `SLATE_BAKED` a second baked-irradiance contribution joins it — same
 * wins/peak/total update, no smooth lobes — at the atlas's raw `E` scale so
 * it lands in the same unnormalized units as realtime `I * cos * attenuation`
 * light terms. Under `SLATE_BAKED_ENV` the atlas also carries environment
 * irradiance, so the baked sample replaces the spherical-polynomial
 * environment instead of double-counting it; the polynomial it substitutes
 * for is already `E / PI`-scaled, so that branch keeps the division.
 */
export function celEnvironmentAccumulation(wgsl: boolean, influence = "1.0"): string {
  const texel = wgsl
    ? `var slateBakedTexel: vec4f=${bakedIrradianceTexelSample(true)};`
    : `vec4 slateBakedTexel=${bakedIrradianceTexelSample(false)};`;
  return `#ifdef SLATE_BAKED_ENV
${texel}
${wgsl ? "var slateEnvironmentColor: vec3f" : "vec3 slateEnvironmentColor"}=slateBakedTexel.rgb*slateBakedTexel.a*${BAKED_IRRADIANCE_INV_PI}*clamp(${influence},0.0,1.0);
#else
${wgsl ? "var slateEnvironmentColor: vec3f" : "vec3 slateEnvironmentColor"}=slateCelEnvironmentLight(normalW)*clamp(${influence},0.0,1.0);
#endif
${wgsl ? "var slateEnvironmentStrength: f32" : "float slateEnvironmentStrength"}=slateCelStrength(slateEnvironmentColor);
slateCelWins=0.0;
if (slateEnvironmentStrength>slateCelPeak+max(1.0,slateCelPeak)*0.00001) { slateCelWins=1.0; }
slateCelPeak=max(slateCelPeak,slateEnvironmentStrength);
slateCelTotal+=slateEnvironmentStrength;
diffuseBase=slateCelAccumulate(diffuseBase,slateEnvironmentColor,slateCelWins);
#ifdef SPECULARTERM
specularBase=slateCelAccumulate(specularBase,${wgsl ? "vec3f" : "vec3"}(0.0),slateCelWins);
#endif
#if defined(SLATE_BAKED) && !defined(SLATE_BAKED_ENV)
${texel}
${wgsl ? "var slateBakedColor: vec3f" : "vec3 slateBakedColor"}=slateBakedTexel.rgb*slateBakedTexel.a;
${wgsl ? "var slateBakedStrength: f32" : "float slateBakedStrength"}=slateCelStrength(slateBakedColor);
slateCelWins=0.0;
if (slateBakedStrength>slateCelPeak+max(1.0,slateCelPeak)*0.00001) { slateCelWins=1.0; }
slateCelPeak=max(slateCelPeak,slateBakedStrength);
slateCelTotal+=slateBakedStrength;
diffuseBase=slateCelAccumulate(diffuseBase,slateBakedColor,slateCelWins);
#ifdef SPECULARTERM
specularBase=slateCelAccumulate(specularBase,${wgsl ? "vec3f" : "vec3"}(0.0),slateCelWins);
#endif
#endif`;
}

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
vec3 slateCelEnvironmentLight(vec3 normal) {
  vec3 n = vec3(dot(slateCelEnvironmentRotation0.xyz,normal),dot(slateCelEnvironmentRotation1.xyz,normal),dot(slateCelEnvironmentRotation2.xyz,normal));
  vec3 color = slateCelIrradiance_x.xyz*n.x+slateCelIrradiance_y.xyz*n.y+slateCelIrradiance_z.xyz*n.z+
    slateCelIrradiance_xx.xyz*n.x*n.x+slateCelIrradiance_yy.xyz*n.y*n.y+slateCelIrradiance_zz.xyz*n.z*n.z+
    slateCelIrradiance_xy.xyz*n.x*n.y+slateCelIrradiance_yz.xyz*n.y*n.z+slateCelIrradiance_zx.xyz*n.z*n.x;
  return max(color,vec3(0.0))*slateCelEnvironment.x;
}
// Resolve round-off at exact hard thresholds consistently; no edge blending.
float slateCelBand(float value) {
  float levels = slateCelBands.x - 1.0;
  float shifted = pow(clamp(value, 0.0, 1.0), log(0.5) / log(slateCelBands.y)) * levels;
  return clamp(floor(shifted + 0.5001) / levels, 0.0, 1.0);
}
float slateCelShadowVisibility(float visibility) {
  return step(0.49999, visibility);
}
float slateCelStrength(vec3 color) {
  return max(color.r, max(color.g, color.b));
}
vec3 slateCelAccumulate(vec3 previous, vec3 incoming, float wins) {
  if (slateCelLight.y < 0.5) { return mix(previous, incoming, wins); }
  return previous + incoming;
}
vec3 slateCelSurfaceSpecular(vec3 color) {
  if (slateCelLight.y > 1.5) {
    float strength = slateCelStrength(color);
    // Blend keeps the overlap tint but emits the full-strength highlight or
    // none; a partial rescale would smear the hard highlight across lights.
    return color / max(strength, 0.00001) * slateCelSpecular.x * step(0.5, strength / max(slateCelSpecular.x, 0.00001));
  }
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
  return step(edge - 0.00001, ndh) * step(0.00001, ndl) * slateCelSpecular.x;
}
vec3 slateCelSurfaceLight(vec3 color, float peak) {
  if (slateCelLight.z > 0.5) { return vec3(1.0); }
  float strength = max(color.r, max(color.g, color.b));
  float brightness = strength;
  if (slateCelLight.y > 1.5) { brightness = peak; }
  return mix(vec3(1.0 - slateCelBands.z), slateCelTint(color / max(strength, 0.00001)), slateCelBand(brightness));
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
    .replace(/vec3 (\w+) =/g, "var $1: vec3f =")
    .replace(/vec3\(/g, "vec3f(")
    .replace(
      /\b(slateCelBands|slateCelSpecular|slateCelLight|slateCelEnvironment(?:Rotation[012])?|slateCelIrradiance_(?:xx|yy|zz|xy|yz|zx|x|y|z))\b/g,
      "uniforms.$1",
    );
}

/** Retain Babylon's light transforms, colors, ranges, cones and shadow bindings. */
export function celLightingFunctions(source: string, wgsl: boolean): string {
  source = wgsl
    ? celClusteredLightingWGSL(source)
    : celClusteredLighting(source);
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
        "specComp*slateCelSpecularTint(specularColor,diffuseColor)*step(0.00001,attenuation)",
        2,
      )
      .replaceAll(
        "specComp*specularColor;",
        "specComp*slateCelSpecularTint(specularColor,diffuseColor);",
        1,
      ).value
  );
}

for (const wgsl of [false, true]) {
  const store = ShaderStore.GetIncludesShadersStore(wgsl ? 1 : 0);
  const fragment = (wgsl ? lightFragmentWGSL : lightFragment).shader;
  store.slateCelLightFragment = checkedShader(
    withShadowDistanceFade(
      checkedShader(fragment, "clustered CEL sequential call").replace(
        wgsl
          ? "vec2u(light{X}.vSliceRanges[sliceIndex].xy),glossiness);}"
          : "ivec2(light{X}.vSliceRanges[sliceIndex]),glossiness);}",
        wgsl
          ? "vec2u(light{X}.vSliceRanges[sliceIndex].xy),glossiness,slateCelPeak);}"
          : "ivec2(light{X}.vSliceRanges[sliceIndex]),glossiness,slateCelPeak);}",
      ).value,
      wgsl,
    ),
    wgsl ? "light fragment WGSL" : "light fragment GLSL",
  )
    .replace(
      /diffuseBase\+=info\.diffuse\*(shadow(?:Debug\{X\})?);/g,
      (
        _match,
        shadow: string,
      ) => `${wgsl ? "var slateCelIncoming{X}: f32" : "float slateCelIncoming{X}"}=slateCelStrength(info.diffuse*${shadow === "shadow" ? "slateCelShadowVisibility(shadow)" : shadow});
slateCelWins=0.0;
if (slateCelIncoming{X}>slateCelPeak+max(1.0,slateCelPeak)*0.00001) { slateCelWins=1.0; }
#ifdef CLUSTLIGHT{X}
// The children already compared against the conventional prefix in sequence.
// Comparing their final maximum again would break epsilon ties.
slateCelWins=info.slateCelWins;
slateCelPeak=info.slateCelPeak;
slateCelTotal+=info.slateCelTotal;
#else
slateCelPeak=max(slateCelPeak,slateCelIncoming{X});
slateCelTotal+=slateCelIncoming{X};
#endif
diffuseBase=slateCelAccumulate(diffuseBase,info.diffuse*${shadow === "shadow" ? "slateCelShadowVisibility(shadow)" : shadow},slateCelWins);`,
      2,
    )
    .replace(
      "specularBase+=info.specular*shadow;",
      "specularBase=slateCelAccumulate(specularBase,info.specular*slateCelShadowVisibility(shadow),slateCelWins);",
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
  environmentInfluence = 1,
): void {
  const { cel } = sceneRenderingSettings(scene);
  effect.setFloat4(
    "slateCelBands",
    cel.shadowBands,
    cel.shadowThreshold,
    cel.shadowStrength,
    0,
  );
  effect.setFloat4(
    "slateCelSpecular",
    cel.specularEnabled ? cel.specularStrength : 0,
    cel.specularSize,
    0,
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
  const { environmentLighting } = sceneRenderingSettings(scene);
  const environment = scene.environmentTexture;
  const polynomial = environment?.sphericalPolynomial;
  const strength = !unlit && scene.lightsEnabled && environmentLighting.enabled && polynomial
    ? scene.iblIntensity * environmentLighting.celStrength * environmentInfluence
    : 0;
  effect.setFloat4("slateCelEnvironment", strength, 0, 0, 0);
  const matrix = environment?.getReflectionTextureMatrix().m;
  const invertZ = environment && (scene.useRightHandedSystem ? !environment.invertZ : environment.invertZ) ? -1 : 1;
  const invertY = environment?.coordinatesMode === Constants.TEXTURE_INVCUBIC_MODE ? -1 : 1;
  for (let row = 0; row < 3; row++) {
    const sign = row === 2 ? invertZ : row === 1 ? invertY : 1;
    effect.setFloat4(`slateCelEnvironmentRotation${row}`, (matrix?.[row] ?? (row === 0 ? 1 : 0)) * sign, (matrix?.[row + 4] ?? (row === 1 ? 1 : 0)) * sign, (matrix?.[row + 8] ?? (row === 2 ? 1 : 0)) * sign, 0);
  }
  for (const key of ["x", "y", "z", "xx", "yy", "zz", "xy", "yz", "zx"] as const) {
    const value = polynomial?.[key];
    effect.setFloat4(`slateCelIrradiance_${key}`, value?.x ?? 0, value?.y ?? 0, value?.z ?? 0, 0);
  }
}
