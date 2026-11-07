import { UniformBuffer } from "@babylonjs/core/Materials/uniformBuffer";
import type { Effect } from "@babylonjs/core/Materials/effect";
import type { Observer } from "@babylonjs/core/Misc/observable";
import type { Scene } from "@babylonjs/core/scene";
import { Constants } from "@babylonjs/core/Engines/constants";
import { RawTexture } from "@babylonjs/core/Materials/Textures/rawTexture";
import type { BaseTexture } from "@babylonjs/core/Materials/Textures/baseTexture";
import { ToHalfFloat } from "@babylonjs/core/Misc/textureTools";
import type { Light2DProperties } from "@haptic/core";
import { beginManagedRenderAllocation, releaseManagedRenderLeaseAfterDisposal, type ManagedRenderLease } from "./managed-render-resources";
import { polarShadow2D, SHADOW_2D_BINS, type WorldOccluder2D } from "./shadows-2d";

/**
 * 2D lighting plan: Sprites and Tilemaps with Shading Mode 2D in a Scene that holds 2D Lights (`setScene2DLighting`)
 * draw the unlit Material's 2D-lit variant (`UnlitMaterialKey.lighting`), whose colour multiplies the light at the
 * pixel's XY: the Global lights' sum plus each Point light's radial falloff and cone. Every 2D light is data in one
 * per-Scene uniform block, rewritten each frame, so no 2D light change compiles a shader. 2D lights are not Babylon
 * lights: 3D surfaces never see them and they take no part in the 3D light block, its budget or shadows.
 */

/** Point lights the block holds; the nearest to the camera win. Global lights have no limit. */
export const LIGHT_2D_MAXIMUM = 16;
const RECORD_VEC4S = 4;
/** Point lights whose shadows the block draws: the first shadow-casting ones it holds, in its order. */
export const SHADOWED_2D_MAXIMUM = 8;
/** The 2D shadow map's sampler: one row of `SHADOW_2D_BINS` per shadowed light (`shadows-2d.ts`). */
export const HAPTIC_2D_SHADOW_SAMPLER = "haptic2DShadowSampler";

/** A 2D light as the block draws it: authored values and its world pose in the XY plane. */
export type Light2DRecord = {
  properties: Light2DProperties;
  x: number;
  y: number;
  /** Unit XY direction the cone points along (the light's +Y). */
  directionX: number;
  directionY: number;
  /** A transform or attachment error; the light draws nothing. */
  error?: string;
};

/** The block's GLSL and WGSL declarations; their layout matches `sceneLights2D`'s buffer. */
export const HAPTIC_2D_LIGHTS_GLSL = `layout(std140) uniform Haptic2DLights {
vec4 haptic2DHeader;
vec4 haptic2DLights[${LIGHT_2D_MAXIMUM * RECORD_VEC4S}];
};
`;
export const HAPTIC_2D_LIGHTS_WGSL = `struct Haptic2DLightsBlock {
haptic2DHeader: vec4f,
haptic2DLights: array<vec4f, ${LIGHT_2D_MAXIMUM * RECORD_VEC4S}>,
};
var<uniform> Haptic2DLights : Haptic2DLightsBlock;
`;

/**
 * The light at a world XY: the header's ambient (the Global lights) plus, for each Point light, its colour times
 * (1 - t)² over its falloff (t from the inner radius to the radius) times its cone's smoothstep between the outer and
 * inner angles, times its shadow: past where its shadow map row says shadow starts along the pixel's direction, the
 * light fades out over 2% of its radius. Records: (x, y, radius, inner radius), (r, g, b, has cone), (direction x, y,
 * cos outer/2, cos inner/2), (shadow row's v, has shadow, 0, 0).
 */
export const HAPTIC_2D_LIGHT_FUNCTION_GLSL = `vec3 haptic2DLight(vec2 position) {
vec3 total = haptic2DHeader.yzw;
int count = int(haptic2DHeader.x);
for (int i = 0; i < ${LIGHT_2D_MAXIMUM}; i++) {
if (i >= count) { break; }
vec4 place = haptic2DLights[i * 4];
vec2 offset = position - place.xy;
float distance2D = length(offset);
if (distance2D >= place.z) { continue; }
float t = clamp((distance2D - place.w) / max(place.z - place.w, 0.0001), 0.0, 1.0);
float falloff = (1.0 - t) * (1.0 - t);
vec4 tint = haptic2DLights[i * 4 + 1];
if (tint.w > 0.5) {
vec4 cone = haptic2DLights[i * 4 + 2];
float along = distance2D > 0.0001 ? dot(offset / distance2D, cone.xy) : 1.0;
falloff *= smoothstep(0.0, 1.0, clamp((along - cone.z) / max(cone.w - cone.z, 0.0001), 0.0, 1.0));
}
vec4 shade = haptic2DLights[i * 4 + 3];
if (shade.y > 0.5) {
float edge = texture2D(${HAPTIC_2D_SHADOW_SAMPLER}, vec2(atan(offset.y, offset.x) * 0.15915494 + 0.5, shade.x)).r;
falloff *= 1.0 - smoothstep(edge, edge + 0.02, distance2D / place.z);
}
total += tint.rgb * falloff;
}
return total;
}
`;
export const HAPTIC_2D_LIGHT_FUNCTION_WGSL = `fn haptic2DLight(position: vec2f) -> vec3f {
var total = Haptic2DLights.haptic2DHeader.yzw;
let count = i32(Haptic2DLights.haptic2DHeader.x);
for (var i: i32 = 0; i < ${LIGHT_2D_MAXIMUM}; i = i + 1) {
if (i >= count) { break; }
let place = Haptic2DLights.haptic2DLights[i * 4];
let offset = position - place.xy;
let distance2D = length(offset);
if (distance2D >= place.z) { continue; }
let t = clamp((distance2D - place.w) / max(place.z - place.w, 0.0001), 0.0, 1.0);
var falloff = (1.0 - t) * (1.0 - t);
let tint = Haptic2DLights.haptic2DLights[i * 4 + 1];
if (tint.w > 0.5) {
let cone = Haptic2DLights.haptic2DLights[i * 4 + 2];
var along = 1.0;
if (distance2D > 0.0001) { along = dot(offset / distance2D, cone.xy); }
falloff = falloff * smoothstep(0.0, 1.0, clamp((along - cone.z) / max(cone.w - cone.z, 0.0001), 0.0, 1.0));
}
let shade = Haptic2DLights.haptic2DLights[i * 4 + 3];
if (shade.y > 0.5) {
let edge = textureSampleLevel(${HAPTIC_2D_SHADOW_SAMPLER}, ${HAPTIC_2D_SHADOW_SAMPLER}Sampler, vec2f(atan2(offset.y, offset.x) * 0.15915494 + 0.5, shade.x), 0.0).r;
falloff = falloff * (1.0 - smoothstep(edge, edge + 0.02, distance2D / place.z));
}
total = total + tint.rgb * falloff;
}
return total;
}
`;

type SceneLights2D = {
  /** The Scene's Shading Mode 2D surfaces draw lit (it holds or may spawn 2D Lights). */
  lit: boolean;
  records: Set<Light2DRecord>;
  /** Enabled Point lights past the block's maximum at the last write. */
  limited: Set<Light2DRecord>;
  buffer: UniformBuffer | null;
  beforeRender: Observer<Scene> | null;
  listeners: Set<() => void>;
  occluders: Set<Occluder2DRecord>;
  /** Bounds (minX, minY, maxX, maxY) a caster left or entered since the last write: the shadows they reach redraw. */
  changedBounds: number[];
  shadow: ShadowMap | null;
};

/**
 * A body's shadow casters: its outlines in its own frame and its pose. The Scene poses them into `world` only when a
 * shadowed light needs them (`refreshOccluder`), so casters in a Scene without shadowed lights cost a matrix copy.
 */
export type Occluder2DRecord = {
  /** Flat XY outlines in the body's frame (`Occluder2DShape`), sizes already scaled. */
  shapes: readonly { closed: boolean; points: readonly number[] }[];
  /** Body position and rotation about Z. */
  x: number; y: number; angle: number;
  /** The pose changed since `world` was built. */
  dirty: boolean;
  world: WorldOccluder2D[];
};

/** The 2D shadow map and, per row, the light and pose it was drawn for. */
type ShadowMap = {
  texture: RawTexture;
  lease: ManagedRenderLease | null;
  data: Uint16Array;
  rows: ({ record: Light2DRecord; x: number; y: number; radius: number } | null)[];
};
const ring = new Float32Array(SHADOW_2D_BINS);

const scenes = new WeakMap<Scene, SceneLights2D>();
const lightWords = new Float32Array(LIGHT_2D_MAXIMUM * RECORD_VEC4S * 4);
const candidates: { record: Light2DRecord; score: number }[] = [];

function sceneLights2D(scene: Scene): SceneLights2D {
  let state = scenes.get(scene);
  if (!state) {
    state = {
      lit: false, records: new Set(), limited: new Set(), buffer: null, beforeRender: null, listeners: new Set(),
      occluders: new Set(), changedBounds: [], shadow: null,
    };
    scenes.set(scene, state);
    const owned = state;
    scene.onDisposeObservable.addOnce(() => {
      if (owned.beforeRender) scene.onBeforeRenderObservable.remove(owned.beforeRender);
      owned.buffer?.dispose();
      owned.buffer = null;
      if (owned.shadow) {
        owned.shadow.texture.dispose();
        if (owned.shadow.lease) void releaseManagedRenderLeaseAfterDisposal(scene.getEngine(), owned.shadow.lease);
        owned.shadow = null;
      }
      owned.occluders.clear();
      owned.records.clear();
      owned.listeners.clear();
      scenes.delete(scene);
    });
  }
  return state;
}

/** The block, created with its first reader and rewritten before each frame from then on. */
function lightBuffer(scene: Scene, state: SceneLights2D): UniformBuffer {
  if (state.buffer) return state.buffer;
  // Not dynamic, as the 3D light block: on WebGPU a write moves the block to another buffer, so draws keep their values.
  const buffer = new UniformBuffer(scene.getEngine(), undefined, false, "Haptic2DLights");
  buffer.addUniform("haptic2DHeader", 4);
  buffer.addUniform("haptic2DLights", 4, LIGHT_2D_MAXIMUM * RECORD_VEC4S);
  buffer.create();
  state.buffer = buffer;
  state.beforeRender = scene.onBeforeRenderObservable.add(() => write2DLights(scene));
  write2DLights(scene);
  return buffer;
}

/** Whether the Scene's Shading Mode 2D surfaces draw lit by 2D lights. */
export function scene2DLighting(scene: Scene): boolean {
  return scenes.get(scene)?.lit ?? false;
}

/**
 * Sets whether the Scene's Shading Mode 2D surfaces draw lit: a Scene holding or able to spawn a 2D Light does, from its
 * load; one without draws them unlit and pays nothing. A change rebinds those surfaces (`onScene2DLightingChanged`), a
 * new program; editor edits only, as Play decides it once at load. Returns whether it changed.
 */
export function setScene2DLighting(scene: Scene, lit: boolean): boolean {
  const state = sceneLights2D(scene);
  if (state.lit === lit) return false;
  state.lit = lit;
  for (const listener of [...state.listeners]) listener();
  return true;
}

/** Calls `listener` whenever the Scene's 2D lighting turns on or off; returns its removal. */
export function onScene2DLightingChanged(scene: Scene, listener: () => void): () => void {
  const state = sceneLights2D(scene);
  state.listeners.add(listener);
  return () => state.listeners.delete(listener);
}

/** Adds a 2D light to the Scene's block; the caller mutates the record in place and calls the removal to retire it. */
export function add2DLight(scene: Scene, record: Light2DRecord): () => void {
  const state = sceneLights2D(scene);
  state.records.add(record);
  return () => {
    state.records.delete(record);
    state.limited.delete(record);
  };
}

/** Whether `record` was past the block's Point light maximum at the last write. */
export function is2DLightLimited(scene: Scene, record: Light2DRecord): boolean {
  return scenes.get(scene)?.limited.has(record) ?? false;
}

/** Bind the block for a draw with `effect`, which reads it. */
export function bind2DLights(scene: Scene, effect: Effect): void {
  const state = sceneLights2D(scene);
  // Bound directly, as the 3D light block is: never through bindToEffect.
  const buffer = lightBuffer(scene, state).getBuffer();
  if (buffer) effect.bindUniformBuffer(buffer, "Haptic2DLights");
}

/**
 * What `pack2DLights` packed: the Point lights it holds, the ambient, the enabled Point lights past its maximum, and the
 * shadowed lights by shadow map row.
 */
export type Packed2DLights = { count: number; ambient: [number, number, number]; limited: Light2DRecord[]; shadowed: Light2DRecord[] };

/**
 * Packs `records` into `words` (the block's light records, `LIGHT_2D_MAXIMUM` × 3 vec4s): the Global lights summed into
 * the ambient, then up to `LIGHT_2D_MAXIMUM` enabled Point lights, nearest to the camera's XY first (by distance less
 * radius; in record order without a camera), at positions relative to the floating `origin`. The first
 * `SHADOWED_2D_MAXIMUM` of them that cast shadows take shadow map rows in that order (with `shadows`; none without). With lights disabled (the
 * Unlit viewport) it packs a white ambient and no lights, so lit surfaces draw as unlit ones. A disabled light, one of
 * zero intensity or one with an error draws nothing.
 */
export function pack2DLights(
  records: Iterable<Light2DRecord>,
  options: { lightsEnabled: boolean; camera: { x: number; y: number } | null; origin: { x: number; y: number }; shadows?: boolean },
  words: Float32Array,
): Packed2DLights {
  const ambient: [number, number, number] = [0, 0, 0];
  const limited: Light2DRecord[] = [];
  const shadowed: Light2DRecord[] = [];
  words.fill(0);
  if (!options.lightsEnabled) return { count: 0, ambient: [1, 1, 1], limited, shadowed };
  const camera = options.camera;
  candidates.length = 0;
  for (const record of records) {
    const properties = record.properties;
    if (!properties.enabled || properties.intensity <= 0 || record.error) continue;
    if (properties.lightKind === "global") {
      for (let channel = 0; channel < 3; channel++) ambient[channel]! += properties.color[channel]! * properties.intensity;
      continue;
    }
    const score = camera ? Math.hypot(record.x - camera.x, record.y - camera.y) - properties.radius : 0;
    candidates.push({ record, score });
  }
  // Stable: equal scores keep record order.
  candidates.sort((a, b) => a.score - b.score);
  const count = Math.min(LIGHT_2D_MAXIMUM, candidates.length);
  for (let index = 0; index < candidates.length; index++) {
    const record = candidates[index]!.record;
    if (index >= count) { limited.push(record); continue; }
    const properties = record.properties;
    const cone = properties.outerAngle < 360 || properties.innerAngle < 360;
    const row = options.shadows && properties.castShadows && shadowed.length < SHADOWED_2D_MAXIMUM ? shadowed.push(record) - 1 : -1;
    words.set([
      record.x - options.origin.x, record.y - options.origin.y, properties.radius, properties.innerRadius,
      properties.color[0] * properties.intensity, properties.color[1] * properties.intensity, properties.color[2] * properties.intensity, cone ? 1 : 0,
      record.directionX, record.directionY, Math.cos(properties.outerAngle * Math.PI / 360), Math.cos(properties.innerAngle * Math.PI / 360),
      row < 0 ? 0 : (row + 0.5) / SHADOWED_2D_MAXIMUM, row < 0 ? 0 : 1, 0, 0,
    ], index * RECORD_VEC4S * 4);
  }
  candidates.length = 0;
  return { count, ambient, limited, shadowed };
}

/** Writes the block from the Scene's 2D lights (`pack2DLights`), seen from its active camera. */
export function write2DLights(scene: Scene): void {
  const state = scenes.get(scene);
  const buffer = state?.buffer;
  if (!state || !buffer) return;
  const camera = scene.activeCamera?.globalPosition ?? null;
  const origin = scene.floatingOriginOffset;
  const packed = pack2DLights(state.records, { lightsEnabled: scene.lightsEnabled, camera, origin, shadows: state.occluders.size > 0 }, lightWords);
  drawShadows(scene, state, packed.shadowed);
  state.limited.clear();
  for (const record of packed.limited) state.limited.add(record);
  buffer.updateFloat4("haptic2DHeader", packed.count, packed.ambient[0], packed.ambient[1], packed.ambient[2]);
  buffer.updateFloatArray("haptic2DLights", lightWords);
  buffer.update();
}

/** Adds a body's shadow casters; the caller updates the record's pose (`setOccluderPose`) and calls the removal to retire it. */
export function add2DOccluder(scene: Scene, record: Occluder2DRecord): () => void {
  const state = sceneLights2D(scene);
  state.occluders.add(record);
  pushBounds(state, record);
  record.dirty = true;
  return () => {
    if (!state.occluders.delete(record)) return;
    pushBounds(state, record);
  };
}

/** Poses a body's casters; a changed pose redraws the shadows it reaches at the next write. */
export function setOccluderPose(record: Occluder2DRecord, x: number, y: number, angle: number): void {
  if (record.x === x && record.y === y && record.angle === angle) return;
  record.x = x; record.y = y; record.angle = angle;
  record.dirty = true;
}

/** Replaces a body's outlines (its collider set changed). */
export function setOccluderShapes(record: Occluder2DRecord, shapes: Occluder2DRecord["shapes"]): void {
  record.shapes = shapes;
  record.dirty = true;
}

function pushBounds(state: SceneLights2D, record: Occluder2DRecord): void {
  for (const occluder of record.world) state.changedBounds.push(occluder.minX, occluder.minY, occluder.maxX, occluder.maxY);
}

/** Builds a dirty record's world outlines and records the bounds it left and entered. */
function refreshOccluder(state: SceneLights2D, record: Occluder2DRecord): void {
  if (!record.dirty) return;
  record.dirty = false;
  pushBounds(state, record);
  const cos = Math.cos(record.angle), sin = Math.sin(record.angle);
  record.world = record.shapes.map((shape) => {
    const points = new Float64Array(shape.points.length);
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (let index = 0; index < points.length; index += 2) {
      const px = shape.points[index]!, py = shape.points[index + 1]!;
      const x = record.x + px * cos - py * sin, y = record.y + px * sin + py * cos;
      points[index] = x; points[index + 1] = y;
      minX = Math.min(minX, x); minY = Math.min(minY, y); maxX = Math.max(maxX, x); maxY = Math.max(maxY, y);
    }
    return { closed: shape.closed, points, minX, minY, maxX, maxY };
  });
  pushBounds(state, record);
}

/** The Scene's 2D shadow map, created with its first reader: R16F, `SHADOW_2D_BINS` wide, a row per shadowed light. */
function shadowMap(scene: Scene, state: SceneLights2D): ShadowMap {
  if (state.shadow) return state.shadow;
  const engine = scene.getEngine();
  const data = new Uint16Array(SHADOW_2D_BINS * SHADOWED_2D_MAXIMUM).fill(ToHalfFloat(1));
  const bytes = data.byteLength;
  // 8 KiB the 2D-lit programs always bind: made even when the ledger has no room, unrecorded then, since WebGPU draws
  // only with every declared texture bound.
  const lease = beginManagedRenderAllocation(engine, bytes) ?? null;
  const texture = RawTexture.CreateRTexture(data, SHADOW_2D_BINS, SHADOWED_2D_MAXIMUM, scene, false, false,
    Constants.TEXTURE_BILINEAR_SAMPLINGMODE, Constants.TEXTURETYPE_HALF_FLOAT);
  texture.name = "haptic:2DShadows";
  // Directions wrap around the ring; rows never blend.
  texture.wrapU = Constants.TEXTURE_WRAP_ADDRESSMODE;
  texture.wrapV = Constants.TEXTURE_CLAMP_ADDRESSMODE;
  if (lease) lease.commit([{ handle: texture.getInternalTexture()!, bytes, category: "shadow" }]);
  const map: ShadowMap = { texture, lease, data, rows: new Array(SHADOWED_2D_MAXIMUM).fill(null) };
  state.shadow = map;
  return map;
}

/**
 * Redraws the rows whose light changed, moved or was reached by a caster that moved, and uploads the map when any did.
 * A row left without a light is cleared to unshadowed.
 */
function drawShadows(scene: Scene, state: SceneLights2D, shadowed: readonly Light2DRecord[]): void {
  if (!state.shadow && !shadowed.length) { state.changedBounds.length = 0; return; }
  const map = shadowMap(scene, state);
  if (shadowed.length) for (const record of state.occluders) refreshOccluder(state, record);
  const changed = state.changedBounds;
  const reached = (x: number, y: number, radius: number) => {
    for (let index = 0; index < changed.length; index += 4)
      if (changed[index + 2]! >= x - radius && changed[index]! <= x + radius && changed[index + 3]! >= y - radius && changed[index + 1]! <= y + radius) return true;
    return false;
  };
  let casters: WorldOccluder2D[] | null = null;
  let upload = false;
  for (let row = 0; row < SHADOWED_2D_MAXIMUM; row++) {
    const record = shadowed[row];
    const drawn = map.rows[row];
    if (!record) {
      if (drawn) { map.data.fill(ToHalfFloat(1), row * SHADOW_2D_BINS, (row + 1) * SHADOW_2D_BINS); map.rows[row] = null; upload = true; }
      continue;
    }
    const radius = record.properties.radius;
    if (drawn?.record === record && drawn.x === record.x && drawn.y === record.y && drawn.radius === radius && !reached(record.x, record.y, radius)) continue;
    casters ??= [...state.occluders].flatMap((occluder) => occluder.world);
    polarShadow2D(record.x, record.y, radius, casters, ring);
    for (let bin = 0; bin < SHADOW_2D_BINS; bin++) map.data[row * SHADOW_2D_BINS + bin] = ToHalfFloat(ring[bin]!);
    map.rows[row] = { record, x: record.x, y: record.y, radius };
    upload = true;
  }
  changed.length = 0;
  if (upload) map.texture.update(map.data);
}

/** Bind the 2D shadow map for a draw with `effect`; always bound, as WebGPU draws only with every declared texture. */
export function bind2DShadows(scene: Scene, effect: Effect): void {
  effect.setTexture(HAPTIC_2D_SHADOW_SAMPLER, shadowMap(scene, sceneLights2D(scene)).texture as BaseTexture);
}
