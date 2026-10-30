import "./texture-quality";
import "./standard-fog";
import { lightsInCreationOrder, syncForwardLightPolicy } from "./light-policy";
import { forwardLightBudget } from "./forward-light-budget";
import { sceneRenderingSettings } from "./render-settings";
import { markSceneReadinessDirty, notifySceneReceiversChanged } from "./scene-readiness-signal";
import {
  LightBlock,
  Material,
  NodeMaterial,
  NodeMaterialModes,
  PBRMetallicRoughnessBlock,
  type Light,
  type Observer,
  type Scene,
} from "@babylonjs/core";
import { deviceProfile } from "./device-profile";
import { hapticLightLimits, selectHapticLights, writeHapticLights } from "./haptic-lights";

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
        (block) => block instanceof PBRMetallicRoughnessBlock || block instanceof LightBlock,
      )
    );
  }
  return typeof material.maxSimultaneousLights === "number";
}

type SceneLighting = { sync: () => void; invalidate: () => void; limits: () => string[] };

const lightingByScene = new WeakMap<Scene, SceneLighting>();

/**
 * Bound conventional shader variants before compilation, then select effective
 * lights within that budget without changing authored Enabled values.
 */
export function syncSceneLighting(scene: Scene): void {
  sceneLighting(scene).sync();
}

function sceneLighting(scene: Scene): SceneLighting {
  let lighting = lightingByScene.get(scene);
  if (!lighting) {
    lighting = installSceneLighting(scene);
    lightingByScene.set(scene, lighting);
  }
  return lighting;
}

/**
 * Re-apply the light-slot capacity at the next sync, e.g. when a material
 * starts using scene lights again. No-op where lighting is not managed.
 */
export function invalidateSceneLighting(scene: Scene): void {
  lightingByScene.get(scene)?.invalidate();
}

export function sceneLightingLimits(scene: Scene): string[] {
  return [
    ...scene.lights.flatMap((light) => typeof light.metadata?.areaLight?.error === "string" ? [`${light.name}: ${light.metadata.areaLight.error}`] : []),
    ...(lightingByScene.get(scene)?.limits() ?? []),
    ...hapticLightLimits(scene),
  ];
}

function installSceneLighting(scene: Scene): SceneLighting {
  let dirty = true;
  let lightCount = -1;
  let materialCount = -1;
  let sceneLightsEnabled = scene.lightsEnabled;
  let sceneShadowsEnabled = scene.shadowsEnabled;
  // The most lights the Scene has held, enabled or not; it never shrinks.
  let lightInventory = 0;
  // The light capacity of the last refresh (every lit Effect's MAXLIGHTCOUNT).
  let lightCapacity = -1;
  // The enabled lights, in any order: the block reads them as data, so their order changes no receiver.
  let enabledLights = new Set<Light>();
  let nextEnabled = new Set<Light>();
  let admission: ReturnType<typeof syncForwardLightPolicy> = {
    requested: 0,
    admitted: 0,
    limited: [],
    samplerLimited: [],
    samplers: 0,
  };
  let budget = forwardLightBudget(scene.getEngine());
  const watchedLights = new Map<Light, Observer<boolean>>();
  const invalidate = () => {
    dirty = true;
  };
  const watchLight = () => {
    dirty = true;
  };

  const sync = (): void => {
    if (scene.isDisposed) return;
    budget = forwardLightBudget(scene.getEngine());
    // Selection precedes the collection fast path: camera/light movement and
    // priority changes need no scene membership or Enabled event.
    admission = syncForwardLightPolicy(
      scene,
      budget.slots,
      Math.max(0, sceneRenderingSettings(scene).localLightBudget),
      selectHapticLights,
    );
    // HapticLightingBlock reads the admitted lights from one block, rewritten each frame; its Materials hold no light defines.
    writeHapticLights(scene);
    nextEnabled.clear();
    let enabledChanged = false;
    for (const light of scene.lights) {
      if (!light.isEnabled()) continue;
      nextEnabled.add(light);
      if (!enabledLights.has(light)) enabledChanged = true;
    }
    const changed =
      sceneLightsEnabled !== scene.lightsEnabled ||
      sceneShadowsEnabled !== scene.shadowsEnabled ||
      enabledChanged ||
      nextEnabled.size !== enabledLights.size;
    // Babylon defers its new-entity observables. These O(1) checks also catch
    // objects constructed immediately before prewarm or the first render.
    if (!dirty && lightCount === scene.lights.length && materialCount === scene.materials.length && !changed) return;
    dirty = false;
    // Light membership changed; the cached strict readiness
    // result no longer describes the effects these materials will build.
    markSceneReadinessDirty(scene);
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
        light.onEffectiveEnabledStateChangedObservable.add(watchLight),
      );
    }
    const previousEnabled = enabledLights;
    enabledLights = nextEnabled;
    nextEnabled = previousEnabled;
    // Sized by the light inventory, not the enabled count: turning lights on
    // or off and budget swaps keep MAXLIGHTCOUNT, so a receiver whose own
    // lights are unchanged keeps its Effect. Not the slot count either: Babylon
    // expands every per-light include this many times before dropping the
    // unused copies, and that JS cost is paid per Effect.
    lightInventory = Math.max(lightInventory, scene.lights.length);
    const capacity = Math.min(budget.slots, Math.max(4, lightInventory));
    // Only a different light set or capacity gives receivers other defines. Other refreshes (a material added or
    // retired) leave a program that failed to link failing, so they must not end the Material library's latch.
    const receiversChanged = changed || capacity !== lightCapacity;
    lightCapacity = capacity;
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
    if (receiversChanged) notifySceneReceiversChanged(scene);
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
    invalidate,
    limits: () => {
      if (!admission.limited.length) return [];
      const limited = `Limited: ${lightsInCreationOrder(admission.limited)
        .slice(0, 16)
        .map((light) => light.name)
        .join(", ")}${admission.limited.length > 16 ? ", …" : ""}`;
      const local = sceneRenderingSettings(scene).localLightBudget;
      const maximum = deviceProfile().lightMaximum;
      return [
        `Light block: ${admission.admitted}/${admission.requested} requested lights admitted; ${local} scalability local lights; this device draws at most ${maximum.point} point, ${maximum.spot} spot, ${maximum.rect} rect area and ${maximum.directional} directional lights and one fill. ${limited}`,
      ];
    },
  };
}
