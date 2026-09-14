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
  if (material.constructor === CelMaterial)
    return (
      (material as CelMaterial).hasOriginalShadowHooks() &&
      compatible((material as CelMaterial).source)
    );
  if (
    material.constructor !== PBRMaterial &&
    material.constructor !== StandardMaterial
  )
    return false;
  if (material.customShaderNameResolve) return false;
  return !material.pluginManager?._plugins.some(
    (plugin) => !nativePlugins.has(plugin.constructor),
  );
}

/** Inspect actual scene consumers; unused preview/proxy/post-process materials do not select the path. */
export function clusteredSceneMaterialReason(scene: Scene): string | undefined {
  if (!scene.lightsEnabled)
    return "This scene does not use lighting; using Forward.";
  for (const mesh of scene.meshes) {
    // Empty transform/proxy nodes do not submit a material pass.
    if (!mesh.getTotalVertices()) continue;
    const material = mesh.material ?? scene.defaultMaterial;
    if (!compatible(material))
      return `Material ?${material.name}? has no supported clustered lighting contract; using Forward.`;
  }
  return undefined;
}
