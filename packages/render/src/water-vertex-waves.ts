/**
 * GPU wave displacement shared by the water material, other passes (outline mask) and Custom Material water: grid
 * offsets, the spectrum's vertex uniforms and `WaterVertexWaves` for surfaces without a `WaterMaterialPlugin`.
 */
import { BaseTexture, Vector3, type AbstractMesh, Scene } from "@babylonjs/core";
import { WATER_FFT_CASCADES_MAX, waterBankFadeLength, waterFoamScale, waterSpectrum, type WaterBodyProperties, type WaterDefinition } from "@haptic/core";
import { sceneWaterQualityDeviceClamp } from "./render-settings";
import { waterFftForSurface, type WaterFftResult } from "./water-fft";
import { WATER_FFT_CASCADE_TURNS } from "./water-fft-spectrum";
import { placeholderFft, sceneWaterNodeLighting } from "./water-scene-state";
import { SPECTRUM_LOD_SCALE } from "./water-shader-chunks";
import { FFT_UNIFORMS, WATER_FFT_SAMPLER, WATER_FOAM_SAMPLER, waterFoamThresholdOf } from "./water-shader-defines";
import { WATER_CLOCK_UNIFORM, WATER_EYE_UNIFORM, WATER_NODE_FOAM_UNIFORM, WATER_NODE_SUN_UNIFORM } from "./water-shader-source";

const gridOffsets = new WeakMap<AbstractMesh, Float64Array>();
const gridWorld = new Float64Array(3);

/**
 * Registers `offset` (local X, Z; read live) as the translation of `mesh`'s uploaded rest positions: Global Water
 * recentres by moving this instead of re-uploading its grid. It is per mesh, not per material, and `slateWaterGridOffset`
 * carries it to the vertex shaders of the material and of other passes (`bindVertexWaves`).
 */
export function setWaterGridOffsetSource(mesh: AbstractMesh, offset: Float64Array): void {
  gridOffsets.set(mesh, offset);
}

/**
 * The mesh's registered grid offset as a world-space vector (into a shared scratch): the linear part of its current
 * world matrix applied to (x, 0, z). Taking it at bind time keeps it right under any rotation, scale or tilt, and a
 * floating origin (which only changes the matrix's translation) never reaches it.
 */
export function waterGridOffset(mesh: AbstractMesh | null | undefined): Float64Array {
  const offset = mesh ? gridOffsets.get(mesh) : undefined;
  if (!offset || (offset[0] === 0 && offset[1] === 0)) return gridWorld.fill(0);
  const m = mesh!.getWorldMatrix().m, x = offset[0]!, z = offset[1]!;
  gridWorld[0] = x * m[0]! + z * m[8]!; gridWorld[1] = x * m[1]! + z * m[9]!; gridWorld[2] = x * m[2]! + z * m[10]!;
  return gridWorld;
}

/** Where a pass's vertex uniforms and the spectrum's texture go: an `Effect`, or whatever records what a pass receives. */
export interface WaterUniformSink {
  setFloat4(name: string, x: number, y: number, z: number, w: number): unknown;
  setTexture(name: string, texture: BaseTexture | null): unknown;
}

/** Floats of the spectrum's vertex uniforms (`slateWaterFft` and every cascade's vec4) written by `waterSpectrumUniforms`. */
export const SPECTRUM_UNIFORM_FLOATS = (1 + WATER_FFT_CASCADES_MAX) * 4;

/**
 * The spectrum `water` draws with in `scene` (`waterFftForSurface`, which is also its demand) and its uniforms for Wave
 * Scale `scale` into `out` (`FFT_UNIFORMS` order): (Wave Scale while the spectrum is ready and matches `cascades`, else
 * 0: flat until the first dispatch; λ; grid size; `SPECTRUM_LOD_SCALE`) and per cascade (1 / patch size, uv offset): the
 * offset is the floating origin in the cascade's turned frame, fract(R(−θ)·origin / L) + 0.5 / N in float64, so the
 * floating origin never reaches the shader as a large coordinate. Returns the spectrum only when it is ready and matches
 * `cascades`. Allocation-free.
 */
export function waterSpectrumUniforms(scene: Scene, water: WaterDefinition, scale: number, cascades: number, out: Float32Array): WaterFftResult | null {
  const result = waterFftForSurface(scene, water);
  const band = result?.ready && result.cascades === cascades ? result : null;
  const origin = scene.floatingOriginMode ? scene.floatingOriginOffset : Vector3.ZeroReadOnly;
  out.fill(0);
  out[0] = band ? scale : 0; out[1] = waterSpectrum(water).choppiness; out[2] = band?.size ?? 1; out[3] = SPECTRUM_LOD_SCALE;
  if (!band) return null;
  for (let c = 0; c < band.cascades && c < WATER_FFT_CASCADES_MAX; c++) {
    const o = (1 + c) * 4, patch = band.patchSizes[c]!, turn = WATER_FFT_CASCADE_TURNS[c]!, cos = Math.cos(turn), sin = Math.sin(turn);
    const px = (cos * origin.x + sin * origin.z) / patch, pz = (cos * origin.z - sin * origin.x) / patch, texel = 0.5 / band.size;
    out[o] = 1 / patch;
    out[o + 1] = px - Math.floor(px) + texel;
    out[o + 2] = pz - Math.floor(pz) + texel;
  }
  return band;
}

/**
 * Sets `WATER_VERTEX_WAVE_UNIFORMS` and the spectrum's texture: the grid offset (world X/Z translation of the uploaded
 * rest grid), the bank fade length and the spectrum's uniforms (`waterSpectrumUniforms`), with a placeholder texture
 * until the spectrum is ready. The material plugin binds them to another pass's effect (`WaterMaterialPlugin.bindVertexWaves`)
 * and a surface without a plugin binds them to its Custom Material (`WaterVertexWaves.bind`), so both displace
 * identically.
 */
export function bindWaterVertexUniforms(
  sink: WaterUniformSink, scene: Scene, grid: ArrayLike<number>, bankFade: number, spectrum: Float32Array, band: WaterFftResult | null,
): void {
  sink.setFloat4("slateWaterGridOffset", grid[0]!, grid[1]!, grid[2]!, 0);
  sink.setFloat4("slateWaterSwellInfo", bankFade, 0, 0, 0);
  for (let i = 0; i < 1 + WATER_FFT_CASCADES_MAX; i++) {
    sink.setFloat4(FFT_UNIFORMS[i]!, spectrum[i * 4]!, spectrum[i * 4 + 1]!, spectrum[i * 4 + 2]!, spectrum[i * 4 + 3]!);
  }
  sink.setTexture(WATER_FFT_SAMPLER, band?.texture ?? placeholderFft(scene));
}

/**
 * The waves of a water surface that has no `WaterMaterialPlugin`: Custom Material water whose graph holds a Water Waves
 * node (`WaterWavesBlock`). The node's vertex stage displaces the surface's static rest grid with the same source as
 * built-in shading (`waterWaveBlockSource`) from the same uniforms (`bindWaterVertexUniforms`), here from the surface's
 * own definition, body and clock; the water mesh keeps `time` current.
 */
export class WaterVertexWaves {
  /** The surface's water clock in seconds. */
  time = 0;
  readonly water: WaterDefinition;
  readonly body: WaterBodyProperties;
  private readonly spectrum = new Float32Array(SPECTRUM_UNIFORM_FLOATS);
  constructor(water: WaterDefinition, body: WaterBodyProperties) {
    this.water = water;
    this.body = body;
  }
  /** The spectrum's cascades this surface's material compiles (`SLATE_WATER_FFT`): the device-effective FFT Cascades. */
  cascades(scene: Scene): number {
    return Math.max(1, sceneWaterQualityDeviceClamp(scene).quality.fftCascades);
  }
  /**
   * Sets the vertex uniforms, the spectrum and its foam, the clock, the eye (the active camera relative to the rest
   * positions), the foam terms and the sun for a draw of `mesh`. Allocation-free.
   */
  bind(sink: WaterUniformSink, scene: Scene, mesh: AbstractMesh): void {
    const scale = this.body.waveScale;
    const band = waterSpectrumUniforms(scene, this.water, scale, this.cascades(scene), this.spectrum);
    bindWaterVertexUniforms(sink, scene, waterGridOffset(mesh), this.body.kind === "global" ? 0 : waterBankFadeLength(this.water, scale), this.spectrum, band);
    sink.setTexture(WATER_FOAM_SAMPLER, band?.foam ?? placeholderFft(scene));
    sink.setFloat4(WATER_CLOCK_UNIFORM, this.time, 0, 0, 0);
    const camera = scene.activeCamera, origin = scene.floatingOriginMode ? scene.floatingOriginOffset : Vector3.ZeroReadOnly;
    const eye = camera?.globalPosition ?? Vector3.ZeroReadOnly;
    sink.setFloat4(WATER_EYE_UNIFORM, eye.x - origin.x, eye.y - origin.y, eye.z - origin.z, 0);
    const quality = sceneWaterQualityDeviceClamp(scene).quality;
    sink.setFloat4(WATER_NODE_FOAM_UNIFORM, this.water.crestFoam, this.water.foamAmount,
      waterFoamThresholdOf(this.water, scale, quality.fftSize, this.cascades(scene)), 1 / waterFoamScale(scale));
    const sun = sceneWaterNodeLighting(scene).sun;
    sink.setFloat4(WATER_NODE_SUN_UNIFORM, sun[0]!, sun[1]!, sun[2]!, this.water.subsurface);
  }
}

const meshWaves = new WeakMap<AbstractMesh, WaterVertexWaves>();
/** Registers (or with null removes) the waves `mesh`'s Custom Material displaces it with; the water mesh owns them. */
export function setMeshVertexWaves(mesh: AbstractMesh, waves: WaterVertexWaves | null): void {
  if (waves) meshWaves.set(mesh, waves);
  else meshWaves.delete(mesh);
}
/** The waves a Custom Material displaces `mesh` with (`setMeshVertexWaves`), or null. */
export function meshVertexWaves(mesh: AbstractMesh | null | undefined): WaterVertexWaves | null {
  return (mesh && meshWaves.get(mesh)) || null;
}
