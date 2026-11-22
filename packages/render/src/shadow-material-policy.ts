import { NodeMaterialModes } from "@babylonjs/core/Materials/Node/Enums/nodeMaterialModes";
import { NodeMaterial } from "@babylonjs/core/Materials/Node/nodeMaterial";
import { PBRAnisotropicConfiguration } from "@babylonjs/core/Materials/PBR/pbrAnisotropicConfiguration";
import { PBRBRDFConfiguration } from "@babylonjs/core/Materials/PBR/pbrBRDFConfiguration";
import { PBRClearCoatConfiguration } from "@babylonjs/core/Materials/PBR/pbrClearCoatConfiguration";
import { PBRIridescenceConfiguration } from "@babylonjs/core/Materials/PBR/pbrIridescenceConfiguration";
import { PBRMaterial } from "@babylonjs/core/Materials/PBR/pbrMaterial";
import { PBRSheenConfiguration } from "@babylonjs/core/Materials/PBR/pbrSheenConfiguration";
import { PBRSubSurfaceConfiguration } from "@babylonjs/core/Materials/PBR/pbrSubSurfaceConfiguration";
import { Material } from "@babylonjs/core/Materials/material";
import { DetailMapConfiguration } from "@babylonjs/core/Materials/material.detailMapConfiguration";
import { StandardMaterial } from "@babylonjs/core/Materials/standardMaterial";
import type { AbstractMesh } from "@babylonjs/core/Meshes/abstractMesh";
import { InstancedMesh } from "@babylonjs/core/Meshes/instancedMesh";
import { Mesh } from "@babylonjs/core/Meshes/mesh";
import { FoliageFadePlugin } from "./foliage-fade";
import { TextureQualityPlugin } from "./texture-quality";
import { LatticeDeformerPlugin } from "./lattice-deformer-native";
import { activeMeshLatticeBinding, isCageOnlyShadowWrapper } from "./lattice-deformer-binding";

const compiled = new WeakSet<NodeMaterial>();
const compiledShape = new WeakMap<
  NodeMaterial,
  {
    buildId: number;
    resolver: Material["customShaderNameResolve"];
    observers: readonly unknown[];
  }
>();

/** Compiler-only opt-in after a successful opaque, identity-WPO surface build. */
export function registerCacheableShadowMaterial(material: NodeMaterial): void {
  compiled.add(material);
  compiledShape.set(material, {
    buildId: material.buildId,
    resolver: material.customShaderNameResolve,
    observers: [...material.onBindObservable.observers],
  });
}

// Installed Babylon 9.29's native plugins, Haptic's mip bias, foliage fade and Standard fog change
// surface shading, not vertices. Alpha coverage is rejected separately below.
// Exact constructors reject derived/custom plugins even when they use a native name.
const nativePlugins = new Set<unknown>([
  DetailMapConfiguration,
  PBRAnisotropicConfiguration,
  PBRBRDFConfiguration,
  PBRClearCoatConfiguration,
  PBRIridescenceConfiguration,
  PBRSheenConfiguration,
  PBRSubSurfaceConfiguration,
  FoliageFadePlugin,
  TextureQualityPlugin,
  LatticeDeformerPlugin,
]);

/**
 * True when nothing the material or its plugins do can move vertices off the mesh's geometry:
 * Babylon's stock PBR/Standard vertex stage with native or surface-only plugins, or a compiled
 * opaque surface whose World Position Offset is the identity and whose build is unchanged.
 * Custom, Cel, partly compiled and shader-authored materials are not.
 */
export function hasStockVertexStage(material: Material): boolean {
  if (
    material.pluginManager?._plugins.some(
      (plugin) => !nativePlugins.has(plugin.constructor),
    )
  )
    return false;
  const constructor = material.constructor;
  if (constructor === NodeMaterial) {
    const node = material as NodeMaterial;
    const shape = compiledShape.get(node);
    return (
      compiled.has(node) &&
      node.mode === NodeMaterialModes.Material &&
      !!shape &&
      shape.buildId === node.buildId &&
      shape.resolver === node.customShaderNameResolve &&
      shape.observers.length === node.onBindObservable.observers.length &&
      shape.observers.every(
        (observer, index) =>
          observer === node.onBindObservable.observers[index],
      )
    );
  }
  return (
    (constructor === PBRMaterial || constructor === StandardMaterial) &&
    !material.customShaderNameResolve &&
    !material.onBindObservable.hasObservers()
  );
}

/**
 * `hasStockVertexStage`, or a compiled surface whose first build is still pending and whose plan has the stock vertex
 * stage (`plannedStockVertexStage`, set by the compiler before the build): grouping by it need not wait for the build.
 */
export function hasStockOrPlannedVertexStage(material: Material): boolean {
  if (hasStockVertexStage(material)) return true;
  if (!(material instanceof NodeMaterial) || compiled.has(material)) return false;
  if (material.pluginManager?._plugins.some((plugin) => !nativePlugins.has(plugin.constructor))) return false;
  return (material.metadata as { plannedStockVertexStage?: boolean } | null)?.plannedStockVertexStage === true;
}

/**
 * True when a mesh's thin instances keep their placements: static matrix and attribute buffers, which change only
 * through `thinInstanceSetBuffer` (a new buffer) or a per-instance setter, both of which the refresh scheduler tracks.
 */
export function hasStaticThinInstances(mesh: Mesh): boolean {
  if (mesh.thinInstanceAllowAutomaticStaticBufferRecreation) return false;
  const thin = mesh._thinInstanceDataStorage;
  if (thin.matrixBuffer?.isUpdatable() || thin.previousMatrixBuffer?.isUpdatable()) return false;
  for (const kind in mesh._userThinInstanceBuffersStorage?.vertexBuffers ?? {})
    if (mesh._userThinInstanceBuffersStorage.vertexBuffers[kind]?.isUpdatable()) return false;
  return true;
}

/** Conservative shape eligibility; the refresh scheduler tracks mutable depth/culling state. */
export function canCacheShadowMaterial(
  material: Material,
  mesh: AbstractMesh,
): boolean {
  // An instance draws its source's geometry, deformers and material at its own world matrix, which the refresh
  // scheduler tracks per caster: it caches as its source would (render hooks exist on the source only).
  const source = mesh instanceof InstancedMesh ? mesh.sourceMesh : mesh;
  return canCacheShadowMesh(mesh) && canCacheShadowMaterialFor(material, source.hasVertexAlpha);
}

/**
 * The mesh's part of `canCacheShadowMaterial`: a source `Mesh` without deformers, dynamic thin instances or render
 * hooks, fully visible. A lattice cage counts as no deformer when it widened the mesh's bounds to its hull
 * (`LatticeBinding.widens`) and an instance's source draws with the same cage: what it draws then follows the cage's
 * revision, the root's and the mesh's world matrices and the geometry, all of which the refresh scheduler tracks.
 */
export function canCacheShadowMesh(mesh: AbstractMesh): boolean {
  const source = mesh instanceof InstancedMesh ? mesh.sourceMesh : mesh;
  const cage = activeMeshLatticeBinding(mesh);
  if (cage && !cage.widens(mesh)) return false;
  if (source !== mesh && activeMeshLatticeBinding(source) !== cage) return false;
  return !(
    !(source instanceof Mesh) ||
    source.skeleton ||
    source.morphTargetManager ||
    source.bakedVertexAnimationManager ||
    (source.hasThinInstances && !hasStaticThinInstances(source)) ||
    source.onBeforeRenderObservable.hasObservers() ||
    source.onBeforeBindObservable.hasObservers() ||
    source.visibility !== 1
  );
}

/** What `needAlphaBlendingForMesh` reads of a fully visible mesh: its visibility and whether it has vertex alpha. */
const fullyVisible = [{ visibility: 1, hasVertexAlpha: false }, { visibility: 1, hasVertexAlpha: true }] as unknown as readonly [AbstractMesh, AbstractMesh];

/**
 * The Material's part of `canCacheShadowMaterial` for a mesh that passes `canCacheShadowMesh` (so fully visible), given
 * only whether it has vertex alpha: the same for every such mesh. The stock vertex stage is asked first: only Babylon
 * 9.29's exact PBR, Standard and Node Materials pass it, and their `needAlphaBlendingForMesh` and
 * `needAlphaTestingForMesh` (Material's own) read nothing else of the mesh.
 */
export function canCacheShadowMaterialFor(material: Material, hasVertexAlpha: boolean): boolean {
  if (!hasStockVertexStage(material)) return false;
  const padding = Number(material.metadata?.boundsPadding ?? 0);
  if (!Number.isFinite(padding) || padding > 0) return false;
  const mesh = fullyVisible[hasVertexAlpha ? 1 : 0];
  if (
    material.alpha !== 1 ||
    // A wrapper only cages use draws a mesh without one as the stock depth program does, and a caged mesh by its cage,
    // which `canCacheShadowMesh` vouches for.
    (material.shadowDepthWrapper && !isCageOnlyShadowWrapper(material.shadowDepthWrapper)) ||
    (material.transparencyMode !== null &&
      material.transparencyMode !== Material.MATERIAL_OPAQUE) ||
    material.needAlphaBlendingForMesh(mesh) ||
    material.needAlphaTestingForMesh(mesh)
  )
    return false;
  return !(
    material.clipPlane ||
    material.clipPlane2 ||
    material.clipPlane3 ||
    material.clipPlane4 ||
    material.clipPlane5 ||
    material.clipPlane6
  );
}
