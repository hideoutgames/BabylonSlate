import { Constants, type Effect, type Scene } from "@babylonjs/core";
import { sceneRenderingSettings } from "./render-settings";

const CEL_ROTATION_UNIFORMS = [
  "slateCelEnvironmentRotation0",
  "slateCelEnvironmentRotation1",
  "slateCelEnvironmentRotation2",
] as const;
const CEL_IRRADIANCE_KEYS = ["x", "y", "z", "xx", "yy", "zz", "xy", "yz", "zx"] as const;
const CEL_IRRADIANCE_UNIFORMS = CEL_IRRADIANCE_KEYS.map((key) => `slateCelIrradiance_${key}`);

export const CEL_UNIFORMS = [
  "slateCelBands",
  "slateCelSpecular",
  "slateCelLight",
  "slateCelEnvironment",
  ...CEL_ROTATION_UNIFORMS,
  ...CEL_IRRADIANCE_UNIFORMS,
];

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

export function bindCelSettings(
  effect: Effect,
  scene: Scene,
  unlit = false,
  environmentInfluence = 1,
): void {
  // Runs for every CEL draw: reuse the precomputed uniform names.
  const { cel, environmentLighting } = sceneRenderingSettings(scene);
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
    effect.setFloat4(CEL_ROTATION_UNIFORMS[row]!, (matrix?.[row] ?? (row === 0 ? 1 : 0)) * sign, (matrix?.[row + 4] ?? (row === 1 ? 1 : 0)) * sign, (matrix?.[row + 8] ?? (row === 2 ? 1 : 0)) * sign, 0);
  }
  for (let index = 0; index < CEL_IRRADIANCE_KEYS.length; index++) {
    const value = polynomial?.[CEL_IRRADIANCE_KEYS[index]!];
    effect.setFloat4(CEL_IRRADIANCE_UNIFORMS[index]!, value?.x ?? 0, value?.y ?? 0, value?.z ?? 0, 0);
  }
}
