import {
  Color3, MaterialPluginBase, Matrix, PBRMaterial, type MaterialDefines, ShaderLanguage, Vector3, type AbstractEngine, type AbstractMesh, type Effect,
  type Material, Scene, type SubMesh, type UniformBuffer,
} from "@babylonjs/core";
import { WATER_FFT_CASCADES_MAX, waterBankFadeLength, waterFoamScale, type WaterBodyProperties, type WaterDefinition, type WaterQuality } from "@haptic/core";
import { sceneWaterQualityDeviceClamp } from "./render-settings";
import type { WaterFftResult } from "./water-fft";
import { invalidateSceneLighting } from "./scene-lighting";
import type { WaterContactField } from "./water-contact-field";
import { WATER_FIELD_DEPTH_RANGE, WATER_FIELD_FINE_DEPTH_SPAN, type WaterField } from "./water-field";
import { waterPlanarReflectionForCamera, type WaterPlanarReflection } from "./water-planar-reflection";
import type { WaterQualityDeviceClamp } from "./water-quality-device";
import { waterRemovalShapeVector } from "./water-removal-mesh";
import { isMainWaterPass, waterSceneCopyForPass, type WaterSceneCopy } from "./water-scene-copy";
import {
  absorbScratch, gammaScratch, GLOW_RATIO_CAP, glowCoefficient, linearScratch, placeholderFft, placeholderField, sceneWaterBindingData, smoothstep,
  waterAbsorption, type WaterBindingData, waterBodyLight, type WaterLighting, type WaterRemovalCandidate, withWaterEnvironment,
} from "./water-scene-state";
import { WATER_REMOVAL_SLOTS } from "./water-shader-chunks";
import {
  BLEND_COLOR_UNIFORMS, BLEND_PARTNERS, DEFAULT_TIER, EMPTY_TEXTURE, FFT, FFT_UNIFORMS, PLANAR, PLANAR_REACH, Q, REFRACTION, SSR, SSR_MAX_DISTANCE, SSR_STEPS,
  WATER_BLEND_DEFINE, WATER_FFT_SAMPLER, WATER_FOAM_SAMPLER, WATER_GPU_WAVES_DEFINE, WATER_PLANAR_SAMPLER, WATER_SCENE_SAMPLER, WATER_SHADING_TIERS,
  waterFoamThresholdOf,
} from "./water-shader-defines";
import { injectionFor, VERTEX_WAVE_ATTRIBUTES, VERTEX_WAVE_DEFINES } from "./water-shader-source";
import { bindWaterVertexUniforms, SPECTRUM_UNIFORM_FLOATS, waterGridOffset, waterSpectrumUniforms } from "./water-vertex-waves";
export {
  WATER_GPU_WAVES_DEFINE,
  WATER_BLEND_DEFINE,
  WATER_NODE_BLEND_DEFINE,
  WATER_BLEND_ATTRIBUTE_CONDITION,
  WATER_QUALITY_DEFINE,
  WATER_SHADING_TIERS,
  WATER_OBJECT_DEFINES,
  WATER_SCENE_SAMPLER,
  WATER_PLANAR_SAMPLER,
  WATER_FFT_DEFINE,
  WATER_FFT_SAMPLER,
  WATER_FOAM_SAMPLER,
  waterHazeConstants,
  waterFoamThresholdOf,
} from "./water-shader-defines";
export {
  edgeFoamHelpers,
  marchSource,
  transmittanceSource,
  WATER_FAR_ROUGHNESS,
  WATER_GLOSS_FALLOFF,
  fresnelSource,
  reflectionKeepSource,
  WATER_REMOVAL_SLOTS,
} from "./water-shader-chunks";
export {
  waterAbsorption,
  placeholderField,
  sceneWaterBodyLight,
  sceneWaterNodeLighting,
} from "./water-scene-state";
export {
  waterVertexSource,
  WATER_VERTEX_WAVE_UNIFORMS,
  WATER_CLOCK_UNIFORM,
  waterOutlineVertexSource,
  waterWaveBlockSource,
  WATER_EYE_UNIFORM,
  WATER_NODE_FOAM_UNIFORM,
  WATER_NODE_SUN_UNIFORM,
  WATER_NODE_VARYING,
  type WaterWaveNodeSources,
  waterWaveNodeSources,
  toWgsl,
  waterShaderSource,
  stripShaderComments,
} from "./water-shader-source";
export {
  setWaterGridOffsetSource,
  waterGridOffset,
  type WaterUniformSink,
  bindWaterVertexUniforms,
  WaterVertexWaves,
  setMeshVertexWaves,
  meshVertexWaves,
} from "./water-vertex-waves";

/**
 * The plugin of built-in water whose vertex shader displaces this mesh (GPU waves on, rest grid present), or null:
 * passes that draw the mesh with their own vertex shader add its displacement for exactly these.
 */
export function gpuWaterWaves(material: Material | null | undefined, mesh: AbstractMesh): WaterMaterialPlugin | null {
  const plugin = material?.pluginManager?.getPlugin<WaterMaterialPlugin>("SlateWater");
  return plugin instanceof WaterMaterialPlugin && plugin.gpuWaves && mesh.isVerticesDataPresent("slateWaterData") ? plugin : null;
}

/** Object contact distances are encoded up to three contact-foam widths (1-8 m). */
export const contactRange = (water: WaterDefinition) => Math.max(1, Math.min(8, water.contactFoamWidth * 3));

/** Writes one vec4 into a packed array at `o`; returns the next offset. */
const put4 = (v: Float64Array, o: number, x: number, y: number, z: number, w: number) => {
  v[o] = x; v[o + 1] = y; v[o + 2] = z; v[o + 3] = w;
  return o + 4;
};
/**
 * Writes an asset colour, in linear space as Babylon converts colours (exact sRGB where the engine uses it, like the
 * clear and fog colours in `sceneWaterLighting`), and `w` into a packed array at `o`; returns the next offset.
 */
const putLinear = (v: Float64Array, o: number, color: readonly number[], w: number, exact: boolean) => {
  gammaScratch.set(color[0]!, color[1]!, color[2]!).toLinearSpaceToRef(linearScratch, exact);
  return put4(v, o, linearScratch.r, linearScratch.g, linearScratch.b, w);
};
/**
 * The per-render vec4s `WaterMaterialPlugin.frameConstants` packs, in its write order; from `FRAME_BLEND_START` on, the
 * partners' colours only a blending surface binds.
 */
const FRAME_UNIFORMS: readonly string[] = [
  "slateWaterShallow", "slateWaterDeep", "slateWaterFoam", "slateWaterMotion", "slateWaterLook", "slateWaterWaves",
  "slateWaterSun", "slateWaterSunColor", "slateWaterSky", "slateWaterHorizon", "slateWaterSunShape", "slateWaterAbsorb", "slateWaterThrough",
  "slateWaterOrigin", "slateWaterLight", "slateWaterSwellInfo", "slateWaterShape", "slateWaterTerms", "slateWaterHaze",
  ...BLEND_COLOR_UNIFORMS,
];
const FRAME_BLEND_START = FRAME_UNIFORMS.length - BLEND_COLOR_UNIFORMS.length;
const NO_BLEND_PARTNERS: readonly (WaterDefinition | null)[] = Object.freeze([null, null, null]);
/** The numeric definition fields the packed vec4s read besides the colours (`frameInputsChanged`). */
const FRAME_DEFINITION_FIELDS = [
  "opacity", "reflectionStrength", "foamAmount", "foamWidth", "depthColorDistance",
  "subsurface", "waveHeight", "waveLength", "waveSpeed", "waveDirection", "surfaceFoam", "roughness", "colorVariation", "waveSpread",
  "crestFoam", "contactFoamWidth",
] as const satisfies readonly (keyof WaterDefinition)[];
/**
 * Render, clock, origin, scale, tier, reflection source, bank fade and the simulation's size and cascades; the fields;
 * three colours; each partner's three and nine.
 */
const FRAME_KEY_LENGTH = 12 + FRAME_DEFINITION_FIELDS.length + 9 + BLEND_PARTNERS * (3 + 9);
const REMOVAL_SHAPE_UNIFORMS = Array.from({ length: WATER_REMOVAL_SLOTS }, (_, i) => `slateWaterRemovalShape${i}`);
const REMOVAL_UNIFORMS = Array.from({ length: WATER_REMOVAL_SLOTS }, (_, i) => `slateWaterRemoval${i}`);
/** Sets one define; true when its value changed. */
function setDefine(defines: MaterialDefines, name: string, value: boolean | number): boolean {
  if (defines[name] === value) return false;
  defines[name] = value;
  return true;
}

/** A water variant a render pass asked Babylon to compile: what the compile log (`recordWaterVariant`) holds. */
export interface WaterVariantRequest {
  at: number;
  mesh: string;
  /** `engine.currentRenderPassId` when the variant was requested, and whether that is a scene-copy (main water) pass. */
  pass: number;
  mainPass: boolean;
  refraction: boolean;
  ssr: boolean;
  planar: boolean;
  fft: boolean;
  blend: boolean;
  /** The shadow defines in the variant, as the pass's shadow toggles left them. */
  shadows: string[];
  depthPrePass: boolean;
  prePass: boolean;
  /** The calling frames, innermost first. */
  caller: string;
}

/** Harnesses and tests opt in with `globalThis.__slateWaterCompileLog = []`; without it nothing is recorded. */
const WATER_COMPILE_LOG = "__slateWaterCompileLog";

/** Appends one request to the compile log when one is installed. Called when a pass's defines change, i.e. per variant. */
function recordWaterVariant(defines: MaterialDefines, mesh: AbstractMesh | null, scene: Scene): void {
  const log = (globalThis as unknown as Record<string, WaterVariantRequest[] | undefined>)[WATER_COMPILE_LOG];
  if (!log) return;
  const pass = scene.getEngine().currentRenderPassId;
  const on = (name: string) => Boolean(defines[name]);
  log.push({
    at: performance.now(), mesh: mesh?.name ?? "", pass, mainPass: isMainWaterPass(scene, pass),
    refraction: on(REFRACTION), ssr: on(SSR), planar: on(PLANAR), fft: on(FFT), blend: on(WATER_BLEND_DEFINE),
    shadows: Object.keys(defines).filter((name) => name.startsWith("SHADOW") && defines[name]),
    depthPrePass: on("DEPTHPREPASS"), prePass: on("PREPASS"),
    caller: String(new Error().stack ?? "").split("\n").slice(2, 12).map((frame) => frame.trim().replace(/^at /, "")).join(" < "),
  });
}

/** World-space water shading on native PBR; both backends use the same wave spectrum. */
export class WaterMaterialPlugin extends MaterialPluginBase {
  time = 0;
  /** Terrain data for this surface; null until terrain meets the water. */
  field: WaterField | null = null;
  /** Height-aware object contacts for this surface; its texture is null until an object meets the water. */
  contacts: WaterContactField | null = null;
  readonly water: WaterDefinition;
  readonly body: WaterBodyProperties;
  /** The surface this material shades, for choosing nearby removal volumes. */
  mesh: AbstractMesh | null = null;
  private bindingFrame = -1;
  private bindingRender = -1;
  private removalMesh: AbstractMesh | null = null;
  private readonly selectedRemovals: WaterRemovalCandidate[] = [];
  private readonly removalGaps = new Float64Array(WATER_REMOVAL_SLOTS + 1);
  /** The uniform buffer whose removal slots were last written empty (skipped while it stays so). */
  private removalsCleared: UniformBuffer | null = null;
  private _gpuWaves = false;
  /** Device-clamped quality the features below follow; compared by identity (it changes with the revision). */
  private clamp: WaterQualityDeviceClamp | null = null;
  private tier = DEFAULT_TIER;
  /** Rest height is level across the body (no river, no tilted volume): a planar reflection can mirror it. */
  private _flat = true;
  /** The surface blends with neighbours (`SLATE_WATER_BLEND`); the water mesh owns it with the per-vertex blend data. */
  private _blend = false;
  /**
   * The neighbours whose colours a blending surface mixes toward, by slot (each by its per-vertex colour share); null
   * keeps the asset's own. Set by the water mesh with `blend`.
   */
  partners: readonly (WaterDefinition | null)[] = NO_BLEND_PARTNERS;
  /** Device-effective features this asset asks for; the copy features also need a copy for the pass drawn. */
  private refracts = false;
  private marches = false;
  private mirrors = false;
  private marchSteps = 0;
  /** The scene copy and planar reflection of the current draw (`hardBindForSubMesh`), bound by `bindForSubMesh`. */
  private boundCopy: WaterSceneCopy | null = null;
  private boundPlanar: WaterPlanarReflection | null = null;
  /** The spectrum's cascades at the device-effective quality (`SLATE_WATER_FFT`). */
  private fftCascades = 1;
  /** The spectrum bound for the current draw: ready and matching the compiled cascades, or null (placeholder, gain 0). */
  private boundFft: WaterFftResult | null = null;
  /** `slateWaterFft` and the cascades' vec4s, as last computed (`waterSpectrumUniforms`). */
  private readonly fftValues = new Float32Array(SPECTRUM_UNIFORM_FLOATS);
  /** `frameConstants`' packed vec4s and the inputs they were computed from (`frameInputsChanged`). */
  private readonly frameValues = new Float64Array(FRAME_UNIFORMS.length * 4);
  private readonly frameKey = new Float64Array(FRAME_KEY_LENGTH).fill(NaN);
  private readonly frameScratch = new Float64Array(FRAME_KEY_LENGTH);
  private readonly framePartners: (WaterDefinition | null)[] = [null, null, null];
  constructor(material: PBRMaterial, water: WaterDefinition, body: WaterBodyProperties) {
    super(material, "SlateWater", 180, {
      SLATE_WATER: true, [WATER_GPU_WAVES_DEFINE]: false, [Q]: DEFAULT_TIER,
      [REFRACTION]: false, [SSR]: false, [SSR_STEPS]: 0, [PLANAR]: false, [FFT]: 1, [WATER_BLEND_DEFINE]: false,
    }, true, false);
    this.water = water;
    this.body = body;
    this.doNotSerialize = true;
    this.registerForExtraEvents = true;
    this._enable(true);
    this.syncQuality(material.getScene());
  }
  override isCompatible(): boolean { return true; }
  override getClassName(): string { return "WaterMaterialPlugin"; }
  /** The shading tier compiled into this material (`SLATE_WATER_QUALITY`): 0 Low to 3 Ultra. */
  get shadingTier(): number { return this.tier; }
  /**
   * Follows the scene's device-clamped project Water quality. Unchanged quality costs one cached-clamp compare; a new
   * Shading Detail, or a change in the refraction, reflection and spectrum features this asset runs, marks the defines
   * dirty (and resets a frozen Play material's cached readiness). Realistic Low draws unlit; this also restores that flag
   * after the editor's Unlit viewport mode, which owns it while active. Called every frame by the water update and
   * before each readiness check, ahead of define preparation.
   */
  syncQuality(scene: Scene = this._material.getScene()): void {
    const clamp = sceneWaterQualityDeviceClamp(scene);
    if (clamp !== this.clamp) {
      this.clamp = clamp;
      const tier = WATER_SHADING_TIERS[clamp.quality.shadingDetail];
      if (tier !== this.tier) {
        this.tier = tier;
        this.markDefinesDirty();
      }
      this.syncObjectFeatures();
    }
    const material = this._material as PBRMaterial;
    if (material.unlit) return;
    const unlit = this.tier === WATER_SHADING_TIERS.low;
    if (material.disableLighting === unlit) return;
    material.disableLighting = unlit;
    if (material.isFrozen) material.markDirty(true);
    // Lit again: the scene's light-slot capacity reaches this material at its next lighting sync.
    invalidateSceneLighting(scene);
  }
  /** Defines changed outside define preparation; a frozen Play material re-prepares only when marked dirty. */
  private markDefinesDirty(): void {
    this.markAllDefinesAsDirty();
    if (this._material.isFrozen) this._material.markDirty(true);
  }
  /**
   * Refraction, the screen-space march, the planar reflection and the spectrum's cascades this asset runs at the
   * device-effective quality: Refraction above 0 with Water Refraction on; Object Reflections under Screen Space
   * reflections or Planar's Screen Space fallback; Object Reflections at Planar on a flat body; FFT Cascades. Recompiles
   * only when one of them changes.
   */
  private syncObjectFeatures(): void {
    const clamp = this.clamp;
    if (!clamp) return;
    const q = clamp.quality, w = this.water;
    const refracts = q.refraction && w.refraction > 0;
    const marches = w.objectReflections && (q.reflections === "screenSpace" || (q.reflections === "planar" && clamp.screenSpaceFallback));
    const mirrors = w.objectReflections && q.reflections === "planar" && this._flat;
    const steps = marches ? Math.round(q.reflectionSteps) : 0;
    const fft = Math.max(1, q.fftCascades);
    if (refracts === this.refracts && marches === this.marches && mirrors === this.mirrors && steps === this.marchSteps && fft === this.fftCascades) return;
    this.refracts = refracts; this.marches = marches; this.mirrors = mirrors; this.marchSteps = steps; this.fftCascades = fft;
    this.markDefinesDirty();
  }
  /**
   * The asset was edited in place (`updateWaterMeshDefinition`; Style never changes there). Re-evaluates the features
   * it runs (Refraction, Object Reflections). Uniform-only fields (waves, colours, amounts) cost nothing here: every bind
   * reads the definition.
   */
  definitionChanged(): void {
    this.syncObjectFeatures();
  }
  /** The spectrum's cascades compiled into this material (`SLATE_WATER_FFT`). */
  get spectrumCascades(): number { return this.fftCascades; }
  /**
   * Whether the body's rest height is level (no river, no volume tilted out of level), as its planar reflection
   * requires; the water mesh keeps it current when the volume's rotation changes.
   */
  get flat(): boolean { return this._flat; }
  set flat(value: boolean) {
    if (this._flat === value) return;
    this._flat = value;
    this.syncObjectFeatures();
  }
  /** Whether the surface blends with neighbours (`SLATE_WATER_BLEND`): the water mesh sets it with the vertex data. */
  get blend(): boolean { return this._blend; }
  set blend(value: boolean) {
    if (this._blend === value) return;
    this._blend = value;
    this.markDefinesDirty();
  }
  /**
   * Wave Scale the spectrum's uniforms carry: the body's, or 1 for a calm body that blends, so it can take a neighbour's
   * waves through its per-vertex scales (`PreparedWaterBlendBody.referenceScale`).
   */
  get waveScale(): number { return this._blend && Math.abs(this.body.waveScale) <= 1e-6 ? 1 : this.body.waveScale; }
  override isReadyForSubMesh(_defines: MaterialDefines, scene: Scene): boolean {
    this.syncQuality(scene);
    return true;
  }
  /**
   * Defines are prepared per render pass (each pass has its own draw wrapper): the copy features compile only into a
   * pass with a registered scene copy, which is registered before that pass's first readiness probe and never
   * changes for the pass, so no later dirtying is needed. The depth pre-pass draws under its own pass id
   * (`TransparentDepthPrePass`) and compiles neither: its variant returns before them, with the same vertex stage.
   */
  override prepareDefines(defines: MaterialDefines, scene: Scene): void {
    let changed = setDefine(defines, WATER_GPU_WAVES_DEFINE, this._gpuWaves);
    changed = setDefine(defines, Q, this.tier) || changed;
    const copy = (this.refracts || this.marches) && isMainWaterPass(scene, scene.getEngine().currentRenderPassId);
    changed = setDefine(defines, REFRACTION, this.refracts && copy) || changed;
    changed = setDefine(defines, SSR, this.marches && copy) || changed;
    changed = setDefine(defines, SSR_STEPS, this.marches && copy ? this.marchSteps : 0) || changed;
    // Every pass at Planar quality compiles it, Render Target Capture passes included: their planar lookup is null
    // (mirrors are per scene view), so the per-draw uniform selects the march or sky fallback. Gating it per pass would
    // need a registry of planar-drawing pass ids, as the scene copy has.
    changed = setDefine(defines, PLANAR, this.mirrors) || changed;
    changed = setDefine(defines, FFT, this.fftCascades) || changed;
    changed = setDefine(defines, WATER_BLEND_DEFINE, this._blend) || changed;
    if (changed) {
      defines.markAsUnprocessed();
      recordWaterVariant(defines, this.mesh, scene);
    }
  }
  /**
   * True when the vertex shader displaces the mesh (`SLATE_WATER_GPU_WAVES`) and the mesh keeps a static rest grid.
   * The water mesh owns this: its vertex data layout must change with it (see `setWaterGpuWaves`).
   */
  get gpuWaves(): boolean { return this._gpuWaves; }
  set gpuWaves(value: boolean) {
    if (this._gpuWaves === value) return;
    this._gpuWaves = value;
    this.markDefinesDirty();
  }
  override getAttributes(attributes: string[]): void {
    attributes.push("slateWaterData", "slateWaterFlow", "slateWaterBaseNormal", "slateWaterOffset");
    if (this._blend) attributes.push("slateWaterBlend", "slateWaterBlendColors");
  }
  override getUniforms() {
    const vectors = [
      "slateWaterShallow", "slateWaterDeep", "slateWaterFoam", "slateWaterMotion", "slateWaterLook", "slateWaterWaves", "slateWaterSun", "slateWaterSunColor",
      "slateWaterLight", "slateWaterShape", "slateWaterFieldBounds", "slateWaterFieldInfo", "slateWaterFieldStep", "slateWaterContactBounds", "slateWaterContactInfo",
      "slateWaterOrigin", "slateWaterGridOffset", "slateWaterSwellInfo", "slateWaterTerms", "slateWaterHaze",
      // Realistic: the analytic sky's zenith and horizon (scene background and fog colours), the per-channel
      // absorption from Shallow Color (w: Low's single coefficient), the uniform-only sun terms and the light through
      // thin crests (Subsurface).
      "slateWaterSky", "slateWaterHorizon", "slateWaterAbsorb", "slateWaterSunShape", "slateWaterThrough",
      // (1 / output width, 1 / output height, Refraction, march distance) and (planar on, display-encoded,
      // distortion, 0): per draw, from the pass's scene copy and the view's planar reflection.
      "slateWaterScreen", "slateWaterPlanar",
      // A blending surface's partners' colours (\`BLEND_COLOR_UNIFORMS\`).
      ...BLEND_COLOR_UNIFORMS, ...FFT_UNIFORMS,
    ];
    const removals = Array.from({ length: WATER_REMOVAL_SLOTS }, (_, i) => i);
    return { ubo: [
      ...[...vectors, ...removals.map((i) => `slateWaterRemovalShape${i}`)].map((name) => ({ name, size: 4, type: "vec4" })),
      ...removals.map((i) => ({ name: `slateWaterRemoval${i}`, size: 16, type: "mat4" })),
      { name: "slateWaterPlanarMatrix", size: 16, type: "mat4" },
    ] };
  }
  // Unused names are dropped by Babylon: the copy and planar samplers bind only in variants that declare them.
  override getSamplers(samplers: string[]): void {
    samplers.push("slateWaterFieldSampler", "slateWaterContactSampler", WATER_SCENE_SAMPLER, WATER_PLANAR_SAMPLER, WATER_FFT_SAMPLER, WATER_FOAM_SAMPLER);
  }
  override bindForSubMesh(buffer: UniformBuffer, scene: Scene, _engine?: AbstractEngine, subMesh?: SubMesh): void {
    buffer.setTexture("slateWaterFieldSampler", this.field?.texture ?? placeholderField(scene));
    buffer.setTexture("slateWaterContactSampler", this.contacts?.texture ?? placeholderField(scene));
    // The variant drawn in this pass declares the copy and planar samplers only with their features; a placeholder
    // (Babylon's empty texture, or an empty array for the spectrum, sampled at gain 0) keeps a declared binding valid in a
    // frame without its source.
    const defines = subMesh?.materialDefines as MaterialDefines | null | undefined;
    if (defines?.[REFRACTION] || defines?.[SSR]) buffer.setTexture(WATER_SCENE_SAMPLER, this.boundCopy?.texture ?? EMPTY_TEXTURE);
    if (defines?.[PLANAR]) buffer.setTexture(WATER_PLANAR_SAMPLER, this.boundPlanar?.texture ?? EMPTY_TEXTURE);
    buffer.setTexture(WATER_FFT_SAMPLER, this.boundFft?.texture ?? placeholderFft(scene));
    // The foam: the placeholder's zero turbulence is neutralized by the zero gain bound with it.
    buffer.setTexture(WATER_FOAM_SAMPLER, this.boundFft?.foam ?? placeholderFft(scene));
  }
  /**
   * Per draw: the pass's scene copy (its output size can change in place, so `invSize` is read every draw) and the
   * view's planar reflection, looked up only when the variant drawn samples them. The planar lookup also requests
   * the reflection for the view's next renders, so only water that draws it keeps it alive. Allocation-free.
   */
  private bindObjectFeatures(buffer: UniformBuffer, scene: Scene, subMesh: SubMesh | undefined): void {
    const defines = subMesh?.materialDefines as MaterialDefines | null | undefined;
    this.boundCopy = this.boundPlanar = null;
    const camera = scene.activeCamera;
    if (defines?.[REFRACTION] || defines?.[SSR]) {
      const copy = waterSceneCopyForPass(scene, scene.getEngine().currentRenderPassId);
      this.boundCopy = copy;
      const distance = Math.min(camera && camera.maxZ > 0 ? camera.maxZ : SSR_MAX_DISTANCE, SSR_MAX_DISTANCE);
      buffer.updateFloat4("slateWaterScreen", copy ? copy.invSize[0] : 0, copy ? copy.invSize[1] : 0, this.water.refraction, distance);
    }
    // The planar uniform also selects the march for bodies that are not the view's dominant one.
    if (defines?.[PLANAR] || defines?.[SSR]) {
      const planar = defines?.[PLANAR] ? waterPlanarReflectionForCamera(scene, camera) : null;
      const mine = planar && planar.mesh === this.mesh ? planar : null;
      this.boundPlanar = mine;
      buffer.updateFloat4("slateWaterPlanar", mine ? 1 : 0, mine?.gammaSpace ? 1 : 0, PLANAR_REACH, 0);
      if (mine) buffer.updateMatrix("slateWaterPlanarMatrix", mine.viewProjection);
    }
  }
  /**
   * Per draw: asks for the spectrum (`waterSpectrumUniforms`, which is also its demand) and uploads its uniforms. Until
   * it is ready (or when it does not match the compiled cascades) the gain is 0, so the placeholder bound instead leaves
   * the surface flat. Allocation-free.
   */
  private bindFft(buffer: UniformBuffer, scene: Scene): void {
    this.boundFft = waterSpectrumUniforms(scene, this.water, this.waveScale, this.fftCascades, this.fftValues);
    const v = this.fftValues;
    for (let i = 0; i < 1 + WATER_FFT_CASCADES_MAX; i++) buffer.updateFloat4(FFT_UNIFORMS[i]!, v[i * 4]!, v[i * 4 + 1]!, v[i * 4 + 2]!, v[i * 4 + 3]!);
  }
  override hardBindForSubMesh(buffer: UniformBuffer, scene: Scene, _engine?: AbstractEngine, subMesh?: SubMesh): void {
    this.bindObjectFeatures(buffer, scene, subMesh);
    this.bindFft(buffer, scene);
    // Per mesh, every draw: surfaces that share this material recentre independently, so it is not a frame constant.
    const grid = waterGridOffset(subMesh?.getRenderingMesh() ?? this.mesh);
    buffer.updateFloat4("slateWaterGridOffset", grid[0]!, grid[1]!, grid[2]!, 0);
    const data = sceneWaterBindingData(scene);
    // Packed without allocation, then uploaded.
    const values = this.frameConstants(scene, data), count = this._blend ? FRAME_UNIFORMS.length : FRAME_BLEND_START;
    for (let i = 0; i < count; i++) {
      const o = i * 4;
      buffer.updateFloat4(FRAME_UNIFORMS[i]!, values[o]!, values[o + 1]!, values[o + 2]!, values[o + 3]!);
    }
    const w = this.water;
    const field = this.field?.texture ? this.field : null;
    if (field) {
      const bounds = field.bounds, depth = field.depthRange, texel = field.texelSize;
      buffer.updateFloat4("slateWaterFieldBounds", bounds[0]!, bounds[1]!, bounds[2]!, bounds[3]!);
      buffer.updateFloat4("slateWaterFieldInfo", 1, field.fineDepthMin, depth[0], depth[1]);
      buffer.updateFloat4("slateWaterFieldStep", texel[0], texel[1], field.fineDepthSpan, 0);
    } else {
      buffer.updateFloat4("slateWaterFieldBounds", 0, 0, 1, 1);
      buffer.updateFloat4("slateWaterFieldInfo", 0, 0, WATER_FIELD_DEPTH_RANGE[0], WATER_FIELD_DEPTH_RANGE[1]);
      buffer.updateFloat4("slateWaterFieldStep", 1, 1, WATER_FIELD_FINE_DEPTH_SPAN, 0);
    }
    const contacts = this.contacts?.texture ? this.contacts : null;
    if (contacts) {
      const bounds = contacts.bounds;
      buffer.updateFloat4("slateWaterContactBounds", bounds[0]!, bounds[1]!, bounds[2]!, bounds[3]!);
      buffer.updateFloat4("slateWaterContactInfo", 1, contacts.range, contacts.amplitude, 0);
    } else {
      buffer.updateFloat4("slateWaterContactBounds", 0, 0, 1, 1);
      buffer.updateFloat4("slateWaterContactInfo", 0, contactRange(w), 1, 0);
    }
    // The nearest enabled removal volumes that can reach this surface.
    const mesh = this.mesh;
    if (this.bindingFrame !== data.frame || this.bindingRender !== data.render || this.removalMesh !== mesh) {
      const selected = this.selectedRemovals, gaps = this.removalGaps;
      selected.length = 0;
      if (data.removals.length > 0) {
        // The nearest few that reach the surface, by insertion into the slots (no per-render arrays).
        const center = mesh?.getBoundingInfo().boundingSphere;
        for (const entry of data.removals) {
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
      this.bindingFrame = data.frame;
      this.bindingRender = data.render;
      this.removalMesh = mesh;
    }
    // Without removals the cleared slots stay cleared in this material's buffer: nothing to rewrite per draw.
    if (this.selectedRemovals.length > 0 || this.removalsCleared !== buffer) {
      for (let i = 0; i < WATER_REMOVAL_SLOTS; i++) {
        const entry = this.selectedRemovals[i];
        if (!entry) { buffer.updateFloat4(REMOVAL_SHAPE_UNIFORMS[i]!, 0, 0, 0, 0); buffer.updateMatrix(REMOVAL_UNIFORMS[i]!, Matrix.IdentityReadOnly); continue; }
        const shape = entry.shape ??= waterRemovalShapeVector(entry.volume);
        buffer.updateFloat4(REMOVAL_SHAPE_UNIFORMS[i]!, shape[0], shape[1], shape[2], shape[3]);
        entry.inverse ??= entry.mesh.getWorldMatrix().clone().invert();
        buffer.updateMatrix(REMOVAL_UNIFORMS[i]!, entry.inverse);
      }
      this.removalsCleared = this.selectedRemovals.length > 0 ? null : buffer;
    }
  }
  /**
   * Writes every input of `frameConstants` into `frameKey` (the render, which owns the scene lighting, the clock, the
   * origin, Wave Scale, tier, reflection source and each definition field it reads) and reports whether any changed
   * since the last call, or a partner did. Allocation-free.
   */
  private frameInputsChanged(data: WaterBindingData, origin: Vector3, scale: number, reflective: boolean, bankFade: number, blend: boolean, quality: Readonly<WaterQuality>): boolean {
    const s = this.frameScratch, w = this.water;
    let n = 0;
    s[n++] = data.frame; s[n++] = data.render; s[n++] = this.time; s[n++] = origin.x; s[n++] = origin.y; s[n++] = origin.z;
    s[n++] = scale; s[n++] = this.tier; s[n++] = reflective ? 1 : 0; s[n++] = bankFade;
    s[n++] = quality.fftSize; s[n++] = quality.fftCascades;
    for (let i = 0; i < FRAME_DEFINITION_FIELDS.length; i++) s[n++] = w[FRAME_DEFINITION_FIELDS[i]!];
    for (let c = 0; c < 3; c++) { s[n++] = w.shallowColor[c]!; s[n++] = w.deepColor[c]!; s[n++] = w.foamColor[c]!; }
    let changed = false;
    for (let k = 0; k < BLEND_PARTNERS; k++) {
      const partner = blend ? this.partners[k] ?? w : null;
      if (this.framePartners[k] !== partner) { this.framePartners[k] = partner; changed = true; }
      if (!partner) continue;
      s[n++] = partner.opacity; s[n++] = partner.reflectionStrength; s[n++] = partner.foamAmount;
      for (let c = 0; c < 3; c++) { s[n++] = partner.shallowColor[c]!; s[n++] = partner.deepColor[c]!; s[n++] = partner.foamColor[c]!; }
    }
    const key = this.frameKey;
    for (let i = 0; i < n; i++) if (!Object.is(key[i], s[i])) { key[i] = s[i]!; changed = true; }
    return changed;
  }
  /** The bound vec4s in `FRAME_UNIFORMS` order (colours, lighting and the asset's terms), read from the definition at every bind. */
  private frameConstants(scene: Scene, data: WaterBindingData): Float64Array {
    const origin = scene.floatingOriginMode ? scene.floatingOriginOffset : Vector3.ZeroReadOnly;
    const w = this.water, scale = this.waveScale, blend = this._blend;
    const material = this._material as PBRMaterial, reflective = material.reflectionTexture !== null || scene.environmentTexture !== null;
    const bankFade = this.bankFade();
    // The depth pre-pass and colour draws (and further views) of one render bind the same values: compare every input
    // (a few dozen numbers) instead of recomputing them, so in-place asset edits still apply at the next draw.
    const quality = sceneWaterQualityDeviceClamp(scene).quality;
    if (!this.frameInputsChanged(data, origin, scale, reflective, bankFade, blend, quality)) return this.frameValues;
    const v = this.frameValues;
    let o = 0;
    const lighting = data.lighting, ambient = withWaterEnvironment(lighting, w.reflectionStrength, reflective);
    const exact = scene.getEngine().useExactSrgbConversions;
    o = putLinear(v, o, w.shallowColor, w.opacity, exact);
    o = putLinear(v, o, w.deepColor, w.reflectionStrength, exact);
    o = putLinear(v, o, w.foamColor, w.foamAmount, exact);
    o = put4(v, o, this.time, 0, 0, w.foamWidth);
    o = put4(v, o, 0, w.depthColorDistance, 0, w.subsurface);
    o = put4(v, o, w.waveHeight * scale, w.waveLength, w.waveSpeed, w.waveDirection * Math.PI / 180);
    const sun = lighting.sun, sunColor = lighting.sunColor, sky = lighting.sky, horizon = lighting.horizon;
    o = put4(v, o, sun[0]!, sun[1]!, sun[2]!, sun[3]!);
    o = put4(v, o, sunColor[0]!, sunColor[1]!, sunColor[2]!, w.surfaceFoam);
    o = put4(v, o, sky[0]!, sky[1]!, sky[2]!, lighting.sunGlitter);
    o = put4(v, o, horizon[0]!, horizon[1]!, horizon[2]!, lighting.overcast);
    const shape = lighting.sunShape;
    o = put4(v, o, shape[0]!, shape[1]!, shape[2]!, shape[3]!);
    this.absorption(v, o, lighting, w, exact); o += 8;
    // With floating origin, shaders see positions relative to this offset (the eye); patterns must stay world-anchored.
    o = put4(v, o, origin.x, origin.y, origin.z, w.roughness);
    o = put4(v, o, ambient[0]!, ambient[1]!, ambient[2]!, waterBodyLight(ambient, lighting));
    o = put4(v, o, bankFade, 0, w.colorVariation, 0);
    o = put4(v, o, waterFoamThresholdOf(w, scale, quality.fftSize, Math.max(1, quality.fftCascades)), w.waveSpread, w.crestFoam, w.contactFoamWidth);
    o = put4(v, o, smoothstep(0, 0.1, w.foamAmount) * Math.max(w.foamAmount, 0.85) * smoothstep(0, 0.05, w.contactFoamWidth), smoothstep(0, 0.05, w.crestFoam), 1 / waterFoamScale(scale), 0);
    const haze = lighting.haze;
    o = put4(v, o, haze[0]!, haze[1]!, haze[2]!, haze[3]!);
    for (let k = 0; blend && k < BLEND_PARTNERS; k++) {
      // Each partner's colours, through the same conversions as the asset's own (its own again in an empty slot).
      const partner = this.partners[k] ?? w;
      o = putLinear(v, o, partner.shallowColor, partner.opacity, exact);
      o = putLinear(v, o, partner.deepColor, partner.reflectionStrength, exact);
      o = putLinear(v, o, partner.foamColor, partner.foamAmount, exact);
      this.absorption(v, o, lighting, partner, exact); o += 8;
    }
    return v;
  }
  /**
   * Per-channel absorption for Realistic transmittance (`slateWaterAbsorb`, `waterAbsorption`; `w` is spare, 0), and
   * the light through thin crests (`slateWaterThrough`, Subsurface): the sun's colour times what a crest transmits, by
   * the gentler `glowCoefficient`, with Opacity's cap on the absorption path in `w`. Allocation-free.
   */
  private absorption(v: Float64Array, o: number, lighting: WaterLighting, water: WaterDefinition, exact: boolean): void {
    const absorb = waterAbsorption(water, exact, absorbScratch), pathCap = absorb[3]!;
    put4(v, o, absorb[0]!, absorb[1]!, absorb[2]!, 0);
    gammaScratch.set(Math.max(0, water.shallowColor[0]), Math.max(0, water.shallowColor[1]), Math.max(0, water.shallowColor[2])).toLinearSpaceToRef(linearScratch, exact);
    const r = linearScratch.r, g = linearScratch.g, b = linearScratch.b;
    // Light through a crest crosses more open water than a shallow, through gentler ratios, and blue goes at least as
    // fast as green there (the plankton and dissolved matter of open water absorb blue), so crests glow teal against the
    // navy body even where clear shallows over sand read azure.
    const gr = glowCoefficient(r), gg = glowCoefficient(g), gb = Math.max(glowCoefficient(b), gg), glowWeight = Math.min(gr, gg, gb);
    const tr = Math.min(gr / glowWeight, GLOW_RATIO_CAP), tg = Math.min(gg / glowWeight, GLOW_RATIO_CAP), tb = Math.min(gb / glowWeight, GLOW_RATIO_CAP);
    const sun = lighting.sun[3]! * lighting.subsurfaceLift * 0.8, color = lighting.sunColor;
    put4(v, o + 4, color[0]! * Math.exp(-tr * 1.6) * sun, color[1]! * Math.exp(-tg * 1.6) * sun, color[2]! * Math.exp(-tb * 1.6) * sun, pathCap);
  }
  private bankFade(): number { return this.body.kind === "global" ? 0 : waterBankFadeLength(this.water, this.waveScale); }
  /**
   * Defines another pass's program needs for `waterOutlineVertexSource` to match this material's vertex shader: the
   * spectrum's cascades and the blend scaling. Allocation-free.
   */
  vertexWaveDefines(): readonly string[] {
    return VERTEX_WAVE_DEFINES[this._blend ? 1 : 0]![this.fftCascades]!;
  }
  /** Mesh attributes `waterOutlineVertexSource` reads under `vertexWaveDefines`. Allocation-free. */
  vertexWaveAttributes(): readonly string[] {
    return VERTEX_WAVE_ATTRIBUTES[this._blend ? 1 : 0]!;
  }
  /**
   * Sets `WATER_VERTEX_WAVE_UNIFORMS` and the spectrum's sampler on another pass's effect for this frame, as
   * `hardBindForSubMesh` and `bindForSubMesh` do, and the drawn `mesh`'s grid offset.
   */
  bindVertexWaves(effect: Effect, scene: Scene, mesh: AbstractMesh): void {
    const band = waterSpectrumUniforms(scene, this.water, this.waveScale, this.fftCascades, this.fftValues);
    bindWaterVertexUniforms(effect, scene, waterGridOffset(mesh), this.bankFade(), this.fftValues, band);
  }
  /**
   * Injected code is a pure function of (stage, language), so it is built and stripped once per key (`injectionFor`).
   * Babylon calls this at every effect compile, once per injection point.
   */
  override getCustomCode(shaderType: string, language = ShaderLanguage.GLSL): Record<string, string> | null {
    if (shaderType !== "vertex" && shaderType !== "fragment") return null;
    return injectionFor(shaderType, language);
  }
}

export function configureWaterMaterial(material: PBRMaterial, water: WaterDefinition): void {
  // Water drops the light loop at Low Water Shading Detail (`WaterMaterialPlugin.syncQuality`).
  material.unlit = material.disableLighting = false;
  // Realistic output is premultiplied (see CUSTOM_FRAGMENT_BEFORE_FOG), which raises coverage for bright light itself.
  material.useRadianceOverAlpha = false;
  material.useSpecularOverAlpha = false;
  material.albedoColor = Color3.White();
  material.metallic = 0;
  applyWaterMaterialScalars(material, water);
  material.indexOfRefraction = 1.333;
  // Realistic water widens its GGX lobe by the slope variance its filtered waves lose; Babylon's derivative-based
  // specular antialiasing would widen it again and dim the sun glitter to nothing.
  material.enableSpecularAntiAliasing = false;
  // The shader derives per-pixel transmittance from depth; blending must stay on even at full Opacity.
  material.alpha = 1;
  material.transparencyMode = PBRMaterial.PBRMATERIAL_ALPHABLEND;
  material.backFaceCulling = false;
  material.needDepthPrePass = true;
}

/** The PBR scalars a Water definition sets besides its Style (which needs a rebuild): Roughness and Reflection Strength. */
export function applyWaterMaterialScalars(material: PBRMaterial, water: WaterDefinition): void {
  material.roughness = water.roughness;
  material.environmentIntensity = water.reflectionStrength;
}
