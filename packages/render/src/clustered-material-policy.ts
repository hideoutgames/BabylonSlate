import {
  DetailMapConfiguration,
  InstancedMesh,
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
  type AbstractMesh,
  type Observer,
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
    return (
      material.subMaterials
        .map((child) => child && unqualifiedNativeFeature(child))
        .find(Boolean) ?? undefined
    );
  if (material.constructor === CelMaterial)
    return unqualifiedNativeFeature((material as CelMaterial).source);
  if (material instanceof PBRMaterial) {
    if (material.clearCoat.isEnabled) return "Clear Coat";
    if (material.anisotropy.isEnabled) return "Anisotropy";
    if (material.iridescence.isEnabled) return "Iridescence";
    if (material.sheen.isEnabled) return "Sheen";
    const sub = material.subSurface;
    if (
      sub.isRefractionEnabled ||
      sub.isTranslucencyEnabled ||
      sub.isScatteringEnabled ||
      sub.isDispersionEnabled
    )
      return "Subsurface";
  }
  if (
    (material instanceof PBRMaterial || material instanceof StandardMaterial) &&
    material.detailMap.isEnabled
  )
    return "Detail Map";
  return undefined;
}

type MaterialConsumers = {
  material: Material;
  meshes: { mesh: AbstractMesh; index: number }[];
};

const consumersByScene = new WeakMap<Scene, SceneMaterialConsumers>();

/** Cache assignments, not verdicts: Babylon exposes mutable material contracts without change events. */
class SceneMaterialConsumers {
  private readonly scene: Scene;
  private readonly watched = new Map<AbstractMesh, Observer<AbstractMesh>>();
  private readonly groups: MaterialConsumers[] = [];
  private dirty = true;
  private meshCount = -1;
  private defaultMaterial: Material | undefined;

  constructor(scene: Scene) {
    this.scene = scene;
    const added = scene.onNewMeshAddedObservable.add((mesh) => {
      // Add notifications are deferred, including those for already-removed
      // cluster proxy meshes. Counts cover real additions before notification.
      if (!this.watched.has(mesh) && scene.meshes.includes(mesh))
        this.invalidate();
    });
    const removed = scene.onMeshRemovedObservable.add((mesh) => {
      if (this.watched.has(mesh)) this.invalidate();
    });
    scene.onDisposeObservable.addOnce(() => {
      scene.onNewMeshAddedObservable.remove(added);
      scene.onMeshRemovedObservable.remove(removed);
      this.invalidate();
      consumersByScene.delete(scene);
    });
  }

  private invalidate = (): void => {
    this.dirty = true;
    // Release removed/reassigned consumers even if the next request is Forward.
    this.groups.length = 0;
    for (const [mesh, observer] of this.watched)
      mesh.onMaterialChangedObservable.remove(observer);
    this.watched.clear();
  };

  private watch(mesh: AbstractMesh): void {
    if (this.watched.has(mesh)) return;
    this.watched.set(
      mesh,
      mesh.onMaterialChangedObservable.add(this.invalidate),
    );
  }

  current(): readonly MaterialConsumers[] {
    const scene = this.scene;
    const fallback = scene.defaultMaterial;
    if (
      !this.dirty &&
      this.meshCount === scene.meshes.length &&
      this.defaultMaterial === fallback
    )
      return this.groups;

    this.invalidate();
    const byMaterial = new Map<Material, MaterialConsumers>();
    for (let index = 0; index < scene.meshes.length; index++) {
      const mesh = scene.meshes[index]!;
      this.watch(mesh);
      // Instances inherit assignments from their source, even if it is detached
      // from the scene. Their own material observable does not notify on edits.
      if (mesh instanceof InstancedMesh) this.watch(mesh.sourceMesh);
      const material = mesh.material ?? fallback;
      let group = byMaterial.get(material);
      if (!group) {
        group = { material, meshes: [] };
        byMaterial.set(material, group);
        this.groups.push(group);
      }
      group.meshes.push({ mesh, index });
    }
    this.meshCount = scene.meshes.length;
    this.defaultMaterial = fallback;
    this.dirty = false;
    return this.groups;
  }
}

/** Inspect actual scene consumers; unused preview/proxy/post-process materials do not select the path. */
export function clusteredSceneMaterialReason(scene: Scene): string | undefined {
  if (!scene.lightsEnabled)
    return "This scene does not use lighting; using Forward.";
  if (scene.isDisposed) return undefined;
  let consumers = consumersByScene.get(scene);
  if (!consumers) {
    consumers = new SceneMaterialConsumers(scene);
    consumersByScene.set(scene, consumers);
  }
  let firstIndex = Infinity;
  let reason: string | undefined;
  for (const group of consumers.current()) {
    if (group.meshes[0]!.index >= firstIndex) break;
    const material = group.material;
    const feature = unqualifiedNativeFeature(material);
    if (!feature && compatible(material)) continue;
    // Only rejected contracts need a drawable consumer. Geometry can change
    // without a material/membership event; check it live and retain the first
    // drawable mesh's reason in scene order, rather than group insertion order.
    for (const { mesh, index } of group.meshes) {
      if (index >= firstIndex) break;
      if (!mesh.getTotalVertices()) continue;
      firstIndex = index;
      reason = feature
        ? `Material "${material.name}" enables ${feature}, whose combined clustered sampler contract is not qualified; using Forward.`
        : `Material "${material.name}" has no supported clustered lighting contract; using Forward.`;
      break;
    }
  }
  return reason;
}
