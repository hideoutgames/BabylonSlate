import {
  Color4, Constants, EffectWrapper, ShaderLanguage, Texture, type Camera,
} from "@babylonjs/core";
import { FrameGraphTask } from "@babylonjs/core/FrameGraph/frameGraphTask";
import type { FrameGraph } from "@babylonjs/core/FrameGraph/frameGraph";
import type { FrameGraphTextureHandle } from "@babylonjs/core/FrameGraph/frameGraphTypes";
import type { FrameGraphRenderPass } from "@babylonjs/core/FrameGraph/Passes/renderPass";
import { FrameGraphObjectRendererTask } from "@babylonjs/core/FrameGraph/Tasks/Rendering/objectRendererTask";
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
import { registerSharedOutlineShaders, SHARED_OUTLINE_COMPOSE_SHADER } from "./shared-outline-shaders";
import { SharedOutlineMaskRenderer } from "./shared-outline-mask";

class OutlineCompose extends EffectWrapper { get drawWrapper() { return this._drawWrapper; } }
type MaskRecord = {
  group: SharedOutlineGroup;
  mask: FrameGraphTextureHandle;
  depth: FrameGraphTextureHandle;
  clear: FrameGraphClearTextureTask;
  objects: FrameGraphObjectRendererTask;
  renderer: SharedOutlineMaskRenderer;
  clearPass?: FrameGraphRenderPass;
  drawPass?: FrameGraphRenderPass;
};

/** Shared outline masks and composition with a bounded per-view pass budget. */
export class FrameGraphSharedOutlineTask extends FrameGraphTask {
  camera!: Camera;
  targetTexture!: FrameGraphTextureHandle;
  readonly outputTexture: FrameGraphTextureHandle;
  readonly view: SharedOutlineView;
  private readonly masks: MaskRecord[] = [];
  private readonly compose: OutlineCompose;
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
    registerSharedOutlineShaders();
    this.compose = new OutlineCompose({
      name: `${name} Compose`, engine: graph.engine, useShaderStore: true,
      fragmentShader: SHARED_OUTLINE_COMPOSE_SHADER,
      uniformNames: ["screenSize", "tableSize", "maximumWidth", "reverseDepth", "activeGroups"],
      samplerNames: ["strictDepth", ...SHARED_OUTLINE_GROUPS.flatMap((group) => [`${group}Mask`, `${group}Style`])],
      shaderLanguage: graph.engine.isWebGPU ? ShaderLanguage.WGSL : ShaderLanguage.GLSL,
    });
    this.onBeforeTaskExecute.add(() => this.sync());
  }
  get drawingPassCount(): number { return this.view.active ? 1 + SHARED_OUTLINE_GROUPS.filter((group) => this.view.groupActive(group)).length : 0; }
  get renderRecordCount(): number { return this.view.active ? 1 + 2 * (this.drawingPassCount - 1) : 0; }
  override getClassName(): string { return "FrameGraphSharedOutlineTask"; }

  override record(): void {
    if (this.targetTexture === undefined || !this.camera) throw new Error("Shared outline task needs targetTexture and camera.");
    const graph = this._frameGraph;
    const textures = graph.textureManager;
    const size = textures.getTextureDescription(this.targetTexture).size;
    this.width = size.width; this.height = size.height;
    textures.resolveDanglingHandle(this.outputTexture, this.targetTexture);
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
        const objects = new FrameGraphObjectRendererTask(`${this.name} ${group} Mask`, graph, graph.scene, { doNotChangeAspectRatio: false });
        objects.targetTexture = clear.outputTexture; objects.depthTexture = clear.outputDepthTexture;
        objects.camera = this.camera; objects.objectList = { meshes: [], particleSystems: [] };
        objects.disableShadows = true; objects.disableImageProcessing = true;
        objects.renderParticles = false; objects.renderSprites = false;
        objects.enableBoundingBoxRendering = false; objects.enableOutlineRendering = false;
        objects.depthTest = true; objects.depthWrite = true;
        this.view.owner.registerRenderPass(objects.objectRenderer.renderPassId);
        this.masks.push({ group, mask, depth, clear, objects,
          renderer: new SharedOutlineMaskRenderer(objects.objectRenderer, this.view, group) });
      }
    }
    this.sync();
    for (const record of this.masks) {
      record.clearPass = record.clear.record(true);
      record.drawPass = record.objects.record(true);
    }
    const pass = graph.addRenderPass(`${this.name} Compose`);
    this.composePass = pass;
    pass.setRenderTarget(this.outputTexture);
    pass.addDependencies(this.masks.flatMap((record) => [record.mask, record.depth]));
    pass.setInitializeFunc((context) => {
      for (const record of this.masks) {
        context.setTextureSamplingMode(record.mask, Texture.NEAREST_SAMPLINGMODE);
        context.setTextureSamplingMode(record.depth, Texture.NEAREST_SAMPLINGMODE);
      }
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
        effect.setFloat("reverseDepth", graph.engine.useReverseDepthBuffer ? 1 : 0);
        effect.setFloat3("activeGroups", ...SHARED_OUTLINE_GROUPS.map((group) => this.view.groupActive(group) ? 1 : 0) as [number, number, number]);
        for (const record of this.masks) {
          context.bindTextureHandle(effect, `${record.group}Mask`, record.mask);
          effect.setTexture(`${record.group}Style`, this.view.styleTexture(record.group));
        }
        context.bindTextureHandle(effect, "strictDepth", this.masks[0]!.depth);
      }, undefined, false, false, false, false, Constants.ALPHA_COMBINE);
    });
    this.sync();
  }
  private sync(): void {
    if (this.disposed) return;
    this.view.prepare();
    for (const record of this.masks) {
      const active = this.view.active && this.view.groupActive(record.group);
      if (record.clearPass) record.clearPass.disabled = !active;
      if (record.drawPass) record.drawPass.disabled = !active;
      record.objects.camera = this.camera;
      record.objects.objectList = { meshes: active ? this.view.meshesForGroup(record.group) : [], particleSystems: [] };
      record.renderer.prune();
    }
    if (this.composePass) this.composePass.disabled = !this.view.active;
  }
  override isReady(): boolean {
    if (this.disposed) return false;
    this.sync();
    return !this.view.active || this.compose.isReady() && this.masks.every((record) => !this.view.groupActive(record.group) || record.objects.isReady());
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
