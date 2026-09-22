import {
  Constants, EffectFallbacks, Material, ShaderLanguage, VertexBuffer,
  type AbstractMesh, type BaseTexture, type DrawWrapper, type SubMesh,
} from "@babylonjs/core";
import type { ObjectRenderer } from "@babylonjs/core/Rendering/objectRenderer";
import { AddClipPlaneUniforms, BindClipPlane, PrepareStringDefinesForClipPlanes } from "@babylonjs/core/Materials/clipPlaneMaterialHelper";
import { BindBonesParameters, BindMorphTargetParameters, PrepareDefinesAndAttributesForMorphTargets, PushAttributesForInstances } from "@babylonjs/core/Materials/materialHelper.functions";
import { retireOwnedEffect, type OwnedEffectRetirement } from "./owned-effect-retirement";
import { SHARED_OUTLINE_ATTRIBUTE, type SharedOutlineGroup, type SharedOutlineView } from "./shared-outline";
import { SHARED_OUTLINE_MASK_SHADER } from "./shared-outline-shaders";
import { acquireAuthoredOutlineVariant, type AuthoredOutlineVariant } from "./material-compiler";

type MaskProgram = { source: Material; wrapper?: DrawWrapper; variant?: AuthoredOutlineVariant };

/** Native submesh submission with pass-owned programs; original materials never change. */
export class SharedOutlineMaskRenderer {
  private readonly programs = new Map<SubMesh, MaskProgram>();
  private readonly retirements: OwnedEffectRetirement[] = [];
  private disposed = false;
  constructor(private readonly renderer: ObjectRenderer, private readonly view: SharedOutlineView, private readonly group: SharedOutlineGroup) {
    renderer.customIsReadyFunction = (mesh) => {
      if (this.disposed || mesh.isDisposed()) return false;
      // The renderer performs LOD selection after this callback. Check both the
      // source here and the actual LOD again before submission.
      return (mesh.subMeshes ?? []).every((subMesh) => this.ready(subMesh));
    };
    renderer.customRenderFunction = (opaque, tested, transparent, depthOnly) => {
      const engine = view.scene.getEngine();
      const alpha = engine.getAlphaMode(), color = engine.getColorWrite();
      const depth = engine.getDepthBuffer(), write = engine.getDepthWrite();
      try {
        engine.setAlphaMode(Constants.ALPHA_DISABLE);
        engine.setDepthBuffer(true); engine.setDepthWrite(true);
        engine.setColorWrite(false);
        for (let i = 0; i < depthOnly.length; i++) this.draw(depthOnly.data[i]!);
        engine.setColorWrite(true);
        for (const list of [opaque, tested, transparent])
          for (let i = 0; i < list.length; i++) this.draw(list.data[i]!);
      } finally {
        engine.setAlphaMode(alpha); engine.setColorWrite(color);
        engine.setDepthBuffer(depth); engine.setDepthWrite(write);
      }
    };
  }
  /** Drop removed geometry without recompiling or rebuilding unchanged programs. */
  prune(): void {
    for (const [subMesh, program] of this.programs)
      if (subMesh.getMesh().isDisposed() || !subMesh.getRenderingMesh().subMeshes?.includes(subMesh)) {
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
    const batch = mesh._getInstancesRenderList(subMesh._id, !!subMesh.getReplacementMesh());
    return { batch, hardware: !!batch.hardwareInstancedRendering[subMesh._id] || mesh.hasThinInstances ||
      !!mesh._userInstancedBuffersStorage?.vertexBuffers[SHARED_OUTLINE_ATTRIBUTE] };
  }
  private ready(subMesh: SubMesh): boolean {
    const source = this.source(subMesh);
    if (!source) return true;
    const mesh = subMesh.getRenderingMesh();
    this.view.owner.prepareRenderSource(mesh);
    const { hardware } = this.instances(subMesh);
    let program = this.programs.get(subMesh);
    if (program && program.source !== source) {
      this.retire(subMesh, program); this.programs.delete(subMesh); program = undefined;
    }
    if (!program) {
      const variant = acquireAuthoredOutlineVariant(source);
      if (!variant && !["StandardMaterial", "PBRMaterial", "PBRMetallicRoughnessMaterial", "PBRSpecularGlossinessMaterial", "BackgroundMaterial"].includes(source.getClassName()))
        throw new Error(`Shared outlines cannot reproduce the coverage of custom material "${source.name}".`);
      program = { source, variant }; this.programs.set(subMesh, program);
    }
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
      return ready;
    }
    const coverage = source as Material & { opacityFresnelParameters?: { isEnabled: boolean }; useAlphaFresnel?: boolean; _useAlphaFresnel?: boolean };
    if (coverage.opacityFresnelParameters?.isEnabled || coverage.useAlphaFresnel || coverage._useAlphaFresnel)
      throw new Error(`Shared outlines require an authored coverage variant for Fresnel material "${source.name}".`);
    const texture = coverageTexture(source, mesh);
    const opacity = opacityTexture(source);
    for (const sampled of [texture, opacity]) if (sampled && sampled.coordinatesIndex > 1)
      throw new Error(`Shared outlines do not yet qualify alpha texture UV set ${sampled.coordinatesIndex + 1} on "${source.name}".`);
    const attributes = [VertexBuffer.PositionKind];
    const defines = ["#define STORE_CAMERASPACE_Z"];
    const uv1 = [texture, opacity].some((sampled) => sampled && sampled.coordinatesIndex !== 1) && mesh.isVerticesDataPresent(VertexBuffer.UVKind);
    const uv2 = [texture, opacity].some((sampled) => sampled?.coordinatesIndex === 1) && mesh.isVerticesDataPresent(VertexBuffer.UV2Kind);
    if (texture || opacity) {
      defines.push("#define ALPHATEST");
      if (uv1) { attributes.push(VertexBuffer.UVKind); defines.push("#define UV1"); }
      if (uv2) { attributes.push(VertexBuffer.UV2Kind); defines.push("#define UV2"); }
      for (const [sampled, prefix] of [[texture, "SLATE_DIFFUSE"], [opacity, "SLATE_OPACITY"]] as const) if (sampled) {
        defines.push(`#define ${prefix}`);
        if (sampled.coordinatesIndex === 1 && uv2) defines.push(`#define ${prefix}_UV2`);
        else if (sampled.coordinatesIndex !== 1 && uv1) defines.push(`#define ${prefix}_UV1`);
      }
    }
    const vertexAlpha = mesh.hasVertexAlpha && mesh.useVertexColors && mesh.isVerticesDataPresent(VertexBuffer.ColorKind);
    const instanceAlpha = hardware && mesh.hasThinInstances && mesh.isVerticesDataPresent(VertexBuffer.ColorInstanceKind);
    if (vertexAlpha) { attributes.push(VertexBuffer.ColorKind); defines.push("#define VERTEXCOLOR", "#define VERTEXALPHA"); }
    if (instanceAlpha) { attributes.push(VertexBuffer.ColorInstanceKind); defines.push("#define INSTANCESCOLOR"); }
    if (vertexAlpha || instanceAlpha) defines.push("#define SLATE_VERTEX_ALPHA");
    const fallbacks = new EffectFallbacks();
    if (mesh.useBones && mesh.computeBonesUsingShaders) {
      attributes.push(VertexBuffer.MatricesIndicesKind, VertexBuffer.MatricesWeightsKind);
      if (mesh.numBoneInfluencers > 4) attributes.push(VertexBuffer.MatricesIndicesExtraKind, VertexBuffer.MatricesWeightsExtraKind);
      defines.push(`#define NUM_BONE_INFLUENCERS ${mesh.numBoneInfluencers}`);
      defines.push(mesh.skeleton?.isUsingTextureForMatrices ? "#define BONETEXTURE" : `#define BonesPerMesh ${(mesh.skeleton?.bones.length ?? 0) + 1}`);
      if (mesh.numBoneInfluencers > 0) fallbacks.addCPUSkinningFallback(0, mesh);
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
      const uniforms = ["world", "viewProjection", "view", "selectionId", "tableSize", "discardNonmembers", "alphaCutoff", "coverageAlpha", "coverageMode", "coverageDiffuse", "diffuseMatrix", "opacityMatrix", "opacityOptions",
        "mBones", "boneTextureInfo", "morphTargetInfluences", "morphTargetCount", "morphTargetTextureInfo", "morphTargetTextureIndices",
        "bakedVertexAnimationSettings", "bakedVertexAnimationTextureSizeInverted", "bakedVertexAnimationTime"];
      AddClipPlaneUniforms(uniforms);
      wrapper.setEffect(this.view.scene.getEngine().createEffect(SHARED_OUTLINE_MASK_SHADER, {
        attributes, uniformsNames: uniforms, uniformBuffersNames: [],
        samplers: ["styleSampler", "diffuseSampler", "opacitySampler", "boneSampler", "morphTargets", "bakedVertexAnimationTexture"],
        defines: joined, fallbacks, indexParameters: { maxSimultaneousMorphTargets: morphs },
        shaderLanguage: this.view.scene.getEngine().isWebGPU ? ShaderLanguage.WGSL : ShaderLanguage.GLSL,
      }, this.view.scene.getEngine()), joined);
    }
    program.wrapper = wrapper;
    return (!texture || texture.isReady()) && (!opacity || opacity.isReady()) && !!wrapper.effect?.isReady();
  }
  private draw(subMesh: SubMesh): void {
    const original = this.source(subMesh);
    if (!original) return;
    const mesh = subMesh.getRenderingMesh(), effective = subMesh.getEffectiveMesh();
    effective._internalAbstractMeshDataInfo._isActiveIntermediate = false;
    const { batch, hardware } = this.instances(subMesh);
    if (batch.mustReturn || !this.ready(subMesh)) { this.renderer.resetRefreshCounter(); return; }
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
    mesh._processRendering(effective, subMesh, effect, original.fillMode, batch, hardware, (_instance, world) => effect.setMatrix("world", world));
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
function usesTextureAlpha(material: Material): boolean {
  const flags = material as Material & { useAlphaFromDiffuseTexture?: boolean; _useAlphaFromAlbedoTexture?: boolean };
  return material.transparencyMode !== Material.MATERIAL_OPAQUE && !!(flags.useAlphaFromDiffuseTexture || flags._useAlphaFromAlbedoTexture);
}
function coverageTexture(material: Material, mesh: AbstractMesh) {
  const texture = material.getAlphaTestTexture();
  return material.needAlphaTestingForMesh(mesh) || material.needAlphaBlendingForMesh(mesh) && texture?.hasAlpha &&
    usesTextureAlpha(material) ? texture : null;
}
