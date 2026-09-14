import "./texture-quality";
import { syncForwardLightPolicy } from "./light-policy";
import { forwardLightBudget } from "./forward-light-budget";
import { clusteredLightingLimits, syncClusteredLightPolicy } from "./clustered-light-policy";
import {
  Material,
  NodeMaterial,
  NodeMaterialModes,
  type Light,
  type Observer,
  type Scene,
} from "@babylonjs/core";

type LitMaterial = Material & { maxSimultaneousLights: number };

function isLitMaterial(material: Material): material is LitMaterial {
  if (!("maxSimultaneousLights" in material)) return false;
  if ("disableLighting" in material && material.disableLighting === true)
    return false;
  if ("unlit" in material && material.unlit === true) return false;
  if (material instanceof NodeMaterial) {
    return (
      material.mode === NodeMaterialModes.Material &&
      material.attachedBlocks.some(
        (block) =>
          block.getClassName() === "PBRMetallicRoughnessBlock" ||
          block.getClassName() === "CelLightBlock" ||
          block.getClassName() === "LightBlock",
      )
    );
  }
  return typeof material.maxSimultaneousLights === "number";
}

type SceneLighting = { sync: () => void; limits: () => string[] };
const lightingByScene = new WeakMap<Scene, SceneLighting>();

/**
 * Bound conventional shader variants before compilation, then select effective
 * lights within that budget without changing authored Enabled values.
 */
export function syncSceneLighting(scene: Scene): void {
  let lighting = lightingByScene.get(scene);
  if (!lighting) {
    lighting = installSceneLighting(scene);
    lightingByScene.set(scene, lighting);
  }
  lighting.sync();
}

export function sceneLightingLimits(scene: Scene): string[] {
  return [...clusteredLightingLimits(scene), ...(lightingByScene.get(scene)?.limits() ?? [])];
}

function installSceneLighting(scene: Scene): SceneLighting {
  let dirty = true;
  let lightCount = -1;
  let materialCount = -1;
  let sceneLightsEnabled = scene.lightsEnabled;
  let sceneShadowsEnabled = scene.shadowsEnabled;
  let enabledLights: Light[] = [];
  let nextEnabled: Light[] = [];
  let shadowLayout: unknown[] = [];
  let nextShadowLayout: unknown[] = [];
  let admission = { requested: 0, admitted: 0, limited: [] as Light[] };
  let budget = forwardLightBudget(scene.getEngine());
  const watchedLights = new Map<Light, Observer<boolean>>();
  const invalidate = () => {
    dirty = true;
  };

  const sync = (): void => {
    if (scene.isDisposed) return;
    syncClusteredLightPolicy(scene);
    budget = forwardLightBudget(scene.getEngine());
    // Selection precedes the collection fast path: camera/light movement and
    // priority changes need no scene membership or Enabled event.
    admission = syncForwardLightPolicy(scene, budget.slots);
    nextEnabled.length = 0;
    nextShadowLayout.length = 0;
    for (const light of scene.lights) {
      if (!light.isEnabled()) continue;
      nextEnabled.push(light);
      nextShadowLayout.push(light.shadowEnabled,
        light.getShadowGenerator(scene.activeCamera) ?? light.getShadowGenerator());
    }
    const changed =
      sceneLightsEnabled !== scene.lightsEnabled ||
      sceneShadowsEnabled !== scene.shadowsEnabled ||
      nextEnabled.length !== enabledLights.length ||
      nextEnabled.some((light, index) => light !== enabledLights[index]) ||
      nextShadowLayout.length !== shadowLayout.length ||
      nextShadowLayout.some((entry, index) => entry !== shadowLayout[index]);
    // Babylon defers its new-entity observables. These O(1) checks also catch
    // objects constructed immediately before prewarm or the first render.
    if (
      !dirty &&
      lightCount === scene.lights.length &&
      materialCount === scene.materials.length &&
      !changed
    )
      return;
    dirty = false;
    lightCount = scene.lights.length;
    materialCount = scene.materials.length;
    sceneLightsEnabled = scene.lightsEnabled;
    sceneShadowsEnabled = scene.shadowsEnabled;
    const liveLights = new Set(scene.lights);
    for (const [light, observer] of watchedLights) {
      if (liveLights.has(light)) continue;
      light.onEffectiveEnabledStateChangedObservable.remove(observer);
      watchedLights.delete(light);
    }
    for (const light of liveLights) {
      if (watchedLights.has(light)) continue;
      watchedLights.set(
        light,
        light.onEffectiveEnabledStateChangedObservable.add(invalidate),
      );
    }
    const previousEnabled = enabledLights;
    enabledLights = nextEnabled;
    nextEnabled = previousEnabled;
    const previousShadowLayout = shadowLayout;
    shadowLayout = nextShadowLayout;
    nextShadowLayout = previousShadowLayout;
    const capacity = Math.min(budget.slots, Math.max(4, enabledLights.length));
    const blocked = scene.blockMaterialDirtyMechanism;
    scene.blockMaterialDirtyMechanism = false;
    try {
      for (const material of scene.materials) {
        if (!isLitMaterial(material)) continue;
        if (!changed && material.maxSimultaneousLights === capacity) continue;
        material.maxSimultaneousLights = capacity;
        material.markAsDirty(Material.LightDirtyFlag);
        // Light defines alone do not invalidate a frozen material's cached
        // readiness, including when a disposed generator removes SHADOW defines.
        // Preserve its freeze policy while refreshing the shader.
        material.markDirty();
      }
    } finally {
      scene.blockMaterialDirtyMechanism = blocked;
    }
  };

  const beforeRender = scene.onBeforeRenderObservable.add(sync);
  const lightAdded = scene.onNewLightAddedObservable.add(invalidate);
  const lightRemoved = scene.onLightRemovedObservable.add(invalidate);
  const materialAdded = scene.onNewMaterialAddedObservable.add(invalidate);
  const materialRemoved = scene.onMaterialRemovedObservable.add(invalidate);
  const restored = scene
    .getEngine()
    .onContextRestoredObservable.add(invalidate);
  scene.onDisposeObservable.addOnce(() => {
    scene.onBeforeRenderObservable.remove(beforeRender);
    scene.onNewLightAddedObservable.remove(lightAdded);
    scene.onLightRemovedObservable.remove(lightRemoved);
    scene.onNewMaterialAddedObservable.remove(materialAdded);
    scene.onMaterialRemovedObservable.remove(materialRemoved);
    scene.getEngine().onContextRestoredObservable.remove(restored);
    for (const [light, observer] of watchedLights) {
      light.onEffectiveEnabledStateChangedObservable.remove(observer);
    }
    watchedLights.clear();
    lightingByScene.delete(scene);
  });
  return {
    sync,
    limits: () =>
      admission.limited.length
        ? [
            `Conventional lighting: ${admission.admitted}/${admission.requested} requested lights admitted; ${budget.slots} shader slots (${budget.source}, ${budget.reservedBlocks} non-light blocks reserved). Limited: ${admission.limited
              .slice(0, 16)
              .map((light) => light.name)
              .join(", ")}${admission.limited.length > 16 ? ", …" : ""}`,
          ]
        : [],
  };
}
