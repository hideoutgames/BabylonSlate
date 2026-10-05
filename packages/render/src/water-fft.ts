/**
 * FFT ocean detail band: a render-only, GPU-simulated spectrum above the analytic swell (`WaterWaveSet.cutoffK`).
 * Physics, queries and buoyancy never read it.
 *
 * Simulation (fragment shaders through EffectWrapper/EffectRenderer, so WebGL2 and WebGPU run the same passes; no
 * compute shaders):
 * - h0: the seeded initial spectrum (`waterFftInitialSpectrum`), uploaded once as an RGBA32F raw texture
 *   (`cascades · N` × N).
 * - Per dispatch: one time-evolution pass into an RGBA32F work atlas (`2 · cascades · N` × N), log2 N horizontal and
 *   log2 N − 1 vertical Stockham butterfly passes ping-ponging between two work atlases (every cascade in one draw),
 *   then the last vertical pass once per output layer. 2·log2 N + 2·cascades draws in total (14 at 64²×1, 18 at
 *   128²×2, 22 at 256²×3), all `texelFetch`/`textureLoad` with no filtering.
 *
 * Output (`WaterFftResult.texture`): ONE 2D-array texture, N × N × (2 · cascades), RGBA16F (RGBA32F only where
 * half-float targets are not renderable), bilinear, REPEAT, no mips. Values are metres and slopes at Detail Waves 1 and
 * Wave Scale 1 (multiply every channel by `amplitudeGain` · Wave Scale):
 * - layer 2c     = (Dx, H, Dz, ∂Dx/∂z) of cascade c: Gerstner offset (Tessendorf λ = 1), height, and the shear term;
 * - layer 2c + 1 = (∂H/∂x, ∂H/∂z, ∂Dx/∂x, ∂Dz/∂z): slope and the Jacobian diagonal minus one, so
 *   J = [[1 + ∂Dx/∂x, ∂Dx/∂z], [∂Dx/∂z, 1 + ∂Dz/∂z]] (∂Dz/∂x = ∂Dx/∂z) — add λ-scaled terms to the analytic Jacobian.
 * - Texel (i, j) of cascade c holds the field at world (X, Z) = (i, j) · L_c / N (mod L_c, `patchSizes[c]`): sample at
 *   uv = (X, Z) / L_c + 0.5 / N with layer 2c or 2c + 1. Under a floating origin, add `fract(origin / L_c)` from the CPU
 *   in float64 instead of passing absolute positions.
 *
 * Lifecycle: one simulation per Scene and spectrum (every definition with the same waves, Wave Seed and Water quality
 * shares it), created only while device-effective FFT Ocean Detail is on and visible built-in water with Detail Waves
 * > 0 requests it (`requestWaterFft`, from the water before-render observer), dispatched at most once per engine frame
 * and only when the water clock moved (`updateSceneWaterFft`), so captures and paused frames never re-run it. Memory is
 * leased under the managed "water" category; effects retire through `retireOwnedEffect`. Readiness never blocks:
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
  type Camera,
  type InternalTexture,
  type Observer,
  type RenderTargetWrapper,
  type Scene,
} from "@babylonjs/core";
import { waterWaveSet, type WaterDefinition, type WaterWaveSet } from "@babylonslate/core";
import { createEngineDrawingState, restoreEngineDrawingState, saveEngineDrawingState } from "./engine-drawing-state";
import {
  beginManagedRenderAllocation,
  releaseManagedRenderLeaseAfterDisposal,
  type ManagedRenderLease,
} from "./managed-render-resources";
import { retireOwnedEffect } from "./owned-effect-retirement";
import { sceneWaterQualityDeviceClamp } from "./render-settings";
import { renderTargetAllocationBytes } from "./render-target-resource-cost";
import { waterFftCycle, waterFftInitialSpectrum, waterFftLayout, waterFftStages, type WaterFftLayout } from "./water-fft-spectrum";

/** One FFT detail band as a water material samples it. Stable per definition and simulation: never rebuilt per frame. */
export interface WaterFftResult {
  /** 2D array, `2 · cascades` layers (see the module header for packing and sampling). */
  readonly texture: BaseTexture;
  readonly cascades: number;
  /** World metres of each cascade's periodic patch. */
  readonly patchSizes: number[];
  /** The asset's Detail Waves: multiply every channel by it (and by the body's Wave Scale). */
  readonly amplitudeGain: number;
  /** False until the first dispatch completed (and again after a context restore or a respectrum); render analytic only. */
  readonly ready: boolean;
}

/** Observer runs a simulation may go unrequested before its memory is released (about two seconds at 60 fps). */
export const WATER_FFT_IDLE_RUNS = 120;
/** Observer runs to wait before trying again after the managed ledger refused an allocation. */
const RETRY_RUNS = 120;

const VERTEX = "slateWaterFft", EVOLVE = "slateWaterFftEvolve", BUTTERFLY = "slateWaterFftButterfly";
for (const wgsl of [false, true]) {
  const store = ShaderStore.GetShadersStore(wgsl ? 1 : 0);
  store[`${VERTEX}VertexShader`] = wgsl
    ? "attribute position: vec2f;\n@vertex\nfn main(input: VertexInputs) -> FragmentInputs {\nvertexOutputs.position = vec4f(vertexInputs.position, 0.0, 1.0);\n}"
    : "attribute vec2 position;\nvoid main(void) {\ngl_Position = vec4(position, 0.0, 1.0);\n}";
}
// Time evolution: h̃ = h0(k)·e^{−iθ} + conj(h0(−k))·e^{iθ}, θ = 2π·fract(m·cycle); writes the packed field spectra
// (`waterFftEvolve`). The mirrored texel of index x is (N − x) mod N.
ShaderStore.ShadersStore[`${EVOLVE}PixelShader`] = `precision highp float;
precision highp int;
precision highp sampler2D;
uniform sampler2D h0Texture;
uniform vec4 fftParams;
uniform vec4 fftPatch;
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
float theta = 6.283185307179586 * fract(a.z * fftParams.y);
float c = cos(theta);
float s = sin(theta);
float bIm = -b.y;
vec2 h = vec2(a.x * c + a.y * s + b.x * c - bIm * s, a.y * c - a.x * s + b.x * s + bIm * c);
float scale = cascade == 0 ? fftPatch.x : (cascade == 1 ? fftPatch.y : fftPatch.z);
vec2 k = vec2(float(x < size / 2 ? x : x - size), float(y < size / 2 ? y : y - size)) * scale;
vec2 u = k / max(length(k), 1e-30);
vec2 ih = vec2(-h.y, h.x);
vec4 result;
if (segment - cascade * 2 == 0) {
result = vec4(slatePack(ih * u.x, h), slatePack(ih * u.y, -h * (k.x * u.y)));
} else {
result = vec4(slatePack(ih * k.x, ih * k.y), slatePack(-h * (k.x * u.x), -h * (k.y * u.y)));
}
gl_FragColor = result;
}`;
ShaderStore.ShadersStoreWGSL[`${EVOLVE}PixelShader`] = `var h0Texture: texture_2d<f32>;
uniform fftParams: vec4f;
uniform fftPatch: vec4f;
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
let theta = 6.283185307179586 * fract(a.z * uniforms.fftParams.y);
let c = cos(theta);
let s = sin(theta);
let bIm = -b.y;
let h = vec2f(a.x * c + a.y * s + b.x * c - bIm * s, a.y * c - a.x * s + b.x * s + bIm * c);
let scale = select(select(uniforms.fftPatch.z, uniforms.fftPatch.y, cascade == 1), uniforms.fftPatch.x, cascade == 0);
let k = vec2f(f32(select(x - size, x, x < size / 2)), f32(select(y - size, y, y < size / 2))) * scale;
let u = k / max(length(k), 1e-30);
let ih = vec2f(-h.y, h.x);
var result: vec4f;
if (segment - cascade * 2 == 0) {
result = vec4f(slatePack(ih * u.x, h), slatePack(ih * u.y, -h * (k.x * u.y)));
} else {
result = vec4f(slatePack(ih * k.x, ih * k.y), slatePack(-h * (k.x * u.x), -h * (k.y * u.y)));
}
fragmentOutputs.color = result;
}`;
// One radix-2 Stockham stage (`waterFftButterfly`): fftStage = (2^stage, horizontal, x offset, N).
ShaderStore.ShadersStore[`${BUTTERFLY}PixelShader`] = `precision highp float;
precision highp int;
precision highp sampler2D;
uniform sampler2D fftInput;
uniform vec4 fftStage;
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
gl_FragColor = a + direction * vec4(c * b.x - s * b.y, c * b.y + s * b.x, c * b.z - s * b.w, c * b.w + s * b.z);
}`;
ShaderStore.ShadersStoreWGSL[`${BUTTERFLY}PixelShader`] = `var fftInput: texture_2d<f32>;
uniform fftStage: vec4f;
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
fragmentOutputs.color = a + direction * vec4f(c * b.x - s * b.y, c * b.y + s * b.x, c * b.z - s * b.w, c * b.w + s * b.z);
}`;

/** Shared, reused save slot: dispatches never nest and run synchronously. */
const drawingState = createEngineDrawingState();

const RGBA = Constants.TEXTUREFORMAT_RGBA;

/** Same spectrum, size and cascades ⇒ same simulation. */
function simulationKey(set: WaterWaveSet, layout: WaterFftLayout): string {
  return [layout.size, layout.cascades, set.spectrumScale, set.peakK, set.spectrumSharpness, layout.heading, layout.spread, set.waveSeed, set.waveSpeed].join(":");
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

  private constructor(
    readonly engine: AbstractEngine,
    public key: string,
    public layout: WaterFftLayout,
    private readonly spectrum: Float32Array,
    private readonly h0: InternalTexture,
    private readonly work: [RenderTargetWrapper, RenderTargetWrapper],
    private readonly output: RenderTargetWrapper,
    private readonly lease: ManagedRenderLease,
  ) {
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
      uniformNames: ["fftParams", "fftPatch"], samplerNames: ["h0Texture"],
    });
    this.butterfly = new EffectWrapper({
      engine, name: BUTTERFLY, vertexShader: VERTEX, fragmentShader: BUTTERFLY, useShaderStore: true, shaderLanguage: language,
      uniformNames: ["fftStage"], samplerNames: ["fftInput"],
    });
    // Restored contexts rebuild every texture empty: dispatch again before reporting ready.
    this.restored = engine.onContextRestoredObservable.add(() => { this.ready = false; this.time = Number.NaN; });
  }

  get size(): number { return this.layout.size; }
  get cascades(): number { return this.layout.cascades; }

  /** Reserves the whole footprint in the managed ledger, then allocates; null when the ledger refuses or allocation fails. */
  static create(engine: AbstractEngine, set: WaterWaveSet, layout: WaterFftLayout, key: string): WaterFftSimulation | null {
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
      const spectrum = waterFftInitialSpectrum(set, layout);
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
      return new WaterFftSimulation(engine, key, layout, spectrum, h0, targets, output, lease);
    } catch {
      // A device that cannot allocate keeps analytic-only water, like a ledger refusal.
      for (const resource of owned) resource.dispose();
      void releaseManagedRenderLeaseAfterDisposal(engine, lease);
      return null;
    }
  }

  /** Reuses this simulation's storage for another spectrum of the same size: a new h0 upload, no new GPU resources. */
  respectrum(set: WaterWaveSet, layout: WaterFftLayout, key: string): void {
    this.key = key; this.layout = layout;
    waterFftInitialSpectrum(set, layout, this.spectrum);
    this.engine.updateRawTexture(this.h0, this.spectrum, RGBA, false, null, Constants.TEXTURETYPE_FLOAT, false);
    this.ready = false; this.time = Number.NaN;
  }

  /** Runs every pass for `time`; false (and nothing drawn) while either effect still compiles. */
  dispatch(time: number, frame: number): boolean {
    if (!this.evolve.isReady() || !this.butterfly.isReady()) return false;
    const engine = this.engine, renderer = this.renderer, { size, cascades, patchSizes } = this.layout;
    const stages = waterFftStages(size);
    saveEngineDrawingState(engine, drawingState);
    try {
      engine.setAlphaMode(Constants.ALPHA_DISABLE);
      engine.setColorWrite(true);
      engine.bindFramebuffer(this.work[0], 0, undefined, undefined, true);
      renderer.applyEffectWrapper(this.evolve);
      const evolve = this.evolve.effect;
      evolve.setTexture("h0Texture", this.h0Texture);
      evolve.setFloat4("fftParams", size, waterFftCycle(time), 0, 0);
      evolve.setFloat4("fftPatch", 2 * Math.PI / patchSizes[0]!, 2 * Math.PI / (patchSizes[1] ?? 1), 2 * Math.PI / (patchSizes[2] ?? 1), 0);
      renderer.draw();
      engine.unBindFramebuffer(this.work[0], true);
      let source = 0;
      for (let stage = 0; stage < stages; stage++, source ^= 1) this.stage(source, this.work[source ^ 1]!, 0, stage, true, 0);
      for (let stage = 0; stage < stages - 1; stage++, source ^= 1) this.stage(source, this.work[source ^ 1]!, 0, stage, false, 0);
      for (let layer = 0; layer < 2 * cascades; layer++) this.stage(source, this.output, layer, stages - 1, false, layer * size);
    } finally {
      restoreEngineDrawingState(engine, drawingState);
    }
    this.time = time; this.frame = frame; this.ready = true; this.dispatches++;
    return true;
  }

  private stage(source: number, target: RenderTargetWrapper, layer: number, stage: number, horizontal: boolean, xOffset: number): void {
    const engine = this.engine;
    engine.bindFramebuffer(target, 0, undefined, undefined, true, 0, layer);
    this.renderer.applyEffectWrapper(this.butterfly);
    const effect = this.butterfly.effect;
    effect.setTexture("fftInput", this.workTextures[source]!);
    effect.setFloat4("fftStage", 1 << stage, horizontal ? 1 : 0, xOffset, this.layout.size);
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
  key: string;
  sim: WaterFftSimulation | null;
  view: WaterFftResult | null;
  /** Run in which this entry last queued for a simulation. */
  pendingRun: number;
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
  created: number;
  respectrummed: number;
  retired: number;
  denied: number;
};

const scenes = new WeakMap<Scene, SceneFft>();

function sceneFft(scene: Scene): SceneFft {
  let state = scenes.get(scene);
  if (!state) {
    const owned: SceneFft = state = {
      run: 0, sims: [], byKey: new Map(), definitions: new WeakMap(), pending: [], deniedUntil: 0,
      created: 0, respectrummed: 0, retired: 0, denied: 0,
    };
    scenes.set(scene, owned);
    scene.onDisposeObservable.addOnce(() => {
      retireAll(owned);
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
  entry.view = sim && {
    texture: sim.texture, cascades: sim.cascades, patchSizes: sim.layout.patchSizes, amplitudeGain: entry.gain,
    get ready() { return sim.ready && !sim.disposed && sim.key === entry.key; },
  };
}

function sees(camera: Camera, mesh: AbstractMesh): boolean {
  // Scene.render refreshes camera matrices only after before-render observers: use this frame's.
  camera.getViewMatrix(); camera.getProjectionMatrix();
  return camera.isInFrustum(mesh);
}

/** True when an active camera of the scene sees the mesh's (wave-padded) bounds; a scene without a camera sees it. */
function inActiveView(scene: Scene, mesh: AbstractMesh): boolean {
  const cameras = scene.activeCameras;
  if (cameras && cameras.length > 0) {
    for (let i = 0; i < cameras.length; i++) if (sees(cameras[i]!, mesh)) return true;
    return false;
  }
  const camera = scene.activeCamera;
  return !camera || sees(camera, mesh);
}

/**
 * Called by the water before-render observer for each enabled built-in (WaterMaterialPlugin) surface. Notes that
 * `definition` needs its detail band this run when device-effective FFT Ocean Detail is on, Detail Waves > 0 and the
 * surface is visible (`active`, when the caller already knows; otherwise visible and inside an active camera's
 * frustum). Allocation-free once the definition has been seen; never creates GPU resources itself.
 */
export function requestWaterFft(scene: Scene, mesh: AbstractMesh, definition: WaterDefinition, active?: boolean): void {
  if (!(definition.detailWaves > 0)) return;
  const quality = sceneWaterQualityDeviceClamp(scene).quality;
  if (!quality.fft) return;
  if (!(active ?? (mesh.isVisible && mesh.visibility > 0 && inActiveView(scene, mesh)))) return;
  const state = sceneFft(scene);
  let entry = state.definitions.get(definition);
  if (!entry) {
    entry = { set: null, size: 0, cascades: 0, key: "", sim: null, view: null, pendingRun: -1, gain: definition.detailWaves };
    state.definitions.set(definition, entry);
  }
  const set = waterWaveSet(definition);
  if (entry.set !== set || entry.size !== quality.fftSize || entry.cascades !== quality.fftCascades) {
    entry.set = set; entry.size = quality.fftSize; entry.cascades = quality.fftCascades; entry.gain = definition.detailWaves;
    entry.key = simulationKey(set, waterFftLayout(set, entry.size, entry.cascades));
    bind(entry, state.byKey.get(entry.key) ?? null);
  } else if (entry.sim && (entry.sim.disposed || entry.sim.key !== entry.key)) {
    bind(entry, state.byKey.get(entry.key) ?? null);
  }
  if (entry.sim) entry.sim.requestedRun = state.run;
  else if (entry.pendingRun !== state.run) {
    entry.pendingRun = state.run;
    state.pending.push(entry);
  }
}

/** Gives a requesting definition a simulation: an existing one, an idle one of the same size (new h0 only), or a new lease. */
function resolve(scene: Scene, state: SceneFft, entry: DefinitionEntry, run: number): void {
  const existing = state.byKey.get(entry.key);
  if (existing) {
    bind(entry, existing);
    existing.requestedRun = run;
    return;
  }
  const set = entry.set!, layout = waterFftLayout(set, entry.size, entry.cascades);
  let idle: WaterFftSimulation | null = null;
  for (const sim of state.sims) {
    if (sim.requestedRun < run && sim.size === entry.size && sim.cascades === entry.cascades && (!idle || sim.requestedRun < idle.requestedRun)) idle = sim;
  }
  if (idle) {
    state.byKey.delete(idle.key);
    idle.respectrum(set, layout, entry.key);
    state.byKey.set(entry.key, idle);
    state.respectrummed++;
  } else {
    if (run < state.deniedUntil) return;
    idle = WaterFftSimulation.create(scene.getEngine(), set, layout, entry.key);
    if (!idle) {
      state.deniedUntil = run + RETRY_RUNS;
      state.denied++;
      return;
    }
    state.sims.push(idle);
    state.byKey.set(entry.key, idle);
    state.created++;
  }
  bind(entry, idle);
  idle.requestedRun = run;
}

/**
 * Called once per water before-render observer run, after every `requestWaterFft`: gives new requests a simulation,
 * dispatches each simulation requested this run at most once per engine frame and only when `time` (the water clock)
 * changed, and releases simulations unrequested for `WATER_FFT_IDLE_RUNS` runs, all of them when FFT Ocean Detail is
 * off, and any whose size no longer matches the Water quality. No visible requesting water: no passes at all.
 */
export function updateSceneWaterFft(scene: Scene, time: number): void {
  const state = scenes.get(scene);
  if (!state) return;
  const run = state.run++;
  const quality = sceneWaterQualityDeviceClamp(scene).quality;
  if (!quality.fft) {
    state.pending.length = 0;
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
  const frame = scene.getEngine().frameId;
  for (let i = 0; i < state.sims.length; i++) {
    const sim = state.sims[i]!;
    if (sim.requestedRun === run && sim.frame !== frame && (!sim.ready || sim.time !== time)) sim.dispatch(time, frame);
  }
}

/**
 * The detail band a water material should sample for `definition` in `scene`, or null: FFT Ocean Detail off or clamped
 * on this device, Detail Waves 0, no visible water has requested it yet, or the asset or quality changed since (the
 * next observer run rebinds). Check `ready` before sampling. Allocation-free.
 */
export function waterFftForSurface(scene: Scene, definition: WaterDefinition): WaterFftResult | null {
  const entry = scenes.get(scene)?.definitions.get(definition);
  const sim = entry?.sim;
  if (!entry || !sim || sim.disposed || sim.key !== entry.key || !(definition.detailWaves > 0)) return null;
  const quality = sceneWaterQualityDeviceClamp(scene).quality;
  if (!quality.fft || quality.fftSize !== sim.size || quality.fftCascades !== sim.cascades) return null;
  if (entry.set !== waterWaveSet(definition) || entry.gain !== definition.detailWaves) return null;
  return entry.view;
}

export interface WaterFftDiagnostics {
  simulations: { key: string; size: number; cascades: number; patchSizes: number[]; time: number; ready: boolean; dispatches: number }[];
  /** Simulations allocated, given a new spectrum in place of an idle one, released, and refused by the ledger. */
  created: number;
  respectrummed: number;
  retired: number;
  denied: number;
}

/** Test and proof readout of a scene's FFT simulations. Allocates; never call per frame. */
export function waterFftDiagnostics(scene: Scene): WaterFftDiagnostics {
  const state = scenes.get(scene);
  return {
    simulations: (state?.sims ?? []).map((sim) => ({
      key: sim.key, size: sim.size, cascades: sim.cascades, patchSizes: [...sim.layout.patchSizes], time: sim.time, ready: sim.ready,
      dispatches: sim.dispatches,
    })),
    created: state?.created ?? 0,
    respectrummed: state?.respectrummed ?? 0,
    retired: state?.retired ?? 0,
    denied: state?.denied ?? 0,
  };
}
