import { UniformBuffer } from "@babylonjs/core/Materials/uniformBuffer";
import type { Effect } from "@babylonjs/core/Materials/effect";
import type { Observer } from "@babylonjs/core/Misc/observable";
import type { Scene } from "@babylonjs/core/scene";
import type { Light2DProperties } from "@haptic/core";

/**
 * 2D lighting plan: Sprites and Tilemaps with Shading Mode 2D in a Scene that holds 2D Lights (`setScene2DLighting`)
 * draw the unlit Material's 2D-lit variant (`UnlitMaterialKey.lighting`), whose colour multiplies the light at the
 * pixel's XY: the Global lights' sum plus each Point light's radial falloff and cone. Every 2D light is data in one
 * per-Scene uniform block, rewritten each frame, so no 2D light change compiles a shader. 2D lights are not Babylon
 * lights: 3D surfaces never see them and they take no part in the 3D light block, its budget or shadows.
 */

/** Point lights the block holds; the nearest to the camera win. Global lights have no limit. */
export const LIGHT_2D_MAXIMUM = 16;
const RECORD_VEC4S = 3;

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
 * inner angles. Records: (x, y, radius, inner radius), (r, g, b, has cone), (direction x, y, cos outer/2, cos inner/2).
 */
export const HAPTIC_2D_LIGHT_FUNCTION_GLSL = `vec3 haptic2DLight(vec2 position) {
vec3 total = haptic2DHeader.yzw;
int count = int(haptic2DHeader.x);
for (int i = 0; i < ${LIGHT_2D_MAXIMUM}; i++) {
if (i >= count) { break; }
vec4 place = haptic2DLights[i * 3];
vec2 offset = position - place.xy;
float distance2D = length(offset);
if (distance2D >= place.z) { continue; }
float t = clamp((distance2D - place.w) / max(place.z - place.w, 0.0001), 0.0, 1.0);
float falloff = (1.0 - t) * (1.0 - t);
vec4 tint = haptic2DLights[i * 3 + 1];
if (tint.w > 0.5) {
vec4 cone = haptic2DLights[i * 3 + 2];
float along = distance2D > 0.0001 ? dot(offset / distance2D, cone.xy) : 1.0;
falloff *= smoothstep(0.0, 1.0, clamp((along - cone.z) / max(cone.w - cone.z, 0.0001), 0.0, 1.0));
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
let place = Haptic2DLights.haptic2DLights[i * 3];
let offset = position - place.xy;
let distance2D = length(offset);
if (distance2D >= place.z) { continue; }
let t = clamp((distance2D - place.w) / max(place.z - place.w, 0.0001), 0.0, 1.0);
var falloff = (1.0 - t) * (1.0 - t);
let tint = Haptic2DLights.haptic2DLights[i * 3 + 1];
if (tint.w > 0.5) {
let cone = Haptic2DLights.haptic2DLights[i * 3 + 2];
var along = 1.0;
if (distance2D > 0.0001) { along = dot(offset / distance2D, cone.xy); }
falloff = falloff * smoothstep(0.0, 1.0, clamp((along - cone.z) / max(cone.w - cone.z, 0.0001), 0.0, 1.0));
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
};

const scenes = new WeakMap<Scene, SceneLights2D>();
const lightWords = new Float32Array(LIGHT_2D_MAXIMUM * RECORD_VEC4S * 4);
const candidates: { record: Light2DRecord; score: number }[] = [];

function sceneLights2D(scene: Scene): SceneLights2D {
  let state = scenes.get(scene);
  if (!state) {
    state = { lit: false, records: new Set(), limited: new Set(), buffer: null, beforeRender: null, listeners: new Set() };
    scenes.set(scene, state);
    const owned = state;
    scene.onDisposeObservable.addOnce(() => {
      if (owned.beforeRender) scene.onBeforeRenderObservable.remove(owned.beforeRender);
      owned.buffer?.dispose();
      owned.buffer = null;
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
 * Writes the block from the Scene's 2D lights: the Global lights summed into the ambient, then up to `LIGHT_2D_MAXIMUM`
 * enabled Point lights, nearest to the active camera's XY first (by distance less radius). A Scene with its lights
 * disabled (the Unlit viewport) writes a white ambient and no lights, so lit surfaces draw as unlit ones.
 */
export function write2DLights(scene: Scene): void {
  const state = scenes.get(scene);
  const buffer = state?.buffer;
  if (!state || !buffer) return;
  state.limited.clear();
  let ambientR = 0, ambientG = 0, ambientB = 0;
  candidates.length = 0;
  if (!scene.lightsEnabled) {
    ambientR = ambientG = ambientB = 1;
  } else {
    const camera = scene.activeCamera?.globalPosition;
    for (const record of state.records) {
      const properties = record.properties;
      if (!properties.enabled || properties.intensity <= 0 || record.error) continue;
      const [r, g, b] = properties.color;
      if (properties.lightKind === "global") {
        ambientR += r * properties.intensity;
        ambientG += g * properties.intensity;
        ambientB += b * properties.intensity;
        continue;
      }
      const score = camera ? Math.hypot(record.x - camera.x, record.y - camera.y) - properties.radius : 0;
      candidates.push({ record, score });
    }
  }
  candidates.sort((a, b) => a.score - b.score);
  const offset = scene.floatingOriginOffset;
  const count = Math.min(LIGHT_2D_MAXIMUM, candidates.length);
  lightWords.fill(0);
  for (let index = 0; index < candidates.length; index++) {
    const record = candidates[index]!.record;
    if (index >= count) { state.limited.add(record); continue; }
    const properties = record.properties;
    const cone = properties.outerAngle < 360 || properties.innerAngle < 360;
    const halfOuter = properties.outerAngle * Math.PI / 360;
    const halfInner = properties.innerAngle * Math.PI / 360;
    lightWords.set([
      record.x - offset.x, record.y - offset.y, properties.radius, properties.innerRadius,
      properties.color[0] * properties.intensity, properties.color[1] * properties.intensity, properties.color[2] * properties.intensity, cone ? 1 : 0,
      record.directionX, record.directionY, Math.cos(halfOuter), Math.cos(halfInner),
    ], index * RECORD_VEC4S * 4);
  }
  candidates.length = 0;
  buffer.updateFloat4("haptic2DHeader", count, ambientR, ambientG, ambientB);
  buffer.updateFloatArray("haptic2DLights", lightWords);
  buffer.update();
}
