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
import type { FrameGraphRenderContext } from "@babylonjs/core/FrameGraph/frameGraphRenderContext";
import type { Effect } from "@babylonjs/core/Materials/effect";
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
import { SHARED_OUTLINE_STROKE_SAMPLERS, SHARED_OUTLINE_STROKE_UNIFORMS } from "./shared-outline-stroke";
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

export interface SharedOutlineTaskOptions {
  /**
   * Another pass composites the stroke (a Display Color pass, as its last stage): the task records its mask passes
   * only, with no composition pass and no composition Effect, and that pass declares `strokeTextures`, sets their
   * sampling (`setStrokeSampling`) and binds the stroke (`bindStroke`) with the shared stroke include
   * (`shared-outline-stroke.ts`). The pass must run after this task, at `targetTexture`'s size.
   */
  externalCompose?: boolean;
}

/** Shared outline masks and composition with a bounded per-view pass budget. */
export class FrameGraphSharedOutlineTask extends FrameGraphTask {
  camera!: Camera;
  /**
   * The image the strokes land on; its size is the masks' and the stroke's pixels. The task blends onto it, unless the
   * composition is external (`externalCompose`): it is then a texture of the composing pass's size, which the task only
   * measures.
   */
  targetTexture!: FrameGraphTextureHandle;
  /**
   * The view's scene depth as its object pass left it, single-sample (resolved where the pass is multisampled). With
   * it, and when it is the target's size, the strict mask starts from a copy of it and its pass draws the outlined
   * meshes and only the occluders that depth lacks (`writesSceneDepth`), instead of every occluder again.
   */
  sceneDepthTexture: FrameGraphTextureHandle | undefined;
  /** `targetTexture` with the strokes blended on; never resolved when the composition is external. */
  readonly outputTexture: FrameGraphTextureHandle;
  readonly view: SharedOutlineView;
  /** Whether another pass composites the stroke (`SharedOutlineTaskOptions.externalCompose`). */
  readonly externalCompose: boolean;
  /**
   * The groups this task draws, fixed as it is built: those active then. An inactive group's targets and passes are
   * never created (the selection group never is in Play, which has no selection). A group that activates later needs a
   * new graph (`coversActiveGroups`); one that deactivates keeps its targets, its passes disabled, until the graph is
   * built again, so outlines a script toggles each tick rebuild the graph at most once per group.
   */
  readonly groups: readonly SharedOutlineGroup[];
  private readonly masks: MaskRecord[] = [];
  /** The composition's own Effect; none when the composition is external. */
  private readonly compose: EffectWrapper | undefined;
  private readonly seed: EffectWrapper;
  /** Whether the strict mask is seeded from `sceneDepthTexture` (decided as the task records). */
  private seeded = false;
  /** Set once the compose or a mask shader fails to compile. */
  readonly compileFailure = new EffectCompileFailure();
  private readonly inverseProjection = Matrix.Identity();
  private composePass: FrameGraphRenderPass | undefined;
  /** The masks and the strict group's depth, which the stroke samples; set as the task records. */
  private strokeInputs: FrameGraphTextureHandle[] = [];
  private strictDepth: FrameGraphTextureHandle | undefined;
  /** Whether this frame's masks can hold a stroke (`sync`); false keeps every group's stroke unread. */
  private strokesDrawn = false;
  private lease: ManagedRenderLease | undefined;
  private width = 0;
  private height = 0;
  private committed = false;
  private disposed = false;
  private readonly retirements: OwnedEffectRetirement[] = [];
  private released: Promise<void> | undefined;
  private resolveGraphRelease!: () => void;
  private readonly graphReleased = new Promise<void>((resolve) => { this.resolveGraphRelease = resolve; });

  constructor(name: string, graph: FrameGraph, view: SharedOutlineView, options: SharedOutlineTaskOptions = {}) {
    super(name, graph);
    if (view.scene !== graph.scene || view.isDisposed) throw new Error("Shared outline view does not belong to the live graph Scene.");
    this.view = view;
    this.externalCompose = options.externalCompose ?? false;
    this.groups = view.active ? SHARED_OUTLINE_GROUPS.filter((group) => view.groupActive(group)) : [];
    this.outputTexture = graph.textureManager.createDanglingHandle();
    registerSharedOutlineShaders();
    this.compose = this.externalCompose ? undefined : new EffectWrapper({
      name: `${name} Compose`, engine: graph.engine, useShaderStore: true,
      fragmentShader: SHARED_OUTLINE_COMPOSE_SHADER,
      uniformNames: [...SHARED_OUTLINE_STROKE_UNIFORMS],
      samplerNames: [...SHARED_OUTLINE_STROKE_SAMPLERS],
      shaderLanguage: ShaderLanguage.GLSL,
      onError: this.compileFailure.for(`${name} Compose`),
    });
    this.seed = new EffectWrapper({
      name: `${name} Depth Seed`, engine: graph.engine, useShaderStore: true,
      fragmentShader: SHARED_OUTLINE_DEPTH_SEED_SHADER,
      uniformNames: [], samplerNames: ["sceneDepth"],
      shaderLanguage: ShaderLanguage.GLSL,
      onError: this.compileFailure.for(`${name} Depth Seed`),
    });
    this.onBeforeTaskExecute.add(() => this.sync(true));
  }
  /** Whether every group the view has active has its targets here; when not, the graph must be built again. */
  coversActiveGroups(): boolean {
    return !this.view.active || SHARED_OUTLINE_GROUPS.every((group) => this.groups.includes(group) || !this.view.groupActive(group));
  }
  /** Whether `group` has its targets here and is active this frame. */
  private drawsGroup(group: SharedOutlineGroup): boolean { return this.view.active && this.groups.includes(group) && this.view.groupActive(group); }
  /** Whether the strict mask's pass runs seeded from the scene's depth this frame. */
  private get seeds(): boolean { return this.seeded && this.drawsGroup("strict"); }
  /** The compose (unless external), each active group's mask and, where the strict mask is seeded, its depth copy. */
  get drawingPassCount(): number {
    if (!this.view.active) return 0;
    return this.composePassCount + this.groups.filter((group) => this.drawsGroup(group)).length + (this.seeds ? 1 : 0);
  }
  get renderRecordCount(): number {
    if (!this.view.active) return 0;
    const groups = this.groups.filter((group) => this.drawsGroup(group)).length;
    return this.composePassCount + 2 * groups + (this.seeds ? 1 : 0);
  }
  private get composePassCount(): number { return this.externalCompose ? 0 : 1; }
  /**
   * Whether a stroke can show this frame: the view is active and a mask can hold an identity (`sync`). An external
   * composition reads no mask in a frame without one (`bindStroke` sets every group inactive).
   */
  get strokesShow(): boolean { return this.view.active && this.strokesDrawn; }
  /** The textures the stroke samples, for the composing pass's dependencies: each group's mask and the strict depth. */
  get strokeTextures(): readonly FrameGraphTextureHandle[] { return this.strokeInputs; }
  /** Nearest sampling for every texture the stroke reads: it decodes identities and compares depths texel by texel. */
  setStrokeSampling(context: FrameGraphRenderContext): void {
    for (const handle of this.strokeInputs) context.setTextureSamplingMode(handle, Texture.NEAREST_SAMPLINGMODE);
  }
  /**
   * Binds this frame's stroke uniforms and samplers on `effect`, which includes the shared stroke. A group without
   * targets, or every group in a frame where no stroke can show, reads as inactive, so its samplers are never read; each
   * still takes a texture that is never a render target (its own style table), since WebGL rejects a draw whose
   * program's samplers could read the target it draws into.
   */
  bindStroke(context: FrameGraphRenderContext, effect: Effect): void {
    const drawn = this.strokesShow;
    effect.setFloat2("screenSize", this.width, this.height);
    effect.setFloat2("tableSize", this.view.tableWidth, this.view.tableHeight);
    effect.setFloat("maximumWidth", this.view.maximumWidth);
    effect.setFloat3("maximumWidths", ...SHARED_OUTLINE_GROUPS.map((group) => this.view.maximumWidthForGroup(group)) as [number, number, number]);
    effect.setFloat("distanceFadeEnabled", this.view.distanceFadeEnabled ? 1 : 0);
    effect.setFloat("reverseDepth", this._frameGraph.engine.useReverseDepthBuffer ? 1 : 0);
    this.camera.getProjectionMatrix().invertToRef(this.inverseProjection);
    effect.setMatrix("inverseProjection", this.inverseProjection);
    effect.setFloat2("depthRange", 2, -1);
    effect.setFloat3("activeGroups", ...SHARED_OUTLINE_GROUPS.map((group) => drawn && this.drawsGroup(group) ? 1 : 0) as [number, number, number]);
    for (const group of SHARED_OUTLINE_GROUPS) {
      const style = this.view.styleTexture(group);
      const record = this.masks.find((entry) => entry.group === group);
      if (record) context.bindTextureHandle(effect, `${group}Mask`, record.mask);
      else effect.setTexture(`${group}Mask`, style);
      effect.setTexture(`${group}Style`, style);
    }
    if (this.strictDepth !== undefined) context.bindTextureHandle(effect, "strictDepth", this.strictDepth);
    else effect.setTexture("strictDepth", this.view.styleTexture("strict"));
  }
  override getClassName(): string { return "FrameGraphSharedOutlineTask"; }

  override record(): void {
    if (this.targetTexture === undefined || !this.camera) throw new Error("Shared outline task needs targetTexture and camera.");
    const graph = this._frameGraph;
    const textures = graph.textureManager;
    const size = textures.getTextureDescription(this.targetTexture).size;
    this.width = size.width; this.height = size.height;
    if (!this.externalCompose) textures.resolveDanglingHandle(this.outputTexture, this.targetTexture);
    const sceneDepth = this.sceneDepthTexture;
    const depthSize = sceneDepth === undefined ? undefined : textures.getTextureDescription(sceneDepth).size;
    // A scene depth of another size (an authored chain at its own resolution) is not this mask's pixels.
    this.seeded = depthSize?.width === this.width && depthSize.height === this.height;
    if (!this.masks.length && this.groups.length) {
      // RGBA8 ID + depth32 per drawn group at most (the through and selection groups may share one depth), with no
      // hidden MSAA/mipmap allocation.
      this.lease = beginManagedRenderAllocation(graph.engine, this.width * this.height * 8 * this.groups.length);
      if (!this.lease) throw new Error("Shared outline targets exceed the Engine resource reservation.");
      for (const group of this.groups) {
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
    // Every drawn group's mask, but only the strict group's depth: the others end with their own mask pass, so the
    // graph's allocator gives the through and selection passes one depth target in turn.
    this.strictDepth = this.masks.find((record) => record.group === "strict")?.depth;
    this.strokeInputs = [...this.masks.map((record) => record.mask), ...this.strictDepth === undefined ? [] : [this.strictDepth]];
    if (!this.externalCompose) this.recordCompose();
    this.sync();
  }
  /** The composition's own pass: the stroke blended onto the target (`ALPHA_COMBINE`). */
  private recordCompose(): void {
    const pass = this._frameGraph.addRenderPass(`${this.name} Compose`);
    this.composePass = pass;
    pass.setRenderTarget(this.outputTexture);
    pass.addDependencies(this.strokeInputs);
    pass.setInitializeFunc((context) => this.setStrokeSampling(context));
    pass.setExecuteFunc((context) => {
      if (!this.view.active) return;
      const compose = this.compose!;
      context.applyFullScreenEffect(compose.drawWrapper, () => {
        // FrameGraph binds the DrawWrapper directly, so EffectWrapper's
        // onApply default for the native postprocess vertex shader does not run.
        compose.effect.setFloat2("scale", 1, 1);
        this.bindStroke(context, compose.effect);
      }, undefined, false, false, false, false, Constants.ALPHA_COMBINE);
    });
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
   * `cull` narrows each group's members to those that can show this frame, and
   * the strict occluders to those that can affect them; readiness keeps the
   * full lists so a mesh's program is ready before it comes into view. A frame
   * drawn without view culling (`skipFrustumClipping`: Play's starting-state
   * draw) draws the full lists, so each program has its first draw there
   * rather than when its mesh comes into view.
   *
   * A narrowed frame in which no group can show a stroke (no stroked strict member can show, and the through and
   * selection groups have no member in view) draws none of the task's passes: every mask would hold no identity, and the
   * composition of masks without identities blends nothing onto the image (`strokes`). An external composition reads
   * every group as inactive in such a frame (`strokesShow`), so it fetches none of the masks left from an earlier frame.
   */
  private sync(cull = false): void {
    if (this.disposed) return;
    this.view.prepare();
    const narrow = cull && !this.view.scene.skipFrustumClipping;
    let strokes = !narrow;
    for (const record of this.masks) {
      const active = this.view.active && this.view.groupActive(record.group);
      record.objects.camera = this.camera;
      // An inactive group's pass is disabled and never probed, so it keeps one empty list.
      const overSceneDepth = record.group === "strict" && this.seeded;
      const meshes = !active ? record.inactive : !narrow ? this.view.meshesForGroup(record.group, overSceneDepth)
        : record.group === "strict" ? this.view.strictOccludersFor(this.camera, this.width, this.height, overSceneDepth)
        : this.view.membersFor(record.group, this.camera, this.width, this.height);
      // The through and selection lists hold only stroked members; the strict one also its identity streams' sources and
      // instances, and occluders, so its cull says whether a stroked member shows.
      if (active && !strokes) strokes = record.group === "strict" ? this.view.strictStrokesShow : meshes.length > 0;
      const list = record.objects.objectList;
      if (list.meshes !== meshes) list.meshes = meshes;
      record.renderer.prune();
    }
    const drawn = this.view.active && strokes;
    this.strokesDrawn = strokes;
    for (const record of this.masks) {
      const disabled = !drawn || !this.view.groupActive(record.group);
      if (record.clearPass) record.clearPass.disabled = disabled;
      if (record.seedPass) record.seedPass.disabled = disabled;
      if (record.drawPass) record.drawPass.disabled = disabled;
    }
    if (this.composePass) this.composePass.disabled = !drawn;
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
    let ready = this.compose?.isReady() ?? true;
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
    const compose = this.compose;
    if (compose) this.retirements.push(retireOwnedEffect(compose.effect, () => compose.dispose()));
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
