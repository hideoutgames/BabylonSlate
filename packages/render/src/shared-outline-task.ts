import {
  Color4, Constants, EffectWrapper, Material, ShaderLanguage, ShaderMaterial, Texture, Vector2,
  type AbstractMesh, type Camera, type InstancedMesh, type Mesh,
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
  SHARED_OUTLINE_ATTRIBUTE, SHARED_OUTLINE_GROUPS, SharedOutlineView,
  type SharedOutlineGroup,
} from "./shared-outline";
import { registerSharedOutlineShaders, SHARED_OUTLINE_COMPOSE_SHADER, SHARED_OUTLINE_MASK_SHADER } from "./shared-outline-shaders";

class OutlineCompose extends EffectWrapper { get drawWrapper() { return this._drawWrapper; } }
type MaskRecord = {
  group: SharedOutlineGroup;
  mask: FrameGraphTextureHandle;
  depth: FrameGraphTextureHandle;
  clear: FrameGraphClearTextureTask;
  objects: FrameGraphObjectRendererTask;
  materials: Map<Mesh, { source: Material | null; mask: ShaderMaterial }>;
  clearPass?: FrameGraphRenderPass;
  drawPass?: FrameGraphRenderPass;
};

/** Bounded production task candidate. Qualification gates adoption by editor UI. */
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
        this.masks.push({ group, mask, depth, clear, objects, materials: new Map() });
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
      if (!active) continue;
      const sources = new Set<Mesh>();
      for (const mesh of record.objects.objectList.meshes ?? []) {
        if (!mesh.material || !mesh.subMeshes?.length) continue;
        const source = mesh.isAnInstance ? (mesh as InstancedMesh).sourceMesh : mesh as Mesh;
        sources.add(source);
        for (const lod of source.getLODLevels()) if (lod.mesh) sources.add(lod.mesh);
      }
      for (const source of sources) {
        let existing = record.materials.get(source);
        if (existing && existing.source !== source.material) {
          this.retireMaterial(existing.mask); record.materials.delete(source); existing = undefined;
        }
        if (!existing) {
          const mask = this.createMaskMaterial(source, record.group);
          existing = { source: source.material, mask }; record.materials.set(source, existing);
          record.objects.objectRenderer.setMaterialForRendering(source, mask);
        }
        existing.mask.setTexture("styleSampler", this.view.styleTexture(record.group));
        existing.mask.setVector2("tableSize", new Vector2(this.view.tableWidth, this.view.tableHeight));
      }
      for (const [source, entry] of record.materials) if (source.isDisposed()) {
        this.retireMaterial(entry.mask); record.materials.delete(source);
      }
    }
    if (this.composePass) this.composePass.disabled = !this.view.active;
  }
  private createMaskMaterial(source: Mesh, group: SharedOutlineGroup): ShaderMaterial {
    const original = source.material;
    const texture = original?.needAlphaTestingForMesh(source) ? original.getAlphaTestTexture() : null;
    const uv2 = texture?.coordinatesIndex === 1 && source.isVerticesDataPresent("uv2");
    const alphaTest = !!texture && source.isVerticesDataPresent(uv2 ? "uv2" : "uv");
    const material = new ShaderMaterial(`${this.name} ${group} Mask Material`, this._frameGraph.scene,
      { vertex: SHARED_OUTLINE_MASK_SHADER, fragment: SHARED_OUTLINE_MASK_SHADER }, {
        attributes: ["position", SHARED_OUTLINE_ATTRIBUTE, ...(alphaTest ? [uv2 ? "uv2" : "uv"] : [])],
        uniforms: ["world", "viewProjection", "view", "selectionId", "tableSize", "discardNonmembers", "diffuseMatrix", "alphaCutoff"],
        samplers: ["styleSampler", "diffuseSampler"],
        defines: ["STORE_CAMERASPACE_Z", ...(alphaTest ? [uv2 ? "UV2" : "UV1"] : [])],
        needAlphaBlending: false, needAlphaTesting: alphaTest, useClipPlane: true,
        shaderLanguage: this._frameGraph.engine.isWebGPU ? ShaderLanguage.WGSL : ShaderLanguage.GLSL,
      }, true);
    material.backFaceCulling = original?.backFaceCulling ?? true;
    material.cullBackFaces = original?.cullBackFaces ?? true;
    material.sideOrientation = original?.sideOrientation ?? Material.CounterClockWiseSideOrientation;
    material.disableDepthWrite = false;
    material.setFloat("discardNonmembers", group === "strict" ? 0 : 1);
    material.setFloat("alphaCutoff", "alphaCutOff" in (original ?? {}) ? (original as Material & { alphaCutOff: number }).alphaCutOff : 0.4);
    if (texture && alphaTest) {
      material.setTexture("diffuseSampler", texture); material.setMatrix("diffuseMatrix", texture.getTextureMatrix());
    }
    material.onBindObservable.add((mesh: AbstractMesh) => material.getEffect()?.setFloat("selectionId", this.view.owner.identityFor(mesh)));
    return material;
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
  private retireMaterial(material: ShaderMaterial): void {
    this.retirements.push(retireOwnedEffect(material.getEffect(), () => material.dispose(true, false)));
  }
  override dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const record of this.masks) {
      for (const [source, entry] of record.materials) {
        if (!source.isDisposed()) record.objects.objectRenderer.setMaterialForRendering(source, undefined);
        this.retireMaterial(entry.mask);
      }
      record.materials.clear();
      this.view.owner.retireRenderPass(record.objects.objectRenderer.renderPassId);
      record.objects.dispose(); record.clear.dispose();
    }
    this.retirements.push(retireOwnedEffect(this.compose.effect, () => this.compose.dispose()));
    super.dispose();
  }
  async whenDisposed(): Promise<void> { await Promise.all(this.retirements.map((entry) => entry.completion)); }
  whenReleased(): Promise<void> {
    this.released ??= this.graphReleased.then(async () => {
      await Promise.all(this.retirements.map((entry) => entry.released));
      if (this.lease) await releaseManagedRenderLeaseAfterDisposal(this._frameGraph.engine, this.lease);
    });
    return this.released;
  }
  releaseAfterGraphDisposal(): Promise<void> {
    if (!this.disposed) throw new Error("Dispose shared outline tasks before releasing graph resources.");
    this.resolveGraphRelease(); return this.whenReleased();
  }
}
