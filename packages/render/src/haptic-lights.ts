import {
  DirectionalLight,
  HemisphericLight,
  Matrix,
  PointLight,
  RectAreaLight,
  ShadowGenerator,
  SpotLight,
  TmpVectors,
  UniformBuffer,
  Vector3,
  type AbstractEngine,
  type Effect,
  type Light,
  type Scene,
} from "@babylonjs/core";
import { rectLightEmission, syncAreaEmissionLayers } from "./area-emission-array";
import { retainAreaLightLookup } from "./area-light-resources";
import { deviceProfile } from "./device-profile";
import { isIlluminatingLight, sortLightsByAdmission, type ForwardLightSelection } from "./light-policy";
import { AtlasShadowGenerator, shadowAtlasTexture } from "./shadow-atlas";

/**
 * Lighting plan: lit graph Materials (`HapticLightingBlock`) read every light from one per-Scene uniform block
 * (`HapticLights`) and loop over it, instead of Babylon's per-light defines, so no light change compiles a shader.
 * Behind an Engine switch while the plan's phases land; unshadowed.
 */

/** Records per light type the block holds: the most any device draws (`DeviceProfile.lightMaximum`). */
export const HAPTIC_LIGHT_MAXIMUM = { directional: 4, point: 32, spot: 16, rect: 4 } as const;
/** Shadow views the block holds: one per shadowed spot light. */
export const HAPTIC_SHADOW_VIEWS = 16;
/**
 * A shadow view's record: its light's view-projection (four columns), its atlas tile (u, v, size, texel) and (darkness,
 * filter quality: 0 low, 1 medium, 2 high).
 */
const SHADOW_VIEW_VEC4S = 6;

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
vec4 hapticSpot[${HAPTIC_LIGHT_MAXIMUM.spot * 4}];
vec4 hapticRect[${HAPTIC_LIGHT_MAXIMUM.rect * 4}];
vec4 hapticShadowViews[${HAPTIC_SHADOW_VIEWS * SHADOW_VIEW_VEC4S}];
};
`;
export const HAPTIC_LIGHTS_WGSL = `struct HapticLightsBlock {
hapticCounts: vec4f,
hapticFillDirection: vec4f,
hapticFillSky: vec4f,
hapticFillGround: vec4f,
hapticDirectional: array<vec4f, ${HAPTIC_LIGHT_MAXIMUM.directional * 2}>,
hapticPoint: array<vec4f, ${HAPTIC_LIGHT_MAXIMUM.point * 2}>,
hapticSpot: array<vec4f, ${HAPTIC_LIGHT_MAXIMUM.spot * 4}>,
hapticRect: array<vec4f, ${HAPTIC_LIGHT_MAXIMUM.rect * 4}>,
hapticShadowViews: array<vec4f, ${HAPTIC_SHADOW_VIEWS * SHADOW_VIEW_VEC4S}>,
};
var<uniform> HapticLights : HapticLightsBlock;
`;

type SceneLights = { buffer: UniformBuffer; rects: RectAreaLight[]; layers: number[]; limits: string[] };
const scenes = new WeakMap<Scene, SceneLights>();
const directional = new Float32Array(HAPTIC_LIGHT_MAXIMUM.directional * 8);
const point = new Float32Array(HAPTIC_LIGHT_MAXIMUM.point * 8);
const spot = new Float32Array(HAPTIC_LIGHT_MAXIMUM.spot * 16);
const shadowViews = new Float32Array(HAPTIC_SHADOW_VIEWS * SHADOW_VIEW_VEC4S * 4);
const shadowTransform = new Matrix();
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
    buffer.addUniform("hapticSpot", 4, HAPTIC_LIGHT_MAXIMUM.spot * 4);
    buffer.addUniform("hapticRect", 4, HAPTIC_LIGHT_MAXIMUM.rect * 4);
    buffer.addUniform("hapticShadowViews", 4, HAPTIC_SHADOW_VIEWS * SHADOW_VIEW_VEC4S);
    buffer.create();
    // Rect area lights read Babylon's LTC tables, always bound, so a rect light arriving compiles nothing.
    const releaseLookup = retainAreaLightLookup(scene);
    lights = { buffer, rects: [], layers: [], limits: [] };
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

type LightKind = "fill" | keyof typeof HAPTIC_LIGHT_MAXIMUM;

/** How the block draws `light`: its records' type, the fill, or not at all (null). */
function lightKind(light: Light): LightKind | null {
  if (light instanceof HemisphericLight) return "fill";
  if (light instanceof DirectionalLight) return "directional";
  if (light instanceof SpotLight) return "spot";
  if (light instanceof RectAreaLight) return "rect";
  if (light instanceof PointLight) return "point";
  return null;
}

const admitted: Light[] = [];
const admittedCounts = { directional: 0, point: 0, spot: 0, rect: 0 };

/**
 * The block's admission, as Forward's selection (`syncForwardLightPolicy`): the lights ranked as Forward ranks them
 * (priority, camera distance, the incumbent bonus), then admitted while their type is under this device's maximum
 * (`DeviceProfile.lightMaximum`) and, for point, spot and rect lights, within the Local Light Budget. The first fill
 * is admitted beside them. The block has no shader slots or samplers to run out of; the rest are limited.
 */
export const selectHapticLights: ForwardLightSelection = (scene, candidates, previous, capacity, limited) => {
  sortLightsByAdmission(scene, candidates, previous);
  const maximum = deviceProfile().lightMaximum;
  admitted.length = 0;
  admittedCounts.directional = admittedCounts.point = admittedCounts.spot = admittedCounts.rect = 0;
  let fill = false;
  let locals = 0;
  for (const light of candidates) {
    const kind = lightKind(light);
    if (kind === "fill") {
      if (fill) { limited.push(light); continue; }
      fill = true;
    } else {
      const local = kind !== "directional";
      if (!kind || admittedCounts[kind] >= maximum[kind] || (local && locals >= capacity.locals)) { limited.push(light); continue; }
      admittedCounts[kind]++;
      if (local) locals++;
    }
    admitted.push(light);
  }
  return { admitted, samplers: 0 };
};

/**
 * Writes `light`'s shadow as shadow view `index` when it casts shadows into the atlas and the block has a view free:
 * its view-projection relative to the floating origin (the block's positions are), its tile in atlas texture
 * coordinates, its darkness, which stays neutral until the tile has drawn, and its filter quality. Returns the view's
 * index, or -1 for none.
 */
function writeShadowView(scene: Scene, light: SpotLight, index: number): number {
  const generator = light.getShadowGenerator();
  if (!(generator instanceof AtlasShadowGenerator) || !scene.shadowsEnabled || !light.shadowEnabled || index >= HAPTIC_SHADOW_VIEWS) return -1;
  const offset = scene.floatingOriginOffset;
  Matrix.TranslationToRef(offset.x, offset.y, offset.z, shadowTransform);
  shadowTransform.multiplyToRef(generator.getTransformMatrix(), shadowTransform);
  const base = index * SHADOW_VIEW_VEC4S * 4, edge = shadowAtlasTexture(scene).getRenderSize(), tile = generator.tile;
  shadowViews.set(shadowTransform.m, base);
  const quality = generator.filteringQuality === ShadowGenerator.QUALITY_LOW ? 0 : generator.filteringQuality === ShadowGenerator.QUALITY_MEDIUM ? 1 : 2;
  shadowViews.set([tile.x / edge, tile.y / edge, tile.size / edge, 1 / edge, generator.getDarkness(), quality, 0, 0], base + 16);
  return index;
}

/**
 * Write the block from the lights the admission left on (`selectHapticLights`), once per frame, after it. The fill is
 * the admitted hemispheric light. A rect area light's record holds its centre and its half width and half height
 * vectors, as Babylon's does, and the layer of its emission in the texture array (`area-emission-array.ts`), -1 for
 * its flat colour. A Scene with its lights disabled (the Unlit viewport) writes none, as Babylon's materials then light
 * with none.
 */
export function writeHapticLights(scene: Scene): void {
  if (!engines.has(scene.getEngine())) return;
  const state = sceneLights(scene);
  const offset = scene.floatingOriginOffset;
  let fill: HemisphericLight | null = null;
  let directionals = 0;
  let points = 0;
  let spots = 0;
  let rects = 0;
  let views = 0;
  state.rects.length = 0;
  // The admission keeps within the block's records; the checks below hold them whatever it admitted.
  if (scene.lightsEnabled) for (const light of scene.lights) {
    if (!light.isEnabled() || !isIlluminatingLight(light)) continue;
    if (light instanceof HemisphericLight) {
      fill ??= light;
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
        light.diffuse.r * intensity, light.diffuse.g * intensity, light.diffuse.b * intensity, light.range,
        writeShadowView(scene, light, views), 0, 0, 0], spots * 16);
      if (spot[spots * 16 + 12]! >= 0) views++;
      spots++;
    } else if (light instanceof RectAreaLight) {
      if (rects === HAPTIC_LIGHT_MAXIMUM.rect) continue;
      const world = light.parent?.getWorldMatrix() ?? Matrix.IdentityReadOnly;
      const position = Vector3.TransformCoordinatesToRef(light.position, world, TmpVectors.Vector3[0]);
      const width = Vector3.TransformNormalFromFloatsToRef(light.width / 2, 0, 0, world, TmpVectors.Vector3[1]);
      const height = Vector3.TransformNormalFromFloatsToRef(0, light.height / 2, 0, world, TmpVectors.Vector3[2]);
      const intensity = light.getScaledIntensity();
      rect.set([position.x - offset.x, position.y - offset.y, position.z - offset.z, 0, width.x, width.y, width.z, 0,
        height.x, height.y, height.z, 0, light.diffuse.r * intensity, light.diffuse.g * intensity, light.diffuse.b * intensity, -1], rects * 16);
      state.rects.push(light);
      rects++;
    } else if (light instanceof PointLight) {
      if (points === HAPTIC_LIGHT_MAXIMUM.point) continue;
      const position = light.computeTransformedInformation() ? light.transformedPosition : light.position;
      const intensity = light.getScaledIntensity();
      point.set([position.x - offset.x, position.y - offset.y, position.z - offset.z, light.radius,
        light.diffuse.r * intensity, light.diffuse.g * intensity, light.diffuse.b * intensity, light.range], points * 8);
      points++;
    }
  }
  const cap = deviceProfile().areaEmissionLayers;
  syncAreaEmissionLayers(scene, state.rects, cap, state.layers);
  state.limits.length = 0;
  state.rects.forEach((light, index) => {
    rect[index * 16 + 15] = state.layers[index]!;
    if (state.layers[index] === -1 && rectLightEmission(light))
      state.limits.push(`${light.name}: draws its flat colour; this device holds ${cap} area light emission textures at once`);
  });
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
  buffer.updateFloatArray("hapticShadowViews", shadowViews);
  buffer.update();
}

/** Lights the block draws other than as authored, for `sceneLightingLimits`. */
export function hapticLightLimits(scene: Scene): readonly string[] {
  return scenes.get(scene)?.limits ?? [];
}
