import {
  DirectionalLight,
  HemisphericLight,
  Matrix,
  PointLight,
  RectAreaLight,
  SpotLight,
  TmpVectors,
  UniformBuffer,
  Vector3,
  type AbstractEngine,
  type Effect,
  type Light,
  type Scene,
} from "@babylonjs/core";
import { retainAreaLightLookup } from "./area-light-resources";
import { isIlluminatingLight, sortLightsByAdmission } from "./light-policy";

/**
 * Lighting plan: lit graph Materials (`HapticLightingBlock`) read every light from one per-Scene uniform block
 * (`HapticLights`) and loop over it, instead of Babylon's per-light defines, so no light change compiles a shader.
 * Behind an Engine switch while the plan's phases land; unshadowed.
 */

/** Records per light type the block holds. */
export const HAPTIC_LIGHT_MAXIMUM = { directional: 4, point: 32, spot: 16, rect: 4 } as const;

const engines = new WeakSet<AbstractEngine>();

/** Switch the light block on an Engine; graph Materials compiled afterwards draw with `HapticLightingBlock`. */
export function setHapticLighting(engine: AbstractEngine, enabled: boolean): void {
  if (enabled) engines.add(engine);
  else engines.delete(engine);
}

export function hapticLighting(engine: AbstractEngine): boolean {
  return engines.has(engine);
}

/** Graph Materials of `scene` draw with the light block: switched on, on an Engine with uniform buffers. */
export function hapticLightingActive(scene: Scene): boolean {
  const engine = scene.getEngine();
  return engines.has(engine) && engine.supportsUniformBuffers;
}

/** The block's GLSL and WGSL declarations; their layout matches `hapticLightBuffer`. WGSL binds the buffer by the variable's name. */
export const HAPTIC_LIGHTS_GLSL = `layout(std140) uniform HapticLights {
vec4 hapticCounts;
vec4 hapticFillDirection;
vec4 hapticFillSky;
vec4 hapticFillGround;
vec4 hapticDirectional[${HAPTIC_LIGHT_MAXIMUM.directional * 2}];
vec4 hapticPoint[${HAPTIC_LIGHT_MAXIMUM.point * 2}];
vec4 hapticSpot[${HAPTIC_LIGHT_MAXIMUM.spot * 3}];
vec4 hapticRect[${HAPTIC_LIGHT_MAXIMUM.rect * 4}];
};
`;
export const HAPTIC_LIGHTS_WGSL = `struct HapticLightsBlock {
hapticCounts: vec4f,
hapticFillDirection: vec4f,
hapticFillSky: vec4f,
hapticFillGround: vec4f,
hapticDirectional: array<vec4f, ${HAPTIC_LIGHT_MAXIMUM.directional * 2}>,
hapticPoint: array<vec4f, ${HAPTIC_LIGHT_MAXIMUM.point * 2}>,
hapticSpot: array<vec4f, ${HAPTIC_LIGHT_MAXIMUM.spot * 3}>,
hapticRect: array<vec4f, ${HAPTIC_LIGHT_MAXIMUM.rect * 4}>,
};
var<uniform> HapticLights : HapticLightsBlock;
`;

type SceneLights = { buffer: UniformBuffer; held: Set<Light>; next: Set<Light>; ranked: Light[] };
const scenes = new WeakMap<Scene, SceneLights>();
const directional = new Float32Array(HAPTIC_LIGHT_MAXIMUM.directional * 8);
const point = new Float32Array(HAPTIC_LIGHT_MAXIMUM.point * 8);
const spot = new Float32Array(HAPTIC_LIGHT_MAXIMUM.spot * 12);
const rect = new Float32Array(HAPTIC_LIGHT_MAXIMUM.rect * 16);

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
    buffer.addUniform("hapticRect", 4, HAPTIC_LIGHT_MAXIMUM.rect * 4);
    buffer.create();
    // Rect area lights read Babylon's LTC tables, always bound, so a rect light arriving compiles nothing.
    const releaseLookup = retainAreaLightLookup(scene);
    lights = { buffer, held: new Set(), next: new Set(), ranked: [] };
    scenes.set(scene, lights);
    scene.onDisposeObservable.addOnce(() => {
      buffer.dispose();
      releaseLookup();
    });
  }
  return lights;
}

/** `scene`'s light block, as the shaders read it. */
export function hapticLightBuffer(scene: Scene): UniformBuffer {
  return sceneLights(scene).buffer;
}

/** Bind the block for a draw with `effect`, which reads it. */
export function bindHapticLights(scene: Scene, effect: Effect): void {
  // Bound directly, never through bindToEffect: a UniformBuffer rebinds to its recorded Effect on every update, which
  // on WebGPU writes into whichever draw context is current, possibly a released one, as the block updates between draws.
  const buffer = sceneLights(scene).buffer.getBuffer();
  if (buffer) effect.bindUniformBuffer(buffer, "HapticLights");
}

/**
 * Write the block from the Scene's lights, once per frame: every illuminating light, ranked as Forward ranks them
 * (priority, distance, the incumbent bonus), up to each type's maximum. The first hemispheric light is the fill.
 * A rect area light's record holds its centre and its half width and half height vectors, as Babylon's does.
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
  let rects = 0;
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
    } else if (light instanceof RectAreaLight) {
      if (rects === HAPTIC_LIGHT_MAXIMUM.rect) continue;
      const world = light.parent?.getWorldMatrix() ?? Matrix.IdentityReadOnly;
      const position = Vector3.TransformCoordinatesToRef(light.position, world, TmpVectors.Vector3[0]);
      const width = Vector3.TransformNormalFromFloatsToRef(light.width / 2, 0, 0, world, TmpVectors.Vector3[1]);
      const height = Vector3.TransformNormalFromFloatsToRef(0, light.height / 2, 0, world, TmpVectors.Vector3[2]);
      const intensity = light.getScaledIntensity();
      rect.set([position.x - offset.x, position.y - offset.y, position.z - offset.z, 0, width.x, width.y, width.z, 0,
        height.x, height.y, height.z, 0, light.diffuse.r * intensity, light.diffuse.g * intensity, light.diffuse.b * intensity, 0], rects * 16);
      rects++;
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
  buffer.updateFloat4("hapticCounts", directionals, points, spots, rects);
  if (!fill) buffer.updateFloat4("hapticFillDirection", 0, 1, 0, 0);
  else {
    const direction = fill.direction.normalizeToNew();
    const sky = fill.diffuse.scale(fill.getScaledIntensity());
    const ground = fill.groundColor.scale(fill.intensity);
    // w marks the fill present.
    buffer.updateFloat4("hapticFillDirection", direction.x, direction.y, direction.z, 1);
    buffer.updateFloat4("hapticFillSky", sky.r, sky.g, sky.b, 0);
    buffer.updateFloat4("hapticFillGround", ground.r, ground.g, ground.b, 0);
  }
  buffer.updateFloatArray("hapticDirectional", directional);
  buffer.updateFloatArray("hapticPoint", point);
  buffer.updateFloatArray("hapticSpot", spot);
  buffer.updateFloatArray("hapticRect", rect);
  buffer.update();
  [state.held, state.next] = [state.next, state.held];
}
