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
          block.getClassName() === "LightBlock",
      )
    );
  }
  return typeof material.maxSimultaneousLights === "number";
}

type SceneLighting = { sync: () => void };
const lightingByScene = new WeakMap<Scene, SceneLighting>();

/**
 * Forward shaders must have room for every enabled scene light. Keep Babylon's
 * small-scene default, growing only when the scene needs more lights. Changes
 * are batched before rendering; unchanged frames only check collection sizes.
 */
export function syncSceneLighting(scene: Scene): void {
  let lighting = lightingByScene.get(scene);
  if (!lighting) {
    lighting = installSceneLighting(scene);
    lightingByScene.set(scene, lighting);
  }
  lighting.sync();
}

function installSceneLighting(scene: Scene): SceneLighting {
  let dirty = true;
  let lightCount = -1;
  let materialCount = -1;
  let sceneLightsEnabled = scene.lightsEnabled;
  let enabledLights: Light[] = [];
  const watchedLights = new Map<Light, Observer<boolean>>();
  const invalidate = () => {
    dirty = true;
  };

  const sync = (): void => {
    if (scene.isDisposed) return;
    // Babylon defers its new-entity observables. These O(1) checks also catch
    // objects constructed immediately before prewarm or the first render.
    if (
      !dirty &&
      lightCount === scene.lights.length &&
      materialCount === scene.materials.length &&
      sceneLightsEnabled === scene.lightsEnabled
    )
      return;
    dirty = false;
    lightCount = scene.lights.length;
    materialCount = scene.materials.length;
    const sceneLightingChanged = sceneLightsEnabled !== scene.lightsEnabled;
    sceneLightsEnabled = scene.lightsEnabled;
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
    const nextEnabled = scene.lights.filter((light) => light.isEnabled());
    const changed =
      sceneLightingChanged ||
      nextEnabled.length !== enabledLights.length ||
      nextEnabled.some((light, index) => light !== enabledLights[index]);
    enabledLights = nextEnabled;
    const capacity = Math.max(4, enabledLights.length);
    const blocked = scene.blockMaterialDirtyMechanism;
    scene.blockMaterialDirtyMechanism = false;
    try {
      for (const material of scene.materials) {
        if (!isLitMaterial(material)) continue;
        if (!changed && material.maxSimultaneousLights === capacity) continue;
        material.maxSimultaneousLights = capacity;
        material.markAsDirty(Material.LightDirtyFlag);
        // Light defines alone do not invalidate a frozen material's cached
        // readiness. Preserve its freeze policy while refreshing the shader.
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
  scene.onDisposeObservable.addOnce(() => {
    scene.onBeforeRenderObservable.remove(beforeRender);
    scene.onNewLightAddedObservable.remove(lightAdded);
    scene.onLightRemovedObservable.remove(lightRemoved);
    scene.onNewMaterialAddedObservable.remove(materialAdded);
    scene.onMaterialRemovedObservable.remove(materialRemoved);
    for (const [light, observer] of watchedLights) {
      light.onEffectiveEnabledStateChangedObservable.remove(observer);
    }
    watchedLights.clear();
    lightingByScene.delete(scene);
  });
  return { sync };
}
