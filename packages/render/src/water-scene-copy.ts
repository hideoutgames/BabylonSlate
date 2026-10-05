import {
  Constants, EffectWrapper, Matrix, MultiMaterial, RenderingManager, ShaderLanguage, Texture, ThinTexture,
  type AbstractEngine, type AbstractMesh, type Camera, type FrameGraphObjectList, type IParticleSystem, type Scene,
} from "@babylonjs/core";
import { ShaderStore } from "@babylonjs/core/Engines/shaderStore";
import { FrameGraphTask } from "@babylonjs/core/FrameGraph/frameGraphTask";
import type { FrameGraph } from "@babylonjs/core/FrameGraph/frameGraph";
import type { FrameGraphTextureHandle } from "@babylonjs/core/FrameGraph/frameGraphTypes";
import type { FrameGraphCullObjectsTask } from "@babylonjs/core/FrameGraph/Tasks/Misc/cullObjectsTask";
import { FrameGraphObjectRendererTask } from "@babylonjs/core/FrameGraph/Tasks/Rendering/objectRendererTask";
import { FrameGraphClearTextureTask } from "@babylonjs/core/FrameGraph/Tasks/Texture/clearTextureTask";
import { FrameGraphCopyToBackbufferColorTask } from "@babylonjs/core/FrameGraph/Tasks/Texture/copyToBackbufferColorTask";
import { FrameGraphCopyToTextureTask } from "@babylonjs/core/FrameGraph/Tasks/Texture/copyToTextureTask";
import { HasStencilAspect } from "@babylonjs/core/Materials/Textures/textureHelper.functions";
import "@babylonjs/core/Shaders/postprocess.vertex";
import "@babylonjs/core/ShadersWGSL/postprocess.vertex";
import "@babylonjs/core/Shaders/ShadersInclude/helperFunctions";
import "@babylonjs/core/ShadersWGSL/ShadersInclude/helperFunctions";
import { clusteredLightTarget } from "./clustered-light-policy";
import { ManagedShadowObjectRendererTask } from "./framegraph-managed-shadows";
import {
  beginManagedRenderAllocation, releaseManagedRenderLeaseAfterDisposal, type ManagedRenderLease,
} from "./managed-render-resources";
import { retireOwnedEffect, type OwnedEffectRetirement } from "./owned-effect-retirement";
import { sceneWaterQualityDeviceClamp } from "./render-settings";
import { managedRenderTextureResource, renderTargetAllocationBytes } from "./render-target-resource-cost";
import { sceneWaterSamplesSceneCopy, waterMeshSamplesSceneCopy } from "./water-mesh";
import type { WaterQualityDeviceClamp } from "./water-quality-device";

/** Linear view depth written for sky / far-plane pixels (the sentinel volumetric-shader also uses). */
export const WATER_SCENE_COPY_SKY_DEPTH = 65000;
/**
 * RGBA16F stores the sentinel as its nearest half float, 64992: readers treat
 * a copy alpha at or above this as sky. Real depths are clamped to the sentinel.
 */
export const WATER_SCENE_COPY_SKY_THRESHOLD = 64000;
export const WATER_SCENE_COPY_SHADER = "babylonSlateWaterSceneCopy";

/**
 * One view's opaque scene copy, sampled by built-in water drawn in that view's
 * transparent pass. Look it up per draw with `waterSceneCopyForPass`.
 */
export interface WaterSceneCopy {
  /**
   * RGBA16F, CLAMP, bilinear: rgb = linear scene colour after the opaque pass;
   * a = positive linear view depth of the nearest surface in each texel's
   * footprint, WATER_SCENE_COPY_SKY_DEPTH for sky. Its internal texture is
   * attached when the graph builds, before the graph ever draws.
   */
  readonly texture: ThinTexture;
  /** 1 / full output size in pixels: the copy's uv = fragment position × invSize. */
  readonly invSize: readonly [number, number];
  /** Copy resolution relative to the output (device-effective Refraction Resolution). */
  readonly scale: number;
  /** Process-unique; changes whenever `texture` is (re)attached or the output is resized. */
  readonly revision: number;
}

type RegistryEntry = { texture: ThinTexture; invSize: [number, number]; scale: number; revision: number };
const registries = new WeakMap<Scene, Map<number, RegistryEntry>>();
let revisions = 0;

/**
 * The scene copy for a render pass, or null. Only a ForwardSceneFrameGraph's
 * "Forward transparent" pass has one; classic frames, captures, previews and
 * thumbnails use other pass ids and keep today's blended water.
 */
export function waterSceneCopyForPass(scene: Scene, renderPassId: number): WaterSceneCopy | null {
  return registries.get(scene)?.get(renderPassId) ?? null;
}

/** Whether `renderPassId` is a main view's water pass, which samples a scene copy. */
export function isMainWaterPass(scene: Scene, renderPassId: number): boolean {
  return registries.get(scene)?.has(renderPassId) ?? false;
}

/** Device-effective features that sample the copy (planar uses it for its screen-space fallback). */
function refractionDemand(clamp: WaterQualityDeviceClamp): boolean {
  return clamp.quality.refraction;
}
function screenSpaceDemand(clamp: WaterQualityDeviceClamp): boolean {
  const reflections = clamp.quality.reflections;
  return reflections === "screenSpace" || (reflections === "planar" && clamp.screenSpaceFallback);
}

/** A per-group clear would wipe the opaque depth before the transparent pass draws (groups share one depth buffer). */
function clearsDepthBetweenGroups(scene: Scene): boolean {
  if (!RenderingManager.AUTOCLEAR) return false;
  for (let group = 1; group < RenderingManager.MAX_RENDERINGGROUPS; group += 1) {
    const setup = scene.getAutoClearDepthStencilSetup(group);
    if (setup?.autoClear && setup.depth) return true;
  }
  return false;
}

/** An explicit colour/depth output the copy can sample directly; the backbuffer cannot be sampled. */
function sampleableOutput(camera: Camera): boolean {
  const depth = camera.outputRenderTarget?.depthStencilTexture;
  return depth !== null && depth !== undefined && !HasStencilAspect(depth.format);
}

/** A copy texel's size for an output dimension, as FrameGraph resolves a percentage size. */
function copyDimension(output: number, scale: number): number {
  return Math.floor((scale * 100 * output) / 100);
}

/**
 * The copy scale the scene and view ask for, or 0: device-effective Refraction
 * or a screen-space reflection march, built-in water whose asset samples that
 * feature (Refraction above 0, or Object Reflections), half-float render
 * targets, no per-group depth clear in groups 1–3, (when the output itself
 * cannot be sampled and an own colour/depth pair stands in) a cleared frame,
 * and an output large enough for a copy texel. Cheap and allocation-free: a
 * view compares it every frame and re-plans when it changes. Clustered
 * lighting is checked only when planning (`waterSceneCopyScale`).
 */
export function waterSceneCopyDemand(scene: Scene, camera: Camera): number {
  const clamp = sceneWaterQualityDeviceClamp(scene);
  const refraction = refractionDemand(clamp), screenSpace = screenSpaceDemand(clamp);
  if (!refraction && !screenSpace) return 0;
  const engine = scene.getEngine();
  if (!engine.getCaps().textureHalfFloatRender) return 0;
  if (!sceneWaterSamplesSceneCopy(scene, refraction, screenSpace)) return 0;
  if (clearsDepthBetweenGroups(scene)) return 0;
  if (!sampleableOutput(camera) && !(scene.autoClear && scene.autoClearDepthAndStencil)) return 0;
  const scale = clamp.quality.refractionScale;
  const target = camera.outputRenderTarget;
  const width = target ? target.getRenderWidth() : engine.getRenderWidth(true);
  const height = target ? target.getRenderHeight() : engine.getRenderHeight(true);
  if (copyDimension(width, scale) < 1 || copyDimension(height, scale) < 1) return 0;
  return scale;
}

/**
 * The copy scale a view's graph plans, or 0 when no scene copy is admitted:
 * `waterSceneCopyDemand` on Forward lighting (a clustered target rejects the
 * copy; the graph already re-plans when that target changes).
 */
export function waterSceneCopyScale(scene: Scene, camera: Camera): number {
  const scale = waterSceneCopyDemand(scene, camera);
  return scale > 0 && clusteredLightTarget(scene, camera) ? 0 : scale;
}

/** Copy taps per axis: every source texel a downsampled texel covers at integer ratios (4×4 at 0.25). */
function copyTaps(scale: number): number {
  return scale >= 1 ? 1 : Math.min(4, Math.ceil(1 / scale - 1e-6));
}

/** Whether any sub-material of `mesh` draws in the transparent queue (RenderingGroup.dispatch's test). */
function blendsForMesh(mesh: AbstractMesh, scene: Scene): boolean {
  const material = mesh.material ?? scene.defaultMaterial;
  if (material instanceof MultiMaterial) {
    const subMaterials = material.subMaterials;
    for (let index = 0; index < subMaterials.length; index += 1)
      if (subMaterials[index]?.needAlphaBlendingForMesh(mesh)) return true;
    return false;
  }
  return material.needAlphaBlendingForMesh(mesh);
}

/** Whether `mesh` is among the first `count` entries of `list`. */
function listed(list: readonly AbstractMesh[], count: number, mesh: AbstractMesh): boolean {
  for (let index = 0; index < count; index += 1) if (list[index] === mesh) return true;
  return false;
}

function registerWaterSceneCopyShaders(): void {
  ShaderStore.ShadersStore[`${WATER_SCENE_COPY_SHADER}PixelShader`] = `
varying vec2 vUV;
uniform sampler2D sceneColor;
uniform sampler2D sceneDepth;
uniform vec2 copyTexel;
uniform mat4 inverseProjection;
uniform vec2 depthRange;
uniform float reverseDepth;
uniform float decodeSrgb;
#include<helperFunctions>
float slateNearer(float a, float b) { return reverseDepth > 0.5 ? max(a, b) : min(a, b); }
// Decode each tap before averaging: display colour must not be averaged in sRGB.
vec3 slateSceneColor(vec2 uv) {
  vec3 c = texture2D(sceneColor, uv).rgb;
  return decodeSrgb > 0.5 ? toLinearSpace(c) : c;
}
void main(void) {
  // SLATE_COPY_TAPS² taps spread evenly over this texel's footprint: at integer ratios, the
  // centre of every source texel it covers, so even a one-texel occluder keeps its depth.
  vec3 rgb = vec3(0.0);
  float raw = reverseDepth > 0.5 ? 0.0 : 1.0;
  for (int y = 0; y < SLATE_COPY_TAPS; y++) {
    for (int x = 0; x < SLATE_COPY_TAPS; x++) {
      vec2 uv = vUV + ((vec2(float(x), float(y)) + 0.5) / float(SLATE_COPY_TAPS) - 0.5) * copyTexel;
      rgb += slateSceneColor(uv);
      raw = slateNearer(raw, texture2D(sceneDepth, uv).r);
    }
  }
  rgb /= float(SLATE_COPY_TAPS * SLATE_COPY_TAPS);
  float sky = reverseDepth > 0.5 ? step(raw, 0.0) : step(1.0, raw);
  vec4 view = inverseProjection * vec4(vUV * 2.0 - 1.0, raw * depthRange.x + depthRange.y, 1.0);
  float w = abs(view.w) > 1e-8 ? view.w : 1e-8;
  // Positive distance along the view axis for either handedness.
  float viewZ = clamp(abs(view.z / w), 0.0, ${WATER_SCENE_COPY_SKY_DEPTH}.0);
  gl_FragColor = vec4(min(rgb, vec3(${WATER_SCENE_COPY_SKY_DEPTH}.0)), mix(viewZ, ${WATER_SCENE_COPY_SKY_DEPTH}.0, sky));
}
`;
  ShaderStore.ShadersStoreWGSL[`${WATER_SCENE_COPY_SHADER}PixelShader`] = `
varying vUV: vec2f;
var sceneColorSampler: sampler;
var sceneColor: texture_2d<f32>;
var sceneDepthSampler: sampler;
var sceneDepth: texture_2d<f32>;
uniform copyTexel: vec2f;
uniform inverseProjection: mat4x4f;
uniform depthRange: vec2f;
uniform reverseDepth: f32;
uniform decodeSrgb: f32;
#include<helperFunctions>
fn slateNearer(a: f32, b: f32) -> f32 { return select(min(a, b), max(a, b), uniforms.reverseDepth > 0.5); }
fn slateSceneColor(uv: vec2f) -> vec3f {
  let c = textureSampleLevel(sceneColor, sceneColorSampler, uv, 0.0).rgb;
  return select(c, toLinearSpaceVec3(c), uniforms.decodeSrgb > 0.5);
}
fn slateSceneDepth(uv: vec2f) -> f32 { return textureSampleLevel(sceneDepth, sceneDepthSampler, uv, 0.0).r; }
@fragment
fn main(input: FragmentInputs) -> FragmentOutputs {
  let uv = fragmentInputs.vUV;
  let taps = f32(SLATE_COPY_TAPS);
  var rgb = vec3f(0.0);
  var raw: f32 = select(1.0, 0.0, uniforms.reverseDepth > 0.5);
  for (var y: i32 = 0; y < SLATE_COPY_TAPS; y++) {
    for (var x: i32 = 0; x < SLATE_COPY_TAPS; x++) {
      let tap = uv + ((vec2f(f32(x), f32(y)) + 0.5) / taps - 0.5) * uniforms.copyTexel;
      rgb += slateSceneColor(tap);
      raw = slateNearer(raw, slateSceneDepth(tap));
    }
  }
  rgb = rgb / (taps * taps);
  let sky = select(step(1.0, raw), step(raw, 0.0), uniforms.reverseDepth > 0.5);
  let view = uniforms.inverseProjection * vec4f(uv * 2.0 - 1.0, raw * uniforms.depthRange.x + uniforms.depthRange.y, 1.0);
  let w = select(1e-8, view.w, abs(view.w) > 1e-8);
  let viewZ = clamp(abs(view.z / w), 0.0, ${WATER_SCENE_COPY_SKY_DEPTH}.0);
  fragmentOutputs.color = vec4f(min(rgb, vec3f(${WATER_SCENE_COPY_SKY_DEPTH}.0)), mix(viewZ, ${WATER_SCENE_COPY_SKY_DEPTH}.0, sky));
}
`;
}

/** A target the split plans, relative to the view's output size. */
type TargetSpec = { name: string; format: number; type: number; scale: number };

/**
 * The packed copy: one pass and one target. A direct FrameGraphTask with an
 * empty disabled pass, so a disabled copy costs nothing (a disabled
 * FrameGraphPostProcessTask would still copy its source).
 */
class WaterSceneCopyTask extends FrameGraphTask {
  camera!: Camera;
  readonly outputTexture: FrameGraphTextureHandle;
  /** Copy draws actually executed. */
  draws = 0;
  private readonly wrapper: EffectWrapper;
  private readonly inverseProjection = Matrix.Identity();
  /** One copy texel in uv, refreshed each time the graph records (a resize re-records). */
  private texelX = 0;
  private texelY = 0;
  private readonly sourceColor: FrameGraphTextureHandle;
  private readonly sourceDepth: FrameGraphTextureHandle;
  private retirement: OwnedEffectRetirement | undefined;

  constructor(
    name: string,
    graph: FrameGraph,
    sourceColor: FrameGraphTextureHandle,
    sourceDepth: FrameGraphTextureHandle,
    output: FrameGraphTextureHandle,
    taps: number,
  ) {
    super(name, graph);
    this.sourceColor = sourceColor;
    this.sourceDepth = sourceDepth;
    this.outputTexture = output;
    registerWaterSceneCopyShaders();
    this.wrapper = new EffectWrapper({
      name, engine: graph.engine, useShaderStore: true, fragmentShader: WATER_SCENE_COPY_SHADER,
      uniformNames: ["copyTexel", "inverseProjection", "depthRange", "reverseDepth", "decodeSrgb"],
      samplerNames: ["sceneColor", "sceneDepth"],
      defines: `#define SLATE_COPY_TAPS ${taps}`,
      shaderLanguage: graph.engine.isWebGPU ? ShaderLanguage.WGSL : ShaderLanguage.GLSL,
    });
  }

  override getClassName(): string { return "WaterSceneCopyTask"; }

  override isReady(): boolean { return this.wrapper.isReady(); }

  override record(): void {
    const graph = this._frameGraph;
    const size = graph.textureManager.getTextureAbsoluteDimensions(this.outputTexture);
    this.texelX = 1 / size.width;
    this.texelY = 1 / size.height;
    const pass = graph.addRenderPass(this.name);
    pass.setRenderTarget(this.outputTexture);
    pass.addDependencies([this.sourceColor, this.sourceDepth]);
    pass.setExecuteFunc((context) => {
      // Depth is unfilterable on WebGPU; colour taps sit on texel centres at integer ratios.
      context.setTextureSamplingMode(this.sourceDepth, Constants.TEXTURE_NEAREST_SAMPLINGMODE);
      const engine = graph.engine;
      const effect = this.wrapper.effect;
      const drawn = context.applyFullScreenEffect(this.wrapper.drawWrapper, () => {
        // FrameGraph binds the DrawWrapper directly; the postprocess vertex shader still needs its scale.
        effect.setFloat2("scale", 1, 1);
        effect.setFloat2("copyTexel", this.texelX, this.texelY);
        this.camera.getProjectionMatrix().invertToRef(this.inverseProjection);
        effect.setMatrix("inverseProjection", this.inverseProjection);
        effect.setFloat2("depthRange", engine.isNDCHalfZRange ? 1 : 2, engine.isNDCHalfZRange ? 0 : -1);
        effect.setFloat("reverseDepth", engine.useReverseDepthBuffer ? 1 : 0);
        // Scene Linear colour is already linear; Legacy Display and CEL are exact sRGB.
        effect.setFloat("decodeSrgb", graph.scene.imageProcessingConfiguration.applyByPostProcess ? 0 : 1);
        context.bindTextureHandle(effect, "sceneColor", this.sourceColor);
        context.bindTextureHandle(effect, "sceneDepth", this.sourceDepth);
      });
      if (drawn) this.draws += 1;
      // Water samples the copy with distortion: bilinear colour (depth by texel-centre fetch).
      context.setTextureSamplingMode(this.outputTexture, Constants.TEXTURE_BILINEAR_SAMPLINGMODE);
    });
    const disabled = graph.addRenderPass(`${this.name}_disabled`, true);
    disabled.setRenderTarget(this.outputTexture);
    disabled.setExecuteFunc(() => {});
  }

  override dispose(): void {
    this.retirement ??= retireOwnedEffect(this.wrapper.effect, () => this.wrapper.dispose());
    super.dispose();
  }

  whenDisposed(): Promise<void> { return this.retirement?.completion ?? Promise.resolve(); }
  whenReleased(): Promise<void> { return this.retirement?.released ?? Promise.resolve(); }
}

/** Runs once per frame after culling: switches the split on visible copy-sampling water. */
class WaterSplitTask extends FrameGraphTask {
  private readonly split: () => void;
  constructor(name: string, graph: FrameGraph, split: () => void) {
    super(name, graph);
    this.split = split;
  }
  override getClassName(): string { return "WaterSplitTask"; }
  override record(): void {
    this._frameGraph.addPass(this.name).setExecuteFunc(this.split);
  }
}

/**
 * Draws through another task's ObjectRenderer into other targets. The two never
 * draw in the same frame, so one render pass id, one set of draw wrappers and
 * one readiness probe serve both: the owner probes the same list on the same
 * pass, and its shadow toggles, registered on the shared renderer, run for
 * these draws too.
 */
class SharedObjectRendererTask extends FrameGraphObjectRendererTask {
  constructor(name: string, graph: FrameGraph, owner: FrameGraphObjectRendererTask) {
    super(name, graph, graph.scene, undefined, owner.objectRenderer);
  }
  // The shared renderer keeps its owner's name for diagnostics and inspector lookups.
  override get name(): string { return this._name; }
  override set name(value: string) { this._name = value; }
  protected override _setLightsForShadow(): void {}
  override isReady(): boolean { return true; }
}

export interface WaterSceneCopyGraphOptions {
  frameGraph: FrameGraph;
  camera: Camera;
  /** Device-effective copy scale from waterSceneCopyScale (> 0). */
  scale: number;
  /** Full output size. */
  width: number;
  height: number;
  /** The view's "Forward clear", "Forward cull" and main "Forward objects" tasks. */
  clear: FrameGraphClearTextureTask;
  cull: FrameGraphCullObjectsTask;
  objects: ManagedShadowObjectRendererTask;
  /**
   * Sampleable colour/depth the main object pass draws (an effect chain's
   * scene targets or an imported render-target output). Absent when it draws
   * the backbuffer (or a stencil depth): the split then draws into an own
   * colour + depth pair and copies its colour to `output`.
   */
  scene?: { color: FrameGraphTextureHandle; depth: FrameGraphTextureHandle };
  /** The view's output colour, written by the own pair's final copy. */
  output: { color: FrameGraphTextureHandle; texture: boolean };
}

/**
 * Opaque/transparent split with one packed scene copy between, owned by the
 * enclosing view graph:
 *
 *   Forward clear → Forward cull → Water split → Forward objects (opaque only
 *   while copy-sampling water is visible) → Water scene copy → Forward
 *   transparent
 *
 * With no sampleable output the own-pair form keeps the direct path for
 * frames without such water ("Forward clear"/"Forward objects" draw the
 * output as before) and swaps to Water clear → Water opaque (Forward
 * objects' renderer) → Water scene copy → Forward transparent → Water output
 * on frames with it. The split then decides before the output clear runs:
 * Forward cull → Water split → Forward clear. Either way a frame without
 * visible copy-sampling water runs only empty disabled passes.
 */
export class WaterSceneCopyGraph {
  /** Runs after "Forward cull": before "Forward clear" when `splitsClear`, else just before the object pass. */
  readonly split: FrameGraphTask;
  /** The split also switches "Forward clear", so it must run before it (the own-pair form). */
  readonly splitsClear: boolean;
  /** Insert immediately after the main object pass. */
  readonly afterObjects: FrameGraphTask[] = [];
  /** Main-view passes, besides "Forward objects", that must receive the admitted shadow maps. */
  readonly shadowReceivers: ManagedShadowObjectRendererTask[] = [];
  readonly transparent: ManagedShadowObjectRendererTask;
  readonly ownTargets: boolean;
  readonly scale: number;
  private readonly scene: Scene;
  private readonly graph: FrameGraph;
  private readonly copy: WaterSceneCopyTask;
  private readonly sceneClear: FrameGraphClearTextureTask;
  private readonly cull: FrameGraphCullObjectsTask;
  private readonly objects: ManagedShadowObjectRendererTask;
  private readonly ownClear?: FrameGraphClearTextureTask;
  private readonly ownOpaque?: SharedObjectRendererTask;
  /** Targets this split allocates: the copy, then any own colour and depth. */
  private readonly targets: { handle: FrameGraphTextureHandle; spec: TargetSpec }[] = [];
  /** Targets sized relative to the backbuffer, so an output resize rebuilds this graph in place. */
  private readonly followsBackbuffer: boolean;
  /** Tasks this owner disposes (the split's own, never the view's). */
  private readonly owned: FrameGraphTask[] = [];
  /** Tasks enabled only on frames with visible copy-sampling water. */
  private readonly waterPasses: FrameGraphTask[] = [];
  private readonly refraction: boolean;
  private readonly screenSpace: boolean;
  private lease: ManagedRenderLease;
  /** Leases of targets a resize replaced: released once the rebuilt targets are committed. */
  private readonly replacedLeases: ManagedRenderLease[] = [];
  private readonly leaseReleases: Promise<void>[] = [];
  private width: number;
  private height: number;
  private readonly entry: RegistryEntry;
  private readonly passId: number;
  private readonly transparentMeshes: AbstractMesh[] = [];
  private readonly noParticles: IParticleSystem[] = [];
  private readonly transparentList: FrameGraphObjectList;
  private readonly probeMeshes: AbstractMesh[] = [];
  private readonly probeList: FrameGraphObjectList = { meshes: null, particleSystems: null };
  private probing: FrameGraphObjectList | undefined;
  private visible: boolean | undefined;
  private frames = 0;
  private visibleFrames = 0;
  private committed = false;
  private tasksDisposed = false;
  private released: Promise<void> | undefined;

  /** Reserve and plan the copy, or undefined (with a warning) when the shared budget refuses it. */
  static create(options: WaterSceneCopyGraphOptions): WaterSceneCopyGraph | undefined {
    const engine = options.frameGraph.engine;
    const specs = targetSpecs(options.frameGraph.scene, engine, options.scale, !options.scene);
    const followsBackbuffer = !options.scene && !options.output.texture;
    const lease = beginManagedRenderAllocation(engine, plannedBytes(specs, options.width, options.height, followsBackbuffer));
    if (!lease) {
      console.warn("Water scene copy disabled: shared Engine render-target budget is exhausted.");
      return undefined;
    }
    try {
      return new WaterSceneCopyGraph(options, lease, specs, followsBackbuffer);
    } catch (error) {
      lease.release();
      throw error;
    }
  }

  private constructor(options: WaterSceneCopyGraphOptions, lease: ManagedRenderLease, specs: TargetSpec[], followsBackbuffer: boolean) {
    const { frameGraph: graph, camera } = options;
    const scene = graph.scene;
    this.scene = scene;
    this.graph = graph;
    this.lease = lease;
    this.scale = options.scale;
    this.width = options.width;
    this.height = options.height;
    this.followsBackbuffer = followsBackbuffer;
    this.sceneClear = options.clear;
    this.cull = options.cull;
    this.objects = options.objects;
    this.ownTargets = !options.scene;
    // The plan belongs to one Water quality revision; a change re-plans the graph.
    const clamp = sceneWaterQualityDeviceClamp(scene);
    this.refraction = refractionDemand(clamp);
    this.screenSpace = screenSpaceDemand(clamp);
    this.transparentList = { meshes: this.transparentMeshes, particleSystems: this.noParticles };
    const textures = graph.textureManager;
    const handles = specs.map((spec) => {
      const handle = textures.createRenderTargetTexture(spec.name, {
        size: followsBackbuffer
          ? { width: spec.scale * 100, height: spec.scale * 100 }
          : { width: Math.max(1, Math.round(options.width * spec.scale)), height: Math.max(1, Math.round(options.height * spec.scale)) },
        sizeIsPercentage: followsBackbuffer,
        options: { createMipMaps: false, samples: 1, types: [spec.type], formats: [spec.format], useSRGBBuffers: [false] },
      });
      this.targets.push({ handle, spec });
      return handle;
    });
    let source = options.scene;
    let opaque: FrameGraphObjectRendererTask = this.objects;
    if (!source) {
      source = { color: handles[1]!, depth: handles[2]! };
      this.ownClear = new FrameGraphClearTextureTask("Water clear", graph);
      this.ownClear.targetTexture = source.color;
      this.ownClear.depthTexture = source.depth;
      // Forward objects' own renderer: one pass id and one readiness probe for both paths.
      this.ownOpaque = new SharedObjectRendererTask("Water opaque", graph, this.objects);
      this.ownOpaque.targetTexture = this.ownClear.outputTexture;
      this.ownOpaque.depthTexture = this.ownClear.outputDepthTexture;
      this.ownOpaque.objectList = this.cull.outputObjectList;
      opaque = this.ownOpaque;
      this.owned.push(this.ownClear, this.ownOpaque);
    }
    this.copy = new WaterSceneCopyTask("Water scene copy", graph, source.color, source.depth, handles[0]!, copyTaps(options.scale));
    this.owned.push(this.copy);
    const transparent = new ManagedShadowObjectRendererTask("Forward transparent", graph, scene, { doNotChangeAspectRatio: false });
    this.transparent = transparent;
    this.owned.push(transparent);
    transparent.mainView = true;
    transparent.targetTexture = opaque.outputTexture;
    transparent.depthTexture = opaque.outputDepthTexture;
    transparent.renderDepthOnlyMeshes = false;
    transparent.renderOpaqueMeshes = false;
    transparent.renderAlphaTestMeshes = false;
    transparent.enableBoundingBoxRendering = false;
    // The opaque pass already wrote this frame's depth; any group clear here would wipe it.
    for (let group = RenderingManager.MIN_RENDERINGGROUPS; group < RenderingManager.MAX_RENDERINGGROUPS; group += 1)
      transparent.objectRenderer.setRenderingAutoClearDepthStencil(group, false);
    transparent.objectList = this.transparentList;
    // Keep the copy alive (unaliased) through the pass that samples it.
    transparent.setOwnedTextureDependencies("water", [this.copy.outputTexture]);
    this.shadowReceivers.push(transparent);
    this.split = new WaterSplitTask("Water split", graph, () => this.splitFrame());
    this.splitsClear = this.ownTargets;
    this.owned.push(this.split);
    if (this.ownClear && this.ownOpaque) {
      const output = options.output;
      let copyOut: FrameGraphTask;
      if (output.texture) {
        const task = new FrameGraphCopyToTextureTask("Water output", graph);
        task.sourceTexture = source.color;
        task.targetTexture = output.color;
        copyOut = task;
      } else {
        const task = new FrameGraphCopyToBackbufferColorTask("Water output", graph);
        task.sourceTexture = source.color;
        copyOut = task;
      }
      this.owned.push(copyOut);
      this.afterObjects.push(this.ownClear, this.ownOpaque, this.copy, transparent, copyOut);
      this.waterPasses.push(this.ownClear, this.ownOpaque, this.copy, transparent, copyOut);
    } else {
      this.afterObjects.push(this.copy, transparent);
      this.waterPasses.push(this.copy, transparent);
    }
    this.setCamera(camera);
    this.apply(false);
    // Registered before the first readiness probe: material variants for this
    // pass settle with the copy present, so no later dirtying is needed.
    this.passId = transparent.objectRenderer.renderPassId;
    const placeholder = new ThinTexture(null);
    placeholder.wrapU = placeholder.wrapV = Texture.CLAMP_ADDRESSMODE;
    this.entry = { texture: placeholder, invSize: [1 / options.width, 1 / options.height], scale: options.scale, revision: ++revisions };
    let registry = registries.get(scene);
    if (!registry) { registry = new Map(); registries.set(scene, registry); }
    registry.set(this.passId, this.entry);
  }

  /** The registered "Forward transparent" render pass id. */
  get renderPassId(): number { return this.passId; }

  setCamera(camera: Camera): void {
    this.copy.camera = camera;
    this.transparent.camera = camera;
    if (this.ownOpaque) this.ownOpaque.camera = camera;
  }

  /** Mirror the view's clear settings; called with the view's own syncSceneInputs. */
  syncInputs(): void {
    if (!this.ownClear) return;
    this.ownClear.color = this.sceneClear.color;
    this.ownClear.clearColor = this.sceneClear.clearColor;
    this.ownClear.clearDepth = this.sceneClear.clearDepth;
    this.ownClear.clearStencil = this.sceneClear.clearStencil;
  }

  /**
   * Follow a backbuffer resize in place, before the view graph rebuilds: the
   * targets re-size with the backbuffer, and every task and render pass id is
   * kept. Reserves the resized targets while the current ones stay charged;
   * false (with a warning) when the budget refuses them or the targets cannot
   * follow this output, and the view must then re-plan.
   */
  resize(width: number, height: number): boolean {
    if (!this.followsBackbuffer || this.tasksDisposed) return false;
    const specs = this.targets.map((target) => target.spec);
    const lease = beginManagedRenderAllocation(this.graph.engine, plannedBytes(specs, width, height, true));
    if (!lease) {
      console.warn("Water scene copy resize refused: shared Engine render-target budget is exhausted.");
      return false;
    }
    this.replacedLeases.push(this.lease);
    this.lease = lease;
    this.committed = false;
    this.width = width;
    this.height = height;
    return true;
  }

  /** Probe with every current candidate: the transparent pass only with alpha-blended ones. */
  beginProbe(all: FrameGraphObjectList): void {
    if (this.probing) return;
    this.probing = this.transparent.objectList;
    const meshes = all.meshes ?? this.scene.meshes;
    const probe = this.probeMeshes;
    let count = 0;
    for (let index = 0; index < meshes.length; index += 1) {
      const mesh = meshes[index]!;
      if (blendsForMesh(mesh, this.scene)) probe[count++] = mesh;
    }
    probe.length = count;
    this.probeList.meshes = probe;
    this.probeList.particleSystems = all.particleSystems ?? this.noParticles;
    this.transparent.objectList = this.probeList;
  }

  endProbe(): void {
    const saved = this.probing;
    if (!saved) return;
    this.probing = undefined;
    this.transparent.objectList = saved;
    this.probeMeshes.length = 0;
    this.probeList.meshes = null;
  }

  /** Per frame, after culling: no allocation, and only flag writes when visibility changes. */
  private splitFrame(): void {
    const culled = this.cull.outputObjectList;
    const meshes = culled.meshes ?? this.scene.meshes;
    let visible = false;
    for (let index = 0; index < meshes.length; index += 1) {
      if (waterMeshSamplesSceneCopy(meshes[index]!, this.refraction, this.screenSpace)) { visible = true; break; }
    }
    this.frames += 1;
    const list = this.transparentMeshes;
    if (visible) {
      this.visibleFrames += 1;
      let count = 0;
      for (let index = 0; index < meshes.length; index += 1) {
        const mesh = meshes[index]!;
        if (blendsForMesh(mesh, this.scene)) list[count++] = mesh;
      }
      // Babylon draws a mesh-emitted particle system only while its emitter is
      // in the pass's list (RenderingGroup._renderParticles), so add the culled
      // emitters exactly as the direct path's full culled list holds them.
      const systems = culled.particleSystems ?? this.scene.particleSystems;
      for (let index = 0; index < systems.length; index += 1) {
        const system = systems[index]!;
        const emitter = system.emitter;
        if (!emitter || !("position" in emitter) || !system.isStarted()) continue;
        if (listed(list, count, emitter) || meshes.indexOf(emitter) === -1) continue;
        list[count++] = emitter;
      }
      list.length = count;
      this.transparentList.particleSystems = systems;
    } else if (list.length) {
      // Release references held for a pass that will not run.
      list.length = 0;
    }
    this.apply(visible);
  }

  private apply(visible: boolean): void {
    if (this.visible === visible) return;
    this.visible = visible;
    for (const task of this.waterPasses) task.disabled = !visible;
    // The opaque pass leaves transparents, particles and sprites to the transparent pass.
    this.objects.renderTransparentMeshes = !visible;
    this.objects.renderParticles = !visible;
    this.objects.renderSprites = !visible;
    if (this.ownTargets) {
      // The direct path draws the output exactly as before on frames without such water.
      this.sceneClear.disabled = visible;
      this.objects.disabled = visible;
    }
  }

  /** Attach the built copy to the registry and commit the reservation; after each build. */
  reconcile(): void {
    const textures = this.graph.textureManager;
    const copy = textures.getTextureFromHandle(this.copy.outputTexture);
    if (!copy) throw new Error("Water scene copy target is not allocated.");
    const invX = 1 / this.width, invY = 1 / this.height;
    if (this.entry.texture.getInternalTexture() !== copy || this.entry.invSize[0] !== invX || this.entry.invSize[1] !== invY) {
      const texture = new ThinTexture(copy);
      texture.wrapU = texture.wrapV = Texture.CLAMP_ADDRESSMODE;
      this.entry.texture = texture;
      this.entry.invSize = [invX, invY];
      this.entry.revision = ++revisions;
    }
    if (this.committed) return;
    const resources = this.targets.map(({ handle }) => {
      const texture = textures.getTextureFromHandle(handle);
      if (!texture) throw new Error("Water scene copy target is not allocated.");
      return managedRenderTextureResource(texture, "water", { samples: 1, allocatedMipLevels: 1 });
    });
    this.lease.commit(resources);
    this.committed = true;
    // The build disposed the replaced targets; WebGPU destroys them at the end of its frame.
    for (const replaced of this.replacedLeases.splice(0))
      this.leaseReleases.push(releaseManagedRenderLeaseAfterDisposal(this.graph.engine, replaced));
  }

  /** Planning and per-frame work, for diagnostics, tests and proofs. */
  diagnostics(): { ownTargets: boolean; scale: number; renderPassId: number; frames: number; visibleFrames: number; copies: number } {
    return {
      ownTargets: this.ownTargets, scale: this.scale, renderPassId: this.passId,
      frames: this.frames, visibleFrames: this.visibleFrames, copies: this.copy.draws,
    };
  }

  /** Actual disposal (graph release): unregisters the pass before its tasks go. */
  disposeTasks(): void {
    if (this.tasksDisposed) return;
    this.tasksDisposed = true;
    const registry = registries.get(this.scene);
    if (registry?.get(this.passId) === this.entry) registry.delete(this.passId);
    // Never dispose the wrapper: it borrows the graph's texture reference.
    this.entry.texture = new ThinTexture(null);
    const errors: unknown[] = [];
    for (const task of this.owned) {
      try { task.dispose(); } catch (error) { errors.push(error); }
    }
    if (errors.length) throw new AggregateError(errors, "Water scene copy task disposal failed.");
  }

  whenDisposed(): Promise<void> {
    if (!this.tasksDisposed) return Promise.reject(new Error("Dispose water scene copy tasks before awaiting their retirement."));
    return this.copy.whenDisposed();
  }

  whenReleased(): Promise<void> {
    if (!this.tasksDisposed) return Promise.reject(new Error("Dispose water scene copy tasks before awaiting their release."));
    return this.copy.whenReleased();
  }

  /** Release the reservations once the graph (and its targets) is disposed. */
  releaseAfterGraphDisposal(): Promise<void> {
    if (!this.tasksDisposed) throw new Error("Dispose water scene copy tasks before releasing their graph lease.");
    return (this.released ??= this.copy.whenReleased().then(async () => {
      const engine = this.graph.engine;
      const leases = [...this.replacedLeases.splice(0), this.lease];
      await Promise.all([...this.leaseReleases, ...leases.map((lease) => releaseManagedRenderLeaseAfterDisposal(engine, lease))]);
    }));
  }
}

/** Without an effect chain the materials write display colour; Scene Linear keeps half-float. */
function ownColorType(scene: Scene): number {
  return scene.imageProcessingConfiguration.applyByPostProcess ? Constants.TEXTURETYPE_HALF_FLOAT : Constants.TEXTURETYPE_UNSIGNED_BYTE;
}

/**
 * The split's targets. On WebGPU the own pair matches the swap chain's colour
 * and the main pass's depth format, so its draws reuse the render pipelines
 * the direct path already created (pipelines are keyed by attachment formats):
 * water coming into view creates none.
 */
function targetSpecs(scene: Scene, engine: AbstractEngine, scale: number, own: boolean): TargetSpec[] {
  const specs: TargetSpec[] = [{ name: "Water scene copy", format: Constants.TEXTUREFORMAT_RGBA, type: Constants.TEXTURETYPE_HALF_FLOAT, scale }];
  if (!own) return specs;
  const colorType = ownColorType(scene);
  const swapChain = engine.isWebGPU ? (engine as unknown as { _options?: { swapChainFormat?: string } })._options?.swapChainFormat : undefined;
  const bgra = swapChain === "bgra8unorm" && colorType === Constants.TEXTURETYPE_UNSIGNED_BYTE;
  const stencilDepth = engine.isWebGPU && engine.isStencilEnable;
  specs.push(
    { name: "Water scene color", format: bgra ? Constants.TEXTUREFORMAT_BGRA : Constants.TEXTUREFORMAT_RGBA, type: colorType, scale: 1 },
    stencilDepth
      ? { name: "Water scene Z", format: Constants.TEXTUREFORMAT_DEPTH24_STENCIL8, type: Constants.TEXTURETYPE_FLOAT, scale: 1 }
      : { name: "Water scene Z", format: Constants.TEXTUREFORMAT_DEPTH32_FLOAT, type: Constants.TEXTURETYPE_FLOAT, scale: 1 },
  );
  return specs;
}

/** The ledger charge for `specs` at an output size, as FrameGraph will size them. */
function plannedBytes(specs: readonly TargetSpec[], width: number, height: number, followsBackbuffer: boolean): number {
  let bytes = 0;
  for (const spec of specs) {
    bytes += renderTargetAllocationBytes({
      width: followsBackbuffer ? copyDimension(width, spec.scale) : Math.max(1, Math.round(width * spec.scale)),
      height: followsBackbuffer ? copyDimension(height, spec.scale) : Math.max(1, Math.round(height * spec.scale)),
      format: spec.format, type: spec.type,
    });
  }
  return bytes;
}
