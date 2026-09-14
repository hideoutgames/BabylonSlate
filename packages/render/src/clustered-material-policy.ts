import {
  DetailMapConfiguration,
  LightBlock,
  Material,
  MultiMaterial,
  NodeMaterial,
  NodeMaterialModes,
  PBRAnisotropicConfiguration,
  PBRBRDFConfiguration,
  PBRClearCoatConfiguration,
  PBRIridescenceConfiguration,
  PBRMaterial,
  PBRMetallicRoughnessBlock,
  PBRSheenConfiguration,
  PBRSubSurfaceConfiguration,
  StandardMaterial,
  type Scene,
} from "@babylonjs/core";
import { CelMaterial } from "./cel-material";
import { TextureQualityPlugin } from "./texture-quality";

const compiled = new WeakMap<NodeMaterial, number>();
const unlit = new WeakSet<Material>();

/** Owned editor helpers whose shaders never read scene lights. */
export function registerClusteredUnlitMaterial(material: Material): void {
  unlit.add(material);
}

/** Only a successfully lowered surface without custom shader code opts in. */
export function registerClusteredSurfaceMaterial(material: NodeMaterial): void {
  compiled.set(material, material.buildId);
}

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

function compatible(material: Material): boolean {
  if (unlit.has(material)) return true;
  if (material instanceof MultiMaterial)
    return material.subMaterials.every((child) => !child || compatible(child));
  if (material instanceof NodeMaterial) {
    if (material.mode !== NodeMaterialModes.Material) return true;
    // External graphs and out-of-band rebuilds have no proven per-child CEL/PBR contract.
    if (compiled.get(material) !== material.buildId) return false;
    return material.attachedBlocks.every(
      (block) =>
        !(
          block instanceof LightBlock ||
          block instanceof PBRMetallicRoughnessBlock
        ) || !block.light,
    );
  }
  const constructor = material.constructor;
  if (constructor === CelMaterial)
    return (
      (material as CelMaterial).hasOriginalShadowHooks() &&
      compatible((material as CelMaterial).source)
    );
  if (constructor !== PBRMaterial && constructor !== StandardMaterial)
    return false;
  if (
    Boolean(material.customShaderNameResolve) ||
    material.onBindObservable.hasObservers()
  )
    return false;
  return !material.pluginManager?._plugins.some(
    (plugin) => !nativePlugins.has(plugin.constructor),
  );
}


function unqualifiedNativeFeature(material: Material): string | undefined {
  if (material instanceof MultiMaterial)
    return material.subMaterials.map((child) => child && unqualifiedNativeFeature(child)).find(Boolean) ?? undefined;
  if (material.constructor === CelMaterial)
    return unqualifiedNativeFeature((material as CelMaterial).source);
  if (material instanceof PBRMaterial) {
    if (material.clearCoat.isEnabled) return "Clear Coat";
    if (material.anisotropy.isEnabled) return "Anisotropy";
    if (material.iridescence.isEnabled) return "Iridescence";
    if (material.sheen.isEnabled) return "Sheen";
    const sub = material.subSurface;
    if (sub.isRefractionEnabled || sub.isTranslucencyEnabled || sub.isScatteringEnabled || sub.isDispersionEnabled)
      return "Subsurface";
  }
  if ((material instanceof PBRMaterial || material instanceof StandardMaterial) && material.detailMap.isEnabled)
    return "Detail Map";
  return undefined;
}

/** Inspect actual scene consumers; unused preview/proxy/post-process materials do not select the path. */
export function clusteredSceneMaterialReason(scene: Scene): string | undefined {
  if (!scene.lightsEnabled)
    return "This scene does not use lighting; using Forward.";
  for (const mesh of scene.meshes) {
    // Empty transform/proxy nodes do not submit a material pass.
    if (!mesh.getTotalVertices()) continue;
    const material = mesh.material ?? scene.defaultMaterial;
    const feature = unqualifiedNativeFeature(material);
    if (feature)
      return `Material "${material.name}" enables ${feature}, whose combined clustered sampler contract is not qualified; using Forward.`;
    if (!compatible(material))
      return `Material "${material.name}" has no supported clustered lighting contract; using Forward.`;
  }
  return undefined;
}
