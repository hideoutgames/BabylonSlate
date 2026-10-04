import {
  Constants, EffectWrapper, Matrix, MultiMaterial, RenderingManager, ShaderLanguage, Texture, ThinTexture,
  type AbstractMesh, type Camera, type FrameGraphObjectList, type IParticleSystem, type Scene,
} from "@babylonjs/core";
import { ShaderStore } from "@babylonjs/core/Engines/shaderStore";
import { FrameGraphTask } from "@babylonjs/core/FrameGraph/frameGraphTask";
import type { FrameGraph } from "@babylonjs/core/FrameGraph/frameGraph";
import type { FrameGraphTextureHandle } from "@babylonjs/core/FrameGraph/frameGraphTypes";
import type { FrameGraphCullObjectsTask } from "@babylonjs/core/FrameGraph/Tasks/Misc/cullObjectsTask";
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
import { managedRenderTextureResource } from "./render-target-resource-cost";
import { sceneBuiltInWaterCount, waterMeshSamplesSceneCopy } from "./water-mesh";
import type { WaterQualityDeviceClamp } from "./water-quality-device";

/** Linear view depth stored for sky / far-plane pixels (the sentinel volumetric-shader also uses). */
export const WATER_SCENE_COPY_SKY_DEPTH = 65000;
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
  /** Process-unique; changes whenever `texture` is (re)attached. */
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

/**
 * The copy scale this view's graph plans, or 0 when no scene copy is admitted:
 * device-effective Refraction or a screen-space reflection march, a
 * built-in water surface in the scene, half-float render targets, Forward
 * lighting, no per-group depth clear in groups 1–3, and (when the output itself
 * cannot be sampled and an own colour/depth pair stands in) a cleared frame.
 * Cheap and allocation-free; the graph re-plans when the value changes.
 */
export function waterSceneCopyScale(scene: Scene, camera: Camera): number {
  const clamp = sceneWaterQualityDeviceClamp(scene);
  if (!refractionDemand(clamp) && !screenSpaceDemand(clamp)) return 0;
  if (!scene.getEngine().getCaps().textureHalfFloatRender) return 0;
  if (sceneBuiltInWaterCount(scene) === 0) return 0;
  if (clearsDepthBetweenGroups(scene)) return 0;
  if (clusteredLightTarget(scene, camera)) return 0;
  if (!sampleableOutput(camera) && !(scene.autoClear && scene.autoClearDepthAndStencil)) return 0;
  return clamp.quality.refractionScale;
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

function registerWaterSceneCopyShaders(): void {
  ShaderStore.ShadersStore[`${WATER_SCENE_COPY_SHADER}PixelShader`] = `
varying vec2 vUV;
uniform sampler2D sceneColor;
uniform sampler2D sceneDepth;
uniform vec2 footprint;
uniform mat4 inverseProjection;
uniform vec2 depthRange;
uniform float reverseDepth;
uniform float decodeSrgb;
#include<helperFunctions>
float slateNearer(float a, float b) { return reverseDepth > 0.5 ? max(a, b) : min(a, b); }
void main(void) {
#ifdef SLATE_COPY_FOOTPRINT
  vec2 uvA = vUV - footprint;
  vec2 uvB = vUV + vec2(footprint.x, -footprint.y);
  vec2 uvC = vUV + vec2(-footprint.x, footprint.y);
  vec2 uvD = vUV + footprint;
  vec3 rgb = 0.25 * (texture2D(sceneColor, uvA).rgb + texture2D(sceneColor, uvB).rgb + texture2D(sceneColor, uvC).rgb + texture2D(sceneColor, uvD).rgb);
  float raw = slateNearer(slateNearer(texture2D(sceneDepth, uvA).r, texture2D(sceneDepth, uvB).r), slateNearer(texture2D(sceneDepth, uvC).r, texture2D(sceneDepth, uvD).r));
#else
  vec3 rgb = texture2D(sceneColor, vUV).rgb;
  float raw = texture2D(sceneDepth, vUV).r;
#endif
  if (decodeSrgb > 0.5) rgb = toLinearSpace(rgb);
  float sky = reverseDepth > 0.5 ? step(raw, 0.0) : step(1.0, raw);
  vec4 view = inverseProjection * vec4(vUV * 2.0 - 1.0, raw * depthRange.x + depthRange.y, 1.0);
  float w = abs(view.w) > 1e-8 ? view.w : 1e-8;
  float viewZ = clamp(view.z / w, 0.0, ${WATER_SCENE_COPY_SKY_DEPTH}.0);
  gl_FragColor = vec4(min(rgb, vec3(${WATER_SCENE_COPY_SKY_DEPTH}.0)), mix(viewZ, ${WATER_SCENE_COPY_SKY_DEPTH}.0, sky));
}
`;
  ShaderStore.ShadersStoreWGSL[`${WATER_SCENE_COPY_SHADER}PixelShader`] = `
varying vUV: vec2f;
var sceneColorSampler: sampler;
var sceneColor: texture_2d<f32>;
var sceneDepthSampler: sampler;
var sceneDepth: texture_2d<f32>;
uniform footprint: vec2f;
uniform inverseProjection: mat4x4f;
uniform depthRange: vec2f;
uniform reverseDepth: f32;
uniform decodeSrgb: f32;
#include<helperFunctions>
fn slateNearer(a: f32, b: f32) -> f32 { return select(min(a, b), max(a, b), uniforms.reverseDepth > 0.5); }
fn slateSceneColor(uv: vec2f) -> vec3f { return textureSampleLevel(sceneColor, sceneColorSampler, uv, 0.0).rgb; }
fn slateSceneDepth(uv: vec2f) -> f32 { return textureSampleLevel(sceneDepth, sceneDepthSampler, uv, 0.0).r; }
@fragment
fn main(input: FragmentInputs) -> FragmentOutputs {
  let uv = fragmentInputs.vUV;
#ifdef SLATE_COPY_FOOTPRINT
  let offset = uniforms.footprint;
  let uvA = uv - offset;
  let uvB = uv + vec2f(offset.x, -offset.y);
  let uvC = uv + vec2f(-offset.x, offset.y);
  let uvD = uv + offset;
  var rgb = 0.25 * (slateSceneColor(uvA) + slateSceneColor(uvB) + slateSceneColor(uvC) + slateSceneColor(uvD));
  let raw = slateNearer(slateNearer(slateSceneDepth(uvA), slateSceneDepth(uvB)), slateNearer(slateSceneDepth(uvC), slateSceneDepth(uvD)));
#else
  var rgb = slateSceneColor(uv);
  let raw = slateSceneDepth(uv);
#endif
  if (uniforms.decodeSrgb > 0.5) { rgb = toLinearSpaceVec3(rgb); }
  let sky = select(step(1.0, raw), step(raw, 0.0), uniforms.reverseDepth > 0.5);
  let view = uniforms.inverseProjection * vec4f(uv * 2.0 - 1.0, raw * uniforms.depthRange.x + uniforms.depthRange.y, 1.0);
  let w = select(1e-8, view.w, abs(view.w) > 1e-8);
  let viewZ = clamp(view.z / w, 0.0, ${WATER_SCENE_COPY_SKY_DEPTH}.0);
  fragmentOutputs.color = vec4f(min(rgb, vec3f(${WATER_SCENE_COPY_SKY_DEPTH}.0)), mix(viewZ, ${WATER_SCENE_COPY_SKY_DEPTH}.0, sky));
}
`;
}

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
  private readonly footprintX: number;
  private readonly footprintY: number;
  private retirement: OwnedEffectRetirement | undefined;

  constructor(
    name: string,
    graph: FrameGraph,
    private readonly sourceColor: FrameGraphTextureHandle,
    private readonly sourceDepth: FrameGraphTextureHandle,
    width: number,
    height: number,
    footprint: boolean,
  ) {
    super(name, graph);
    this.outputTexture = graph.textureManager.createRenderTargetTexture(name, {
      size: { width, height }, sizeIsPercentage: false,
      options: {
        createMipMaps: false, samples: 1, types: [Constants.TEXTURETYPE_HALF_FLOAT],
        formats: [Constants.TEXTUREFORMAT_RGBA], useSRGBBuffers: [false],
      },
    });
    // A quarter output texel each way: at half scale these are the centres of
    // the 2×2 source texels, so the taps ignore the source's sampling mode.
    this.footprintX = footprint ? 0.25 / width : 0;
    this.footprintY = footprint ? 0.25 / height : 0;
    registerWaterSceneCopyShaders();
    this.wrapper = new EffectWrapper({
      name, engine: graph.engine, useShaderStore: true, fragmentShader: WATER_SCENE_COPY_SHADER,
      uniformNames: ["footprint", "inverseProjection", "depthRange", "reverseDepth", "decodeSrgb"],
      samplerNames: ["sceneColor", "sceneDepth"],
      defines: footprint ? "#define SLATE_COPY_FOOTPRINT" : "",
      shaderLanguage: graph.engine.isWebGPU ? ShaderLanguage.WGSL : ShaderLanguage.GLSL,
    });
  }

  override getClassName(): string { return "WaterSceneCopyTask"; }

  override isReady(): boolean { return this.wrapper.isReady(); }

  override record(): void {
    const graph = this._frameGraph;
    const pass = graph.addRenderPass(this.name);
    pass.setRenderTarget(this.outputTexture);
    pass.addDependencies([this.sourceColor, this.sourceDepth]);
    pass.setExecuteFunc((context) => {
      // Depth is unfilterable on WebGPU; colour uses texel-centre taps and keeps its owner's mode.
      context.setTextureSamplingMode(this.sourceDepth, Constants.TEXTURE_NEAREST_SAMPLINGMODE);
      const engine = graph.engine;
      const effect = this.wrapper.effect;
      const drawn = context.applyFullScreenEffect(this.wrapper.drawWrapper, () => {
        // FrameGraph binds the DrawWrapper directly; the postprocess vertex shader still needs its scale.
        effect.setFloat2("scale", 1, 1);
        effect.setFloat2("footprint", this.footprintX, this.footprintY);
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
  constructor(name: string, graph: FrameGraph, private readonly split: () => void) {
    super(name, graph);
  }
  override getClassName(): string { return "WaterSplitTask"; }
  override record(): void {
    this._frameGraph.addPass(this.name).setExecuteFunc(this.split);
  }
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
   * colour + DEPTH32_FLOAT pair and copies its colour to `output`.
   */
  scene?: { color: FrameGraphTextureHandle; depth: FrameGraphTextureHandle };
  /** The view's output colour, written by the own pair's final copy. */
  output: { color: FrameGraphTextureHandle; texture: boolean };
}

/**
 * Opaque/transparent split with one packed scene copy between, owned by the
 * enclosing view graph:
 *
 *   Water split → Forward objects (opaque only while copy-sampling water is
 *   visible) → Water scene copy → Forward transparent
 *
 * With no sampleable output the own-pair form keeps the direct path for
 * frames without such water ("Forward clear"/"Forward objects" draw the
 * output as before) and swaps to Water clear → Water opaque → Water scene
 * copy → Forward transparent → Water output on frames with it. Either way a
 * frame without visible copy-sampling water runs only empty disabled passes.
 */
export class WaterSceneCopyGraph {
  /** Insert immediately before the main object pass. */
  readonly beforeObjects: FrameGraphTask[] = [];
  /** Insert immediately after the main object pass. */
  readonly afterObjects: FrameGraphTask[] = [];
  /** Main-view passes that must receive the admitted shadow maps. */
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
  private readonly ownOpaque?: ManagedShadowObjectRendererTask;
  private readonly ownOutput?: FrameGraphTask;
  private readonly ownHandles: FrameGraphTextureHandle[] = [];
  /** Tasks this owner disposes (the split's own, never the view's). */
  private readonly owned: FrameGraphTask[] = [];
  /** Tasks enabled only on frames with visible copy-sampling water. */
  private readonly waterPasses: FrameGraphTask[] = [];
  private readonly refraction: boolean;
  private readonly screenSpace: boolean;
  private readonly lease: ManagedRenderLease;
  private readonly entry: RegistryEntry;
  private readonly passId: number;
  private readonly transparentMeshes: AbstractMesh[] = [];
  private readonly noParticles: IParticleSystem[] = [];
  private readonly transparentList: FrameGraphObjectList;
  private readonly probeMeshes: AbstractMesh[] = [];
  private readonly probeList: FrameGraphObjectList = { meshes: null, particleSystems: null };
  private probing: { transparent: FrameGraphObjectList; opaque?: FrameGraphObjectList } | undefined;
  private visible: boolean | undefined;
  private frames = 0;
  private visibleFrames = 0;
  private committed = false;
  private tasksDisposed = false;
  private released: Promise<void> | undefined;

  /** Reserve and plan the copy, or undefined (with a warning) when the shared budget refuses it. */
  static create(options: WaterSceneCopyGraphOptions): WaterSceneCopyGraph | undefined {
    const { width, height, scale } = options;
    const copyWidth = Math.max(1, Math.round(width * scale));
    const copyHeight = Math.max(1, Math.round(height * scale));
    let bytes = copyWidth * copyHeight * 8;
    if (!options.scene) bytes += width * height * (ownColorType(options.frameGraph.scene) === Constants.TEXTURETYPE_HALF_FLOAT ? 8 : 4) + width * height * 4;
    const lease = beginManagedRenderAllocation(options.frameGraph.engine, bytes);
    if (!lease) {
      console.warn("Water scene copy disabled: shared Engine render-target budget is exhausted.");
      return undefined;
    }
    try {
      return new WaterSceneCopyGraph(options, lease, copyWidth, copyHeight);
    } catch (error) {
      lease.release();
      throw error;
    }
  }

  private constructor(options: WaterSceneCopyGraphOptions, lease: ManagedRenderLease, copyWidth: number, copyHeight: number) {
    const { frameGraph: graph, camera } = options;
    const scene = graph.scene;
    this.scene = scene;
    this.graph = graph;
    this.lease = lease;
    this.scale = options.scale;
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
    let source = options.scene;
    let opaque: ManagedShadowObjectRendererTask = this.objects;
    if (!source) {
      const create = (name: string, format: number, type: number) => {
        const handle = textures.createRenderTargetTexture(name, {
          size: { width: options.width, height: options.height }, sizeIsPercentage: false,
          options: { createMipMaps: false, samples: 1, types: [type], formats: [format], useSRGBBuffers: [false] },
        });
        this.ownHandles.push(handle);
        return handle;
      };
      source = {
        color: create("Water scene color", Constants.TEXTUREFORMAT_RGBA, ownColorType(scene)),
        depth: create("Water scene Z", Constants.TEXTUREFORMAT_DEPTH32_FLOAT, Constants.TEXTURETYPE_FLOAT),
      };
      this.ownClear = new FrameGraphClearTextureTask("Water clear", graph);
      this.ownClear.targetTexture = source.color;
      this.ownClear.depthTexture = source.depth;
      this.ownOpaque = new ManagedShadowObjectRendererTask("Water opaque", graph, scene, { doNotChangeAspectRatio: false });
      this.ownOpaque.mainView = true;
      this.ownOpaque.targetTexture = this.ownClear.outputTexture;
      this.ownOpaque.depthTexture = this.ownClear.outputDepthTexture;
      this.ownOpaque.renderTransparentMeshes = false;
      this.ownOpaque.renderParticles = false;
      this.ownOpaque.renderSprites = false;
      opaque = this.ownOpaque;
      this.owned.push(this.ownClear, this.ownOpaque);
      this.shadowReceivers.push(this.ownOpaque);
    }
    this.copy = new WaterSceneCopyTask("Water scene copy", graph, source.color, source.depth, copyWidth, copyHeight, options.scale < 1);
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
    const split = new WaterSplitTask("Water split", graph, () => this.split());
    this.owned.push(split);
    this.beforeObjects.push(split);
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
      this.ownOutput = copyOut;
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

  /** Mirror the view's clear settings and culled list; called with the view's own syncSceneInputs. */
  syncInputs(): void {
    if (this.ownClear) {
      this.ownClear.color = this.sceneClear.color;
      this.ownClear.clearColor = this.sceneClear.clearColor;
      this.ownClear.clearDepth = this.sceneClear.clearDepth;
      this.ownClear.clearStencil = this.sceneClear.clearStencil;
    }
    if (this.ownOpaque && !this.probing) this.ownOpaque.objectList = this.cull.outputObjectList;
  }

  /** Probe with every current candidate: the transparent pass only with alpha-blended ones. */
  beginProbe(all: FrameGraphObjectList): void {
    if (this.probing) return;
    this.probing = { transparent: this.transparent.objectList, opaque: this.ownOpaque?.objectList };
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
    if (this.ownOpaque) this.ownOpaque.objectList = all;
  }

  endProbe(): void {
    const saved = this.probing;
    if (!saved) return;
    this.probing = undefined;
    this.transparent.objectList = saved.transparent;
    if (this.ownOpaque && saved.opaque) this.ownOpaque.objectList = saved.opaque;
    this.probeMeshes.length = 0;
    this.probeList.meshes = null;
  }

  /** Per frame, after culling: no allocation, and only flag writes when visibility changes. */
  private split(): void {
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
      list.length = count;
      this.transparentList.particleSystems = culled.particleSystems ?? this.noParticles;
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
    if (this.ownTargets) {
      // The direct path draws the output exactly as before on frames without such water.
      this.sceneClear.disabled = visible;
      this.objects.disabled = visible;
    } else {
      // The shared opaque pass leaves transparents, particles and sprites to the transparent pass.
      this.objects.renderTransparentMeshes = !visible;
      this.objects.renderParticles = !visible;
      this.objects.renderSprites = !visible;
    }
  }

  /** Attach the built copy to the registry and commit the reservation; after each build. */
  reconcile(): void {
    const textures = this.graph.textureManager;
    const copy = textures.getTextureFromHandle(this.copy.outputTexture);
    if (!copy) throw new Error("Water scene copy target is not allocated.");
    if (this.entry.texture.getInternalTexture() !== copy) {
      const texture = new ThinTexture(copy);
      texture.wrapU = texture.wrapV = Texture.CLAMP_ADDRESSMODE;
      this.entry.texture = texture;
      this.entry.revision = ++revisions;
    }
    if (this.committed) return;
    const resources = [copy, ...this.ownHandles.map((handle) => textures.getTextureFromHandle(handle))].map((texture) => {
      if (!texture) throw new Error("Water scene copy target is not allocated.");
      return managedRenderTextureResource(texture, "water", { samples: 1, allocatedMipLevels: 1 });
    });
    this.lease.commit(resources);
    this.committed = true;
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

  /** Release the reservation once the graph (and its targets) is disposed. */
  releaseAfterGraphDisposal(): Promise<void> {
    if (!this.tasksDisposed) throw new Error("Dispose water scene copy tasks before releasing their graph lease.");
    return (this.released ??= this.copy.whenReleased().then(() =>
      releaseManagedRenderLeaseAfterDisposal(this.graph.engine, this.lease)));
  }
}

/** Without an effect chain the materials write display colour; Scene Linear keeps half-float. */
function ownColorType(scene: Scene): number {
  return scene.imageProcessingConfiguration.applyByPostProcess ? Constants.TEXTURETYPE_HALF_FLOAT : Constants.TEXTURETYPE_UNSIGNED_BYTE;
}
