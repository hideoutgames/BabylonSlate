import { Constants } from "@babylonjs/core/Engines/constants";
import type { Effect } from "@babylonjs/core/Materials/effect";
import type { Scene } from "@babylonjs/core/scene";
import type { CelShadingSettings } from "@haptic/core";
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

/**
 * Display-space lighting deliberately avoids a PBR BRDF and tone mapping. Every edge (a band's, a highlight's) is one
 * pixel wide whatever the zoom: thresholds go through `fwidth`, which is defined only in uniform control flow, so they
 * run on values summed over the lights after the light loop, never inside it.
 */
export function celFunctions(): string {
  return `
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
// A step at zero, one pixel wide whatever the zoom. Only in uniform control flow.
float slateCelStep(float x) {
  return clamp(x / max(fwidth(x), 0.000001) + 0.5, 0.0, 1.0);
}
// A brightness on the ramp's scale: band i spans (i - 0.5, i + 0.5].
float slateCelShift(float value) {
  return pow(clamp(value, 0.0, 1.0), slateCelBands.y) * slateCelBands.x;
}
// The ramp: \`s\` (\`slateCelShift\`) to one of \`levels + 1\` flat bands (exactly i / levels), each edge \`w\` wide in
// the ramp's units (its change across a pixel, so one pixel). The bias resolves round-off at exact thresholds
// consistently.
float slateCelRamp(float s, float w) {
  float levels = slateCelBands.x;
  float e = s + 0.5001;
  float f = floor(e);
  float r = e - f;
  // The band above the nearest edge, and the signed distance to that edge in band units.
  float near = r < 0.5 ? f : f + 1.0;
  float t = r < 0.5 ? r : r - 1.0;
  return clamp((near - 1.0 + clamp(t / w + 0.5, 0.0, 1.0)) / levels, 0.0, 1.0);
}
// The width of a ramp edge for \`s\`: its change across the pixel, up to half a band. Only in uniform control flow.
float slateCelEdge(float s) {
  return clamp(fwidth(s), 0.000001, 0.5);
}
// \`value\` on the ramp, each edge one pixel wide whatever the zoom. Only in uniform control flow.
float slateCelBand(float value) {
  float s = slateCelShift(value);
  return slateCelRamp(s, slateCelEdge(s));
}
float slateCelStrength(vec3 color) {
  return max(color.r, max(color.g, color.b));
}
vec3 slateCelAccumulate(vec3 previous, vec3 incoming, float wins) {
  if (slateCelLight.y < 0.5) { return mix(previous, incoming, wins); }
  return previous + incoming;
}
vec3 slateCelTint(vec3 color) {
  float strength = max(color.r, max(color.g, color.b));
  return mix(vec3(strength), color, slateCelLight.x);
}
`;
}

/** The CEL settings as the shader reads them (`slateCelBands`, `slateCelSpecular`), derived once on the CPU. */
function celShadingUniforms(cel: CelShadingSettings): { bands: [number, number, number, number]; specular: [number, number, number, number] } {
  const levels = cel.shadowBands - 1;
  // The threshold is where the ramp's half way lands: value^exponent = 0.5 at value = threshold.
  const exponent = Math.log(0.5) / Math.log(cel.shadowThreshold);
  // The brightness at which the first lit band starts (the ramp's first edge, at half a band).
  const litThreshold = (0.5 / levels) ** (1 / exponent);
  const size = cel.specularSize;
  return {
    bands: [levels, exponent, 1 - cel.shadowStrength, litThreshold],
    // Specular Size is the sine of the highlight's half angle; a rect light keeps its form-factor threshold.
    specular: [cel.specularEnabled ? cel.specularStrength : 0, Math.sqrt(Math.max(0, 1 - size * size)), 1 - size, 0],
  };
}

type CelBinding = {
  scene: Scene;
  frame: number;
  pipeline: unknown;
  cel: CelShadingSettings;
  environmentLighting: unknown;
  lightsEnabled: boolean;
  environment: unknown;
  polynomial: unknown;
  iblIntensity: number;
};
const celBindings = new WeakMap<Effect, CelBinding>();

/**
 * Binds the Scene's CEL settings to a CEL program. Uniform values stay in the program, so a draw skips the writes when
 * the same Scene already bound this Effect in this Engine frame with the same settings: Scenes sharing one Engine
 * (previews, thumbnails) can share an Effect with other settings, and a settings change (a new resolved object, the
 * Scene's lights or environment) within a frame still binds. What only changes between frames (the environment's
 * rotation and orientation) is bound again on the next frame.
 */
export function bindCelSettings(effect: Effect, scene: Scene): void {
  const { cel, environmentLighting } = sceneRenderingSettings(scene);
  const frame = scene.getEngine().frameId;
  const pipeline = effect.getPipelineContext();
  const environment = scene.environmentTexture;
  const polynomial = environment?.sphericalPolynomial ?? null;
  const last = celBindings.get(effect);
  if (last && last.scene === scene && last.frame === frame && last.pipeline === pipeline && last.cel === cel &&
    last.environmentLighting === environmentLighting && last.lightsEnabled === scene.lightsEnabled &&
    last.environment === environment && last.polynomial === polynomial && last.iblIntensity === scene.iblIntensity) return;
  celBindings.set(effect, {
    scene, frame, pipeline, cel, environmentLighting, lightsEnabled: scene.lightsEnabled, environment, polynomial,
    iblIntensity: scene.iblIntensity,
  });
  const { bands, specular } = celShadingUniforms(cel);
  effect.setFloat4("slateCelBands", bands[0], bands[1], bands[2], bands[3]);
  effect.setFloat4("slateCelSpecular", specular[0], specular[1], specular[2], specular[3]);
  effect.setFloat4(
    "slateCelLight",
    cel.lightColorInfluence,
    cel.lightMixing === "strongest"
      ? 0
      : cel.lightMixing === "additive"
        ? 1
        : 2,
    scene.lightsEnabled ? 0 : 1,
    0,
  );
  const strength = scene.lightsEnabled && environmentLighting.enabled && polynomial
    ? scene.iblIntensity * environmentLighting.celStrength
    : 0;
  effect.setFloat4("slateCelEnvironment", strength, 0, 0, 0);
  // The shader reads the rotation and the irradiance only at a strength above zero.
  if (strength <= 0) return;
  const matrix = environment!.getReflectionTextureMatrix().m;
  const invertZ = (scene.useRightHandedSystem ? !environment!.invertZ : environment!.invertZ) ? -1 : 1;
  const invertY = environment!.coordinatesMode === Constants.TEXTURE_INVCUBIC_MODE ? -1 : 1;
  for (let row = 0; row < 3; row++) {
    const sign = row === 2 ? invertZ : row === 1 ? invertY : 1;
    effect.setFloat4(CEL_ROTATION_UNIFORMS[row]!, matrix[row]! * sign, matrix[row + 4]! * sign, matrix[row + 8]! * sign, 0);
  }
  for (let index = 0; index < CEL_IRRADIANCE_KEYS.length; index++) {
    const value = polynomial![CEL_IRRADIANCE_KEYS[index]!];
    effect.setFloat4(CEL_IRRADIANCE_UNIFORMS[index]!, value.x, value.y, value.z, 0);
  }
}
