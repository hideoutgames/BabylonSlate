import {
  DetailMapConfiguration,
  Material,
  Mesh,
  NodeMaterial,
  NodeMaterialModes,
  PBRAnisotropicConfiguration,
  PBRBRDFConfiguration,
  PBRClearCoatConfiguration,
  PBRIridescenceConfiguration,
  PBRMaterial,
  PBRSheenConfiguration,
  PBRSubSurfaceConfiguration,
  StandardMaterial,
  type AbstractMesh,
} from "@babylonjs/core";
import { CelMaterial } from "./cel-material";
import { TextureQualityPlugin } from "./texture-quality";

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

// Installed Babylon 9.20's native plugins and Slate's mip bias change surface
// shading, not vertices. Alpha coverage is rejected separately below.
// Exact constructors reject derived/custom plugins even when they use a native name.
const nativePlugins = new Set<unknown>([
  DetailMapConfiguration,
  PBRAnisotropicConfiguration,
  PBRBRDFConfiguration,
  PBRClearCoatConfiguration,
  PBRIridescenceConfiguration,
  PBRSheenConfiguration,
  PBRSubSurfaceConfiguration,
  TextureQualityPlugin,
]);

/** Conservative shape eligibility; the refresh scheduler tracks mutable depth/culling state. */
export function canCacheShadowMaterial(
  material: Material,
  mesh: AbstractMesh,
): boolean {
  const padding = Number(material.metadata?.boundsPadding ?? 0);
  if (!Number.isFinite(padding) || padding > 0) return false;
  if (
    !(mesh instanceof Mesh) ||
    mesh.skeleton ||
    mesh.morphTargetManager ||
    mesh.bakedVertexAnimationManager ||
    mesh.hasThinInstances ||
    mesh.instances.length > 0 ||
    mesh.onBeforeRenderObservable.hasObservers() ||
    mesh.onBeforeBindObservable.hasObservers()
  )
    return false;
  if (
    material.alpha !== 1 ||
    mesh.visibility !== 1 ||
    material.shadowDepthWrapper ||
    (material.transparencyMode !== null &&
      material.transparencyMode !== Material.MATERIAL_OPAQUE) ||
    material.needAlphaBlendingForMesh(mesh) ||
    material.needAlphaTestingForMesh(mesh)
  )
    return false;
  if (
    material.clipPlane ||
    material.clipPlane2 ||
    material.clipPlane3 ||
    material.clipPlane4 ||
    material.clipPlane5 ||
    material.clipPlane6
  )
    return false;
  if (
    material.pluginManager?._plugins.some(
      (plugin) => !nativePlugins.has(plugin.constructor),
    )
  )
    return false;

  if (material.constructor === NodeMaterial) {
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
  if (material.constructor === CelMaterial) {
    const cel = material as CelMaterial;
    return (
      cel.hasOriginalShadowHooks() && canCacheShadowMaterial(cel.source, mesh)
    );
  }
  return (
    (material.constructor === PBRMaterial ||
      material.constructor === StandardMaterial) &&
    !material.customShaderNameResolve &&
    !material.onBindObservable.hasObservers()
  );
}
