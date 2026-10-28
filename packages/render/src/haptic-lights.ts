import {
  DirectionalLight,
  HemisphericLight,
  PointLight,
  SpotLight,
  UniformBuffer,
  type AbstractEngine,
  type Effect,
  type Light,
  type Scene,
} from "@babylonjs/core";
import { isIlluminatingLight, sortLightsByAdmission } from "./light-policy";
import { sceneRenderingSettings } from "./render-settings";

/**
 * Lighting plan Phase 4 spike: lit graph Materials read every light from one per-Scene uniform block (`HapticLights`)
 * and loop over it, instead of Babylon's per-light defines. Off by default, GLSL only, unshadowed; console
 * `hapticlights` switches it for a Play session so a Benchmark can compare it with Forward.
 */

/** Records per light type the block holds. */
export const HAPTIC_LIGHT_MAXIMUM = { directional: 4, point: 32, spot: 16 } as const;

/** Which lights the block holds: the ones Forward admitted (the same set, for a fair comparison), or every one. */
export type HapticLightSet = "forward" | "all";

const engines = new WeakMap<AbstractEngine, HapticLightSet>();

/** Switch the spike on an Engine; null switches it off. Lit graph Materials recompile at their next draw. */
export function setHapticLighting(engine: AbstractEngine, lights: HapticLightSet | null): void {
  if (lights) engines.set(engine, lights);
  else engines.delete(engine);
}

export function hapticLighting(engine: AbstractEngine): HapticLightSet | null {
  return engines.get(engine) ?? null;
}

/** The spike draws `scene`'s PBR graph Materials: switched on, on a WebGL2 Engine with uniform buffers, in PBR mode. */
export function hapticLightingActive(scene: Scene): boolean {
  const engine = scene.getEngine();
  return engines.has(engine) && !engine.isWebGPU && engine.supportsUniformBuffers && sceneRenderingSettings(scene).mode === "pbr";
}

/** The block's GLSL declaration; its layout matches `hapticLightBuffer`. */
export const HAPTIC_LIGHTS_GLSL = `#ifdef HAPTIC_LIGHTS
layout(std140) uniform HapticLights {
vec4 hapticCounts;
vec4 hapticFillDirection;
vec4 hapticFillSky;
vec4 hapticFillGround;
vec4 hapticDirectional[${HAPTIC_LIGHT_MAXIMUM.directional * 2}];
vec4 hapticPoint[${HAPTIC_LIGHT_MAXIMUM.point * 2}];
vec4 hapticSpot[${HAPTIC_LIGHT_MAXIMUM.spot * 3}];
};
#endif
`;

/** One light's diffuse and specular, as Babylon's PBR `lightFragment` adds them, unshadowed. */
function contribution(color: string, radius: string, ground: string | null): string {
  return `preInfo.NdotV=NdotV;
${ground ? "preInfo.roughness=roughness;" : `preInfo.roughness=adjustRoughnessFromLightProperties(roughness,${radius},preInfo.lightDistance);`}
preInfo.diffuseRoughness=diffuseRoughness;preInfo.surfaceAlbedo=surfaceAlbedo;
#ifdef IRIDESCENCE
preInfo.iridescenceIntensity=iridescenceIntensity;
#endif
info.diffuse=${ground ? `computeHemisphericDiffuseLighting(preInfo,${color},${ground})` : `computeDiffuseLighting(preInfo,${color})`};
#ifdef SPECULARTERM
#if (CONDUCTOR_SPECULAR_MODEL==CONDUCTOR_SPECULAR_MODEL_OPENPBR)
{vec3 metalFresnel=reflectivityOut.specularWeight*getF82Specular(preInfo.VdotH,clearcoatOut.specularEnvironmentR0,reflectivityOut.colorReflectanceF90,reflectivityOut.roughness);vec3 dielectricFresnel=fresnelSchlickGGX(preInfo.VdotH,reflectivityOut.dielectricColorF0,reflectivityOut.colorReflectanceF90);hapticFresnel=mix(dielectricFresnel,metalFresnel,reflectivityOut.metallic);}
#else
hapticFresnel=fresnelSchlickGGX(preInfo.VdotH,clearcoatOut.specularEnvironmentR0,reflectivityOut.colorReflectanceF90);
#endif
#ifndef LEGACY_SPECULAR_ENERGY_CONSERVATION
{float NdotH=dot(normalW,preInfo.H);vec3 fresnel=fresnelSchlickGGX(NdotH,vec3(reflectanceF0),specularEnvironmentR90);info.diffuse*=(vec3(1.0)-fresnel);}
#endif
info.specular=computeSpecularLighting(preInfo,normalW,clearcoatOut.specularEnvironmentR0,hapticFresnel,AARoughnessFactors.x,${color});
specularBase+=info.specular;
#endif
diffuseBase+=info.diffuse;
aggShadow+=1.;numLights+=1.;
`;
}

/**
 * The loops, inserted where Babylon's PBR block adds its per-light `lightFragment` copies (none in this mode).
 * Point and spot lights use physical falloff and end at their range.
 */
export function hapticLightLoopGlsl(worldPosition: string): string {
  return `#ifdef HAPTIC_LIGHTS
{
vec3 hapticFresnel;
if (hapticCounts.w>0.) {
preInfo=computeHemisphericPreLightingInfo(hapticFillDirection,viewDirectionW,normalW);
preInfo.attenuation=1.0;
${contribution("hapticFillSky.rgb", "0.", "hapticFillGround.rgb")}}
for (int i=0;i<${HAPTIC_LIGHT_MAXIMUM.directional};i++) {
if (i>=int(hapticCounts.x)) break;
preInfo=computeDirectionalPreLightingInfo(hapticDirectional[i*2],viewDirectionW,normalW);
preInfo.attenuation=1.0;
${contribution("hapticDirectional[i*2+1].rgb", "hapticDirectional[i*2].w", null)}}
for (int i=0;i<${HAPTIC_LIGHT_MAXIMUM.point};i++) {
if (i>=int(hapticCounts.y)) break;
vec4 hapticPosition=hapticPoint[i*2];vec4 hapticColor=hapticPoint[i*2+1];
preInfo=computePointAndSpotPreLightingInfo(hapticPosition,viewDirectionW,normalW,${worldPosition}.xyz);
if (preInfo.lightDistance>hapticColor.w) continue;
preInfo.attenuation=computeDistanceLightFalloff_Physical(preInfo.lightDistanceSquared);
${contribution("hapticColor.rgb", "hapticPosition.w", null)}}
for (int i=0;i<${HAPTIC_LIGHT_MAXIMUM.spot};i++) {
if (i>=int(hapticCounts.z)) break;
vec4 hapticPosition=hapticSpot[i*3];vec4 hapticDirection=hapticSpot[i*3+1];vec4 hapticColor=hapticSpot[i*3+2];
preInfo=computePointAndSpotPreLightingInfo(hapticPosition,viewDirectionW,normalW,${worldPosition}.xyz);
if (preInfo.lightDistance>hapticColor.w) continue;
preInfo.attenuation=computeDistanceLightFalloff_Physical(preInfo.lightDistanceSquared)*computeDirectionalLightFalloff_Physical(hapticDirection.xyz,preInfo.L,hapticDirection.w);
${contribution("hapticColor.rgb", "hapticPosition.w", null)}}
}
#endif
`;
}

type SceneLights = { buffer: UniformBuffer; held: Set<Light>; next: Set<Light>; ranked: Light[] };
const scenes = new WeakMap<Scene, SceneLights>();
const directional = new Float32Array(HAPTIC_LIGHT_MAXIMUM.directional * 8);
const point = new Float32Array(HAPTIC_LIGHT_MAXIMUM.point * 8);
const spot = new Float32Array(HAPTIC_LIGHT_MAXIMUM.spot * 12);

function sceneLights(scene: Scene): SceneLights {
  let lights = scenes.get(scene);
  if (!lights) {
    const buffer = new UniformBuffer(scene.getEngine(), undefined, true, "HapticLights");
    buffer.addUniform("hapticCounts", 4);
    buffer.addUniform("hapticFillDirection", 4);
    buffer.addUniform("hapticFillSky", 4);
    buffer.addUniform("hapticFillGround", 4);
    buffer.addUniform("hapticDirectional", 4, HAPTIC_LIGHT_MAXIMUM.directional * 2);
    buffer.addUniform("hapticPoint", 4, HAPTIC_LIGHT_MAXIMUM.point * 2);
    buffer.addUniform("hapticSpot", 4, HAPTIC_LIGHT_MAXIMUM.spot * 3);
    buffer.create();
    lights = { buffer, held: new Set(), next: new Set(), ranked: [] };
    scenes.set(scene, lights);
    scene.onDisposeObservable.addOnce(() => buffer.dispose());
  }
  return lights;
}

/** `scene`'s light block, as the shaders read it. */
export function hapticLightBuffer(scene: Scene): UniformBuffer {
  return sceneLights(scene).buffer;
}

const bindsHapticLights = new WeakMap<Effect, boolean>();

/** Bind the block for a draw with `effect`, when that Effect reads it. */
export function bindHapticLights(scene: Scene, effect: Effect): void {
  let binds = bindsHapticLights.get(effect);
  if (binds === undefined) {
    binds = effect.defines.includes("#define HAPTIC_LIGHTS");
    bindsHapticLights.set(effect, binds);
  }
  if (!binds) return;
  // bindToEffect only records the Effect; bindUniformBuffer binds it.
  const buffer = sceneLights(scene).buffer;
  buffer.bindToEffect(effect, "HapticLights");
  buffer.bindUniformBuffer();
}

/**
 * Write the block from the Scene's lights, once per frame: Forward's admitted lights, or every illuminating light
 * ranked as Forward ranks them, up to each type's maximum. The first hemispheric light is the fill.
 */
export function writeHapticLights(scene: Scene): void {
  const set = engines.get(scene.getEngine());
  if (!set) return;
  const state = sceneLights(scene);
  const ranked = state.ranked;
  ranked.length = 0;
  for (const light of scene.lights)
    if (set === "forward" ? light.isEnabled() && light.intensity > 0 : isIlluminatingLight(light)) ranked.push(light);
  if (set === "all") sortLightsByAdmission(scene, ranked, state.held);
  state.next.clear();
  const offset = scene.floatingOriginOffset;
  let fill: HemisphericLight | null = null;
  let directionals = 0;
  let points = 0;
  let spots = 0;
  for (const light of ranked) {
    if (light instanceof HemisphericLight) {
      if (fill) continue;
      fill = light;
    } else if (light instanceof DirectionalLight) {
      if (directionals === HAPTIC_LIGHT_MAXIMUM.directional) continue;
      const direction = light.computeTransformedInformation() ? light.transformedDirection : light.direction;
      const intensity = light.getScaledIntensity();
      directional.set([direction.x, direction.y, direction.z, light.radius,
        light.diffuse.r * intensity, light.diffuse.g * intensity, light.diffuse.b * intensity, 0], directionals * 8);
      directionals++;
    } else if (light instanceof SpotLight) {
      if (spots === HAPTIC_LIGHT_MAXIMUM.spot) continue;
      const transformed = light.computeTransformedInformation();
      const position = transformed ? light.transformedPosition : light.position;
      const direction = (transformed ? light.transformedDirection : light.direction).normalizeToNew();
      const intensity = light.getScaledIntensity();
      spot.set([position.x - offset.x, position.y - offset.y, position.z - offset.z, light.radius,
        direction.x, direction.y, direction.z, Math.cos(light.angle * 0.5),
        light.diffuse.r * intensity, light.diffuse.g * intensity, light.diffuse.b * intensity, light.range], spots * 12);
      spots++;
    } else if (light instanceof PointLight) {
      if (points === HAPTIC_LIGHT_MAXIMUM.point) continue;
      const position = light.computeTransformedInformation() ? light.transformedPosition : light.position;
      const intensity = light.getScaledIntensity();
      point.set([position.x - offset.x, position.y - offset.y, position.z - offset.z, light.radius,
        light.diffuse.r * intensity, light.diffuse.g * intensity, light.diffuse.b * intensity, light.range], points * 8);
      points++;
    } else continue;
    state.next.add(light);
  }
  const buffer = state.buffer;
  buffer.updateFloat4("hapticCounts", directionals, points, spots, fill ? 1 : 0);
  if (fill) {
    const direction = fill.direction.normalizeToNew();
    const sky = fill.diffuse.scale(fill.getScaledIntensity());
    const ground = fill.groundColor.scale(fill.intensity);
    buffer.updateFloat4("hapticFillDirection", direction.x, direction.y, direction.z, 0);
    buffer.updateFloat4("hapticFillSky", sky.r, sky.g, sky.b, 0);
    buffer.updateFloat4("hapticFillGround", ground.r, ground.g, ground.b, 0);
  }
  buffer.updateFloatArray("hapticDirectional", directional);
  buffer.updateFloatArray("hapticPoint", point);
  buffer.updateFloatArray("hapticSpot", spot);
  buffer.update();
  [state.held, state.next] = [state.next, state.held];
}
