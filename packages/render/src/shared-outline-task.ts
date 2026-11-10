import type { Camera } from "@babylonjs/core/Cameras/camera";
import type { AbstractMesh } from "@babylonjs/core/Meshes/abstractMesh";
import { Constants } from "@babylonjs/core/Engines/constants";
import { Texture } from "@babylonjs/core/Materials/Textures/texture";
import { EffectWrapper } from "@babylonjs/core/Materials/effectRenderer";
import { ShaderLanguage } from "@babylonjs/core/Materials/shaderLanguage";
import { Color4 } from "@babylonjs/core/Maths/math.color";
import { Matrix } from "@babylonjs/core/Maths/math.vector";
import { FrameGraphTask } from "@babylonjs/core/FrameGraph/frameGraphTask";
import type { FrameGraph } from "@babylonjs/core/FrameGraph/frameGraph";
import type { FrameGraphTextureHandle } from "@babylonjs/core/FrameGraph/frameGraphTypes";
import type { FrameGraphRenderPass } from "@babylonjs/core/FrameGraph/Passes/renderPass";
import { FrameGraphClearTextureTask } from "@babylonjs/core/FrameGraph/Tasks/Texture/clearTextureTask";
import {
  beginManagedRenderAllocation, releaseManagedRenderLeaseAfterDisposal,
  type ManagedRenderLease,
} from "./managed-render-resources";
import { managedRenderTextureResource } from "./render-target-resource-cost";
import { retireOwnedEffect, type OwnedEffectRetirement } from "./owned-effect-retirement";
import {
  SHARED_OUTLINE_GROUPS, SharedOutlineView,
  type SharedOutlineGroup,
} from "./shared-outline";
import { registerSharedOutlineShaders, SHARED_OUTLINE_COMPOSE_SHADER, SHARED_OUTLINE_DEPTH_SEED_SHADER } from "./shared-outline-shaders";
import { SharedOutlineMaskRenderer } from "./shared-outline-mask";
import { EffectCompileFailure } from "./effect-compile-failure";
import { LightNeutralObjectRendererTask } from "./light-neutral-tasks";

type MaskRecord = {
  group: SharedOutlineGroup;
  mask: FrameGraphTextureHandle;
  depth: FrameGraphTextureHandle;
  clear: FrameGraphClearTextureTask;
  objects: LightNeutralObjectRendererTask;
  renderer: SharedOutlineMaskRenderer;
  clearPass?: FrameGraphRenderPass;
  /** The strict group's, when the mask is seeded from the scene's depth. */
  seedPass?: FrameGraphRenderPass;
  drawPass?: FrameGraphRenderPass;
  /** Mesh list whose programs were last probed ready, while the group stayed active. */
  probed?: readonly unknown[];
  /** The list an inactive group holds. */
  inactive: AbstractMesh[];
};

/** Shared outline masks and composition with a bounded per-view pass budget. */
export class FrameGraphSharedOutlineTask extends FrameGraphTask {
  camera!: Camera;
  targetTexture!: FrameGraphTextureHandle;
  /**
   * The view's scene depth as its object pass left it, single-sample (resolved where the pass is multisampled). With
   * it, and when it is the target's size, the strict mask starts from a copy of it and its pass draws the outlined
   * meshes and only the occluders that depth lacks (`writesSceneDepth`), instead of every occluder again.
   */
  sceneDepthTexture: FrameGraphTextureHandle | undefined;
  readonly outputTexture: FrameGraphTextureHandle;
  readonly view: SharedOutlineView;
  private readonly masks: MaskRecord[] = [];
  private readonly compose: EffectWrapper;
  private readonly seed: EffectWrapper;
  /** Whether the strict mask is seeded from `sceneDepthTexture` (decided as the task records). */
  private seeded = false;
  /** Set once the compose or a mask shader fails to compile. */
  readonly compileFailure = new EffectCompileFailure();
  private readonly inverseProjection = Matrix.Identity();
  private composePass: FrameGraphRenderPass | undefined;
  private lease: ManagedRenderLease | undefined;
  private width = 0;
  private height = 0;
  private committed = false;
  private disposed = false;
  private readonly retirements: OwnedEffectRetirement[] = [];
  private released: Promise<void> | undefined;
  private resolveGraphRelease!: () => void;
  private readonly graphReleased = new Promise<void>((resolve) => { this.resolveGraphRelease = resolve; });

  constructor(name: string, graph: FrameGraph, view: SharedOutlineView) {
    super(name, graph);
    if (view.scene !== graph.scene || view.isDisposed) throw new Error("Shared outline view does not belong to the live graph Scene.");
    this.view = view;
    this.outputTexture = graph.textureManager.createDanglingHandle();
    registerSharedOutlineShaders(graph.engine.isWebGPU);
    this.compose = new EffectWrapper({
      name: `${name} Compose`, engine: graph.engine, useShaderStore: true,
      fragmentShader: SHARED_OUTLINE_COMPOSE_SHADER,
      uniformNames: ["screenSize", "tableSize", "maximumWidth", "maximumWidths", "reverseDepth", "activeGroups", "inverseProjection", "depthRange", "distanceFadeEnabled"],
      samplerNames: ["strictDepth", ...SHARED_OUTLINE_GROUPS.flatMap((group) => [`${group}Mask`, `${group}Style`])],
      shaderLanguage: graph.engine.isWebGPU ? ShaderLanguage.WGSL : ShaderLanguage.GLSL,
      onError: this.compileFailure.for(`${name} Compose`),
    });
    this.seed = new EffectWrapper({
      name: `${name} Depth Seed`, engine: graph.engine, useShaderStore: true,
      fragmentShader: SHARED_OUTLINE_DEPTH_SEED_SHADER,
      uniformNames: [], samplerNames: ["sceneDepth"],
      shaderLanguage: graph.engine.isWebGPU ? ShaderLanguage.WGSL : ShaderLanguage.GLSL,
      onError: this.compileFailure.for(`${name} Depth Seed`),
    });
    this.onBeforeTaskExecute.add(() => this.sync(true));
  }
  /** Whether the strict mask's pass runs seeded from the scene's depth this frame. */
  private get seeds(): boolean { return this.seeded && this.view.active && this.view.groupActive("strict"); }
  /** The compose, each active group's mask and, where the strict mask is seeded, its depth copy. */
  get drawingPassCount(): number {
    return this.view.active ? 1 + SHARED_OUTLINE_GROUPS.filter((group) => this.view.groupActive(group)).length + (this.seeds ? 1 : 0) : 0;
  }
  get renderRecordCount(): number {
    if (!this.view.active) return 0;
    const groups = SHARED_OUTLINE_GROUPS.filter((group) => this.view.groupActive(group)).length;
    return 1 + 2 * groups + (this.seeds ? 1 : 0);
  }
  override getClassName(): string { return "FrameGraphSharedOutlineTask"; }

  override record(): void {
    if (this.targetTexture === undefined || !this.camera) throw new Error("Shared outline task needs targetTexture and camera.");
    const graph = this._frameGraph;
    const textures = graph.textureManager;
    const size = textures.getTextureDescription(this.targetTexture).size;
    this.width = size.width; this.height = size.height;
    textures.resolveDanglingHandle(this.outputTexture, this.targetTexture);
    const sceneDepth = this.sceneDepthTexture;
    const depthSize = sceneDepth === undefined ? undefined : textures.getTextureDescription(sceneDepth).size;
    // A scene depth of another size (an authored chain at its own resolution) is not this mask's pixels.
    this.seeded = depthSize?.width === this.width && depthSize.height === this.height;
    if (!this.masks.length) {
      // RGBA8 ID + depth32 per group, with no hidden MSAA/mipmap allocation.
      this.lease = beginManagedRenderAllocation(graph.engine, this.width * this.height * 8 * 3);
      if (!this.lease) throw new Error("Shared outline targets exceed the Engine resource reservation.");
      for (const group of SHARED_OUTLINE_GROUPS) {
        const create = (suffix: string, format: number, type: number) => textures.createRenderTargetTexture(`${this.name} ${group} ${suffix}`, {
          size: { width: this.width, height: this.height }, sizeIsPercentage: false,
          options: { createMipMaps: false, samples: 1, formats: [format], types: [type], useSRGBBuffers: [false] },
        });
        const mask = create("Identity", Constants.TEXTUREFORMAT_RGBA, Constants.TEXTURETYPE_UNSIGNED_BYTE);
        const depth = create("Depth", Constants.TEXTUREFORMAT_DEPTH32_FLOAT, Constants.TEXTURETYPE_FLOAT);
        const clear = new FrameGraphClearTextureTask(`${this.name} ${group} Clear`, graph);
        clear.targetTexture = mask; clear.depthTexture = depth; clear.clearDepth = true; clear.clearStencil = false;
        clear.color = new Color4(0, 0, 0, 0);
        // Mask draws use pass-owned programs or authored outlineMask variants with
        // no lighting, so the pass skips Babylon's per-pass light flag toggles.
        const objects = new LightNeutralObjectRendererTask(`${this.name} ${group} Mask`, graph, graph.scene, { doNotChangeAspectRatio: false });
        objects.targetTexture = clear.outputTexture; objects.depthTexture = clear.outputDepthTexture;
        // One list per group for the task's lifetime: `sync` swaps only its meshes.
        const inactive: AbstractMesh[] = [];
        objects.camera = this.camera; objects.objectList = { meshes: inactive, particleSystems: [] };
        objects.disableImageProcessing = true;
        objects.renderParticles = false; objects.renderSprites = false;
        objects.enableBoundingBoxRendering = false; objects.enableOutlineRendering = false;
        objects.depthTest = true; objects.depthWrite = true;
        this.view.owner.registerRenderPass(objects.objectRenderer.renderPassId);
        this.masks.push({ group, mask, depth, clear, objects, inactive,
          renderer: new SharedOutlineMaskRenderer(objects.objectRenderer, this.view, group, this.compileFailure) });
      }
    }
    this.sync();
    for (const record of this.masks) {
      record.clearPass = record.clear.record(true);
      record.seedPass = record.group === "strict" && this.seeded ? this.recordSeed(record, sceneDepth!) : undefined;
      record.drawPass = record.objects.record(true);
      record.renderer.overSceneDepth = record.seedPass !== undefined;
    }
    const pass = graph.addRenderPass(`${this.name} Compose`);
    this.composePass = pass;
    pass.setRenderTarget(this.outputTexture);
    // Every group's mask, but only the strict group's depth: the others end with their own mask pass, so the graph's
    // allocator gives the through and selection passes one depth target in turn.
    const strictDepth = this.masks[0]!.depth;
    pass.addDependencies([...this.masks.map((record) => record.mask), strictDepth]);
    pass.setInitializeFunc((context) => {
      for (const record of this.masks) context.setTextureSamplingMode(record.mask, Texture.NEAREST_SAMPLINGMODE);
      context.setTextureSamplingMode(strictDepth, Texture.NEAREST_SAMPLINGMODE);
    });
    pass.setExecuteFunc((context) => {
      if (!this.view.active) return;
      const effect = this.compose.effect;
      context.applyFullScreenEffect(this.compose.drawWrapper, () => {
        // FrameGraph binds the DrawWrapper directly, so EffectWrapper's
        // onApply default for the native postprocess vertex shader does not run.
        effect.setFloat2("scale", 1, 1);
        effect.setFloat2("screenSize", this.width, this.height);
        effect.setFloat2("tableSize", this.view.tableWidth, this.view.tableHeight);
        effect.setFloat("maximumWidth", this.view.maximumWidth);
        effect.setFloat3("maximumWidths", ...SHARED_OUTLINE_GROUPS.map((group) => this.view.maximumWidthForGroup(group)) as [number, number, number]);
        effect.setFloat("distanceFadeEnabled", this.view.distanceFadeEnabled ? 1 : 0);
        effect.setFloat("reverseDepth", graph.engine.useReverseDepthBuffer ? 1 : 0);
        this.camera.getProjectionMatrix().invertToRef(this.inverseProjection);
        effect.setMatrix("inverseProjection", this.inverseProjection);
        effect.setFloat2("depthRange", graph.engine.isNDCHalfZRange ? 1 : 2, graph.engine.isNDCHalfZRange ? 0 : -1);
        effect.setFloat3("activeGroups", ...SHARED_OUTLINE_GROUPS.map((group) => this.view.groupActive(group) ? 1 : 0) as [number, number, number]);
        for (const record of this.masks) {
          context.bindTextureHandle(effect, `${record.group}Mask`, record.mask);
          effect.setTexture(`${record.group}Style`, this.view.styleTexture(record.group));
        }
        context.bindTextureHandle(effect, "strictDepth", strictDepth);
      }, undefined, false, false, false, false, Constants.ALPHA_COMBINE);
    });
    this.sync();
  }
  /** The strict mask's depth, cleared, takes the scene's: one full-screen draw in place of every occluder that depth holds. */
  private recordSeed(record: MaskRecord, sceneDepth: FrameGraphTextureHandle): FrameGraphRenderPass {
    const graph = this._frameGraph;
    const pass = graph.addRenderPass(`${this.name} ${record.group} Depth Seed`);
    pass.setRenderTarget(record.clear.outputTexture);
    pass.setRenderTargetDepth(record.clear.outputDepthTexture);
    pass.addDependencies(sceneDepth);
    pass.setInitializeFunc((context) => context.setTextureSamplingMode(sceneDepth, Texture.NEAREST_SAMPLINGMODE));
    pass.setExecuteFunc((context) => {
      const effect = this.seed.effect;
      context.applyFullScreenEffect(this.seed.drawWrapper, () => {
        // The context turns depth writes off for a full-screen draw; this one exists to write depth, whatever it holds.
        graph.engine.setDepthWrite(true);
        graph.engine.setDepthFunction(Constants.ALWAYS);
        effect.setFloat2("scale", 1, 1);
        context.bindTextureHandle(effect, "sceneDepth", sceneDepth);
      }, undefined, true, false, true);
    });
    return pass;
  }
  /**
   * `cull` narrows the strict occluders to those that can affect this frame;
   * readiness keeps the full list so an occluder's program is ready before it
   * comes into view. A frame drawn without view culling (`skipFrustumClipping`:
   * Play's starting-state draw) draws the full list, so each occluder's program
   * has its first draw there rather than when it comes into view.
   */
  private sync(cull = false): void {
    if (this.disposed) return;
    this.view.prepare();
    const narrow = cull && !this.view.scene.skipFrustumClipping;
    for (const record of this.masks) {
      const active = this.view.active && this.view.groupActive(record.group);
      if (record.clearPass) record.clearPass.disabled = !active;
      if (record.seedPass) record.seedPass.disabled = !active;
      if (record.drawPass) record.drawPass.disabled = !active;
      record.objects.camera = this.camera;
      // An inactive group's pass is disabled and never probed, so it keeps one empty list.
      const overSceneDepth = record.group === "strict" && this.seeded;
      const meshes = !active ? record.inactive : narrow && record.group === "strict"
        ? this.view.strictOccludersFor(this.camera, this.width, this.height, overSceneDepth)
        : this.view.meshesForGroup(record.group, overSceneDepth);
      const list = record.objects.objectList;
      if (list.meshes !== meshes) list.meshes = meshes;
      record.renderer.prune();
    }
    if (this.composePass) this.composePass.disabled = !this.view.active;
  }
  override isReady(): boolean { return this.probe(false); }
  /**
   * Readiness after only outline membership or style changed. A group whose mesh
   * list is the one already probed ready is not probed again: its programs
   * cannot have changed, since any scene or material change reaches the owner
   * as a full probe. A selection change thus costs the newly selected meshes.
   */
  isReadyAfterOutlineChange(): boolean { return this.probe(true); }
  private probe(skipProbedGroups: boolean): boolean {
    if (this.disposed) return false;
    this.sync();
    if (!this.view.active) return true;
    // Probe every group even after a failure, so each starts its own compilation.
    let ready = this.compose.isReady();
    if (this.seeds && !this.seed.isReady()) ready = false;
    for (const record of this.masks) {
      if (!this.view.groupActive(record.group)) { record.probed = undefined; continue; }
      const meshes = record.objects.objectList.meshes ?? undefined;
      if (skipProbedGroups && record.probed === meshes) continue;
      const groupReady = record.objects.isReady();
      record.probed = groupReady ? meshes : undefined;
      if (!groupReady) ready = false;
    }
    return ready;
  }
  /** Whether `renderPassId` is one of this task's mask passes, which draw every frame. */
  ownsRenderPass(renderPassId: number): boolean {
    return this.masks.some((record) => record.objects.objectRenderer.renderPassIds.includes(renderPassId));
  }
  reconcileResources(): void {
    if (this.committed || !this.lease) return;
    const resources = this.masks.flatMap((record) => [
      managedRenderTextureResource(this._frameGraph.textureManager.getTextureFromHandle(record.mask)!, "postprocess", { samples: 1, allocatedMipLevels: 1 }),
      managedRenderTextureResource(this._frameGraph.textureManager.getTextureFromHandle(record.depth)!, "depth", { samples: 1, allocatedMipLevels: 1 }),
    ]);
    this.lease.commit(resources); this.committed = true;
  }
  override dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const record of this.masks) {
      record.renderer.dispose();
      this.view.owner.retireRenderPass(record.objects.objectRenderer.renderPassId);
      record.objects.dispose(); record.clear.dispose();
    }
    this.retirements.push(retireOwnedEffect(this.compose.effect, () => this.compose.dispose()));
    this.retirements.push(retireOwnedEffect(this.seed.effect, () => this.seed.dispose()));
    super.dispose();
  }
  async whenDisposed(): Promise<void> { await Promise.all([
    ...this.retirements.map((entry) => entry.completion), ...this.masks.map((record) => record.renderer.whenDisposed()),
  ]); }
  whenReleased(): Promise<void> {
    this.released ??= this.graphReleased.then(async () => {
      await Promise.all(this.retirements.map((entry) => entry.released));
      await Promise.all(this.masks.map((record) => record.renderer.whenReleased()));
      if (this.lease) await releaseManagedRenderLeaseAfterDisposal(this._frameGraph.engine, this.lease);
    });
    return this.released;
  }
  releaseAfterGraphDisposal(): Promise<void> {
    if (!this.disposed) throw new Error("Dispose shared outline tasks before releasing graph resources.");
    this.resolveGraphRelease(); return this.whenReleased();
  }
}
