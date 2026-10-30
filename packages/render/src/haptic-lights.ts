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
  type Camera,
  type DataBuffer,
  type Effect,
  type Light,
  type Scene,
} from "@babylonjs/core";
import { rectLightEmission, syncAreaEmissionLayers } from "./area-emission-array";
import { retainAreaLightLookup } from "./area-light-resources";
import { deviceProfile } from "./device-profile";
import { isIlluminatingLight, sortLightsByAdmission, type ForwardLightSelection } from "./light-policy";
import { CLUSTER_BLOCK_WORDS, CLUSTER_COUNT, CLUSTER_HEADER_FLOATS, buildLightClusters, type ClusterLight } from "./light-clusters";
import { AtlasCascadedShadowGenerator, AtlasShadowGenerator, shadowAtlasTexture, watchShadowDraws } from "./shadow-atlas";

/**
 * Lighting plan: lit graph Materials (`HapticLightingBlock`) read every light from one per-Scene uniform block
 * (`HapticLights`) and loop over it, instead of Babylon's per-light defines, so no light change compiles a shader.
 * Behind an Engine switch while the plan's phases land; unshadowed.
 */

/** Records per light type the block holds: the most any device draws (`DeviceProfile.lightMaximum`). */
export const HAPTIC_LIGHT_MAXIMUM = { directional: 4, point: 32, spot: 16, rect: 4 } as const;
/**
 * Shadow views the block holds: first one per cascade of the shadowed sun, then 48 for local lights' tiles (a spot
 * light's one, a point light's six). A light whose views do not fit draws unshadowed.
 */
export const HAPTIC_SHADOW_VIEWS = 4 + 48;
/** The views the sun's cascades take, whichever camera's map they are; local lights' follow. */
const SUN_SHADOW_VIEWS = 4;
/**
 * A shadow view's record: its light's view-projection (four columns), its atlas tile (u, v, size, texel), (darkness,
 * filter: PCF's quality 0 low, 1 medium, 2 high, Contact Hardening's 3, 4, 5, 1 for a cascade, whose depth clamps, 1
 * for receiver-plane bias) and Contact Hardening's terms: a perspective view's (near, far, 0, light size), a cascade's
 * (width correction, height correction, depth correction, light size), the light size a share of the tile.
 */
export const HAPTIC_SHADOW_VIEW_VEC4S = 7;

/** The block's GLSL and WGSL declarations; their layout matches `hapticLightBuffer`. WGSL binds the buffer by the variable's name. */
export const HAPTIC_LIGHTS_GLSL = `layout(std140) uniform HapticLights {
vec4 hapticCounts;
vec4 hapticFillDirection;
vec4 hapticFillSky;
vec4 hapticFillGround;
vec4 hapticDirectional[${HAPTIC_LIGHT_MAXIMUM.directional * 2}];
vec4 hapticPoint[${HAPTIC_LIGHT_MAXIMUM.point * 3}];
vec4 hapticSpot[${HAPTIC_LIGHT_MAXIMUM.spot * 4}];
vec4 hapticRect[${HAPTIC_LIGHT_MAXIMUM.rect * 4}];
vec4 hapticShadowViews[${HAPTIC_SHADOW_VIEWS * HAPTIC_SHADOW_VIEW_VEC4S}];
vec4 hapticSunShadow[4];
};
`;
/**
 * The light clusters' block (`light-clusters.ts`): the header, then two mask words per cluster. Its own block, as the
 * light block has no room for it, and one buffer, so a view always reads masks with the header they were built for.
 */
export const HAPTIC_CLUSTERS_GLSL = `layout(std140) uniform HapticClusters {
vec4 hapticClusterHeader[${CLUSTER_HEADER_FLOATS / 4}];
uvec4 hapticClusterMasks[${CLUSTER_COUNT / 2}];
};
`;
export const HAPTIC_CLUSTERS_WGSL = `struct HapticClustersBlock {
hapticClusterHeader: array<vec4f, ${CLUSTER_HEADER_FLOATS / 4}>,
hapticClusterMasks: array<vec4u, ${CLUSTER_COUNT / 2}>,
};
var<uniform> HapticClusters : HapticClustersBlock;
`;
export const HAPTIC_LIGHTS_WGSL = `struct HapticLightsBlock {
hapticCounts: vec4f,
hapticFillDirection: vec4f,
hapticFillSky: vec4f,
hapticFillGround: vec4f,
hapticDirectional: array<vec4f, ${HAPTIC_LIGHT_MAXIMUM.directional * 2}>,
hapticPoint: array<vec4f, ${HAPTIC_LIGHT_MAXIMUM.point * 3}>,
hapticSpot: array<vec4f, ${HAPTIC_LIGHT_MAXIMUM.spot * 4}>,
hapticRect: array<vec4f, ${HAPTIC_LIGHT_MAXIMUM.rect * 4}>,
hapticShadowViews: array<vec4f, ${HAPTIC_SHADOW_VIEWS * HAPTIC_SHADOW_VIEW_VEC4S}>,
hapticSunShadow: array<vec4f, 4>,
};
var<uniform> HapticLights : HapticLightsBlock;
`;

/** A shadowed local light's map this frame and its first shadow view. */
type ShadowedLight = { shadow: AtlasShadowGenerator; first: number };
type SceneLights = {
  buffer: UniformBuffer; rects: RectAreaLight[]; layers: number[]; limits: string[];
  /** The shadowed sun this frame and the map of it last written, the rendering camera's (`sunShadowMap`). */
  shadowed: ShadowedLight[]; sun: DirectionalLight | null; sunWritten: AtlasCascadedShadowGenerator | null;
  shadowViews: Float32Array; sunShadow: Float32Array;
  /** The clusters' block as written (`HAPTIC_CLUSTERS_GLSL`), its GPU buffer and the local lights it was built from. */
  clusterWords: Float32Array; clusterMasks: Uint32Array; clusterHeader: Float32Array; clusterBuffer: DataBuffer | null;
  clusterLights: ClusterLight[];
  /** The camera the clusters were last built for; another active camera rebuilds them at its first bind. */
  clusterCamera: Camera | null;
};
const scenes = new WeakMap<Scene, SceneLights>();
const directional = new Float32Array(HAPTIC_LIGHT_MAXIMUM.directional * 8);
const point = new Float32Array(HAPTIC_LIGHT_MAXIMUM.point * 12);
const spot = new Float32Array(HAPTIC_LIGHT_MAXIMUM.spot * 16);
const shadowTransform = new Matrix();
const rect = new Float32Array(HAPTIC_LIGHT_MAXIMUM.rect * 16);

function sceneLights(scene: Scene): SceneLights {
  let lights = scenes.get(scene);
  if (!lights) {
    // Not dynamic: on WebGPU, a write after the frame's last update moves the block to another buffer, so draws keep the
    // values they were bound with when it changes between them (a view drawing with its own sun map); a dynamic buffer
    // has one, which every draw of the frame reads at its last values.
    const buffer = new UniformBuffer(scene.getEngine(), undefined, false, "HapticLights");
    buffer.addUniform("hapticCounts", 4);
    buffer.addUniform("hapticFillDirection", 4);
    buffer.addUniform("hapticFillSky", 4);
    buffer.addUniform("hapticFillGround", 4);
    buffer.addUniform("hapticDirectional", 4, HAPTIC_LIGHT_MAXIMUM.directional * 2);
    buffer.addUniform("hapticPoint", 4, HAPTIC_LIGHT_MAXIMUM.point * 3);
    buffer.addUniform("hapticSpot", 4, HAPTIC_LIGHT_MAXIMUM.spot * 4);
    buffer.addUniform("hapticRect", 4, HAPTIC_LIGHT_MAXIMUM.rect * 4);
    buffer.addUniform("hapticShadowViews", 4, HAPTIC_SHADOW_VIEWS * HAPTIC_SHADOW_VIEW_VEC4S);
    buffer.addUniform("hapticSunShadow", 4, 4);
    buffer.create();
    // Rect area lights read Babylon's LTC tables, always bound, so a rect light arriving compiles nothing.
    const releaseLookup = retainAreaLightLookup(scene);
    // Uploaded as raw words through a Float32Array view, so no mask passes through a JavaScript number.
    const clusterWords = new Float32Array(CLUSTER_BLOCK_WORDS);
    lights = {
      buffer, rects: [], layers: [], limits: [], shadowed: [], sun: null, sunWritten: null,
      shadowViews: new Float32Array(HAPTIC_SHADOW_VIEWS * HAPTIC_SHADOW_VIEW_VEC4S * 4), sunShadow: new Float32Array(16),
      clusterWords, clusterMasks: new Uint32Array(clusterWords.buffer, CLUSTER_HEADER_FLOATS * 4),
      clusterHeader: clusterWords.subarray(0, CLUSTER_HEADER_FLOATS),
      clusterBuffer: scene.getEngine().createUniformBuffer(clusterWords, "HapticClusters"), clusterLights: [],
      clusterCamera: null,
    };
    scenes.set(scene, lights);
    // A map draws after the block's write, with the views it is then sampled by.
    const state = lights;
    watchShadowDraws(scene, () => {
      writeShadowViews(scene, state);
      state.buffer.update();
    });
    // A view with its own sun map (a Full Quality capture's) draws with it, and the scene view with its own after.
    const cameraChanged = scene.onActiveCameraChanged.add(() => {
      if (!state.sun || sunShadowMap(scene, state.sun) === state.sunWritten) return;
      writeShadowViews(scene, state);
      state.buffer.update();
    });
    const engine = scene.getEngine();
    const restored = engine.onContextRestoredObservable.add(() => {
      state.clusterBuffer = engine.createUniformBuffer(state.clusterWords, "HapticClusters");
    });
    scene.onDisposeObservable.addOnce(() => {
      scene.onActiveCameraChanged.remove(cameraChanged);
      engine.onContextRestoredObservable.remove(restored);
      buffer.dispose();
      if (state.clusterBuffer) engine._releaseBuffer(state.clusterBuffer);
      state.clusterBuffer = null;
      releaseLookup();
    });
  }
  return lights;
}

/** Builds `state`'s clusters for the Scene's active camera from its local lights as last written, and uploads them. */
function writeClusters(scene: Scene, state: SceneLights): void {
  state.clusterCamera = scene.activeCamera;
  buildLightClusters(state.clusterMasks, state.clusterHeader, state.clusterLights, scene.activeCamera, scene.floatingOriginOffset);
  if (state.clusterBuffer) scene.getEngine().updateUniformBuffer(state.clusterBuffer, state.clusterWords);
}

/** Bind the clusters' block for a draw with `effect`, which reads it. */
export function bindHapticClusters(scene: Scene, effect: Effect): void {
  const state = sceneLights(scene);
  // The clusters follow the rendering camera (a capture's), built at its first draw; masks built for another camera
  // stay correct, only coarser.
  if (state.clusterCamera !== scene.activeCamera) writeClusters(scene, state);
  const buffer = state.clusterBuffer;
  if (buffer) effect.bindUniformBuffer(buffer, "HapticClusters");
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
  return admitted;
};

/** Whether `light` casts shadows this frame. */
function castsShadows(scene: Scene, light: Light): boolean {
  return scene.shadowsEnabled && light.shadowEnabled;
}

/**
 * A spot or point light's map when it casts shadows into the atlas and the block has room for its views (from `views`
 * on), as its first view, or null.
 */
function shadowedLight(scene: Scene, light: SpotLight | PointLight, views: number): ShadowedLight | null {
  const shadow = light.getShadowGenerator();
  if (!(shadow instanceof AtlasShadowGenerator) || !castsShadows(scene, light) || views + shadow.tiles.length > HAPTIC_SHADOW_VIEWS)
    return null;
  return { shadow, first: views };
}

/**
 * The sun's cascades the rendering camera samples: its own map when it has one in the atlas (a Full Quality capture's,
 * `SceneShadowController.attachView`), else the scene view's, or null when neither is in the atlas.
 */
function sunShadowMap(scene: Scene, light: DirectionalLight): AtlasCascadedShadowGenerator | null {
  const own = scene.activeCamera && light.getShadowGenerator(scene.activeCamera);
  if (own instanceof AtlasCascadedShadowGenerator) return own;
  const shadow = light.getShadowGenerator();
  return shadow instanceof AtlasCascadedShadowGenerator ? shadow : null;
}

/** Writes `shadow`'s views from `first` on (`writeShadowViews`). */
function writeViews(scene: Scene, state: SceneLights, shadow: AtlasShadowGenerator | AtlasCascadedShadowGenerator, first: number, edge: number): void {
  const offset = scene.floatingOriginOffset;
  const quality = shadow.filteringQuality === ShadowGenerator.QUALITY_LOW ? 0 : shadow.filteringQuality === ShadowGenerator.QUALITY_MEDIUM ? 1 : 2;
  const filter = quality + (shadow.useContactHardeningShadow ? 3 : 0);
  const size = shadow.contactHardeningLightSizeUVRatio;
  const cascaded = shadow instanceof AtlasCascadedShadowGenerator;
  shadow.tiles.forEach((tile, index) => {
    const base = (first + index) * HAPTIC_SHADOW_VIEW_VEC4S * 4;
    Matrix.TranslationToRef(offset.x, offset.y, offset.z, shadowTransform);
    shadowTransform.multiplyToRef(shadow.drawnViews[index]!, shadowTransform);
    state.shadowViews.set(shadowTransform.m, base);
    state.shadowViews.set([tile.x / edge, tile.y / edge, tile.size / edge, 1 / edge, shadow.getDarkness(), filter, Number(cascaded),
      Number(cascaded && shadow.autoBias)], base + 16);
    if (cascaded) {
      const correction = shadow.cascadeCorrections[index]!;
      state.shadowViews.set([correction.x, correction.y, correction.z, size], base + 24);
    } else {
      const range = shadow.drawnDepthRange;
      state.shadowViews.set([range.x, range.y, 0, size], base + 24);
    }
  });
}

/**
 * Writes the shadowed lights' views: per tile, the view-projection it was last drawn with, relative to the floating
 * origin (the block's positions are), the tile in atlas texture coordinates, the darkness, which stays neutral until
 * the map has drawn, the filter and its quality, and Contact Hardening's terms; the sun's first, from the map the rendering camera samples
 * (`sunShadowMap`), with its cascade choice (`hapticSunShadow`: its cascade count, blend factor, distance fade and
 * first view, always 0; the camera's view depth plane; its cascades' far ends and lengths in it), as last drawn.
 * Updates them in the buffer, which the caller updates.
 */
function writeShadowViews(scene: Scene, state: SceneLights): void {
  const offset = scene.floatingOriginOffset;
  const edge = shadowAtlasTexture(scene).getRenderSize();
  state.sunShadow.fill(0);
  for (const { shadow, first } of state.shadowed) writeViews(scene, state, shadow, first, edge);
  const shadow = state.sunWritten = state.sun && sunShadowMap(scene, state.sun);
  if (shadow) {
    writeViews(scene, state, shadow, 0, edge);
    const plane = shadow.cascadeDepth;
    // The camera's view depth of a block position, which is relative to the floating origin.
    const sign = scene.useRightHandedSystem ? -1 : 1;
    state.sunShadow.set([shadow.numCascades, shadow.cascadeBlendPercentage === 0 ? 10000 : 1 / shadow.cascadeBlendPercentage, shadow.fadeFraction, 0,
      sign * plane.x, sign * plane.y, sign * plane.z, sign * (plane.w + plane.x * offset.x + plane.y * offset.y + plane.z * offset.z)]);
    state.sunShadow.set(shadow.cascadeEnds.slice(0, 4), 8);
    state.sunShadow.set(shadow.cascadeLengths.slice(0, 4), 12);
  }
  state.buffer.updateFloatArray("hapticShadowViews", state.shadowViews);
  state.buffer.updateFloatArray("hapticSunShadow", state.sunShadow);
}

/**
 * Write the block from the lights the admission left on (`selectHapticLights`), once per frame, after it. The fill is
 * the admitted hemispheric light. A spot light's record holds its cone's half-angle cosines, the outer beside its
 * direction and the inner beside its shadow's first view (glTF's cone: full inside the inner, none past the outer). A
 * rect area light's record holds its centre and its half width and half height vectors, as Babylon's does, and the
 * layer of its emission in the texture array (`area-emission-array.ts`), -1 for its flat colour. A Scene with its lights disabled (the Unlit viewport) writes none, as Babylon's materials then light
 * with none.
 */
export function writeHapticLights(scene: Scene): void {
  const state = sceneLights(scene);
  const offset = scene.floatingOriginOffset;
  let fill: HemisphericLight | null = null;
  let directionals = 0;
  let points = 0;
  let spots = 0;
  let rects = 0;
  let views = SUN_SHADOW_VIEWS;
  state.rects.length = 0;
  state.shadowed.length = 0;
  state.sun = null;
  const clusters = state.clusterLights;
  clusters.length = 0;
  // The admission keeps within the block's records; the checks below hold them whatever it admitted.
  if (scene.lightsEnabled) for (const light of scene.lights) {
    if (!light.isEnabled() || !isIlluminatingLight(light)) continue;
    if (light instanceof HemisphericLight) {
      fill ??= light;
    } else if (light instanceof DirectionalLight) {
      if (directionals === HAPTIC_LIGHT_MAXIMUM.directional) continue;
      const direction = light.computeTransformedInformation() ? light.transformedDirection : light.direction;
      const intensity = light.getScaledIntensity();
      // The first shadowed sun's shadow is the block's sun shadow; w marks the light that casts it.
      const shadowed = !state.sun && castsShadows(scene, light) && light.getShadowGenerator() instanceof AtlasCascadedShadowGenerator;
      if (shadowed) state.sun = light;
      directional.set([direction.x, direction.y, direction.z, light.radius,
        light.diffuse.r * intensity, light.diffuse.g * intensity, light.diffuse.b * intensity, shadowed ? 1 : 0], directionals * 8);
      directionals++;
    } else if (light instanceof SpotLight) {
      if (spots === HAPTIC_LIGHT_MAXIMUM.spot) continue;
      const transformed = light.computeTransformedInformation();
      const position = transformed ? light.transformedPosition : light.position;
      const direction = (transformed ? light.transformedDirection : light.direction).normalizeToNew();
      const intensity = light.getScaledIntensity();
      const shadowed = shadowedLight(scene, light, views);
      if (shadowed) {
        state.shadowed.push(shadowed);
        views += shadowed.shadow.tiles.length;
      }
      spot.set([position.x - offset.x, position.y - offset.y, position.z - offset.z, light.radius,
        direction.x, direction.y, direction.z, Math.cos(light.angle * 0.5),
        light.diffuse.r * intensity, light.diffuse.g * intensity, light.diffuse.b * intensity, light.range,
        shadowed ? shadowed.first : -1, Math.cos(light.innerAngle * 0.5), 0, 0], spots * 16);
      clusters.push({ kind: "spot", index: spots, x: position.x - offset.x, y: position.y - offset.y, z: position.z - offset.z, radius: light.range });
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
      clusters.push({ kind: "rect", index: rects, x: 0, y: 0, z: 0, radius: Infinity });
      rects++;
    } else if (light instanceof PointLight) {
      if (points === HAPTIC_LIGHT_MAXIMUM.point) continue;
      const position = light.computeTransformedInformation() ? light.transformedPosition : light.position;
      const intensity = light.getScaledIntensity();
      const shadowed = shadowedLight(scene, light, views);
      if (shadowed) {
        state.shadowed.push(shadowed);
        views += shadowed.shadow.tiles.length;
      }
      // The shadow: its first view and its faces (six, one for a point light with a direction), -1 for none.
      point.set([position.x - offset.x, position.y - offset.y, position.z - offset.z, light.radius,
        light.diffuse.r * intensity, light.diffuse.g * intensity, light.diffuse.b * intensity, light.range,
        shadowed ? shadowed.first : -1, shadowed?.shadow.tiles.length ?? 0, 0, 0], points * 12);
      clusters.push({ kind: "point", index: points, x: position.x - offset.x, y: position.y - offset.y, z: position.z - offset.z, radius: light.range });
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
  writeShadowViews(scene, state);
  buffer.update();
  writeClusters(scene, state);
}

/**
 * Writes into `out` the block's shadow views of `light` as last written: a spot light's one, a point light's faces or
 * the shadowed sun's cascades (from view 0, the rendering camera's map); false when the block draws it unshadowed.
 */
export function hapticShadowViews(scene: Scene, light: Light, out: { first: number; count: number }): boolean {
  const state = scenes.get(scene);
  if (!state) return false;
  if (light === state.sun) {
    if (!state.sunWritten) return false;
    out.first = 0;
    out.count = state.sunWritten.tiles.length;
    return true;
  }
  for (const { shadow, first } of state.shadowed)
    if (shadow.getLight() === light) {
      out.first = first;
      out.count = shadow.tiles.length;
      return true;
    }
  return false;
}

/** Lights the block draws other than as authored, for `sceneLightingLimits`. */
export function hapticLightLimits(scene: Scene): readonly string[] {
  return scenes.get(scene)?.limits ?? [];
}
