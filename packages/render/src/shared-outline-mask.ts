import {
  Constants, EffectFallbacks, Material, ShaderLanguage, VertexBuffer,
  type AbstractMesh, type BaseTexture, type DrawWrapper, type Effect, type Matrix, type SmartArray, type SubMesh,
} from "@babylonjs/core";
import type { ObjectRenderer } from "@babylonjs/core/Rendering/objectRenderer";
import { AddClipPlaneUniforms, BindClipPlane, PrepareStringDefinesForClipPlanes } from "@babylonjs/core/Materials/clipPlaneMaterialHelper";
import { BindBonesParameters, BindMorphTargetParameters, PrepareDefinesAndAttributesForMorphTargets, PushAttributesForInstances } from "@babylonjs/core/Materials/materialHelper.functions";
import { retireOwnedEffect, type OwnedEffectRetirement } from "./owned-effect-retirement";
import { SHARED_OUTLINE_ATTRIBUTE, type SharedOutlineGroup, type SharedOutlineView } from "./shared-outline";
import { SHARED_OUTLINE_MASK_SHADER } from "./shared-outline-shaders";
import { acquireAuthoredOutlineVariant, type AuthoredOutlineVariant } from "./material-compiler";
import { CelMaterial } from "./cel-material";

type MaskProgram = {
  source: Material; wrapper?: DrawWrapper; variant?: AuthoredOutlineVariant;
  /** Render id and instancing mode of the last successful render-time validation. */
  readyRenderId?: number; readyHardware?: boolean;
};

/** Native submesh submission with pass-owned programs; original materials never change. */
export class SharedOutlineMaskRenderer {
  private readonly programs = new Map<SubMesh, MaskProgram>();
  private readonly retirements: OwnedEffectRetirement[] = [];
  private disposed = false;
  private readonly renderer: ObjectRenderer;
  private readonly view: SharedOutlineView;
  private readonly group: SharedOutlineGroup;
  /** Instancing mode of the most recent instances() call. */
  private hardware = false;
  private currentEffect: Effect | undefined;
  // One callback for every submission; _processRendering invokes it synchronously.
  private readonly setInstanceWorld = (_instance: boolean, world: Matrix) => this.currentEffect!.setMatrix("world", world);
  constructor(renderer: ObjectRenderer, view: SharedOutlineView, group: SharedOutlineGroup) {
    this.renderer = renderer; this.view = view; this.group = group;
    renderer.customIsReadyFunction = (mesh, _refreshRate, preWarm) => {
      if (this.disposed || mesh.isDisposed()) return false;
      // The renderer performs LOD selection after this callback. Check both the
      // source here and the actual LOD again before submission. Readiness
      // probes (preWarm) always revalidate and never let a draw skip its check.
      return (mesh.subMeshes ?? []).every((subMesh) => this.ready(subMesh, !preWarm));
    };
    renderer.customRenderFunction = (opaque, tested, transparent, depthOnly) => {
      const engine = view.scene.getEngine();
      const alpha = engine.getAlphaMode(), color = engine.getColorWrite();
      const depth = engine.getDepthBuffer(), write = engine.getDepthWrite();
      try {
        engine.setAlphaMode(Constants.ALPHA_DISABLE);
        engine.setDepthBuffer(true); engine.setDepthWrite(true);
        engine.setColorWrite(false);
        this.drawList(depthOnly);
        engine.setColorWrite(true);
        this.drawList(opaque); this.drawList(tested); this.drawList(transparent);
      } finally {
        engine.setAlphaMode(alpha); engine.setColorWrite(color);
        engine.setDepthBuffer(depth); engine.setDepthWrite(write);
      }
    };
  }
  /** Drop removed geometry without recompiling or rebuilding unchanged programs. */
  prune(): void {
    for (const [subMesh, program] of this.programs)
      // Regular instances own cloned submeshes but borrow source geometry.
      // Testing source membership retires their live asynchronous programs on
      // every readiness probe, preventing native WebGL compilation from settling.
      if (subMesh.getMesh().isDisposed() || subMesh.getRenderingMesh().isDisposed() ||
        !subMesh.getMesh().subMeshes?.includes(subMesh)) {
        this.retire(subMesh, program); this.programs.delete(subMesh);
      }
    for (let index = this.retirements.length - 1; index >= 0; index--)
      if (this.retirements[index]!.isReleased()) this.retirements.splice(index, 1);
  }
  private source(subMesh: SubMesh): Material | null {
    const mesh = subMesh.getRenderingMesh();
    // Ensure Babylon's default exists, but preserve deliberately null submaterials.
    if (!mesh.material) return this.view.scene.defaultMaterial;
    return subMesh.getMaterial();
  }
  private instances(subMesh: SubMesh) {
    const mesh = subMesh.getRenderingMesh();
    const replacement = !!subMesh.getReplacementMesh();
    const batch = mesh._getInstancesRenderList(subMesh._id, replacement);
    // Readiness precedes visibility dispatch and the first ID VBO. Registration
    // keeps async compilation on the same variant before and during drawing.
    // Mirrored replacement draws retain Babylon's noninstanced world transform.
    this.hardware = !replacement && (!!batch.hardwareInstancedRendering[subMesh._id] || mesh.hasThinInstances ||
      mesh.instancedBuffers?.[SHARED_OUTLINE_ATTRIBUTE] !== undefined);
    return batch;
  }
  /** `render` marks render-time validation, which the same pass's draw may reuse. */
  private ready(subMesh: SubMesh, render: boolean): boolean {
    const source = this.source(subMesh);
    if (!source) return true;
    const mesh = subMesh.getRenderingMesh();
    this.view.owner.prepareRenderSource(mesh);
    this.instances(subMesh);
    const hardware = this.hardware;
    let program = this.programs.get(subMesh);
    if (program && program.source !== source) {
      this.retire(subMesh, program); this.programs.delete(subMesh); program = undefined;
    }
    if (!program) {
      const variant = acquireAuthoredOutlineVariant(source);
      // The engine's CEL adapter changes lighting, not StandardMaterial coverage.
      // Only admit the actual adapter with its original hooks, never an arbitrary
      // custom material that happens to use the same class name.
      const nativeCel = source instanceof CelMaterial && source.hasOriginalShadowHooks();
      if (!variant && !nativeCel && !["StandardMaterial", "PBRMaterial", "PBRMetallicRoughnessMaterial", "PBRSpecularGlossinessMaterial", "BackgroundMaterial"].includes(source.getClassName()))
        throw new Error(`Shared outlines cannot reproduce the coverage of custom material "${source.name}".`);
      program = { source, variant }; this.programs.set(subMesh, program);
    }
    // Any other validation, including a probe, invalidates the draw shortcut.
    program.readyRenderId = undefined;
    if (program.variant) {
      const compiled = program.variant.compiled;
      if (compiled.buildState !== "ready") return false;
      const before = subMesh._getDrawWrapper(this.renderer.renderPassId)?.effect;
      const ready = compiled.material.isReadyForSubMesh(mesh, subMesh, hardware);
      const wrapper = subMesh._getDrawWrapper(this.renderer.renderPassId);
      // NodeMaterial can replace the Effect in an existing wrapper after a
      // texture/deformation define edit. That replaced reference is ours too.
      if (before && wrapper?.effect !== before) this.retirements.push(retireOwnedEffect(before, () => before.dispose()));
      program.wrapper = wrapper;
      if (ready && render) { program.readyRenderId = this.view.scene.getRenderId(); program.readyHardware = hardware; }
      return ready;
    }
    const coverage = source as Material & { opacityFresnelParameters?: { isEnabled: boolean }; useAlphaFresnel?: boolean; _useAlphaFresnel?: boolean };
    if (coverage.opacityFresnelParameters?.isEnabled || coverage.useAlphaFresnel || coverage._useAlphaFresnel)
      throw new Error(`Shared outlines require an authored coverage variant for Fresnel material "${source.name}".`);
    const texture = coverageTexture(source, mesh);
    const opacity = opacityTexture(source);
    const unsupported = texture && texture.coordinatesIndex > 1 ? texture : opacity && opacity.coordinatesIndex > 1 ? opacity : null;
    if (unsupported)
      throw new Error(`Shared outlines do not yet qualify alpha texture UV set ${unsupported.coordinatesIndex + 1} on "${source.name}".`);
    const attributes = [VertexBuffer.PositionKind];
    const defines = ["#define STORE_CAMERASPACE_Z"];
    const uv1 = (samplesUV1(texture) || samplesUV1(opacity)) && mesh.isVerticesDataPresent(VertexBuffer.UVKind);
    const uv2 = (samplesUV2(texture) || samplesUV2(opacity)) && mesh.isVerticesDataPresent(VertexBuffer.UV2Kind);
    if (texture || opacity) {
      defines.push("#define ALPHATEST");
      if (uv1) { attributes.push(VertexBuffer.UVKind); defines.push("#define UV1"); }
      if (uv2) { attributes.push(VertexBuffer.UV2Kind); defines.push("#define UV2"); }
      defineCoverageSampler(defines, texture, "SLATE_DIFFUSE", uv1, uv2);
      defineCoverageSampler(defines, opacity, "SLATE_OPACITY", uv1, uv2);
    }
    const vertexAlpha = mesh.hasVertexAlpha && mesh.useVertexColors && mesh.isVerticesDataPresent(VertexBuffer.ColorKind);
    const instanceAlpha = hardware && mesh.hasThinInstances && mesh.isVerticesDataPresent(VertexBuffer.ColorInstanceKind);
    if (vertexAlpha) { attributes.push(VertexBuffer.ColorKind); defines.push("#define VERTEXCOLOR", "#define VERTEXALPHA"); }
    if (instanceAlpha) { attributes.push(VertexBuffer.ColorInstanceKind); defines.push("#define INSTANCESCOLOR"); }
    if (vertexAlpha || instanceAlpha) defines.push("#define SLATE_VERTEX_ALPHA");
    let cpuSkinning = false;
    if (mesh.useBones && mesh.computeBonesUsingShaders) {
      attributes.push(VertexBuffer.MatricesIndicesKind, VertexBuffer.MatricesWeightsKind);
      if (mesh.numBoneInfluencers > 4) attributes.push(VertexBuffer.MatricesIndicesExtraKind, VertexBuffer.MatricesWeightsExtraKind);
      defines.push(`#define NUM_BONE_INFLUENCERS ${mesh.numBoneInfluencers}`);
      defines.push(mesh.skeleton?.isUsingTextureForMatrices ? "#define BONETEXTURE" : `#define BonesPerMesh ${(mesh.skeleton?.bones.length ?? 0) + 1}`);
      cpuSkinning = mesh.numBoneInfluencers > 0;
    } else defines.push("#define NUM_BONE_INFLUENCERS 0");
    // Color morphs are needed only when their alpha changes visible coverage.
    const morphs = mesh.morphTargetManager ? PrepareDefinesAndAttributesForMorphTargets(mesh.morphTargetManager,
      defines, attributes, mesh, true, false, false, uv1, uv2, vertexAlpha) : 0;
    if (hardware) {
      defines.push("#define INSTANCES"); PushAttributesForInstances(attributes);
      if (mesh.hasThinInstances) defines.push("#define THIN_INSTANCES");
      else attributes.push(SHARED_OUTLINE_ATTRIBUTE);
    }
    if (mesh.bakedVertexAnimationManager?.isEnabled) {
      defines.push("#define BAKED_VERTEX_ANIMATION_TEXTURE");
      if (hardware) attributes.push("bakedVertexAnimationSettingsInstanced");
    }
    PrepareStringDefinesForClipPlanes(source, this.view.scene, defines);
    const joined = defines.join("\n");
    let wrapper = subMesh._getDrawWrapper(this.renderer.renderPassId, true)!;
    if (wrapper.defines !== joined) {
      this.retireWrapper(subMesh, program);
      wrapper = subMesh._getDrawWrapper(this.renderer.renderPassId, true)!;
      const fallbacks = new EffectFallbacks();
      if (cpuSkinning) fallbacks.addCPUSkinningFallback(0, mesh);
      const uniforms = ["world", "viewProjection", "view", "selectionId", "tableSize", "discardNonmembers", "alphaCutoff", "coverageAlpha", "coverageMode", "coverageDiffuse", "diffuseMatrix", "opacityMatrix", "opacityOptions",
        "mBones", "boneTextureInfo", "morphTargetInfluences", "morphTargetCount", "morphTargetTextureInfo", "morphTargetTextureIndices",
        "bakedVertexAnimationSettings", "bakedVertexAnimationTextureSizeInverted", "bakedVertexAnimationTime"];
      AddClipPlaneUniforms(uniforms);
      wrapper.setEffect(this.view.scene.getEngine().createEffect(SHARED_OUTLINE_MASK_SHADER, {
        attributes, uniformsNames: uniforms, uniformBuffersNames: [],
        samplers: ["styleSampler", "diffuseSampler", "opacitySampler", "boneSampler", "morphTargets", "bakedVertexAnimationTexture"],
        defines: joined, fallbacks, onCompiled: null, onError: null,
        indexParameters: { maxSimultaneousMorphTargets: morphs },
        shaderLanguage: this.view.scene.getEngine().isWebGPU ? ShaderLanguage.WGSL : ShaderLanguage.GLSL,
      }, this.view.scene.getEngine()), joined);
    }
    program.wrapper = wrapper;
    const ready = (!texture || texture.isReady()) && (!opacity || opacity.isReady()) && !!wrapper.effect?.isReady();
    if (ready && render) { program.readyRenderId = this.view.scene.getRenderId(); program.readyHardware = hardware; }
    return ready;
  }
  private draw(subMesh: SubMesh): void {
    const original = this.source(subMesh);
    if (!original) return;
    const mesh = subMesh.getRenderingMesh(), effective = subMesh.getEffectiveMesh();
    effective._internalAbstractMeshDataInfo._isActiveIntermediate = false;
    // Keep this submission's mode; ready() refreshes the field after source admission.
    const batch = this.instances(subMesh), hardware = this.hardware;
    // Reuse this pass's render-time validation of the same submesh and mode.
    // LOD and instance-source submeshes are validated here on first submission.
    const prepared = this.programs.get(subMesh);
    const current = prepared?.source === original && prepared.readyRenderId === this.view.scene.getRenderId() &&
      prepared.readyHardware === hardware && !!prepared.wrapper?.effect;
    if (batch.mustReturn || !current && !this.ready(subMesh, true)) { this.renderer.resetRefreshCounter(); return; }
    const engine = this.view.scene.getEngine();
    let orientation = original._getEffectiveOrientation(mesh);
    if (effective._getWorldMatrixDeterminant() < 0)
      orientation = orientation === Material.ClockWiseSideOrientation ? Material.CounterClockWiseSideOrientation : Material.ClockWiseSideOrientation;
    engine.setState(original.backFaceCulling, original.zOffset, undefined, orientation === Material.ClockWiseSideOrientation,
      original.cullBackFaces, undefined, original.zOffsetUnits);
    const program = this.programs.get(subMesh)!, wrapper = program.wrapper!, effect = wrapper.effect!;
    engine.enableEffect(wrapper);
    if (!hardware) mesh._bind(subMesh, effect, original.fillMode);
    if (program.variant) program.variant.compiled.material.bindForSubMesh(effective.getWorldMatrix(), mesh, subMesh);
    else {
      effect.setMatrix("world", effective.getWorldMatrix());
      effect.setMatrix("viewProjection", this.view.scene.getTransformMatrix());
      effect.setMatrix("view", this.view.scene.getViewMatrix());
      const texture = coverageTexture(original, mesh);
      if (texture) { effect.setTexture("diffuseSampler", texture); effect.setMatrix("diffuseMatrix", texture.getTextureMatrix()); }
      const opacity = opacityTexture(original);
      const pbr = original.getClassName().startsWith("PBR");
      if (opacity) {
        effect.setTexture("opacitySampler", opacity); effect.setMatrix("opacityMatrix", opacity.getTextureMatrix());
        effect.setFloat3("opacityOptions", opacity.level, opacity.getAlphaFromRGB ? 1 : 0, pbr ? 1 : 0);
      }
      const tested = original.needAlphaTestingForMesh(mesh);
      const after = pbr || original.transparencyMode !== null;
      effect.setFloat3("coverageMode", tested && !after ? 1 : 0, tested && after ? 1 : 0, original.needAlphaBlendingForMesh(mesh) ? 1 : 0);
      effect.setFloat("coverageDiffuse", (pbr && tested) || usesTextureAlpha(original) ? 1 : 0);
      effect.setFloat("alphaCutoff", alphaCutoff(original));
      BindBonesParameters(mesh, effect); BindMorphTargetParameters(mesh, effect);
      if (mesh.morphTargetManager?.isUsingTextureForTargets) mesh.morphTargetManager._bind(effect);
      mesh.bakedVertexAnimationManager?.bind(effect, hardware);
      BindClipPlane(effect, original, this.view.scene);
    }
    effect.setFloat("coverageAlpha", original.alpha * effective.visibility);
    effect.setFloat("selectionId", this.view.owner.identityFor(effective) || this.view.owner.identityFor(mesh));
    effect.setFloat("discardNonmembers", this.group === "strict" ? 0 : 1);
    effect.setFloat2("tableSize", this.view.tableWidth, this.view.tableHeight);
    effect.setTexture("styleSampler", this.view.styleTexture(this.group));
    this.currentEffect = effect;
    mesh._processRendering(effective, subMesh, effect, original.fillMode, batch, hardware, this.setInstanceWorld);
  }
  private drawList(list: SmartArray<SubMesh>): void {
    for (let i = 0; i < list.length; i++) this.draw(list.data[i]!);
  }
  private retireWrapper(subMesh: SubMesh, program: MaskProgram): void {
    const wrapper = program.wrapper ?? subMesh._getDrawWrapper(this.renderer.renderPassId);
    if (!wrapper) return;
    if (subMesh._getDrawWrapper(this.renderer.renderPassId) === wrapper) subMesh._removeDrawWrapper(this.renderer.renderPassId, false);
    if (wrapper.effect) subMesh.getRenderingMesh().geometry?._releaseVertexArrayObject(wrapper.effect);
    this.retirements.push(retireOwnedEffect(wrapper.effect, () => wrapper.dispose(true)));
    program.wrapper = undefined;
  }
  private retire(subMesh: SubMesh, program: MaskProgram): void {
    this.retireWrapper(subMesh, program);
    if (program.variant) {
      const pending = [...this.retirements];
      let released = false;
      const disposal = Promise.all(pending.map((entry) => entry.released)).then(() => program.variant!.release()).then(() => { released = true; });
      const completion = Promise.all(pending.map((entry) => entry.completion)).then(() => disposal);
      void completion.catch(() => {});
      this.retirements.push({ completion, released: disposal, isReleased: () => released });
    }
  }
  dispose(): void {
    if (this.disposed) return; this.disposed = true;
    for (const [subMesh, program] of this.programs) this.retire(subMesh, program);
    this.programs.clear();
  }
  async whenDisposed(): Promise<void> { await Promise.all(this.retirements.map((entry) => entry.completion)); }
  async whenReleased(): Promise<void> { await Promise.all(this.retirements.map((entry) => entry.released)); }
}

function alphaCutoff(material: Material): number {
  const values = material as Material & { alphaCutOff?: number; _alphaCutOff?: number };
  return values.alphaCutOff ?? values._alphaCutOff ?? 0.4;
}
function opacityTexture(material: Material): BaseTexture | null {
  const values = material as Material & { opacityTexture?: BaseTexture | null; _opacityTexture?: BaseTexture | null };
  return values.opacityTexture ?? values._opacityTexture ?? null;
}
/** Coverage samplers read UV2 for coordinate index 1 and UV1 otherwise. */
function samplesUV1(texture: BaseTexture | null): boolean { return !!texture && texture.coordinatesIndex !== 1; }
function samplesUV2(texture: BaseTexture | null): boolean { return texture?.coordinatesIndex === 1; }
function defineCoverageSampler(defines: string[], sampled: BaseTexture | null, prefix: string, uv1: boolean, uv2: boolean): void {
  if (!sampled) return;
  defines.push(`#define ${prefix}`);
  if (sampled.coordinatesIndex === 1 && uv2) defines.push(`#define ${prefix}_UV2`);
  else if (sampled.coordinatesIndex !== 1 && uv1) defines.push(`#define ${prefix}_UV1`);
}
function usesTextureAlpha(material: Material): boolean {
  const flags = material as Material & { useAlphaFromDiffuseTexture?: boolean; _useAlphaFromAlbedoTexture?: boolean };
  return material.transparencyMode !== Material.MATERIAL_OPAQUE && !!(flags.useAlphaFromDiffuseTexture || flags._useAlphaFromAlbedoTexture);
}
function coverageTexture(material: Material, mesh: AbstractMesh) {
  const texture = material.getAlphaTestTexture();
  return material.needAlphaTestingForMesh(mesh) || material.needAlphaBlendingForMesh(mesh) && texture?.hasAlpha &&
    usesTextureAlpha(material) ? texture : null;
}
