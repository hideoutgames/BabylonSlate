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

/**
 * Lighting plan: lit graph Materials (`HapticLightingBlock`) read every light from one per-Scene uniform block
 * (`HapticLights`) and loop over it, instead of Babylon's per-light defines, so no light change compiles a shader.
 * Behind an Engine switch while the plan's phases land; GLSL only, unshadowed.
 */

/** Records per light type the block holds. */
export const HAPTIC_LIGHT_MAXIMUM = { directional: 4, point: 32, spot: 16 } as const;

const engines = new WeakSet<AbstractEngine>();

/** Switch the light block on an Engine; graph Materials compiled afterwards draw with `HapticLightingBlock`. */
export function setHapticLighting(engine: AbstractEngine, enabled: boolean): void {
  if (enabled) engines.add(engine);
  else engines.delete(engine);
}

export function hapticLighting(engine: AbstractEngine): boolean {
  return engines.has(engine);
}

/** Graph Materials of `scene` draw with the light block: switched on, on a WebGL2 Engine with uniform buffers. */
export function hapticLightingActive(scene: Scene): boolean {
  const engine = scene.getEngine();
  return engines.has(engine) && !engine.isWebGPU && engine.supportsUniformBuffers;
}

/** The block's GLSL declaration; its layout matches `hapticLightBuffer`. */
export const HAPTIC_LIGHTS_GLSL = `layout(std140) uniform HapticLights {
vec4 hapticCounts;
vec4 hapticFillDirection;
vec4 hapticFillSky;
vec4 hapticFillGround;
vec4 hapticDirectional[${HAPTIC_LIGHT_MAXIMUM.directional * 2}];
vec4 hapticPoint[${HAPTIC_LIGHT_MAXIMUM.point * 2}];
vec4 hapticSpot[${HAPTIC_LIGHT_MAXIMUM.spot * 3}];
};
`;

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

/** Bind the block for a draw with `effect`, which reads it. */
export function bindHapticLights(scene: Scene, effect: Effect): void {
  // bindToEffect only records the Effect; bindUniformBuffer binds it.
  const buffer = sceneLights(scene).buffer;
  buffer.bindToEffect(effect, "HapticLights");
  buffer.bindUniformBuffer();
}

/**
 * Write the block from the Scene's lights, once per frame: every illuminating light, ranked as Forward ranks them
 * (priority, distance, the incumbent bonus), up to each type's maximum. The first hemispheric light is the fill.
 * A Scene with its lights disabled (the Unlit viewport) writes none, as Babylon's materials then light with none.
 */
export function writeHapticLights(scene: Scene): void {
  if (!engines.has(scene.getEngine())) return;
  const state = sceneLights(scene);
  const ranked = state.ranked;
  ranked.length = 0;
  if (scene.lightsEnabled) for (const light of scene.lights) if (isIlluminatingLight(light)) ranked.push(light);
  sortLightsByAdmission(scene, ranked, state.held);
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
