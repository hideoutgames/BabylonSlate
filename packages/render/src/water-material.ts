import { Vector3, type AbstractMesh } from "@babylonjs/core";
import type { WaterDefinition } from "@haptic/core";
import type { WaterRemovalCandidate } from "./water-scene-state";
import { WATER_REMOVAL_SLOTS } from "./water-shader-chunks";
export {
  WATER_GPU_WAVES_DEFINE,
  WATER_BLEND_DEFINE,
  WATER_NODE_BLEND_DEFINE,
  WATER_BLEND_ATTRIBUTE_CONDITION,
  WATER_FFT_DEFINE,
  WATER_FFT_SAMPLER,
  WATER_FOAM_SAMPLER,
  waterFoamDrift,
  waterFoamThresholdOf,
} from "./water-shader-defines";
export {
  aerialPerspectiveSource,
  edgeFoamHelpers,
  horizonHazeSource,
  horizonLiftSource,
  marchSource,
  transmittanceSource,
  WATER_FAR_ROUGHNESS,
  WATER_GLOSS_FALLOFF,
  fresnelSource,
  planarLookupSource,
  reflectionKeepSource,
  REMOVAL_HELPER,
  shorelineSource,
  silhouetteFallbackSource,
  slopeVarianceSource,
  waterEdgeSource,
  WATER_REMOVAL_SLOTS,
} from "./water-shader-chunks";
export {
  waterAbsorption,
  placeholderField,
  sceneWaterBindingData,
  sceneWaterBodyLight,
  sceneWaterNodeLighting,
  type WaterRemovalCandidate,
} from "./water-scene-state";
export {
  WATER_VERTEX_WAVE_UNIFORMS,
  WATER_CLOCK_UNIFORM,
  waterWaveBlockSource,
  WATER_EYE_UNIFORM,
  WATER_NODE_FOAM_UNIFORM,
  WATER_NODE_SUN_UNIFORM,
  WATER_NODE_VARYING,
  waterWaveNodeSources,
  toWgsl,
  waterBlendCullSource,
  stripShaderComments,
} from "./water-shader-source";
export {
  setWaterGridOffsetSource,
  waterGridOffset,
  WaterVertexWaves,
  setMeshVertexWaves,
  meshVertexWaves,
} from "./water-vertex-waves";

/** Object contact distances are encoded up to three contact-foam widths (1-8 m). */
export const contactRange = (water: WaterDefinition) => Math.max(1, Math.min(8, water.contactFoamWidth * 3));

/** Each removal slot's (shape code, half extents) and inverse world matrix (`REMOVAL_HELPER`); the Water Cut block's too. */
export const WATER_REMOVAL_SHAPE_UNIFORMS = Array.from({ length: WATER_REMOVAL_SLOTS }, (_, i) => `slateWaterRemovalShape${i}`);
export const WATER_REMOVAL_UNIFORMS = Array.from({ length: WATER_REMOVAL_SLOTS }, (_, i) => `slateWaterRemoval${i}`);

/**
 * The nearest `WATER_REMOVAL_SLOTS` of the render's enabled removal volumes (`WaterBindingData.removals`) that reach
 * `mesh`'s bounds, nearest first, into `selected`; `gaps` is scratch of `WATER_REMOVAL_SLOTS + 1`. By insertion into
 * the slots: no per-render arrays. The Water Cut block cuts these volumes.
 */
export function selectWaterRemovals(removals: readonly WaterRemovalCandidate[], mesh: AbstractMesh | null | undefined, selected: WaterRemovalCandidate[], gaps: Float64Array): void {
  selected.length = 0;
  if (removals.length === 0) return;
  const center = mesh?.getBoundingInfo().boundingSphere;
  for (const entry of removals) {
    const gap = center ? Vector3.Distance(center.centerWorld, entry.position) - entry.radius - center.radiusWorld : 0;
    if (gap > 0) continue;
    let at = selected.length;
    while (at > 0 && gaps[at - 1]! > gap) at--;
    if (at >= WATER_REMOVAL_SLOTS) continue;
    for (let j = Math.min(selected.length, WATER_REMOVAL_SLOTS - 1); j > at; j--) { selected[j] = selected[j - 1]!; gaps[j] = gaps[j - 1]!; }
    selected[at] = entry; gaps[at] = gap;
    if (selected.length > WATER_REMOVAL_SLOTS) selected.length = WATER_REMOVAL_SLOTS;
  }
}
