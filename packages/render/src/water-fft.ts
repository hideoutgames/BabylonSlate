/**
 * FFT ocean detail band: a render-only, GPU-simulated spectrum above the analytic swell (`WaterWaveSet.cutoffK`).
 * Physics, queries and buoyancy never read it.
 *
 * Simulation (fragment shaders through EffectWrapper/EffectRenderer, so WebGL2 and WebGPU run the same passes; no
 * compute shaders):
 * - h0: the seeded unit spectrum (`waterFftInitialSpectrum`), uploaded as an RGBA32F raw texture (`cascades · N` × N).
 * - Per dispatch: one time-evolution pass (scaling h0 by `layout.amplitude`) into an RGBA32F work atlas
 *   (`2 · cascades · N` × N), log2 N horizontal and log2 N − 1 vertical Stockham butterfly passes ping-ponging between
 *   two work atlases (every cascade in one draw), then the last vertical pass once per output layer. 2·log2 N +
 *   2·cascades draws in total (14 at 64²×1, 18 at 128²×2, 22 at 256²×3), all `texelFetch`/`textureLoad` with no
 *   filtering. ∂Dx/∂z shares its complex transform with Dz and is up to 100× larger, so it travels divided by
 *   `layout.shearScales[c]` and the final pass multiplies it back: rounding in one half never swamps the other.
 *
 * Output (`WaterFftResult.texture`): ONE 2D-array texture, N × N × (2 · cascades), RGBA16F (RGBA32F only where
 * half-float targets are not renderable), bilinear, REPEAT, no mips. Values are metres and slopes at Detail Waves 1,
 * Wave Scale 1 and horizontal scale λ = 1:
 * - layer 2c     = (Dx, H, Dz, ∂Dx/∂z) of cascade c: Gerstner offset, height, and the shear term;
 * - layer 2c + 1 = (∂H/∂x, ∂H/∂z, ∂Dx/∂x, ∂Dz/∂z): slope and the Jacobian diagonal minus one (∂Dz/∂x = ∂Dx/∂z).
 * - Texel (i, j) of cascade c holds the field at world (X, Z) = (i, j) · L_c / N (mod L_c, `patchSizes[c]`): sample at
 *   uv = (X, Z) / L_c + 0.5 / N with layer 2c or 2c + 1. Under a floating origin, add `fract(origin / L_c)` from the CPU
 *   in float64 instead of passing absolute positions.
 * Consumer contract (the water shader slice):
 * - Multiply every channel by g = `amplitudeGain` (Detail Waves) · Wave Scale. H and ∂H/∂x, ∂H/∂z are then final.
 * - Scale the horizontal terms (Dx, Dz and the three ∂D terms) by λ = Steepness · bank gain (`waterBankGain` with the
 *   body's `waterBankFadeLength`, the analytic offset's fade), never the raw λ = 1: Steepness 0 bodies and banks get no
 *   horizontal detail, as with the analytic swell. The detail Jacobian is J = I + λ·g·[[∂Dx/∂x, ∂Dx/∂z],
 *   [∂Dx/∂z, ∂Dz/∂z]]; add its terms to the analytic Jacobian and keep the combined determinant at or above
 *   `WATER_JACOBIAN_FLOOR` (lower λ locally), which the rest-point inversion and Jacobian foam assume.
 * - Bounds: |H| and |D| / λ of the band stay within 4σ = `detailHeight` · Detail Waves · Wave Scale (statistically;
 *   `waterWaveEnvelope` already includes it vertically). `waterHorizontalEnvelope` and the bank fade, which physics
 *   shares, do not: a consumer that displaces geometry horizontally pads its culling bounds by λ · that 4σ itself.
 * - Call `waterFftForSurface` every frame the material samples the band (its demand keeps the simulation running).
 *
 * Lifecycle: one simulation per Scene and spectrum, created only while device-effective FFT Ocean Detail is on,
 * visible built-in water with Detail Waves > 0 requests it (`requestWaterFft`, from the water before-render observer)
 * and a material sampled it (`waterFftForSurface`) since the last two observer runs. `updateSceneWaterFft` dispatches it
 * at most once per engine frame and only when the water clock moved, so captures and paused frames never re-run it.
 * A new unit spectrum is drawn in budgeted steps (`WATER_FFT_BUILD_TEXELS` per run, never a whole build in one frame)
 * and kept in a per-engine cache, so released, recycled or re-created simulations upload it without redrawing. Memory
 * is leased under the managed "water" category; effects retire through `retireOwnedEffect`. Readiness never blocks:
 * `ready` stays false (render analytic waves only) until the first dispatch completes.
 */
import {
  BaseTexture,
  Constants,
  EffectRenderer,
  EffectWrapper,
  ShaderStore,
  ThinTexture,
  type AbstractEngine,
  type AbstractMesh,
  type InternalTexture,
  type Observer,
  type RenderTargetWrapper,
  type Scene,
} from "@babylonjs/core";
import { waterWaveSet, type WaterDefinition, type WaterWaveSet } from "@babylonslate/core";
import { inActiveView } from "./active-view";
import { createEngineDrawingState, restoreEngineDrawingState, saveEngineDrawingState } from "./engine-drawing-state";
import {
  beginManagedRenderAllocation,
  releaseManagedRenderLeaseAfterDisposal,
  type ManagedRenderLease,
} from "./managed-render-resources";
import { retireOwnedEffect } from "./owned-effect-retirement";
import { sceneWaterQualityDeviceClamp } from "./render-settings";
import { renderTargetAllocationBytes } from "./render-target-resource-cost";
import {
  WATER_FFT_BUILD_TEXELS, waterFftCycle, waterFftLayout, waterFftSpectrumBuild, waterFftStages, type WaterFftLayout,
  type WaterFftSpectrumBuild,
} from "./water-fft-spectrum";

/** One FFT detail band as a water material samples it. Stable per definition and simulation: never rebuilt per frame. */
export interface WaterFftResult {
  /** 2D array, `2 · cascades` layers (see the module header for packing, sampling and the consumer contract). */
  readonly texture: BaseTexture;
  readonly cascades: number;
  /** World metres of each cascade's periodic patch. */
  readonly patchSizes: number[];
  /** The asset's Detail Waves: multiply every channel by it and by the body's Wave Scale (λ scales D on top). */
  readonly amplitudeGain: number;
  /** False until the first dispatch completed (and again after a context restore or a respectrum); render analytic only. */
  readonly ready: boolean;
}

/** Observer runs a simulation may go unrequested before its memory is released (about two seconds at 60 fps). */
export const WATER_FFT_IDLE_RUNS = 120;
/**
 * Observer runs a simulation must go unrequested before another spectrum takes over its storage while a new one could
 * still be allocated: bodies viewed in turn keep their own simulations instead of trading one back and forth.
 */
export const WATER_FFT_RECYCLE_RUNS = 60;
/**
 * Simulations per Scene. Further spectra take over the longest-idle simulation, or stay analytic while every
 * simulation is in view, so repeated wave edits never pile up storage.
 */
export const WATER_FFT_MAX_SIMULATIONS = 3;
/**
 * Extra observer runs a material's `waterFftForSurface` call keeps its band requested: a material samples after each
 * run, so one frame without a bind (a skipped draw) never stops the simulation.
 */
const DEMAND_RUNS = 1;
/** Observer runs to wait before trying again after the managed ledger refused an allocation. */
const RETRY_RUNS = 120;
/** Completed unit spectra kept per engine (CPU memory; 3 MiB each at 256²×3, 0.5 MiB at 128²×2). */
const SPECTRUM_CACHE_BYTES = 12 * 1024 ** 2;

const VERTEX = "slateWaterFft", EVOLVE = "slateWaterFftEvolve", BUTTERFLY = "slateWaterFftButterfly";
for (const wgsl of [false, true]) {
  const store = ShaderStore.GetShadersStore(wgsl ? 1 : 0);
  store[`${VERTEX}VertexShader`] = wgsl
    ? "attribute position: vec2f;\n@vertex\nfn main(input: VertexInputs) -> FragmentInputs {\nvertexOutputs.position = vec4f(vertexInputs.position, 0.0, 1.0);\n}"
    : "attribute vec2 position;\nvoid main(void) {\ngl_Position = vec4(position, 0.0, 1.0);\n}";
}
// Time evolution: h̃ = A·(h0(k)·e^{−iθ} + conj(h0(−k))·e^{iθ}), θ = 2π·fract(m·cycle); writes the packed field
// spectra (`waterFftEvolve`). fftParams = (N, cycle, A, 0). The mirrored texel of index x is (N − x) mod N.
// m reaches about 4200 at 256²×3, where a float32 m·cycle loses ~1e-3 rad and each packed pair's phase error leaks
// its large partner (∂Dx/∂z into Dz). With m = 64·mHigh + mLow, fract(m·c) = fract(mHigh·fract(64c) + mLow·c): 64c and
// its fract are exact, and both products stay below 130, so the phase is good to about 1e-4 rad.
ShaderStore.ShadersStore[`${EVOLVE}PixelShader`] = `precision highp float;
precision highp int;
precision highp sampler2D;
uniform sampler2D h0Texture;
uniform vec4 fftParams;
uniform vec4 fftPatch;
uniform vec4 fftShear;
vec2 slatePack(vec2 a, vec2 b) { return vec2(a.x - b.y, a.y + b.x); }
void main(void) {
int size = int(fftParams.x);
ivec2 p = ivec2(gl_FragCoord.xy);
int segment = p.x / size;
int cascade = segment / 2;
int x = p.x - segment * size;
int y = p.y;
int mirrorX = x == 0 ? 0 : size - x;
int mirrorY = y == 0 ? 0 : size - y;
vec4 a = texelFetch(h0Texture, ivec2(cascade * size + x, y), 0);
vec4 b = texelFetch(h0Texture, ivec2(cascade * size + mirrorX, mirrorY), 0);
float mHigh = floor(a.z / 64.0);
float theta = 6.283185307179586 * fract(mHigh * fract(64.0 * fftParams.y) + (a.z - 64.0 * mHigh) * fftParams.y);
float c = cos(theta);
float s = sin(theta);
float bIm = -b.y;
vec2 h = fftParams.z * vec2(a.x * c + a.y * s + b.x * c - bIm * s, a.y * c - a.x * s + b.x * s + bIm * c);
float scale = cascade == 0 ? fftPatch.x : (cascade == 1 ? fftPatch.y : fftPatch.z);
float shear = cascade == 0 ? fftShear.x : (cascade == 1 ? fftShear.y : fftShear.z);
vec2 k = vec2(float(x < size / 2 ? x : x - size), float(y < size / 2 ? y : y - size)) * scale;
vec2 u = k / max(length(k), 1e-30);
vec2 ih = vec2(-h.y, h.x);
vec4 result;
if (segment - cascade * 2 == 0) {
result = vec4(slatePack(ih * u.x, h), slatePack(ih * u.y, -h * (k.x * u.y * shear)));
} else {
result = vec4(slatePack(ih * k.x, ih * k.y), slatePack(-h * (k.x * u.x), -h * (k.y * u.y)));
}
gl_FragColor = result;
}`;
ShaderStore.ShadersStoreWGSL[`${EVOLVE}PixelShader`] = `var h0Texture: texture_2d<f32>;
uniform fftParams: vec4f;
uniform fftPatch: vec4f;
uniform fftShear: vec4f;
fn slatePack(a: vec2f, b: vec2f) -> vec2f { return vec2f(a.x - b.y, a.y + b.x); }
@fragment
fn main(input: FragmentInputs) -> FragmentOutputs {
let size = i32(uniforms.fftParams.x);
let p = vec2i(fragmentInputs.position.xy);
let segment = p.x / size;
let cascade = segment / 2;
let x = p.x - segment * size;
let y = p.y;
let mirrorX = select(size - x, 0, x == 0);
let mirrorY = select(size - y, 0, y == 0);
let a = textureLoad(h0Texture, vec2i(cascade * size + x, y), 0);
let b = textureLoad(h0Texture, vec2i(cascade * size + mirrorX, mirrorY), 0);
let mHigh = floor(a.z / 64.0);
let theta = 6.283185307179586 * fract(mHigh * fract(64.0 * uniforms.fftParams.y) + (a.z - 64.0 * mHigh) * uniforms.fftParams.y);
let c = cos(theta);
let s = sin(theta);
let bIm = -b.y;
let h = uniforms.fftParams.z * vec2f(a.x * c + a.y * s + b.x * c - bIm * s, a.y * c - a.x * s + b.x * s + bIm * c);
let scale = select(select(uniforms.fftPatch.z, uniforms.fftPatch.y, cascade == 1), uniforms.fftPatch.x, cascade == 0);
let shear = select(select(uniforms.fftShear.z, uniforms.fftShear.y, cascade == 1), uniforms.fftShear.x, cascade == 0);
let k = vec2f(f32(select(x - size, x, x < size / 2)), f32(select(y - size, y, y < size / 2))) * scale;
let u = k / max(length(k), 1e-30);
let ih = vec2f(-h.y, h.x);
var result: vec4f;
if (segment - cascade * 2 == 0) {
result = vec4f(slatePack(ih * u.x, h), slatePack(ih * u.y, -h * (k.x * u.y * shear)));
} else {
result = vec4f(slatePack(ih * k.x, ih * k.y), slatePack(-h * (k.x * u.x), -h * (k.y * u.y)));
}
fragmentOutputs.color = result;
}`;
// One radix-2 Stockham stage (`waterFftButterfly`): fftStage = (2^stage, horizontal, x offset, N); the result is
// multiplied by fftScale (1 except the final pass of a cascade's first layer, which restores ∂Dx/∂z).
ShaderStore.ShadersStore[`${BUTTERFLY}PixelShader`] = `precision highp float;
precision highp int;
precision highp sampler2D;
uniform sampler2D fftInput;
uniform vec4 fftStage;
uniform vec4 fftScale;
void main(void) {
ivec2 p = ivec2(gl_FragCoord.xy);
int span = int(fftStage.x);
int size = int(fftStage.w);
int x = p.x + int(fftStage.z);
int y = p.y;
bool horizontal = fftStage.y > 0.5;
int i = horizontal ? x - (x / size) * size : y;
int block = i / (2 * span);
int pos = i - block * 2 * span;
int k = pos >= span ? pos - span : pos;
int j = block * span + k;
ivec2 ia = horizontal ? ivec2(x - i + j, y) : ivec2(x, j);
ivec2 ib = horizontal ? ivec2(x - i + j + size / 2, y) : ivec2(x, j + size / 2);
vec4 a = texelFetch(fftInput, ia, 0);
vec4 b = texelFetch(fftInput, ib, 0);
float angle = 3.141592653589793 * float(k) / float(span);
float c = cos(angle);
float s = sin(angle);
float direction = pos >= span ? -1.0 : 1.0;
gl_FragColor = fftScale * (a + direction * vec4(c * b.x - s * b.y, c * b.y + s * b.x, c * b.z - s * b.w, c * b.w + s * b.z));
}`;
ShaderStore.ShadersStoreWGSL[`${BUTTERFLY}PixelShader`] = `var fftInput: texture_2d<f32>;
uniform fftStage: vec4f;
uniform fftScale: vec4f;
@fragment
fn main(input: FragmentInputs) -> FragmentOutputs {
let p = vec2i(fragmentInputs.position.xy);
let span = i32(uniforms.fftStage.x);
let size = i32(uniforms.fftStage.w);
let x = p.x + i32(uniforms.fftStage.z);
let y = p.y;
let horizontal = uniforms.fftStage.y > 0.5;
let i = select(y, x - (x / size) * size, horizontal);
let block = i / (2 * span);
let pos = i - block * 2 * span;
let k = select(pos, pos - span, pos >= span);
let j = block * span + k;
let ia = select(vec2i(x, j), vec2i(x - i + j, y), horizontal);
let ib = select(vec2i(x, j + size / 2), vec2i(x - i + j + size / 2, y), horizontal);
let a = textureLoad(fftInput, ia, 0);
let b = textureLoad(fftInput, ib, 0);
let angle = 3.141592653589793 * f32(k) / f32(span);
let c = cos(angle);
let s = sin(angle);
let direction = select(1.0, -1.0, pos >= span);
fragmentOutputs.color = uniforms.fftScale * (a + direction * vec4f(c * b.x - s * b.y, c * b.y + s * b.x, c * b.z - s * b.w, c * b.w + s * b.z));
}`;

/** Shared, reused save slot: dispatches never nest and run synchronously. */
const drawingState = createEngineDrawingState();

const RGBA = Constants.TEXTUREFORMAT_RGBA;

/** Completed unit spectra by `spectrumKey`, least recently used first; immutable once stored. */
const spectrumCaches = new WeakMap<AbstractEngine, Map<string, Float32Array>>();

function cachedSpectrum(engine: AbstractEngine, key: string): Float32Array | undefined {
  return spectrumCaches.get(engine)?.get(key);
}

/** Stores (or marks as most recently used) a completed spectrum, evicting the least recently used past the budget. */
function keepSpectrum(engine: AbstractEngine, key: string, data: Float32Array): void {
  let cache = spectrumCaches.get(engine);
  if (!cache) spectrumCaches.set(engine, cache = new Map());
  cache.delete(key);
  cache.set(key, data);
  let bytes = 0;
  for (const value of cache.values()) bytes += value.byteLength;
  for (const [oldest, value] of cache) {
    if (bytes <= SPECTRUM_CACHE_BYTES || oldest === key) break;
    cache.delete(oldest);
    bytes -= value.byteLength;
  }
}

class WaterFftSimulation {
  readonly texture: BaseTexture;
  /** Run of the last request; `updateSceneWaterFft` dispatches only simulations requested in its run. */
  requestedRun = -1;
  time = Number.NaN;
  frame = -1;
  ready = false;
  disposed = false;
  dispatches = 0;
  private readonly h0Texture: ThinTexture;
  private readonly workTextures: [ThinTexture, ThinTexture];
  private readonly renderer: EffectRenderer;
  private readonly evolve: EffectWrapper;
  private readonly butterfly: EffectWrapper;
  private readonly restored: Observer<AbstractEngine>;
  readonly engine: AbstractEngine;
  layout: WaterFftLayout;
  private readonly h0: InternalTexture;
  private readonly work: [RenderTargetWrapper, RenderTargetWrapper];
  private readonly output: RenderTargetWrapper;
  private readonly lease: ManagedRenderLease;

  private constructor(
    engine: AbstractEngine, layout: WaterFftLayout, h0: InternalTexture,
    work: [RenderTargetWrapper, RenderTargetWrapper], output: RenderTargetWrapper, lease: ManagedRenderLease,
  ) {
    this.engine = engine; this.layout = layout; this.h0 = h0;
    this.work = work; this.output = output; this.lease = lease;
    const outputTexture = output.texture!;
    // The wrapper holds its own reference, so the material's texture and the render target release independently.
    outputTexture.incrementReferences();
    this.texture = new BaseTexture(engine, outputTexture);
    this.texture.name = "Water FFT Detail";
    this.texture.wrapU = this.texture.wrapV = Constants.TEXTURE_WRAP_ADDRESSMODE;
    this.h0Texture = new ThinTexture(h0);
    this.workTextures = [new ThinTexture(work[0].texture), new ThinTexture(work[1].texture)];
    this.renderer = new EffectRenderer(engine);
    const language = engine.isWebGPU ? 1 : 0;
    this.evolve = new EffectWrapper({
      engine, name: EVOLVE, vertexShader: VERTEX, fragmentShader: EVOLVE, useShaderStore: true, shaderLanguage: language,
      uniformNames: ["fftParams", "fftPatch", "fftShear"], samplerNames: ["h0Texture"],
    });
    this.butterfly = new EffectWrapper({
      engine, name: BUTTERFLY, vertexShader: VERTEX, fragmentShader: BUTTERFLY, useShaderStore: true, shaderLanguage: language,
      uniformNames: ["fftStage", "fftScale"], samplerNames: ["fftInput"],
    });
    // Restored contexts rebuild every target empty (h0 re-uploads from its retained data): dispatch again first.
    this.restored = engine.onContextRestoredObservable.add(() => { this.ready = false; this.time = Number.NaN; });
  }

  get key(): string { return this.layout.key; }
  get size(): number { return this.layout.size; }
  get cascades(): number { return this.layout.cascades; }

  /**
   * Reserves the whole footprint in the managed ledger, then allocates and uploads the completed unit spectrum; null
   * when the ledger refuses or allocation fails. No CPU spectrum work.
   */
  static create(engine: AbstractEngine, layout: WaterFftLayout, spectrum: Float32Array): WaterFftSimulation | null {
    const { size, cascades } = layout, caps = engine.getCaps();
    // Half-float output where renderable; float output keeps the band where only float targets render.
    const outputType = caps.textureHalfFloatRender ? Constants.TEXTURETYPE_HALF_FLOAT : Constants.TEXTURETYPE_FLOAT;
    const outputSampling = caps.textureHalfFloatRender || caps.textureFloatLinearFiltering
      ? Constants.TEXTURE_BILINEAR_SAMPLINGMODE : Constants.TEXTURE_NEAREST_SAMPLINGMODE;
    const h0Bytes = renderTargetAllocationBytes({ width: cascades * size, height: size, format: RGBA, type: Constants.TEXTURETYPE_FLOAT });
    const workBytes = renderTargetAllocationBytes({ width: 2 * cascades * size, height: size, format: RGBA, type: Constants.TEXTURETYPE_FLOAT });
    const outputBytes = renderTargetAllocationBytes({ width: size, height: size, layers: 2 * cascades, format: RGBA, type: outputType });
    const lease = beginManagedRenderAllocation(engine, h0Bytes + 2 * workBytes + outputBytes);
    if (!lease) return null;
    const owned: { dispose(): void }[] = [];
    try {
      const h0 = engine.createRawTexture(spectrum, cascades * size, size, RGBA, false, false, Constants.TEXTURE_NEAREST_SAMPLINGMODE, null, Constants.TEXTURETYPE_FLOAT);
      owned.push(h0);
      const work = (label: string) => {
        const target = engine.createRenderTargetTexture({ width: 2 * cascades * size, height: size }, {
          type: Constants.TEXTURETYPE_FLOAT, format: RGBA, samplingMode: Constants.TEXTURE_NEAREST_SAMPLINGMODE,
          generateMipMaps: false, generateDepthBuffer: false, generateStencilBuffer: false, label,
        });
        owned.push(target);
        return target;
      };
      const targets: [RenderTargetWrapper, RenderTargetWrapper] = [work("Water FFT work A"), work("Water FFT work B")];
      const output = engine.createRenderTargetTexture({ width: size, height: size, layers: 2 * cascades }, {
        type: outputType, format: RGBA, samplingMode: outputSampling,
        generateMipMaps: false, generateDepthBuffer: false, generateStencilBuffer: false, label: "Water FFT detail",
      });
      owned.push(output);
      lease.commit([
        { handle: h0, bytes: h0Bytes, category: "water" },
        { handle: targets[0].texture!, bytes: workBytes, category: "water" },
        { handle: targets[1].texture!, bytes: workBytes, category: "water" },
        { handle: output.texture!, bytes: outputBytes, category: "water" },
      ]);
      return new WaterFftSimulation(engine, layout, h0, targets, output, lease);
    } catch {
      // A device that cannot allocate keeps analytic-only water, like a ledger refusal.
      for (const resource of owned) resource.dispose();
      void releaseManagedRenderLeaseAfterDisposal(engine, lease);
      return null;
    }
  }

  /** Same unit spectrum, other Wave Height, Wave Length or Wave Speed: new uniforms only (no upload, no CPU work). */
  retarget(layout: WaterFftLayout): void {
    this.layout = layout;
    this.ready = false; this.time = Number.NaN;
  }

  /** Reuses this simulation's storage for another completed unit spectrum of the same size: one h0 upload. */
  respectrum(layout: WaterFftLayout, spectrum: Float32Array): void {
    this.engine.updateRawTexture(this.h0, spectrum, RGBA, false, null, Constants.TEXTURETYPE_FLOAT, false);
    this.retarget(layout);
  }

  /** Runs every pass for `time`; false (and nothing drawn) while either effect still compiles. */
  dispatch(time: number, frame: number): boolean {
    if (!this.evolve.isReady() || !this.butterfly.isReady()) return false;
    const engine = this.engine, renderer = this.renderer, { size, cascades, patchSizes, shearScales, amplitude, timeScale } = this.layout;
    const stages = waterFftStages(size);
    saveEngineDrawingState(engine, drawingState);
    try {
      engine.setAlphaMode(Constants.ALPHA_DISABLE);
      engine.setColorWrite(true);
      engine.bindFramebuffer(this.work[0], 0, undefined, undefined, true);
      renderer.applyEffectWrapper(this.evolve);
      const evolve = this.evolve.effect;
      evolve.setTexture("h0Texture", this.h0Texture);
      evolve.setFloat4("fftParams", size, waterFftCycle(time, timeScale), amplitude, 0);
      evolve.setFloat4("fftPatch", 2 * Math.PI / patchSizes[0]!, 2 * Math.PI / (patchSizes[1] ?? 1), 2 * Math.PI / (patchSizes[2] ?? 1), 0);
      evolve.setFloat4("fftShear", 1 / shearScales[0]!, 1 / (shearScales[1] ?? 1), 1 / (shearScales[2] ?? 1), 0);
      renderer.draw();
      engine.unBindFramebuffer(this.work[0], true);
      let source = 0;
      for (let stage = 0; stage < stages; stage++, source ^= 1) this.stage(source, this.work[source ^ 1]!, 0, stage, true, 0, 1);
      for (let stage = 0; stage < stages - 1; stage++, source ^= 1) this.stage(source, this.work[source ^ 1]!, 0, stage, false, 0, 1);
      for (let layer = 0; layer < 2 * cascades; layer++) {
        this.stage(source, this.output, layer, stages - 1, false, layer * size, layer & 1 ? 1 : shearScales[layer >> 1]!);
      }
    } finally {
      restoreEngineDrawingState(engine, drawingState);
    }
    this.time = time; this.frame = frame; this.ready = true; this.dispatches++;
    return true;
  }

  private stage(
    source: number, target: RenderTargetWrapper, layer: number, stage: number, horizontal: boolean, xOffset: number, shear: number,
  ): void {
    const engine = this.engine;
    engine.bindFramebuffer(target, 0, undefined, undefined, true, 0, layer);
    this.renderer.applyEffectWrapper(this.butterfly);
    const effect = this.butterfly.effect;
    effect.setTexture("fftInput", this.workTextures[source]!);
    effect.setFloat4("fftStage", 1 << stage, horizontal ? 1 : 0, xOffset, this.layout.size);
    effect.setFloat4("fftScale", 1, 1, 1, shear);
    this.renderer.draw();
    engine.unBindFramebuffer(target, true);
  }

  /** Releases GPU storage, then the ledger lease (after WebGPU drains its deferred destruction). */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true; this.ready = false;
    const engine = this.engine;
    engine.onContextRestoredObservable.remove(this.restored);
    this.texture.dispose();
    this.output.dispose();
    this.work[0].dispose(); this.work[1].dispose();
    this.h0.dispose();
    this.renderer.dispose();
    const evolve = this.evolve, butterfly = this.butterfly;
    retireOwnedEffect(evolve.effect, () => evolve.dispose());
    retireOwnedEffect(butterfly.effect, () => butterfly.dispose());
    void releaseManagedRenderLeaseAfterDisposal(engine, this.lease);
  }
}

type DefinitionEntry = {
  set: WaterWaveSet | null;
  size: number;
  cascades: number;
  /** Layout of `set` at the Water quality's size and cascades; built once per change, never per frame. */
  layout: WaterFftLayout | null;
  sim: WaterFftSimulation | null;
  view: WaterFftResult | null;
  /** Run in which this entry last queued for a simulation. */
  pendingRun: number;
  /** `SceneFft.run` at the last `waterFftForSurface` call: a material samples this band. */
  demandRun: number;
  gain: number;
};

type SceneFft = {
  /** Observer run counter: requests mark the current run, `updateSceneWaterFft` processes it and advances. */
  run: number;
  sims: WaterFftSimulation[];
  byKey: Map<string, WaterFftSimulation>;
  definitions: WeakMap<WaterDefinition, DefinitionEntry>;
  /** Entries without a simulation this run; resolved after every request is in, so recycling never steals a live one. */
  pending: DefinitionEntry[];
  deniedUntil: number;
  /** The unit spectrum being drawn, and the last run a pending entry wanted it. */
  build: WaterFftSpectrumBuild | null;
  buildWanted: number;
  /** First entry this run whose spectrum is neither cached nor being drawn. */
  nextBuild: DefinitionEntry | null;
  created: number;
  retargeted: number;
  respectrummed: number;
  retired: number;
  denied: number;
  built: number;
};

const scenes = new WeakMap<Scene, SceneFft>();

function sceneFft(scene: Scene): SceneFft {
  let state = scenes.get(scene);
  if (!state) {
    const owned: SceneFft = state = {
      run: 0, sims: [], byKey: new Map(), definitions: new WeakMap(), pending: [], deniedUntil: 0,
      build: null, buildWanted: -1, nextBuild: null,
      created: 0, retargeted: 0, respectrummed: 0, retired: 0, denied: 0, built: 0,
    };
    scenes.set(scene, owned);
    scene.onDisposeObservable.addOnce(() => {
      retireAll(owned);
      owned.build = null;
      scenes.delete(scene);
    });
  }
  return state;
}

function retire(state: SceneFft, index: number): void {
  const sim = state.sims[index]!;
  state.sims.splice(index, 1);
  if (state.byKey.get(sim.key) === sim) state.byKey.delete(sim.key);
  sim.dispose();
  state.retired++;
}

function retireAll(state: SceneFft): void {
  for (let i = state.sims.length - 1; i >= 0; i--) retire(state, i);
}

function bind(entry: DefinitionEntry, sim: WaterFftSimulation | null): void {
  entry.sim = sim;
  const key = entry.layout?.key;
  entry.view = sim && {
    texture: sim.texture, cascades: sim.cascades, patchSizes: entry.layout!.patchSizes, amplitudeGain: entry.gain,
    get ready() { return sim.ready && !sim.disposed && sim.key === key && entry.layout?.key === key; },
  };
}

/**
 * Called by the water before-render observer for each enabled built-in (WaterMaterialPlugin) surface. Notes that
 * `definition` needs its detail band this run when device-effective FFT Ocean Detail is on, Detail Waves > 0, a
 * material sampled the band (`waterFftForSurface`) since the last two runs, and the surface is visible
 * (`active`, when the caller already knows; otherwise visible and inside an active camera's frustum). Allocation-free
 * once the definition and its waves have been seen; never creates GPU resources itself.
 */
export function requestWaterFft(scene: Scene, mesh: AbstractMesh, definition: WaterDefinition, active?: boolean): void {
  if (!(definition.detailWaves > 0)) return;
  const state = scenes.get(scene), entry = state?.definitions.get(definition);
  if (!state || !entry || state.run - entry.demandRun > DEMAND_RUNS) return;
  const quality = sceneWaterQualityDeviceClamp(scene).quality;
  if (!quality.fft) return;
  if (!(active ?? (mesh.isVisible && mesh.visibility > 0 && inActiveView(scene, mesh)))) return;
  const set = waterWaveSet(definition);
  if (entry.set !== set || entry.size !== quality.fftSize || entry.cascades !== quality.fftCascades) {
    entry.set = set; entry.size = quality.fftSize; entry.cascades = quality.fftCascades; entry.gain = definition.detailWaves;
    entry.layout = waterFftLayout(set, entry.size, entry.cascades);
    bind(entry, state.byKey.get(entry.layout.key) ?? null);
  } else if (entry.sim && (entry.sim.disposed || entry.sim.key !== entry.layout!.key)) {
    bind(entry, state.byKey.get(entry.layout!.key) ?? null);
  }
  if (entry.sim) entry.sim.requestedRun = state.run;
  else if (entry.pendingRun !== state.run) {
    entry.pendingRun = state.run;
    state.pending.push(entry);
  }
}

/** The longest-idle simulation of `layout`'s size unrequested for at least `idleRuns` runs, or null. */
function idleSimulation(state: SceneFft, layout: WaterFftLayout, run: number, idleRuns: number, spectrumKey?: string): WaterFftSimulation | null {
  let idle: WaterFftSimulation | null = null;
  for (const sim of state.sims) {
    if (run - sim.requestedRun < idleRuns || sim.size !== layout.size || sim.cascades !== layout.cascades) continue;
    if (spectrumKey !== undefined && sim.layout.spectrumKey !== spectrumKey) continue;
    if (!idle || sim.requestedRun < idle.requestedRun) idle = sim;
  }
  return idle;
}

/** Moves `sim` to `layout`'s key in the shared-simulation index. */
function rekey(state: SceneFft, sim: WaterFftSimulation, layout: WaterFftLayout): void {
  if (state.byKey.get(sim.key) === sim) state.byKey.delete(sim.key);
  state.byKey.set(layout.key, sim);
}

/**
 * Gives a requesting definition a simulation, cheapest first: an existing one of the same key; an idle one with the
 * same unit spectrum (new uniforms only); otherwise, once the unit spectrum is cached (else it is queued for drawing),
 * a simulation idle for `WATER_FFT_RECYCLE_RUNS`, a new lease (below `WATER_FFT_MAX_SIMULATIONS` and not refused), or
 * finally the longest-idle simulation (one h0 upload each). Allocation-free while it cannot be served.
 */
function resolve(scene: Scene, state: SceneFft, entry: DefinitionEntry, run: number): void {
  const layout = entry.layout!;
  const existing = state.byKey.get(layout.key);
  if (existing) {
    bind(entry, existing);
    existing.requestedRun = run;
    return;
  }
  let sim = idleSimulation(state, layout, run, 1, layout.spectrumKey);
  if (sim) {
    rekey(state, sim, layout);
    sim.retarget(layout);
    state.retargeted++;
  } else {
    const engine = scene.getEngine(), spectrum = cachedSpectrum(engine, layout.spectrumKey);
    if (!spectrum) {
      if (state.build?.key === layout.spectrumKey) state.buildWanted = run;
      else state.nextBuild ??= entry;
      return;
    }
    let reuse = idleSimulation(state, layout, run, WATER_FFT_RECYCLE_RUNS);
    if (!reuse && state.sims.length < WATER_FFT_MAX_SIMULATIONS && run >= state.deniedUntil) {
      sim = WaterFftSimulation.create(engine, layout, spectrum);
      if (sim) {
        state.sims.push(sim);
        state.byKey.set(layout.key, sim);
        state.created++;
      } else {
        state.deniedUntil = run + RETRY_RUNS;
        state.denied++;
      }
    }
    if (!sim) {
      // Long idle, or (at the cap or refused) the longest-idle simulation of this size: one h0 upload.
      reuse ??= idleSimulation(state, layout, run, 1);
      if (!reuse) return;
      rekey(state, reuse, layout);
      reuse.respectrum(layout, spectrum);
      state.respectrummed++;
      sim = reuse;
    }
    keepSpectrum(engine, layout.spectrumKey, spectrum);
  }
  bind(entry, sim);
  sim.requestedRun = run;
}

/**
 * Advances the unit spectrum a pending entry wanted this run by one budgeted step; when nothing wants the spectrum in
 * progress, starts the one wanted instead (its partial work is dropped) or leaves it suspended, without CPU work.
 */
function advanceBuild(scene: Scene, state: SceneFft, run: number): void {
  const next = state.nextBuild;
  state.nextBuild = null;
  if (state.buildWanted !== run) {
    if (next) {
      state.build = waterFftSpectrumBuild(next.set!, next.layout!);
      state.buildWanted = run;
    } else {
      if (state.build && run - state.buildWanted > WATER_FFT_IDLE_RUNS) state.build = null;
      return;
    }
  }
  const build = state.build!;
  if (!build.step(WATER_FFT_BUILD_TEXELS)) return;
  keepSpectrum(scene.getEngine(), build.key, build.data);
  state.build = null;
  state.built++;
}

/**
 * Called once per water before-render observer run, after every `requestWaterFft`: gives new requests a simulation,
 * advances a spectrum being drawn by one budgeted step, dispatches each simulation requested this run at most once
 * per engine frame and only when `time` (the water clock) changed, and releases simulations unrequested for
 * `WATER_FFT_IDLE_RUNS` runs, all of them when FFT Ocean Detail is off, and any whose size no longer matches the Water
 * quality. No sampled, visible water: no passes and no spectrum work at all.
 */
export function updateSceneWaterFft(scene: Scene, time: number): void {
  const state = scenes.get(scene);
  if (!state) return;
  const run = state.run++;
  const quality = sceneWaterQualityDeviceClamp(scene).quality;
  if (!quality.fft) {
    state.pending.length = 0;
    state.build = null;
    if (state.sims.length) retireAll(state);
    return;
  }
  // Release first, so a size change never holds both footprints.
  for (let i = state.sims.length - 1; i >= 0; i--) {
    const sim = state.sims[i]!;
    if (sim.size !== quality.fftSize || sim.cascades !== quality.fftCascades || run - sim.requestedRun > WATER_FFT_IDLE_RUNS) retire(state, i);
  }
  for (let i = 0; i < state.pending.length; i++) resolve(scene, state, state.pending[i]!, run);
  state.pending.length = 0;
  if (state.build || state.nextBuild) advanceBuild(scene, state, run);
  const frame = scene.getEngine().frameId;
  for (let i = 0; i < state.sims.length; i++) {
    const sim = state.sims[i]!;
    // A band with Wave Speed 0 never changes once drawn.
    const stale = !sim.ready || (sim.time !== time && sim.layout.timeScale !== 0);
    if (sim.requestedRun === run && sim.frame !== frame && stale) sim.dispatch(time, frame);
  }
}

/**
 * The detail band a water material should sample for `definition` in `scene`, or null: FFT Ocean Detail off or clamped
 * on this device, Detail Waves 0, no visible water has requested it yet, or the asset or quality changed since (the
 * next observer run rebinds). Calling it is the material's demand: a definition nobody asked for since the last two
 * observer runs gets no simulation and no passes, so call it every frame the band is sampled. Check `ready` before
 * sampling.
 * Allocation-free once the definition has been seen.
 */
export function waterFftForSurface(scene: Scene, definition: WaterDefinition): WaterFftResult | null {
  if (!(definition.detailWaves > 0)) return null;
  const quality = sceneWaterQualityDeviceClamp(scene).quality;
  if (!quality.fft) return null;
  const state = sceneFft(scene);
  let entry = state.definitions.get(definition);
  if (!entry) {
    entry = { set: null, size: 0, cascades: 0, layout: null, sim: null, view: null, pendingRun: -1, demandRun: -1, gain: definition.detailWaves };
    state.definitions.set(definition, entry);
  }
  entry.demandRun = state.run;
  const sim = entry.sim;
  if (!sim || sim.disposed || sim.key !== entry.layout?.key) return null;
  if (quality.fftSize !== sim.size || quality.fftCascades !== sim.cascades) return null;
  if (entry.set !== waterWaveSet(definition) || entry.gain !== definition.detailWaves) return null;
  return entry.view;
}

export interface WaterFftDiagnostics {
  simulations: { key: string; spectrumKey: string; size: number; cascades: number; patchSizes: number[]; time: number; ready: boolean; dispatches: number }[];
  /**
   * Simulations allocated; reused with new uniforms only (same unit spectrum); reused with another unit spectrum's
   * upload; released; refused by the ledger. Unit spectra drawn, and the one being drawn.
   */
  created: number;
  retargeted: number;
  respectrummed: number;
  retired: number;
  denied: number;
  built: number;
  building: string | null;
}

/** Test and proof readout of a scene's FFT simulations. Allocates; never call per frame. */
export function waterFftDiagnostics(scene: Scene): WaterFftDiagnostics {
  const state = scenes.get(scene);
  return {
    simulations: (state?.sims ?? []).map((sim) => ({
      key: sim.key, spectrumKey: sim.layout.spectrumKey, size: sim.size, cascades: sim.cascades, patchSizes: [...sim.layout.patchSizes],
      time: sim.time, ready: sim.ready, dispatches: sim.dispatches,
    })),
    created: state?.created ?? 0,
    retargeted: state?.retargeted ?? 0,
    respectrummed: state?.respectrummed ?? 0,
    retired: state?.retired ?? 0,
    denied: state?.denied ?? 0,
    built: state?.built ?? 0,
    building: state?.build?.key ?? null,
  };
}
